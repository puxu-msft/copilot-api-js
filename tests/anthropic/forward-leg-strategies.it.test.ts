/**
 * T7.2 — forward translate-leg STRATEGY FACTORY production seam (mock transport, no GHC / no quota).
 *
 * The招牌 use case — an Anthropic client (Claude Code) pointing at an OpenAI model via `@cc`/`@responses`
 * — 500'd in production on `[strategy-registry] no strategy builder registered for the /chat/completions
 * leg yet`: the registry never registered the CC/Responses builders AND the messages handler only ever
 * filled the `anthropic` supply slot. Every prior forward-leg test injected `strategies:[]` or drove
 * `driver.inspectRequest` (a dry-run that NEVER enters S4), so the real `deps.strategies(env)` factory —
 * the exact code that threw — was never exercised. This is the production接缝 that溜过 all tests.
 *
 * This test drives the REAL factory (`buildMessagesDriverStrategies`, the identical function the handler
 * hands the driver as `deps.strategies`) through the REAL anthropic codec + REAL driver + REAL router,
 * over a mock transport. `runRequest` invokes `deps.strategies(env)` UNCONDITIONALLY (driver.ts S4, before
 * the exchange), so a broken factory throws here — proving the root-cause fix, not a symptom.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  PreparedRequest,
  RawHttpRequest,
  Transport,
  UpstreamStream,
} from "~/lib/pipeline/types"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { preprocessAnthropicMessages } from "~/lib/anthropic/sanitize"
import { createAnthropicCodec } from "~/lib/codec/anthropic/codec"
import { withCapturingManager } from "~/lib/context/manager"
import { ENDPOINT } from "~/lib/models/endpoint"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { setModels } from "~/lib/state"
import { buildMessagesDriverStrategies } from "~/routes/messages/handler-v4"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"

async function* noFrames(): AsyncIterable<never> {}

/** A mock transport that records the outbound wire and returns a canned non-streaming upstream body. */
function mockTransport(nonStream: unknown, onWire?: (wire: PreparedRequest) => void): Transport {
  return {
    send: (wire) => {
      onWire?.(wire)
      const upstream: UpstreamStream = { frames: noFrames(), nonStream, headers: new Headers() }
      return Promise.resolve(upstream)
    },
  }
}

/**
 * Build the REAL anthropic codec + driver WHOSE `strategies` is the REAL production factory
 * (`buildMessagesDriverStrategies`) — NOT `strategies:[]`. This is the whole point: the factory that
 * threw in production is what the driver invokes.
 */
function makeDriver(transport: Transport) {
  const messages = [{ role: "user" as const, content: "what's the weather in SF?" }]
  const pre = preprocessAnthropicMessages(messages as never)
  const betaProbe = createBetaProbe(undefined)
  const codec = createAnthropicCodec({
    betaProbe,
    preprocessInfo: { strippedReadTagCount: pre.strippedReadTagCount, dedupedToolCallCount: pre.dedupedToolCallCount },
  })
  const driver = createPipelineDriver({
    codec,
    transport,
    strategies: (env) => buildMessagesDriverStrategies(env, { codec, betaProbe }),
    maxRetries: 0,
    maxLearningRetries: 0,
    requestRewrites: codec.getRequestRewrites(),
  })
  const raw = {
    body: { model: "will-be-overridden", max_tokens: 128, messages: pre.messages, stream: false },
    headers: new Headers(),
    path: "/v1/messages",
    method: "POST",
  } as unknown as RawHttpRequest
  return { driver, raw }
}

/** Drive the full S1→S4 pipeline (which invokes the real strategies factory before the exchange). */
async function runForwardLeg(modelName: string) {
  const cannedCc = {
    id: "msg_x",
    object: "chat.completion",
    created: 0,
    model: modelName.replace(/@.*$/, ""),
    choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content: "ok" } }],
    usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
  }
  let sentWire: PreparedRequest | undefined
  const { driver, raw } = makeDriver(mockTransport(cannedCc, (w) => (sentWire = w)))
  const req = { ...(raw as object), body: { ...(raw.body as object), model: modelName } } as unknown as RawHttpRequest
  const result = await withCapturingManager(() => driver.runRequest(req)).result
  return { result, sentWire }
}

describe("T7.2 — forward-leg strategy factory does NOT throw (production seam, real factory)", () => {
  useIsolatedRuntime()

  // claude-x supports the direct messages leg AND both OpenAI legs (like real claude-opus-4.8 on GHC).
  const seed = () =>
    setModels({
      object: "list",
      data: [mockModel("claude-x", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.CHAT_COMPLETIONS, ENDPOINT.RESPONSES] })],
    })

  test("@cc forward leg: runRequest succeeds (real factory built the CC stack, no strategy-registry throw) + CC wire reached upstream", async () => {
    seed()
    const { result, sentWire } = await runForwardLeg("claude-x@cc")
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`unexpected reject: ${result.rejection.reason}`)
    // The strategies factory ran (S4) without the `no strategy builder` / `cc supply` throw.
    expect(result.env.targetEndpoint).toBe(ENDPOINT.CHAT_COMPLETIONS)
    // The outbound wire is CC-shaped at /chat/completions (the translation reached the upstream).
    expect(sentWire?.url).toBe(ENDPOINT.CHAT_COMPLETIONS)
    expect(Array.isArray((sentWire?.body as { messages?: unknown }).messages)).toBe(true)
  })

  test("@responses forward leg: runRequest succeeds + Responses-shaped wire (input[], not messages[]) reached upstream", async () => {
    seed()
    const { result, sentWire } = await runForwardLeg("claude-x@responses")
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`unexpected reject: ${result.rejection.reason}`)
    expect(result.env.targetEndpoint).toBe(ENDPOINT.RESPONSES)
    expect(Array.isArray((sentWire?.body as { input?: unknown }).input)).toBe(true)
    expect((sentWire?.body as { messages?: unknown }).messages).toBeUndefined()
  })

  test("DIRECT leg (no suffix): the ANTHROPIC stack still builds (zero regression) + Anthropic wire reached upstream", async () => {
    seed()
    const cannedAnthropic = {
      id: "msg_direct",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-x",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }
    let sentWire: PreparedRequest | undefined
    const { driver, raw } = makeDriver(mockTransport(cannedAnthropic, (w) => (sentWire = w)))
    const req = { ...(raw as object), body: { ...(raw.body as object), model: "claude-x" } } as unknown as RawHttpRequest
    const result = await withCapturingManager(() => driver.runRequest(req)).result
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`unexpected reject: ${result.rejection.reason}`)
    expect(result.env.targetEndpoint).toBe(ENDPOINT.MESSAGES)
    expect(sentWire?.url).toBe(ENDPOINT.MESSAGES)
  })
})

describe("T7.2 — buildMessagesDriverStrategies returns a REAL non-empty stack per leg (unit-level directness)", () => {
  useIsolatedRuntime()

  const codecAndProbe = () => {
    const betaProbe = createBetaProbe(undefined)
    const codec = createAnthropicCodec({ betaProbe, preprocessInfo: { strippedReadTagCount: 0, dedupedToolCallCount: 0 } })
    return { codec, betaProbe }
  }

  const ccLegEnv = (leg: (typeof ENDPOINT)["CHAT_COMPLETIONS"] | (typeof ENDPOINT)["RESPONSES"]): RequestEnvelope =>
    ({ targetEndpoint: leg, body: { model: "claude-x", messages: [] }, model: { id: "claude-x" } }) as unknown as RequestEnvelope

  test("a CC-target env yields the CC stack (real strategies) — NOT a throw", () => {
    const { codec, betaProbe } = codecAndProbe()
    const stack = buildMessagesDriverStrategies(ccLegEnv(ENDPOINT.CHAT_COMPLETIONS), { codec, betaProbe })
    expect(stack.length).toBeGreaterThan(0)
    expect(stack.map((s) => s.name)).toContain("token-refresh")
  })

  test("a Responses-target env also yields the CC stack (deferred CC→Responses wire) — NOT a throw", () => {
    const { codec, betaProbe } = codecAndProbe()
    const stack = buildMessagesDriverStrategies(ccLegEnv(ENDPOINT.RESPONSES), { codec, betaProbe })
    expect(stack.length).toBeGreaterThan(0)
    expect(stack.map((s) => s.name)).toContain("token-refresh")
  })
})
