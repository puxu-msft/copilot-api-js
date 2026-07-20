import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import type { RequestContextSnapshot } from "~/lib/observability/events"

import { toActiveRequestWire } from "~/lib/observability/active-request-wire"

// 构造一个带 summary 的快照(模拟 snapshotWithSummary 的产物)。
function snap(over: Partial<RequestContextSnapshot> = {}): RequestContextSnapshot {
  return {
    id: "r1",
    endpoint: "anthropic-messages",
    sessionId: "sess-1",
    rawPath: "/v1/messages?beta=true",
    method: "POST",
    path: "/v1/messages",
    state: "streaming",
    startTime: 1000,
    queueWaitMs: 12,
    clientModel: "claude-sonnet-4",
    resolvedModel: "claude-sonnet-4-20250514",
    requestBodySize: 4096,
    multiplier: 1,
    summary: {
      id: "r1",
      endpoint: "anthropic-messages",
      state: "streaming",
      active: true,
      startTime: 1000,
      durationMs: 50,
      lastUpdatedAt: 2000,
      model: "claude-sonnet-4",
      stream: true,
      attemptCount: 2,
      currentStrategy: "exhaustive",
      queueWaitMs: 12,
      transport: "http",
    },
    ...over,
  }
}

describe("toActiveRequestWire", () => {
  it("投影 summary 标量 + 顶层富字段(requestBodySize/multiplier/method/path/models)", () => {
    const w = toActiveRequestWire(snap())
    expect(w.id).toBe("r1")
    expect(w.attemptCount).toBe(2)
    expect(w.currentStrategy).toBe("exhaustive")
    expect(w.queueWaitMs).toBe(12)
    expect(w.transport).toBe("http")
    expect(w.stream).toBe(true)
    // 顶层富字段——当前 requestPayload 漏掉,这里必须带上
    expect(w.requestBodySize).toBe(4096)
    expect(w.multiplier).toBe(1)
    expect(w.method).toBe("POST")
    expect(w.path).toBe("/v1/messages")
    expect(w.clientModel).toBe("claude-sonnet-4")
    expect(w.resolvedModel).toBe("claude-sonnet-4-20250514")
    expect(w.sessionId).toBe("sess-1")
    expect(w.rawPath).toBe("/v1/messages?beta=true")
  })

  it("summary 缺失时降级到快照标量(防御,不抛)", () => {
    const w = toActiveRequestWire(snap({ summary: undefined, resolvedModel: undefined }))
    expect(w.id).toBe("r1")
    expect(w.state).toBe("streaming")
    expect(w.startTime).toBe(1000)
    expect(w.resolvedModel).toBeUndefined()
    expect(w.attemptCount).toBeUndefined()
    // queueWaitMs/sessionId/rawPath 是快照顶层标量,降级路径不丢
    expect(w.queueWaitMs).toBe(12)
    expect(w.sessionId).toBe("sess-1")
    expect(w.rawPath).toBe("/v1/messages?beta=true")
  })
})
