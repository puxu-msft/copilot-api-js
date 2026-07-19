import { describe, expect, test } from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import { createResponsesBufferedMergeReducer } from "~/lib/codec/openai-responses/buffered-merge-reducer"

import { functionCallBlock } from "./fixtures/buffered-merge-blocks"

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
