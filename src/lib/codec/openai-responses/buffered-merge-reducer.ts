import type { BufferedFlushContext, ClientFrame } from "~/lib/pipeline/types"
import type { ResponsesOutputItem } from "~/types/api/openai-responses"

const DROPPABLE_DELTA_TYPES: ReadonlySet<string> = new Set([
  "response.output_text.delta",
  "response.function_call_arguments.delta",
  "response.refusal.delta",
  "response.reasoning_text.delta",
  "response.reasoning_summary_text.delta",
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

export interface ResponsesBufferedMergeOpts {
  eventCompaction: "verbatim" | "drop-delta" | "item-summary"
  completedOutput: "upstream" | "repair-if-incomplete" | "rebuild"
}

export interface ResponsesBufferedMergeReducer {
  observe(frame: ClientFrame): void
  transformFlush(frames: readonly ClientFrame[], ctx: BufferedFlushContext): readonly ClientFrame[]
}

export function createResponsesBufferedMergeReducer(opts: ResponsesBufferedMergeOpts): ResponsesBufferedMergeReducer {
  // NOTE: no resetAttempt — candidate-hosted (spec §4 2026-07-19 重接地): a fresh candidate session
  // per retry/recovery means a fresh closure over `collected`, so per-attempt state is fresh by
  // construction. The driver has no lifecycle hook to reset THIS closure — there is nothing to reset.
  const collected = new Map<number, ResponsesOutputItem>()

  return {
    observe(frame: ClientFrame) {
      const parsed = parseResponsesFrame(frame)
      if (parsed?.type === "response.output_item.done" && typeof parsed.data.output_index === "number") {
        collected.set(parsed.data.output_index, parsed.data.item as ResponsesOutputItem)
      }
    },
    transformFlush(frames: readonly ClientFrame[], ctx: BufferedFlushContext): readonly ClientFrame[] {
      if (ctx.cause === "retreat") return frames
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
        if (closed && DROPPABLE_DELTA_TYPES.has(parsed.type)) continue
        working.push(f)
      }
      return working
    },
  }
}
