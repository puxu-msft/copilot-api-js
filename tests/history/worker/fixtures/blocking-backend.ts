import type { HistoryWorkerBackend } from "~/lib/history/worker/backend"

/**
 * Burn `ms` of wall-clock WITHOUT yielding — the shape of work this migration exists to move off the main thread.
 *
 * A `setTimeout`/`await` would prove nothing: the event loop stays responsive across those, and the whole question is what happens when it cannot. SQLite's schema reconcile, migrations, journal recovery and commit are all synchronous C calls with exactly this profile.
 */
export function busyWaitMs(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // Deliberately spinning: yielding here would defeat the purpose.
  }
}

/**
 * Wrap a backend so its two heavyweight entry points block synchronously first.
 *
 * Shared by the real-Worker fixture entry and the in-process negative control so that both arms inject the SAME block — if each built its own, a difference in the observation could be a difference in the injection instead of a difference in isolation, which is the one thing this pair must not be ambiguous about.
 */
export function withSynchronousBlock(backend: HistoryWorkerBackend, blockMs: number): HistoryWorkerBackend {
  return {
    ...backend,
    initialize: async (config) => {
      busyWaitMs(blockMs)
      return await backend.initialize(config)
    },
    persist: async (envelope) => {
      busyWaitMs(blockMs)
      return await backend.persist(envelope)
    },
  }
}
