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
  state: "completed" | "failed" | "aborted" | "interrupted"
  inputTokens: number
  outputTokens: number
  startedAt?: number
  /** First user message text — drives the persisted preview_text. */
  text?: string
  cacheRead?: number
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
      usage: { input_tokens: opts.inputTokens, output_tokens: opts.outputTokens, ...(opts.cacheRead ? { cache_read_input_tokens: opts.cacheRead } : {}) },
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
    expect(p!.firstPreview).toBe("older message")
  })

  test("firstPreview strips system-reminder; preview is last USER text not tool_result", async () => {
    const id = generateId()
    insertEntry({
      id,
      sessionId: "session-Q",
      startedAt: Date.now(),
      endpoint: "anthropic-messages",
      inboundRequest: {
        model: "claude-a",
        messages: [
          { role: "user", content: "<system-reminder>noise</system-reminder>真正的开场问题" },
          { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] },
          { role: "user", content: "后续追问" },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1" }] },
        ],
        stream: true,
      },
    })
    updateEntry(id, { state: "completed", outboundResponse: { success: true, model: "claude-a", usage: { input_tokens: 1, output_tokens: 1 }, content: null } })
    await finalizeEntry(id)

    const q = querySessionSummaries().find((s) => s.sessionId === "session-Q")
    expect(q).toBeDefined()
    expect(q!.firstPreview).toBe("真正的开场问题")
    // last entry ends with a tool_result; preview must skip it back to the last user text
    expect(q!.preview).toBe("后续追问")
  })

  test("inputTokens includes cache reads (cache dominates agentic traffic)", async () => {
    const base = Date.now()
    await seedEntry({ sessionId: "session-C", model: "claude-a", state: "completed", inputTokens: 100, outputTokens: 5, cacheRead: 12_000, startedAt: base })
    await seedEntry({ sessionId: "session-C", model: "claude-a", state: "completed", inputTokens: 2, outputTokens: 5, cacheRead: 95_000, startedAt: base + 1 })
    const c = querySessionSummaries().find((s) => s.sessionId === "session-C")
    expect(c!.inputTokens).toBe(100 + 2 + 12_000 + 95_000)
  })

  test("aborted/interrupted are bucketed so completed+failed+aborted == requestCount", async () => {
    await seedEntry({ sessionId: "session-R", model: "claude-a", state: "completed", inputTokens: 1, outputTokens: 1 })
    await seedEntry({ sessionId: "session-R", model: "claude-a", state: "failed", inputTokens: 1, outputTokens: 0 })
    await seedEntry({ sessionId: "session-R", model: "claude-a", state: "aborted", inputTokens: 1, outputTokens: 0 })
    await seedEntry({ sessionId: "session-R", model: "claude-a", state: "interrupted", inputTokens: 1, outputTokens: 0 })
    const r = querySessionSummaries().find((s) => s.sessionId === "session-R")
    expect(r!.requestCount).toBe(4)
    expect(r!.completed).toBe(1)
    expect(r!.failed).toBe(1)
    expect(r!.aborted).toBe(2)
    expect(r!.completed + r!.failed + r!.aborted).toBe(r!.requestCount)
  })

  test("preview strips multiple reminders + bare TodoWrite, not just one wrapper", async () => {
    const id = generateId()
    insertEntry({
      id,
      sessionId: "session-N",
      startedAt: Date.now(),
      endpoint: "anthropic-messages",
      inboundRequest: {
        model: "claude-a",
        messages: [
          { role: "user", content: "<system-reminder>x</system-reminder>真问题<ide_open>f</ide_open> The TodoWrite tool hasn't been used recently. blah" },
        ],
        stream: true,
      },
    })
    updateEntry(id, { state: "completed", outboundResponse: { success: true, model: "claude-a", usage: { input_tokens: 1, output_tokens: 1 }, content: null } })
    await finalizeEntry(id)
    const n = querySessionSummaries().find((s) => s.sessionId === "session-N")
    expect(n!.firstPreview).toBe("真问题")
  })
})
