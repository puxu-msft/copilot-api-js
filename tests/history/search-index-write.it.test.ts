import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  HistoryEntry,
  MessageContent,
} from "~/lib/history/types"

import {
  //
  finalizeEntry,
  insertEntry,
  updateEntry,
} from "~/lib/history"
import { hashMessage } from "~/lib/history/normalize-message"
import { getDatabase } from "~/lib/history/sqlite/connection"
import { buildSearchIndexForEntry } from "~/lib/history/sqlite/search-index-write"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

/** Insert + (optionally patch) + finalize one terminal entry so it lands persisted. */
function seed(entry: HistoryEntry, patch?: Partial<HistoryEntry>): void {
  insertEntry(entry)
  updateEntry(entry.id, {
    state: "completed",
    outboundResponse: { success: true, model: entry.inboundRequest.model ?? "m", usage: { input_tokens: 1, output_tokens: 1 }, content: null },
    ...patch,
  })
  finalizeEntry(entry.id)
}

function baseEntry(id: string, messages: Array<MessageContent>, startedAt: number, sessionId = "s1"): HistoryEntry {
  return {
    id,
    sessionId,
    startedAt,
    endpoint: "anthropic-messages",
    inboundRequest: { model: "claude-opus-4", messages, stream: true },
  }
}

describe("search-index dual-write (P1)", () => {
  useIsolatedRuntime()

  test("inbound messages → msg_blob + req_msg with position order", () => {
    const messages: Array<MessageContent> = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "an answer" },
    ]
    seed(baseEntry("r1", messages, 1000))

    const db = getDatabase()
    const rows = db.prepare("SELECT pos, hash FROM req_msg WHERE req_id = ? ORDER BY pos").all("r1") as Array<{ pos: number; hash: string }>
    expect(rows.map((r) => r.pos)).toEqual([0, 1])
    expect(rows[0].hash).toBe(hashMessage(messages[0], "anthropic"))
    expect(rows[1].hash).toBe(hashMessage(messages[1], "anthropic"))

    const blobs = db.prepare("SELECT text FROM msg_blob WHERE hash = ?").all(rows[0].hash) as Array<{ text: string }>
    expect(blobs).toHaveLength(1)
    expect(blobs[0].text).toContain("first question")
  })

  test("identical message across two requests is stored once (content-addressed dedup)", () => {
    const shared: MessageContent = { role: "user", content: "shared turn text" }
    seed(baseEntry("a1", [shared], 1000))
    seed(baseEntry("a2", [shared, { role: "assistant", content: "reply" }], 2000))

    const db = getDatabase()
    const sharedHash = hashMessage(shared, "anthropic")
    const blobCount = db.prepare("SELECT COUNT(*) AS n FROM msg_blob WHERE hash = ?").get(sharedHash) as { n: number }
    expect(blobCount.n).toBe(1)
    // Both requests reference the same blob.
    const refs = db.prepare("SELECT req_id FROM req_msg WHERE hash = ? ORDER BY req_id").all(sharedHash) as Array<{ req_id: string }>
    expect(refs.map((r) => r.req_id)).toEqual(["a1", "a2"])
  })

  test("cache_control moving between turns still dedups to one blob", () => {
    const withCc: MessageContent = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out", cache_control: { type: "ephemeral" } }] }
    const withoutCc: MessageContent = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }] }
    seed(baseEntry("c1", [withCc], 1000))
    seed(baseEntry("c2", [withoutCc], 2000))

    const db = getDatabase()
    const n = db.prepare("SELECT COUNT(DISTINCT hash) AS n FROM req_msg WHERE req_id IN ('c1','c2')").get() as { n: number }
    expect(n.n).toBe(1)
  })

  test("rewrites-req captures removed-side text (proxy dropped a message)", () => {
    const m1: MessageContent = { role: "user", content: "kept message" }
    const m2: MessageContent = { role: "user", content: "DROPPED_BY_PROXY message" }
    const entry = baseEntry("rw1", [m1, m2], 1000)
    // Proxy sent only m1 upstream → m2 is a removed-side rewrite.
    seed(entry, { outboundRequest: { messages: [m1] } })

    const db = getDatabase()
    const aux = db.prepare("SELECT text FROM req_aux WHERE req_id = ? AND source = 'rewrites-req'").get("rw1") as { text: string } | undefined
    expect(aux).toBeDefined()
    expect(aux?.text).toContain("DROPPED_BY_PROXY")
  })

  test("req-headers / resp-headers facets concatenate present legs", () => {
    const entry = baseEntry("h1", [{ role: "user", content: "q" }], 1000)
    seed(entry, {
      httpHeaders: {
        inboundRequest: { "x-client": "claude-code" },
        outboundRequest: { authorization: "Bearer redacted-but-stored" },
        outboundResponse: { "x-request-id": "req-xyz" },
      },
    })

    const db = getDatabase()
    const reqH = db.prepare("SELECT text FROM req_aux WHERE req_id = ? AND source = 'req-headers'").get("h1") as { text: string } | undefined
    const respH = db.prepare("SELECT text FROM req_aux WHERE req_id = ? AND source = 'resp-headers'").get("h1") as { text: string } | undefined
    expect(reqH?.text).toContain("x-client: claude-code")
    expect(reqH?.text).toContain("authorization: Bearer redacted-but-stored")
    expect(respH?.text).toContain("x-request-id: req-xyz")
  })

  test("prev_req_id points at the most-recent prior request in the same session", () => {
    seed(baseEntry("p1", [{ role: "user", content: "turn 1" }], 1000, "sess"))
    seed(baseEntry("p2", [{ role: "user", content: "turn 2" }], 2000, "sess"))
    seed(baseEntry("p3", [{ role: "user", content: "turn 3" }], 3000, "sess"))

    const db = getDatabase()
    const get = (id: string) => (db.prepare("SELECT prev_req_id FROM entries_v2 WHERE id = ?").get(id) as { prev_req_id: string | null }).prev_req_id
    expect(get("p1")).toBeNull()
    expect(get("p2")).toBe("p1")
    expect(get("p3")).toBe("p2")
  })

  test("re-finalization is idempotent (no PK conflict, rows replaced)", () => {
    const messages: Array<MessageContent> = [{ role: "user", content: "idempotent" }]
    seed(baseEntry("i1", messages, 1000))
    // Re-finalize the same id.
    expect(() => finalizeEntry("i1")).not.toThrow()

    const db = getDatabase()
    const n = db.prepare("SELECT COUNT(*) AS n FROM req_msg WHERE req_id = 'i1'").get() as { n: number }
    expect(n.n).toBe(1)
  })

  test("build throw degrades to empty index without escaping (RFC reviewer M1)", () => {
    // Force a build-logic throw INDEPENDENT of head serialization: a throwing
    // getter on inboundRequest.messages. buildSearchIndexForEntry must swallow it
    // and return an empty index (so finalize, which calls it tx-outside, is never
    // aborted by a derived-index failure). A data poison like a BigInt is NOT used
    // here — that breaks head-blob serialization too, so it can't isolate the
    // build's own try/catch contract.
    const poison = baseEntry("x", [], 1000)
    Object.defineProperty(poison.inboundRequest, "messages", {
      get() {
        throw new Error("boom")
      },
    })
    let built: ReturnType<typeof buildSearchIndexForEntry> | undefined
    expect(() => {
      built = buildSearchIndexForEntry(poison)
    }).not.toThrow()
    expect(built).toEqual({ msgs: [], aux: [] })
  })

  test("entry with no messages indexes empty but finalizes head row intact", () => {
    seed(baseEntry("m1", [], 1000))
    const db = getDatabase()
    const head = db.prepare("SELECT id, status FROM entries_v2 WHERE id = ?").get("m1") as { id: string; status: string } | undefined
    expect(head?.id).toBe("m1")
    expect(head?.status).toBe("completed")
    const n = db.prepare("SELECT COUNT(*) AS n FROM req_msg WHERE req_id = 'm1'").get() as { n: number }
    expect(n.n).toBe(0)
  })

  test("rewrites-resp (streaming) captures changed frame raw between upstream and forwarded", () => {
    const entry = baseEntry("sr1", [{ role: "user", content: "q" }], 1000)
    seed(entry, {
      // Upstream emitted UPSTREAM_DELTA; the proxy forwarded a rewritten frame.
      sseEvents: [{ offsetMs: 0, type: "content_block_delta", raw: '{"delta":"UPSTREAM_DELTA"}' }],
      inboundResponse: { sseEvents: [{ offsetMs: 0, type: "content_block_delta", raw: '{"delta":"FORWARDED_DELTA"}' }] },
    })

    const db = getDatabase()
    const aux = db.prepare("SELECT text FROM req_aux WHERE req_id = ? AND source = 'rewrites-resp'").get("sr1") as { text: string } | undefined
    expect(aux).toBeDefined()
    expect(aux?.text).toContain("UPSTREAM_DELTA")
    expect(aux?.text).toContain("FORWARDED_DELTA")
  })

  test("prev_req_id isolates by agent across a subagent boundary", () => {
    // main turn 1 → subagent turn → main turn 2: main2.prev must skip the subagent.
    seed(baseEntry("main1", [{ role: "user", content: "m1" }], 1000, "x"))
    seed({ ...baseEntry("sub1", [{ role: "user", content: "s1" }], 1500, "x"), agentId: "agent-A" })
    seed(baseEntry("main2", [{ role: "user", content: "m2" }], 2000, "x"))

    const db = getDatabase()
    const get = (id: string) => (db.prepare("SELECT prev_req_id FROM entries_v2 WHERE id = ?").get(id) as { prev_req_id: string | null }).prev_req_id
    expect(get("main2")).toBe("main1") // NULL-agent group skips the subagent row
    expect(get("sub1")).toBeNull() // first (and only) row in agent-A group
  })
})
