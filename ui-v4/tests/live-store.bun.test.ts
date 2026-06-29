import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import type { ActiveRequestInfo } from "@/types/ws"

import {
  //
  applyActiveEvent,
  type LiveState,
} from "@/stores/live-store"

const req = (id: string, state = "streaming"): ActiveRequestInfo => ({ id, endpoint: "/v1/messages", state, startTime: 0, durationMs: 0 })

describe("live-store reducer applyActiveEvent", () => {
  it("created adds to the map", () => {
    const s: LiveState = { byId: {} }
    const next = applyActiveEvent(s, { action: "created", request: req("a"), activeCount: 1 })
    expect(Object.keys(next.byId)).toEqual(["a"])
  })
  it("state_changed updates in place", () => {
    const s: LiveState = { byId: { a: req("a", "pending") } }
    const next = applyActiveEvent(s, { action: "state_changed", request: req("a", "streaming"), activeCount: 1 })
    expect(next.byId.a?.state).toBe("streaming")
  })
  it("completed/failed removes from the map", () => {
    const s: LiveState = { byId: { a: req("a"), b: req("b") } }
    const next = applyActiveEvent(s, { action: "completed", requestId: "a", activeCount: 1 })
    expect(Object.keys(next.byId)).toEqual(["b"])
  })
  it("aborted removes from the map (terminal — must leave the Live lane)", () => {
    const s: LiveState = { byId: { a: req("a"), b: req("b") } }
    const next = applyActiveEvent(s, { action: "aborted", requestId: "a", activeCount: 1 })
    expect(Object.keys(next.byId)).toEqual(["b"])
  })
  it("non-terminal requestId-only actions (attempt_failed/feature_applied) are a no-op", () => {
    const s: LiveState = { byId: { a: req("a") } }
    expect(applyActiveEvent(s, { action: "attempt_failed", requestId: "a", activeCount: 1 })).toBe(s)
    expect(applyActiveEvent(s, { action: "feature_applied", requestId: "a", activeCount: 1 })).toBe(s)
  })
  it("returns a NEW object (immutable)", () => {
    const s: LiveState = { byId: {} }
    const next = applyActiveEvent(s, { action: "created", request: req("a"), activeCount: 1 })
    expect(next).not.toBe(s)
    expect(next.byId).not.toBe(s.byId)
  })
})
