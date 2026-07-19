import { describe, expect, test } from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import { createResponsesBufferedMergeReducer } from "~/lib/codec/openai-responses/buffered-merge-reducer"

import { functionCallBlock, messageMultiPartBlock, reasoningContentBlock, reasoningSummaryBlock, refusalBlock } from "./fixtures/buffered-merge-blocks"

function types(frames: ReadonlyArray<ClientFrame>): Array<string> {
  return frames.map((f) => f.event ?? "")
}

describe("createResponsesBufferedMergeReducer — drop-delta (function_call block)", () => {
  test("drop-delta drops function_call_arguments.delta once the item is closed by output_item.done", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
    const { frames } = functionCallBlock(0, "fc_1")
    for (const f of frames) reducer.observe(f)
    const out = reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] })
    expect(types(out)).toEqual(["response.output_item.added", "response.function_call_arguments.done", "response.output_item.done"])
  })
})

describe("drop-delta — message/refusal/reasoning blocks", () => {
  test.each([
    ["message multi-part", messageMultiPartBlock, ["response.output_item.added", "response.content_part.added", "response.output_text.done", "response.content_part.done", "response.content_part.added", "response.refusal.done", "response.content_part.done", "response.output_item.done"]],
    ["refusal-only", refusalBlock, ["response.output_item.added", "response.content_part.added", "response.refusal.done", "response.content_part.done", "response.output_item.done"]],
    ["reasoning summary", reasoningSummaryBlock, ["response.output_item.added", "response.reasoning_summary_part.added", "response.reasoning_summary_text.done", "response.reasoning_summary_part.done", "response.output_item.done"]],
    ["reasoning content", reasoningContentBlock, ["response.output_item.added", "response.content_part.added", "response.reasoning_text.done", "response.content_part.done", "response.output_item.done"]],
  ])("%s: drop-delta keeps every .added + the final .done, drops mid-stream deltas", (_label, blockFn, expectedTypes) => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
    const { frames } = blockFn(0, "item_1")
    for (const f of frames) reducer.observe(f)
    const out = reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] })
    expect(types(out)).toEqual(expectedTypes)
  })

  test("地雷不变量: every surviving content-part `.done` has its `.added` still present", () => {
    for (const blockFn of [messageMultiPartBlock, refusalBlock, reasoningSummaryBlock, reasoningContentBlock]) {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
      const { frames } = blockFn(0, "item_1")
      for (const f of frames) reducer.observe(f)
      const out = types(reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] }))
      const doneTypes = out.filter((t) => t.endsWith(".done") && (t.includes("content_part") || t.includes("reasoning_summary_part")))
      for (const doneType of doneTypes) {
        const addedType = doneType.replace(".done", ".added")
        expect(out).toContain(addedType)
      }
    }
  })
})
