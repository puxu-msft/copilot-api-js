import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import type { MessageContent } from "@/lib/content/types"

import { normalizeToContentBlocks } from "@/lib/content/normalize"

describe("normalizeToContentBlocks (dual-format)", () => {
  it("Anthropic: content array passes through", () => {
    const msg = { role: "assistant", content: [{ type: "text", text: "hi" }] } as MessageContent
    expect(normalizeToContentBlocks(msg)).toEqual([{ type: "text", text: "hi" }])
  })
  it("OpenAI string content → text block", () => {
    const msg = { role: "user", content: "hello" } as MessageContent
    expect(normalizeToContentBlocks(msg)).toEqual([{ type: "text", text: "hello" }])
  })
  it("OpenAI tool_calls → virtual tool_use blocks (parse arguments)", () => {
    const msg = {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", function: { name: "Edit", arguments: '{"path":"a"}' } }],
    } as unknown as MessageContent
    expect(normalizeToContentBlocks(msg)).toEqual([{ type: "tool_use", id: "c1", name: "Edit", input: { path: "a" } }])
  })
  it("OpenAI tool_calls with bad arguments → _raw fallback", () => {
    const msg = { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "Edit", arguments: "not json" } }] } as unknown as MessageContent
    expect(normalizeToContentBlocks(msg)[0]).toMatchObject({ type: "tool_use", input: { _raw: "not json" } })
  })
  it("OpenAI tool response (role tool) → tool_result block", () => {
    const msg = { role: "tool", tool_call_id: "c1", content: "result" } as MessageContent
    expect(normalizeToContentBlocks(msg)).toEqual([{ type: "tool_result", tool_use_id: "c1", content: "result" }])
  })
  it("empty string content → no blocks", () => {
    expect(normalizeToContentBlocks({ role: "user", content: "" } as MessageContent)).toEqual([])
  })
})
