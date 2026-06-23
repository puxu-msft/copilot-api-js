import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import {
  //
  closeDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  getEntryById,
  queryEntries,
  queryEntryCount,
  querySummaries,
  resolveResponseSession,
} from "~/lib/history/sqlite/read"
import {
  //
  clearAllEntries,
  deleteSession,
  insertCompletedEntry,
  setEntryPinned,
  upsertHeadRow,
  upsertResponseSession,
} from "~/lib/history/sqlite/write"

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    endpoint: "anthropic-messages",
    startedAt: Date.now(),
    endedAt: Date.now() + 100,
    durationMs: 100,
    state: "completed",
    active: false,
    lastUpdatedAt: Date.now() + 100,
    transport: "http",
    inboundRequest: { model: "claude-opus-4-7" },
    outboundResponse: {
      success: true,
      model: "claude-opus-4-7",
      usage: { input_tokens: 1, output_tokens: 2 },
      content: { role: "assistant", content: "ok" },
    },
    ...overrides,
  } as HistoryEntry
}

describe("sqlite write/read", () => {
  beforeEach(() => {
    closeDatabase()
    openInMemoryDatabase()
  })

  test("insert and query by id", () => {
    const entry = makeEntry({ id: "e1", sessionId: "s1" })
    insertCompletedEntry(entry)
    const got = getEntryById("e1")
    expect(got?.id).toBe("e1")
    expect(got?.outboundResponse?.usage.input_tokens).toBe(1)
  })

  test("queryEntries filters by model", () => {
    insertCompletedEntry(
      makeEntry({
        id: "a",
        inboundRequest: { model: "m1" },
        outboundResponse: {
          success: true,
          model: "m1",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: null,
        },
      }),
    )
    insertCompletedEntry(
      makeEntry({
        id: "b",
        inboundRequest: { model: "m2" },
        outboundResponse: {
          success: true,
          model: "m2",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: null,
        },
      }),
    )
    const byM1 = queryEntries({ model: "m1", limit: 10 })
    expect(byM1.map((e) => e.id)).toEqual(["a"])
  })

  test("queryEntries filters by exact state (granular, beats coarse success); pid filter works", () => {
    insertCompletedEntry(makeEntry({ id: "c", state: "completed", process: { pid: 100, bootTime: 1, version: "v" } }))
    insertCompletedEntry(makeEntry({ id: "f", state: "failed", process: { pid: 100, bootTime: 1, version: "v" } }))
    insertCompletedEntry(makeEntry({ id: "ab", state: "aborted", process: { pid: 200, bootTime: 1, version: "v" } }))
    insertCompletedEntry(makeEntry({ id: "intr", state: "interrupted", process: { pid: 200, bootTime: 1, version: "v" } }))

    // state filter is exact (not just completed/failed like `success`).
    expect(queryEntries({ state: "aborted", limit: 10 }).map((e) => e.id)).toEqual(["ab"])
    expect(queryEntries({ state: "interrupted", limit: 10 }).map((e) => e.id)).toEqual(["intr"])
    // state wins over success when both given.
    expect(queryEntries({ state: "failed", success: true, limit: 10 }).map((e) => e.id)).toEqual(["f"])
    // pid filter.
    expect(
      queryEntries({ pid: 200, limit: 10 })
        .map((e) => e.id)
        .sort(),
    ).toEqual(["ab", "intr"])
    // querySummaries carries pid for in-flight-consistent filtering.
    const sums = querySummaries({ pid: 100, limit: 10 })
    expect(sums.map((s) => s.id).sort()).toEqual(["c", "f"])
    expect(sums.every((s) => s.pid === 100)).toBe(true)
  })

  test("querySummaries does not decompress blob but returns meta", () => {
    insertCompletedEntry(makeEntry({ id: "s-a" }))
    const summaries = querySummaries({ limit: 10 })
    expect(summaries.length).toBeGreaterThan(0)
    expect(summaries[0].id).toBe("s-a")
  })

  test("querySummaries returns messageCount and previewText from stored columns", () => {
    insertCompletedEntry(
      makeEntry({
        id: "s-summary",
        inboundRequest: {
          model: "claude-opus-4-7",
          messages: [
            { role: "user", content: "first user message" },
            { role: "assistant", content: "reply" },
            { role: "user", content: "follow-up question from user" },
          ],
        },
      }),
    )

    const summaries = querySummaries({ limit: 10 })
    const summary = summaries.find((s) => s.id === "s-summary")
    expect(summary).toBeDefined()
    expect(summary?.messageCount).toBe(3)
    expect(summary?.previewText).toBe("follow-up question from user")
  })

  test("deleteSession removes entries", () => {
    insertCompletedEntry(makeEntry({ id: "x1", sessionId: "del" }))
    insertCompletedEntry(makeEntry({ id: "x2", sessionId: "del" }))
    const removed = deleteSession("del")
    expect(removed).toBe(2)
    expect(queryEntryCount({ sessionId: "del" })).toBe(0)
  })

  test("clearAllEntries empties all tables", () => {
    insertCompletedEntry(makeEntry({ id: "z", sessionId: "z" }))
    upsertResponseSession("resp-1", "z")
    expect(queryEntryCount()).toBe(1)
    clearAllEntries()
    expect(queryEntryCount()).toBe(0)
    expect(resolveResponseSession("resp-1")).toBeUndefined()
  })

  test("response_session roundtrip", () => {
    upsertResponseSession("r1", "s-beta")
    expect(resolveResponseSession("r1")).toBe("s-beta")
    upsertResponseSession("r1", "s-gamma")
    expect(resolveResponseSession("r1")).toBe("s-gamma")
  })

  test("agent_id persists and queryEntries filters by agentId / mainAgentOnly", () => {
    insertCompletedEntry(makeEntry({ id: "main-1", sessionId: "S", agentId: undefined }))
    insertCompletedEntry(makeEntry({ id: "sub-a", sessionId: "S", agentId: "agent-A" }))
    insertCompletedEntry(makeEntry({ id: "sub-b", sessionId: "S", agentId: "agent-B" }))

    // Round-trip: agentId survives serialize → entries_v2.agent_id → deserialize.
    expect(getEntryById("sub-a")?.agentId).toBe("agent-A")
    expect(getEntryById("main-1")?.agentId).toBeUndefined()

    // Filters: specific subagent / main-agent-only (agent_id IS NULL) / agentId wins when both set.
    expect(queryEntries({ agentId: "agent-A" }).map((e) => e.id)).toEqual(["sub-a"])
    expect(queryEntries({ mainAgentOnly: true }).map((e) => e.id)).toEqual(["main-1"])
    expect(queryEntries({ agentId: "agent-B", mainAgentOnly: true }).map((e) => e.id)).toEqual(["sub-b"])
  })

  test("pinned defaults false; setEntryPinned roundtrips through column + summary", () => {
    insertCompletedEntry(makeEntry({ id: "pin-1" }))
    expect(getEntryById("pin-1")?.pinned).toBe(false)
    expect(querySummaries({ limit: 10 }).find((s) => s.id === "pin-1")?.pinned).toBe(false)

    expect(setEntryPinned("pin-1", true)).toBe(true)
    expect(getEntryById("pin-1")?.pinned).toBe(true)
    expect(querySummaries({ limit: 10 }).find((s) => s.id === "pin-1")?.pinned).toBe(true)

    expect(setEntryPinned("pin-1", false)).toBe(true)
    expect(getEntryById("pin-1")?.pinned).toBe(false)
  })

  test("a later head upsert (eager status transition) does NOT reset the pin flag", () => {
    const entry = makeEntry({ id: "pin-keep" })
    insertCompletedEntry(entry)
    expect(setEntryPinned("pin-keep", true)).toBe(true)
    // Eager incremental writers re-upsert the head row; INSERT_ENTRY_SQL omits
    // the pinned column, so the dedicated flag must survive untouched.
    upsertHeadRow(entry, "streaming")
    expect(getEntryById("pin-keep")?.pinned).toBe(true)
    insertCompletedEntry(entry) // full re-finalize too
    expect(getEntryById("pin-keep")?.pinned).toBe(true)
  })

  test("setEntryPinned returns false for an unknown id", () => {
    expect(setEntryPinned("ghost", true)).toBe(false)
  })
})
