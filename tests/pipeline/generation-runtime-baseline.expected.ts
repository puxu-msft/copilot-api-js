/** Hand-authored client-wire oracle. This module never imports production translators/decoders. */

const ANTHROPIC_MODEL = "claude-generation-baseline"
const RESPONSES_MODEL = "gpt-responses-generation-baseline"
const CC_MODEL = "gpt-cc-generation-baseline"
const GEMINI_CC_MODEL = "gpt-gemini-generation-baseline"

const eventFrame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const dataFrame = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`

function anthropicDirectWire(): string {
  return [
    eventFrame("message_start", {
      type: "message_start",
      message: {
        id: "msg_generation_baseline",
        type: "message",
        role: "assistant",
        model: ANTHROPIC_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 0 },
      },
    }),
    eventFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    eventFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "alpha" } }),
    eventFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    eventFrame("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_generation", name: "get_weather", input: {} },
    }),
    eventFrame("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":"SF"}' } }),
    eventFrame("content_block_stop", { type: "content_block_stop", index: 1 }),
    eventFrame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 7 } }),
    eventFrame("message_stop", { type: "message_stop" }),
  ].join("")
}

function anthropicFromResponsesWire(): string {
  return [
    eventFrame("message_start", {
      type: "message_start",
      message: {
        id: "resp_N",
        type: "message",
        role: "assistant",
        model: RESPONSES_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
    eventFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    eventFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "beta" } }),
    eventFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    eventFrame("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "call_generation", name: "lookup", input: {} },
    }),
    eventFrame("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":"docs"}' } }),
    eventFrame("content_block_stop", { type: "content_block_stop", index: 1 }),
    eventFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { input_tokens: 13, output_tokens: 5 },
    }),
    eventFrame("message_stop", { type: "message_stop" }),
  ].join("")
}

function responsesFromAnthropicWire(): string {
  const responseBase = {
    id: "resp_N",
    object: "response",
    created_at: 0,
    status: "in_progress",
    model: ANTHROPIC_MODEL,
    output: [],
    usage: null,
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
  }
  const messageItem = {
    id: "item_N",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "alpha", annotations: [] }],
  }
  const toolItem = {
    type: "function_call",
    id: "toolu_generation",
    call_id: "toolu_generation",
    name: "get_weather",
    arguments: '{"city":"SF"}',
    status: "completed",
  }
  return [
    eventFrame("response.created", { type: "response.created", sequence_number: 0, response: responseBase }),
    eventFrame("response.content_part.added", {
      type: "response.content_part.added",
      sequence_number: 1,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
    eventFrame("response.output_text.delta", { type: "response.output_text.delta", sequence_number: 2, output_index: 0, content_index: 0, delta: "alpha" }),
    eventFrame("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: 3,
      output_index: 1,
      item: { type: "function_call", id: "toolu_generation", call_id: "toolu_generation", name: "get_weather", arguments: "", status: "in_progress" },
    }),
    eventFrame("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      sequence_number: 4,
      output_index: 1,
      item_id: "toolu_generation",
      delta: '{"city":"SF"}',
    }),
    eventFrame("response.output_text.done", { type: "response.output_text.done", sequence_number: 5, output_index: 0, content_index: 0, text: "alpha" }),
    eventFrame("response.content_part.done", {
      type: "response.content_part.done",
      sequence_number: 6,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "alpha", annotations: [] },
    }),
    eventFrame("response.output_item.done", { type: "response.output_item.done", sequence_number: 7, output_index: 0, item: messageItem }),
    eventFrame("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      sequence_number: 8,
      output_index: 1,
      item_id: "toolu_generation",
      arguments: '{"city":"SF"}',
    }),
    eventFrame("response.output_item.done", { type: "response.output_item.done", sequence_number: 9, output_index: 1, item: toolItem }),
    eventFrame("response.completed", {
      type: "response.completed",
      sequence_number: 10,
      response: { ...responseBase, status: "completed", output: [messageItem, toolItem], usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } },
    }),
  ].join("")
}

function ccDirectWire(): string {
  return [
    dataFrame({
      id: "chatcmpl_generation",
      object: "chat.completion.chunk",
      created: 0,
      model: CC_MODEL,
      choices: [{ index: 0, delta: { role: "assistant", content: "gamma" }, finish_reason: null, logprobs: null }],
    }),
    dataFrame({
      id: "chatcmpl_generation",
      object: "chat.completion.chunk",
      created: 0,
      model: CC_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 },
    }),
    "data: [DONE]\n\n",
  ].join("")
}

function geminiTranslationWire(): string {
  return [
    dataFrame({ candidates: [{ content: { role: "model", parts: [{ text: "delta " }] }, index: 0 }], modelVersion: GEMINI_CC_MODEL }),
    dataFrame({
      candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call_gemini", name: "lookup", args: { q: "flush" } } }] }, index: 0 }],
      modelVersion: GEMINI_CC_MODEL,
    }),
    dataFrame({
      candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 19, candidatesTokenCount: 6, totalTokenCount: 25 },
      modelVersion: GEMINI_CC_MODEL,
    }),
  ].join("")
}

function terminal(inputTokens: number, outputTokens: number, frameOrigins: Array<string>, details?: Record<string, unknown>) {
  return {
    outcome: "completed",
    usage: {
      inputTokens,
      outputTokens,
      ...(details?.output_tokens_details === undefined ? {} : { reasoningTokens: 2 }),
      details: { input_tokens: inputTokens, output_tokens: outputTokens, ...details },
    },
    frameOrigins,
  }
}

export function expectedGenerationRuntimeResults(): Record<string, unknown> {
  return {
    "anthropic-direct": {
      wire: anthropicDirectWire(),
      terminal: terminal(
        11,
        7,
        Array.from({ length: 9 }, () => "rewrite-out:client"),
      ),
    },
    "anthropic-client-to-responses": {
      wire: anthropicFromResponsesWire(),
      terminal: terminal(13, 5, [...Array.from({ length: 6 }, () => "render:client"), ...Array.from({ length: 3 }, () => "client-sink:client")], {
        output_tokens_details: { reasoning_tokens: 2 },
      }),
    },
    "responses-client-to-anthropic": {
      wire: responsesFromAnthropicWire(),
      // The reverse translator's six closing lifecycle frames now flow through the processor's
      // ordinary post-render transform boundary instead of bypassing it in a handler-side drain.
      terminal: terminal(
        11,
        7,
        Array.from({ length: 11 }, () => "client-transform:client"),
      ),
    },
    "cc-direct": {
      wire: ccDirectWire(),
      terminal: terminal(17, 3, ["client-transform:client", "client-transform:client", "client-transform:client"]),
    },
    "gemini-translation": {
      wire: geminiTranslationWire(),
      terminal: terminal(19, 6, ["render:client", "client-sink:client", "client-sink:client"]),
    },
  }
}
