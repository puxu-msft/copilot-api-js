import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import { summarizeRequestContext } from "~/lib/context/activity-summary"

describe("summarizeRequestContext.currentAttemptStartedAt", () => {
  it("有 currentAttempt 时暴露其 startTime", () => {
    const startTime = 1_700_000_000_000
    const ctx = {
      id: "r1",
      endpoint: "messages",
      state: "executing",
      startTime: 1,
      queueWaitMs: 0,
      attempts: [{ startTime }],
      currentAttempt: { startTime },
    } as never
    expect(summarizeRequestContext(ctx).currentAttemptStartedAt).toBe(startTime)
  })

  it("无 currentAttempt 时为 undefined（不崩）", () => {
    const ctx = { id: "r1", endpoint: "messages", state: "pending", startTime: 1, queueWaitMs: 0 } as never
    expect(summarizeRequestContext(ctx).currentAttemptStartedAt).toBeUndefined()
  })
})
