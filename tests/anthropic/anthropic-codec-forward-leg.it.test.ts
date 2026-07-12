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
import { withCapturingManager } from "~/lib/context/manager"
import { ENDPOINT } from "~/lib/models/endpoint"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { setModels } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"

const dryRunTransport = {
  send: () => {
    throw new Error("dry-run: transport must never be used")
  },
} as never

/** Build the REAL anthropic codec + driver (mirrors dry-run-pipeline.ts `inspectFormatRequest`). */
function inspect(modelName: string, stopAfter: "translate" | "prepare-wire") {
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
  return withCapturingManager(() => driver.inspectRequest(raw, stopAfter)).result
}

describe("T2.4 — anthropic codec forward-leg wire delegation (dry-run inspectRequest)", () => {
  useIsolatedRuntime()

  // claude-x supports BOTH the direct messages leg AND the CC leg (like real claude-opus-4.8).
  const seedModel = () =>
    setModels({ object: "list", data: [mockModel("claude-x", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.CHAT_COMPLETIONS] })] })

  test("@cc forward leg → prepare-wire yields a CC-shaped wire at /chat/completions (translation reached the wire)", () => {
    seedModel()
    const insp = inspect("claude-x@cc", "prepare-wire")
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

  test("DIRECT leg (no suffix) → wire stays Anthropic-shaped at /v1/messages (zero regression)", () => {
    seedModel()
    const insp = inspect("claude-x", "prepare-wire")
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

describe("T3.3 — non-streaming response side translates for a translate leg; streaming stays fail-fast", () => {
  useIsolatedRuntime()

  function translateLegEnv(): RequestEnvelope {
    return { targetEndpoint: ENDPOINT.CHAT_COMPLETIONS, body: {}, model: {}, ctx: { recordFeature: () => {} } } as unknown as RequestEnvelope
  }
  function directEnv(): RequestEnvelope {
    return { targetEndpoint: ENDPOINT.MESSAGES, body: {}, model: {} } as unknown as RequestEnvelope
  }
  const codec = () => createAnthropicCodec({ betaProbe: createBetaProbe(undefined), preprocessInfo: { strippedReadTagCount: 0, dedupedToolCallCount: 0 } })

  test("renderResponse (STREAMING) THROWS for a translate leg (per-frame state machine is Phase 4)", () => {
    expect(() => codec().renderResponse({ data: "{}", event: "message" }, translateLegEnv())).toThrow(/STREAMING response-side translation is not wired yet/)
  })

  test("renderResponseNonStreaming TRANSLATES a CC completion back to an Anthropic response (T3.3)", () => {
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

  test("direct-leg non-streaming render stays identity (no translation)", () => {
    const upstream = { id: "msg_direct", type: "message", content: [] }
    expect(codec().renderResponseNonStreaming(upstream, directEnv())).toBe(upstream)
  })

  test("direct-leg streaming render stays identity (no throw)", () => {
    const frame = { data: '{"type":"content_block_delta"}', event: "content_block_delta" }
    expect(codec().renderResponse(frame, directEnv())).toBe(frame)
  })
})
