import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import { createResponsesBufferedMergeReducer } from "~/lib/codec/openai-responses/buffered-merge-reducer"
import { readSyntheticKind, tagFrameSynthetic } from "~/lib/pipeline/frame-origin"

import {
  //
  functionCallBlock,
  messageMultiPartBlock,
  messageWithAnnotationBlock,
  reasoningContentBlock,
  reasoningSummaryBlock,
  refusalBlock,
} from "./fixtures/buffered-merge-blocks"

function types(frames: ReadonlyArray<ClientFrame>): Array<string> {
  return frames.map((f) => f.event ?? "")
}

describe("createResponsesBufferedMergeReducer — drop-delta (function_call block)", () => {
  test("drop-delta drops function_call_arguments.delta once the item is closed by output_item.done", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
    const { frames } = functionCallBlock(0, "fc_1")
    for (const f of frames) reducer.observe(f)
    const out = reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames.at(-1) })
    expect(types(out)).toEqual(["response.output_item.added", "response.function_call_arguments.done", "response.output_item.done"])
  })
})

describe("drop-delta — message/refusal/reasoning blocks", () => {
  test.each([
    [
      "message multi-part",
      messageMultiPartBlock,
      [
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.done",
        "response.content_part.done",
        "response.content_part.added",
        "response.refusal.done",
        "response.content_part.done",
        "response.output_item.done",
      ],
    ],
    [
      "refusal-only",
      refusalBlock,
      ["response.output_item.added", "response.content_part.added", "response.refusal.done", "response.content_part.done", "response.output_item.done"],
    ],
    [
      "reasoning summary",
      reasoningSummaryBlock,
      [
        "response.output_item.added",
        "response.reasoning_summary_part.added",
        "response.reasoning_summary_text.done",
        "response.reasoning_summary_part.done",
        "response.output_item.done",
      ],
    ],
    [
      "reasoning content",
      reasoningContentBlock,
      ["response.output_item.added", "response.content_part.added", "response.reasoning_text.done", "response.content_part.done", "response.output_item.done"],
    ],
  ])("%s: drop-delta keeps every .added + the final .done, drops mid-stream deltas", (_label, blockFn, expectedTypes) => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
    const { frames } = blockFn(0, "item_1")
    for (const f of frames) reducer.observe(f)
    const out = reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames.at(-1) })
    expect(types(out)).toEqual(expectedTypes)
  })

  test("地雷不变量: every surviving content-part `.done` has its `.added` still present", () => {
    for (const blockFn of [messageMultiPartBlock, refusalBlock, reasoningSummaryBlock, reasoningContentBlock]) {
      const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
      const { frames } = blockFn(0, "item_1")
      for (const f of frames) reducer.observe(f)
      const out = types(reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames.at(-1) }))
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
    const out = types(reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames.at(-1) }))
    expect(out).toEqual(["response.output_item.added", "response.output_item.done"])
  })

  test("annotation.added is dropped together with content_part.added — no orphan reference (GPT-audit HIGH fix)", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "item-summary", completedOutput: "upstream" })
    const { frames } = messageWithAnnotationBlock(0, "msg_1")
    for (const f of frames) reducer.observe(f)
    const out = types(reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames.at(-1) }))
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
      const out = reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames.at(-1) })
      expect(out).toEqual(frames)
    }
  })

  test("three modes are strictly ordered by frame count: verbatim >= drop-delta >= item-summary", () => {
    for (const blockFn of [functionCallBlock, messageMultiPartBlock, refusalBlock, reasoningSummaryBlock, reasoningContentBlock]) {
      const counts = (["verbatim", "drop-delta", "item-summary"] as const).map((mode) => {
        const reducer = createResponsesBufferedMergeReducer({ eventCompaction: mode, completedOutput: "upstream" })
        const { frames } = blockFn(0, "item_1")
        for (const f of frames) reducer.observe(f)
        return reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames.at(-1) }).length
      })
      expect(counts[0]).toBeGreaterThanOrEqual(counts[1])
      expect(counts[1]).toBeGreaterThanOrEqual(counts[2])
    }
  })
})

function completedFrame(output: Array<unknown>): ClientFrame {
  return {
    event: "response.completed",
    data: JSON.stringify({ type: "response.completed", response: { id: "r1", object: "response", status: "completed", output, usage: null } }),
  }
}

describe("completed_output: upstream", () => {
  test("terminal response.completed passes through as the same reference (upstream must not replace it)", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
    const { frames: fcFrames } = functionCallBlock(0, "fc_1")
    for (const f of fcFrames) reducer.observe(f)
    const terminal = completedFrame([]) // deliberately empty/defective — upstream mode must NOT repair it
    const out = reducer.transformFlush([...fcFrames, terminal], { cause: "boundary", boundaryFrame: terminal })
    const last = out.at(-1)
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
    const last = out.at(-1)!
    expect(JSON.parse(last.data!).response.output).toEqual([finalItem])
    expect(readSyntheticKind(last)).toBe("buffered-terminal-repair")
  })

  test("complete terminal is left untouched (not re-tagged, same reference)", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" })
    const { frames: fcFrames, finalItem } = functionCallBlock(0, "fc_1")
    for (const f of fcFrames) reducer.observe(f)
    const terminal = completedFrame([finalItem]) // already complete
    const out = reducer.transformFlush([...fcFrames, terminal], { cause: "boundary", boundaryFrame: terminal })
    const last = out.at(-1)!
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
    const last = out.at(-1)!
    expect(readSyntheticKind(last)).toBe("buffered-terminal-repair")
    expect(JSON.parse(last.data!).response.output).toEqual([finalItem])
  })
})

describe("diagnostics()", () => {
  test("retreat (buffer-cap forfeit): the flush is VERBATIM even under drop-delta — a hard invariant (spec §5.3.1)", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "rebuild" })
    const { frames } = functionCallBlock(0, "fc_1")
    for (const f of frames) reducer.observe(f)
    // cause "retreat" short-circuits ALL compaction + terminal reconciliation: the buffered prefix is
    // about to be handed off to live write-through, so it must reach the client byte-for-byte.
    const out = reducer.transformFlush(frames, { cause: "retreat" })
    expect(out).toEqual(frames) // no deltas dropped, no terminal rebuilt
    expect(reducer.diagnostics().verbatimFallbacks).toEqual(["retreat"])
    expect(reducer.diagnostics().droppedEventCount).toBe(0)
  })

  test("accumulates dropped-event stats across flushes within one reducer instance", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" })
    const { frames } = functionCallBlock(0, "fc_1")
    for (const f of frames) reducer.observe(f)
    reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames.at(-1) })
    const diag1 = reducer.diagnostics()
    expect(diag1.eventCompaction).toBe("drop-delta")
    expect(diag1.droppedEventCount).toBe(2)
    expect(diag1.droppedEventTypes).toEqual(["response.function_call_arguments.delta"])
  })

  test("a FRESH reducer instance starts with zeroed diagnostics — no cross-attempt leak possible by construction", () => {
    const stale = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" })
    const { frames } = functionCallBlock(0, "fc_1")
    for (const f of frames) stale.observe(f)
    stale.transformFlush(frames, { cause: "boundary", boundaryFrame: frames.at(-1) })
    expect(stale.diagnostics().droppedEventCount).toBe(2)

    const fresh = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" })
    expect(fresh.diagnostics().droppedEventCount).toBe(0)
    expect(fresh.diagnostics().droppedEventTypes).toEqual([])
  })

  test("records repairedItemCount + repairReasons only for repair-if-incomplete (not rebuild)", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "repair-if-incomplete" })
    const { frames: fcFrames } = functionCallBlock(0, "fc_1")
    for (const f of fcFrames) reducer.observe(f)
    const terminal = completedFrame([])
    reducer.transformFlush([...fcFrames, terminal], { cause: "boundary", boundaryFrame: terminal })
    const diag = reducer.diagnostics()
    expect(diag.repairedItemCount).toBe(1)
    expect(diag.repairReasons).toEqual(["empty-output"])
  })

  test("rebuild mode does NOT push a repairReason (unconditional replace is not a defect diagnosis)", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "rebuild" })
    const { frames: fcFrames, finalItem } = functionCallBlock(0, "fc_1")
    for (const f of fcFrames) reducer.observe(f)
    const terminal = completedFrame([finalItem])
    reducer.transformFlush([...fcFrames, terminal], { cause: "boundary", boundaryFrame: terminal })
    const diag = reducer.diagnostics()
    expect(diag.repairedItemCount).toBe(1)
    expect(diag.repairReasons).toEqual([])
  })

  test("droppedEventBytes counts BOTH event-name length and data length — aligns with driver's bufferedBytes calc (driver.ts:1138, GPT-audit suggestion)", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
    const { frames } = functionCallBlock(0, "fc_1")
    for (const f of frames) reducer.observe(f)
    reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames.at(-1) })
    const diag = reducer.diagnostics()
    const droppedFrames = frames.filter((f) => f.event === "response.function_call_arguments.delta")
    const expectedBytes = droppedFrames.reduce((sum, f) => sum + (f.data?.length ?? 0) + (f.event?.length ?? 0), 0)
    expect(diag.droppedEventBytes).toBe(expectedBytes)
    expect(diag.droppedEventBytes).toBeGreaterThan(droppedFrames.reduce((sum, f) => sum + (f.data?.length ?? 0), 0))
  })
})

describe("次序不变量（spec §4）: observe 先于 drop 生效", () => {
  test("a frame observed AFTER its own output_item.done in the same batch is still correctly recognized as closed at flush time", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
    const { frames } = functionCallBlock(0, "fc_1")
    for (const f of frames) reducer.observe(f)
    const out = reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames.at(-1) })
    expect(types(out)).not.toContain("response.function_call_arguments.delta")
  })
})

describe("变异纪律 MUTANT 示范", () => {
  test("MUTANT: if event_compaction were accidentally verbatim, the drop-delta frame-count assertion would fail", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "verbatim", completedOutput: "upstream" }) // deliberately wrong mode
    const { frames } = functionCallBlock(0, "fc_1")
    for (const f of frames) reducer.observe(f)
    const out = reducer.transformFlush(frames, { cause: "boundary", boundaryFrame: frames.at(-1) })
    // MUST NOT equal the drop-delta expectation — proving the frame-count assertion has teeth (a mode
    // regression is observably different: verbatim keeps everything, drop-delta strips the deltas).
    expect(types(out)).not.toEqual(["response.output_item.added", "response.function_call_arguments.done", "response.output_item.done"])
    expect(out.length).toBe(frames.length) // verbatim keeps all 5 frames
  })
})

describe("hook-rewrite provenance through the merge (Unit 2 §Phase A — two subtractive edge cases)", () => {
  // Characterization: richest-data-flow ②b accepts that provenance on frames REMOVED/REBUILT by the
  // merge is lost (recoverable via the upstream/forwarded two-track diff). These固化 the two boundaries.
  test("identity pass-through: a hook-rewrite tag on a SURVIVING (non-dropped) frame is preserved", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
    const { frames } = functionCallBlock(0, "fc_1")
    // Tag the structural output_item.added frame — it survives drop-delta (not a droppable delta).
    const tagged = frames.map((f) => (f.event === "response.output_item.added" ? tagFrameSynthetic({ ...f }, "hook-rewrite") : f))
    for (const f of tagged) reducer.observe(f)
    const out = reducer.transformFlush(tagged, { cause: "boundary", boundaryFrame: tagged.at(-1) })
    const survivor = out.find((f) => f.event === "response.output_item.added")
    expect(survivor).toBeDefined()
    expect(readSyntheticKind(survivor!)).toBe("hook-rewrite") // same object reference passed through → tag rides along
  })

  test("subtractive drop: a hook-rewrite tag on a DROPPED delta frame vanishes with the frame (acceptable, two-track recoverable)", () => {
    const reducer = createResponsesBufferedMergeReducer({ eventCompaction: "drop-delta", completedOutput: "upstream" })
    const { frames } = functionCallBlock(0, "fc_1")
    const tagged = frames.map((f) => (f.event === "response.function_call_arguments.delta" ? tagFrameSynthetic({ ...f }, "hook-rewrite") : f))
    for (const f of tagged) reducer.observe(f)
    const out = reducer.transformFlush(tagged, { cause: "boundary", boundaryFrame: tagged.at(-1) })
    // The dropped delta is gone entirely — no surviving frame carries hook-rewrite (subtraction, not corruption).
    expect(out.some((f) => f.event === "response.function_call_arguments.delta")).toBe(false)
    expect(out.some((f) => readSyntheticKind(f) === "hook-rewrite")).toBe(false)
  })
})
