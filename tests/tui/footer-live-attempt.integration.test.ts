/**
 * BLOCK-1 防回归守卫：在途请求的 footer/panel 读的 `entry.ctx` 来自高频
 * `request.stream_progress` 事件，而后者用的是**轻量 `snapshot()`**（无 `.summary`）。
 *
 * 本测驱动真实 `createRequestContext` → 真实 bus，断言 `stream_progress` 的
 * `ctx` 顶层携带 `currentAttemptStartedAt` / `attemptCount`。若该链路断掉，
 * footer/panel 的 last/total(N) 会在真实运行时静默退化成单值——单测注入 ctx
 * 标量无法发现（会假绿），只有这条真实-bus 路径能守住根因修复点。
 */

import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import { createRequestContext } from "~/lib/context/request"
import { createBus } from "~/lib/observability"

describe("BLOCK-1 回归：stream_progress 后轻量 snapshot 仍带 currentAttemptStartedAt", () => {
  it("真实 ctx beginAttempt + recordStreamProgress → stream_progress 顶层带 attempt 计时", () => {
    const events: Array<unknown> = []
    const bus = createBus()
    bus.subscribe((e) => void events.push(e))
    const ctx = createRequestContext({ endpoint: "anthropic-messages", publisher: bus.scope("request") })
    ctx.beginAttempt({})
    ctx.recordStreamProgress({ bytesIn: 10, eventsIn: 1 })
    const progress = events.find((e) => (e as { kind?: string }).kind === "request.stream_progress") as {
      ctx: { currentAttemptStartedAt?: number; attemptCount?: number }
    }
    expect(progress).toBeDefined()
    expect(progress.ctx.currentAttemptStartedAt).toBeGreaterThan(0)
    expect(progress.ctx.attemptCount).toBe(1)
  })
})
