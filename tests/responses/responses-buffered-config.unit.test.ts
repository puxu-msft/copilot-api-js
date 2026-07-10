import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"
import { resolveResponsesBufferedAndHeartbeat } from "~/routes/responses/buffered-config"

describe("resolveResponsesBufferedAndHeartbeat", () => {
  const snap = snapshotStateForTests()
  afterEach(() => restoreStateForTests(snap))

  test("default: buffered off, heartbeat = streamKeepalivePingSec", () => {
    setStateForTests({ responsesBufferedRetry: false, streamKeepalivePingSec: 20 })
    expect(resolveResponsesBufferedAndHeartbeat()).toEqual({ buffered: false, heartbeatSec: 20 })
  })

  test("buffered on with ping>0: forces heartbeat = ping", () => {
    setStateForTests({ responsesBufferedRetry: true, streamKeepalivePingSec: 20 })
    expect(resolveResponsesBufferedAndHeartbeat()).toEqual({ buffered: true, heartbeatSec: 20 })
  })

  test("buffered on with ping=0: forces heartbeat = protectStreamingHeartbeat", () => {
    setStateForTests({ responsesBufferedRetry: true, streamKeepalivePingSec: 0, protectStreamingHeartbeat: 15 })
    expect(resolveResponsesBufferedAndHeartbeat()).toEqual({ buffered: true, heartbeatSec: 15 })
  })

  test("live (buffered off) does NOT force a heartbeat even when ping=0", () => {
    setStateForTests({ responsesBufferedRetry: false, streamKeepalivePingSec: 0, protectStreamingHeartbeat: 15 })
    expect(resolveResponsesBufferedAndHeartbeat()).toEqual({ buffered: false, heartbeatSec: 0 })
  })
})
