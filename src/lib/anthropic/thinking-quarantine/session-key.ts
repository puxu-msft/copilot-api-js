export interface QuarantineKey {
  sessionId: string
  agentId: string
}

/**
 * Normalize a `(session, agent)` pair into a durable quarantine key.
 *
 * The main agent carries no `x-claude-code-agent-id` header, so its `agentId`
 * normalizes to `""` — distinct from any real subagent id, and stable across
 * turns of the same conversation.
 *
 * Returns `null` when there is no `sessionId`: without a durable session
 * identifier we cannot remember a poisoned conversation across turns, so it
 * cannot be quarantined at L3.
 */
export function toQuarantineKey(sessionId: string | undefined, agentId: string | undefined): QuarantineKey | null {
  if (!sessionId) return null
  return { sessionId, agentId: agentId ?? "" }
}

/**
 * Stable, collision-safe string encoding of a {@link QuarantineKey}, used as the
 * map/cache key. The store (Task 9) hydrates its in-memory cache with this exact
 * encoding, so any change here must stay in lockstep with the store.
 */
export function keyString(k: QuarantineKey): string {
  return `${k.sessionId} ${k.agentId}`
}
