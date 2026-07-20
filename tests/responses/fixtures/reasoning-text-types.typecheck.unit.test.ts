import { describe, expect, test } from "bun:test"
import type {
  ContentPartAddedEvent,
  OutputTextAnnotationAddedEvent,
  ReasoningTextDeltaEvent,
  ReasoningTextDoneEvent,
  ResponsesReasoningOutput,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

describe("reasoning_text independent track types (typecheck oracle: bun run typecheck)", () => {
  test("ResponsesReasoningOutput.content + ReasoningText*Event + content_part part union compile", () => {
    const delta: ReasoningTextDeltaEvent = {
      type: "response.reasoning_text.delta",
      item_id: "rs_1",
      output_index: 0,
      content_index: 0,
      delta: "thinking...",
      sequence_number: 1,
    }
    const done: ReasoningTextDoneEvent = {
      type: "response.reasoning_text.done",
      item_id: "rs_1",
      output_index: 0,
      content_index: 0,
      text: "thinking...",
      sequence_number: 2,
    }
    const item: ResponsesReasoningOutput = {
      type: "reasoning",
      id: "rs_1",
      summary: [],
      content: [{ type: "reasoning_text", text: "thinking..." }],
    }
    const contentPart: ContentPartAddedEvent = {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "reasoning_text", text: "" },
      sequence_number: 0,
    }
    expect(delta.type).toBe("response.reasoning_text.delta")
    expect(done.type).toBe("response.reasoning_text.done")
    expect(item.content?.[0].text).toBe("thinking...")
    expect(contentPart.part.type).toBe("reasoning_text")
  })
})

describe("output_text.annotation.added event type (typecheck oracle: bun run typecheck)", () => {
  test("OutputTextAnnotationAddedEvent compiles and narrows via ResponsesStreamEvent union", () => {
    const event: OutputTextAnnotationAddedEvent = {
      type: "response.output_text.annotation.added",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      annotation_index: 0,
      annotation: { type: "url_citation", start_index: 0, end_index: 5, url: "https://example.com", title: "Example" },
      sequence_number: 1,
    }
    const asStreamEvent: ResponsesStreamEvent = event
    expect(event.type).toBe("response.output_text.annotation.added")
    expect(asStreamEvent.type).toBe("response.output_text.annotation.added")
  })
})
