/**
 * Deterministic fake clock for tests that exercise `setTimeout`-driven timers (heartbeat cadence,
 * ③ pre-response grace window) without real wall-clock waits. Intercepts `setTimeout`/`clearTimeout`/
 * `Date.now`; `advance(ms)` fires all due timers in order, draining microtasks between each so the
 * code-under-test's `await`s settle. (Extracted from streaming-l2-buffered.http.test.ts — the third
 * user is the ③ pre-stream-grace tests.)
 */
export class FakeClock {
  now = 1_000_000
  private nextId = 1
  private timers = new Map<number, { fireAt: number; cb: () => void; cleared?: boolean }>()
  private origSet = globalThis.setTimeout
  private origClear = globalThis.clearTimeout
  private origNow = Date.now
  /**
   * Delays the caller chose NOT to fake, armed on the real host timer. Two properties this set
   * relies on: an entry is removed when it fires ({@link install}) or when the caller clears it,
   * and {@link restore} clears whatever is left, so a non-intercepted timer can never outlive the
   * clock that armed it.
   *
   * The membership test in the patched `clearTimeout` is what keeps the two id spaces apart, and it
   * works because Bun's `setTimeout` returns a `Timeout` OBJECT while faked ids are plain numbers:
   * `Set.delete` uses SameValueZero and never coerces, so a fake id of `1` cannot cancel a real
   * `Timeout` whose `valueOf()` is also `1` (verified by forcing exactly that alias). On a host
   * where `setTimeout` returns a number instead — browser semantics — that separation disappears
   * and this routing would need real tagging.
   */
  private realTimers = new Set<ReturnType<typeof setTimeout>>()

  readonly realSetTimeout = this.origSet.bind(globalThis)

  install(options: { intercept?: (delayMs: number) => boolean } = {}): void {
    this.now = 1_000_000
    this.nextId = 1
    this.timers.clear()
    // Dropping references to real timers would orphan them: unlike the lazily-fired fake entries
    // above, these are armed on the host and would go on firing into whatever test runs next,
    // past a restore() that no longer knows about them.
    for (const timer of this.realTimers) this.origClear(timer)
    this.realTimers.clear()
    Date.now = () => this.now
    ;(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((cb: () => void, ms: number) => {
      const delayMs = ms || 0
      if (options.intercept && !options.intercept(delayMs)) {
        const id: ReturnType<typeof setTimeout> = this.origSet(() => {
          this.realTimers.delete(id)
          cb()
        }, delayMs)
        this.realTimers.add(id)
        return id
      }
      const id = this.nextId++
      this.timers.set(id, { fireAt: this.now + delayMs, cb })
      return id as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    ;(globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      if (this.realTimers.delete(id)) {
        this.origClear(id)
        return
      }
      const e = this.timers.get(id as unknown as number)
      if (e) e.cleared = true
    }) as typeof clearTimeout
  }

  restore(): void {
    Date.now = this.origNow
    globalThis.setTimeout = this.origSet
    globalThis.clearTimeout = this.origClear
    for (const timer of this.realTimers) this.origClear(timer)
    this.realTimers.clear()
  }

  /**
   * Number of timers that are still LIVE — armed, not yet fired, not cleared. A fired timer is
   * `delete`d from the map by {@link advance}; a `clearTimeout`'d one is flagged `cleared`. So a
   * "rearm WITHOUT clearTimeout-first" leak surfaces here as an EXTRA live entry. This is the
   * load-bearing oracle for the §4.4 "suspend→resume leaves EXACTLY one timer" invariant — the ping
   * count alone is blind to it, because a leaked timer that fires mid-interval reschedules without a
   * ping (elapsed < interval) instead of emitting an observable extra ping.
   */
  get liveTimerCount(): number {
    let n = 0
    for (const t of this.timers.values()) if (!t.cleared) n++
    return n
  }

  /** Remaining delay of every live timer, sorted. Lets integration tests distinguish a leaked
   * short-cadence heartbeat from unrelated long-lived runtime timers without depending on timer IDs. */
  get liveTimerDelaysMs(): Array<number> {
    return [...this.timers.values()]
      .filter((timer) => !timer.cleared)
      .map((timer) => timer.fireAt - this.now)
      .sort((a, b) => a - b)
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => !t.cleared && t.fireAt <= target).sort(([, a], [, b]) => a.fireAt - b.fireAt)
      if (due.length === 0) break
      const [id, entry] = due[0]
      this.now = entry.fireAt
      this.timers.delete(id)
      entry.cb()
      await Promise.resolve()
      await Promise.resolve()
    }
    this.now = target
  }
}
