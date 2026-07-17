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
  compress,
} from "~/lib/sqlite/compression"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

/** Column view (list / sessions-agg / stats read this). */
function col(id: string): { input_tokens: number | null; cache_read: number | null; usage_normalized: number } {
  return getDatabase().prepare("SELECT input_tokens, cache_read, usage_normalized FROM entries_v2 WHERE id = ?").get(id) as {
    input_tokens: number | null
    cache_read: number | null
    usage_normalized: number
  }
}

/** Blob view (detail page reads this via assembleFullEntry → read adapter → upstreamResponse). */
function blobInput(id: string): number | undefined {
  return getEntryById(id)?.attempts?.at(-1)?.upstreamResponse?.usage?.input_tokens
}

const MODEL_FOR: Record<string, string> = {
  "openai-chat-completions": "gpt-5",
  "gemini-generate-content": "gemini-2.5-pro",
  "anthropic-messages": "claude",
}

/** Insert one legacy `entry_stages` row (hand-built, mirroring the pre-P4c-3 stage layout). */
function insertStageRow(id: string, stage: string, attemptIndex: number, payload: unknown): void {
  getDatabase()
    .prepare("INSERT INTO entry_stages (entry_id, stage, attempt_index, created_at, blob_gz) VALUES (?,?,?,?,?)")
    .run(id, stage, attemptIndex, 0, compress(payload))
}

/**
 * Seed a LEGACY finalized row the way the pre-P4c-3 write path did: a head row +
 * an `outbound_response` stage carrying the usage (+ optional `sse_events` /
 * `inbound_response` streaming-marker stages). The backfill targets exactly this
 * legacy stage layout — historical rows (usage_normalized=0) — since new rows are
 * born net (usage_normalized=1) and skipped. `usageInput` is the stored input_tokens
 * (overlap = total incl cached; net = excluding cached), mirrored in column + stage.
 */
function seedLegacyFinalized(
  id: string,
  startedAt: number,
  endpoint: string,
  usageInput: number,
  cached: number,
  extraStages: Array<{ stage: string; attemptIndex: number; payload: unknown }> = [],
): void {
  const model = MODEL_FOR[endpoint] ?? "gpt-5"
  const head = { endpoint, state: "completed", attempts: [{ index: 0, strategy: "primary", durationMs: 1 }] }
  getDatabase()
    .prepare(
      "INSERT INTO entries_v2 (id, started_at, endpoint, transport, status, input_tokens, cache_read, output_tokens, usage_normalized, blob_gz) "
        + "VALUES (?,?,?,?,?,?,?,?,0,?)",
    )
    .run(id, startedAt, endpoint, "http", "completed", usageInput, cached, 3, compress(head))
  insertStageRow(id, "inbound_request", -1, { model, messages: [{ role: "user", content: "hi" }] })
  insertStageRow(id, "outbound_response", 0, { success: true, model, usage: { input_tokens: usageInput, cache_read_input_tokens: cached, output_tokens: 3 }, content: null })
  for (const s of extraStages) insertStageRow(id, s.stage, s.attemptIndex, s.payload)
}

/**
 * Seed a legacy OpenAI/Gemini row in the pre-migration OVERLAP form (column + stage
 * blob both carry `input_tokens = total` incl the cached subset, usage_normalized=0).
 * Non-streaming (no sse_events / inbound_response stage) → the backfill net-izes it.
 */
function seedOverlapFinalized(id: string, startedAt: number, total: number, cached: number, endpoint = "openai-chat-completions"): void {
  seedLegacyFinalized(id, startedAt, endpoint, total, cached)
}

/** Insert a LEGACY single-blob row (head blob IS the full entry; NO stage rows). */
function seedLegacySingleBlob(id: string, startedAt: number, total: number, cached: number): void {
  const full = {
    inboundRequest: { model: "gpt-5", messages: [{ role: "user", content: "legacy" }] },
    outboundResponse: { success: true, model: "gpt-5", usage: { input_tokens: total, cache_read_input_tokens: cached, output_tokens: 3 }, content: null },
    // Real legacy single-blob rows mirror the final attempt's response; the read
    // adapter surfaces this per-attempt copy as upstreamResponse (own usage object).
    attempts: [{ index: 0, strategy: "primary", durationMs: 1, response: { success: true, model: "gpt-5", usage: { input_tokens: total, cache_read_input_tokens: cached, output_tokens: 3 }, content: null } }],
  }
  getDatabase()
    .prepare(
      "INSERT INTO entries_v2 (id, started_at, endpoint, transport, status, input_tokens, cache_read, output_tokens, usage_normalized, blob_gz) "
        + "VALUES (?,?,?,?,?,?,?,?,0,?)",
    )
    .run(id, startedAt, "openai-chat-completions", "http", "completed", total, cached, 3, compress(full))
}

/** Insert an anthropic-messages row already in the net convention (marker cleared). */
function seedAnthropicNet(id: string, startedAt: number, net: number, cached: number): void {
  seedLegacyFinalized(id, startedAt, "anthropic-messages", net, cached)
}

/**
 * Insert a Gemini STREAMING row: it carries sseEvents (→ an sse_events stage) and
 * its usage is ALREADY net (the CC→Gemini codec nets promptTokenCount). The
 * backfill MUST NOT subtract again. `cached` sits in cache_read disjointly.
 */
function seedGeminiStreamingNet(id: string, startedAt: number, net: number, cached: number): void {
  seedLegacyFinalized(id, startedAt, "gemini-generate-content", net, cached, [
    { stage: "sse_events", attemptIndex: -1, payload: [{ offsetMs: 1, type: "message_start", raw: "{}" }] },
  ])
}

/** Insert a LEGACY single-blob Gemini STREAMING row (net; sseEvents in the head blob, NO stage rows). */
function seedLegacyGeminiStreamingNet(id: string, startedAt: number, net: number, cached: number): void {
  const full = {
    inboundRequest: { model: "gemini-2.5-pro", messages: [{ role: "user", content: "legacy" }], stream: true },
    outboundResponse: {
      success: true,
      model: "gemini-2.5-pro",
      usage: { input_tokens: net, cache_read_input_tokens: cached, output_tokens: 3 },
      content: null,
    },
    attempts: [{ index: 0, strategy: "primary", durationMs: 1, response: { success: true, model: "gemini-2.5-pro", usage: { input_tokens: net, cache_read_input_tokens: cached, output_tokens: 3 }, content: null } }],
    sseEvents: [{ offsetMs: 1, type: "message_start", raw: "{}" }],
  }
  getDatabase()
    .prepare(
      "INSERT INTO entries_v2 (id, started_at, endpoint, transport, status, input_tokens, cache_read, output_tokens, usage_normalized, blob_gz) "
        + "VALUES (?,?,?,?,?,?,?,?,0,?)",
    )
    .run(id, startedAt, "gemini-generate-content", "http", "completed", net, cached, 3, compress(full))
}

/**
 * Insert a Gemini STREAMING row the way the PRE-DRIVER handler (2026-06-05..~06-20)
 * did: NET usage, frames recorded via setForwardedResponse → `inboundResponse.sseEvents`
 * (an `inbound_response` stage), NOT the top-level `sse_events` stage. This is the
 * layout the first fix missed.
 */
function seedGeminiStreamingInboundResponse(id: string, startedAt: number, net: number, cached: number): void {
  seedLegacyFinalized(id, startedAt, "gemini-generate-content", net, cached, [
    { stage: "inbound_response", attemptIndex: -1, payload: { sseEvents: [{ offsetMs: 1, type: "message_start", raw: "{}" }] } },
  ])
}

/** Legacy single-blob Gemini STREAMING row with sseEvents under `inboundResponse` (not top-level). */
function seedLegacyGeminiInboundResponse(id: string, startedAt: number, net: number, cached: number): void {
  const full = {
    inboundRequest: { model: "gemini-2.5-pro", messages: [{ role: "user", content: "legacy" }], stream: true },
    inboundResponse: { sseEvents: [{ offsetMs: 1, type: "message_start", raw: "{}" }] },
    outboundResponse: {
      success: true,
      model: "gemini-2.5-pro",
      usage: { input_tokens: net, cache_read_input_tokens: cached, output_tokens: 3 },
      content: null,
    },
    attempts: [{ index: 0, strategy: "primary", durationMs: 1, response: { success: true, model: "gemini-2.5-pro", usage: { input_tokens: net, cache_read_input_tokens: cached, output_tokens: 3 }, content: null } }],
  }
  getDatabase()
    .prepare(
      "INSERT INTO entries_v2 (id, started_at, endpoint, transport, status, input_tokens, cache_read, output_tokens, usage_normalized, blob_gz) "
        + "VALUES (?,?,?,?,?,?,?,?,0,?)",
    )
    .run(id, startedAt, "gemini-generate-content", "http", "completed", net, cached, 3, compress(full))
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

  test("Gemini STREAMING row is already net (sse_events present): NOT re-subtracted", async () => {
    // Regression guard: the CC→Gemini codec nets promptTokenCount, so a streaming
    // Gemini row is stored net. A blind subtract would corrupt it (600 → 200).
    await seedGeminiStreamingNet("gs1", 1000, 600, 400)
    expect(col("gs1").input_tokens).toBe(600)

    await runUsageNormalizeBackfill(getDatabase())

    expect(col("gs1").input_tokens).toBe(600) // untouched — NOT 200
    expect(blobInput("gs1")).toBe(600)
    expect(col("gs1").cache_read).toBe(400)
    expect(col("gs1").usage_normalized).toBe(1)
  })

  test("legacy single-blob Gemini STREAMING row (sseEvents in head blob): NOT re-subtracted", async () => {
    seedLegacyGeminiStreamingNet("gls1", 1000, 600, 400)

    await runUsageNormalizeBackfill(getDatabase())

    expect(col("gls1").input_tokens).toBe(600) // untouched — NOT 200
    expect(blobInput("gls1")).toBe(600)
    expect(col("gls1").usage_normalized).toBe(1)
  })

  test("Gemini NON-streaming row (no sse_events) stores the total: IS net-ized", async () => {
    await seedOverlapFinalized("gn1", 1000, 1000, 400, "gemini-generate-content") // no sseEvents → non-streaming
    await runUsageNormalizeBackfill(getDatabase())

    expect(col("gn1").input_tokens).toBe(600) // 1000 - 400
    expect(blobInput("gn1")).toBe(600)
    expect(col("gn1").usage_normalized).toBe(1)
  })

  test("legacy-era Gemini streaming (sseEvents in inbound_response stage, no sse_events stage): NOT re-subtracted", async () => {
    // The pre-driver handler recorded frames under inboundResponse → an inbound_response
    // stage, not a top-level sse_events stage. Must still be detected as already-net.
    await seedGeminiStreamingInboundResponse("gir1", 1000, 600, 400)
    await runUsageNormalizeBackfill(getDatabase())

    expect(col("gir1").input_tokens).toBe(600) // untouched — NOT 200
    expect(blobInput("gir1")).toBe(600)
    expect(col("gir1").usage_normalized).toBe(1)
  })

  test("legacy single-blob Gemini streaming (sseEvents under inboundResponse in head blob): NOT re-subtracted", async () => {
    seedLegacyGeminiInboundResponse("glir1", 1000, 600, 400)
    await runUsageNormalizeBackfill(getDatabase())

    expect(col("glir1").input_tokens).toBe(600) // untouched — NOT 200
    expect(blobInput("glir1")).toBe(600)
    expect(col("glir1").usage_normalized).toBe(1)
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
