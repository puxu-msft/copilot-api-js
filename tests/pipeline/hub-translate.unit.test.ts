/**
 * Hub-and-spoke shared translation layer — request dispatch (T2.1, RFC §4.2).
 *
 * Verifies `translateRequestVia` routes each (sourceFormat × targetEndpoint) cell to the correct
 * translator (asserting the OUTPUT SHAPE, not re-testing the translators' internals — those have
 * their own suites), that the NON-STREAMING response dispatch `renderResponseNonStreamingVia` routes
 * both directions (T3.3), and that the STREAMING response-side skeleton throws (streaming translation
 * legs are end-to-end fail-fast until Phase 4).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  Message as AnthropicResponse,
  MessagesPayload,
} from "~/types/api/anthropic"
import type {
  //
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/types/api/openai-chat-completions"
import type { ResponsesPayload } from "~/types/api/openai-responses"

import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  createForwardStreamTranslator,
  createReverseStreamTranslator,
  renderResponseNonStreamingVia,
  translateRequestVia,
} from "~/lib/pipeline/hub-translate"

const anthropicBody: MessagesPayload = {
  model: "claude-x",
  max_tokens: 100,
  system: "sys",
  messages: [{ role: "user", content: "hi" }],
}
const ccBody: ChatCompletionsPayload = {
  model: "gpt-x",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ],
}
const responsesBody = { model: "gpt-x", instructions: "sys", input: "hi" } as unknown as ResponsesPayload

describe("translateRequestVia — forward legs (→ CC-canonical)", () => {
  test("anthropic → /chat/completions produces a CC body (system message + user)", () => {
    const out = translateRequestVia("anthropic", ENDPOINT.CHAT_COMPLETIONS, anthropicBody) as ChatCompletionsPayload
    expect(out.model).toBe("claude-x")
    expect(out.messages[0]).toEqual({ role: "system", content: "sys" })
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" })
  })

  test("anthropic → /responses produces a Responses body DIRECTLY (RFC 2026-07-14 direct bridge — no CC hop)", () => {
    const out = translateRequestVia("anthropic", ENDPOINT.RESPONSES, anthropicBody) as {
      model: string
      instructions?: string
      input?: unknown
      messages?: unknown
    }
    // Responses-shaped directly at translateOut — no CC intermediate (has `input`, not `messages`).
    expect(Array.isArray(out.input)).toBe(true)
    expect(out.messages).toBeUndefined()
    expect(out.instructions).toBe("sys")
  })

  test("openai-cc / gemini → CC leg is identity (already CC)", () => {
    expect(translateRequestVia("openai-cc", ENDPOINT.CHAT_COMPLETIONS, ccBody)).toBe(ccBody)
    expect(translateRequestVia("gemini", ENDPOINT.CHAT_COMPLETIONS, ccBody)).toBe(ccBody)
  })

  test("openai-responses → CC leg translates Responses → CC", () => {
    const out = translateRequestVia("openai-responses", ENDPOINT.CHAT_COMPLETIONS, responsesBody) as ChatCompletionsPayload
    expect(Array.isArray(out.messages)).toBe(true)
    // instructions → system message
    expect(out.messages[0]).toEqual({ role: "system", content: "sys" })
  })
})

describe("translateRequestVia — reverse legs (→ /v1/messages)", () => {
  test("openai-cc → /v1/messages produces an Anthropic body (system extracted, user message)", () => {
    const out = translateRequestVia("openai-cc", ENDPOINT.MESSAGES, ccBody) as MessagesPayload
    expect(out.system).toBe("sys")
    expect(out.messages).toEqual([{ role: "user", content: "hi" }])
  })

  test("gemini → /v1/messages shares the cc→anthropic translator (no gemini-held anthropic sub-codec)", () => {
    const out = translateRequestVia("gemini", ENDPOINT.MESSAGES, ccBody) as MessagesPayload
    expect(out.system).toBe("sys")
    expect(out.messages).toEqual([{ role: "user", content: "hi" }])
  })

  test("openai-responses → /v1/messages DIRECT single-hop Responses → Anthropic (RFC 2026-07-14 subtask D)", () => {
    const out = translateRequestVia("openai-responses", ENDPOINT.MESSAGES, responsesBody) as MessagesPayload
    expect(out.system).toBe("sys")
    expect(out.messages).toEqual([{ role: "user", content: "hi" }])
  })

  test("anthropic → /v1/messages is defensive identity (the direct path never routes here)", () => {
    expect(translateRequestVia("anthropic", ENDPOINT.MESSAGES, anthropicBody)).toBe(anthropicBody)
  })
})

describe("renderResponseNonStreamingVia — non-streaming response dispatch (T3.3)", () => {
  const ccUpstream: ChatCompletionResponse = {
    id: "msg_x",
    object: "chat.completion",
    created: 0,
    model: "claude-x",
    choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content: "hi" } }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  }
  const anthropicUpstream = {
    id: "msg_y",
    type: "message",
    role: "assistant",
    model: "claude-x",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 1 },
  } as unknown as AnthropicResponse

  test("FORWARD /chat/completions leg: CC upstream → Anthropic response", () => {
    const { rendered, contentFiltered } = renderResponseNonStreamingVia(ENDPOINT.CHAT_COMPLETIONS, ccUpstream)
    expect((rendered as { type: string }).type).toBe("message")
    expect((rendered as { content: unknown }).content).toEqual([{ type: "text", text: "hi" }])
    expect(contentFiltered).toBe(false)
  })

  test("FORWARD leg surfaces contentFiltered (N3) when a choice finished with content_filter", () => {
    const filtered = { ...ccUpstream, choices: [{ ...ccUpstream.choices[0], finish_reason: "content_filter" as const }] }
    const { rendered, contentFiltered } = renderResponseNonStreamingVia(ENDPOINT.CHAT_COMPLETIONS, filtered)
    expect((rendered as { stop_reason: string }).stop_reason).toBe("end_turn")
    expect(contentFiltered).toBe(true)
  })

  test("REVERSE /v1/messages leg: Anthropic upstream → CC-canonical response", () => {
    const { rendered, contentFiltered } = renderResponseNonStreamingVia(ENDPOINT.MESSAGES, anthropicUpstream)
    expect((rendered as { object: string }).object).toBe("chat.completion")
    expect((rendered as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toBe("hi")
    expect(contentFiltered).toBe(false)
  })
})

describe("createForwardStreamTranslator — STREAMING forward-leg dispatch (Phase 4)", () => {
  /** A CC SSE chunk frame. */
  const ccChunk = (obj: unknown): { data: string; event: string } => ({ data: JSON.stringify(obj), event: "message" })

  test("cc leg (/chat/completions): single-hop CC → Anthropic frames + terminal meta", () => {
    const t = createForwardStreamTranslator(ENDPOINT.CHAT_COMPLETIONS, "claude-x")
    const frames = [
      ...t.renderFrame(ccChunk({ id: "msg_x", model: "claude-x", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] })),
      ...t.renderFrame(
        ccChunk({
          id: "msg_x",
          model: "claude-x",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      ),
      ...t.flush(),
    ]
    const types = frames.map((f) => JSON.parse(f.data ?? "{}").type)
    expect(types).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"])
    expect(t.getMeta().stopReason).toBe("end_turn")
    expect(t.getMeta().usage.input_tokens).toBe(5)
  })

  test("responses leg (/responses): DIRECT single-hop Responses → Anthropic frames (RFC 2026-07-14 subtask C)", () => {
    const t = createForwardStreamTranslator(ENDPOINT.RESPONSES, "gpt-x")
    const rEvent = (obj: unknown): { data: string; event: string } => ({ data: JSON.stringify(obj), event: "message" })
    const frames = [
      ...t.renderFrame(rEvent({ type: "response.created", response: { id: "resp_1", model: "gpt-x" } })),
      ...t.renderFrame(rEvent({ type: "response.output_text.delta", output_index: 0, delta: "hello" })),
      ...t.renderFrame(
        rEvent({
          type: "response.completed",
          response: { id: "resp_1", model: "gpt-x", status: "completed", usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } },
        }),
      ),
      ...t.flush(),
    ]
    const types = frames.map((f) => JSON.parse(f.data ?? "{}").type)
    expect(types).toContain("message_start")
    expect(types).toContain("content_block_delta")
    expect(types).toContain("message_stop")
    // Self-contained terminal meta (this translator's OWN running state, not a CC accumulator).
    expect(t.getMeta().usage.input_tokens).toBe(7)
    expect(t.getMeta().stopReason).toBe("end_turn")
  })

  test("forward translator REJECTS the /v1/messages leg (it is a REVERSE leg — use createReverseStreamTranslator)", () => {
    expect(() => createForwardStreamTranslator(ENDPOINT.MESSAGES, "claude-x")).toThrow(/\/v1\/messages leg is a REVERSE leg/)
  })
})

describe("createReverseStreamTranslator — REVERSE-leg dispatch (Phase 5, T5.2/T5.3/T5.4)", () => {
  const aev = (obj: unknown): { data: string; event: string } => ({ data: JSON.stringify(obj), event: (obj as { type: string }).type })
  const start = aev({
    type: "message_start",
    message: {
      id: "msg_r",
      type: "message",
      role: "assistant",
      model: "claude-x",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  })
  const textStart = aev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
  const textDelta = aev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })
  const textStop = aev({ type: "content_block_stop", index: 0 })
  const msgDelta = aev({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })
  const msgStop = aev({ type: "message_stop" })

  test("cc leg: single-hop Anthropic → CC frames (role chunk + content + finish, getMeta net usage)", () => {
    const t = createReverseStreamTranslator("openai-cc", "claude-x")
    const frames = [
      ...t.renderFrame(start),
      ...t.renderFrame(textStart),
      ...t.renderFrame(textDelta),
      ...t.renderFrame(textStop),
      ...t.renderFrame(msgDelta),
      ...t.renderFrame(msgStop),
      ...t.flush(),
    ]
    const objs = frames.map(
      (f) => JSON.parse(f.data ?? "{}") as { object?: string; choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: unknown }> },
    )
    // First CC chunk is the role delta; a content delta carries delta.content; a finish chunk carries finish_reason.
    expect(objs[0].choices?.[0]?.delta).toEqual({ role: "assistant" })
    expect(objs.some((o) => o.choices?.[0]?.delta?.content === "hi")).toBe(true)
    expect(objs.some((o) => o.choices?.[0]?.finish_reason === "stop")).toBe(true)
    expect(t.getMeta().finishReason).toBe("stop")
    expect(t.getMeta().usage?.prompt_tokens).toBe(5)
    expect(t.getMeta().sawMessageStop).toBe(true)
  })

  test("gemini leg: single-hop Anthropic → CC frames (the gemini codec does the CC→Gemini second hop)", () => {
    const t = createReverseStreamTranslator("gemini", "claude-x")
    const frames = [
      ...t.renderFrame(start),
      ...t.renderFrame(textStart),
      ...t.renderFrame(textDelta),
      ...t.renderFrame(textStop),
      ...t.renderFrame(msgDelta),
      ...t.renderFrame(msgStop),
    ]
    expect(
      frames.some((f) => (JSON.parse(f.data ?? "{}") as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content === "hi"),
    ).toBe(true)
  })

  test("responses leg: two-hop Anthropic → CC → Responses lifecycle events (needs the reverse exchange)", () => {
    const t = createReverseStreamTranslator("openai-responses", "claude-x", { responseId: "resp_r", itemId: "item_r", clientModel: "claude-x" })
    const frames = [
      ...t.renderFrame(start),
      ...t.renderFrame(textStart),
      ...t.renderFrame(textDelta),
      ...t.renderFrame(textStop),
      ...t.renderFrame(msgDelta),
      ...t.renderFrame(msgStop),
      ...t.flush(),
    ]
    const events = frames.map((f) => f.event)
    expect(events).toContain("response.created")
    expect(events).toContain("response.output_text.delta")
    expect(events).toContain("response.completed")
    // getMeta is the Anthropic→CC translator's meta (the truncation signal source).
    expect(t.getMeta().finishReason).toBe("stop")
  })

  test("responses leg WITHOUT an exchange ctx throws (never-swallow — the handler must build a reverse-exchange)", () => {
    expect(() => createReverseStreamTranslator("openai-responses", "claude-x")).toThrow(/requires an exchangeCtx/)
  })

  test("anthropic clientFormat (direct leg) never reaches a reverse translator → throws", () => {
    expect(() => createReverseStreamTranslator("anthropic", "claude-x")).toThrow(/unhandled clientFormat/)
  })
})
