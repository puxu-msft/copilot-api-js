import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  HistoryEntry,
  MessageContent,
} from "~/lib/history/types"

import {
  //
  finalizeEntry,
  insertEntry,
  searchContains,
  searchHistory,
  updateEntry,
} from "~/lib/history"
import { getDatabase } from "~/lib/history/sqlite/connection"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

async function seed(entry: HistoryEntry, patch?: Partial<HistoryEntry>): Promise<void> {
  insertEntry(entry)
  updateEntry(entry.id, {
    state: "completed",
    outboundResponse: { success: true, model: entry.inboundRequest.model ?? "m", usage: { input_tokens: 1, output_tokens: 1 }, content: null },
    ...patch,
  })
  await finalizeEntry(entry.id)
}

function entry(id: string, messages: Array<MessageContent>, startedAt: number, extra?: Partial<HistoryEntry>): HistoryEntry {
  return {
    id,
    sessionId: "s",
    startedAt,
    endpoint: "anthropic-messages",
    inboundRequest: { model: "claude-opus-4", messages, stream: true },
    ...extra,
  }
}

/** Mark the backfill complete so `partial` is false in these tests. */
function markComplete(): void {
  getDatabase().prepare("INSERT INTO history_meta (key, value) VALUES ('search_index_version', '1') ON CONFLICT(key) DO UPDATE SET value='1'").run()
}

describe("dedicated search (search-query)", () => {
  useIsolatedRuntime()

  test("inbound: substring match returns the owning request, deduped across requests", async () => {
    const shared: MessageContent = { role: "user", content: "find the UNIQUE_NEEDLE here" }
    await seed(entry("o1", [shared], 1000)) // earliest owner
    await seed(entry("o2", [shared, { role: "assistant", content: "reply" }], 2000))
    markComplete()

    const result = searchHistory({ source: "inbound", q: "UNIQUE_NEEDLE" })
    expect(result.partial).toBe(false)
    // One result row (deduped by hash), owned by the EARLIEST request.
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].ownerReqId).toBe("o1")
    expect(result.rows[0].snippet).toContain("UNIQUE_NEEDLE")
    expect(result.rows[0].source).toBe("inbound")
  })

  test("contains: lists every request referencing a matched hash", async () => {
    const shared: MessageContent = { role: "user", content: "CONTAINS_PROBE message" }
    await seed(entry("c1", [shared], 1000))
    await seed(entry("c2", [shared], 2000))
    markComplete()

    const result = searchHistory({ source: "inbound", q: "CONTAINS_PROBE" })
    const hash = result.rows[0].hash!
    const ids = searchContains(hash)
    expect(ids.sort()).toEqual(["c1", "c2"])
  })

  test("LIKE wildcards in the needle are escaped (matched literally)", async () => {
    await seed(entry("w1", [{ role: "user", content: "literal 100% match" }], 1000))
    await seed(entry("w2", [{ role: "user", content: "should not match via wildcard" }], 2000))
    markComplete()

    // "100%" must match the literal percent, not act as a LIKE wildcard.
    const hit = searchHistory({ source: "inbound", q: "100%" })
    expect(hit.rows).toHaveLength(1)
    expect(hit.rows[0].ownerReqId).toBe("w1")
    // A bare "%" is escaped to a LITERAL percent: it matches ONLY the row that
    // actually contains "%", NOT everything (which an unescaped LIKE wildcard would).
    const wild = searchHistory({ source: "inbound", q: "%" })
    expect(wild.rows).toHaveLength(1)
    expect(wild.rows[0].ownerReqId).toBe("w1")
  })

  test("CJK 2-character substring matches", async () => {
    await seed(entry("cjk1", [{ role: "user", content: "请处理这个问题谢谢" }], 1000))
    markComplete()
    const result = searchHistory({ source: "inbound", q: "问题" })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].ownerReqId).toBe("cjk1")
  })

  test("structural filters AND with the text match", async () => {
    await seed(entry("f1", [{ role: "user", content: "FILTER_NEEDLE one" }], 1000, { sessionId: "alpha" }))
    await seed(entry("f2", [{ role: "user", content: "FILTER_NEEDLE two" }], 2000, { sessionId: "beta" }))
    markComplete()

    const result = searchHistory({ source: "inbound", q: "FILTER_NEEDLE", filters: { sessionId: "beta" } })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].ownerReqId).toBe("f2")
  })

  test("rewrites-req facet finds removed-side changed text", async () => {
    const m1: MessageContent = { role: "user", content: "kept" }
    const m2: MessageContent = { role: "user", content: "REWRITE_FACET_NEEDLE dropped" }
    await seed(entry("rw1", [m1, m2], 1000), { outboundRequest: { messages: [m1] } })
    markComplete()

    const result = searchHistory({ source: "rewrites-req", q: "REWRITE_FACET_NEEDLE" })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].ownerReqId).toBe("rw1")
    expect(result.rows[0].hash).toBeUndefined()
  })

  test("resp-headers facet matches stored header text", async () => {
    await seed(entry("h1", [{ role: "user", content: "q" }], 1000), { httpHeaders: { outboundResponse: { "x-trace": "HEADER_FACET_NEEDLE" } } })
    markComplete()
    const result = searchHistory({ source: "resp-headers", q: "HEADER_FACET_NEEDLE" })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].ownerReqId).toBe("h1")
  })

  test("pagination: cursor walks the result set without overlap", async () => {
    for (let i = 0; i < 5; i++) await seed(entry(`p${i}`, [{ role: "user", content: `PAGE_NEEDLE row ${i}` }], 1000 + i))
    markComplete()

    const page1 = searchHistory({ source: "inbound", q: "PAGE_NEEDLE", limit: 2 })
    expect(page1.rows).toHaveLength(2)
    expect(page1.nextCursor).not.toBeNull()
    const page2 = searchHistory({ source: "inbound", q: "PAGE_NEEDLE", limit: 2, cursor: page1.nextCursor ?? undefined })
    expect(page2.rows).toHaveLength(2)
    const ids1 = new Set(page1.rows.map((r) => r.ownerReqId))
    for (const r of page2.rows) expect(ids1.has(r.ownerReqId)).toBe(false)
  })

  test("partial flag is set for inbound while the backfill is incomplete", async () => {
    await seed(entry("pp1", [{ role: "user", content: "PARTIAL_PROBE" }], 1000))
    // No markComplete() → version flag absent → partial.
    const result = searchHistory({ source: "inbound", q: "PARTIAL_PROBE" })
    expect(result.partial).toBe(true)
    expect(result.builtPct).toBeGreaterThan(0)
    // The already-built row is still findable (partial = covers built rows).
    expect(result.rows).toHaveLength(1)
  })

  test("empty needle returns no rows", async () => {
    await seed(entry("e1", [{ role: "user", content: "anything" }], 1000))
    markComplete()
    expect(searchHistory({ source: "inbound", q: "" }).rows).toHaveLength(0)
  })
})
