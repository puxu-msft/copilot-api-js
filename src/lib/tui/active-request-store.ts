import type {
  //
  AttemptSnapshot,
  RequestContextSnapshot,
} from "~/lib/observability"

import { isTerminalState } from "~/lib/history/lifecycle-state"

export interface ActiveRequest {
  ctx: RequestContextSnapshot
  streamBytesIn?: number
  streamEventsIn?: number
  streamBlockType?: string
  tags: Array<string>
  recoveredToolNames?: Array<string>
  thinking?: { requested?: string; effective: string }
  isHistoryAccess: boolean
  statusCode?: number
  attemptCount: number
  attempts: Array<AttemptSnapshot>
}

/** Purely owns active-request presentation state; no terminal or controller concerns. */
export class ActiveRequestStore {
  private readonly entries = new Map<string, ActiveRequest>()

  get size(): number {
    return this.entries.size
  }

  get(id: string): ActiveRequest | undefined {
    return this.entries.get(id)
  }

  values(): IterableIterator<ActiveRequest> {
    return this.entries.values()
  }

  orderedIds(): Array<string> {
    return [...this.entries.keys()]
  }

  create(ctx: RequestContextSnapshot): ActiveRequest {
    const entry = newEntry(ctx)
    this.entries.set(ctx.id, entry)
    return entry
  }

  upsert(ctx: RequestContextSnapshot): { entry: ActiveRequest; inserted: boolean } {
    const existing = this.entries.get(ctx.id)
    if (existing) {
      existing.ctx = ctx
      return { entry: existing, inserted: false }
    }
    const entry = newEntry(ctx)
    if (!isTerminalState(ctx.state)) this.entries.set(ctx.id, entry)
    return { entry, inserted: !isTerminalState(ctx.state) }
  }

  remove(id: string): ActiveRequest | undefined {
    const entry = this.entries.get(id)
    this.entries.delete(id)
    return entry
  }

  recordAttempt(entry: ActiveRequest, snapshot: AttemptSnapshot): void {
    const existing = entry.attempts.findIndex((attempt) => attempt.attemptIndex === snapshot.attemptIndex)
    if (existing === -1) entry.attempts.push(snapshot)
    else entry.attempts[existing] = snapshot
  }

  clear(): void {
    this.entries.clear()
  }
}

function newEntry(ctx: RequestContextSnapshot): ActiveRequest {
  return { ctx, tags: [], isHistoryAccess: ctx.path.startsWith("/history"), attemptCount: 0, attempts: [] }
}
