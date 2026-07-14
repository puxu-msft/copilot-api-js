import { describe, expect, it } from "bun:test"

import { recordLatest, recordOnce, type AttemptTiming } from "./request-timing"

describe("recordTiming", () => {
  it("recordOnce keeps the FIRST write, ignores later", () => {
    const t: AttemptTiming = {}
    recordOnce(t, "upstreamHeadersAt", 100)
    recordOnce(t, "upstreamHeadersAt", 200)
    expect(t.upstreamHeadersAt).toBe(100)
  })
  it("recordLatest keeps the LAST write", () => {
    const t: AttemptTiming = {}
    recordLatest(t, "upstreamLastTokenAt", 100)
    recordLatest(t, "upstreamLastTokenAt", 200)
    expect(t.upstreamLastTokenAt).toBe(200)
  })
  it("recordOnce ignores undefined/null", () => {
    const t: AttemptTiming = {}
    recordOnce(t, "upstreamHeadersAt", undefined as unknown as number)
    expect(t.upstreamHeadersAt).toBeUndefined()
  })
})
