/**
 * Integration test for end-to-end lineage write-path:
 * finalizeEntry → computeLineageDigest → insertCompletedEntry transaction →
 * entry_lineage + entry_produced_tool_ids rows present.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import {
  //
  clearHistory,
  finalizeEntry,
  initHistory,
  insertEntry,
  shutdownHistory,
  updateEntry,
} from "~/lib/history"
import { unpackTurnHashes } from "~/lib/history/lineage"
import { getDatabase } from "~/lib/history/sqlite/connection"
import { setStateForTests } from "~/lib/state"
import { generateId } from "~/lib/utils"

function makeAnthropicEntry(messages: HistoryEntry["inboundRequest"]["messages"], extra?: Partial<HistoryEntry>): HistoryEntry {
  const entry: HistoryEntry = {
    id: generateId(),
    startedAt: Date.now(),
    endpoint: "anthropic-messages",
    inboundRequest: { model: "claude-opus-4-7", messages, stream: true },
    ...extra,
  }
  insertEntry(entry)
  return entry
}

interface LineageRow {
  entry_id: string
  schema_version: number
  root_hash: string
  turn_hashes_blob: Buffer
  post_response_hash: string | null
  back_tool_use_id: string | null
  computed_at: number
}

interface ToolIdRow {
  tool_use_id: string
  entry_id: string
}

beforeEach(() => {
  setStateForTests({ historyDbPath: ":memory:" })
  initHistory(true, 200)
})

afterEach(() => {
  clearHistory()
  shutdownHistory()
  setStateForTests({ historyDbPath: "" })
})

describe("finalizeEntry → lineage write path", () => {
  test("writes entry_lineage row with packed turn_hashes blob for a completed Anthropic entry", () => {
    const entry = makeAnthropicEntry([{ role: "user", content: "hello world" }])
    updateEntry(entry.id, {
      state: "completed",
      outboundResponse: {
        success: true,
        model: "claude-opus-4-7",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: { role: "assistant", content: [{ type: "text", text: "hi back" }] },
      },
    })
    finalizeEntry(entry.id)

    const db = getDatabase()
    const row = db.prepare("SELECT * FROM entry_lineage WHERE entry_id = ?").get(entry.id) as LineageRow | undefined
    expect(row).toBeDefined()
    expect(row?.schema_version).toBe(1)
    expect(row?.root_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row?.post_response_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row?.back_tool_use_id).toBeNull()

    // 1 message → 1 turn hash → 32 bytes packed.
    expect(row?.turn_hashes_blob.length).toBe(32)
    expect(unpackTurnHashes(row?.turn_hashes_blob as Buffer)).toHaveLength(1)
  })

  test("writes one entry_produced_tool_ids row per tool_use in assistant response", () => {
    const entry = makeAnthropicEntry([{ role: "user", content: "do work" }])
    updateEntry(entry.id, {
      state: "completed",
      outboundResponse: {
        success: true,
        model: "claude-opus-4-7",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_A", name: "Read", input: { path: "/a" } },
            { type: "tool_use", id: "toolu_B", name: "Read", input: { path: "/b" } },
          ],
        },
      },
    })
    finalizeEntry(entry.id)

    const db = getDatabase()
    const ids = db.prepare("SELECT tool_use_id FROM entry_produced_tool_ids WHERE entry_id = ? ORDER BY tool_use_id").all(entry.id) as Array<{
      tool_use_id: string
    }>
    expect(ids.map((r) => r.tool_use_id)).toEqual(["toolu_A", "toolu_B"])
  })

  test("sets back_tool_use_id when last user message is a tool_result", () => {
    const entry = makeAnthropicEntry([
      { role: "user", content: "Q1" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_PARENT", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_PARENT", content: "result" }] },
    ])
    updateEntry(entry.id, {
      state: "completed",
      outboundResponse: {
        success: true,
        model: "claude-opus-4-7",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      },
    })
    finalizeEntry(entry.id)

    const db = getDatabase()
    const row = db.prepare("SELECT back_tool_use_id FROM entry_lineage WHERE entry_id = ?").get(entry.id) as { back_tool_use_id: string }
    expect(row.back_tool_use_id).toBe("toolu_PARENT")
  })

  test("post_response_hash is NULL for failed entry (no outboundResponse.content)", () => {
    const entry = makeAnthropicEntry([{ role: "user", content: "Q1" }])
    updateEntry(entry.id, {
      state: "failed",
      outboundResponse: {
        success: false,
        model: "claude-opus-4-7",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: null,
        error: "upstream 500",
      },
    })
    finalizeEntry(entry.id)

    const db = getDatabase()
    const row = db.prepare("SELECT post_response_hash FROM entry_lineage WHERE entry_id = ?").get(entry.id) as { post_response_hash: string | null }
    expect(row.post_response_hash).toBeNull()
  })

  test("re-finalizing an entry replaces lineage row + produced_tool_ids idempotently", () => {
    const entry = makeAnthropicEntry([{ role: "user", content: "first attempt" }])
    updateEntry(entry.id, {
      state: "completed",
      outboundResponse: {
        success: true,
        model: "claude-opus-4-7",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: { role: "assistant", content: [{ type: "tool_use", id: "toolu_OLD", name: "X", input: {} }] },
      },
    })
    finalizeEntry(entry.id)

    // Simulate re-finalize with different produced ids.
    insertEntry({ ...entry })
    updateEntry(entry.id, {
      state: "completed",
      outboundResponse: {
        success: true,
        model: "claude-opus-4-7",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: { role: "assistant", content: [{ type: "tool_use", id: "toolu_NEW", name: "X", input: {} }] },
      },
    })
    finalizeEntry(entry.id)

    const db = getDatabase()
    const ids = db.prepare("SELECT tool_use_id FROM entry_produced_tool_ids WHERE entry_id = ?").all(entry.id) as Array<ToolIdRow>
    // Old id wiped, new id present.
    expect(ids.map((r) => r.tool_use_id)).toEqual(["toolu_NEW"])

    const lineageRows = db.prepare("SELECT COUNT(*) as n FROM entry_lineage WHERE entry_id = ?").get(entry.id) as { n: number }
    expect(lineageRows.n).toBe(1)
  })

  test("entry_lineage row CASCADES on entry delete (clearHistory)", () => {
    const entry = makeAnthropicEntry([{ role: "user", content: "x" }])
    updateEntry(entry.id, {
      state: "completed",
      outboundResponse: {
        success: true,
        model: "claude-opus-4-7",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: { role: "assistant", content: [{ type: "tool_use", id: "toolu_X", name: "Y", input: {} }] },
      },
    })
    finalizeEntry(entry.id)

    const db = getDatabase()
    expect((db.prepare("SELECT COUNT(*) AS n FROM entry_lineage").get() as { n: number }).n).toBe(1)
    expect((db.prepare("SELECT COUNT(*) AS n FROM entry_produced_tool_ids").get() as { n: number }).n).toBe(1)

    clearHistory()

    expect((db.prepare("SELECT COUNT(*) AS n FROM entry_lineage").get() as { n: number }).n).toBe(0)
    expect((db.prepare("SELECT COUNT(*) AS n FROM entry_produced_tool_ids").get() as { n: number }).n).toBe(0)
  })

  test("non-Anthropic endpoint gets no lineage row (v1 scope)", () => {
    const entry: HistoryEntry = {
      id: generateId(),
      startedAt: Date.now(),
      endpoint: "openai-chat-completions",
      inboundRequest: { model: "gpt-5", messages: [{ role: "user", content: "hi" }] },
    }
    insertEntry(entry)
    updateEntry(entry.id, {
      state: "completed",
      outboundResponse: {
        success: true,
        model: "gpt-5",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
    })
    finalizeEntry(entry.id)

    const db = getDatabase()
    const row = db.prepare("SELECT COUNT(*) AS n FROM entry_lineage WHERE entry_id = ?").get(entry.id) as { n: number }
    expect(row.n).toBe(0)
  })
})

describe("parent → child verification (the algorithm property in production)", () => {
  test("two adjacent entries link via tool_use_id and the postResponseHash matches the child's turnHashes", () => {
    // Parent entry produces tool_use toolu_X.
    const parent = makeAnthropicEntry([{ role: "user", content: "go" }])
    updateEntry(parent.id, {
      state: "completed",
      outboundResponse: {
        success: true,
        model: "claude-opus-4-7",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: { role: "assistant", content: [{ type: "tool_use", id: "toolu_X", name: "Read", input: { path: "/a" } }] },
      },
    })
    finalizeEntry(parent.id)

    // Child echoes parent's request + assistant + adds tool_result.
    const child = makeAnthropicEntry([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_X", name: "Read", input: { path: "/a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_X", content: "/a contents" }] },
    ])
    updateEntry(child.id, {
      state: "completed",
      outboundResponse: {
        success: true,
        model: "claude-opus-4-7",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: { role: "assistant", content: [{ type: "text", text: "done" }] },
      },
    })
    finalizeEntry(child.id)

    const db = getDatabase()
    // Lookup parent via child.back_tool_use_id.
    const childRow = db.prepare("SELECT back_tool_use_id, turn_hashes_blob FROM entry_lineage WHERE entry_id = ?").get(child.id) as {
      back_tool_use_id: string
      turn_hashes_blob: Buffer
    }
    expect(childRow.back_tool_use_id).toBe("toolu_X")

    const parentLookup = db.prepare("SELECT entry_id FROM entry_produced_tool_ids WHERE tool_use_id = ?").get(childRow.back_tool_use_id) as { entry_id: string }
    expect(parentLookup.entry_id).toBe(parent.id)

    // Verifier: child.turnHashes[1] === parent.postResponseHash.
    const parentRow = db.prepare("SELECT turn_hashes_blob, post_response_hash FROM entry_lineage WHERE entry_id = ?").get(parent.id) as {
      turn_hashes_blob: Buffer
      post_response_hash: string
    }
    const childTurns = unpackTurnHashes(childRow.turn_hashes_blob)
    const parentTurns = unpackTurnHashes(parentRow.turn_hashes_blob)
    expect(childTurns[parentTurns.length]).toBe(parentRow.post_response_hash)
  })
})
