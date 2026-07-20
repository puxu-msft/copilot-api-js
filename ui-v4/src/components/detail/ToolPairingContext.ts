import {
  //
  createContext,
  useContext,
} from "react"

import type { ToolPair } from "@/lib/content/tool-pairing"

/** Conversation-scoped tool-call ↔ tool-result navigation: the pairing map + a scroll-to-anchor fn. */
export interface ToolPairingValue {
  pairing: Map<string, ToolPair>
  scrollTo: (anchorId: string) => void
}

/**
 * Provided by the rendered conversation (ConvoSegment) so `tool_use` / `tool_result` blocks can
 * offer jump-to-counterpart buttons. `null` outside a conversation (e.g. ResponseSegment) → blocks
 * render without jump affordances.
 */
const ToolPairingContext = createContext<ToolPairingValue | null>(null)

export const ToolPairingProvider = ToolPairingContext.Provider

export function useToolPairing(): ToolPairingValue | null {
  return useContext(ToolPairingContext)
}
