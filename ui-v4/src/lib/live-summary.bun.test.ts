import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import type { LiveEntry } from "@/stores/live-store"

import {
  //
  groupKey,
  summarizeLive,
} from "@/lib/live-summary"

const row = (over: Partial<LiveEntry>): LiveEntry => ({ id: "x", endpoint: "anthropic-messages", state: "streaming", startTime: 0, ...over }) as LiveEntry

describe("groupKey", () => {
  it("优先 resolvedModel,回退 model,再回退 resolving…", () => {
    expect(groupKey(row({ resolvedModel: "m-2", model: "m-1" }))).toBe("m-2")
    expect(groupKey(row({ model: "m-1" }))).toBe("m-1")
    expect(groupKey(row({}))).toBe("resolving…")
  })
})

describe("summarizeLive", () => {
  it("统计 count/streaming/retrying/oldest 并按模型分组、oldest-first", () => {
    const rows = [
      row({ id: "a", resolvedModel: "gpt-4o", state: "streaming", startTime: 1000 }),
      row({ id: "b", resolvedModel: "gpt-4o", state: "pending", startTime: 500, retry: { attempt: 2, willRetry: true, waitMs: 100 } }),
      row({ id: "c", resolvedModel: "claude", state: "streaming", startTime: 2000 }),
    ]
    const s = summarizeLive(rows, 3000)
    expect(s.count).toBe(3)
    expect(s.streaming).toBe(2)
    expect(s.retrying).toBe(1)
    expect(s.oldestElapsedMs).toBe(2500) // 3000 - 500
    // 组按各组内最旧 startTime 升序:gpt-4o(500) 在 claude(2000) 前
    expect(s.groups.map((g) => g.key)).toEqual(["gpt-4o", "claude"])
    // 组内 oldest-first
    expect(s.groups[0]?.rows.map((r) => r.id)).toEqual(["b", "a"])
  })

  it("空集:count 0、oldest 0、无组", () => {
    const s = summarizeLive([], 100)
    expect(s.count).toBe(0)
    expect(s.oldestElapsedMs).toBe(0)
    expect(s.groups).toEqual([])
  })
})
