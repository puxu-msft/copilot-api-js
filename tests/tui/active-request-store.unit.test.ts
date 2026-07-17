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
    expect(store.upsert(ctx("a")).inserted).toBe(true)
    expect(store.upsert({ ...ctx("a"), resolvedModel: "m" }).inserted).toBe(false)
    store.remove("a")
    expect(store.upsert(ctx("a", "failed")).inserted).toBe(false)
    expect(store.size).toBe(0)
  })

  test("replaces an attempt snapshot with the richer settled version", () => {
    const store = new ActiveRequestStore()
    const entry = store.create(ctx("a"))
    store.recordAttempt(entry, { attemptIndex: 0, strategy: "first" })
    store.recordAttempt(entry, { attemptIndex: 0, strategy: "first", error: { status: 500, message: "x", type: "server_error" } })
    expect(entry.attempts).toHaveLength(1)
    expect(entry.attempts[0].error?.status).toBe(500)
  })
})
