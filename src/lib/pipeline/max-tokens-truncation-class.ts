import type { TerminalObserverState } from "./max-tokens-terminal-observer"

export type TruncationClass = "text" | "tool_use" | "tool_use_closed" | "thinking"

/**
 * Classify a max_tokens terminal from the independent observer's final wire state.
 *
 * This deliberately does not read the continuation ledger: replayability of earlier committed
 * blocks is a separate concern from identifying the actual block that was truncated.
 */
export function classifyMaxTokensTruncation(observer: TerminalObserverState): TruncationClass | undefined {
  switch (observer.lastBlockKind) {
    case "text":
      return "text"
    case "tool_use":
      return observer.lastBlockClosed ? "tool_use_closed" : "tool_use"
    case "thinking":
      return "thinking"
    case undefined:
      return undefined
  }
}
