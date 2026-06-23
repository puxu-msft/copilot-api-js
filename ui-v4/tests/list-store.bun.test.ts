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
  it("select pauses tail and records id; scroll-up pauses", () => {
    expect(reduceListEvent({ ...initialListState, tailOn: true }, { kind: "select", id: "a" })).toMatchObject({ tailOn: false, selectedId: "a" })
    expect(reduceListEvent({ ...initialListState, tailOn: true }, { kind: "scroll-up" }).tailOn).toBe(false)
  })
  it("resume turns tail on and clears buffer", () => {
    const next = reduceListEvent({ ...initialListState, tailOn: false, bufferedIds: ["x"] }, { kind: "resume" })
    expect(next).toMatchObject({ tailOn: true, bufferedIds: [] })
  })
})
