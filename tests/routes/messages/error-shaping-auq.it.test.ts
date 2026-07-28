/**
 * AUQ (AskUserQuestion) synthesis wiring — end-to-end (Phase 4 Task 4.2,
 * docs/plan/2026-07-13-upstream-error-client-shaping/phase-4-askuserquestion.md).
 *
 * Real Hono app + mocked upstream `globalThis.fetch`, asserting the ACTUAL HTTP
 * response `/v1/messages` returns when a B-class (AUQ candidate) error reaches
 * `shapePrecommitError` with `error_ask_user_question=true`: a synthesized 200
 * response (whole `AnthropicMessageResponse` for stream:false, a self-contained
 * SSE frame sequence for stream:true) carrying an `AskUserQuestion` tool_use —
 * instead of the flattened canonical error body.
 *
 * CF-2 (mandatory gate): synthesis requires BOTH `errorShapingEnabled` AND
 * `errorAskUserQuestion`; either false falls back to the plain canonical error
 * (unchanged from Phase 2's behavior).
 */

import {
  //
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getHistory } from "~/lib/history"
import { drainV3Writer } from "~/lib/history/v3/store"
import { setModels } from "~/lib/models/cache"
import { setStateForTests } from "~/lib/state"

import { mockModel } from "../../helpers/factories"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"
import { applyFetchMock } from "../../helpers/mock-fetch"
import { createFullTestApp } from "../../helpers/test-app"

const MODEL = "claude-3-5-sonnet-latest"
const app = createFullTestApp()

function setupCommonState(): void {
  setStateForTests({
    copilotToken: "test-token",
    accountType: "individual",
    vsCodeVersion: "1.100.0",
    responseHeaderTimeout: 0,
  })
  setModels({
    object: "list",
    data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })],
  })
}

async function postMessages(body: Record<string, unknown>): Promise<Response> {
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 10, messages: [{ role: "user", content: "hi" }], ...body }),
  })
}

function mockUpstreamStatus(status: number, message: string): void {
  applyFetchMock(mock(async () => new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } })))
}

describe("AUQ synthesis — end to end", () => {
  useIsolatedRuntime()

  test("stream:false request, upstream 402 quota_exceeded, error_ask_user_question=true → 200 whole AnthropicMessageResponse with AskUserQuestion tool_use (not a 402 error body)", async () => {
    setupCommonState()
    setStateForTests({ errorShapingEnabled: true, errorAskUserQuestion: true })
    mockUpstreamStatus(402, "You have exceeded your usage quota")

    const res = await postMessages({ stream: false })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      stop_reason: string
      content: Array<{ type: string; name?: string; input?: { questions?: Array<{ options?: Array<unknown> }> } }>
    }
    expect(body.stop_reason).toBe("tool_use")
    expect(body.content[0]?.name).toBe("AskUserQuestion")
    // FIX-B end-to-end: the REAL path (decide() → optionsForErrorType → builder → wire) must emit
    // CC-schema {label, description} object options — not plain strings (see unit test's FIX-B oracle
    // + tests/infra/debug-dry-run-pipeline.http.test.ts:108 real traffic).
    const opts = body.content[0]?.input?.questions?.[0]?.options
    expect(opts?.length).toBeGreaterThan(0)
    for (const opt of opts ?? []) {
      expect(Object.keys(opt as Record<string, unknown>).sort()).toEqual(["description", "label"])
    }
  })

  test("stream:true request, upstream 403 auth_expired, error_ask_user_question=true → 200 SSE with self-contained AUQ frame sequence", async () => {
    setupCommonState()
    setStateForTests({ errorShapingEnabled: true, errorAskUserQuestion: true })
    mockUpstreamStatus(403, "token expired")

    const res = await postMessages({ stream: true })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain("AskUserQuestion")
    expect(text).toContain("message_stop")
  })

  test("error_ask_user_question=false → falls back to plain canonical error (no behavior change from Phase 2)", async () => {
    setupCommonState()
    setStateForTests({ errorShapingEnabled: true, errorAskUserQuestion: false })
    mockUpstreamStatus(402, "You have exceeded your usage quota")

    const res = await postMessages({ stream: false })

    expect(res.status).toBe(402)
  })

  test("errorShapingEnabled=false → falls back to plain canonical error even with errorAskUserQuestion=true (CF-2: both gates required)", async () => {
    setupCommonState()
    setStateForTests({ errorShapingEnabled: false, errorAskUserQuestion: true })
    mockUpstreamStatus(402, "You have exceeded your usage quota")

    const res = await postMessages({ stream: false })

    expect(res.status).toBe(402)
  })

  test("401 auth_expired reaching decide() (post token-refresh exhaustion) with error_ask_user_question=true → also synthesizes AUQ (no 401 special-casing here)", async () => {
    setupCommonState()
    setStateForTests({ errorShapingEnabled: true, errorAskUserQuestion: true })
    mockUpstreamStatus(401, "token expired")

    const res = await postMessages({ stream: false })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { content: Array<{ name?: string }> }
    expect(body.content[0]?.name).toBe("AskUserQuestion")
  })
})

// ============================================================================
// Task 4.3 — history recording invariant (SENTINEL for the D-1 gap)
// ============================================================================
//
// Task 4.3 asked whether the existing RequestContext/history API can express the
// AUQ split (real upstream error in attempts[].upstreamResponse, synthesized 200
// in clientResponse). Empirically probed (see README §0 D-1): it CANNOT, because
// AUQ synthesis happens AFTER handler-v4.ts's generic `ctx.fail()` already froze
// the entry snapshot, and the observability middleware's `setClientResponseStatus`
// safety net is a documented no-op on a settled entry (and returns early on the
// SSE path). Fixing that is a RequestContext settle-lifecycle change OUT of Phase
// 4's authorized scope — so instead of a "locks the ideal invariant" test, this is
// a SENTINEL locking the CURRENT (known-suboptimal) behavior:
//   - POSITIVE invariant that DOES hold: the real upstream 402 is preserved in
//     attempts[].upstreamResponse (richest-data-flow — the real error is never
//     masked by the AUQ synthesis).
//   - DOCUMENTED gap: clientResponse does NOT reflect the synthesized 200 (it is
//     absent). If someone later fixes the settle timing (D-1 option 2/3), this
//     assertion flips red and forces them to update it + revisit D-1.
describe("AUQ synthesis — history recording (Task 4.3 sentinel / D-1)", () => {
  useIsolatedRuntime()

  test("real upstream 402 preserved in attempts[].upstreamResponse; clientResponse gap documented (D-1)", async () => {
    setupCommonState()
    setStateForTests({ errorShapingEnabled: true, errorAskUserQuestion: true })
    mockUpstreamStatus(402, "You have exceeded your usage quota")

    const res = await postMessages({ stream: false })
    expect(res.status).toBe(200)
    await res.json()
    await drainV3Writer()

    const entry = getHistory({ endpoint: "anthropic-messages" }).entries[0]
    expect(entry).toBeDefined()

    // POSITIVE: the real upstream error is not lost — the richest-data-flow guarantee.
    const attempt = entry?.attempts?.[0]
    expect(attempt?.upstreamResponse?.status).toBe(402)
    expect(attempt?.upstreamResponse?.success).toBe(false)

    expect(entry?.clientResponse?.status).toBe(200)
    expect(entry?.clientResponse?.body).toBeDefined()
  })
})

// ============================================================================
// Producer-oracle: synthetic marking on the AUQ streaming path (cross-model review Major)
// ============================================================================
//
// `captureForwardedGenerationFrame`'s 3rd `syntheticKind` param only drives arena
// origin/transformId — projection.ts's `frames()` reads `node.value.synthetic`, so the
// FORWARDED-track `SseEventRecord` itself must carry `synthetic` too, or a 100%
// proxy-fabricated AUQ turn stays indistinguishable from real content (richest-data-flow /
// ADR 2026-07-05 "合成帧必打可辨识标记"). Independent oracle: reads back the SAME persisted
// history entry a real request populates (`getHistory()`), not the route's return value.
describe("AUQ synthesis — forwarded-track synthetic marking (streaming, producer-oracle)", () => {
  useIsolatedRuntime()

  test("every clientResponse.sseEvents frame is tagged synthetic:'error-shaping-auq'", async () => {
    setupCommonState()
    setStateForTests({ errorShapingEnabled: true, errorAskUserQuestion: true })
    mockUpstreamStatus(403, "token expired")

    const res = await postMessages({ stream: true })
    expect(res.status).toBe(200)
    await res.text()
    await drainV3Writer()

    const entry = getHistory({ endpoint: "anthropic-messages" }).entries[0]
    const forwarded = entry?.clientResponse?.sseEvents ?? []
    expect(forwarded.length).toBeGreaterThan(0)
    expect(forwarded.every((e) => e.synthetic === "error-shaping-auq")).toBe(true)
    // The upstream track never carries it — no real upstream response for a pre-commit AUQ (the
    // upstream 403 lives in attempts[].upstreamResponse, not sseEvents, for this non-streaming
    // upstream call), so this stays a pure forwarded-track assertion.
  })
})
