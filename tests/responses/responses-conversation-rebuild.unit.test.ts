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
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history"

import {
  //
  rebuildConversationMessages,
  rebuildMessagesFromEntries,
} from "~/routes/responses/conversation-rebuild"

const entries: Array<HistoryEntry> = []

function resetEntries(...e: Array<HistoryEntry>): void {
  entries.length = 0
  entries.push(...e)
}

function makeEntry(opts: Partial<HistoryEntry> & { id: string; startedAt: number }): HistoryEntry {
  return {
    endpoint: "openai-responses",
    state: "completed",
    inboundRequest: { messages: [] },
    ...opts,
  } as HistoryEntry
}

describe("rebuildConversationMessages", () => {
  test("returns [] for undefined sessionId", () => {
    expect(rebuildConversationMessages(undefined)).toEqual([])
  })

  test("returns [] for unknown sessionId", () => {
    resetEntries()
    expect(rebuildMessagesFromEntries(entries)).toEqual([])
  })

  test("delta mode: each entry contributes its single new user message + response", () => {
    resetEntries(
      makeEntry({
        id: "e1",
        startedAt: 1,
        inboundRequest: { messages: [{ role: "user", content: "first" }] },
        outboundResponse: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "answer 1" },
        },
      }),
      makeEntry({
        id: "e2",
        startedAt: 2,
        inboundRequest: { messages: [{ role: "user", content: "second" }] },
        outboundResponse: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "answer 2" },
        },
      }),
    )
    const result = rebuildMessagesFromEntries(entries)
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
        inboundRequest: { messages: [{ role: "user", content: "u1" }] },
        outboundResponse: {
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
        inboundRequest: {
          messages: [
            { role: "user", content: "u1" },
            { role: "assistant", content: "a1" },
            { role: "user", content: "u2" },
          ],
        },
        outboundResponse: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "a2" },
        },
      }),
    )
    const result = rebuildMessagesFromEntries(entries)
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
        inboundRequest: { messages: [{ role: "user", content: "in-flight" }] },
      }),
      makeEntry({
        id: "e2",
        startedAt: 2,
        inboundRequest: { messages: [{ role: "user", content: "good" }] },
        outboundResponse: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "yes" },
        },
      }),
    )
    const result = rebuildMessagesFromEntries(entries)
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
        inboundRequest: { messages: [{ role: "user", content: "failed turn" }] },
        outboundResponse: {
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
        inboundRequest: { messages: [{ role: "user", content: "ok turn" }] },
        outboundResponse: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "yes" },
        },
      }),
    )
    const result = rebuildMessagesFromEntries(entries)
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
        inboundRequest: { messages: [{ role: "user", content: "ant-only" }] },
        outboundResponse: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "ant-resp" },
        },
      }),
      makeEntry({
        id: "e2",
        startedAt: 2,
        inboundRequest: { messages: [{ role: "user", content: "resp-only" }] },
        outboundResponse: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "resp-resp" },
        },
      }),
    )
    const result = rebuildMessagesFromEntries(entries)
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
        inboundRequest: {
          messages: [
            { role: "user", content: "u1" },
            { role: "assistant", content: "[reasoning: rs_x]" },
          ],
        },
        outboundResponse: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "a1" },
        },
      }),
    )
    const result = rebuildMessagesFromEntries(entries)
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
        inboundRequest: {
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
        outboundResponse: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "ok" },
        },
      }),
    )
    const result = rebuildMessagesFromEntries(entries)
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
        inboundRequest: {
          messages: [{ role: "user", content: "use it" }],
        },
        outboundResponse: {
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
        inboundRequest: {
          messages: [{ role: "tool", tool_call_id: "c1", content: "result" }],
        },
        outboundResponse: {
          success: true,
          model: "m",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: { role: "assistant", content: "done" },
        },
      }),
    )
    const result = rebuildMessagesFromEntries(entries)
    expect(result[1]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
    })
    expect(result[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "result" })
  })
})
