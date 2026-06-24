/**
 * One-time `preview_text` backfill (sqlite/preview-backfill.ts).
 *
 * `extractPreviewText` changed to faithfully summarize the LAST message; the
 * per-entry preview is denormalized into `entries_v2.preview_text` at finalize
 * and the read paths do NOT recompute, so existing rows keep their stale value.
 * `maybeBackfillPreview` recomputes once, guarded by `PRAGMA user_version`.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history"

import { getDatabase } from "~/lib/history/sqlite/connection"
import { maybeBackfillPreview } from "~/lib/history/sqlite/preview-backfill"
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
 * the messages) exist — exactly what `assembleFullEntry` needs to recompute the
 * preview. The LAST message is an OpenAI `role:"tool"` message → new logic yields
 * `[tool_result: <call_id>]`.
 */
function persistToolResultLastEntry(id: string): void {
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
    // A fresh `:memory:` runtime starts at user_version 0, BUT the fixture opens
    // the DB and runs openDatabase → maybeBackfillPreview, which sets it to 1.
    // Reset to 0 so each test controls the guard explicitly.
    getDatabase().exec("PRAGMA user_version = 0")
  })

  test("recomputes a stale preview and sets user_version", () => {
    persistToolResultLastEntry("bf1")
    // The faithful new logic summarizes the LAST message (the tool result).
    expect(storedPreview("bf1")).toBe("[tool_result: call_xyz]")

    // Simulate a LEGACY row: stale stored preview (old "first message" logic) +
    // a pre-backfill user_version.
    getDatabase().prepare("UPDATE entries_v2 SET preview_text = ? WHERE id = ?").run("STALE FIRST MESSAGE", "bf1")
    getDatabase().exec("PRAGMA user_version = 0")
    expect(storedPreview("bf1")).toBe("STALE FIRST MESSAGE")

    maybeBackfillPreview(getDatabase())

    expect(storedPreview("bf1")).toBe("[tool_result: call_xyz]")
    expect(userVersion()).toBe(1)
  })

  test("recompute keeps the FTS index in sync (search by new preview)", () => {
    persistToolResultLastEntry("bf-fts")
    getDatabase().prepare("UPDATE entries_v2 SET preview_text = ? WHERE id = ?").run("zzz_stale_needle", "bf-fts")
    getDatabase().exec("PRAGMA user_version = 0")

    maybeBackfillPreview(getDatabase())

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

  test("is idempotent / guarded once user_version is current", () => {
    persistToolResultLastEntry("bf2")
    getDatabase().exec("PRAGMA user_version = 0")
    maybeBackfillPreview(getDatabase())
    expect(userVersion()).toBe(1)

    // After the first backfill, set a sentinel and call again → guard must make
    // it a NO-OP (sentinel preserved, because user_version is already ≥ 1).
    getDatabase().prepare("UPDATE entries_v2 SET preview_text = ? WHERE id = ?").run("SENTINEL_DO_NOT_TOUCH", "bf2")
    maybeBackfillPreview(getDatabase())
    expect(storedPreview("bf2")).toBe("SENTINEL_DO_NOT_TOUCH")
  })

  test("empty DB: sets user_version without error", () => {
    // beforeEach reset user_version to 0; no entries exist.
    expect(getEntryById("nope")).toBeUndefined()
    maybeBackfillPreview(getDatabase())
    expect(userVersion()).toBe(1)
  })
})
