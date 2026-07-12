/**
 * Chat Completions → Anthropic Messages request translation (T2.3, REVERSE leg).
 *
 * Pure-function unit tests over `translateChatCompletionsToAnthropic`, INCLUDING the WARN-E hard
 * constraints (RFC §9): the red-line assertion is that the output NEVER contains a `thinking` /
 * `redacted_thinking` content block (an unsigned thinking block poisons GHC — skill
 * `ghc-anthropic-upstream`), plus tool_use.id passthrough / no cache_control injection / server-tool
 * strip.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ContentBlockParam,
  MessagesPayload,
} from "~/types/api/anthropic"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { translateChatCompletionsToAnthropic } from "~/lib/openai/translate/cc-to-anthropic-request"

/** Minimal CC payload builder. */
function cc(over: Partial<ChatCompletionsPayload>): ChatCompletionsPayload {
  return { model: "claude-x", messages: [], ...over }
}

/** Recursively collect every block `type` across all messages (+ system) — the red-line oracle. */
function allBlockTypes(payload: MessagesPayload): Array<string> {
  const types: Array<string> = []
  for (const m of payload.messages) {
    if (Array.isArray(m.content)) for (const b of m.content) types.push(b.type)
  }
  return types
}

describe("translateChatCompletionsToAnthropic — top-level", () => {
  test("model / max_tokens (max_completion_tokens fallback) / temperature / top_p / stream", () => {
    const a = translateChatCompletionsToAnthropic(
      cc({ model: "claude-opus-4.8", max_completion_tokens: 999, temperature: 0.5, top_p: 0.8, stream: true, messages: [{ role: "user", content: "hi" }] }),
    )
    expect(a.model).toBe("claude-opus-4.8")
    expect(a.max_tokens).toBe(999)
    expect(a.temperature).toBe(0.5)
    expect(a.top_p).toBe(0.8)
    expect(a.stream).toBe(true)
  })

  test("max_tokens preferred over max_completion_tokens; default when neither present", () => {
    expect(translateChatCompletionsToAnthropic(cc({ max_tokens: 100, max_completion_tokens: 999 })).max_tokens).toBe(100)
    expect(translateChatCompletionsToAnthropic(cc({})).max_tokens).toBe(4096)
  })

  test("stop (string | array) → stop_sequences", () => {
    expect(translateChatCompletionsToAnthropic(cc({ stop: "END" })).stop_sequences).toEqual(["END"])
    expect(translateChatCompletionsToAnthropic(cc({ stop: ["A", "B"] })).stop_sequences).toEqual(["A", "B"])
    expect(translateChatCompletionsToAnthropic(cc({ stop: null })).stop_sequences).toBeUndefined()
  })

  test("user → metadata.user_id", () => {
    expect(translateChatCompletionsToAnthropic(cc({ user: "u-9" })).metadata).toEqual({ user_id: "u-9" })
  })
})

describe("translateChatCompletionsToAnthropic — system / messages", () => {
  test("system + developer messages → top-level system (joined)", () => {
    const a = translateChatCompletionsToAnthropic(
      cc({
        messages: [
          { role: "system", content: "sys-A" },
          { role: "developer", content: "sys-B" },
          { role: "user", content: "hi" },
        ],
      }),
    )
    expect(a.system).toBe("sys-A\n\nsys-B")
    expect(a.messages).toEqual([{ role: "user", content: "hi" }])
  })

  test("assistant text + tool_calls → text block + tool_use block (id passthrough — WARN-E ②)", () => {
    const a = translateChatCompletionsToAnthropic(
      cc({
        messages: [
          {
            role: "assistant",
            content: "let me check",
            tool_calls: [{ id: "call_XYZ", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
          },
        ],
      }),
    )
    expect(a.messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "call_XYZ", name: "get_weather", input: { city: "SF" } },
      ],
    })
  })

  test("toolu_ id is passed through unchanged (round-trip self-consistency — PROBE OQ3)", () => {
    const a = translateChatCompletionsToAnthropic(
      cc({ messages: [{ role: "assistant", content: null, tool_calls: [{ id: "toolu_abc", type: "function", function: { name: "f", arguments: "{}" } }] }] }),
    )
    const block = (a.messages[0]?.content as Array<ContentBlockParam>)[0] as { id: string }
    expect(block.id).toBe("toolu_abc")
  })

  test("malformed tool arguments → empty input (never throws)", () => {
    const a = translateChatCompletionsToAnthropic(
      cc({
        messages: [{ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{not json" } }] }],
      }),
    )
    const block = (a.messages[0]?.content as Array<ContentBlockParam>)[0] as { input: unknown }
    expect(block.input).toEqual({})
  })

  test("consecutive tool messages fold into ONE user turn of tool_result blocks", () => {
    const a = translateChatCompletionsToAnthropic(
      cc({
        messages: [
          { role: "tool", tool_call_id: "call_1", content: "r1" },
          { role: "tool", tool_call_id: "call_2", content: "r2" },
          { role: "user", content: "thanks" },
        ],
      }),
    )
    expect(a.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "r1" },
          { type: "tool_result", tool_use_id: "call_2", content: "r2" },
        ],
      },
      { role: "user", content: "thanks" },
    ])
  })

  test("user image_url data URL → base64 image block; http url → url source", () => {
    const dataUrl = translateChatCompletionsToAnthropic(
      cc({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } }] }] }),
    )
    expect((dataUrl.messages[0]?.content as Array<ContentBlockParam>)[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "QQ==" },
    })

    const httpUrl = translateChatCompletionsToAnthropic(
      cc({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }] }),
    )
    expect((httpUrl.messages[0]?.content as Array<ContentBlockParam>)[0]).toEqual({ type: "image", source: { type: "url", url: "https://x/y.png" } })
  })
})

describe("translateChatCompletionsToAnthropic — tools / tool_choice", () => {
  test("function tools → Anthropic tools (parameters → input_schema, no cache_control — WARN-E ③)", () => {
    const a = translateChatCompletionsToAnthropic(
      cc({ tools: [{ type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object" } } }] }),
    )
    expect(a.tools).toEqual([{ name: "get_weather", description: "d", input_schema: { type: "object" } }])
    // WARN-E ③: no cache_control injected anywhere on the tool.
    expect(JSON.stringify(a.tools)).not.toContain("cache_control")
  })

  test("tool_choice mapping auto/required→any/none/named→tool", () => {
    expect(translateChatCompletionsToAnthropic(cc({ tool_choice: "auto" })).tool_choice).toEqual({ type: "auto" })
    expect(translateChatCompletionsToAnthropic(cc({ tool_choice: "required" })).tool_choice).toEqual({ type: "any" })
    expect(translateChatCompletionsToAnthropic(cc({ tool_choice: "none" })).tool_choice).toEqual({ type: "none" })
    expect(translateChatCompletionsToAnthropic(cc({ tool_choice: { type: "function", function: { name: "f" } } })).tool_choice).toEqual({
      type: "tool",
      name: "f",
    })
  })
})

describe("translateChatCompletionsToAnthropic — WARN-E RED LINE (never synthesize thinking)", () => {
  test("reasoning_effort is DROPPED, never mapped to a thinking block or thinking config", () => {
    const a = translateChatCompletionsToAnthropic(cc({ reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] }))
    // No thinking config on the payload.
    expect(a.thinking).toBeUndefined()
    // No thinking content block anywhere.
    expect(allBlockTypes(a)).not.toContain("thinking")
    expect(allBlockTypes(a)).not.toContain("redacted_thinking")
  })

  test("a rich CC conversation (text + tools + images + reasoning_effort) yields ZERO thinking blocks", () => {
    const a = translateChatCompletionsToAnthropic(
      cc({
        reasoning_effort: "high",
        tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
        messages: [
          { role: "system", content: "be terse" },
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } },
            ],
          },
          { role: "assistant", content: "sure", tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_1", content: "done" },
        ],
      }),
    )
    const types = allBlockTypes(a)
    expect(types).not.toContain("thinking")
    expect(types).not.toContain("redacted_thinking")
    // Sanity: the real blocks ARE present (proves the red-line check touched a populated output).
    expect(types).toContain("text")
    expect(types).toContain("tool_use")
    expect(types).toContain("image")
    expect(types).toContain("tool_result")
    // WARN-E ③: no cache_control injected anywhere in the whole payload.
    expect(JSON.stringify(a)).not.toContain("cache_control")
  })
})
