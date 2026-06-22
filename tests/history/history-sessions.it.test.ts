import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  clearHistory,
  getCurrentSession,
  getSessionIdFromHeaders,
  initHistory,
  registerResponseSession,
  resolveResponseSessionId,
  shutdownHistory,
} from "~/lib/history"
import {
  //
  closeDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { setStateForTests } from "~/lib/state"

describe("history session resolution", () => {
  beforeEach(() => {
    setStateForTests({ historyDbPath: ":memory:" })
    openInMemoryDatabase()
    initHistory(true, 200)
  })

  afterEach(() => {
    clearHistory()
    shutdownHistory()
    closeDatabase()
    setStateForTests({ historyDbPath: "" })
  })

  test("does not create a synthetic session when no id is provided", () => {
    expect(getCurrentSession("anthropic-messages")).toBeUndefined()
  })

  test("extracts a real client session id from headers", () => {
    const headers = new Headers({
      "x-request-id": "req-only",
      "x-interaction-id": "interaction-123",
    })

    expect(getSessionIdFromHeaders(headers)).toBe("interaction-123")
  })

  test("extracts the Claude Code session id and prefers it over generic candidates", () => {
    // Claude Code sends `x-claude-code-session-id` (a stable per-conversation UUID).
    const headers = new Headers({
      "x-claude-code-session-id": "ce6fd04e-a162-4cd6-bdff-81d0b110c8fb",
      "x-session-id": "generic-fallback",
    })

    expect(getSessionIdFromHeaders(headers)).toBe("ce6fd04e-a162-4cd6-bdff-81d0b110c8fb")
  })

  test("uses previous response ids as real responses session anchors", () => {
    expect(resolveResponseSessionId("resp_root")).toBe("resp_root")

    registerResponseSession("resp_followup", "resp_root")

    expect(resolveResponseSessionId("resp_followup")).toBe("resp_root")
  })
})
