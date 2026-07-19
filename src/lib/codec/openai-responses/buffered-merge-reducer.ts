import type {
  //
  BufferedFlushContext,
  ClientFrame,
} from "~/lib/pipeline/types"
import type { ResponsesOutputItem } from "~/types/api/openai-responses"

import { tagFrameSynthetic } from "~/lib/pipeline/frame-origin"

const DROPPABLE_DELTA_TYPES: ReadonlySet<string> = new Set([
  "response.output_text.delta",
  "response.function_call_arguments.delta",
  "response.refusal.delta",
  "response.reasoning_text.delta",
  "response.reasoning_summary_text.delta",
])

/** item-summary collapses a closed item to just its `output_item.added` + `output_item.done`. Beyond
 *  the deltas (dropped by DROPPABLE_DELTA_TYPES), these intermediate sub-frames are also dropped — the
 *  terminal `output_item.done` carries the complete item, so they lose no final-state info. Includes
 *  `output_text.annotation.added` (GPT-audit HIGH fix, Task 0.2b/2.3): it has the SAME minefield shape
 *  as `output_text.done` (SDK accumulator getContent(content_index) throws when its content_part.added
 *  was dropped), so it MUST be dropped together with content_part — never left an orphan reference. */
const ITEM_SUMMARY_ONLY_SUBFRAME_TYPES: ReadonlySet<string> = new Set([
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.done",
  "response.output_text.annotation.added",
  "response.refusal.done",
  "response.reasoning_text.done",
  "response.function_call_arguments.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.done",
])

interface ParsedFrame {
  type: string
  data: Record<string, unknown>
}

function parseResponsesFrame(frame: ClientFrame): ParsedFrame | undefined {
  if (!frame.data) return undefined
  try {
    const data = JSON.parse(frame.data) as Record<string, unknown>
    const type = frame.event ?? (typeof data.type === "string" ? data.type : undefined)
    return type ? { type, data } : undefined
  } catch {
    return undefined
  }
}

const TERMINAL_TYPES: ReadonlySet<string> = new Set(["response.completed", "response.failed", "response.incomplete"])

/** Reverse-scan for the terminal frame in a flush batch. Terminal frames are themselves commit
 *  boundaries, so if one is present in this batch it is the batch's own trigger (near the end). */
function locateTerminal(frames: ReadonlyArray<ClientFrame>): { index: number; parsed: ParsedFrame } | undefined {
  for (let i = frames.length - 1; i >= 0; i--) {
    const parsed = parseResponsesFrame(frames[i])
    if (parsed && TERMINAL_TYPES.has(parsed.type)) return { index: i, parsed }
  }
  return undefined
}

export type TerminalRepairReason = "empty-output" | "missing-item" | "inconsistent-item"

/** Defect oracle for the `repair-if-incomplete` gate: does the upstream terminal snapshot's `output`
 *  faithfully cover every item we collected from `output_item.done`? Complete → keep upstream verbatim
 *  (never dethrone the authoritative snapshot); incomplete → the reason drives a rebuild. */
export function isTerminalSnapshotComplete(
  output: ReadonlyArray<ResponsesOutputItem>,
  collected: ReadonlyMap<number, ResponsesOutputItem>,
): { complete: true } | { complete: false; reason: TerminalRepairReason } {
  if (output.length === 0 && collected.size > 0) return { complete: false, reason: "empty-output" }
  const byId = new Map(output.map((item) => [item.id, item] as const))
  for (const collectedItem of collected.values()) {
    const match = byId.get(collectedItem.id)
    if (!match) return { complete: false, reason: "missing-item" }
    if (!itemsEquivalent(match, collectedItem)) return { complete: false, reason: "inconsistent-item" }
  }
  return { complete: true }
}

function itemsEquivalent(a: ResponsesOutputItem, b: ResponsesOutputItem): boolean {
  if (a.type !== b.type) return false
  if (a.type === "function_call" && b.type === "function_call") return a.arguments === b.arguments && a.call_id === b.call_id
  if (a.type === "message" && b.type === "message") return JSON.stringify(a.content) === JSON.stringify(b.content)
  if (a.type === "reasoning" && b.type === "reasoning")
    return JSON.stringify(a.summary) === JSON.stringify(b.summary) && a.encrypted_content === b.encrypted_content
  return false
}

export interface ResponsesBufferedMergeOpts {
  eventCompaction: "verbatim" | "drop-delta" | "item-summary"
  completedOutput: "upstream" | "repair-if-incomplete" | "rebuild"
}

export interface ResponsesBufferedMergeReducer {
  observe(frame: ClientFrame): void
  transformFlush(frames: ReadonlyArray<ClientFrame>, ctx: BufferedFlushContext): ReadonlyArray<ClientFrame>
}

export interface BufferedMergeDiag {
  eventCompaction: "verbatim" | "drop-delta" | "item-summary"
  completedOutput: "upstream" | "repair-if-incomplete" | "rebuild"
  droppedEventCount: number
  droppedEventBytes: number
  droppedEventTypes: Array<string>
  repairedItemCount: number
  repairReasons: Array<TerminalRepairReason>
  /** Flushes returned verbatim (compaction bypassed). Currently only `"retreat"` (buffer-cap forfeit) is
   *  recorded; an open-item-at-terminal-failure keeps its deltas verbatim BY CONSTRUCTION (an unclosed item
   *  is never in `collected`, so drop-delta never touches it) — no explicit fallback push is needed for
   *  correctness. Recording that case as its own diagnostic is deferred (docs/todo/deferred-backlog.md). */
  verbatimFallbacks: Array<"retreat">
}

export function createResponsesBufferedMergeReducer(opts: ResponsesBufferedMergeOpts): ResponsesBufferedMergeReducer & { diagnostics(): BufferedMergeDiag } {
  // NOTE: no resetAttempt — candidate-hosted (spec §4 2026-07-19 重接地): a fresh candidate session
  // per retry/recovery means a fresh closure over `collected`, so per-attempt state is fresh by
  // construction. The driver has no lifecycle hook to reset THIS closure — there is nothing to reset.
  const collected = new Map<number, ResponsesOutputItem>()
  let droppedEventCount = 0
  let droppedEventBytes = 0
  const droppedEventTypes: Array<string> = []
  let repairedItemCount = 0
  const repairReasons: Array<TerminalRepairReason> = []
  const verbatimFallbacks: Array<"retreat"> = []

  return {
    observe(frame: ClientFrame) {
      const parsed = parseResponsesFrame(frame)
      if (parsed?.type === "response.output_item.done" && typeof parsed.data.output_index === "number") {
        collected.set(parsed.data.output_index, parsed.data.item as ResponsesOutputItem)
      }
    },
    transformFlush(frames: ReadonlyArray<ClientFrame>, ctx: BufferedFlushContext): ReadonlyArray<ClientFrame> {
      if (ctx.cause === "retreat") {
        verbatimFallbacks.push("retreat")
        return frames
      }
      if (opts.eventCompaction === "verbatim") return frames
      const working: Array<ClientFrame> = []
      for (const f of frames) {
        const parsed = parseResponsesFrame(f)
        if (!parsed) {
          working.push(f)
          continue
        }
        const outputIndex = typeof parsed.data.output_index === "number" ? parsed.data.output_index : undefined
        const closed = outputIndex !== undefined && collected.has(outputIndex)
        const dropAsDelta = closed && DROPPABLE_DELTA_TYPES.has(parsed.type)
        const dropAsItemSummarySubframe = closed && opts.eventCompaction === "item-summary" && ITEM_SUMMARY_ONLY_SUBFRAME_TYPES.has(parsed.type)
        if (dropAsDelta || dropAsItemSummarySubframe) {
          droppedEventCount++
          // GPT-audit suggestion: align byte accounting with the driver's own bufferedBytes calc
          // (driver.ts:1138 — `(toWrite.data?.length ?? 0) + (toWrite.event?.length ?? 0)`), so the
          // diagnostic number is comparable to the buffer-cap accounting the driver already does.
          droppedEventBytes += (f.data?.length ?? 0) + (f.event?.length ?? 0)
          if (!droppedEventTypes.includes(parsed.type)) droppedEventTypes.push(parsed.type)
          continue
        }
        working.push(f)
      }
      // Terminal-snapshot reconciliation (completed_output). `upstream` (or no terminal in this batch)
      // is a no-op — never dethrone the authoritative upstream snapshot. `repair-if-incomplete` rebuilds
      // ONLY when isTerminalSnapshotComplete() finds a defect; `rebuild` always rebuilds. The rebuilt
      // terminal frame is tagged synthetic "buffered-terminal-repair" (spec §6: only generative frames
      // are marked — a subtractive drop is the absence of a frame, recoverable from the two-track diff).
      const terminal = locateTerminal(working)
      if (!terminal || opts.completedOutput === "upstream") return working
      const response = terminal.parsed.data.response as { output: Array<ResponsesOutputItem> } & Record<string, unknown>
      let shouldRebuild = opts.completedOutput === "rebuild"
      if (opts.completedOutput === "repair-if-incomplete") {
        const verdict = isTerminalSnapshotComplete(response.output, collected)
        shouldRebuild = !verdict.complete
        if (!verdict.complete) repairReasons.push(verdict.reason)
      }
      if (!shouldRebuild) return working
      const rebuiltOutput = Array.from(collected.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, item]) => item)
      repairedItemCount = rebuiltOutput.length
      const newResponse = { ...response, output: rebuiltOutput }
      const newFrame = tagFrameSynthetic(
        { ...working[terminal.index], data: JSON.stringify({ ...terminal.parsed.data, response: newResponse }) },
        "buffered-terminal-repair",
      )
      const result = working.slice()
      result[terminal.index] = newFrame
      return result
    },
    diagnostics(): BufferedMergeDiag {
      return {
        eventCompaction: opts.eventCompaction,
        completedOutput: opts.completedOutput,
        droppedEventCount,
        droppedEventBytes,
        droppedEventTypes: [...droppedEventTypes],
        repairedItemCount,
        repairReasons: [...repairReasons],
        verbatimFallbacks: [...verbatimFallbacks],
      }
    },
  }
}
