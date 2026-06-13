/**
 * Central event bus for the observability subsystem.
 *
 * Producers obtain a typed `ScopedPublisher<NS>` via `bus.scope(NS)` and
 * may only publish events whose `kind` starts with that namespace — the
 * type-system enforces ownership (see `events.ts` "Namespacing"). Sinks
 * subscribe via `bus.subscribe(handler, filter?)` and run in registration
 * order inside isolated try/catch blocks, so one sink throwing does not
 * stop fan-out to the rest (mirrors the existing
 * `RequestContextManager.emit` contract, manager.ts:175-188).
 *
 * `publish(event)` is synchronous; if a handler is async, its promise is
 * NOT awaited. Use `publishAndFlush(event, { deadlineMs })` when the
 * caller must wait for sinks to settle — currently used by shutdown to
 * guarantee WS clients drain before the next phase advances.
 *
 * The bus carries no global state of its own. The singleton in
 * `src/start.ts` is created via `initBus()`; tests construct fresh buses
 * via `createBus()` and pass them by DI to sinks/producers. This keeps
 * sinks independently unit-testable without `mock.module` or
 * `setRenderer`-style singleton mutation.
 */

import consola from "consola"

import type {
  //
  EventNamespace,
  ObservabilityEvent,
} from "./events"

// ============================================================================
// Public types
// ============================================================================

export type EventFilter = (event: ObservabilityEvent) => boolean

export type EventHandler = (event: ObservabilityEvent) => void | Promise<void>

/**
 * Outcome of `publishAndFlush`. `pendingWsBuffer` is the count of WebSocket
 * clients whose `bufferedAmount` is still non-zero when the deadline elapses
 * (mirrors the current `notifyShutdownPhaseChangedAndFlush` return shape).
 * Other sinks complete synchronously and contribute 0 to this count.
 */
export interface FlushResult {
  pendingWsBuffer: number
}

/**
 * A namespace-scoped publisher. Producers receive one via DI and may only
 * publish events whose `kind` starts with that namespace.
 *
 * The template-literal `Extract` parameter rejects cross-namespace publishes
 * at compile time: `requestPub.publish({ kind: "history.entry_added", ... })`
 * is a `tsc` error because `Extract<ObservabilityEvent, { kind: \`request.${string}\` }>`
 * excludes `history.*`. No runtime check needed.
 */
export interface ScopedPublisher<NS extends EventNamespace> {
  publish(event: Extract<ObservabilityEvent, { kind: `${NS}.${string}` }>): void
  publishAndFlush(event: Extract<ObservabilityEvent, { kind: `${NS}.${string}` }>, opts?: { deadlineMs?: number }): Promise<FlushResult>
}

export interface ObservabilityBus {
  /** Mint a scoped publisher for the given namespace (called once per producer at `start.ts`). */
  scope<NS extends EventNamespace>(namespace: NS): ScopedPublisher<NS>

  /**
   * Subscribe with optional filter. Returns an unsubscribe function.
   *
   * Handler errors are caught and `consola.warn`-logged; fan-out continues
   * to the remaining handlers. Async handlers' promises are NOT awaited by
   * `publish` (use `publishAndFlush` when settling matters).
   */
  subscribe(handler: EventHandler, filter?: EventFilter): () => void

  /** Drain pending in-flight async handler promises. For tests and shutdown. */
  flush(): Promise<void>
}

// ============================================================================
// Implementation
// ============================================================================

interface Registration {
  handler: EventHandler
  filter: EventFilter | undefined
  /** Promises returned by async handler invocations, awaited by `flush()`. */
  inFlight: Set<Promise<void>>
}

export function createBus(): ObservabilityBus {
  const registrations = new Set<Registration>()

  function publishSync(event: ObservabilityEvent): Array<Promise<void>> {
    const pending: Array<Promise<void>> = []
    for (const reg of registrations) {
      // Local alias avoids unicorn/no-array-callback-reference flagging
      // `reg.filter(event)` as if `event` were a callback identifier.
      const predicate = reg.filter
      if (predicate && !predicate(event)) continue
      try {
        const ret = reg.handler(event)
        if (ret instanceof Promise) {
          const tracked = ret.catch((err: unknown) => {
            consola.warn(`[observability/bus] async handler rejected for ${event.kind}:`, err instanceof Error ? err.message : err)
          })
          reg.inFlight.add(tracked)
          void tracked.finally(() => reg.inFlight.delete(tracked))
          pending.push(tracked)
        }
      } catch (err: unknown) {
        // Isolate handler failures — one bad sink must not stop fan-out.
        consola.warn(`[observability/bus] handler threw for ${event.kind}:`, err instanceof Error ? err.message : err)
      }
    }
    return pending
  }

  function makeScope<NS extends EventNamespace>(_namespace: NS): ScopedPublisher<NS> {
    // The namespace argument is only retained for diagnostics if we ever
    // want a runtime cross-check. Type-level Extract already prevents
    // cross-namespace publishes at the call site.
    return {
      publish(event) {
        // Sync handlers are fan-out; async handlers' returned promises are
        // tracked in publishSync and surfaced via bus.flush() / publishAndFlush.
        // The caller of `publish` is intentionally not awaiting them.
        void publishSync(event)
      },
      async publishAndFlush(event, opts) {
        const pending = publishSync(event)
        const deadlineMs = opts?.deadlineMs

        if (pending.length > 0) {
          if (deadlineMs && deadlineMs > 0) {
            await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, deadlineMs))])
          } else {
            await Promise.allSettled(pending)
          }
        }

        // `pendingWsBuffer` is filled by WsSink via its own protocol —
        // sinks that want to report a deadline-exceeded count attach a
        // sentinel on the promise; today we return 0 as a placeholder
        // and let WsSink override this when it lands in commit 2.
        return { pendingWsBuffer: 0 }
      },
    }
  }

  return {
    scope: makeScope,
    subscribe(handler, filter) {
      const reg: Registration = { handler, filter, inFlight: new Set() }
      registrations.add(reg)
      return () => {
        registrations.delete(reg)
      }
    },
    async flush() {
      const all: Array<Promise<void>> = []
      for (const reg of registrations) {
        for (const p of reg.inFlight) all.push(p)
      }
      if (all.length > 0) await Promise.allSettled(all)
    },
  }
}

// ============================================================================
// Singleton accessor (only `src/start.ts` calls these directly)
// ============================================================================

let _bus: ObservabilityBus | null = null

export function initBus(): ObservabilityBus {
  _bus = createBus()
  return _bus
}

export function getBus(): ObservabilityBus {
  if (!_bus) throw new Error("Observability bus not initialized — call initBus() first")
  return _bus
}

export function resetBusForTests(): ObservabilityBus {
  _bus = createBus()
  return _bus
}
