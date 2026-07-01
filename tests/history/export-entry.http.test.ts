/**
 * HTTP guard for GET /history/api/entries/:id/export — the zstd-compressed
 * single-entry `.json.zst` download.
 *
 * Seeds a completed entry that carries the heavy `sseEvents` bulk (the field most
 * likely to be dropped by a lossy export path), then:
 *   - hits the export endpoint and asserts the zstd content-type + `.json.zst`
 *     Content-Disposition filename;
 *   - decompresses the body with the storage codec's `decompress` (an INDEPENDENT
 *     oracle) and asserts it `toEqual` the canonical `getEntry(id)` — i.e. the
 *     download is the authoritative richest form, byte-for-byte complete;
 *   - covers the 404 (unknown id) guard.
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
  finalizeEntry,
  getEntry,
  insertEntry,
  updateEntry,
} from "~/lib/history"
import { decompress } from "~/lib/history/sqlite/compression"
import { generateId } from "~/lib/utils"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { createFullTestApp } from "../helpers/test-app"

useIsolatedRuntime()

const app = createFullTestApp()

/** Insert + finalize one completed entry carrying sseEvents so the export has real bulk to round-trip. */
async function seedCompletedEntry(model: string): Promise<string> {
  const id = generateId()
  const entry: HistoryEntry = {
    id,
    sessionId: "session-export",
    startedAt: Date.now(),
    endpoint: "anthropic-messages",
    inboundRequest: { model, messages: [{ role: "user", content: "hi" }], stream: true },
  }
  insertEntry(entry)
  updateEntry(id, {
    state: "completed",
    outboundResponse: { success: true, model, usage: { input_tokens: 10, output_tokens: 5 }, content: null },
    sseEvents: [
      { offsetMs: 0, type: "message_start", raw: `event: message_start\ndata: {"type":"message_start"}\n\n` },
      { offsetMs: 12, type: "message_stop", raw: `event: message_stop\ndata: {"type":"message_stop"}\n\n` },
    ],
  })
  await finalizeEntry(id)
  return id
}

describe("GET /history/api/entries/:id/export", () => {
  test("returns a zstd .json.zst whose decompressed content equals the canonical full entry", async () => {
    const id = await seedCompletedEntry("claude-opus-4.8")

    const res = await app.request(`/history/api/entries/${id}/export`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/zstd")
    expect(res.headers.get("content-disposition")).toContain(`${id}_claude-opus-4.8.json.zst`)

    const bytes = new Uint8Array(await res.arrayBuffer())
    // Independent oracle: storage-codec decompress must reproduce the canonical richest form.
    // Semantically lossless (undefined-valued keys ≡ absent, since JSON drops them) — `toEqual`
    // treats missing and `undefined` keys as equal, which is exactly the fidelity we want.
    const roundTripped = decompress(bytes)
    expect(roundTripped).toEqual(getEntry(id) as unknown as Record<string, unknown>)

    // The heavy sseEvents bulk survives the export (guards against a lossy path).
    expect((roundTripped as HistoryEntry).sseEvents).toHaveLength(2)
  })

  test("sanitizes a filename-hostile model so the Content-Disposition header stays valid (no 500)", async () => {
    // Model is raw client input; a `/` or `:` (or worse, CRLF) must not break the header.
    const id = await seedCompletedEntry("vendor/model:v2")

    const res = await app.request(`/history/api/entries/${id}/export`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-disposition")).toContain(`${id}_vendor_model_v2.json.zst`)
  })

  test("404 for an unknown id", async () => {
    const res = await app.request("/history/api/entries/does-not-exist/export")
    expect(res.status).toBe(404)
  })
})
