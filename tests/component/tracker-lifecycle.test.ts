/**
 * Component tests for TuiLogger lifecycle (clear and destroy).
 */

import { describe, expect, test } from "bun:test"

import { TuiLogger } from "~/lib/tui/tracker"

describe("TuiLogger.clear", () => {
  test("empties requests after clear", () => {
    const tracker = new TuiLogger()
    tracker.startRequest({ method: "POST", path: "/v1/messages" })

    expect(tracker.getActiveRequests().length).toBe(1)

    tracker.clear()
    expect(tracker.getActiveRequests().length).toBe(0)
  })

  test("is safe to call when already empty", () => {
    const tracker = new TuiLogger()
    tracker.clear() // Should not throw
    expect(tracker.getActiveRequests().length).toBe(0)
  })

  test("can add requests after clear", () => {
    const tracker = new TuiLogger()
    tracker.startRequest({ method: "POST", path: "/v1/messages" })
    tracker.clear()

    tracker.startRequest({ method: "POST", path: "/v1/chat/completions" })
    const active = tracker.getActiveRequests()
    expect(active.length).toBe(1)
    expect(active[0].path).toBe("/v1/chat/completions")
    tracker.clear()
  })
})

describe("TuiLogger.destroy", () => {
  test("clears all requests", () => {
    const tracker = new TuiLogger()
    tracker.startRequest({ method: "POST", path: "/v1/messages" })
    tracker.destroy()
    expect(tracker.getActiveRequests().length).toBe(0)
  })

  test("is idempotent - safe to call twice", () => {
    const tracker = new TuiLogger()
    tracker.startRequest({ method: "POST", path: "/v1/messages" })
    tracker.destroy()
    tracker.destroy() // Should not throw
    expect(tracker.getActiveRequests().length).toBe(0)
  })

  test("getActiveRequests returns empty after destroy", () => {
    const tracker = new TuiLogger()
    tracker.startRequest({ method: "POST", path: "/v1/messages" })
    tracker.startRequest({ method: "POST", path: "/v1/chat/completions" })
    expect(tracker.getActiveRequests().length).toBe(2)

    tracker.destroy()
    expect(tracker.getActiveRequests()).toEqual([])
  })
})
