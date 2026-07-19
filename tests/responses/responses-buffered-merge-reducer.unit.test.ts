import { describe, expect, test } from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import { readSyntheticKind } from "~/lib/pipeline/frame-origin"

import { createResponsesBufferedMergeReducer } from "~/lib/codec/openai-responses/buffered-merge-reducer"

import { functionCallBlock, messageMultiPartBlock, messageWithAnnotationBlock, reasoningContentBlock, reasoningSummaryBlock, refusalBlock } from "./fixtures/buffered-merge-blocks"

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

describe("item-summary", () => {
  test.each([
    ["function_call", functionCallBlock],
    ["message multi-part", messageMultiPartBlock],
    ["refusal-only", refusalBlock],
    ["reasoning summary", reasoningSummaryBlock],
    ["reasoning content", reasoningContentBlock],
    ["message with annotation", messageWithAnnotationBlock],
  ])("%s: item-summary collapses to added + done only", (_label, blockFn) => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "item-summary", completedOutput: "upstream" })
    const { frames } = blockFn(0, "item_1")
    for (const f of frames) reducer.observe(f)
    const out = types(reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] }))
    expect(out).toEqual(["response.output_item.added", "response.output_item.done"])
  })

  test("annotation.added is dropped together with content_part.added — no orphan reference (GPT-audit HIGH fix)", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "item-summary", completedOutput: "upstream" })
    const { frames } = messageWithAnnotationBlock(0, "msg_1")
    for (const f of frames) reducer.observe(f)
    const out = types(reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] }))
    expect(out).not.toContain("response.output_text.annotation.added")
    expect(out).not.toContain("response.content_part.added")
    expect(out).toEqual(["response.output_item.added", "response.output_item.done"])
  })
})

describe("verbatim + 三档正交性", () => {
  test("verbatim returns every frame unchanged for all 5 block types", () => {
    for (const blockFn of [functionCallBlock, messageMultiPartBlock, refusalBlock, reasoningSummaryBlock, reasoningContentBlock]) {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "verbatim", completedOutput: "upstream" })
      const { frames } = blockFn(0, "item_1")
      for (const f of frames) reducer.observe(f)
      const out = reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] })
      expect(out).toEqual(frames)
    }
  })

  test("three modes are strictly ordered by frame count: verbatim >= drop-delta >= item-summary", () => {
    for (const blockFn of [functionCallBlock, messageMultiPartBlock, refusalBlock, reasoningSummaryBlock, reasoningContentBlock]) {
      const counts = (["verbatim", "drop-delta", "item-summary"] as const).map((mode) => {
        const reducer = createResponsesBufferedMergeReducer({ eventCompaction: mode, completedOutput: "upstream" })
        const { frames } = blockFn(0, "item_1")
        for (const f of frames) reducer.observe(f)
        return reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames[frames.length - 1] }).length
      })
      expect(counts[0]).toBeGreaterThanOrEqual(counts[1])
      expect(counts[1]).toBeGreaterThanOrEqual(counts[2])
    }
  })
})

function completedFrame(output: Array<unknown>): ClientFrame {
  return { event: "response.completed", data: JSON.stringify({ type: "response.completed", response: { id: "r1", object: "response", status: "completed", output, usage: null } }) }
}

describe("completed_output: upstream", () => {
  test("terminal response.completed passes through as the same reference (upstream must not replace it)", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
    const { frames: fcFrames } = functionCallBlock(0, "fc_1")
    for (const f of fcFrames) reducer.observe(f)
    const terminal = completedFrame([]) // deliberately empty/defective — upstream mode must NOT repair it
    const out = reducer.transformFlush([...fcFrames, terminal], { cause: "boundary", boundaryFrame: terminal })
    const last = out[out.length - 1]
    expect(last).toBe(terminal) // same reference — upstream mode must not replace the terminal frame at all
  })
})

describe("completed_output: repair-if-incomplete", () => {
  test("defective terminal (empty output) gets rebuilt from collected items + tagged synthetic", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" })
    const { frames: fcFrames, finalItem } = functionCallBlock(0, "fc_1")
    for (const f of fcFrames) reducer.observe(f)
    const terminal = completedFrame([]) // defective: empty despite 1 collected item
    const out = reducer.transformFlush([...fcFrames, terminal], { cause: "boundary", boundaryFrame: terminal })
    const last = out[out.length - 1]
    expect(JSON.parse(last.data!).response.output).toEqual([finalItem])
    expect(readSyntheticKind(last)).toBe("buffered-terminal-repair")
  })

  test("complete terminal is left untouched (not re-tagged, same reference)", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" })
    const { frames: fcFrames, finalItem } = functionCallBlock(0, "fc_1")
    for (const f of fcFrames) reducer.observe(f)
    const terminal = completedFrame([finalItem]) // already complete
    const out = reducer.transformFlush([...fcFrames, terminal], { cause: "boundary", boundaryFrame: terminal })
    const last = out[out.length - 1]
    expect(last).toBe(terminal)
    expect(readSyntheticKind(last)).toBeUndefined()
  })
})

describe("completed_output: rebuild", () => {
  test("rebuild unconditionally replaces the output even when the upstream terminal was already complete", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "rebuild" })
    const { frames: fcFrames, finalItem } = functionCallBlock(0, "fc_1")
    for (const f of fcFrames) reducer.observe(f)
    const terminal = completedFrame([finalItem]) // already complete — rebuild still replaces it
    const out = reducer.transformFlush([...fcFrames, terminal], { cause: "boundary", boundaryFrame: terminal })
    const last = out[out.length - 1]
    expect(readSyntheticKind(last)).toBe("buffered-terminal-repair")
    expect(JSON.parse(last.data!).response.output).toEqual([finalItem])
  })
})
