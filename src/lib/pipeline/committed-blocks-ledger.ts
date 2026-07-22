/**
 * Committed-blocks ledger — the data source for continuation-retry (spec
 * 2026-07-22-continuation-retry-and-sequential-anchor §4.2). Accumulates a canonical snapshot of
 * every content block that has been FULLY committed (flushed past a `commitBoundaries` boundary) to
 * the client. A partial block — one still buffering, or cut mid-generation by a transport RST — is
 * NEVER recorded (the driver only calls `recordCommitted` at a commit boundary).
 *
 * On a mid-stream failure the continuation-request-builder reads {@link CommittedBlocksLedger.snapshot}
 * to reconstruct the already-delivered prefix as a synthetic assistant turn, so the upstream continues
 * from where it left off rather than restarting. The ledger is cumulative ACROSS retry attempts
 * (`onAttemptReset` must NOT clear it — the committed prefix stays committed), so it has no reset op.
 */

/** A committed content block in canonical (client-native) form. Union grows with new block types. */
export type CanonicalBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }

export interface CommittedBlocksLedger {
  /** Record one FULLY-committed block (called by the driver at each commit boundary). */
  recordCommitted: (block: CanonicalBlock) => void
  /** A defensive copy of the committed blocks in commit order (safe for the caller to mutate). */
  snapshot: () => Array<CanonicalBlock>
}

export function createCommittedBlocksLedger(): CommittedBlocksLedger {
  const blocks: Array<CanonicalBlock> = []
  return {
    recordCommitted: (block) => void blocks.push(block),
    snapshot: () => blocks.map((b) => ({ ...b })),
  }
}
