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
  getAgentIdFromHeaders,
  getCurrentSession,
  getSessionIdFromHeaders,
  initHistory,
  shutdownHistory,
} from "~/lib/history"
import {
  //
  closeDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  registerResponseSession,
  resolveResponseSessionId,
} from "~/lib/openai/response-session-store"
import { setStateForTests } from "~/lib/state"

describe("history session resolution", () => {
  beforeEach(async () => {
    setStateForTests({ historyDbPath: ":memory:" })
    openInMemoryDatabase()
    initHistory(true, 200)
  })

  afterEach(async () => {
    clearHistory()
    await shutdownHistory()
    closeDatabase()
    setStateForTests({ historyDbPath: "" })
  })

  test("does not create a synthetic session when no id is provided", async () => {
    expect(getCurrentSession("anthropic-messages")).toBeUndefined()
  })

  test("extracts a real client session id from headers", async () => {
    const headers = new Headers({
      "x-request-id": "req-only",
      "x-interaction-id": "interaction-123",
    })

    expect(getSessionIdFromHeaders(headers)).toBe("interaction-123")
  })

  test("extracts the Claude Code session id and prefers it over generic candidates", async () => {
    // Claude Code sends `x-claude-code-session-id` (a stable per-conversation UUID).
    const headers = new Headers({
      "x-claude-code-session-id": "ce6fd04e-a162-4cd6-bdff-81d0b110c8fb",
      "x-session-id": "generic-fallback",
    })

    expect(getSessionIdFromHeaders(headers)).toBe("ce6fd04e-a162-4cd6-bdff-81d0b110c8fb")
  })

  test("extracts the Claude Code agent id (subagent marker); main agent has none", async () => {
    // Subagent requests carry x-claude-code-agent-id; the main agent sends none → undefined.
    expect(getAgentIdFromHeaders(new Headers({ "x-claude-code-agent-id": "acc28fdf99a8d5740" }))).toBe("acc28fdf99a8d5740")
    expect(getAgentIdFromHeaders(new Headers())).toBeUndefined()
    expect(getAgentIdFromHeaders(new Headers({ "x-claude-code-agent-id": "  " }))).toBeUndefined() // whitespace → undefined, never ""
    expect(getAgentIdFromHeaders({ "x-claude-code-agent-id": "sub-1" })).toBe("sub-1") // plain-record form
  })

  test("uses previous response ids as real responses session anchors", async () => {
    expect(resolveResponseSessionId("resp_root")).toBeUndefined()

    registerResponseSession("resp_followup", "resp_root")

    expect(resolveResponseSessionId("resp_followup")).toBe("resp_root")
  })
})
