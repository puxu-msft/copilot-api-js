import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestContextSnapshot } from "~/lib/observability"

import { ActiveRequestStore } from "~/lib/tui/active-request-store"

function ctx(id: string, state: RequestContextSnapshot["state"] = "executing"): RequestContextSnapshot {
  return { id, endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", state, startTime: 1, queueWaitMs: 0 }
}

describe("ActiveRequestStore", () => {
  test("upserts live snapshots but never resurrects terminal late events", () => {
    const store = new ActiveRequestStore()
    store.apply({ kind: "request.created", ctx: ctx("a") })
    store.apply({ kind: "request.model_resolved", ctx: { ...ctx("a"), resolvedModel: "m" } })
    store.apply({ kind: "request.failed", ctx: ctx("a", "failed"), entry: { id: "a", endpoint: "anthropic-messages", state: "failed" }, error: "x" } as never)
    store.apply({ kind: "request.feature_applied", ctx: ctx("a", "failed"), feature: "error-shaping-decided" })
    expect(store.size).toBe(0)
  })

  test("replaces an attempt snapshot with the richer settled version", () => {
    const store = new ActiveRequestStore()
    store.apply({ kind: "request.created", ctx: ctx("a") })
    store.apply({ kind: "request.attempt_started", ctx: ctx("a"), attempt: { attemptIndex: 0, strategy: "first" } })
    store.apply({
      kind: "request.attempt_failed",
      ctx: ctx("a"),
      attempt: { attemptIndex: 0, strategy: "first", error: { status: 500, message: "x", type: "server_error" } },
      willRetry: false,
    })
    expect(store.get("a")?.attempts).toHaveLength(1)
    expect(store.get("a")?.attempts[0].error?.status).toBe(500)
  })
})
