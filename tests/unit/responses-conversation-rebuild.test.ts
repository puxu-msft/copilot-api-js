/**
 * Tests for src/routes/responses/conversation-rebuild.ts
 *
 * Verifies that prior conversation reconstruction (used by the /v1/responses
 * fallback path) correctly handles:
 *   - missing / unknown sessionId
 *   - delta clients (each entry carries only the new turn)
 *   - full-history clients (each entry echoes prior turns)
 *   - filtering of incomplete / failed / non-Responses entries
 *   - replay cap by recency
 *   - marker placeholder skipping (reasoning / item_reference)
 *   - Anthropic-shaped image → CC image_url conversion
 */

import {
  //
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history"

const entries: Array<HistoryEntry> = []

// Spread the real module so other tests imported later still see the full
// surface (shutdownHistory, getStats, etc.) — only override the function we
// actually need to stub.
const realHistory = await import("~/lib/history")
mock.module("~/lib/history", () => ({
  ...realHistory,
  getSessionEntries: (sessionId: string, _opts?: unknown) => {
    if (sessionId !== "S1") return { entries: [], total: 0, nextCursor: null, prevCursor: null }
    return { entries, total: entries.length, nextCursor: null, prevCursor: null }
  },
}))

// Import AFTER mock.module (Bun auto-hoists mock.module above imports).
const { rebuildConversationMessages } = await import("~/routes/responses/conversation-rebuild")

function resetEntries(...e: Array<HistoryEntry>): void {
  entries.length = 0
  entries.push(...e)
}

function makeEntry(opts: Partial<HistoryEntry> & { id: string; startedAt: number }): HistoryEntry {
  return {
    endpoint: "openai-responses",
    state: "completed",
    request: { messages: [] },
    ...opts,
  } as HistoryEntry
}

describe("rebuildConversationMessages", () => {
  test("returns [] for undefined sessionId", () => {
    expect(rebuildConversationMessages(undefined)).toEqual([])
  })

  test("returns [] for unknown sessionId", () => {
    resetEntries()
    expect(rebuildConversationMessages("does-not-exist")).toEqual([])
  })

  test("delta mode: each entry contributes its single new user message + response", () => {
    resetEntries(
      makeEntry({
        id: "e1",
        startedAt: 1,
        request: { messages: [{ role: "user", content: "first" }] },
        response: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "answer 1" },
        },
      }),
      makeEntry({
        id: "e2",
        startedAt: 2,
        request: { messages: [{ role: "user", content: "second" }] },
        response: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "answer 2" },
        },
      }),
    )
    const result = rebuildConversationMessages("S1")
    expect(result).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer 1" },
      { role: "user", content: "second" },
      { role: "assistant", content: "answer 2" },
    ])
  })

  test("full-history mode: only the trailing non-assistant suffix is extracted per entry", () => {
    resetEntries(
      makeEntry({
        id: "e1",
        startedAt: 1,
        request: { messages: [{ role: "user", content: "u1" }] },
        response: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "a1" },
        },
      }),
      makeEntry({
        id: "e2",
        startedAt: 2,
        // Client echoed full history; extractTurnIncrement should yield only ["u2"].
        request: {
          messages: [
            { role: "user", content: "u1" },
            { role: "assistant", content: "a1" },
            { role: "user", content: "u2" },
          ],
        },
        response: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "a2" },
        },
      }),
    )
    const result = rebuildConversationMessages("S1")
    expect(result).toEqual([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ])
  })

  test("skips entries with state !== 'completed'", () => {
    resetEntries(
      makeEntry({
        id: "e1",
        startedAt: 1,
        state: "executing",
        request: { messages: [{ role: "user", content: "in-flight" }] },
      }),
      makeEntry({
        id: "e2",
        startedAt: 2,
        request: { messages: [{ role: "user", content: "good" }] },
        response: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "yes" },
        },
      }),
    )
    const result = rebuildConversationMessages("S1")
    expect(result).toEqual([
      { role: "user", content: "good" },
      { role: "assistant", content: "yes" },
    ])
  })

  test("skips entries whose response.success === false", () => {
    resetEntries(
      makeEntry({
        id: "e1",
        startedAt: 1,
        request: { messages: [{ role: "user", content: "failed turn" }] },
        response: {
          success: false,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: null,
          error: "boom",
        },
      }),
      makeEntry({
        id: "e2",
        startedAt: 2,
        request: { messages: [{ role: "user", content: "ok turn" }] },
        response: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "yes" },
        },
      }),
    )
    const result = rebuildConversationMessages("S1")
    expect(result).toEqual([
      { role: "user", content: "ok turn" },
      { role: "assistant", content: "yes" },
    ])
  })

  test("filters out non-Responses endpoint entries", () => {
    resetEntries(
      makeEntry({
        id: "e1",
        startedAt: 1,
        endpoint: "anthropic-messages",
        request: { messages: [{ role: "user", content: "ant-only" }] },
        response: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "ant-resp" },
        },
      }),
      makeEntry({
        id: "e2",
        startedAt: 2,
        request: { messages: [{ role: "user", content: "resp-only" }] },
        response: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "resp-resp" },
        },
      }),
    )
    const result = rebuildConversationMessages("S1")
    expect(result).toEqual([
      { role: "user", content: "resp-only" },
      { role: "assistant", content: "resp-resp" },
    ])
  })

  test("skips marker placeholders that responsesInputToMessages stores for reasoning items", () => {
    resetEntries(
      makeEntry({
        id: "e1",
        startedAt: 1,
        request: {
          messages: [
            { role: "user", content: "u1" },
            { role: "assistant", content: "[reasoning: rs_x]" },
          ],
        },
        response: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "a1" },
        },
      }),
    )
    const result = rebuildConversationMessages("S1")
    // [reasoning: rs_x] should NOT terminate the walk-back. extractTurnIncrement
    // continues past the marker and lands on the user message.
    expect(result).toEqual([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ])
  })

  test("converts Anthropic-shaped image blocks to CC image_url parts", () => {
    resetEntries(
      makeEntry({
        id: "e1",
        startedAt: 1,
        request: {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "look" },
                { type: "image", source: { type: "url", url: "https://x/y.png" } },
              ],
            },
          ],
        },
        response: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "ok" },
        },
      }),
    )
    const result = rebuildConversationMessages("S1")
    expect(result[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "https://x/y.png" } },
      ],
    })
  })

  test("preserves tool_calls and tool_call_id verbatim", () => {
    resetEntries(
      makeEntry({
        id: "e1",
        startedAt: 1,
        request: {
          messages: [{ role: "user", content: "use it" }],
        },
        response: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
          },
        },
      }),
      makeEntry({
        id: "e2",
        startedAt: 2,
        request: {
          messages: [{ role: "tool", tool_call_id: "c1", content: "result" }],
        },
        response: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "done" },
        },
      }),
    )
    const result = rebuildConversationMessages("S1")
    expect(result[1]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
    })
    expect(result[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "result" })
  })
})
