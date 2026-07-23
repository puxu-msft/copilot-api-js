export type TerminalBlockKind = "text" | "tool_use" | "thinking"

/**
 * Per-request terminal state derived from the final rendered wire block.
 *
 * This is intentionally independent of the continuation ledger: the ledger preserves only closed,
 * replayable blocks and therefore cannot distinguish partial text, an open tool call, or thinking
 * that followed an earlier committed text block.
 */
export interface TerminalObserverState {
  lastBlockKind: TerminalBlockKind | undefined
  lastBlockClosed: boolean
}

interface AnthropicObservedFrame {
  type: string
  index?: number
  content_block?: { type: string }
}

// The public observer shape stays format-neutral for P3. Index identity is only needed by the
// Anthropic updater to reject a late stop for an older block, so keep it private to this adapter.
const lastAnthropicBlockIndex = new WeakMap<TerminalObserverState, number>()

export function createTerminalObserver(): TerminalObserverState {
  const state = { lastBlockKind: undefined, lastBlockClosed: false }
  lastAnthropicBlockIndex.set(state, -1)
  return state
}

/** Update the observer from an already-rendered Anthropic frame without reparsing wire data. */
export function updateAnthropicTerminalObserver(state: TerminalObserverState, frame: AnthropicObservedFrame): void {
  if (frame.type === "content_block_start") {
    const kind = frame.content_block?.type
    if (kind === "text" || kind === "tool_use" || kind === "thinking") {
      state.lastBlockKind = kind
      state.lastBlockClosed = false
      lastAnthropicBlockIndex.set(state, frame.index ?? -1)
    }
    return
  }

  if (frame.type === "content_block_stop" && frame.index === lastAnthropicBlockIndex.get(state)) {
    // A terminal observer only tracks the last opened block. A delayed stop for an older block
    // must not make a newer last block appear closed.
    state.lastBlockClosed = state.lastBlockKind !== undefined
  }
}
