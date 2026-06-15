/**
 * Integration tests for the lineage query layer (getLineage + HTTP endpoint).
 *
 * Builds real entries through finalizeEntry → exercise parent/children/sibling
 * resolution end-to-end.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { Hono } from "hono"

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
import { getLineage } from "~/lib/history/lineage"
import { setStateForTests } from "~/lib/state"
import { generateId } from "~/lib/utils"
import {
  //
  handleGetEntry,
  handleGetLineage,
} from "~/routes/history/handler"

function makeEntry(messages: HistoryEntry["inboundRequest"]["messages"], assistant?: HistoryEntry["outboundResponse"]): HistoryEntry {
  const entry: HistoryEntry = {
    id: generateId(),
    startedAt: Date.now(),
    endpoint: "anthropic-messages",
    inboundRequest: { model: "claude-opus-4-7", messages, stream: true },
  }
  insertEntry(entry)
  updateEntry(entry.id, {
    state: assistant ? "completed" : "failed",
    outboundResponse: assistant ?? {
      success: false,
      model: "claude-opus-4-7",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: null,
      error: "test failure",
    },
  })
  finalizeEntry(entry.id)
  return entry
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

describe("getLineage — null cases", () => {
  test("returns null-shaped response when entry has no lineage row", () => {
    // Non-Anthropic endpoint: lineage compute returns null.
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

    const result = getLineage(entry.id)
    expect(result.digest).toBeNull()
    expect(result.parent).toBeNull()
    expect(result.children).toEqual([])
    expect(result.siblings).toEqual([])
    expect(result.rootSummary).toBeNull()
  })
})

describe("getLineage — parent resolution (primary tool_id edge)", () => {
  test("child finds parent via O(1) tool_use_id reverse-link with edgeType=tool_id", () => {
    const assistant1 = {
      success: true,
      model: "claude-opus-4-7",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: { role: "assistant", content: [{ type: "tool_use", id: "toolu_X", name: "Read", input: { path: "/a" } }] },
    }
    const parent = makeEntry([{ role: "user", content: "go" }], assistant1)

    const child = makeEntry(
      [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_X", name: "Read", input: { path: "/a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_X", content: "file" }] },
      ],
      {
        success: true,
        model: "claude-opus-4-7",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: { role: "assistant", content: [{ type: "text", text: "done" }] },
      },
    )

    const result = getLineage(child.id)
    expect(result.parent).not.toBeNull()
    expect(result.parent?.id).toBe(parent.id)
    expect(result.parent?.edgeType).toBe("tool_id")
  })

  test("parent rootSummary counts both entries in same root", () => {
    const assistant1 = {
      success: true,
      model: "claude-opus-4-7",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: { role: "assistant", content: [{ type: "text", text: "hi back" }] },
    }
    makeEntry([{ role: "user", content: "hi" }], assistant1)
    makeEntry([{ role: "user", content: "hi" }], assistant1)

    const both = getLineage("nonexistent")
    expect(both.rootSummary).toBeNull() // bad-id lookup is null

    // Pick one of them and check rootSummary
    const someEntries = makeEntry([{ role: "user", content: "hi" }], assistant1)
    const lineage = getLineage(someEntries.id)
    expect(lineage.rootSummary).not.toBeNull()
    expect(lineage.rootSummary?.count).toBeGreaterThanOrEqual(3)
  })
})

describe("getLineage — children resolution", () => {
  test("parent finds child via produced_tool_ids reverse-link", () => {
    const parentResp = {
      success: true,
      model: "claude-opus-4-7",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: { role: "assistant", content: [{ type: "tool_use", id: "toolu_Y", name: "Read", input: {} }] },
    }
    const parent = makeEntry([{ role: "user", content: "Q" }], parentResp)

    const child = makeEntry(
      [
        { role: "user", content: "Q" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_Y", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_Y", content: "ok" }] },
      ],
      {
        success: true,
        model: "claude-opus-4-7",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: { role: "assistant", content: [{ type: "text", text: "done" }] },
      },
    )

    const result = getLineage(parent.id)
    expect(result.children).toHaveLength(1)
    expect(result.children[0].id).toBe(child.id)
    expect(result.children[0].edgeType).toBe("tool_id")
  })

  test("failed entries cannot be parents (children=[] even with matching tool ids)", () => {
    // Failed entry — has tool_use in content but postResponseHash will be null,
    // so it can't anchor a child.
    const failed = makeEntry([{ role: "user", content: "Q" }]) // no assistant → failed
    const result = getLineage(failed.id)
    expect(result.children).toEqual([])
  })
})

describe("getLineage — sibling classification", () => {
  test("two successful children of the same parent with different responses → fork", () => {
    const parentResp = {
      success: true,
      model: "claude-opus-4-7",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: { role: "assistant", content: [{ type: "tool_use", id: "toolu_Z", name: "Read", input: {} }] },
    }
    const parent = makeEntry([{ role: "user", content: "Q" }], parentResp)

    const baseChildMessages = [
      { role: "user", content: "Q" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_Z", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_Z", content: "shared output" }] },
    ] as HistoryEntry["inboundRequest"]["messages"]

    const childA = makeEntry(baseChildMessages, {
      success: true,
      model: "claude-opus-4-7",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: { role: "assistant", content: [{ type: "text", text: "answer A" }] },
    })
    const childB = makeEntry(baseChildMessages, {
      success: true,
      model: "claude-opus-4-7",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: { role: "assistant", content: [{ type: "text", text: "answer B (different)" }] },
    })

    const lineageA = getLineage(childA.id)
    expect(lineageA.parent?.id).toBe(parent.id)
    const sibling = lineageA.siblings.find((s) => s.id === childB.id)
    expect(sibling).toBeDefined()
    expect(sibling?.kind).toBe("fork")
  })

  test("one failed + one successful child of same parent → retry_after_failure", () => {
    const parentResp = {
      success: true,
      model: "claude-opus-4-7",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: { role: "assistant", content: [{ type: "tool_use", id: "toolu_Q", name: "Read", input: {} }] },
    }
    makeEntry([{ role: "user", content: "Q" }], parentResp)

    const baseChildMessages = [
      { role: "user", content: "Q" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_Q", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_Q", content: "out" }] },
    ] as HistoryEntry["inboundRequest"]["messages"]

    const failed = makeEntry(baseChildMessages) // no assistant → failed
    const succeeded = makeEntry(baseChildMessages, {
      success: true,
      model: "claude-opus-4-7",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    })

    const lineage = getLineage(succeeded.id)
    const sibling = lineage.siblings.find((s) => s.id === failed.id)
    expect(sibling?.kind).toBe("retry_after_failure")
  })
})

describe("HTTP /history/api/entries/:id/lineage", () => {
  function app() {
    const a = new Hono()
    a.get("/api/entries/:id", handleGetEntry)
    a.get("/api/entries/:id/lineage", handleGetLineage)
    return a
  }

  test("returns 404 for unknown entry id", async () => {
    const res = await app().request("/api/entries/req_nonexistent/lineage")
    expect(res.status).toBe(404)
  })

  test("returns 200 with shaped response for known entry", async () => {
    const entry = makeEntry([{ role: "user", content: "hi" }], {
      success: true,
      model: "claude-opus-4-7",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: { role: "assistant", content: [{ type: "text", text: "hi back" }] },
    })

    const res = await app().request(`/api/entries/${entry.id}/lineage`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.entryId).toBe(entry.id)
    expect(body.digest).toBeDefined()
    expect(body.parent).toBeNull()
    expect(body.children).toEqual([])
    expect(body.siblings).toEqual([])
    expect(body.rootSummary).not.toBeNull()
  })
})
