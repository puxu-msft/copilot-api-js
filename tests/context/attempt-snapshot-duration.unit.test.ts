/**
 * Task 2 — `recordAttemptFailure` 透传 `AttemptSnapshot.durationMs`。
 *
 * 验证 `setAttemptError` 定稿本次 attempt 的 `durationMs`（`Date.now() - startTime`）
 * 后，`recordAttemptFailure` 发布的 `request.attempt_failed` 事件的 `AttemptSnapshot`
 * 携带该 `durationMs`（供 Task 6 的 `[RETRY]` 行作 `lastMs`）。
 *
 * 复用 request-emit-methods.unit.test.ts 的 per-test bus 模式（`createBus()` +
 * `bus.subscribe` 收集事件 + `bus.scope("request")` 作 publisher）——无单例污染、
 * 无 `mock.module`、无全局状态。
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ObservabilityEvent } from "~/lib/observability"

import { createRequestContext } from "~/lib/context/request"
import { createBus } from "~/lib/observability"

function setup() {
  const bus = createBus()
  const events: Array<ObservabilityEvent> = []
  bus.subscribe((e) => {
    events.push(e)
  })

  const ctx = createRequestContext({
    endpoint: "anthropic-messages",
    method: "POST",
    path: "/v1/messages",
    publisher: bus.scope("request"),
  })
  return { bus, ctx, events }
}

describe("recordAttemptFailure 透传 durationMs", () => {
  test("attempt_failed 事件的 AttemptSnapshot 携带已定稿的 durationMs", () => {
    const { ctx, events } = setup()

    ctx.beginAttempt({})
    // 定稿本次 attempt 的 durationMs（setAttemptError 内部 `Date.now() - startTime`）。
    ctx.setAttemptError({ status: 502, message: "boom", type: "server_error", raw: null as never })
    ctx.recordAttemptFailure({ willRetry: true })

    const failed = events.find((e) => e.kind === "request.attempt_failed")
    expect(failed).toBeDefined()
    if (failed?.kind === "request.attempt_failed") {
      // durationMs 已定稿（>= 0，非 undefined）。
      expect(failed.attempt.durationMs).not.toBeUndefined()
      expect(failed.attempt.durationMs).toBeGreaterThanOrEqual(0)
    }
  })
})
