import type { SseFrame } from "~/lib/stream"

/** The flush-triggering cause plus the frame that closed a boundary, when applicable. */
export interface BufferedFlushContext {
  cause: "boundary" | "terminal-drain" | "retreat"
  boundaryFrame?: SseFrame
}
