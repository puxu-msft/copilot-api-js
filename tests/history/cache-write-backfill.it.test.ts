/**
 * Recoverable cache-write backfill (sqlite/cache-write-backfill.ts).
 *
 * Historical streaming OpenAI-family rows were born BEFORE fix-forward captured
 * GHC's `cache_write_tokens`, so their stored `input_tokens` is net-of-CACHED-only
 * (= prompt − cached) and `cache_creation` is NULL. The raw `cache_write_tokens`
 * still lives verbatim in the `sse_events` frames. This backfill re-derives, from
 * the RAW frames, the WHOLE usage split (input = prompt − cached − cache_write,
 * cache_read = cached, cache_creation = cache_write) — it MUST NOT re-subtract on
 * the already-net stored column (C2). Non-streaming rows have no frame source and
 * are marked-skipped. Independent oracle: expected values computed by hand from the
 * raw prompt/cached/cache_write, never re-derived from the code under test.
 */

import { describe, expect, test } from "bun:test"

import { runCacheWriteBackfill } from "~/lib/history/sqlite/cache-write-backfill"
import { getDatabase } from "~/lib/history/sqlite/connection"
import { getEntryById } from "~/lib/history/sqlite/read"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"
import { compress } from "~/lib/sqlite/compression"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

function col(id: string): { input_tokens: number | null; cache_read: number | null; cache_creation: number | null; cache_write_backfilled: number } {
  return getDatabase()
    .prepare("SELECT input_tokens, cache_read, cache_creation, cache_write_backfilled FROM entries_v2 WHERE id = ?")
    .get(id) as { input_tokens: number | null; cache_read: number | null; cache_creation: number | null; cache_write_backfilled: number }
}

function blobUsage(id: string): { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined {
  return getEntryById(id)?.attempts?.at(-1)?.upstreamResponse?.usage
}

function insertStageRow(id: string, stage: string, attemptIndex: number, payload: unknown): void {
  getDatabase().prepare("INSERT INTO entry_stages (entry_id, stage, attempt_index, created_at, blob_gz) VALUES (?,?,?,?,?)").run(id, stage, attemptIndex, 0, compress(payload))
}

/**
 * Seed a streaming OpenAI-family row in the PRE-fix-forward state, in the REAL
 * POST-MIGRATION layout (the only layout this backfill sees — it runs after
 * legacy-stage-backfill): column carries `input = prompt − cached` (cache_write NOT
 * yet subtracted), cache_creation NULL, cache_write_backfilled=0; the frames live
 * NESTED in the `upstream_response` stage's `sseEvents` (attempt_index 0), NOT a
 * separate `sse_events` stage (which extractStagePayloads never emits — verified via
 * merge review). The final usage frame carries the RAW prompt/cached/cache_write.
 */
function seedStreamingPreFixForward(
  id: string,
  startedAt: number,
  endpoint: string,
  storedInput: number,
  cached: number,
  frameRaw: string,
): void {
  const model = endpoint === "gemini-generate-content" ? "gemini-2.5-pro" : "gpt-5"
  const head = { endpoint, state: "completed", attempts: [{ index: 0, strategy: "primary", durationMs: 1 }] }
  getDatabase()
    .prepare(
      "INSERT INTO entries_v2 (id, started_at, endpoint, transport, status, input_tokens, cache_read, cache_creation, output_tokens, usage_normalized, stages_migrated, cache_write_backfilled, blob_gz) "
        + "VALUES (?,?,?,?,?,?,?,?,?,1,1,0,?)",
    )
    .run(id, startedAt, endpoint, "http", "streaming-done", storedInput, cached, null, 3, compress(head))
  insertStageRow(id, "upstream_request", 0, { model, messages: [{ role: "user", content: "hi" }] })
  // Post-migration layout: usage + sseEvents NESTED in the upstream_response stage.
  insertStageRow(id, "upstream_response", 0, {
    success: true,
    model,
    usage: { input_tokens: storedInput, cache_read_input_tokens: cached, output_tokens: 3 },
    body: null,
    sseEvents: [
      { offsetMs: 1, type: "message", raw: "{\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}" },
      { offsetMs: 2, type: "message", raw: frameRaw },
    ],
  })
}

const CHAT_FRAME = JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 } } })
const RESP_FRAME = JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 } } } })

describe("cache-write backfill", () => {
  useIsolatedRuntime()

  test("recomputes cache_creation + input from raw frame, NEVER re-subtracts (C2)", async () => {
    // stored input = 400 (= 1000 − 600 cached; cache_write 300 not yet subtracted)
    seedStreamingPreFixForward("req_chat", 1000, "openai-chat-completions", 400, 600, CHAT_FRAME)
    await runCacheWriteBackfill(getDatabase())
    const c = col("req_chat")
    expect(c.input_tokens).toBe(100) // 1000 − 600 − 300 (whole recompute, NOT 400−600−300=0)
    expect(c.cache_read).toBe(600)
    expect(c.cache_creation).toBe(300)
    expect(c.cache_write_backfilled).toBe(1)
    // blob and column agree
    expect(blobUsage("req_chat")).toMatchObject({ input_tokens: 100, cache_read_input_tokens: 600, cache_creation_input_tokens: 300 })
  })

  test("responses leg reads cache_write from input_tokens_details (M3)", async () => {
    seedStreamingPreFixForward("req_resp", 1000, "openai-responses", 400, 600, RESP_FRAME)
    await runCacheWriteBackfill(getDatabase())
    const c = col("req_resp")
    expect(c.input_tokens).toBe(100)
    expect(c.cache_creation).toBe(300)
    expect(c.cache_write_backfilled).toBe(1)
  })

  test("is idempotent (second run is a no-op)", async () => {
    seedStreamingPreFixForward("req_idem", 1000, "openai-chat-completions", 400, 600, CHAT_FRAME)
    await runCacheWriteBackfill(getDatabase())
    const first = col("req_idem")
    await runCacheWriteBackfill(getDatabase())
    expect(col("req_idem")).toEqual(first)
  })

  test("marks (skips data) a row whose frame has no cache_write", async () => {
    const noCw = JSON.stringify({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 200 } } })
    seedStreamingPreFixForward("req_nocw", 1000, "openai-chat-completions", 300, 200, noCw)
    await runCacheWriteBackfill(getDatabase())
    const c = col("req_nocw")
    expect(c.cache_creation).toBeNull() // nothing to backfill
    expect(c.input_tokens).toBe(300) // unchanged (NOT re-subtracted)
    expect(c.cache_write_backfilled).toBe(1) // still marked (verified, no cache write)
  })

  test("marks (skips) a non-streaming row with no sse_events source", async () => {
    const head = { endpoint: "openai-chat-completions", state: "completed", attempts: [{ index: 0, durationMs: 1 }] }
    getDatabase()
      .prepare(
        "INSERT INTO entries_v2 (id, started_at, endpoint, transport, status, input_tokens, cache_read, cache_creation, output_tokens, usage_normalized, stages_migrated, cache_write_backfilled, blob_gz) "
          + "VALUES (?,?,?,?,?,?,?,?,?,1,1,0,?)",
      )
      .run("req_nonstream", 1000, "openai-chat-completions", "http", "completed", 400, 600, null, 3, compress(head))
    await runCacheWriteBackfill(getDatabase())
    const c = col("req_nonstream")
    expect(c.input_tokens).toBe(400) // untouched
    expect(c.cache_creation).toBeNull()
    expect(c.cache_write_backfilled).toBe(1) // marked so it's not re-scanned
  })

  test("skips anthropic rows entirely (not targeted)", async () => {
    const head = { endpoint: "anthropic-messages", state: "completed", attempts: [{ index: 0, durationMs: 1 }] }
    getDatabase()
      .prepare(
        "INSERT INTO entries_v2 (id, started_at, endpoint, transport, status, input_tokens, cache_read, cache_creation, output_tokens, usage_normalized, stages_migrated, cache_write_backfilled, blob_gz) "
          + "VALUES (?,?,?,?,?,?,?,?,?,1,1,0,?)",
      )
      .run("req_anthropic", 1000, "anthropic-messages", "http", "completed", 50, 100, 200, 3, compress(head))
    await runCacheWriteBackfill(getDatabase())
    // untouched AND still cache_write_backfilled=0 (never in scope)
    const c = col("req_anthropic")
    expect(c.cache_creation).toBe(200)
    expect(c.cache_write_backfilled).toBe(0)
  })

  // Strongest oracle: build the row through the REAL producer write path
  // (insertCompletedEntry → extractStagePayloads), immune to the hand-built-fixture
  // vs production layout gap that merge review caught. The row carries frames on
  // attempts[].upstreamResponse.sseEvents; we then reset it to the pre-fix-forward
  // state (net-of-cached input, no cache_creation, marker 0) and backfill.
  test("recovers cache_write from a row written via the REAL producer path (extractStagePayloads)", async () => {
    const frame = JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 } } })
    await insertCompletedEntry({
      id: "req_real",
      startedAt: 2000,
      endpoint: "openai-chat-completions",
      state: "completed",
      attempts: [
        {
          index: 0,
          durationMs: 1,
          // pre-fix-forward stored usage: net-of-CACHED only, no cache_creation.
          upstreamResponse: {
            success: true,
            model: "gpt-5",
            usage: { input_tokens: 400, output_tokens: 50, cache_read_input_tokens: 600 },
            body: null,
            sseEvents: [{ offsetMs: 1, type: "message", raw: frame }],
          },
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    // Simulate a historical row: clear the born cache_write_backfilled marker.
    getDatabase().prepare("UPDATE entries_v2 SET cache_write_backfilled = 0 WHERE id = 'req_real'").run()

    await runCacheWriteBackfill(getDatabase())

    const c = col("req_real")
    expect(c.input_tokens).toBe(100) // 1000 − 600 − 300
    expect(c.cache_creation).toBe(300)
    expect(c.cache_read).toBe(600)
    expect(c.cache_write_backfilled).toBe(1)
    expect(blobUsage("req_real")).toMatchObject({ input_tokens: 100, cache_creation_input_tokens: 300 })
  })
})
