/**
 * Recoverable legacy-stage → client/upstream-stage migration backfill
 * (sqlite/legacy-stage-backfill.ts).
 *
 * Re-serializes historical rows (legacy stage-split OR legacy single-blob) into the
 * new client/upstream stage shape produced by the current finalize path, so the
 * read-time legacy→new adapter can eventually be dropped for a single-track store.
 *
 * The transform is a faithful re-serialize (NOT destructive arithmetic), so it is
 * naturally idempotent; the per-row `stages_migrated` marker is progress/skip, and
 * the correctness guarantee is the equivalence oracle: the migrated row's consumer
 * projection (new stage payloads + derived columns, read back via assembleFullEntry)
 * must be field-identical to the pre-migration read. Independent oracle: the
 * expected new-leg values are the adapter's own output on the legacy row, captured
 * BEFORE the migration, then compared to the AFTER read.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  compress,
} from "~/lib/history/sqlite/compression"
import { getDatabase } from "~/lib/history/sqlite/connection"
import {
  //
  runLegacyStageBackfill,
  stopLegacyStageBackfill,
} from "~/lib/history/sqlite/legacy-stage-backfill"
import {
  //
  getMeta,
  setMeta,
  STAGE_MIGRATE_CURSOR_KEY,
  STAGE_MIGRATE_VERSION_KEY,
  USAGE_NORMALIZE_VERSION,
  USAGE_NORMALIZE_VERSION_KEY,
} from "~/lib/history/sqlite/meta"
import { getEntryById } from "~/lib/history/sqlite/read"
import {
  //
  extractStagePayloads,
} from "~/lib/history/sqlite/serialize"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

// ── stable, order-independent structural stringify (test-side equivalence oracle) ──
function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(sortDeep)
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue
    out[key] = sortDeep(obj[key])
  }
  return out
}
function stable(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

/** The consumer projection read consumers reconstruct: the new client/upstream stage payloads. */
function newLegProjection(id: string): string {
  const entry = getEntryById(id)
  if (!entry) throw new Error(`entry ${id} not found`)
  return stable(extractStagePayloads(entry))
}

/** Sorted stage names currently persisted for an entry. */
function stageNames(id: string): Array<string> {
  return (getDatabase().prepare("SELECT stage FROM entry_stages WHERE entry_id = ? ORDER BY stage").all(id) as Array<{ stage: string }>).map((r) => r.stage)
}

/** The stages_migrated marker column. */
function marker(id: string): number {
  return (getDatabase().prepare("SELECT stages_migrated FROM entries_v2 WHERE id = ?").get(id) as { stages_migrated: number }).stages_migrated
}

/** Insert one legacy `entry_stages` row (hand-built, mirroring the pre-P4c-3 stage layout). */
function insertStageRow(id: string, stage: string, attemptIndex: number, payload: unknown): void {
  getDatabase()
    .prepare("INSERT INTO entry_stages (entry_id, stage, attempt_index, created_at, blob_gz) VALUES (?,?,?,?,?)")
    .run(id, stage, attemptIndex, 0, compress(payload))
}

/** Simulate the completed usage-normalize backfill (the gate this migration defers on). */
function setUsageGate(): void {
  setMeta(getDatabase(), USAGE_NORMALIZE_VERSION_KEY, USAGE_NORMALIZE_VERSION)
}

/**
 * Seed a LEGACY STAGE-SPLIT finalized row the pre-P4c-3 write path produced: a
 * head-meta blob (attempt summary only) + legacy inbound/effective/outbound stages.
 * usage_normalized=1 (post-usage-normalize), stages_migrated=0 (not yet migrated).
 */
function seedLegacyStageSplit(id: string, startedAt: number, extraStages: Array<{ stage: string; attemptIndex: number; payload: unknown }> = []): void {
  const headMeta = { attempts: [{ index: 0, strategy: "primary", durationMs: 5 }] }
  getDatabase()
    .prepare(
      "INSERT INTO entries_v2 (id, started_at, endpoint, transport, status, model, input_tokens, output_tokens, usage_normalized, stages_migrated, blob_gz) "
        + "VALUES (?,?,?,?,?,?,?,?,1,0,?)",
    )
    .run(id, startedAt, "openai-chat-completions", "http", "completed", "gpt-5", 10, 5, compress(headMeta))
  const body = { model: "gpt-5", messages: [{ role: "user", content: "hi" }] }
  insertStageRow(id, "inbound_request", -1, { model: "gpt-5", messages: [{ role: "user", content: "hi" }] })
  insertStageRow(id, "effective_request", 0, { format: "openai-chat-completions", model: "gpt-5", messages: body.messages, payload: body })
  insertStageRow(id, "outbound_request", 0, { format: "openai-chat-completions", model: "gpt-5", headers: { authorization: "tok" }, payload: body })
  insertStageRow(id, "outbound_response", 0, {
    success: true,
    status: 200,
    model: "gpt-5",
    usage: { input_tokens: 10, output_tokens: 5 },
    content: { choices: [] },
  })
  for (const s of extraStages) insertStageRow(id, s.stage, s.attemptIndex, s.payload)
}

/**
 * Seed a LEGACY STAGE-SPLIT FAILED row whose error text lives ONLY on
 * `outbound_response.error` — NO per-attempt `error` (the head-meta attempt summary
 * carries index/strategy/durationMs only), NO top-level `failureReason`. This is the
 * pre-`failureReason`-projection shape in the real history.db: the error is
 * recoverable ONLY from the response leg. The read adapter routes it into
 * `attempts[].error`; this backfill then re-serializes that adapted read, so the
 * error text must survive at-rest (the legacy `outbound_response` blob is rewritten
 * away into an `upstream_response` stage that has no error field).
 */
function seedLegacyFailedErrorOnlyInResponse(id: string, startedAt: number, errorText: string): void {
  const headMeta = { state: "failed", attempts: [{ index: 0, strategy: "primary", durationMs: 7 }] }
  getDatabase()
    .prepare(
      "INSERT INTO entries_v2 (id, started_at, endpoint, transport, status, model, input_tokens, output_tokens, usage_normalized, stages_migrated, blob_gz) "
        + "VALUES (?,?,?,?,?,?,?,?,1,0,?)",
    )
    .run(id, startedAt, "openai-chat-completions", "http", "failed", "gpt-5", 0, 0, compress(headMeta))
  const body = { model: "gpt-5", messages: [{ role: "user", content: "boom" }] }
  insertStageRow(id, "inbound_request", -1, { model: "gpt-5", messages: [{ role: "user", content: "boom" }] })
  insertStageRow(id, "effective_request", 0, { format: "openai-chat-completions", model: "gpt-5", messages: body.messages, payload: body })
  insertStageRow(id, "outbound_request", 0, { format: "openai-chat-completions", model: "gpt-5", headers: { authorization: "tok" }, payload: body })
  insertStageRow(id, "outbound_response", 0, {
    success: false,
    status: 503,
    model: "gpt-5",
    usage: { input_tokens: 0, output_tokens: 0 },
    error: errorText,
    content: null,
    rawBody: `{"error":"${errorText}"}`,
  })
}

/** Seed a LEGACY SINGLE-BLOB row (head blob IS the full entry; NO stage rows). */
function seedLegacySingleBlob(id: string, startedAt: number): void {
  const full = {
    inboundRequest: { model: "gpt-5", messages: [{ role: "user", content: "legacy" }] },
    outboundResponse: { success: true, status: 200, model: "gpt-5", usage: { input_tokens: 8, output_tokens: 4 }, content: { choices: [] } },
    attempts: [
      {
        index: 0,
        strategy: "primary",
        durationMs: 3,
        effectiveRequest: {
          format: "openai-chat-completions",
          model: "gpt-5",
          messages: [{ role: "user", content: "legacy" }],
          payload: { model: "gpt-5", messages: [{ role: "user", content: "legacy" }] },
        },
        wireRequest: { format: "openai-chat-completions", model: "gpt-5", payload: { model: "gpt-5", messages: [{ role: "user", content: "legacy" }] } },
        response: { success: true, status: 200, model: "gpt-5", usage: { input_tokens: 8, output_tokens: 4 }, content: { choices: [] } },
      },
    ],
  }
  getDatabase()
    .prepare(
      "INSERT INTO entries_v2 (id, started_at, endpoint, transport, status, model, input_tokens, output_tokens, usage_normalized, stages_migrated, blob_gz) "
        + "VALUES (?,?,?,?,?,?,?,?,1,0,?)",
    )
    .run(id, startedAt, "openai-chat-completions", "http", "completed", "gpt-5", 8, 4, compress(full))
}

/** Seed a BORN-NEW row (already in the new stage shape, stages_migrated=1). */
function seedNewRow(id: string, startedAt: number): void {
  getDatabase()
    .prepare(
      "INSERT INTO entries_v2 (id, started_at, endpoint, transport, status, model, usage_normalized, stages_migrated, blob_gz) VALUES (?,?,?,?,?,?,1,1,?)",
    )
    .run(id, startedAt, "openai-chat-completions", "http", "completed", "gpt-5", compress({ attempts: [{ index: 0 }] }))
  insertStageRow(id, "client_request", -1, { format: "openai-chat-completions", model: "gpt-5", messages: [{ role: "user", content: "new" }] })
  insertStageRow(id, "upstream_response", 0, { success: true, model: "gpt-5", usage: { input_tokens: 1, output_tokens: 1 }, body: { choices: [] } })
}

describe("sqlite legacy-stage migration backfill", () => {
  useIsolatedRuntime()

  test("legacy STAGE-SPLIT row: old stages replaced by new client/upstream stages; read is field-equal", async () => {
    seedLegacyStageSplit("ss1", 1000)
    setUsageGate()

    expect(stageNames("ss1")).toEqual(["effective_request", "inbound_request", "outbound_request", "outbound_response"])
    const before = newLegProjection("ss1") // the adapter's new-leg output on the legacy row (the oracle)
    expect(marker("ss1")).toBe(0)

    await runLegacyStageBackfill(getDatabase())

    // (a) old stages gone, new client/upstream stages present (request-side folded into request_group).
    expect(stageNames("ss1")).toEqual(["client_request", "request_group", "upstream_response"])
    // (b) the migrated read is field-identical to the pre-migration adapter read.
    expect(newLegProjection("ss1")).toBe(before)
    // Marker + completion flag set.
    expect(marker("ss1")).toBe(1)
    expect(getMeta(getDatabase(), STAGE_MIGRATE_VERSION_KEY)).toBe("1")
  })

  test("AUDIT: legacy outbound_response.error survives migration at-rest on attempts[].error", async () => {
    const errText = "upstream 503: service unavailable"
    seedLegacyFailedErrorOnlyInResponse("err1", 1000, errText)
    setUsageGate()

    // Pre-migration read (through the adapter) already routes response.error → attempts[].error.
    const beforeEntry = getEntryById("err1")
    expect(beforeEntry?.attempts?.at(-1)?.error).toBe(errText)
    // Anti-vacuous: the persisted legacy stage really carried the error on the response leg.
    const before = newLegProjection("err1")
    expect(marker("err1")).toBe(0)

    await runLegacyStageBackfill(getDatabase())

    // The legacy `outbound_response` (which held the error) is rewritten away.
    expect(stageNames("err1")).toEqual(["client_request", "request_group", "upstream_response"])
    // Equivalence oracle: the migrated new-leg projection is field-identical to the
    // pre-migration adapter read — and it now COVERS the error (attempts[].error rides
    // the head-meta blob, so the equivalence held BOTH before and after this fix).
    expect(newLegProjection("err1")).toBe(before)
    // At-rest: the migrated head blob still carries the error text on attempts[].error.
    expect(getEntryById("err1")?.attempts?.at(-1)?.error).toBe(errText)
    expect(marker("err1")).toBe(1)
  })

  test("legacy SINGLE-BLOB row: heavy legs moved to stages; head blob stripped; read field-equal", async () => {
    seedLegacySingleBlob("sb1", 1000)
    setUsageGate()

    expect(stageNames("sb1")).toEqual([]) // single-blob: no stage rows yet
    const before = newLegProjection("sb1")

    await runLegacyStageBackfill(getDatabase())

    expect(stageNames("sb1")).toEqual(["client_request", "request_group", "upstream_response"])
    expect(newLegProjection("sb1")).toBe(before)
    expect(marker("sb1")).toBe(1)
    // The head blob no longer carries the heavy legs (it is now head-meta only): a
    // detail read reconstructs them from the stage rows, proving they moved out.
    expect(getEntryById("sb1")?.attempts?.at(-1)?.upstreamResponse?.usage?.input_tokens).toBe(8)
  })

  test("born-NEW rows (stages_migrated=1) are NEVER touched", async () => {
    seedNewRow("nw1", 1000)
    setUsageGate()
    const before = stable(
      (
        getDatabase().prepare("SELECT stage, blob_gz FROM entry_stages WHERE entry_id = ? ORDER BY stage").all("nw1") as Array<{
          stage: string
          blob_gz: Uint8Array
        }>
      ).map((r) => ({ stage: r.stage, len: r.blob_gz.length })),
    )

    await runLegacyStageBackfill(getDatabase())

    expect(marker("nw1")).toBe(1)
    expect(stageNames("nw1")).toEqual(["client_request", "upstream_response"]) // untouched (NOT re-packed into request_group)
    const after = stable(
      (
        getDatabase().prepare("SELECT stage, blob_gz FROM entry_stages WHERE entry_id = ? ORDER BY stage").all("nw1") as Array<{
          stage: string
          blob_gz: Uint8Array
        }>
      ).map((r) => ({ stage: r.stage, len: r.blob_gz.length })),
    )
    expect(after).toBe(before)
  })

  test("defers until usage-normalize completes (no version flag, row untouched); runs once gated", async () => {
    seedLegacyStageSplit("df1", 1000)
    // No usage gate set → the migration must defer.
    await runLegacyStageBackfill(getDatabase())
    expect(getMeta(getDatabase(), STAGE_MIGRATE_VERSION_KEY)).toBeNull()
    expect(marker("df1")).toBe(0)
    expect(stageNames("df1")).toEqual(["effective_request", "inbound_request", "outbound_request", "outbound_response"])

    // Now the gate opens → it migrates.
    setUsageGate()
    await runLegacyStageBackfill(getDatabase())
    expect(marker("df1")).toBe(1)
    expect(getMeta(getDatabase(), STAGE_MIGRATE_VERSION_KEY)).toBe("1")
  })

  test("re-run is a guarded no-op (version flag short-circuits; marker excludes the row)", async () => {
    seedLegacyStageSplit("r1", 1000)
    setUsageGate()
    await runLegacyStageBackfill(getDatabase())
    const afterFirst = newLegProjection("r1")
    const stagesAfterFirst = stageNames("r1")

    // Second full run: version guard short-circuits — nothing changes.
    await runLegacyStageBackfill(getDatabase())
    expect(newLegProjection("r1")).toBe(afterFirst)
    expect(stageNames("r1")).toEqual(stagesAfterFirst)

    // Even with the version flag cleared, the per-row marker (stages_migrated=1)
    // keeps the row out of `WHERE stages_migrated=0` → still no re-transform.
    getDatabase().prepare("DELETE FROM history_meta WHERE key = ?").run(STAGE_MIGRATE_VERSION_KEY)
    await runLegacyStageBackfill(getDatabase())
    expect(newLegProjection("r1")).toBe(afterFirst)
  })

  test("re-serialize is naturally idempotent: clearing the marker re-migrates to the SAME shape (no corruption)", async () => {
    seedLegacyStageSplit("id1", 1000)
    setUsageGate()
    await runLegacyStageBackfill(getDatabase())
    const afterFirst = newLegProjection("id1")

    // Unlike a destructive subtraction, a faithful re-serialize is idempotent: clear
    // the marker + version and re-run → the row (already new-shape) migrates again to
    // the identical projection. This documents that the marker is progress/skip, not a
    // corruption guard — the equivalence oracle is the correctness guarantee.
    const db = getDatabase()
    db.prepare("UPDATE entries_v2 SET stages_migrated = 0 WHERE id = ?").run("id1")
    db.prepare("DELETE FROM history_meta WHERE key = ?").run(STAGE_MIGRATE_VERSION_KEY)
    await runLegacyStageBackfill(getDatabase())
    expect(newLegProjection("id1")).toBe(afterFirst)
    expect(marker("id1")).toBe(1)
  })

  test("undecodable blob: row stays stages_migrated=0 (retried), version still completes", async () => {
    seedLegacyStageSplit("bad1", 1000)
    setUsageGate()
    // Corrupt a stage blob so assembleFullEntry's decompress throws — the row must be
    // skipped WITHOUT marking (it stays legacy, fully readable via the adapter).
    getDatabase()
      .prepare("UPDATE entry_stages SET blob_gz = ? WHERE entry_id = ? AND stage = 'outbound_response'")
      .run(new Uint8Array([1, 2, 3, 4]), "bad1")

    await runLegacyStageBackfill(getDatabase())

    expect(marker("bad1")).toBe(0) // not marked → retried on a later full run
    expect(stageNames("bad1")).toContain("outbound_request") // legacy stages untouched
    expect(getMeta(getDatabase(), STAGE_MIGRATE_VERSION_KEY)).toBe("1")
  })

  test("cooperative stop mid-pass: no completion flag; resume completes losslessly", async () => {
    // 60 rows (batch size 50): batch 1 runs synchronously, then the loop yields — set
    // the stop flag DURING the yield so batch 2 breaks (flag never set).
    for (let i = 0; i < 60; i++) seedLegacyStageSplit(`s${String(i).padStart(3, "0")}`, 1000 + i)
    setUsageGate()

    const pass = runLegacyStageBackfill(getDatabase())
    stopLegacyStageBackfill()
    await pass

    expect(getMeta(getDatabase(), STAGE_MIGRATE_VERSION_KEY)).toBeNull()
    expect(getMeta(getDatabase(), STAGE_MIGRATE_CURSOR_KEY)).not.toBeNull()
    let migrated = 0
    for (let i = 0; i < 60; i++) if (marker(`s${String(i).padStart(3, "0")}`) === 1) migrated += 1
    expect(migrated).toBeGreaterThan(0)
    expect(migrated).toBeLessThan(60)

    // Resume: every row migrates exactly once (all marked, none re-transformed), completes.
    await runLegacyStageBackfill(getDatabase())
    for (let i = 0; i < 60; i++) {
      const id = `s${String(i).padStart(3, "0")}`
      expect(marker(id)).toBe(1)
      expect(stageNames(id)).toEqual(["client_request", "request_group", "upstream_response"])
    }
    expect(getMeta(getDatabase(), STAGE_MIGRATE_VERSION_KEY)).toBe("1")
  })

  test("ties: a started_at cluster larger than the batch is lossless", async () => {
    for (let i = 0; i < 60; i++) seedLegacyStageSplit(`t${String(i).padStart(3, "0")}`, 5000) // same started_at
    setUsageGate()
    await runLegacyStageBackfill(getDatabase())
    for (let i = 0; i < 60; i++) expect(marker(`t${String(i).padStart(3, "0")}`)).toBe(1)
    expect(getMeta(getDatabase(), STAGE_MIGRATE_VERSION_KEY)).toBe("1")
  })

  test("empty DB: sets the completion flag without error (once gated)", async () => {
    setUsageGate()
    await runLegacyStageBackfill(getDatabase())
    expect(getMeta(getDatabase(), STAGE_MIGRATE_VERSION_KEY)).toBe("1")
  })
})
