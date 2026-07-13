/**
 * Phase 3 FIX-2 — POST-COMMIT canonical error-frame shaping on the REVERSE TRANSLATE LEG
 * (`pumpTranslateLegStreamingV4`, docs/plan/2026-07-13-upstream-error-client-shaping/task-3-report.md FIX-2).
 *
 * The translate leg serves an Anthropic `/v1/messages` client backed by a NON-Anthropic upstream
 * (`claude-x@cc` → GHC /chat/completions). Its H3 (stream-error) and truncation terminators are now routed
 * through the SAME `shapeRawStreamErrorFrame` G-3 builder as the direct pump (byte-identical to the former
 * hand-built JSON), with the CF-2 golden lock (disabled = verbatim legacy bytes). This proves both the
 * wiring is live AND the enabled/disabled outputs are correct on the reverse leg.
 *
 * The `@cc` suffix + a model advertising BOTH /v1/messages and /chat/completions routes the request to the
 * translate leg (Phase 7 auto-route); the mock upstream returns a CC SSE stream that either throws mid-flight
 * (H3) or drains without a finish_reason (truncation).
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../../helpers/factories"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"
import { applyFetchMock } from "../../helpers/mock-fetch"
import {
  //
  createSseResponse,
  createSseResponseThenError,
  dataFramesOfType,
} from "../../helpers/sse"

const MODEL = "claude-x"

/** A CC SSE data chunk (the translate leg's upstream wire). */
function ccChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

/** A CC stream that streams some content then either throws (H3) or cleanly ends without finish_reason. */
const ccContentChunks = [ccChunk({ id: "m", model: MODEL, choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })]

function errorOf(text: string): { type?: string; message?: string } | undefined {
  return dataFramesOfType(text, "error")[0]?.error as { type?: string; message?: string } | undefined
}

async function translateRequest(sessionId: string): Promise<string> {
  const { createFullTestApp } = await import("../../helpers/test-app")
  const app = createFullTestApp()
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({ model: `${MODEL}@cc`, messages: [{ role: "user", content: "hi" }], max_tokens: 128, stream: true }),
  })
  expect(res.status).toBe(200)
  return res.text()
}

describe("translate-leg post-commit error shaping (FIX-2, @cc reverse leg)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      streamKeepalivePingSec: 0,
      streamCommitAfterSec: 0,
      protectStreamingGeneration: false,
      errorShapingEnabled: true,
    })
    setModels({
      object: "list",
      data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.CHAT_COMPLETIONS] })],
    })
  })

  // ── truncation (terminus ③ on the translate leg) ──────────────────────────
  test.each([true, false])(
    "truncation (CC drains without finish_reason), errorShapingEnabled=%p → canonical api_error frame ('no finish_reason')",
    async (enabled) => {
      setStateForTests({ errorShapingEnabled: enabled })
      applyFetchMock(mock(() => Promise.resolve(createSseResponse(ccContentChunks))))
      const text = await translateRequest(`translate-trunc-${enabled}`)
      expect(errorOf(text)?.type).toBe("api_error")
      expect(errorOf(text)?.message).toBe("Upstream stream truncated before completion (no finish_reason)")
      // Golden lock: the wire shape is byte-identical whether on/off (builder == former hand-built literal).
      const raw = dataFramesOfType(text, "error")[0]
      expect(JSON.stringify(raw)).toBe(
        JSON.stringify({ type: "error", error: { type: "api_error", message: "Upstream stream truncated before completion (no finish_reason)" } }),
      )
    },
  )

  // ── H3 stream-error (terminus ② on the translate leg) ─────────────────────
  test.each([true, false])("H3 mid-stream throw, errorShapingEnabled=%p → canonical error frame via anthropicStreamErrorType", async (enabled) => {
    setStateForTests({ errorShapingEnabled: enabled })
    applyFetchMock(mock(() => Promise.resolve(createSseResponseThenError(ccContentChunks, new Error("upstream cc stream blew up")))))
    const text = await translateRequest(`translate-h3-${enabled}`)
    // classifyStreamError(non-shutdown/non-idle) → api_error; message carries the thrown error text.
    expect(errorOf(text)?.type).toBe("api_error")
    expect(errorOf(text)?.message).toBe("upstream cc stream blew up")
  })
})
