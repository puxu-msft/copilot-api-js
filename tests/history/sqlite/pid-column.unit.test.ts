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
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  getEntryById,
  queryEntries,
} from "~/lib/history/sqlite/read"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"

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

describe("history pid column", () => {
  beforeEach(async () => {
    closeDatabase()
    openInMemoryDatabase()
  })

  test("CRITICAL-1: process identity is written to the pid column, not just the blob", async () => {
    // Regression guard for the INSERT_ENTRY_SQL omission: serializeEntry can fill
    // row.pid correctly, but if the INSERT statement doesn't list the pid column
    // the value silently never lands and `WHERE pid = ?` matches nothing. Assert
    // the raw column directly.
    await insertCompletedEntry(
      makeEntry({
        id: "with-pid",
        process: { pid: 4242, bootTime: 1_700_000_000_000, version: "9.9.9", gitSha: "abc1234", gitDirty: true },
      }),
    )

    const db = getDatabase()
    const row = db.prepare("SELECT pid, boot_time, git_sha FROM entries_v2 WHERE id = ?").get("with-pid") as {
      pid: number | null
      boot_time: number | null
      git_sha: string | null
    }
    expect(row.pid).toBe(4242)
    expect(row.boot_time).toBe(1_700_000_000_000)
    expect(row.git_sha).toBe("abc1234")
  })

  test("the full process object round-trips through the blob (including version/gitDirty not in columns)", async () => {
    await insertCompletedEntry(
      makeEntry({
        id: "blob-roundtrip",
        process: { pid: 7, bootTime: 123, version: "1.2.3", gitSha: "deadbee", gitDirty: false },
      }),
    )
    const got = getEntryById("blob-roundtrip")
    expect(got?.process).toEqual({ pid: 7, bootTime: 123, version: "1.2.3", gitSha: "deadbee", gitDirty: false })
  })

  test("queryEntries filters by pid via the SQL column", async () => {
    await insertCompletedEntry(makeEntry({ id: "p100-a", process: { pid: 100, bootTime: 1, version: "v" } }))
    await insertCompletedEntry(makeEntry({ id: "p100-b", process: { pid: 100, bootTime: 1, version: "v" } }))
    await insertCompletedEntry(makeEntry({ id: "p200", process: { pid: 200, bootTime: 1, version: "v" } }))

    const fromP100 = queryEntries({ pid: 100, limit: 10 })
    expect(fromP100.map((e) => e.id).sort()).toEqual(["p100-a", "p100-b"])

    const fromP200 = queryEntries({ pid: 200, limit: 10 })
    expect(fromP200.map((e) => e.id)).toEqual(["p200"])
  })

  test("an entry with no process identity stores NULL columns and is omitted from pid filters", async () => {
    await insertCompletedEntry(makeEntry({ id: "no-proc" }))
    const db = getDatabase()
    const row = db.prepare("SELECT pid FROM entries_v2 WHERE id = ?").get("no-proc") as { pid: number | null }
    expect(row.pid).toBeNull()
    expect(queryEntries({ pid: 100, limit: 10 }).map((e) => e.id)).not.toContain("no-proc")
  })

  test("migration is idempotent and the pid index exists", async () => {
    // openInMemoryDatabase already ran the migration once in beforeEach. The
    // pid index must exist, and re-running the column migration path (via a
    // fresh open on the same connection lifecycle) must not throw.
    const db = getDatabase()
    const indexes = db.prepare("PRAGMA index_list(entries_v2)").all() as Array<{ name: string }>
    expect(indexes.some((i) => i.name === "idx_entries_v2_pid")).toBe(true)

    // Re-open is a no-op-safe path: it re-execs SCHEMA_SQL + migration, which
    // must tolerate already-present columns and index without error.
    expect(() => openInMemoryDatabase()).not.toThrow()
  })
})
