/**
 * Phase 3 task 3.1 — the `errorFrameCanonical` S5 response rewrite (order 50, runs FIRST).
 *
 * It intercepts a raw upstream `event:error` frame BEFORE any other rewrite and reshapes it into a
 * canonical Anthropic `event:error` envelope; every non-error frame passes through verbatim. The gate
 * is two-axis (HIGH-2): `targetEndpoint === /v1/messages` AND `state.errorShapingEnabled` — so the
 * rewrite NEVER fires on the gemini / chat-completions / responses legs that share `ALL_RESPONSE_REWRITES`.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"

import { errorFrameCanonicalRewrite } from "~/lib/codec/anthropic/error-frame-canonical-rewrite"
import { ENDPOINT } from "~/lib/models/endpoint"
import { setStateForTests } from "~/lib/state"

import { useIsolatedRuntime } from "../../helpers/isolated-fixture"

/** Minimal RequestEnvelope stub — `appliesTo` only reads `targetEndpoint`; `transform` reads nothing off env. */
function env(targetEndpoint: string): RequestEnvelope {
  return { targetEndpoint } as RequestEnvelope
}

describe("errorFrameCanonicalRewrite", () => {
  useIsolatedRuntime()

  test("appliesTo false when errorShapingEnabled=false — golden lock, chain skips this rewrite entirely", () => {
    setStateForTests({ errorShapingEnabled: false })
    expect(errorFrameCanonicalRewrite.appliesTo(env(ENDPOINT.MESSAGES))).toBe(false)
  })

  test("appliesTo true when MESSAGES leg && errorShapingEnabled=true", () => {
    setStateForTests({ errorShapingEnabled: true })
    expect(errorFrameCanonicalRewrite.appliesTo(env(ENDPOINT.MESSAGES))).toBe(true)
  })

  test("appliesTo false for non-MESSAGES targetEndpoint even when errorShapingEnabled=true — HIGH-2 endpoint gate regression (must never fire on gemini/chat-completions/responses legs sharing ALL_RESPONSE_REWRITES)", () => {
    setStateForTests({ errorShapingEnabled: true })
    expect(errorFrameCanonicalRewrite.appliesTo(env(ENDPOINT.CHAT_COMPLETIONS))).toBe(false)
    expect(errorFrameCanonicalRewrite.appliesTo(env(ENDPOINT.RESPONSES))).toBe(false)
    expect(errorFrameCanonicalRewrite.appliesTo(env("/v1beta/models/gemini-2.5-pro:streamGenerateContent"))).toBe(false)
  })

  test("non-error frame → emit unchanged (passthrough)", () => {
    const state = errorFrameCanonicalRewrite.createState?.(env(ENDPOINT.MESSAGES)) ?? {}
    const action = errorFrameCanonicalRewrite.transform({ event: "content_block_delta", data: "{}" }, state)
    expect(action).toEqual({ kind: "emit", frames: [{ event: "content_block_delta", data: "{}" }] })
  })

  test("raw upstream event:error frame (non-Anthropic shape) → reshaped into canonical Anthropic envelope, original message preserved", () => {
    const state = errorFrameCanonicalRewrite.createState?.(env(ENDPOINT.MESSAGES)) ?? {}
    const raw = { event: "error", data: JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }) }
    const action = errorFrameCanonicalRewrite.transform(raw, state)
    expect(action.kind).toBe("emit")
    if (action.kind !== "emit") throw new Error("unreachable")
    const data = JSON.parse(action.frames[0].data ?? "{}") as { type: string; error: { type: string; message: string } }
    expect(data.type).toBe("error")
    expect(typeof data.error.type).toBe("string")
    expect(data.error.message).toBe("slow down")
  })

  test("upstream event:error carrying an inner error.type is preserved on the canonical frame", () => {
    const state = errorFrameCanonicalRewrite.createState?.(env(ENDPOINT.MESSAGES)) ?? {}
    const raw = { event: "error", data: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) }
    const action = errorFrameCanonicalRewrite.transform(raw, state)
    if (action.kind !== "emit") throw new Error("unreachable")
    const data = JSON.parse(action.frames[0].data ?? "{}") as { type: string; error: { type: string; message: string } }
    expect(data.error.type).toBe("overloaded_error")
    expect(data.error.message).toBe("Overloaded")
  })

  test("unparseable / shapeless upstream error → canonical api_error fallback, never throws / never drops", () => {
    const state = errorFrameCanonicalRewrite.createState?.(env(ENDPOINT.MESSAGES)) ?? {}
    const action = errorFrameCanonicalRewrite.transform({ event: "error", data: "not json" }, state)
    if (action.kind !== "emit") throw new Error("unreachable")
    const data = JSON.parse(action.frames[0].data ?? "{}") as { type: string; error: { type: string; message: string } }
    expect(data.type).toBe("error")
    expect(data.error.type).toBe("api_error")
    expect(typeof data.error.message).toBe("string")
  })
})
