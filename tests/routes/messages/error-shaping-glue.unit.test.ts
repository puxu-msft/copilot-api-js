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
}

/**
 * `getLastJson` is a plain function (not a getter destructured eagerly) — `forwardError`'s
 * `HTTPError` branch calls `c.json(...)` synchronously inside `shapePrecommitError`, so the
 * caller must read the captured value AFTER invoking, not snapshot it via destructuring before.
 * `req.raw.signal` is required by `forwardError`'s non-HTTPError abort branch (client-disconnect
 * vs. response-header-timeout discrimination); default to a fresh, non-aborted signal.
 */
function fakeContext(): CapturedContext {
  const headers = new Map<string, string>()
  let lastJson: { data: unknown; status: number } | null = null
  return {
    headers,
    getLastJson: () => lastJson,
    c: {
      header: (name: string, value: string) => {
        headers.set(name.toLowerCase(), value)
      },
      json: (data: unknown, status?: number) => {
        lastJson = { data, status: status ?? 200 }
        return new Response(JSON.stringify(data), { status: status ?? 200 })
      },
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
