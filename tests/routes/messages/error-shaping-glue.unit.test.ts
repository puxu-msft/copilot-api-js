/**
 * Unit tests for `shapePrecommitError` (Phase 2 Task 2.3,
 * docs/plan/2026-07-13-upstream-error-client-shaping/phase-2-precommit-retry-signal.md).
 *
 * Exhaustive branch coverage across all 11 `ApiErrorType`s (see `~/lib/error` `ApiErrorType`) plus
 * the two structural gates (CF-2 disabled-gate, abort passthrough). This is a pure unit test — a
 * hand-built fake `Context` capturing `header()`/`json()` calls, no Hono app, no runtime bootstrap
 * (mirrors `tests/infra/error-format.unit.test.ts`'s `mockContext()` pattern). `autoRestoreState()`
 * is the correct isolation tool here (no `useIsolatedRuntime()` — this file never boots a runtime,
 * per `test-isolation`'s "don't stack the two" rule).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import { HTTPError } from "~/lib/error"
import { setStateForTests } from "~/lib/state"

import { shapePrecommitError } from "../../../src/routes/messages/error-shaping-glue"
import { autoRestoreState } from "../../helpers/state-fixture"

// ============================================================================
// Fake Context — captures header()/json() calls, no real Hono/Response plumbing.
// ============================================================================

interface CapturedContext {
  // `any`, same convention as `tests/infra/error-format.unit.test.ts`'s `mockContext()` — a real
  // `Context` has 20+ unrelated members; this fake only implements what `forwardError`/
  // `shapePrecommitError` actually touch (`header`, `json`, `req.method`/`req.path`/`req.raw.signal`).
  c: any
  headers: Map<string, string>
  getLastJson: () => { data: unknown; status: number } | null
  /** `requestContext.recordFeature` calls captured by the fake `c.get("requestContext")`
   *  (FIX-OBS-2 cross-phase wiring — decode-tool-input.unit.test.ts's `{ id, recordFeature }` convention). */
  features: Array<{ feature: string; detail?: Record<string, unknown> }>
}

/**
 * `getLastJson` is a plain function (not a getter destructured eagerly) — `forwardError`'s
 * `HTTPError` branch calls `c.json(...)` synchronously inside `shapePrecommitError`, so the
 * caller must read the captured value AFTER invoking, not snapshot it via destructuring before.
 * `req.raw.signal` is required by `forwardError`'s non-HTTPError abort branch (client-disconnect
 * vs. response-header-timeout discrimination); default to a fresh, non-aborted signal.
 *
 * `c.get("requestContext")` returns a fake `RequestContext` carrying only `id`/`originalRequest`/
 * `recordFeature` — the three members `shapePrecommitError` actually touches (mirrors the real
 * Hono `Context.get()` shape, matching production's pre-commit `ctx` extraction).
 */
function fakeContext(opts?: { originalRequest?: { stream?: boolean; model?: string }; reqId?: string }): CapturedContext {
  const headers = new Map<string, string>()
  let lastJson: { data: unknown; status: number } | null = null
  const features: Array<{ feature: string; detail?: Record<string, unknown> }> = []
  const requestContext = {
    id: opts?.reqId ?? "req_test",
    originalRequest: opts?.originalRequest,
    recordFeature: (feature: string, detail?: Record<string, unknown>) => {
      features.push({ feature, detail })
    },
    setClientResponseStatus() {},
    setInboundResponseHeaders() {},
    finalizeModelOperationDelivery() {},
  }
  return {
    headers,
    getLastJson: () => lastJson,
    features,
    c: {
      header: (name: string, value: string) => {
        headers.set(name.toLowerCase(), value)
      },
      json: (data: unknown, status?: number) => {
        lastJson = { data, status: status ?? 200 }
        return new Response(JSON.stringify(data), { status: status ?? 200 })
      },
      get: (key: string) => (key === "requestContext" ? requestContext : undefined),
      req: { method: "POST", path: "/v1/messages", raw: { signal: new AbortController().signal } },
    } as any,
  }
}

// ============================================================================
// Fixtures — one HTTPError/Error per ApiErrorType, chosen so classifyError()
// deterministically lands on that exact type (see ~/lib/error/classify.ts).
// ============================================================================

const fixtures = {
  rate_limited: () => new HTTPError("Rate limited", 429, JSON.stringify({ error: { message: "Too many requests" } })),
  upstream_rate_limited: () => new HTTPError("Upstream rate limited", 503, JSON.stringify({ error: { message: "Upstream provider rate limited" } })),
  server_error: () => new HTTPError("Server error", 500, ""),
  network_error: () => new Error("fetch failed: socket hang up"),
  payload_too_large: () => new HTTPError("Too large", 413, ""),
  token_limit: () => new HTTPError("Token limit", 400, JSON.stringify({ error: { message: "prompt is too long: 5000 tokens > 4096 maximum" } })),
  bad_request: () => new HTTPError("Bad request", 400, JSON.stringify({ error: { message: "malformed payload" } })),
  content_filtered: () => new HTTPError("Filtered", 422, ""),
  quota_exceeded: () => new HTTPError("Quota exceeded", 402, ""),
  auth_expired: () => new HTTPError("Unauthorized", 401, ""),
  aborted: () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
} as const

describe("shapePrecommitError — exhaustive branch coverage (Task 2.3)", () => {
  autoRestoreState()

  let warnSpy: ReturnType<typeof spyOn>
  let errorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    setStateForTests({ errorShapingEnabled: true, errorAskUserQuestion: false })
    const noop = Object.assign((..._args: Array<unknown>) => {}, { raw: (..._args: Array<unknown>) => {} })
    warnSpy = spyOn(consola, "warn").mockImplementation(noop as never)
    errorSpy = spyOn(consola, "error").mockImplementation(noop as never)
  })

  afterEach(() => {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  test.each(["rate_limited", "upstream_rate_limited", "server_error", "network_error"] as const)(
    "A类可重试(%s) → x-should-retry:true set (retry-signal)",
    (key) => {
      const { c, headers } = fakeContext()
      shapePrecommitError(c, fixtures[key]())
      expect(headers.get("x-should-retry")).toBe("true")
    },
  )

  test.each(["content_filtered", "quota_exceeded", "auth_expired"] as const)(
    "B类(%s), askUserQuestion=false（默认）→ 无重试头（当前范围只处理 A 类；AUQ 合成是 Phase 4）",
    (key) => {
      const { c, headers } = fakeContext()
      shapePrecommitError(c, fixtures[key]())
      expect(headers.has("x-should-retry")).toBe(false)
      expect(headers.has("retry-after")).toBe(false)
    },
  )

  test.each(["token_limit", "payload_too_large", "bad_request"] as const)("C类(%s) → 无重试头", (key) => {
    const { c, headers } = fakeContext()
    shapePrecommitError(c, fixtures[key]())
    expect(headers.has("x-should-retry")).toBe(false)
    expect(headers.has("retry-after")).toBe(false)
  })

  test("aborted → 直接走 forwardError，从不调用 decide()（非目标；decide() 对 aborted 会抛出，若误调用此用例会暴露）", () => {
    const { c, headers, getLastJson } = fakeContext()
    const res = shapePrecommitError(c, fixtures.aborted())
    expect(res).toBeInstanceOf(Response)
    expect(headers.size).toBe(0)
    // isAbortError short-circuits before classifyError/decide — forwardError's non-HTTPError abort
    // branch runs, landing on 499/504 per its own signal-based dispatch (not asserted here, only that
    // shapePrecommitError didn't throw and didn't inject retry headers).
    expect(getLastJson()).not.toBeNull()
  })

  test("CF-2 golden lock: error_shaping_enabled=false → forwardError called verbatim, decide() never runs (no headers even for an A-class error)", () => {
    setStateForTests({ errorShapingEnabled: false })
    const { c, headers, getLastJson } = fakeContext()
    shapePrecommitError(c, fixtures.rate_limited())
    expect(headers.size).toBe(0)
    expect(getLastJson()?.status).toBe(429)
  })

  test("retryAfterSec present (retry_after in body) → real Retry-After header value, not just x-should-retry", () => {
    const { c, headers } = fakeContext()
    const error = new HTTPError("Upstream rate limited", 503, JSON.stringify({ error: { message: "Upstream provider rate limited", retry_after: 45 } }))
    shapePrecommitError(c, error)
    expect(headers.get("retry-after")).toBe("45")
    expect(headers.get("x-should-retry")).toBe("true")
  })

  test("retryAfterSec absent → x-should-retry:true but no fabricated Retry-After", () => {
    const { c, headers } = fakeContext()
    shapePrecommitError(c, fixtures.rate_limited())
    expect(headers.has("retry-after")).toBe(false)
    expect(headers.get("x-should-retry")).toBe("true")
  })
})

// ============================================================================
// FIX-OBS-2 (whole-branch review cross-phase gap): `error-shaping-decided` was declared in
// FeatureKind (~/lib/observability/events.ts) but had ZERO production call sites. `decide()`'s
// output must be observable — recorded via the pre-commit ctx (`c.get("requestContext")`, already
// exposed for the AUQ branch) right after every `decide()` call, for ALL FOUR decision kinds
// reachable pre-commit (retry-signal / ask-user-question / canonical-error — defer-to-block-level
// is post-commit-only, unreachable here).
// ============================================================================
describe("shapePrecommitError — recordFeature('error-shaping-decided') wiring (FIX-OBS-2)", () => {
  autoRestoreState()

  beforeEach(() => {
    setStateForTests({ errorShapingEnabled: true, errorAskUserQuestion: false })
  })

  test.each([
    ["rate_limited", "retry-signal"],
    ["upstream_rate_limited", "retry-signal"],
    ["server_error", "retry-signal"],
    ["network_error", "retry-signal"],
    ["token_limit", "canonical-error"],
    ["payload_too_large", "canonical-error"],
    ["bad_request", "canonical-error"],
    ["content_filtered", "canonical-error"], // B类, askUserQuestion=false → falls to canonical
    ["quota_exceeded", "canonical-error"],
    ["auth_expired", "canonical-error"],
  ] as const)("%s → decide() 命中记录 error-shaping-decided(decision=%s, commitPhase=pre-commit)", (key, expectedDecision) => {
    const { c, features } = fakeContext()
    shapePrecommitError(c, fixtures[key]())
    expect(features).toContainEqual({
      feature: "error-shaping-decided",
      detail: { decision: expectedDecision, errorType: key, commitPhase: "pre-commit" },
    })
  })

  test("aborted → decide() never called (non-target, isAbortError short-circuit) → error-shaping-decided NOT recorded", () => {
    const { c, features } = fakeContext()
    shapePrecommitError(c, fixtures.aborted())
    expect(features).toEqual([])
  })

  test("CF-2 disabled → decide() never called → error-shaping-decided NOT recorded (golden lock symmetry)", () => {
    setStateForTests({ errorShapingEnabled: false })
    const { c, features } = fakeContext()
    shapePrecommitError(c, fixtures.rate_limited())
    expect(features).toEqual([])
  })
})

describe("shapePrecommitError — recordFeature('error-shaping-auq-synthesized') wiring (FIX-OBS-2)", () => {
  autoRestoreState()

  test("B类 + askUserQuestion=true → records BOTH error-shaping-decided(ask-user-question) AND error-shaping-auq-synthesized", () => {
    setStateForTests({ errorShapingEnabled: true, errorAskUserQuestion: true })
    const { c, features } = fakeContext()
    shapePrecommitError(c, fixtures.content_filtered())
    expect(features).toContainEqual({
      feature: "error-shaping-decided",
      detail: { decision: "ask-user-question", errorType: "content_filtered", commitPhase: "pre-commit" },
    })
    expect(features).toContainEqual({ feature: "error-shaping-auq-synthesized", detail: { errorType: "content_filtered" } })
  })

  test("B类 + askUserQuestion=false → falls to canonical-error, does NOT record error-shaping-auq-synthesized", () => {
    setStateForTests({ errorShapingEnabled: true, errorAskUserQuestion: false })
    const { c, features } = fakeContext()
    shapePrecommitError(c, fixtures.content_filtered())
    expect(features.some((f) => f.feature === "error-shaping-auq-synthesized")).toBe(false)
  })

  test("A类/C类 → never records error-shaping-auq-synthesized (only the ask-user-question decision kind does)", () => {
    setStateForTests({ errorShapingEnabled: true, errorAskUserQuestion: true })
    const { c, features } = fakeContext()
    shapePrecommitError(c, fixtures.token_limit())
    expect(features.some((f) => f.feature === "error-shaping-auq-synthesized")).toBe(false)
  })
})
