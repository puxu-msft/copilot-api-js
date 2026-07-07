/**
 * P0 golden pre-capture for the finalize async-offload refactor
 * (docs/rfc/history-finalize-async-offload.md §5 P0 + invariant I6).
 *
 * Locks the OUTPUT of the finalize write path on the CURRENT synchronous code,
 * so the later async refactor (P2 compress-out-of-tx, P3 chunked index build)
 * can be proven byte/structure-equivalent: same persisted+readable entry, same
 * search-index rows, same compression round-trip. Per
 * [[methodology-golden-fixture-pre-capture]] this MUST pass on the pre-change
 * code first — a golden that only exists post-change proves nothing.
 *
 * When P2 makes `insertCompletedEntry` async, the ONLY change here is `await`;
 * the asserted golden values stay identical (that is the I6 lock).
 */
import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import { hashMessage } from "~/lib/history/normalize-message"
import {
  //
  compress,
  decompress,
} from "~/lib/history/sqlite/compression"
import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { getEntryById } from "~/lib/history/sqlite/read"
import {
  //
  buildSearchIndexChunked,
  buildSearchIndexForEntry,
} from "~/lib/history/sqlite/search-index-write"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"

// A multi-stage entry exercising EVERY heavy finalize path the refactor touches:
// request_group (clientRequest + effectiveSource + upstreamRequest bodies → one zstd
// frame), the response stages (upstreamResponse / clientResponse), the search index
// (inbound messages → msg_blob/req_msg; rewrites-req/resp + headers → req_aux), and
// the head blob.
function richEntry(): HistoryEntry {
  const messages = [
    { role: "user", content: "first user turn with some searchable text" },
    { role: "assistant", content: "assistant reply number one" },
    { role: "user", content: "a follow-up question about caching" },
  ]
  const t0 = 1_700_000_000_000
  const upstreamFrames = [
    { offsetMs: 0, type: "message_start", raw: `{"type":"message_start"}` },
    { offsetMs: 10, type: "content_block_delta", raw: `{"type":"content_block_delta","delta":{"text":"final"}}` },
    { offsetMs: 20, type: "message_stop", raw: `{"type":"message_stop"}` },
  ]
  const forwardedFrames = [
    { offsetMs: 0, type: "message_start", raw: `{"type":"message_start"}` },
    { offsetMs: 20, type: "message_stop", raw: `{"type":"message_stop"}` },
  ]
  return {
    id: "golden-1",
    sessionId: "sess-golden",
    startedAt: t0,
    endedAt: t0 + 4200,
    durationMs: 4200,
    endpoint: "anthropic-messages",
    state: "completed",
    active: false,
    lastUpdatedAt: t0 + 4200,
    transport: "http",
    model: { requested: "claude-opus-4", resolved: "claude-opus-4" },
    clientRequest: {
      model: "claude-opus-4",
      messages,
      stream: true,
      headers: { "content-type": "application/json", "x-client": "golden" },
    },
    clientResponse: {
      body: "final answer about caching",
      sseEvents: forwardedFrames,
    },
    attempts: [
      {
        index: 0,
        durationMs: 4200,
        effectiveSource: { model: "claude-opus-4", messageCount: 3, messages, body: { model: "claude-opus-4", messages, max_tokens: 4096 } },
        upstreamRequest: { model: "claude-opus-4", messages, body: { model: "claude-opus-4", messages, max_tokens: 4096, stream: true } },
        upstreamResponse: {
          success: true,
          model: "claude-opus-4",
          usage: { input_tokens: 120, output_tokens: 45 },
          stopReason: "end_turn",
          body: { role: "assistant", content: "final answer about caching" },
          sseEvents: upstreamFrames,
          headers: { "content-type": "text/event-stream", "x-request-id": "abc123" },
        },
      },
    ],
    _index: { derived: { responseSuccess: true, attemptCount: 1, currentStrategy: "primary" } },
  }
}

describe("finalize golden pre-capture (P0 — locks sync output for the async refactor)", () => {
  beforeEach(async () => {
    closeDatabase()
    openInMemoryDatabase()
  })

  test("finalize → read-back fidelity (the durability invariant the refactor must preserve)", async () => {
    const entry = richEntry()
    await insertCompletedEntry(entry) // P2: becomes `await insertCompletedEntry(entry)`

    const got = getEntryById("golden-1")
    expect(got).toBeTruthy()
    expect(got?.id).toBe("golden-1")
    expect(got?.state).toBe("completed")
    expect(got?.endpoint).toBe("anthropic-messages")
    // request_group members round-trip
    expect(got?.clientRequest?.messages).toEqual(entry.clientRequest?.messages)
    expect(got?.attempts?.at(-1)?.effectiveSource?.body).toEqual(entry.attempts?.at(-1)?.effectiveSource?.body)
    expect(got?.attempts?.at(-1)?.upstreamRequest?.body).toEqual(entry.attempts?.at(-1)?.upstreamRequest?.body)
    // response stages round-trip
    expect(got?.attempts?.at(-1)?.upstreamResponse?.usage).toEqual({ input_tokens: 120, output_tokens: 45 })
    expect(got?.attempts?.at(-1)?.upstreamResponse?.body).toEqual(entry.attempts?.at(-1)?.upstreamResponse?.body)
    expect(got?.attempts?.at(-1)?.upstreamResponse?.sseEvents).toEqual(entry.attempts?.at(-1)?.upstreamResponse?.sseEvents)
    expect(got?.clientResponse?.sseEvents).toEqual(entry.clientResponse?.sseEvents)
    expect(got?.clientRequest?.headers).toEqual(entry.clientRequest?.headers)
    expect(got?.attempts?.at(-1)?.upstreamResponse?.headers).toEqual(entry.attempts?.at(-1)?.upstreamResponse?.headers)
  })

  test("search-index rows are byte-stable (msg_blob / req_msg / req_aux)", async () => {
    const entry = richEntry()
    await insertCompletedEntry(entry)
    const db = getDatabase()

    // inbound messages → req_msg (positional) + msg_blob (content-addressed)
    const reqMsgs = db.prepare("SELECT pos, hash FROM req_msg WHERE req_id = ? ORDER BY pos").all("golden-1") as Array<{ pos: number; hash: string }>
    expect(reqMsgs.map((r) => r.pos)).toEqual([0, 1, 2])
    expect(reqMsgs[0].hash).toBe(hashMessage(entry.clientRequest!.messages![0], "anthropic"))
    expect(reqMsgs[2].hash).toBe(hashMessage(entry.clientRequest!.messages![2], "anthropic"))

    const blob0 = db.prepare("SELECT text FROM msg_blob WHERE hash = ?").get(reqMsgs[0].hash) as { text: string } | null
    expect(blob0?.text).toContain("first user turn")

    // aux sources present (rewrites-resp + headers legs are content-addressed in req_aux)
    const auxSources = (db.prepare("SELECT DISTINCT source FROM req_aux WHERE req_id = ? ORDER BY source").all("golden-1") as Array<{ source: string }>).map(
      (r) => r.source,
    )
    expect(auxSources.length).toBeGreaterThan(0)
  })

  test("buildSearchIndexForEntry output shape is locked", async () => {
    const built = buildSearchIndexForEntry(richEntry())
    // 3 inbound messages → 3 msg entries with stable positional order + hashes
    expect(built.msgs.map((m) => m.pos)).toEqual([0, 1, 2])
    expect(built.msgs[0].hash).toBe(hashMessage(richEntry().clientRequest!.messages![0], "anthropic"))
    expect(built.msgs.every((m) => typeof m.text === "string" && m.text.length > 0)).toBe(true)
    // aux facets present (headers always; rewrites best-effort)
    expect(built.aux.length).toBeGreaterThan(0)
    expect(built.aux.every((a) => typeof a.source === "string" && typeof a.text === "string")).toBe(true)
  })

  test("P3: buildSearchIndexChunked output is identical to the sync builder (I6)", async () => {
    const entry = richEntry()
    expect(await buildSearchIndexChunked(entry)).toEqual(buildSearchIndexForEntry(entry))
  })

  test("compress / decompress round-trips losslessly (the codec the refactor offloads)", async () => {
    const payload = { model: "claude-opus-4", messages: richEntry().clientRequest?.messages, nested: { a: [1, 2, 3], b: "x".repeat(5000) } }
    const blob = compress(payload)
    expect(Buffer.isBuffer(blob)).toBe(true)
    expect(decompress(blob)).toEqual(payload)
  })
})
