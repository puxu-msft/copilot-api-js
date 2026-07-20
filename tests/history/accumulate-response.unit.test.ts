import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { SseEventRecord } from "~/lib/history/types"

import { accumulateForwardedContent } from "~/lib/history/accumulate-response"

function frames(...raws: Array<string>): Array<SseEventRecord> {
  return raws.map((raw) => ({ raw }) as SseEventRecord)
}

describe("accumulateForwardedContent", () => {
  test("anthropic tool_use + text (existing behavior preserved)", () => {
    const msg = accumulateForwardedContent(
      frames(
        JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
        JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
        JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "AskUserQuestion" } }),
      ),
      "anthropic-messages",
    )
    const blocks = msg?.content as Array<{ type: string; name?: string }>
    expect(blocks.map((b) => b.type)).toEqual(["text", "tool_use"])
    expect(blocks[1].name).toBe("AskUserQuestion")
  })

  test("openai-responses function_call → tool_use block (NEW)", () => {
    const msg = accumulateForwardedContent(
      frames(
        JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc1", call_id: "c1", name: "Bash" } }),
        JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"cmd":' }),
        JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: '"ls"}' }),
        JSON.stringify({ type: "response.output_text.delta", delta: "done" }),
      ),
      "openai-responses",
    )
    const blocks = msg?.content as Array<{ type: string; name?: string; input?: unknown }>
    const tool = blocks.find((b) => b.type === "tool_use")
    expect(tool?.name).toBe("Bash")
    expect(tool?.input).toEqual({ cmd: "ls" })
  })

  test("gemini functionCall part → tool_use block (NEW)", () => {
    const msg = accumulateForwardedContent(
      frames(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "Read", args: { path: "/x" } } }] } }] })),
      "gemini-generate-content",
    )
    const blocks = msg?.content as Array<{ type: string; name?: string; input?: unknown }>
    const tool = blocks.find((b) => b.type === "tool_use")
    expect(tool?.name).toBe("Read")
    expect(tool?.input).toEqual({ path: "/x" })
  })

  test("openai-chat-completions text + tool_calls accumulate across frames", () => {
    const msg = accumulateForwardedContent(
      frames(
        JSON.stringify({ choices: [{ delta: { content: "hel" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Bash", arguments: '{"cmd":' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] }),
      ),
      "openai-chat-completions",
    )
    expect(msg?.role).toBe("assistant")
    expect(msg?.content).toBe("hello")
    const toolCalls = (msg as { tool_calls?: Array<{ function: { name: string; arguments: string } }> }).tool_calls
    expect(toolCalls?.[0].function.name).toBe("Bash")
    expect(toolCalls?.[0].function.arguments).toBe('{"cmd":"ls"}')
  })

  test("anthropic malformed tool_use input kept as { _raw } (not silently dropped)", () => {
    const msg = accumulateForwardedContent(
      frames(
        JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Bash" } }),
        JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":' } }),
      ),
      "anthropic-messages",
    )
    const blocks = msg?.content as Array<{ type: string; input?: unknown }>
    const tool = blocks.find((b) => b.type === "tool_use")
    expect(tool?.input).toEqual({ _raw: '{"a":' })
  })
})
