/**
 * T2.4 — anthropic codec translateOut/prepareWire delegate the FORWARD translate leg to the hub,
 * verified OFFLINE through `driver.inspectRequest` (the exact machinery the `/api/debug/dry-run-pipeline`
 * inspector drives — no upstream, no quota).
 *
 * Two axes proven here:
 *   1. FORWARD leg (anthropic + `@cc`): `stopAfter=prepare-wire` yields a CC-shaped wire at
 *      `/chat/completions` (the request translation reached the wire) — the hub delegation works.
 *   2. DIRECT leg (no suffix): the wire stays Anthropic-shaped at `/v1/messages` (zero regression).
 *   3. Response-side FAIL-FAST: streaming `renderResponse` THROWS for a translate leg (Phase 4), while
 *      non-streaming `renderResponseNonStreaming` now TRANSLATES the CC response back to Anthropic (T3.3).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { RawHttpRequest } from "~/lib/pipeline/types"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { preprocessAnthropicMessages } from "~/lib/anthropic/sanitize"
import { createAnthropicCodec } from "~/lib/codec/anthropic/codec"
import { withCapturingManagerAsync } from "~/lib/context/manager"
import { setModels } from "~/lib/models/cache"
import { ENDPOINT } from "~/lib/models/endpoint"
import { createPipelineDriver } from "~/lib/pipeline/driver"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"

const dryRunTransport = {
  send: () => {
    throw new Error("dry-run: transport must never be used")
  },
} as never

/** Build the REAL anthropic codec + driver (mirrors dry-run-pipeline.ts `inspectFormatRequest`). */
async function inspect(modelName: string, stopAfter: "translate" | "prepare-wire") {
  const messages = [{ role: "user" as const, content: "hi" }]
  const pre = preprocessAnthropicMessages(messages as never)
  const betaProbe = createBetaProbe(undefined)
  const codec = createAnthropicCodec({
    betaProbe,
    preprocessInfo: { strippedReadTagCount: pre.strippedReadTagCount, dedupedToolCallCount: pre.dedupedToolCallCount },
  })
  const driver = createPipelineDriver({
    codec,
    transport: dryRunTransport,
    strategies: [],
    maxRetries: 0,
    maxLearningRetries: 0,
    requestRewrites: codec.getRequestRewrites(),
  })
  const raw = {
    body: { model: modelName, max_tokens: 128, system: "be terse", messages: pre.messages },
    headers: new Headers(),
    path: "/v1/messages",
    method: "POST",
  } as unknown as RawHttpRequest
  return (await withCapturingManagerAsync(() => driver.inspectRequest(raw, stopAfter))).result
}

describe("T2.4 — anthropic codec forward-leg wire delegation (dry-run inspectRequest)", () => {
  useIsolatedRuntime()

  // claude-x supports BOTH the direct messages leg AND the CC leg (like real claude-opus-4.8).
  const seedModel = () =>
    setModels({ object: "list", data: [mockModel("claude-x", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.CHAT_COMPLETIONS] })] })

  // claude-r additionally advertises the /responses leg (for the @responses forward-leg IT — W4).
  const seedResponsesModel = () =>
    setModels({
      object: "list",
      data: [mockModel("claude-r", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.CHAT_COMPLETIONS, ENDPOINT.RESPONSES] })],
    })

  test("@cc forward leg → prepare-wire yields a CC-shaped wire at /chat/completions (translation reached the wire)", async () => {
    seedModel()
    const insp = await inspect("claude-x@cc", "prepare-wire")
    expect(insp.stoppedAt).toBe("prepare-wire")

    // translate stage: the body became CC-canonical (has `messages`, model stripped of @cc).
    const translated = insp.stages.translate
    expect(translated?.targetEndpoint).toBe(ENDPOINT.CHAT_COMPLETIONS)
    const tbody = translated?.body as { model: string; messages: Array<{ role: string; content: unknown }>; max_tokens?: number }
    expect(tbody.model).toBe("claude-x")
    // Anthropic top-level `system` folded into a leading CC system message (proof of translation).
    expect(tbody.messages[0]).toEqual({ role: "system", content: "be terse" })
    expect(tbody.messages.some((m) => m.role === "user")).toBe(true)

    // prepare-wire: the outbound wire targets /chat/completions and is CC-shaped.
    const wire = insp.stages["prepare-wire"]
    expect(wire?.url).toBe(ENDPOINT.CHAT_COMPLETIONS)
    const wbody = wire?.body as { model: string; messages?: unknown; thinking?: unknown }
    expect(Array.isArray(wbody.messages)).toBe(true)
    // No Anthropic-only fields leaked onto the CC wire.
    expect(wbody.thinking).toBeUndefined()
  })

  test("@responses forward leg → prepare-wire yields a Responses-shaped wire at /responses (input[], not messages[]) — W4", async () => {
    seedResponsesModel()
    const insp = await inspect("claude-r@responses", "prepare-wire")
    expect(insp.stoppedAt).toBe("prepare-wire")

    // translate stage: env.body is ALREADY Responses-canonical (RFC 2026-07-14 direct bridge — the hub
    // skips the CC intermediate for the anthropic→responses pair entirely, unlike the @cc leg above).
    const translated = insp.stages.translate
    expect(translated?.targetEndpoint).toBe(ENDPOINT.RESPONSES)
    const tbody = translated?.body as { model: string; input?: unknown; messages?: unknown }
    expect(tbody.model).toBe("claude-r")
    expect(Array.isArray(tbody.input)).toBe(true) // Responses-shaped already at the translate stage
    expect(tbody.messages).toBeUndefined()

    // prepare-wire: the outbound wire targets /responses and is Responses-shaped (input[], no messages[]).
    const wire = insp.stages["prepare-wire"]
    expect(wire?.url).toBe(ENDPOINT.RESPONSES)
    const wbody = wire?.body as { input?: unknown; messages?: unknown }
    expect(Array.isArray(wbody.input)).toBe(true)
    expect(wbody.messages).toBeUndefined()
  })

  test("DIRECT leg (no suffix) → wire stays Anthropic-shaped at /v1/messages (zero regression)", async () => {
    seedModel()
    const insp = await inspect("claude-x", "prepare-wire")
    const translated = insp.stages.translate
    expect(translated?.targetEndpoint).toBe(ENDPOINT.MESSAGES)
    // Direct path: translateOut is identity — the body is still the Anthropic payload (has top-level system).
    expect((translated?.body as { system?: unknown }).system).toBe("be terse")

    const wire = insp.stages["prepare-wire"]
    expect(wire?.url).toBe(ENDPOINT.MESSAGES)
    // Anthropic wire keeps `messages` + `system` (NOT folded into a system message).
    const wbody = wire?.body as { system?: unknown; messages?: unknown }
    expect(wbody.system).toBe("be terse")
  })
})

describe("T3.3/T4.2 — non-streaming + streaming response side translate for a translate leg", () => {
  useIsolatedRuntime()

  function translateLegEnv(): RequestEnvelope {
    return {
      targetEndpoint: ENDPOINT.CHAT_COMPLETIONS,
      body: { model: "claude-x" },
      model: { id: "claude-x" },
      ctx: { recordFeature: () => {} },
    } as unknown as RequestEnvelope
  }
  function directEnv(): RequestEnvelope {
    return { targetEndpoint: ENDPOINT.MESSAGES, body: {}, model: {} } as unknown as RequestEnvelope
  }
  const codec = () => createAnthropicCodec({ betaProbe: createBetaProbe(undefined), preprocessInfo: { strippedReadTagCount: 0, dedupedToolCallCount: 0 } })

  test("renderResponse (STREAMING) TRANSLATES a CC frame to Anthropic frame(s) for a translate leg (T4.2)", () => {
    const out = codec().renderResponse(
      { data: JSON.stringify({ id: "msg_x", model: "claude-x", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }), event: "message" },
      translateLegEnv(),
    )
    const frames = Array.isArray(out) ? out : [out]
    const types = frames.map((f) => JSON.parse((f as { data: string }).data).type)
    expect(types).toContain("message_start")
    expect(types).toContain("content_block_delta")
  })

  test("renderResponseNonStreaming TRANSLATES a CC completion back to an Anthropic response (T3.3)", async () => {
    const ccResponse = {
      id: "msg_x",
      object: "chat.completion",
      created: 0,
      model: "claude-x",
      choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content: "hello from cc" } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }
    const out = codec().renderResponseNonStreaming(ccResponse, translateLegEnv()) as {
      type: string
      role: string
      content: Array<{ type: string; text?: string }>
      stop_reason: string
      usage: { input_tokens: number; output_tokens: number }
    }
    expect(out.type).toBe("message")
    expect(out.role).toBe("assistant")
    expect(out.content).toEqual([{ type: "text", text: "hello from cc" }])
    expect(out.stop_reason).toBe("end_turn")
    expect(out.usage).toEqual({ input_tokens: 5, output_tokens: 2 })
  })

  test("direct-leg non-streaming render stays identity (no translation)", async () => {
    const upstream = { id: "msg_direct", type: "message", content: [] }
    expect(codec().renderResponseNonStreaming(upstream, directEnv())).toBe(upstream)
  })

  test("direct-leg streaming render stays identity (no throw)", async () => {
    const frame = { data: '{"type":"content_block_delta"}', event: "content_block_delta" }
    expect(codec().renderResponse(frame, directEnv())).toBe(frame)
  })
})
