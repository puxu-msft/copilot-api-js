import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  EndpointType,
  HistoryEntry,
} from "~/lib/history"

import {
  //
  clearHistory,
  finalizeEntry,
  initHistory,
  insertEntry,
  shutdownHistory,
  updateEntry,
} from "~/lib/history"
import { querySessionSummaries } from "~/lib/history/sqlite/sessions-agg"
import { setStateForTests } from "~/lib/state"
import { generateId } from "~/lib/utils"

interface SeedOpts {
  sessionId: string
  agentId?: string
  endpoint?: EndpointType
  model: string
  state: "completed" | "failed"
  inputTokens: number
  outputTokens: number
  startedAt?: number
  /** First user message text — drives the persisted preview_text. */
  text?: string
}

/** Insert + finalize one terminal entry so it lands in entries_v2 as a non-active row. */
async function seedEntry(opts: SeedOpts): Promise<void> {
  const id = generateId()
  const entry: HistoryEntry = {
    id,
    sessionId: opts.sessionId,
    agentId: opts.agentId,
    startedAt: opts.startedAt ?? Date.now(),
    endpoint: opts.endpoint ?? "anthropic-messages",
    inboundRequest: {
      model: opts.model,
      messages: [{ role: "user", content: opts.text ?? "hi" }],
      stream: true,
    },
  }
  insertEntry(entry)
  updateEntry(id, {
    state: opts.state,
    outboundResponse: {
      success: opts.state === "completed",
      model: opts.model,
      usage: { input_tokens: opts.inputTokens, output_tokens: opts.outputTokens },
      content: null,
    },
  })
  await finalizeEntry(id)
}

describe("querySessionSummaries", () => {
  beforeEach(async () => {
    setStateForTests({ historyDbPath: ":memory:" })
    initHistory(true, 200)
  })

  afterEach(async () => {
    clearHistory()
    await shutdownHistory()
    setStateForTests({ historyDbPath: "" })
  })

  test("aggregates entries by session_id with per-session breakdowns", async () => {
    // Session A: 2 entries (one from a subagent), models claude-a + claude-b.
    await seedEntry({ sessionId: "session-A", agentId: "agent-1", model: "claude-a", state: "completed", inputTokens: 100, outputTokens: 20 })
    await seedEntry({ sessionId: "session-A", model: "claude-b", state: "failed", inputTokens: 50, outputTokens: 0 })
    // Session B: 1 entry, main agent only.
    await seedEntry({ sessionId: "session-B", model: "gpt-x", state: "completed", inputTokens: 10, outputTokens: 5 })

    const summaries = querySessionSummaries()
    expect(summaries).toHaveLength(2)

    const byId = new Map(summaries.map((s) => [s.sessionId, s]))
    const a = byId.get("session-A")
    const b = byId.get("session-B")
    expect(a).toBeDefined()
    expect(b).toBeDefined()

    // Session A: 2 requests; one distinct subagent (NULL agent_id not counted).
    expect(a!.requestCount).toBe(2)
    expect(a!.agentCount).toBe(1)
    expect(a!.inputTokens).toBe(150)
    expect(a!.outputTokens).toBe(20)
    expect(a!.completed).toBe(1)
    expect(a!.failed).toBe(1)
    expect([...a!.models].sort()).toEqual(["claude-a", "claude-b"])

    // Session B: main-agent only → agentCount 0 (COUNT(DISTINCT agent_id) skips NULL).
    expect(b!.requestCount).toBe(1)
    expect(b!.agentCount).toBe(0)
    expect(b!.inputTokens).toBe(10)
    expect(b!.outputTokens).toBe(5)
    expect(b!.completed).toBe(1)
    expect(b!.failed).toBe(0)
    expect(b!.models).toEqual(["gpt-x"])
  })

  test("preview reflects the latest (max started_at) entry's preview text", async () => {
    const base = Date.now()
    // Earlier then later entry in the same session — preview must follow the later one.
    await seedEntry({ sessionId: "session-P", model: "claude-a", state: "completed", inputTokens: 10, outputTokens: 5, startedAt: base, text: "older message" })
    await seedEntry({
      sessionId: "session-P",
      model: "claude-a",
      state: "completed",
      inputTokens: 10,
      outputTokens: 5,
      startedAt: base + 1000,
      text: "newer message",
    })

    const summaries = querySessionSummaries()
    const p = summaries.find((s) => s.sessionId === "session-P")
    expect(p).toBeDefined()
    expect(p!.preview).toBe("newer message")
  })
})
