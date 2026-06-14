/**
 * Observability subsystem public surface.
 *
 * This barrel re-exports the bus + event types for producers (via
 * `ScopedPublisher<NS>`) and the formatting projections for sinks.
 *
 * Sinks live in `./sinks/*` and are wired in `src/start.ts` (see RFC
 * `docs/rfc/observability-rewrite.md` §2.5 for the init order).
 *
 * Dependency contract (enforced by ESLint `no-restricted-imports`, added
 * in this commit):
 * - `lib/{request,anthropic,openai,gemini,history,ws}/` MUST NOT import
 *   from this module.
 * - `routes/*` MUST NOT import from `./sinks/*` or `./bus`.
 * - `lib/context/*` MAY import from this module (it owns the
 *   `ScopedPublisher<"request">` injection point).
 * - `src/start.ts` is the only file that may construct the bus or mint
 *   scoped publishers.
 */

export type { EventFilter, EventHandler, FlushResult, ObservabilityBus, ScopedPublisher } from "./bus"
export { createBus, getBus, initBus, resetBusForTests } from "./bus"

export type {
  AttemptSnapshot,
  EventKind,
  EventNamespace,
  FeatureKind,
  ObservabilityEvent,
  RateLimitMode,
  RequestActivitySnapshot,
  RequestContextLive,
  RequestContextSnapshot,
  ShutdownPhase,
  TransportKind,
} from "./events"
export { assertNever } from "./events"
