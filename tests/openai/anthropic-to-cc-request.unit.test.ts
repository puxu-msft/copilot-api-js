/**
 * Anthropic Messages → Chat Completions request translation (T2.2, FORWARD leg).
 *
 * Pure-function unit tests over `translateAnthropicToChatCompletions` (spec §6 mapping table + the
 * multi-choices request-side fold, PROBE-FINDINGS). No runtime/state — the translator is a pure
 * body→body transform, so plain `bun:test` with inline payloads suffices.
 */

import {
  //
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import type { Model } from "~/lib/models/client"
import type { MessagesPayload } from "~/types/api/anthropic"

import { translateAnthropicToChatCompletions } from "~/lib/openai/translate/anthropic-to-cc-request"

/** Minimal payload builder (max_tokens + messages are required). */
function payload(over: Partial<MessagesPayload>): MessagesPayload {
  return { model: "claude-x", max_tokens: 1024, messages: [], ...over }
}

/** A model advertising a reasoning_effort whitelist (gates the thinking→effort map). */
function reasoningModel(): Model {
  return { id: "m", capabilities: { supports: { reasoning_effort: ["low", "medium", "high"] } } } as unknown as Model
}
/** A model with NO reasoning_effort capability. */
function plainModel(): Model {
  return { id: "m", capabilities: { supports: {} } } as unknown as Model
}

describe("translateAnthropicToChatCompletions — top-level fields", () => {
  test("carries model / max_tokens / temperature / top_p / stream", () => {
    const cc = translateAnthropicToChatCompletions(
      payload({ model: "claude-opus-4.8", max_tokens: 512, temperature: 0.7, top_p: 0.9, stream: true, messages: [{ role: "user", content: "hi" }] }),
    )
    expect(cc.model).toBe("claude-opus-4.8")
    expect(cc.max_tokens).toBe(512)
    expect(cc.temperature).toBe(0.7)
    expect(cc.top_p).toBe(0.9)
    expect(cc.stream).toBe(true)
  })

  test("stop_sequences → stop (array preserved); empty array dropped", () => {
    expect(translateAnthropicToChatCompletions(payload({ stop_sequences: ["END", "STOP"] })).stop).toEqual(["END", "STOP"])
    expect(translateAnthropicToChatCompletions(payload({ stop_sequences: [] })).stop).toBeUndefined()
  })

  test("top_k dropped (no CC equivalent)", () => {
    const cc = translateAnthropicToChatCompletions(payload({ top_k: 40 }))
    expect("top_k" in cc).toBe(false)
  })

  test("metadata.user_id → user", () => {
    expect(translateAnthropicToChatCompletions(payload({ metadata: { user_id: "u-1" } })).user).toBe("u-1")
  })
})

describe("translateAnthropicToChatCompletions — system prompt", () => {
  test("string system → leading system message", () => {
    const cc = translateAnthropicToChatCompletions(payload({ system: "You are helpful.", messages: [{ role: "user", content: "hi" }] }))
    expect(cc.messages[0]).toEqual({ role: "system", content: "You are helpful." })
    expect(cc.messages[1]).toEqual({ role: "user", content: "hi" })
  })

  test("block[] system → concatenated text, cache_control stripped", () => {
    const cc = translateAnthropicToChatCompletions(
      payload({
        system: [
          { type: "text", text: "A" },
          { type: "text", text: "B", cache_control: { type: "ephemeral" } },
        ],
      }),
    )
    expect(cc.messages[0]).toEqual({ role: "system", content: "AB" })
  })

  test("absent / empty system → no system message", () => {
    expect(translateAnthropicToChatCompletions(payload({ messages: [{ role: "user", content: "hi" }] })).messages[0]?.role).toBe("user")
  })
})

describe("translateAnthropicToChatCompletions — content blocks", () => {
  test("user text blocks fold to a string", () => {
    const cc = translateAnthropicToChatCompletions(
      payload({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "part1 " },
              { type: "text", text: "part2" },
            ],
          },
        ],
      }),
    )
    expect(cc.messages[0]).toEqual({ role: "user", content: "part1 part2" })
  })

  test("image block base64 → data-URL image_url part", () => {
    const cc = translateAnthropicToChatCompletions(
      payload({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look:" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            ],
          },
        ],
      }),
    )
    expect(cc.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look:" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    })
  })

  test("image block url source → url image_url part", () => {
    const cc = translateAnthropicToChatCompletions(
      payload({ messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }] }] }),
    )
    expect(cc.messages[0]).toEqual({ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] })
  })

  test("assistant text + tool_use fold into ONE message (content + tool_calls coexist — multi-choices fold)", () => {
    const cc = translateAnthropicToChatCompletions(
      payload({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me check." },
              { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } },
            ],
          },
        ],
      }),
    )
    expect(cc.messages).toHaveLength(1)
    expect(cc.messages[0]).toEqual({
      role: "assistant",
      content: "Let me check.",
      tool_calls: [{ id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
    })
  })

  test("tool-only assistant turn → content:null + tool_calls (toolu_ id preserved — PROBE OQ3)", () => {
    const cc = translateAnthropicToChatCompletions(
      payload({ messages: [{ role: "assistant", content: [{ type: "tool_use", id: "toolu_abc", name: "f", input: {} }] }] }),
    )
    expect(cc.messages[0]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "toolu_abc", type: "function", function: { name: "f", arguments: "{}" } }],
    })
  })

  test("assistant thinking / redacted_thinking blocks dropped (forward direction)", () => {
    const cc = translateAnthropicToChatCompletions(
      payload({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "secret reasoning", signature: "sig" },
              { type: "text", text: "answer" },
            ],
          },
        ],
      }),
    )
    expect(cc.messages[0]).toEqual({ role: "assistant", content: "answer" })
  })

  test("multiple tool_result blocks → multiple role:tool messages, then folded user text", () => {
    const cc = translateAnthropicToChatCompletions(
      payload({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "result-1" },
              { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "result-2" }] },
              { type: "text", text: "thanks" },
            ],
          },
        ],
      }),
    )
    expect(cc.messages).toEqual([
      { role: "tool", tool_call_id: "toolu_1", content: "result-1" },
      { role: "tool", tool_call_id: "toolu_2", content: "result-2" },
      { role: "user", content: "thanks" },
    ])
  })

  test("tool_result is_error → error-prefixed content", () => {
    const cc = translateAnthropicToChatCompletions(
      payload({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "boom", is_error: true }] }] }),
    )
    expect(cc.messages[0]).toEqual({ role: "tool", tool_call_id: "toolu_1", content: "[tool_error] boom" })
  })

  test("string message content → passthrough", () => {
    const cc = translateAnthropicToChatCompletions(payload({ messages: [{ role: "assistant", content: "plain" }] }))
    expect(cc.messages[0]).toEqual({ role: "assistant", content: "plain" })
  })
})

describe("translateAnthropicToChatCompletions — tools / tool_choice", () => {
  test("tools → CC function tools (input_schema → parameters, cache_control not copied)", () => {
    const cc = translateAnthropicToChatCompletions(
      payload({
        tools: [
          {
            name: "get_weather",
            description: "gets weather",
            input_schema: { type: "object", properties: { city: { type: "string" } } },
            cache_control: { type: "ephemeral" },
          },
        ],
      }),
    )
    expect(cc.tools).toEqual([
      {
        type: "function",
        function: { name: "get_weather", description: "gets weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
      },
    ])
  })

  test("native server tools stripped", () => {
    const cc = translateAnthropicToChatCompletions(
      payload({
        tools: [
          { name: "web_search", type: "web_search_20250305" },
          { name: "my_fn", input_schema: { type: "object" } },
        ],
      }),
    )
    expect(cc.tools).toEqual([{ type: "function", function: { name: "my_fn", parameters: { type: "object" } } }])
  })

  test("native server tool drop warning is tagged with requestId when opts.reqId is set", () => {
    const warnSpy = spyOn(consola, "warn").mockImplementation((() => undefined) as unknown as typeof consola.warn)
    try {
      translateAnthropicToChatCompletions(payload({ tools: [{ name: "web_search", type: "web_search_20250305" }] }), { reqId: "req_test_42" })
      const dropLine = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes("dropping native server tool"))
      expect(dropLine).toBeDefined()
      expect(dropLine).toContain("requestId=req_test_42")
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("drop warning omits requestId when opts.reqId is absent", () => {
    const warnSpy = spyOn(consola, "warn").mockImplementation((() => undefined) as unknown as typeof consola.warn)
    try {
      translateAnthropicToChatCompletions(payload({ tools: [{ name: "web_search", type: "web_search_20250305" }] }))
      const dropLine = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes("dropping native server tool"))
      expect(dropLine).toBeDefined()
      expect(dropLine).not.toContain("requestId=")
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("tool_choice mapping: auto/any→required/none/tool→function", () => {
    expect(translateAnthropicToChatCompletions(payload({ tool_choice: { type: "auto" } })).tool_choice).toBe("auto")
    expect(translateAnthropicToChatCompletions(payload({ tool_choice: { type: "any" } })).tool_choice).toBe("required")
    expect(translateAnthropicToChatCompletions(payload({ tool_choice: { type: "none" } })).tool_choice).toBe("none")
    expect(translateAnthropicToChatCompletions(payload({ tool_choice: { type: "tool", name: "f" } })).tool_choice).toEqual({
      type: "function",
      function: { name: "f" },
    })
  })
})

describe("translateAnthropicToChatCompletions — thinking → reasoning_effort (OQ2)", () => {
  test("enabled budget → tier via heuristic (model supports reasoning_effort)", () => {
    expect(
      translateAnthropicToChatCompletions(payload({ thinking: { type: "enabled", budget_tokens: 4000 } }), { model: reasoningModel() }).reasoning_effort,
    ).toBe("low")
    expect(
      translateAnthropicToChatCompletions(payload({ thinking: { type: "enabled", budget_tokens: 20000 } }), { model: reasoningModel() }).reasoning_effort,
    ).toBe("medium")
    expect(
      translateAnthropicToChatCompletions(payload({ thinking: { type: "enabled", budget_tokens: 60000 } }), { model: reasoningModel() }).reasoning_effort,
    ).toBe("high")
  })

  test("adaptive thinking uses output_config.effort", () => {
    const cc = translateAnthropicToChatCompletions(payload({ thinking: { type: "adaptive" }, output_config: { effort: "high" } }), { model: reasoningModel() })
    expect(cc.reasoning_effort).toBe("high")
  })

  test("disabled / absent thinking → no reasoning_effort", () => {
    expect(translateAnthropicToChatCompletions(payload({ thinking: { type: "disabled" } }), { model: reasoningModel() }).reasoning_effort).toBeUndefined()
    expect(translateAnthropicToChatCompletions(payload({}), { model: reasoningModel() }).reasoning_effort).toBeUndefined()
  })

  test("model WITHOUT reasoning_effort capability → thinking dropped (not mapped)", () => {
    expect(
      translateAnthropicToChatCompletions(payload({ thinking: { type: "enabled", budget_tokens: 20000 } }), { model: plainModel() }).reasoning_effort,
    ).toBeUndefined()
  })

  test("no model supplied → best-effort map (no capability gate)", () => {
    expect(translateAnthropicToChatCompletions(payload({ thinking: { type: "enabled", budget_tokens: 20000 } })).reasoning_effort).toBe("medium")
  })
})
