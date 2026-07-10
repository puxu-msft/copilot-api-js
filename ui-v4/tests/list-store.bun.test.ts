import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import {
  //
  initialListState,
  reduceListEvent,
  type ListState,
} from "@/stores/list-store"

describe("list-store reducer", () => {
  it("tail-on: incoming entry id is NOT buffered (caller prepends live)", () => {
    const s: ListState = { ...initialListState, tailOn: true }
    const next = reduceListEvent(s, { kind: "incoming", id: "x" })
    expect(next.bufferedIds).toEqual([])
  })
  it("paused: incoming entry id is buffered", () => {
    const s: ListState = { ...initialListState, tailOn: false }
    const next = reduceListEvent(s, { kind: "incoming", id: "x" })
    expect(next.bufferedIds).toEqual(["x"])
  })
  it("paused: duplicate incoming id not double-buffered", () => {
    const s: ListState = { ...initialListState, tailOn: false, bufferedIds: ["x"] }
    const next = reduceListEvent(s, { kind: "incoming", id: "x" })
    expect(next.bufferedIds).toEqual(["x"])
  })
  it("flush clears the buffer and turns tail back on", () => {
    const s: ListState = { ...initialListState, tailOn: false, bufferedIds: ["x", "y"] }
    const next = reduceListEvent(s, { kind: "flush" })
    expect(next.bufferedIds).toEqual([])
    expect(next.tailOn).toBe(true)
  })
  it("locate + scroll-up both pause tail (selection truth lives in the URL, not the store)", () => {
    expect(reduceListEvent({ ...initialListState, tailOn: true }, { kind: "locate" })).toMatchObject({ tailOn: false })
    expect(reduceListEvent({ ...initialListState, tailOn: true }, { kind: "scroll-up" }).tailOn).toBe(false)
  })
  it("locate is idempotent when already paused (returns same ref → no needless re-render)", () => {
    const paused: ListState = { ...initialListState, tailOn: false }
    expect(reduceListEvent(paused, { kind: "locate" })).toBe(paused)
  })
  it("resume turns tail on and clears buffer", () => {
    const next = reduceListEvent({ ...initialListState, tailOn: false, bufferedIds: ["x"] }, { kind: "resume" })
    expect(next).toMatchObject({ tailOn: true, bufferedIds: [] })
  })
  it("pause turns tail off but KEEPS the buffer (explicit user pause, ≠ resume)", () => {
    const next = reduceListEvent({ ...initialListState, tailOn: true, bufferedIds: ["x"] }, { kind: "pause" })
    expect(next.tailOn).toBe(false)
    expect(next.bufferedIds).toEqual(["x"]) // 暂停不清缓冲(区别于 resume/flush)
  })
  it("pause is idempotent when already paused (returns same ref → no needless re-render)", () => {
    const paused: ListState = { ...initialListState, tailOn: false }
    expect(reduceListEvent(paused, { kind: "pause" })).toBe(paused)
  })
})
