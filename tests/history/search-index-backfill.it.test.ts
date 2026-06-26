/**
 * Recoverable search_index + preview backfill (sqlite/search-index-backfill.ts).
 *
 * Builds the content-addressed index (msg_blob / req_msg / req_aux) for historical
 * rows AND recomputes the denormalized `preview_text`, once, in the background.
 * Guarded by `history_meta(search_index_version)` (NOT PRAGMA user_version — a DB
 * may already be at user_version=1 from the old preview-backfill); resumable via a
 * cursor; cooperatively stoppable mid-pass.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history"
import type { MessageContent } from "~/lib/history/types"

import { extractPreviewText } from "~/lib/history/in-flight"
import { getDatabase } from "~/lib/history/sqlite/connection"
import {
  //
  getMeta,
  SEARCH_BACKFILL_CURSOR_KEY,
  SEARCH_INDEX_DEDUP_RATIO_KEY,
  SEARCH_INDEX_VERSION_KEY,
  setMeta,
} from "~/lib/history/sqlite/meta"
import { getEntryById } from "~/lib/history/sqlite/read"
import {
  //
  runSearchIndexBackfill,
  stopSearchIndexBackfill,
} from "~/lib/history/sqlite/search-index-backfill"
import {
  //
  finalizeEntry,
  insertEntry,
  updateEntry,
} from "~/lib/history/store"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

function storedPreview(id: string): string | null {
  const row = getDatabase().prepare("SELECT preview_text FROM entries_v2 WHERE id = ?").get(id) as { preview_text: string | null } | null
  return row ? row.preview_text : null
}

function reqMsgCount(id: string): number {
  return (getDatabase().prepare("SELECT COUNT(*) AS n FROM req_msg WHERE req_id = ?").get(id) as { n: number }).n
}

/** Persist a completed entry through the REAL write path (insert → update → finalize). */
function persistToolResultLastEntry(id: string, startedAt: number): void {
  const entry = {
    id,
    endpoint: "openai-chat-completions",
    startedAt,
    state: "pending",
    active: true,
    lastUpdatedAt: startedAt,
    inboundRequest: {
      model: "gpt-5",
      messages: [
        { role: "user", content: "the FIRST user message — old logic landed here" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_xyz", type: "function", function: { name: "Read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_xyz", content: "tool output bytes" },
      ],
    },
  } as unknown as HistoryEntry
  insertEntry(entry)
  updateEntry(id, {
    state: "completed",
    active: false,
    lastUpdatedAt: startedAt,
    endedAt: startedAt,
    outboundResponse: { success: true, model: "gpt-5", usage: { input_tokens: 5, output_tokens: 3 }, content: null },
  })
  finalizeEntry(id)
}

/** Wipe the dual-written index + flags so a row looks like a legacy (pre-index) row. */
function makeLegacy(id: string): void {
  const db = getDatabase()
  db.prepare("DELETE FROM req_msg WHERE req_id = ?").run(id)
  db.prepare("DELETE FROM req_aux WHERE req_id = ?").run(id)
  db.prepare("UPDATE entries_v2 SET preview_text = 'STALE' WHERE id = ?").run(id)
  db.prepare("DELETE FROM history_meta WHERE key IN (?, ?)").run(SEARCH_INDEX_VERSION_KEY, SEARCH_BACKFILL_CURSOR_KEY)
}

describe("sqlite search_index backfill", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    // P1 dual-write already indexes new rows; these tests simulate legacy rows by
    // wiping the index + flags, then assert the backfill rebuilds them.
    getDatabase().exec("PRAGMA user_version = 0")
  })

  test("builds the index + recomputes preview, sets the completion flag", async () => {
    persistToolResultLastEntry("bf1", 1000)
    makeLegacy("bf1")
    expect(reqMsgCount("bf1")).toBe(0)
    expect(storedPreview("bf1")).toBe("STALE")

    await runSearchIndexBackfill(getDatabase())

    // Index built (3 messages) + preview recomputed (last = tool result).
    expect(reqMsgCount("bf1")).toBe(3)
    expect(storedPreview("bf1")).toBe("[tool_result: call_xyz]")
    expect(getMeta(getDatabase(), SEARCH_INDEX_VERSION_KEY)).toBe("1")

    // Equivalence oracle: backfilled preview === full assembleFullEntry path.
    const full = getEntryById("bf1")
    expect(storedPreview("bf1")).toBe(extractPreviewText(full!))
  })

  test("guards on history_meta — runs even when PRAGMA user_version is already 1", async () => {
    persistToolResultLastEntry("uv1", 1000)
    makeLegacy("uv1")
    // A DB migrated by the OLD preview-backfill sits at user_version=1; the new
    // backfill must NOT read user_version (it would wrongly skip).
    getDatabase().exec("PRAGMA user_version = 1")

    await runSearchIndexBackfill(getDatabase())

    expect(reqMsgCount("uv1")).toBe(3)
    expect(getMeta(getDatabase(), SEARCH_INDEX_VERSION_KEY)).toBe("1")
  })

  test("is a no-op once the completion flag is set (re-run skips everything)", async () => {
    persistToolResultLastEntry("g1", 1000)
    makeLegacy("g1")
    await runSearchIndexBackfill(getDatabase())
    expect(getMeta(getDatabase(), SEARCH_INDEX_VERSION_KEY)).toBe("1")

    // Flag is set → a second run is a guarded no-op even if we re-stale the row.
    getDatabase().prepare("UPDATE entries_v2 SET preview_text = 'SENTINEL' WHERE id = ?").run("g1")
    await runSearchIndexBackfill(getDatabase())
    expect(storedPreview("g1")).toBe("SENTINEL")
  })

  test("cooperative stop mid-pass: saves no completion flag; resume completes losslessly", async () => {
    // 60 legacy rows (batch size 50): the first batch runs synchronously, then the
    // loop hits `await sleep(0)` — we set the stop flag DURING that yield so the
    // second batch sees it and breaks (flag never set).
    for (let i = 0; i < 60; i++) {
      persistToolResultLastEntry(`r${String(i).padStart(2, "0")}`, 1000 + i)
      makeLegacy(`r${String(i).padStart(2, "0")}`)
    }

    const pass = runSearchIndexBackfill(getDatabase()) // runs batch 1 (50) synchronously, then yields
    stopSearchIndexBackfill() // set during the yield → batch 2 breaks
    await pass

    // Partial: flag unset, cursor saved, ~50 built (the first batch).
    expect(getMeta(getDatabase(), SEARCH_INDEX_VERSION_KEY)).toBeNull()
    expect(getMeta(getDatabase(), SEARCH_BACKFILL_CURSOR_KEY)).not.toBeNull()
    let builtAfterStop = 0
    for (let i = 0; i < 60; i++) if (reqMsgCount(`r${String(i).padStart(2, "0")}`) === 3) builtAfterStop += 1
    expect(builtAfterStop).toBeGreaterThan(0)
    expect(builtAfterStop).toBeLessThan(60)

    // Resume: processes the rest, skip-builds the already-done prefix (no dup), completes.
    await runSearchIndexBackfill(getDatabase())
    for (let i = 0; i < 60; i++) expect(reqMsgCount(`r${String(i).padStart(2, "0")}`)).toBe(3)
    expect(getMeta(getDatabase(), SEARCH_INDEX_VERSION_KEY)).toBe("1")
  })

  test("resume from a saved cursor re-includes the boundary (skip-built dedupes) and processes newer rows", async () => {
    // p0/p1 done in a first complete pass; then clear the flag, add p2/p3 as legacy,
    // and set the cursor to p1's started_at — resume must build p2/p3, re-include p1
    // (skip-built, no dup), and leave p0 (already built, below cursor) intact.
    persistToolResultLastEntry("q0", 2000)
    persistToolResultLastEntry("q1", 2001)
    makeLegacy("q0")
    makeLegacy("q1")
    await runSearchIndexBackfill(getDatabase()) // builds q0,q1; flag set
    expect(reqMsgCount("q0")).toBe(3)
    expect(reqMsgCount("q1")).toBe(3)

    persistToolResultLastEntry("q2", 2002)
    persistToolResultLastEntry("q3", 2003)
    makeLegacy("q2")
    makeLegacy("q3")
    const db = getDatabase()
    db.prepare("DELETE FROM history_meta WHERE key = ?").run(SEARCH_INDEX_VERSION_KEY)
    setMeta(db, SEARCH_BACKFILL_CURSOR_KEY, "2001") // resume boundary at q1

    await runSearchIndexBackfill(getDatabase())

    expect(reqMsgCount("q1")).toBe(3) // re-included at boundary, skip-built (still one set)
    expect(reqMsgCount("q2")).toBe(3) // newly built
    expect(reqMsgCount("q3")).toBe(3)
    expect(getMeta(getDatabase(), SEARCH_INDEX_VERSION_KEY)).toBe("1")
  })

  test("empty DB: sets the completion flag without error", async () => {
    expect(getEntryById("nope")).toBeUndefined()
    await runSearchIndexBackfill(getDatabase())
    expect(getMeta(getDatabase(), SEARCH_INDEX_VERSION_KEY)).toBe("1")
  })

  test("records a dedup-ratio tripwire stat on completion", async () => {
    // Same message across 3 requests → 3 req_msg refs, 1 distinct blob → ratio 3.0.
    const shared: MessageContent = { role: "user", content: "shared dedup probe" }
    for (let i = 0; i < 3; i++) {
      const e = {
        id: `d${i}`,
        startedAt: 1000 + i,
        endpoint: "anthropic-messages",
        inboundRequest: { model: "m", messages: [shared], stream: true },
      } as unknown as HistoryEntry
      insertEntry(e)
      updateEntry(e.id, { state: "completed", outboundResponse: { success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: null } })
      finalizeEntry(e.id)
      makeLegacy(`d${i}`)
    }
    await runSearchIndexBackfill(getDatabase())
    const ratio = getMeta(getDatabase(), SEARCH_INDEX_DEDUP_RATIO_KEY)
    expect(ratio).not.toBeNull()
    expect(Number(ratio)).toBeCloseTo(3, 1)
  })

  test("ties: a started_at cluster larger than the batch is lossless", async () => {
    // 60 rows all at the SAME started_at (batch size is 50) — keyset pagination by
    // (started_at, id) must process all 60, not lose the 10 past the first batch.
    for (let i = 0; i < 60; i++) {
      persistToolResultLastEntry(`tie${String(i).padStart(2, "0")}`, 5000)
      makeLegacy(`tie${String(i).padStart(2, "0")}`)
    }
    await runSearchIndexBackfill(getDatabase())
    let builtCount = 0
    for (let i = 0; i < 60; i++) if (reqMsgCount(`tie${String(i).padStart(2, "0")}`) === 3) builtCount += 1
    expect(builtCount).toBe(60)
    expect(getMeta(getDatabase(), SEARCH_INDEX_VERSION_KEY)).toBe("1")
  })
})
