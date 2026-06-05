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
  getSessions,
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
    expect(getSessions().sessions.length).toBe(0)
  })

  test("extracts a real client session id from headers", () => {
    const headers = new Headers({
      "x-request-id": "req-only",
      "x-interaction-id": "interaction-123",
    })

    expect(getSessionIdFromHeaders(headers)).toBe("interaction-123")
  })

  test("uses previous response ids as real responses session anchors", () => {
    expect(resolveResponseSessionId("resp_root")).toBe("resp_root")

    registerResponseSession("resp_followup", "resp_root")

    expect(resolveResponseSessionId("resp_followup")).toBe("resp_root")
  })
})
