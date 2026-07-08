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

const req = (id: string, state = "streaming"): ActiveRequestInfo => ({ id, endpoint: "anthropic-messages", state, startTime: 0, durationMs: 0 })

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
  it("attempt_failed 合并实时重试遥测到 byId[id].retry", () => {
    const s: LiveState = { byId: { a: req("a") } }
    const next = applyActiveEvent(s, {
      action: "attempt_failed",
      requestId: "a",
      attempt: 2,
      strategy: "default",
      willRetry: true,
      nextStrategy: "exhaustive",
      waitMs: 1200,
    })
    expect(next.byId.a?.retry).toEqual({ attempt: 2, strategy: "default", willRetry: true, nextStrategy: "exhaustive", waitMs: 1200 })
  })

  it("attempt_failed 对不存在的 id 是 no-op(返回原引用)", () => {
    const s: LiveState = { byId: { a: req("a") } }
    expect(applyActiveEvent(s, { action: "attempt_failed", requestId: "z", attempt: 1, willRetry: false, waitMs: 0 })).toBe(s)
  })

  it("feature_applied 追加到 byId[id].features[]", () => {
    const s: LiveState = { byId: { a: req("a") } }
    const next = applyActiveEvent(s, { action: "feature_applied", requestId: "a", feature: "thinking", detail: { effective: "adaptive" } })
    expect(next.byId.a?.features).toEqual([{ feature: "thinking", detail: { effective: "adaptive" } }])
  })

  it("state_changed 刷新时清除陈旧 retry(新一轮 attempt 开始)", () => {
    const s: LiveState = { byId: { a: { ...req("a"), retry: { attempt: 1, willRetry: true, waitMs: 500 } } } }
    const next = applyActiveEvent(s, { action: "state_changed", request: req("a", "streaming"), activeCount: 1 })
    expect(next.byId.a?.retry).toBeUndefined()
  })
  it("returns a NEW object (immutable)", () => {
    const s: LiveState = { byId: {} }
    const next = applyActiveEvent(s, { action: "created", request: req("a"), activeCount: 1 })
    expect(next).not.toBe(s)
    expect(next.byId).not.toBe(s.byId)
  })
})
