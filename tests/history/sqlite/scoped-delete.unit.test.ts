import { beforeEach, describe, expect, test } from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import { closeDatabase, openInMemoryDatabase } from "~/lib/history/sqlite/connection"
import { queryEntryCount, querySummaries } from "~/lib/history/sqlite/read"
import { deleteEntries, insertCompletedEntry, upsertHeadRow } from "~/lib/history/sqlite/write"

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
    inboundRequest: { model: "claude-opus-4-7", messages: [{ role: "user", content: "hello world" }] },
    outboundResponse: {
      success: true,
      model: "claude-opus-4-7",
      usage: { input_tokens: 1, output_tokens: 2 },
      content: { role: "assistant", content: "ok" },
    },
    ...overrides,
  } as HistoryEntry
}

describe("deleteEntries (scoped)", () => {
  beforeEach(async () => {
    closeDatabase()
    openInMemoryDatabase()
  })

  test("deletes only entries matching the endpoint filter, leaves others", async () => {
    await insertCompletedEntry(makeEntry({ id: "a1", endpoint: "anthropic-messages" }))
    await insertCompletedEntry(makeEntry({ id: "o1", endpoint: "openai-chat-completions" }))
    const deleted = deleteEntries({ endpoint: "anthropic-messages" })
    expect(deleted).toBe(1)
    expect(queryEntryCount()).toBe(1)
    expect(querySummaries()[0]?.id).toBe("o1")
  })

  test("filters by model / sessionId / pid / state", async () => {
    await insertCompletedEntry(makeEntry({ id: "m1", inboundRequest: { model: "claude-opus-4-7" }, sessionId: "s1", process: { pid: 111, bootTime: 0, version: "0.0.0" } }))
    await insertCompletedEntry(makeEntry({ id: "m2", inboundRequest: { model: "gpt-5" }, sessionId: "s2", process: { pid: 222, bootTime: 0, version: "0.0.0" }, state: "failed", outboundResponse: { success: false, model: "gpt-5", usage: { input_tokens: 0, output_tokens: 0 }, content: { role: "assistant", content: "" } } }))
    expect(deleteEntries({ model: "opus" })).toBe(1)
    expect(querySummaries().map((s) => s.id)).toEqual(["m2"])
    expect(deleteEntries({ state: "failed" })).toBe(1)
    expect(queryEntryCount()).toBe(0)
  })

  test("does NOT delete in-flight persisted head rows (status=streaming)", async () => {
    await insertCompletedEntry(makeEntry({ id: "done", endpoint: "anthropic-messages" }))
    upsertHeadRow(makeEntry({ id: "live", endpoint: "anthropic-messages" }), "streaming")
    const deleted = deleteEntries({ endpoint: "anthropic-messages" })
    expect(deleted).toBe(1) // only the terminal one
    expect(querySummaries().some((s) => s.id === "live")).toBe(true)
  })

  test("no filters deletes all terminal rows", async () => {
    await insertCompletedEntry(makeEntry({ id: "x1" }))
    await insertCompletedEntry(makeEntry({ id: "x2" }))
    expect(deleteEntries({})).toBe(2)
    expect(queryEntryCount()).toBe(0)
  })
})
