/**
 * Unit tests for {@link extractAnthropicCommittedBlocks} — the continuation-retry ledger's block
 * reconstruction (spec 2026-07-22 §4.2). Verifies the projection from committed Anthropic SSE frames to
 * the {@link CanonicalBlock} union: text content, tool_use name+input (JSON-parsed), the drop of
 * non-replayable block types (thinking / server_tool_use), and edge cases (empty tool input, ping frames).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import { extractAnthropicCommittedBlocks } from "~/lib/anthropic/committed-block-extractor"

const frame = (obj: unknown): ClientFrame => ({ event: (obj as { type: string }).type, data: JSON.stringify(obj) })

describe("extractAnthropicCommittedBlocks", () => {
  test("reconstructs a text block's full text from its deltas", () => {
    const blocks = extractAnthropicCommittedBlocks([
      frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello, " } }),
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } }),
      frame({ type: "content_block_stop", index: 0 }),
    ])
    expect(blocks).toEqual([{ type: "text", text: "Hello, world" }])
  })

  test("reconstructs a tool_use block with name + JSON-parsed input", () => {
    const blocks = extractAnthropicCommittedBlocks([
      frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Write", input: {} } }),
      frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts",' } }),
      frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"content":"x"}' } }),
      frame({ type: "content_block_stop", index: 0 }),
    ])
    expect(blocks).toEqual([{ type: "tool_use", id: "toolu_1", name: "Write", input: { path: "a.ts", content: "x" } }])
  })

  test("empty tool_use input (no deltas) canonicalizes to {}", () => {
    const blocks = extractAnthropicCommittedBlocks([
      frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_2", name: "Noop", input: {} } }),
      frame({ type: "content_block_stop", index: 0 }),
    ])
    expect(blocks).toEqual([{ type: "tool_use", id: "toolu_2", name: "Noop", input: {} }])
  })

  test("drops non-replayable block types (thinking / server_tool_use) — keeps only text + tool_use", () => {
    const blocks = extractAnthropicCommittedBlocks([
      frame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning..." } }),
      frame({ type: "content_block_stop", index: 0 }),
      frame({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      frame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } }),
      frame({ type: "content_block_stop", index: 1 }),
    ])
    expect(blocks).toEqual([{ type: "text", text: "answer" }])
  })

  test("ignores message_start / message_delta / ping / non-JSON frames", () => {
    const blocks = extractAnthropicCommittedBlocks([
      frame({ type: "message_start", message: { id: "m", model: "claude", usage: { input_tokens: 1, output_tokens: 0 } } }),
      { event: "ping", data: '{"type":"ping"}' },
      { event: "done", data: "[DONE]" },
      frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
      frame({ type: "content_block_stop", index: 0 }),
      frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
    ])
    expect(blocks).toEqual([{ type: "text", text: "hi" }])
  })

  test("empty frame list → no blocks", () => {
    expect(extractAnthropicCommittedBlocks([])).toEqual([])
  })
})
