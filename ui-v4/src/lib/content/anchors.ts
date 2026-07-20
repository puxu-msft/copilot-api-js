/**
 * DOM anchor id scheme for in-request navigation — the single source of truth shared by the
 * renderer that EMITS these ids ([ContentRenderer] / [MessageBlock]) and every consumer that
 * targets them ([buildMessageTocNodes] for the TOC, [buildToolPairing] for tool jumps). Keeping
 * the format in one place makes the cross-module contract compiler-checkable instead of a
 * convention three files must independently uphold.
 *
 *   - message i:            `${anchorPrefix}-msg-${i}`
 *   - block j of message i: `${anchorPrefix}-msg-${i}-blk-${j}`
 */
export function messageAnchorId(anchorPrefix: string, messageIndex: number): string {
  return `${anchorPrefix}-msg-${messageIndex}`
}

export function blockAnchorId(anchorPrefix: string, messageIndex: number, blockIndex: number): string {
  return `${messageAnchorId(anchorPrefix, messageIndex)}-blk-${blockIndex}`
}

/**
 * System payloads have no message layer, so their blocks anchor directly:
 *   - block i: `${anchorPrefix}-blk-${i}`
 * Shared by `buildSystemTocNodes` (TOC) and `SystemMessage` (renderer).
 */
export function systemBlockAnchorId(anchorPrefix: string, blockIndex: number): string {
  return `${anchorPrefix}-blk-${blockIndex}`
}
