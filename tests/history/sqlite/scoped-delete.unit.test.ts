import { beforeEach, describe, expect, test } from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import { closeDatabase, getDatabase, openInMemoryDatabase } from "~/lib/history/sqlite/connection"
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
    // One entry per filter dimension, each targetable by exactly one filter:
    // byModel is the only opus row; bySession the only sess-target row; byPid the
    // only pid=4242 row; byState the only failed row (the rest are completed).
    // NOTE: the persisted `model` column derives from outboundResponse.model
    // (serialize.ts) — makeEntry defaults it to "claude-opus-4-7", so the three
    // non-model rows must override outboundResponse.model to "gpt-5" or they'd
    // also match the opus filter.
    const gpt5Response = { success: true as const, model: "gpt-5", usage: { input_tokens: 1, output_tokens: 2 }, content: { role: "assistant", content: "ok" } }
    await insertCompletedEntry(makeEntry({ id: "byModel", inboundRequest: { model: "claude-opus-4-7" } }))
    await insertCompletedEntry(makeEntry({ id: "bySession", inboundRequest: { model: "gpt-5" }, sessionId: "sess-target", outboundResponse: gpt5Response }))
    await insertCompletedEntry(makeEntry({ id: "byPid", inboundRequest: { model: "gpt-5" }, process: { pid: 4242, bootTime: 0, version: "0.0.0" }, outboundResponse: gpt5Response }))
    await insertCompletedEntry(makeEntry({ id: "byState", inboundRequest: { model: "gpt-5" }, state: "failed", outboundResponse: { success: false, model: "gpt-5", usage: { input_tokens: 0, output_tokens: 0 }, content: { role: "assistant", content: "" } } }))

    // Each filter deletes exactly its one matching row (model LIKE %opus%, session_id =, pid =, status =).
    expect(deleteEntries({ model: "opus" })).toBe(1)
    expect(querySummaries().some((s) => s.id === "byModel")).toBe(false)
    expect(deleteEntries({ sessionId: "sess-target" })).toBe(1)
    expect(querySummaries().some((s) => s.id === "bySession")).toBe(false)
    expect(deleteEntries({ pid: 4242 })).toBe(1)
    expect(querySummaries().some((s) => s.id === "byPid")).toBe(false)
    expect(deleteEntries({ state: "failed" })).toBe(1)
    expect(queryEntryCount()).toBe(0)
  })

  // H1 data-loss invariant (spec's catastrophic regression surface): a scoped
  // delete must remove ONLY the matched entries' content-addressed search-index
  // rows (req_msg / req_aux / orphaned msg_blob) and leave the NON-matched
  // entries' index rows fully intact. The disaster this guards against is a
  // no-WHERE full-table wipe (clearAllEntries misuse) that would drag down every
  // other request's index rows with the matched set.
  test("H1: scoped delete spares the non-matched entry's index rows (req_msg / req_aux / msg_blob)", async () => {
    const db = getDatabase()
    // A (anthropic) and B (openai) carry DISTINCT inbound message text so each
    // hashes to its OWN msg_blob row. Content-addressing dedups identical
    // messages into a single shared row; different text guarantees two
    // independent blobs, so A's orphan-GC reclamation can't be masked by B still
    // referencing a shared blob. httpHeaders seed a req_aux row per entry
    // (buildAux → req-headers facet), giving req_aux something to survive/cascade.
    await insertCompletedEntry(
      makeEntry({
        id: "A",
        endpoint: "anthropic-messages",
        inboundRequest: { model: "claude-opus-4-7", messages: [{ role: "user", content: "unique inbound message for entry A" }] },
        httpHeaders: { inboundRequest: { "x-entry": "a" } },
      }),
    )
    await insertCompletedEntry(
      makeEntry({
        id: "B",
        endpoint: "openai-chat-completions",
        inboundRequest: { model: "gpt-5", messages: [{ role: "user", content: "unique inbound message for entry B" }] },
        httpHeaders: { inboundRequest: { "x-entry": "b" } },
      }),
    )

    // Independent oracle: read the three search-index tables directly (bypass the
    // high-level API) to confirm the seed produced two independent blobs up front.
    const hashOf = (reqId: string) => (db.prepare("SELECT hash FROM req_msg WHERE req_id = ?").get(reqId) as { hash: string } | undefined)?.hash
    const hashA = hashOf("A")
    const hashB = hashOf("B")
    expect(hashA).toBeTruthy()
    expect(hashB).toBeTruthy()
    expect(hashA).not.toBe(hashB) // distinct content → distinct blobs (not a shared dedup row)
    const totalBlobs = () => (db.prepare("SELECT COUNT(*) AS n FROM msg_blob").get() as { n: number }).n
    expect(totalBlobs()).toBe(2)

    // Delete ONLY A's endpoint.
    expect(deleteEntries({ endpoint: "anthropic-messages" })).toBe(1)

    const reqMsgCount = (reqId: string) => (db.prepare("SELECT COUNT(*) AS n FROM req_msg WHERE req_id = ?").get(reqId) as { n: number }).n
    const reqAuxCount = (reqId: string) => (db.prepare("SELECT COUNT(*) AS n FROM req_aux WHERE req_id = ?").get(reqId) as { n: number }).n
    const blobCount = (hash: string) => (db.prepare("SELECT COUNT(*) AS n FROM msg_blob WHERE hash = ?").get(hash) as { n: number }).n

    // B (NOT matched) keeps ALL of its index rows — the exact H1 disaster surface.
    expect(reqMsgCount("B")).toBeGreaterThan(0)
    expect(reqAuxCount("B")).toBeGreaterThan(0)
    expect(blobCount(hashB as string)).toBe(1)

    // A (matched) — its per-request rows CASCADE away with the head row...
    expect(reqMsgCount("A")).toBe(0)
    expect(reqAuxCount("A")).toBe(0)
    // ...and its now-unreferenced msg_blob row is reclaimed by the orphan GC.
    expect(blobCount(hashA as string)).toBe(0)
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
