/**
 * T2.4 — anthropic codec translateOut/prepareWire delegate the FORWARD translate leg to the hub,
 * verified OFFLINE through `driver.inspectRequest` (the exact machinery the `/api/debug/dry-run-pipeline`
 * inspector drives — no upstream, no quota).
 *
 * Two axes proven here:
 *   1. FORWARD leg (anthropic + `@cc`): `stopAfter=prepare-wire` yields a CC-shaped wire at
 *      `/chat/completions` (the request translation reached the wire) — the hub delegation works.
 *   2. DIRECT leg (no suffix): the wire stays Anthropic-shaped at `/v1/messages` (zero regression).
 *   3. Response-side FAIL-FAST: `renderResponse` / `renderResponseNonStreaming` THROW for a translate
 *      leg, so the leg is end-to-end fail-fast (an un-translated CC response is never returned).
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

describe("T2.4 — response side is fail-fast for a translate leg", () => {
  useIsolatedRuntime()

  function translateLegEnv(): RequestEnvelope {
    return { targetEndpoint: ENDPOINT.CHAT_COMPLETIONS, body: {}, model: {} } as unknown as RequestEnvelope
  }
  function directEnv(): RequestEnvelope {
    return { targetEndpoint: ENDPOINT.MESSAGES, body: {}, model: {} } as unknown as RequestEnvelope
  }
  const codec = () => createAnthropicCodec({ betaProbe: createBetaProbe(undefined), preprocessInfo: { strippedReadTagCount: 0, dedupedToolCallCount: 0 } })

  test("renderResponse THROWS for a translate leg (never returns un-translated CC to the client)", () => {
    expect(() => codec().renderResponse({ data: "{}", event: "message" }, translateLegEnv())).toThrow(/response translation is not wired yet/)
  })

  test("renderResponseNonStreaming THROWS for a translate leg", () => {
    expect(() => codec().renderResponseNonStreaming({ id: "x" }, translateLegEnv())).toThrow(/response translation is not wired yet/)
  })

  test("direct-leg render stays identity (no throw)", () => {
    const frame = { data: '{"type":"content_block_delta"}', event: "content_block_delta" }
    expect(codec().renderResponse(frame, directEnv())).toBe(frame)
  })
})
