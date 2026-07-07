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
 * Deterministic, collision-safe string encoding of a {@link QuarantineKey}, used
 * as the map/cache key. JSON-encoding the `(sessionId, agentId)` pair keeps the
 * structure unambiguous even when a field contains a space, quote, or other
 * delimiter-like character, so no two distinct pairs can ever collide.
 *
 * The store (Task 9) MUST hydrate its in-memory cache through this exact
 * function so the cache keys and the DB rows agree; any change here must stay in
 * lockstep with the store.
 */
export function keyString(k: QuarantineKey): string {
  return JSON.stringify([k.sessionId, k.agentId])
}
