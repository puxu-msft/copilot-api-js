/**
 * Per-session subagent ordinal registry.
 *
 * Claude Code tags each subagent request with a stable `x-claude-code-agent-id`
 * (an opaque string); the main agent sends none. To render subagents as `❶❷…`
 * (see `~/lib/observability/projections/session-block.ts`) we assign each distinct
 * `agentId` a small 1-based ordinal in FIRST-SEEN order WITHIN its `sessionId`, so
 * `❶` reads as "the first subagent of this conversation".
 *
 * State is process-lifetime and unbounded by design (a long-lived proxy sees few
 * sessions/agents relative to requests; entries are tiny). It resets on restart —
 * ordinals are a display convenience, not persisted identity.
 */
export class AgentOrdinalRegistry {
  /** sessionId → (agentId → 1-based ordinal), assigned in first-seen order. */
  private readonly bySession = new Map<string, Map<string, number>>()

  /**
   * The 1-based ordinal for `agentId` within `sessionId`, assigning the next free
   * number on first sight. Returns `undefined` for a main-agent request (no
   * `agentId`) or when `sessionId` is absent — neither is numbered.
   */
  ordinalFor(sessionId: string | undefined, agentId: string | undefined): number | undefined {
    if (!sessionId || agentId === undefined) return undefined
    let agents = this.bySession.get(sessionId)
    if (!agents) {
      agents = new Map()
      this.bySession.set(sessionId, agents)
    }
    const existing = agents.get(agentId)
    if (existing !== undefined) return existing
    const next = agents.size + 1
    agents.set(agentId, next)
    return next
  }
}
