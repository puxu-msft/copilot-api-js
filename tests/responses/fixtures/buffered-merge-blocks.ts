import type { ClientFrame } from "~/lib/pipeline/types"
import type {
  //
  ResponsesFunctionCallOutput,
  ResponsesMessageOutput,
  ResponsesOutputItem,
  ResponsesReasoningOutput,
} from "~/types/api/openai-responses"

function frame(type: string, data: Record<string, unknown>): ClientFrame {
  return { event: type, data: JSON.stringify({ type, ...data }) }
}

export interface BlockFixture {
  frames: Array<ClientFrame>
  finalItem: ResponsesOutputItem
}

/** function_call block: added → arguments.delta×2 → arguments.done → output_item.done. */
export function functionCallBlock(outputIndex: number, itemId: string): BlockFixture {
  const finalItem: ResponsesFunctionCallOutput = {
    type: "function_call",
    id: itemId,
    call_id: `call_${itemId}`,
    name: "get_weather",
    arguments: '{"city":"Tokyo"}',
    status: "completed",
  }
  return {
    finalItem,
    frames: [
      frame("response.output_item.added", {
        output_index: outputIndex,
        item: { type: "function_call", id: itemId, call_id: `call_${itemId}`, name: "get_weather", arguments: "", status: "in_progress" },
      }),
      frame("response.function_call_arguments.delta", { output_index: outputIndex, item_id: itemId, delta: '{"city":' }),
      frame("response.function_call_arguments.delta", { output_index: outputIndex, item_id: itemId, delta: '"Tokyo"}' }),
      frame("response.function_call_arguments.done", { output_index: outputIndex, item_id: itemId, arguments: '{"city":"Tokyo"}' }),
      frame("response.output_item.done", { output_index: outputIndex, item: finalItem }),
    ],
  }
}

/** message block with 2 content parts: added → content_part.added(0) → text.delta×2 → text.done →
 *  content_part.done(0) → content_part.added(1, refusal) → refusal.delta → refusal.done →
 *  content_part.done(1) → output_item.done. */
export function messageMultiPartBlock(outputIndex: number, itemId: string): BlockFixture {
  const finalItem: ResponsesMessageOutput = {
    type: "message",
    id: itemId,
    role: "assistant",
    status: "completed",
    content: [
      { type: "output_text", text: "Hello world", annotations: [] },
      { type: "refusal", refusal: "cannot comply" },
    ],
  }
  return {
    finalItem,
    frames: [
      frame("response.output_item.added", {
        output_index: outputIndex,
        item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] },
      }),
      frame("response.content_part.added", { output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
      frame("response.output_text.delta", { output_index: outputIndex, content_index: 0, delta: "Hello " }),
      frame("response.output_text.delta", { output_index: outputIndex, content_index: 0, delta: "world" }),
      frame("response.output_text.done", { output_index: outputIndex, content_index: 0, text: "Hello world" }),
      frame("response.content_part.done", { output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "Hello world", annotations: [] } }),
      frame("response.content_part.added", { output_index: outputIndex, content_index: 1, part: { type: "refusal", refusal: "" } }),
      frame("response.refusal.delta", { output_index: outputIndex, content_index: 1, delta: "cannot comply" }),
      frame("response.refusal.done", { output_index: outputIndex, content_index: 1, refusal: "cannot comply" }),
      frame("response.content_part.done", { output_index: outputIndex, content_index: 1, part: { type: "refusal", refusal: "cannot comply" } }),
      frame("response.output_item.done", { output_index: outputIndex, item: finalItem }),
    ],
  }
}

/** Pure refusal-only message block (single content part, no output_text). */
export function refusalBlock(outputIndex: number, itemId: string): BlockFixture {
  const finalItem: ResponsesMessageOutput = {
    type: "message",
    id: itemId,
    role: "assistant",
    status: "completed",
    content: [{ type: "refusal", refusal: "I cannot help with that" }],
  }
  return {
    finalItem,
    frames: [
      frame("response.output_item.added", {
        output_index: outputIndex,
        item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] },
      }),
      frame("response.content_part.added", { output_index: outputIndex, content_index: 0, part: { type: "refusal", refusal: "" } }),
      frame("response.refusal.delta", { output_index: outputIndex, content_index: 0, delta: "I cannot help " }),
      frame("response.refusal.delta", { output_index: outputIndex, content_index: 0, delta: "with that" }),
      frame("response.refusal.done", { output_index: outputIndex, content_index: 0, refusal: "I cannot help with that" }),
      frame("response.content_part.done", { output_index: outputIndex, content_index: 0, part: { type: "refusal", refusal: "I cannot help with that" } }),
      frame("response.output_item.done", { output_index: outputIndex, item: finalItem }),
    ],
  }
}

/** Reasoning block using the `summary` track (reasoning_summary_part/_text events). */
export function reasoningSummaryBlock(outputIndex: number, itemId: string): BlockFixture {
  const finalItem: ResponsesReasoningOutput = {
    type: "reasoning",
    id: itemId,
    summary: [{ type: "summary_text", text: "Let me think about this" }],
    status: "completed",
  }
  return {
    finalItem,
    frames: [
      frame("response.output_item.added", { output_index: outputIndex, item: { type: "reasoning", id: itemId, summary: [] } }),
      frame("response.reasoning_summary_part.added", {
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      }),
      frame("response.reasoning_summary_text.delta", { item_id: itemId, output_index: outputIndex, summary_index: 0, delta: "Let me think " }),
      frame("response.reasoning_summary_text.delta", { item_id: itemId, output_index: outputIndex, summary_index: 0, delta: "about this" }),
      frame("response.reasoning_summary_text.done", { item_id: itemId, output_index: outputIndex, summary_index: 0, text: "Let me think about this" }),
      frame("response.reasoning_summary_part.done", {
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "Let me think about this" },
      }),
      frame("response.output_item.done", { output_index: outputIndex, item: finalItem }),
    ],
  }
}

/** Reasoning block using the independent `content` track (reasoning_text events + shared content_part.*). */
export function reasoningContentBlock(outputIndex: number, itemId: string): BlockFixture {
  const finalItem: ResponsesReasoningOutput = {
    type: "reasoning",
    id: itemId,
    summary: [],
    content: [{ type: "reasoning_text", text: "internal deliberation" }],
    status: "completed",
  }
  return {
    finalItem,
    frames: [
      frame("response.output_item.added", { output_index: outputIndex, item: { type: "reasoning", id: itemId, summary: [] } }),
      frame("response.content_part.added", { output_index: outputIndex, content_index: 0, part: { type: "reasoning_text", text: "" } }),
      frame("response.reasoning_text.delta", { item_id: itemId, output_index: outputIndex, content_index: 0, delta: "internal " }),
      frame("response.reasoning_text.delta", { item_id: itemId, output_index: outputIndex, content_index: 0, delta: "deliberation" }),
      frame("response.reasoning_text.done", { item_id: itemId, output_index: outputIndex, content_index: 0, text: "internal deliberation" }),
      frame("response.content_part.done", { output_index: outputIndex, content_index: 0, part: { type: "reasoning_text", text: "internal deliberation" } }),
      frame("response.output_item.done", { output_index: outputIndex, item: finalItem }),
    ],
  }
}

/** Message block with a single output_text part carrying a streamed citation annotation event
 *  (gpt-5.5 web_search_preview native citations — GPT 对抗复核 HIGH 修复新增)。`annotation.added` is
 *  emitted BETWEEN `content_part.added` and the terminal `.done`, same content_index as the part it
 *  annotates. */
export function messageWithAnnotationBlock(outputIndex: number, itemId: string): BlockFixture {
  const annotation = { type: "url_citation", start_index: 0, end_index: 5, url: "https://example.com", title: "Example" }
  const finalItem: ResponsesMessageOutput = {
    type: "message",
    id: itemId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Hello", annotations: [annotation] }],
  }
  return {
    finalItem,
    frames: [
      frame("response.output_item.added", {
        output_index: outputIndex,
        item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] },
      }),
      frame("response.content_part.added", { output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
      frame("response.output_text.delta", { output_index: outputIndex, content_index: 0, delta: "Hello" }),
      frame("response.output_text.annotation.added", { item_id: itemId, output_index: outputIndex, content_index: 0, annotation_index: 0, annotation }),
      frame("response.output_text.done", { output_index: outputIndex, content_index: 0, text: "Hello" }),
      frame("response.content_part.done", {
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "Hello", annotations: [annotation] },
      }),
      frame("response.output_item.done", { output_index: outputIndex, item: finalItem }),
    ],
  }
}
