import { describe, expect, test } from "bun:test"

import { createRequestContext } from "~/lib/context/request"

describe("RequestContext.recordBufferedMergeInfo", () => {
  test("merges into pipelineInfo without requiring setPipelineInfo to have been called", () => {
    const ctx = createRequestContext({ endpoint: "openai-responses" })
    ctx.recordBufferedMergeInfo({
      eventCompaction: "drop-delta",
      completedOutput: "repair-if-incomplete",
      droppedEventCount: 3,
      droppedEventBytes: 120,
      droppedEventTypes: ["response.output_text.delta"],
      repairedItemCount: 0,
      repairReasons: [],
      verbatimFallbacks: [],
    })
    expect(ctx.pipelineInfo?.bufferedMerge?.droppedEventCount).toBe(3)
  })

  test("survives a later setPipelineInfo full-replace call (independent merge slot, mirrors _streamTimeouts/_sendMessageNormalization)", () => {
    const ctx = createRequestContext({ endpoint: "openai-responses" })
    ctx.recordBufferedMergeInfo({
      eventCompaction: "drop-delta",
      completedOutput: "upstream",
      droppedEventCount: 1,
      droppedEventBytes: 10,
      droppedEventTypes: [],
      repairedItemCount: 0,
      repairReasons: [],
      verbatimFallbacks: [],
    })
    ctx.setPipelineInfo({ preprocessing: { strippedReadTagCount: 0, dedupedToolCallCount: 0 } })
    expect(ctx.pipelineInfo?.bufferedMerge?.droppedEventCount).toBe(1)
    expect(ctx.pipelineInfo?.preprocessing).toBeDefined()
  })
})
