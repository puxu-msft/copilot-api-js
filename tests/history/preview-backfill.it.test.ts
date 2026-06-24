/**
 * One-time `preview_text` backfill (sqlite/preview-backfill.ts).
 *
 * `extractPreviewText` changed to faithfully summarize the LAST message; the
 * per-entry preview is denormalized into `entries_v2.preview_text` at finalize
 * and the read paths do NOT recompute, so existing rows keep their stale value.
 * `backfillPreviewInBackground` recomputes once (async/chunked/inbound-only),
 * guarded by `PRAGMA user_version`.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history"

import { extractPreviewText } from "~/lib/history/in-flight"
import { getDatabase } from "~/lib/history/sqlite/connection"
import { backfillPreviewInBackground } from "~/lib/history/sqlite/preview-backfill"
import { getEntryById } from "~/lib/history/sqlite/read"
import {
  //
  finalizeEntry,
  insertEntry,
  updateEntry,
} from "~/lib/history/store"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

/** Read one row's stored preview_text directly from the column (not recomputed). */
function storedPreview(id: string): string | null {
  const row = getDatabase().prepare("SELECT preview_text FROM entries_v2 WHERE id = ?").get(id) as { preview_text: string | null } | null
  return row ? row.preview_text : null
}

/** Read PRAGMA user_version. */
function userVersion(): number {
  const row = getDatabase().prepare("PRAGMA user_version").get() as Record<string, unknown> | null
  return row ? (Object.values(row)[0] as number) : 0
}

/**
 * Persist a completed entry through the REAL write path (insert → update →
 * finalize), so the head row PLUS its `entry_stages` (inbound_request carrying
 * the messages) exist — exactly what the inbound-only backfill needs to recompute
 * the preview. The LAST message is an OpenAI `role:"tool"` message → new logic
 * yields `[tool_result: <call_id>]`. When `sseEvents` is provided it is persisted
 * as a (large) sse_events stage row — the backfill must produce the right preview
 * WITHOUT decompressing it.
 */
function persistToolResultLastEntry(id: string, sseEvents?: Array<{ raw: string }>): void {
  const entry = {
    id,
    endpoint: "openai-chat-completions",
    startedAt: Date.now(),
    state: "pending",
    active: true,
    lastUpdatedAt: Date.now(),
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
    lastUpdatedAt: Date.now(),
    endedAt: Date.now(),
    ...(sseEvents ? { sseEvents: sseEvents as unknown as HistoryEntry["sseEvents"] } : {}),
    outboundResponse: {
      success: true,
      model: "gpt-5",
      usage: { input_tokens: 5, output_tokens: 3 },
      content: null,
    },
  })
  finalizeEntry(id)
}

describe("sqlite preview_text backfill", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    // A fresh `:memory:` runtime starts at user_version 0; openDatabase no longer
    // backfills (it now runs in the background, fired post-listen by start.ts), so
    // a freshly-opened DB stays at 0. Set it explicitly so each test controls the
    // guard regardless of prior state.
    getDatabase().exec("PRAGMA user_version = 0")
  })

  test("recomputes a stale preview and sets user_version", async () => {
    persistToolResultLastEntry("bf1")
    // The faithful new logic summarizes the LAST message (the tool result).
    expect(storedPreview("bf1")).toBe("[tool_result: call_xyz]")

    // Simulate a LEGACY row: stale stored preview (old "first message" logic) +
    // a pre-backfill user_version.
    getDatabase().prepare("UPDATE entries_v2 SET preview_text = ? WHERE id = ?").run("STALE FIRST MESSAGE", "bf1")
    getDatabase().exec("PRAGMA user_version = 0")
    expect(storedPreview("bf1")).toBe("STALE FIRST MESSAGE")

    await backfillPreviewInBackground(getDatabase())

    expect(storedPreview("bf1")).toBe("[tool_result: call_xyz]")
    expect(userVersion()).toBe(1)

    // Equivalence oracle: the inbound-only backfill extraction MUST equal the
    // OLD/full path. `getEntryById` loads the row through `assembleFullEntry`
    // (full-stage reconstruction); the backfilled column is computed inbound-only.
    // Asserting `storedPreview === extractPreviewText(full-entry)` locks
    // new-inbound-only-path === old-full-assembleFullEntry-path on a REAL
    // finalize-written entry (which carries the B3 request_group container).
    const full = getEntryById("bf1")
    expect(storedPreview("bf1")).toBe(extractPreviewText(full!))
  })

  test("inbound-only: recomputes correctly even with a large sse_events stage", async () => {
    // A 256 KB sse_events stream — the backfill must produce the right preview
    // purely from the inbound messages, WITHOUT needing the sse_events blob.
    const bigRaw = "x".repeat(256 * 1024)
    persistToolResultLastEntry("bf-inbound", [{ raw: bigRaw }])
    getDatabase().prepare("UPDATE entries_v2 SET preview_text = ? WHERE id = ?").run("STALE", "bf-inbound")
    getDatabase().exec("PRAGMA user_version = 0")

    await backfillPreviewInBackground(getDatabase())

    expect(storedPreview("bf-inbound")).toBe("[tool_result: call_xyz]")
    expect(userVersion()).toBe(1)

    // Strongest equivalence case: new-inbound-only === old-full path even though
    // a 256 KB sse_events stage exists. `getEntryById` (assembleFullEntry, full
    // path) reconstructs the entry; the backfill never decompressed sse_events.
    const full = getEntryById("bf-inbound")
    expect(storedPreview("bf-inbound")).toBe(extractPreviewText(full!))
  })

  test("recompute keeps the FTS index in sync (search by new preview)", async () => {
    persistToolResultLastEntry("bf-fts")
    getDatabase().prepare("UPDATE entries_v2 SET preview_text = ? WHERE id = ?").run("zzz_stale_needle", "bf-fts")
    getDatabase().exec("PRAGMA user_version = 0")

    await backfillPreviewInBackground(getDatabase())

    // FTS re-synced from the new preview_text (UPDATE fired entries_v2_fts_au):
    // the new substring is findable, the stale one is not.
    const hit = getDatabase()
      .prepare("SELECT e.id FROM entries_fts f JOIN entries_v2 e ON e.rowid = f.rowid WHERE entries_fts MATCH ?")
      .all('"tool_result"') as Array<{ id: string }>
    expect(hit.some((r) => r.id === "bf-fts")).toBe(true)

    const staleHit = getDatabase()
      .prepare("SELECT e.id FROM entries_fts f JOIN entries_v2 e ON e.rowid = f.rowid WHERE entries_fts MATCH ?")
      .all('"zzz_stale_needle"') as Array<{ id: string }>
    expect(staleHit.some((r) => r.id === "bf-fts")).toBe(false)
  })

  test("is idempotent / guarded once user_version is current", async () => {
    persistToolResultLastEntry("bf2")
    getDatabase().exec("PRAGMA user_version = 0")
    await backfillPreviewInBackground(getDatabase())
    expect(userVersion()).toBe(1)

    // After the first backfill, set a sentinel and call again → guard must make
    // it a NO-OP (sentinel preserved, because user_version is already ≥ 1).
    getDatabase().prepare("UPDATE entries_v2 SET preview_text = ? WHERE id = ?").run("SENTINEL_DO_NOT_TOUCH", "bf2")
    await backfillPreviewInBackground(getDatabase())
    expect(storedPreview("bf2")).toBe("SENTINEL_DO_NOT_TOUCH")
  })

  test("empty DB: sets user_version without error", async () => {
    // beforeEach reset user_version to 0; no entries exist.
    expect(getEntryById("nope")).toBeUndefined()
    await backfillPreviewInBackground(getDatabase())
    expect(userVersion()).toBe(1)
  })
})
