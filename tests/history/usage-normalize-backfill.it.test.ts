/**
 * Recoverable usage net-of-cache normalization backfill (sqlite/usage-normalize-backfill.ts).
 *
 * Flips pre-migration OpenAI/Responses/Gemini rows whose `input_tokens` included
 * the cached subset to the canonical NET convention, in BOTH the column AND the
 * blob (outbound_response stage for finalized rows / head blob for legacy rows)
 * so the list and detail views never diverge. Idempotency rests on the per-row
 * `usage_normalized` marker (NOT the cursor) — the subtraction is destructive.
 *
 * Independent oracle: expected net values are computed by hand as
 * `total - cached` (GHC translator.py), never re-derived from the code under test.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history"

import {
  //
  compress,
  decompress,
} from "~/lib/history/sqlite/compression"
import { getDatabase } from "~/lib/history/sqlite/connection"
import {
  //
  getMeta,
  USAGE_NORMALIZE_CURSOR_KEY,
  USAGE_NORMALIZE_VERSION_KEY,
} from "~/lib/history/sqlite/meta"
import { getEntryById } from "~/lib/history/sqlite/read"
import {
  //
  runUsageNormalizeBackfill,
  stopUsageNormalizeBackfill,
} from "~/lib/history/sqlite/usage-normalize-backfill"
import {
  //
  finalizeEntry,
  insertEntry,
  updateEntry,
} from "~/lib/history/store"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

/** Column view (list / sessions-agg / stats read this). */
function col(id: string): { input_tokens: number | null; cache_read: number | null; usage_normalized: number } {
  return getDatabase().prepare("SELECT input_tokens, cache_read, usage_normalized FROM entries_v2 WHERE id = ?").get(id) as {
    input_tokens: number | null
    cache_read: number | null
    usage_normalized: number
  }
}

/** Blob view (detail page reads this via assembleFullEntry). */
function blobInput(id: string): number | undefined {
  return getEntryById(id)?.outboundResponse?.usage?.input_tokens
}

/**
 * Persist a completed OpenAI entry through the REAL write path (insert → update →
 * finalize → stage-split layout: usage lives in the outbound_response stage row),
 * THEN rewrite it into the pre-migration OVERLAP form: column + stage blob both
 * carry `input_tokens = total` (incl the `cached` subset) and usage_normalized=0.
 */
async function seedOverlapFinalized(id: string, startedAt: number, total: number, cached: number, endpoint = "openai-chat-completions"): Promise<void> {
  const entry = {
    id,
    endpoint,
    startedAt,
    state: "pending",
    active: true,
    lastUpdatedAt: startedAt,
    inboundRequest: { model: "gpt-5", messages: [{ role: "user", content: "hi" }] },
  } as unknown as HistoryEntry
  insertEntry(entry)
  updateEntry(id, {
    state: "completed",
    active: false,
    lastUpdatedAt: startedAt,
    endedAt: startedAt,
    outboundResponse: { success: true, model: "gpt-5", usage: { input_tokens: 5, output_tokens: 3 }, content: null },
  })
  await finalizeEntry(id)

  // Rewrite to the pre-migration overlap form (total incl cached), marker cleared.
  const db = getDatabase()
  db.prepare("UPDATE entries_v2 SET input_tokens = ?, cache_read = ?, usage_normalized = 0 WHERE id = ?").run(total, cached, id)
  const stage = db.prepare("SELECT blob_gz FROM entry_stages WHERE entry_id = ? AND stage = 'outbound_response'").get(id) as { blob_gz: Uint8Array }
  const payload = decompress(stage.blob_gz) as { usage: Record<string, number> }
  payload.usage.input_tokens = total
  payload.usage.cache_read_input_tokens = cached
  db.prepare("UPDATE entry_stages SET blob_gz = ? WHERE entry_id = ? AND stage = 'outbound_response'").run(compress(payload), id)
}

/** Insert a LEGACY single-blob row (head blob IS the full entry; NO stage rows). */
function seedLegacySingleBlob(id: string, startedAt: number, total: number, cached: number): void {
  const full = {
    inboundRequest: { model: "gpt-5", messages: [{ role: "user", content: "legacy" }] },
    outboundResponse: { success: true, model: "gpt-5", usage: { input_tokens: total, cache_read_input_tokens: cached, output_tokens: 3 }, content: null },
  }
  getDatabase()
    .prepare(
      "INSERT INTO entries_v2 (id, started_at, endpoint, transport, status, input_tokens, cache_read, output_tokens, usage_normalized, blob_gz) "
        + "VALUES (?,?,?,?,?,?,?,?,0,?)",
    )
    .run(id, startedAt, "openai-chat-completions", "http", "completed", total, cached, 3, compress(full))
}

/** Insert an anthropic-messages row already in the net convention (marker cleared). */
async function seedAnthropicNet(id: string, startedAt: number, net: number, cached: number): Promise<void> {
  const entry = {
    id,
    endpoint: "anthropic-messages",
    startedAt,
    state: "pending",
    active: true,
    lastUpdatedAt: startedAt,
    inboundRequest: { model: "claude", messages: [{ role: "user", content: "hi" }] },
  } as unknown as HistoryEntry
  insertEntry(entry)
  updateEntry(id, {
    state: "completed",
    active: false,
    endedAt: startedAt,
    outboundResponse: { success: true, model: "claude", usage: { input_tokens: net, cache_read_input_tokens: cached, output_tokens: 3 }, content: null },
  })
  await finalizeEntry(id)
  getDatabase().prepare("UPDATE entries_v2 SET usage_normalized = 0 WHERE id = ?").run(id)
}

describe("sqlite usage-normalize backfill", () => {
  useIsolatedRuntime()

  test("finalized overlap row: nets BOTH column and blob (no list/detail divergence)", async () => {
    await seedOverlapFinalized("f1", 1000, 1000, 400) // total 1000, cached 400 → net 600
    expect(col("f1").input_tokens).toBe(1000)
    expect(blobInput("f1")).toBe(1000)

    await runUsageNormalizeBackfill(getDatabase())

    // Oracle: net = 1000 - 400 = 600, in BOTH persistence sites; cache_read intact.
    expect(col("f1").input_tokens).toBe(600)
    expect(blobInput("f1")).toBe(600)
    expect(col("f1").cache_read).toBe(400)
    expect(col("f1").usage_normalized).toBe(1)
    expect(getMeta(getDatabase(), USAGE_NORMALIZE_VERSION_KEY)).toBe("1")
  })

  test("legacy single-blob row: nets the head blob + column", async () => {
    seedLegacySingleBlob("lg1", 1000, 800, 300) // net 500
    expect(blobInput("lg1")).toBe(800)

    await runUsageNormalizeBackfill(getDatabase())

    expect(col("lg1").input_tokens).toBe(500)
    expect(blobInput("lg1")).toBe(500)
    expect(col("lg1").usage_normalized).toBe(1)
  })

  test("anthropic row is already net: marked normalized with NO data change", async () => {
    await seedAnthropicNet("an1", 1000, 700, 250)
    expect(col("an1").input_tokens).toBe(700)

    await runUsageNormalizeBackfill(getDatabase())

    // Untouched value (already net), only the marker flips.
    expect(col("an1").input_tokens).toBe(700)
    expect(blobInput("an1")).toBe(700)
    expect(col("an1").usage_normalized).toBe(1)
  })

  test("re-run is a guarded no-op (marker + version both prevent a second subtraction)", async () => {
    await seedOverlapFinalized("r1", 1000, 1000, 400)
    await runUsageNormalizeBackfill(getDatabase())
    expect(col("r1").input_tokens).toBe(600)

    // Second full run: version guard short-circuits; value stays net (not 200).
    await runUsageNormalizeBackfill(getDatabase())
    expect(col("r1").input_tokens).toBe(600)

    // Even with the version flag cleared, the per-row marker (usage_normalized=1)
    // keeps the row out of `WHERE usage_normalized=0` → still no re-subtraction.
    getDatabase().prepare("DELETE FROM history_meta WHERE key = ?").run(USAGE_NORMALIZE_VERSION_KEY)
    await runUsageNormalizeBackfill(getDatabase())
    expect(col("r1").input_tokens).toBe(600)
  })

  test("the marker is the SOLE defense: clearing it (value already net) causes a second subtraction", async () => {
    await seedOverlapFinalized("d1", 1000, 1000, 400)
    await runUsageNormalizeBackfill(getDatabase())
    expect(col("d1").input_tokens).toBe(600)

    // Corrupt the invariant by hand: value stays net (600) but the marker is cleared
    // and the completion flag removed. This documents WHY the marker is load-bearing —
    // re-running now double-subtracts (600 - 400 = 200), proving row-level self-check
    // (net===raw) would be insufficient.
    const db = getDatabase()
    db.prepare("UPDATE entries_v2 SET usage_normalized = 0 WHERE id = ?").run("d1")
    db.prepare("DELETE FROM history_meta WHERE key = ?").run(USAGE_NORMALIZE_VERSION_KEY)
    await runUsageNormalizeBackfill(getDatabase())
    expect(col("d1").input_tokens).toBe(200) // corrupted — the marker existed for exactly this reason
  })

  test("undecodable blob: row stays usage_normalized=0 (retried), version still completes", async () => {
    await seedOverlapFinalized("bad1", 1000, 1000, 400)
    // Corrupt the stage blob so decompress throws — the row must be skipped WITHOUT
    // marking (so it stays fully in the old convention: column + blob both untouched).
    getDatabase()
      .prepare("UPDATE entry_stages SET blob_gz = ? WHERE entry_id = ? AND stage = 'outbound_response'")
      .run(new Uint8Array([1, 2, 3, 4]), "bad1")

    await runUsageNormalizeBackfill(getDatabase())

    expect(col("bad1").input_tokens).toBe(1000) // column untouched (atomic skip)
    expect(col("bad1").usage_normalized).toBe(0) // not marked → retried next full run
    expect(getMeta(getDatabase(), USAGE_NORMALIZE_VERSION_KEY)).toBe("1")
  })

  test("cooperative stop mid-pass: no completion flag; resume completes losslessly", async () => {
    // 120 overlap rows (batch size 100): batch 1 runs synchronously, then the loop
    // yields — set the stop flag DURING the yield so batch 2 breaks (flag never set).
    for (let i = 0; i < 120; i++) await seedOverlapFinalized(`s${String(i).padStart(3, "0")}`, 1000 + i, 1000, 400)

    const pass = runUsageNormalizeBackfill(getDatabase())
    stopUsageNormalizeBackfill()
    await pass

    expect(getMeta(getDatabase(), USAGE_NORMALIZE_VERSION_KEY)).toBeNull()
    expect(getMeta(getDatabase(), USAGE_NORMALIZE_CURSOR_KEY)).not.toBeNull()
    let doneAfterStop = 0
    for (let i = 0; i < 120; i++) if (col(`s${String(i).padStart(3, "0")}`).input_tokens === 600) doneAfterStop += 1
    expect(doneAfterStop).toBeGreaterThan(0)
    expect(doneAfterStop).toBeLessThan(120)

    // Resume: no row is double-subtracted (all land on exactly 600), completes.
    await runUsageNormalizeBackfill(getDatabase())
    for (let i = 0; i < 120; i++) expect(col(`s${String(i).padStart(3, "0")}`).input_tokens).toBe(600)
    expect(getMeta(getDatabase(), USAGE_NORMALIZE_VERSION_KEY)).toBe("1")
  })

  test("ties: a started_at cluster larger than the batch is lossless", async () => {
    for (let i = 0; i < 120; i++) await seedOverlapFinalized(`t${String(i).padStart(3, "0")}`, 5000, 1000, 400) // same started_at
    await runUsageNormalizeBackfill(getDatabase())
    for (let i = 0; i < 120; i++) expect(col(`t${String(i).padStart(3, "0")}`).input_tokens).toBe(600)
    expect(getMeta(getDatabase(), USAGE_NORMALIZE_VERSION_KEY)).toBe("1")
  })

  test("empty DB: sets the completion flag without error", async () => {
    await runUsageNormalizeBackfill(getDatabase())
    expect(getMeta(getDatabase(), USAGE_NORMALIZE_VERSION_KEY)).toBe("1")
  })
})
