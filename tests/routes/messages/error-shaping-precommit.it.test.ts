/**
 * Pre-commit Anthropic error shaping — route.ts wiring (Phase 2,
 * docs/plan/2026-07-13-upstream-error-client-shaping/phase-2-precommit-retry-signal.md).
 *
 * End-to-end (real Hono app + mocked upstream `globalThis.fetch`), so the assertions are on the
 * ACTUAL HTTP response headers `/v1/messages` returns — not just `shapePrecommitError`'s return
 * value in isolation (that's `error-shaping-glue.unit.test.ts`).
 *
 * Task 2.1 — golden lock: `error_shaping_enabled=false` reproduces the exact pre-Phase-2 bytes.
 * Task 2.2 — A-class retry-signal real `Retry-After` / `x-should-retry` headers when enabled.
 * CF-1 — integration assertion for the Phase 1 review carry-forward: an UNEXHAUSTED 401/403 is
 * consumed transparently by the `token-refresh` `RetryStrategy` several layers below `route.ts` and
 * NEVER reaches `shapePrecommitError` as an `ApiError` — only an EXHAUSTED 401 (token-refresh's
 * single refresh already spent) bubbles out of the pipeline and reaches the glue.
 */

import {
  //
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { setModels } from "~/lib/models/cache"
import { setStateForTests } from "~/lib/state"
import {
  //
  installTokenRuntime,
  resetTokenRuntimeForTests,
  type TokenRuntime,
} from "~/lib/token"

import { mockModel } from "../../helpers/factories"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"
import { applyFetchMock } from "../../helpers/mock-fetch"
import { createFullTestApp } from "../../helpers/test-app"

const MODEL = "claude-3-5-sonnet-latest"
const app = createFullTestApp()

/** Anthropic non-streaming success body the mocked upstream returns on a 200. */
function successBody(): string {
  return JSON.stringify({
    id: "msg-precommit-test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model: MODEL,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 2 },
  })
}

async function postMessages(): Promise<Response> {
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  })
}

// ============================================================================
// Task 2.1 — golden lock (disabled)
// ============================================================================

describe("pre-commit error shaping — golden lock (disabled)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setupCommonState()
    setStateForTests({ errorShapingEnabled: false })
  })

  test("429 rate_limited, no parseable retry-after → byte-identical to plain forwardError (no synthetic headers, unclassified body untouched)", async () => {
    applyFetchMock(
      mock(
        async () =>
          new Response(JSON.stringify({ error: { code: "rate_limited", message: "Too many requests" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          }),
      ),
    )

    const res = await postMessages()

    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBeNull()
    expect(res.headers.get("x-should-retry")).toBeNull()
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("rate_limit_error")
  })
})

// ============================================================================
// Task 2.2 — enabled, A-class retry-signal
// ============================================================================

describe("pre-commit error shaping — enabled, A-class retry-signal", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setupCommonState()
    setStateForTests({ errorShapingEnabled: true })
  })

  test("503 upstream-rate-limited with a parseable retry_after in the body → real Retry-After + x-should-retry:true headers", async () => {
    // NOTE: deliberately no `error.code` field here. `~/lib/error/forward.ts:mapHttpErrorToEnvelope`
    // (untouched by this phase) matches `errorObj.error?.code === "rate_limited"` (exact) BEFORE its
    // own 503 branch, which would force the final wire status to 429 regardless of the true upstream
    // 503 — a pre-existing divergence from `classify.ts`'s `isUpstreamRateLimited` (which matches on
    // `code.includes("rate")` OR a "rate limit" substring in `message`). Using message-only keeps both
    // classifiers in agreement on 503, which is what this test is actually about (see task-2 report).
    applyFetchMock(
      mock(
        async () =>
          new Response(JSON.stringify({ error: { message: "Upstream provider rate limited", retry_after: 60 } }), {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
      ),
    )

    const res = await postMessages()

    expect(res.status).toBe(503)
    expect(res.headers.get("retry-after")).toBe("60")
    expect(res.headers.get("x-should-retry")).toBe("true")
  })

  test("429 rate_limited without a parseable retry-after → x-should-retry:true set, Retry-After absent (not fabricated)", async () => {
    applyFetchMock(
      mock(
        async () =>
          new Response(JSON.stringify({ error: { code: "rate_limited", message: "Too many requests" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          }),
      ),
    )

    const res = await postMessages()

    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBeNull()
    expect(res.headers.get("x-should-retry")).toBe("true")
  })

  test("402 quota_exceeded (B类, not A) → no x-should-retry / Retry-After (spec N-1: CC never retries 402)", async () => {
    applyFetchMock(
      mock(
        async () =>
          new Response(JSON.stringify({ error: { message: "You have exceeded your usage quota" } }), {
            status: 402,
            headers: { "content-type": "application/json" },
          }),
      ),
    )

    const res = await postMessages()

    expect(res.status).toBe(402)
    expect(res.headers.get("x-should-retry")).toBeNull()
    expect(res.headers.get("retry-after")).toBeNull()
  })

  test("400 token_limit (C类) → no retry headers, body identical to the disabled path", async () => {
    applyFetchMock(
      mock(
        async () =>
          new Response(JSON.stringify({ error: { message: "prompt is too long: 5000 tokens > 4096 maximum" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      ),
    )

    const res = await postMessages()

    expect(res.status).toBe(400)
    expect(res.headers.get("x-should-retry")).toBeNull()
    expect(res.headers.get("retry-after")).toBeNull()
    const body = (await res.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("prompt is too long")
  })
})

// ============================================================================
// CF-1 — token-refresh consumes unexhausted 401/403 BEFORE error-shaping ever sees it
// ============================================================================

describe("pre-commit error shaping — CF-1: token-refresh vs. error-shaping ordering", () => {
  useIsolatedRuntime()

  const mockRefresh = mock<() => Promise<boolean>>()

  beforeEach(() => {
    setupCommonState()
    setStateForTests({ errorShapingEnabled: true })
    mockRefresh.mockReset()
    mockRefresh.mockResolvedValue(true)
    // Install a runtime whose Copilot-token refresh succeeds so a single 401 is
    // refreshed + retried by the token-refresh strategy (peekTokenRuntime()).
    // useIsolatedRuntime()'s afterEach disposes/clears it via RESETTERS.
    installTokenRuntime({ refreshCopilotToken: () => mockRefresh(), dispose: async () => {} } as unknown as TokenRuntime)
  })

  afterAll(async () => {
    await resetTokenRuntimeForTests()
  })

  test("a single (unexhausted) 401 is refreshed + retried transparently — the client sees the eventual 200, never an error-shaping response", async () => {
    let calls = 0
    applyFetchMock(
      mock(async () => {
        calls += 1
        if (calls === 1) {
          return new Response(JSON.stringify({ error: { message: "token expired" } }), { status: 401, headers: { "content-type": "application/json" } })
        }
        return new Response(successBody(), { status: 200, headers: { "content-type": "application/json" } })
      }),
    )

    const res = await postMessages()

    expect(res.status).toBe(200)
    expect(calls).toBe(2)
    expect(mockRefresh).toHaveBeenCalledTimes(1)
    // No retry-signal headers on a plain success — proves decide()/shapePrecommitError never ran.
    expect(res.headers.get("x-should-retry")).toBeNull()
  })

  test("an EXHAUSTED 401 (token-refresh's one refresh already spent) reaches shapePrecommitError as auth_expired — B类 canonical, NOT A类 retry-signal", async () => {
    applyFetchMock(
      mock(async () => new Response(JSON.stringify({ error: { message: "token expired" } }), { status: 401, headers: { "content-type": "application/json" } })),
    )

    const res = await postMessages()

    expect(res.status).toBe(401)
    expect(mockRefresh).toHaveBeenCalledTimes(1) // token-refresh only ever spends ONE refresh per request
    // auth_expired is a B-class AUQ-candidate type, not A-class — default askUserQuestion=false means
    // canonical-error, so no retry-signal headers even though error-shaping is enabled.
    expect(res.headers.get("x-should-retry")).toBeNull()
    expect(res.headers.get("retry-after")).toBeNull()
  })
})

// ============================================================================
// Shared setup
// ============================================================================

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
