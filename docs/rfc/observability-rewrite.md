# RFC: Observability Subsystem Rewrite

**Status:** v4 — all §6 open questions resolved 2026-06-13. Ready to implement on user signal.
**Author:** ECC + 3 rounds of subagent adversarial audit (consensus).
**Driver:** 长远架构健康（用户原则，对话已确认）。
**Scope:** Replace the `src/lib/tui/` subsystem and the ad-hoc `notifyActiveRequestChanged` / `notifyEntry*` broadcast calls with a single event-bus + sinks architecture. Eliminate 10 distinct architecture debts (D1–D10 below).

---

## 1. Problem statement

Today, observation of request lifecycles is implemented as a **5+-year accretion of bypasses** rather than a coherent subsystem. Concrete evidence (counts verified via `grep -rn` 2026-06):

| ID | Debt | Evidence | Origin |
|---|---|---|---|
| D1 | `tracker.ts` mixes 3 jobs (state machine, footer queue mgmt, render dispatch) | [src/lib/tui/tracker.ts:29-237](../src/lib/tui/tracker.ts#L29-L237) | Single-class catch-all |
| D2 | 36 `tuiLogger.*` calls across 12 files; `finishRequest` is **idempotent on purpose** to absorb double-emission | [src/lib/tui/middleware.ts:7-18](../src/lib/tui/middleware.ts#L7-L18) (file comment self-describes the debt) | No event protocol |
| D3 | 3 state machines (`RequestContext.state` / `HistoryEntry.state` / `TuiLogEntry.status`) with hand-rolled mapping | [src/lib/context/consumers.ts:194-200](../src/lib/context/consumers.ts#L194-L200); `interrupted` only exists in History layer | Each layer invented its own |
| D4 | `TuiLogEntry` 30+ fields duplicate `RequestContext.response.usage` / `attempts` / `queueWaitMs` | [src/lib/tui/types.ts:5-45](../src/lib/tui/types.ts#L5-L45) | Layer copied data instead of reading it |
| D5 | **Reverse import**: `pipeline.ts` / `anthropic/pipeline.ts` / `shutdown.ts` import the UI singleton | [src/lib/request/pipeline.ts:20](../src/lib/request/pipeline.ts#L20), [src/lib/anthropic/pipeline.ts:147](../src/lib/anthropic/pipeline.ts#L147), [src/lib/shutdown.ts:30](../src/lib/shutdown.ts#L30) | Layer-violation by necessity |
| D6 | `ConsoleRenderer` constructor hijacks `consola.setReporters` (mutates a process-global reporter list) | [src/lib/tui/console-renderer.ts:78-117](../src/lib/tui/console-renderer.ts#L78-L117) | Footer-vs-log coordination hack |
| D7 | Adding one event type requires editing ≥5 files (`RetryInfo` proved this) | `RetryInfo` in types.ts + TuiRenderer + tracker + renderer + pipeline | Closed-enum renderer protocol |
| D8 | `tags: string[]` is an escape hatch — 7+ handler sites push structured info as strings | [src/routes/messages/handler.ts:389](../src/routes/messages/handler.ts#L389), [src/routes/chat-completions/handler.ts:308,465,521](../src/routes/chat-completions/handler.ts#L308) etc. | D7 made strong-typed events too expensive |
| D9 | Two independent broadcast channels translate the same event stream | `notifyActiveRequestChanged` in [manager.ts:219,247,264,285,310](../src/lib/context/manager.ts#L219) + TUI in [consumers.ts](../src/lib/context/consumers.ts) | No sink abstraction |
| D10 | Non-HTTP entry (WS) must self-start the tracker | [src/routes/responses/ws.ts:210](../src/routes/responses/ws.ts#L210) | Middleware-based tracking is HTTP-only |

The underlying form: a 5+-year-old "middleware logger" mental model stretched to **6 event sources × 3 sinks** without an event-bus abstraction.

**Crucial insight:** `RequestContext` is **already a correct event source** ([src/lib/context/request.ts:97-101](../src/lib/context/request.ts#L97-L101) `onEvent` callback + [src/lib/context/manager.ts:42-49](../src/lib/context/manager.ts#L42-L49) `RequestContextEvent` union + `manager.on('change', ...)`). This rewrite **completes a design already half-built**; it does not invent a new abstraction.

---

## 2. Target architecture

### 2.1 Layout

```
src/lib/observability/
├── events.ts                # ObservabilityEvent discriminated union (canonical type)
├── bus.ts                   # publish/subscribe (filtered), zero global state
├── index.ts                 # Re-exports + singleton bus accessor for routes/start.ts
└── sinks/
    ├── console.ts           # ConsoleSink — owns stdout, footer, formatting
    ├── ws.ts                # WsSink — filters to subset that the web UI cares about
    ├── history.ts           # HistorySink — persist to SQLite (replaces history-consumer)
    └── telemetry.ts         # TelemetrySink — model success/failure counters
    # No sink in lib/tui/. lib/tui/ is deleted.
```

### 2.2 Dependency direction (enforced)

```
src/lib/context/  ──emits──▶  observability/bus  ──fanout──▶  sinks/{console,ws,history,telemetry}
                                                                        │
src/routes/*   ──reads/mutates──▶  context/*                            ▼
src/lib/request/*  ──reads/mutates──▶  context/*           projections/  (pure formatters)
```

**Forbidden imports (ESLint `no-restricted-imports`, per §6 Q3 = "long-term best"):**
- `src/lib/{request,anthropic,openai,gemini,history,ws}/` → MUST NOT import `~/lib/observability/*` (low-level subsystems mutate ctx and emit via scoped publishers received by DI; they never reach into the observability surface)
- `src/routes/*` → MUST NOT import `~/lib/observability/sinks/*` and MUST NOT import `~/lib/observability/bus` (route handlers mutate ctx exclusively; sinks are off-limits — re-introducing direct route→sink calls would resurrect D2)
- `src/lib/observability/sinks/*` → MUST NOT import each other (sinks are independent; cross-sink coupling must go through bus events)
- `src/lib/context/*` MAY import `~/lib/observability` (it owns the `ScopedPublisher<"request">` injection point; producers reach the bus through it)
- `src/start.ts` is the **only** module that may call `initBus()` / `bus.scope(...)` directly — verified by the rule + a one-off allow-list comment

This makes the contract structural, not aspirational.

### 2.3 Single authoritative event type

Drawn directly from cataloguing **every existing emit site** (36 `tuiLogger.*` + 5 `notifyActiveRequestChanged` + 1 `notifyEntryAdded` + 2 `notifyEntryUpdated` + 5 `notifyStatsUpdated` (4 in entries.ts + 1 in sessions.ts) + 1 `notifyHistoryCleared` + 1 `notifySessionDeleted` + 4 `notifyRateLimiterChanged` + 1 `notifyShutdownPhaseChangedAndFlush` = **56 sites**):

```typescript
// observability/events.ts
import type { RequestContext } from "~/lib/context/request"
import type { ApiError } from "~/lib/error"
import type { HistoryEntryData, HistoryStats, EntrySummary } from "~/lib/history/store"

/** Snapshot a context's identity for sinks that need value semantics (no closure over mutable ctx). */
export interface RequestContextSnapshot {
  id: string
  endpoint: EndpointType
  sessionId?: string
  rawPath?: string
  method: string                // captured from HTTP at create-time (or "WS"/"STDIO" for non-HTTP)
  path: string
  clientModel?: string
  resolvedModel?: string
  state: RequestState
  startTime: number
  queueWaitMs: number
  requestBodySize?: number
  multiplier?: number           // pre-resolved from state.modelIndex for billing display
}

/** Partial attempt snapshot — carried on attempt-level events to preserve every diagnostic field
 *  the current `Attempt` type holds, per richest-data-flow (data flows in richest form). */
export interface AttemptSnapshot {
  attemptIndex: number
  strategy?: string
  transport?: TransportKind
  wireRequest?: unknown          // exact payload sent upstream (post-sanitize/truncate)
  effectiveRequest?: unknown
  partialResponse?: unknown      // bytes/events received before failure
  error?: { status: number; message: string; type: string }
}

export type ObservabilityEvent =
  // ── Request lifecycle (1:1 with RequestContextEvent union) ──
  | { kind: "request.created"; ctx: RequestContextSnapshot }
  | { kind: "request.model_resolved"; ctx: RequestContextSnapshot }
  | { kind: "request.state_changed"; ctx: RequestContextSnapshot; previousState: RequestState; meta?: Record<string, unknown> }

  // ── Attempt-level (replaces pipeline.logRetry + consumers.attempts update) ──
  | { kind: "request.attempt_started"; ctx: RequestContextSnapshot; attempt: AttemptSnapshot }
  | { kind: "request.attempt_failed"; ctx: RequestContextSnapshot; attempt: AttemptSnapshot; willRetry: boolean; nextStrategy?: string; waitMs?: number; learning?: boolean }

  // ── Streaming progress (4 current update sites; all fields optional because not every transport reports all) ──
  | { kind: "request.stream_progress"; ctx: RequestContextSnapshot; bytesIn?: number; eventsIn?: number; blockType?: string }

  // ── Feature applications (replaces 7+ tags: string[] usages with strongly-typed events) ──
  | { kind: "request.feature_applied"; ctx: RequestContextSnapshot; feature: FeatureKind; detail?: Record<string, unknown> }

  // ── Terminal (emitted by manager only) ──
  | { kind: "request.completed"; ctx: RequestContextSnapshot; entry: HistoryEntryData }
  | { kind: "request.failed"; ctx: RequestContextSnapshot; entry: HistoryEntryData; error: string; statusCode?: number }
  | { kind: "request.aborted"; ctx: RequestContextSnapshot; entry: HistoryEntryData }

  // ── History persistence (emitted by HistorySink AFTER SQLite write completes; WsSink subscribes) ──
  | { kind: "history.entry_added"; summary: EntrySummary }
  | { kind: "history.entry_updated"; summary: EntrySummary }
  | { kind: "history.stats_changed"; stats: HistoryStats }
  | { kind: "history.cleared" }
  | { kind: "history.session_deleted"; sessionId: string }

  // ── System-level (covers shutdown, rate-limiter, future non-request signals) ──
  | { kind: "system.rate_limit_state"; mode: "normal" | "rate-limited" | "recovering"; queuedCount: number; detail?: Record<string, unknown> }
  | { kind: "system.shutdown_phase_changed"; phase: ShutdownPhase; previousPhase: ShutdownPhase | null; needsFlush: boolean }
  | { kind: "system.shutdown_completed" }

// Note: `/v1/messages/count_tokens` is **excluded from observability entirely** (user decision §6 Q1).
// The route does not create a RequestContext and emits no events; existing tuiLogger calls are deleted in commit 3c without replacement. The route is a synthetic helper, not a real request — it has its own consola.info log line for operator visibility.

export type FeatureKind =
  | "truncated"               // auto-truncate ran
  | "thinking"                // per-request terminal thinking dimension (detail: { requested?, effective }; top-level type only)
  | "beta-stripped"           // unsupported-beta strategy stripped headers (detail: { betas: string[] })
  | "via-chat-completions-fallback"  // responses → chat-completions
  | "via-responses"           // chat-completions → responses
  | "dropped-params"          // sanitize dropped unsupported params (detail: { params: string[] })
  | "transport"               // request used a non-default transport (detail: { kind: TransportKind })
  // Extension: add a string here, exhaustive switch in every sink catches missing cases.

export type TransportKind = "http" | "upstream-ws" | "upstream-ws-fallback"
export type ShutdownPhase = "draining" | "aborting" | "finalized"
```

**Key properties:**

1. **`ctx` snapshot, not live reference** — sinks must not close over mutable state. (HistorySink writes SQLite synchronously via `bun:sqlite`; the snapshot is still required because TelemetrySink and WsSink could conceivably defer to a microtask.)
2. **Exhaustive switch** — every sink uses `switch (event.kind)` with a `default: assertNever(event)`. Adding a kind without updating sinks fails `tsc`.
3. **`entry` on terminal events** — history sink writes from this; console sink reads `entry.outboundResponse.usage`; no need to crawl back to `RequestContext`.
4. **`AttemptSnapshot` on attempt-level events** — preserves wireRequest/effectiveRequest/partialResponse/error so debugging-level sinks can introspect mid-flight (richest-data-flow).
5. **Replaces `tags: string[]`** — feature events are first-class; tags are deleted. `transport` becomes a feature so the console line can still display `(ws)` / `(ws→http)`.
6. **count-tokens is out of scope entirely** — `/v1/messages/count_tokens` is a synthetic helper, not a real request. Per user decision §6 Q1, it does not create a RequestContext, emits no bus events, and is exempted from the middleware (see §2.8). The existing `tuiLogger.updateRequest({ inputTokens })` calls are deleted without replacement; the route already logs `consola.info("[count_tokens] N tokens")` for operator visibility.
7. **System events distinct from request events** — adaptive-rate-limiter and shutdown have their own bus channel; no need for a parallel notification system.
8. **`model_resolved` carries only ctx** — `resolvedModel` and `clientModel` already live in the snapshot (W7: no field duplication).
9. **Every sink filters by `kind` prefix at subscription time** to avoid self-event loops:
   - HistorySink: `(e) => e.kind.startsWith("request.")` (does NOT receive its own `history.*` emissions)
   - WsSink: `(e) => e.kind.startsWith("request.") || e.kind.startsWith("history.") || e.kind.startsWith("system.")` (receives everything; per §6 Q2 also forwards `request.attempt_failed` and `request.feature_applied` to the web UI as new message types — front-end work in a separate PR)
   - TelemetrySink: `(e) => e.kind === "request.completed" || e.kind === "request.failed"` (ignores aborted, attempt_*, history.*, system.*)
   - ConsoleSink: no filter; renders everything per its own switch.

### 2.4 Bus

```typescript
// observability/bus.ts
export type EventFilter = (event: ObservabilityEvent) => boolean
export type EventHandler = (event: ObservabilityEvent) => void | Promise<void>

/**
 * Result of publishAndFlush. `pendingWsBuffer` is the count of WebSocket
 * clients whose `bufferedAmount` is still non-zero after the deadline
 * (mirrors current `notifyShutdownPhaseChangedAndFlush` return shape).
 * Other sinks complete synchronously and contribute 0 to this count.
 */
export interface FlushResult {
  pendingWsBuffer: number
}

/**
 * Scoped publisher — each producer module receives one via DI so the bus
 * can enforce namespace ownership at compile + runtime. Only one publisher
 * per namespace is created at start.ts; modules import the one they own.
 */
export interface ScopedPublisher<NS extends EventNamespace> {
  publish(event: Extract<ObservabilityEvent, { kind: `${NS}.${string}` }>): void
  publishAndFlush(event: Extract<ObservabilityEvent, { kind: `${NS}.${string}` }>, opts?: { deadlineMs?: number }): Promise<FlushResult>
}

export type EventNamespace = "request" | "history" | "system"

export interface ObservabilityBus {
  /**
   * Mint a scoped publisher. Called once per producer at start.ts:
   *   const requestPublisher = bus.scope("request")  // for context/manager.ts
   *   const historyPublisher = bus.scope("history")  // for sinks/history.ts
   *   const systemPublisher  = bus.scope("system")   // for shutdown.ts & adaptive-rate-limiter.ts
   * Producers receive the scoped publisher via DI — they MUST NOT import the
   * raw bus. This makes namespace ownership a type-system fact (the typed
   * `Extract<...>` parameter prevents publishing the wrong kind).
   */
  scope<NS extends EventNamespace>(namespace: NS): ScopedPublisher<NS>

  /**
   * Subscribe with optional filter. Handler runs inside an isolated try/catch
   * — a handler throwing is logged via `consola.warn` and fan-out continues
   * to remaining handlers. Mirrors the contract `RequestContextManager.emit`
   * already provides (manager.ts:175-188).
   *
   * Async handlers' promises are NOT awaited by `publish` (synchronous).
   * Use `publishAndFlush` when the caller must wait.
   */
  subscribe(handler: EventHandler, filter?: EventFilter): () => void

  /** Drain any pending in-flight async handlers. For testing or shutdown. */
  flush(): Promise<void>
}

export function createBus(): ObservabilityBus { /* ~80 lines */ }

// singleton accessor (only start.ts uses it)
let _bus: ObservabilityBus | null = null
export function initBus(): ObservabilityBus { _bus = createBus(); return _bus }
export function getBus(): ObservabilityBus { if (!_bus) throw new Error("Bus not initialized"); return _bus }
export function resetBusForTests(): ObservabilityBus { _bus = createBus(); return _bus }
```

**Sink attach order is contract, not coincidence:**
1. HistorySink (must persist before any WS notify so a downstream `GET /history/api/entries/:id` finds the row)
2. TelemetrySink (records counters before WS so the next stats event is consistent)
3. WsSink (broadcasts to clients; subscribes to `history.*` emitted by HistorySink)
4. ConsoleSink (pure read-only display)

The *binding* invariant is **HistorySink-before-WsSink** (1 before 3). The other positions are softer: TelemetrySink/ConsoleSink only read event payloads and never mutate shared state or query history, so their absolute position is benign.

Implementation note (later refinement): ConsoleSink + FileSink (the two log-stream sinks) are now attached *first*, in a `start.ts` "Phase 1.5" bootstrap that also installs the consola republish hijack — done before the boot banner so the whole startup (version/process/data-dir/rate-limiter init/config-parse errors) is captured to the rotating `copilot-api.log`, not just request-time logs. History/Telemetry/Ws still attach later (after their backing stores init), preserving HistorySink-before-WsSink. ConsoleSink subscribing first is harmless precisely because it is read-only display. So the live subscription order is Console → File → History → Telemetry → Ws; only the History-before-Ws pair is load-bearing.

Order is enforced by `start.ts` and validated by an integration test that:
- Installs a custom HistorySink wrapping the real one in `queueMicrotask(() => realWrite())` (artificially delays the SQLite write)
- Triggers a request completion
- Asserts that WsSink's broadcast happens AFTER the wrapped write resolves
- If the test passes, attaching WsSink before HistorySink in `start.ts` is structurally safe; if it fails, ordering violated

HistorySink's SQLite writes are synchronous via `bun:sqlite`, so in practice no microtask delay occurs — but the test pins the contract.

**Producer namespacing via scoped publishers (W6 implementation):**

The `bus.scope("request")` mechanism enforces ownership at the type level. Each producer module receives one scoped publisher via DI (full init order including the history-publisher timing is in §2.5):

```typescript
// shape only — see §2.5 for the complete start.ts wiring order
initRequestContextManager({ publisher: bus.scope("request") })
initShutdownManager({ publisher: bus.scope("system") })
initAdaptiveRateLimiter({ publisher: bus.scope("system") })
initHistory({ db, publisher: bus.scope("history") })   // entries.ts/sessions.ts read historyState.publisher
```

A module cannot accidentally publish to a foreign namespace: `requestPub.publish({ kind: "history.entry_added", ... })` is a `tsc` error because `Extract<ObservabilityEvent, { kind: "request.${string}" }>` excludes `history.*`. Runtime check is unnecessary — types catch it.

This subsumes W6's "audited at publish time in dev mode" with a stronger compile-time guarantee.

Sinks **never directly import the singleton bus** — they take it in their constructor. This keeps them unit-testable without global mutation.

### 2.5 Sinks (concrete API)

```typescript
// observability/sinks/console.ts
export interface ConsoleSinkOptions {
  stdout?: NodeJS.WritableStream      // default: process.stdout
  isTTY?: boolean                     // default: stdout.isTTY
  showActive?: boolean
  historySize?: number
  completedDisplayMs?: number
}

export class ConsoleSink {
  constructor(bus: ObservabilityBus, options?: ConsoleSinkOptions)
  destroy(): void  // unsubscribes; restores any installed consola reporter
}

// observability/sinks/ws.ts  (replaces ws/broadcast notify* exports for request events)
export function attachWsSink(bus: ObservabilityBus): () => void  // returns detach
// Internally calls broadcastToTopic("history", {...}) / broadcastToTopic("status", {...})
// — but only the WS-relevant subset. The low-level notifyEntryAdded/Updated/StatsUpdated
// /HistoryCleared/SessionDeleted/RateLimiterChanged/ShutdownPhaseChanged primitives stay
// in ws/broadcast.ts as private internals, but their only callers are now the sinks.

// observability/sinks/history.ts  (replaces context/consumers.ts history portions
// + the in-source notifyEntry*/Stats* calls in lib/history/entries.ts and sessions.ts)
//
// HistorySink only SUBSCRIBES to request.completed/failed/aborted; the
// `history.*` events are emitted by lib/history/entries.ts and sessions.ts
// directly via `historyState.publisher` (injected at initHistory time —
// see §2.4 W2 resolution below).
export function attachHistorySink(bus: ObservabilityBus): () => void

// observability/sinks/telemetry.ts  (replaces lib/request-telemetry consumer registration)
export function attachTelemetrySink(bus: ObservabilityBus): () => void
```

**`lib/history/entries.ts` and `sessions.ts` write-path coupling (W2 resolution):**

Today, `entries.ts:45,84,115` and `sessions.ts:117-118` call `notifyEntry*/Stats*/SessionDeleted` inline after every SQLite write. After rewrite:

- The `historyState` module-level singleton (today holding `db: Database`) gains a `publisher: ScopedPublisher<"history">` field, mirroring how `db` is already injected via `initHistory()`.
- `initHistory(opts)` signature extends to `initHistory({ db, publisher })` (or equivalent). Callers in `start.ts` provide both at boot.
- `entries.ts` / `sessions.ts` change their inline `notifyEntryAdded(...)` calls to `historyState.publisher.publish({ kind: "history.entry_added", ... })`. No function signature changes — the publisher comes from module state, same shape as `db`.
- HistorySink's role is split: it (a) **subscribes** to `request.completed/failed/aborted` from bus and calls `finalizeEntry()`, and (b) **owns** the `ScopedPublisher<"history">` instance, but does NOT inject it directly into entries.ts; instead, both HistorySink and entries.ts receive the same `historyPub` reference from `start.ts` at init time.

**Required `start.ts` init order:**
```typescript
const bus = initBus()
const historyPub = bus.scope("history")
const systemPub  = bus.scope("system")
const requestPub = bus.scope("request")

initHistory({ db: openSqlite(), publisher: historyPub })  // entries.ts/sessions.ts read historyState.publisher
attachHistorySink(bus)                                    // subscribes to request.* and writes via entries.ts
attachTelemetrySink(bus)
attachWsSink(bus)
attachConsoleSink(bus)

initShutdownManager({ publisher: systemPub })
initAdaptiveRateLimiter({ publisher: systemPub })
initRequestContextManager({ publisher: requestPub })
```

`initHistory` **must** run before `attachHistorySink` (otherwise HistorySink calls `entries.ts.finalizeEntry()` which dereferences a null `historyState.publisher`). The fixture-style `initHistory` in tests applies the same ordering.

This keeps the rule "history.* is published only by the history subsystem" intact while accommodating the API write path (DELETE /history → clearHistory() → publishes `history.cleared`).

**Consola hijack is preserved but internalized to ConsoleSink.** The honest reading: D6 cannot be fully eliminated without rewriting every `consola.{info,warn,error}` call site to bus events (a separate, larger change). What the rewrite *does* eliminate:
- The hijack no longer lives in a "tracker" class with mixed responsibilities (D1 collapses).
- The hijack is now a documented coupling between ConsoleSink and stdout, scoped to one file, with explicit `destroy()` semantics for tests.
- Other consumers (HistorySink, WsSink, TelemetrySink) **do not** touch consola — only ConsoleSink does, because only ConsoleSink owns stdout.

If a follow-up PR replaces all `consola.warn` with a `system.log_emitted` bus event, the hijack can then be deleted. That is not in scope here.

### 2.6 Context manager changes

`RequestContextManager` becomes the **producer**, not the dispatcher:

```typescript
// context/manager.ts (delta)
import { getBus } from "~/lib/observability"

function handleContextEvent(rawEvent: RequestContextEventData) {
  const { type, context } = rawEvent
  const bus = getBus()
  const snapshot = snapshotContext(context)

  switch (type) {
    case "state_changed":
      bus.publish({ kind: "request.state_changed", ctx: snapshot, previousState: rawEvent.previousState })
      break
    case "updated":
      // emit one of: model_resolved / stream_progress / feature_applied
      // based on rawEvent.field — see §2.7 mapping
      break
    case "completed":
      bus.publish({ kind: "request.completed", ctx: snapshot, entry: rawEvent.entry })
      break
    // ... etc
  }
  // notifyActiveRequestChanged() calls deleted — WsSink subscribes to bus now.
}
```

`registerContextConsumers()` in [consumers.ts](../src/lib/context/consumers.ts) is **deleted entirely** — its TUI portion becomes ConsoleSink, history portion becomes HistorySink, telemetry portion becomes TelemetrySink.

### 2.7 Mapping from current call sites to bus events

| Current call site | New event |
|---|---|
| `tuiLogger.startRequest()` (middleware:50, responses/ws.ts:210) | `request.created` (emitted by `manager.create()` automatically — middleware just creates the ctx) |
| `tuiLogger.updateRequest({ model, clientModel })` (messages:203, chat-completions:192, responses:186, gemini:276, responses/ws:236) | `request.model_resolved` (emitted when `ctx.setResolvedModel()` is called) |
| `tuiLogger.updateRequest({ tags: ["truncated"] })` (chat-completions:521, messages:391) | `request.feature_applied { feature: "truncated" }` (emitted by `ctx.recordFeature()`) |
| `tuiLogger.updateRequest({ tags: ["via-chat-completions-fallback"] })` (responses:193) | `request.feature_applied { feature: "via-chat-completions-fallback" }` |
| `tuiLogger.updateRequest({ tags: ["dropped-params"] })` (chat-completions:465, gemini:271) | `request.feature_applied { feature: "dropped-params" }` |
| `tuiLogger.updateRequest({ tags: ["via-responses"] })` (chat-completions:308) | `request.feature_applied { feature: "via-responses" }` |
| `tuiLogger.updateRequest({ tags: ["beta-strip:..."] })` (messages:389) | `request.feature_applied { feature: "beta-stripped", detail: { betas: [...] } }` |
| `tuiLogger.updateRequest({ tags: ["thinking:adaptive"] })` (messages:342) | `request.feature_applied { feature: "thinking", detail: { type: "adaptive" } }` |
| `tuiLogger.updateRequest({ tags: ["thinking:..."] })` (anthropic/pipeline:147) | `request.feature_applied { feature: "thinking", detail: { requested?, effective } }` (merged terminal dimension; console overwrites `effective` per attempt) |
| `tuiLogger.updateRequest({ streamBytesIn, streamEventsIn })` (4 sites) | `request.stream_progress` (emitted by `ctx.recordStreamProgress()`) |
| `tuiLogger.updateRequest({ model })` / `({ inputTokens })` (count-tokens.ts:96,107,138,152) | **Deleted, no replacement** (per §6 Q1, count-tokens is out of observability). Route keeps its existing `consola.info("[count_tokens] N tokens")` log line for operator visibility. |
| `tuiLogger.updateRequest({ status: "streaming" })` (consumers.ts:197) | `request.state_changed { previousState: "executing" }` — sink derives display |
| `tuiLogger.finishRequest({ statusCode: 200 })` (consumers.ts:235, middleware:84) | `request.completed` (emitted by `ctx.complete()` from handler OR `ctx.completeFromHttpStatus()` from middleware for non-streaming JSON; both paths converge on the same ctx method) |
| `tuiLogger.finishRequest({ error })` (consumers.ts:246, middleware:86) | `request.failed` or `request.aborted` (emitted by `ctx.fail()` / `ctx.abort()` from handler OR `ctx.failIfNotFinalized()` from middleware on uncaught throw) |
| `tuiLogger.logRetry()` (pipeline:346) | `request.attempt_failed { willRetry: true, attempt: {...} }` (emitted by ctx — pipeline calls `ctx.recordAttemptFailure({ willRetry, strategy, error, waitMs, learning, wireRequest, effectiveRequest })`) |
| `notifyActiveRequestChanged()` (manager.ts:219,247,264,285,310) | Bus `request.*` events; WsSink subscribes and translates to existing WS message shape |
| `notifyEntryAdded/Updated()` (history/entries.ts:45,84,115) | Bus `history.entry_added/_updated` events emitted by entries.ts via injected `ScopedPublisher<"history">` (provided by HistorySink at start.ts wire-up — see §2.5 W2 resolution); WsSink subscribes |
| `notifyStatsUpdated()` (entries.ts:46,85,116,167 + sessions.ts:118) | Bus `history.stats_changed`; same injection path |
| `notifyHistoryCleared()` (entries.ts:166) | Bus `history.cleared` |
| `notifySessionDeleted()` (sessions.ts:117) | Bus `history.session_deleted` |
| `notifyRateLimiterChanged()` (adaptive-rate-limiter.ts:295,344,362,563) | Bus `system.rate_limit_state` via injected `ScopedPublisher<"system">` |
| `notifyShutdownPhaseChangedAndFlush()` (shutdown.ts:99) | Bus `system.shutdown_phase_changed` via `systemPub.publishAndFlush(...)` |

**Reduction**: 36 `tuiLogger.*` calls → 0 in routes/pipeline; ~8 new methods on `RequestContext` (`setResolvedModel` / `recordFeature` / `recordStreamProgress` / `recordAttemptFailure` / `complete` / `fail` / `abort`). Each new method emits one event via `onEvent` → bus.

### 2.8 Middleware becomes a context creator + fail-safe finalizer

Today, [middleware.ts](../src/lib/tui/middleware.ts) does:
1. Start tuiLogger entry
2. Set `c.set("tuiLogId", ...)` for handlers
3. On finish: detect SSE vs JSON vs WS and call `finishRequest`

After rewrite:
1. **Path-based skip for synthetic routes**: if the request path is in `SYNTHETIC_PATHS` (currently `["/v1/messages/count_tokens", "/anthropic/v1/messages/count_tokens"]`), the middleware **does not** create a RequestContext and `await next()` runs without any observability wrapping. Per §6 Q1 these routes are intentionally invisible to telemetry/history; they retain their own `consola.info` log line. This is the structural guarantee that count-tokens cannot pollute real-request stats.
2. Otherwise, create RequestContext via `manager.create({ endpoint: inferFromPath, method, path, requestBodySize })`
3. Set `c.set("requestContext", ctx)` (and keep `c.set("tuiLogId", ctx.id)` as a compatibility shim during transition — see §4)
4. **Wrap `await next()` in try/catch and call `ctx.failIfNotFinalized(err)` on throw** (idempotent; no-op if handler already finalized). This preserves immediate operator visibility of handler-thrown errors that currently get caught by `middleware.ts:85-91`.
5. After `await next()` returns, if `ctx.state` is still `executing` / `pending` and the response is non-streaming (no SSE / WS upgrade detected), call `ctx.completeFromHttpStatus(c.res.status)` (also idempotent). For SSE responses (`content-type: text/event-stream`), the middleware **does not** finalize — the stream consumer is the sole owner of `ctx.complete/fail/abort` for SSE, exactly as today.

The stale-request reaper (`manager.ts:141-159`, default 600s with 200s scan period) remains as **long-tail defense** for handlers that hang without throwing — not as the primary finalization path.

This eliminates the dual-finish coordination ([D2](#1-problem-statement)) without regressing error visibility: there is now **one** finalization path (`ctx.complete/fail/abort`), but middleware still ensures it is always called for HTTP requests.

`ctx.failIfNotFinalized(err)` and `ctx.completeFromHttpStatus(status)` are new methods on RequestContext that internally check `this.state` and short-circuit if already terminal — replacing the `idempotent finishRequest` pattern with explicit guarded transitions.

### 2.9 WebSocket entry (D10)

`responses/ws.ts:210` `tuiLogger.startRequest(...)` is replaced by `manager.create({ endpoint: "openai-responses", method: "WS", path: "/v1/responses", requestBodySize: undefined })`. The handler now has a normal RequestContext; every sink sees the request transparently. The middleware-is-the-only-entry assumption is gone.

---

## 3. Testing strategy

### 3.1 Per-sink unit tests (no global state)

```typescript
// tests/observability/sinks/console.sink.unit.test.ts
test("emits [RETRY-n] on attempt_failed with willRetry:true", () => {
  const bus = createBus()
  const writes: string[] = []
  const stdout = createMockWritable(writes)
  const sink = new ConsoleSink(bus, { stdout, isTTY: false })

  bus.publish({
    kind: "request.attempt_failed",
    ctx: makeCtx(),
    attempt: { attemptIndex: 1, strategy: "network-retry", error: { status: 502, message: "ECONNRESET", type: "network_error" } },
    willRetry: true,
    nextStrategy: "network-retry",
    waitMs: 1000,
  })

  expect(writes.join("")).toContain("[RETRY-1]")
  sink.destroy()
})
```

No `setRenderer`, no private-field access, no singleton mutation. Each test owns a fresh bus.

### 3.2 Bus contract tests

```typescript
test("subscribe filter is applied", () => {
  const bus = createBus()
  const received: ObservabilityEvent[] = []
  bus.subscribe((e) => received.push(e), (e) => e.kind === "request.completed")
  bus.publish({ kind: "request.created", ... })   // filtered out
  bus.publish({ kind: "request.completed", ... }) // received
  expect(received).toHaveLength(1)
})
```

### 3.3 RequestContext tests unchanged

[src/lib/context/request.ts](../src/lib/context/request.ts) already takes `onEvent` callback. Existing context tests stay.

### 3.4 Integration: `bootstrapTestRuntime()` registers minimal sinks

```typescript
// tests/helpers/test-bootstrap.ts (delta)
const bus = initBus()
attachHistorySink(bus)        // needed so tests that GET /history work
attachTelemetrySink(bus)      // needed so request-telemetry assertions work
// WsSink NOT attached — tests that need WS install it themselves
// ConsoleSink NOT attached — tests don't want stdout pollution
// Caller stores `detachAll = () => { detachHistory(); detachTelemetry() }`
// for use in resetTestRuntime().
```

`resetTestRuntime()` calls each detach in reverse order, then `resetBusForTests()`. This replaces `tuiLogger.clear()` + the implicit `registerContextConsumers()` registration that exists in [tests/helpers/test-bootstrap.ts:31-53](../tests/helpers/test-bootstrap.ts#L31-L53) today.

### 3.5 Tests to delete + contracts to redistribute

Delete:
- `tests/tui/console-renderer-retry.unit.test.ts` — replaced by `tests/observability/sinks/console.sink.unit.test.ts`
- `tests/helpers/mock-tracker.ts` — no tracker to mock
- `tests/infra/tui-format.unit.test.ts` — format helpers move to `observability/projections/`, tests follow
- `tests/pipeline/pipeline-retry-tui.unit.test.ts` — replaced by `tests/observability/sinks/console.sink.unit.test.ts::attempt_failed`
- `tests/context/context-consumers.unit.test.ts` — file deleted, but the following contracts MUST be re-covered in new sink tests:

| Contract | Current test | New home |
|---|---|---|
| TUI consumer translates `state_changed` to status update | `context-consumers > tui consumer > maps state to status` | `tests/observability/sinks/console.sink.unit.test.ts::state_changed` |
| `aborted` is NOT counted in request-telemetry | `context-consumers > telemetry > aborted excluded` (line 273-282) | `tests/observability/sinks/telemetry.sink.unit.test.ts::aborted excluded` |
| `completed` writes history with success=true | `context-consumers > history > completed persists with success` | `tests/observability/sinks/history.sink.unit.test.ts::completed persists` |
| `failed` writes history with success=false + error | (existing) | `tests/observability/sinks/history.sink.unit.test.ts::failed persists error` |
| Transport tag derived from currentAttempt.transport | `context-consumers > tui consumer > transport tag` | `tests/observability/sinks/console.sink.unit.test.ts::transport feature` |
| Multiple `register` calls dedupe (idempotency) | `context-consumers > register idempotency` | `tests/observability/bus.unit.test.ts::subscribe idempotency` (or document as N/A if new API doesn't expose) |
| HistorySink persists BEFORE WsSink broadcasts entry_added | NEW contract | `tests/observability/integration.unit.test.ts::sink ordering` |

---

## 4. Cutover plan (commits, NOT phases)

Per **architecture-health-first** (no "small fix then refactor"), this is one PR with multiple commits for review friendliness. The functional branch runs the full test suite at every commit. **Invariant: from commit 2 onward, every commit ends with all 4 sinks (Console/Ws/History/Telemetry) attached to the bus; the system remains observable end-to-end through the cutover.**

| Commit | Scope | Approx LOC | Verification |
|---|---|---|---|
| 1. Foundation | Add `observability/{events,bus,index}.ts` (incl. `ScopedPublisher` + `EventNamespace`) + `projections/{format,billing}.ts` (moved from tui/) + ESLint `no-restricted-imports` rule. Bus and event types exist but no producer/sink wired yet — old `tuiLogger` + `notifyActiveRequestChanged` paths remain authoritative. | ~400 | `bun run typecheck` clean; new ESLint rule has no current violations |
| 2. Sinks (attach idle) | Implement 4 sinks + sink-ordering integration test. **Sinks attach in `start.ts` and remain idle: bus carries zero events because no producer publishes yet. The old path (tuiLogger + notify*) still emits exclusively.** No double-counting risk. | ~800 | Per-sink unit tests pass; integration test passes; full backend suite passes (old path still authoritative; sinks asserted to receive zero events under normal operation) |
| 3a. RequestContext API + fields | Extend `RequestContext` type with `method`, `path`, `requestBodySize` fields (today carried only on tuiLogger entry). Add new ctx methods: `setResolvedModel/recordFeature/recordStreamProgress/recordAttemptStart/recordAttemptFailure/failIfNotFinalized/completeFromHttpStatus`. Old tuiLogger still in place — both APIs co-exist this commit. | ~300 | Backend suite still passes (no caller changed) |
| 3b. Producer cutover: context + manager | `manager.ts` switches to emit via injected `ScopedPublisher<"request">`; HistorySink + TelemetrySink + WsSink + ConsoleSink **become authoritative** (old `tuiLogger.updateRequest`/`finishRequest` from consumers.ts deleted; `notifyActiveRequestChanged` calls in manager.ts deleted; `consumers.ts` deleted). **Authority swap is atomic in this commit** — the bus carries every lifecycle event for the first time, and the old consumers stop receiving them, so no event is counted twice. tuiLogger singleton still imported by 5 routes (a deprecation-tagged shim re-routes `tuiLogger.updateRequest({ tags })` to a no-op + console.warn; next commits remove the callers). | ~400 | Backend suite passes; WS UI manually verified (history events still flow via WsSink); ConsoleSink renders requests |
| 3c. Producer cutover: messages route | Migrate `routes/messages/handler.ts` to ctx methods; delete tuiLogger imports there. `routes/messages/count-tokens.ts` deletes its tuiLogger calls without replacement (per §6 Q1, out of observability). | ~200 | Backend tests for messages/anthropic pass; manual check `/v1/messages/count_tokens` does NOT bump telemetry and does NOT create a history entry |
| 3d. Producer cutover: remaining routes | chat-completions / responses / responses-ws / responses-fallback / gemini. pipeline.ts (delete tuiLogger import; use `ctx.recordAttemptFailure`). anthropic/pipeline.ts. shutdown.ts (use `systemPub.publishAndFlush`). adaptive-rate-limiter.ts (use `systemPub.publish`). | ~400 | Full backend suite passes |
| 3e. Middleware swap | Replace `lib/tui/middleware.ts` with `lib/observability/middleware.ts`; uses ctx.failIfNotFinalized + completeFromHttpStatus; SYNTHETIC_PATHS exemption for count-tokens. | ~150 | Full backend suite passes |
| 4. Cleanup | Delete `lib/tui/` entirely. Make `lib/ws/broadcast.ts` notify* exports private (export-prefix `_internal` or move under `observability/sinks/ws-primitives.ts`). Delete `tests/helpers/mock-tracker.ts`, `tests/tui/`, `tests/infra/tui-format.unit.test.ts`, `tests/pipeline/pipeline-retry-tui.unit.test.ts`. Replace `tests/context/context-consumers.unit.test.ts` content with sink tests (see §3.5 table). | ~1000 net deletion | Full backend suite + UI build; verification greps in §7 |

Each commit's diff is mechanically reviewable. The 2 → 3a → 3b split exists because the original "commit 3" was ~1500 LOC. Commit 2 attaches sinks as idle observers; the **single moment of authority transfer** is commit 3b, where the manager swaps its emission target. Commits 3c/3d/3e then mop up route-level direct tuiLogger calls.

---

## 5. Out of scope (explicit non-goals)

- **WS broadcast wire protocol changes** — the front-end WS message shape stays identical (WsSink translates bus events into the existing message shape). Two new message types (`request.attempt_failed` and `request.feature_applied`, per §6 Q2) are added but ignored by the current front-end until a follow-up PR consumes them.
- **History SQLite schema** — unchanged. HistorySink writes the same `HistoryEntryData` as today.
- **`request-telemetry.ts` aggregation logic** — only the *plumbing* (how it receives events) changes. The success/failure counter logic stays.
- **`shutdown.ts` is more than an import swap** — drain counters move from `tracker.getActiveRequests().length` to `manager.activeCount`; `tracker.destroy()` becomes `consoleSink.destroy()`; phase push changes from direct `notifyShutdownPhaseChangedAndFlush()` to `bus.publishAndFlush({ kind: "system.shutdown_phase_changed", ... })`. The phase state machine logic stays.
- **`/v1/messages/count_tokens` observability** — per §6 Q1, this route is intentionally invisible to telemetry, history, console TUI, and WS. Its existing `consola.info("[count_tokens] N tokens")` line is the sole operator signal.
- **Front-end Vue UI changes for new event types** — zero changes in this PR; the UI gracefully ignores unknown WS message types. A follow-up PR can render `request.attempt_failed` and `request.feature_applied` as retry / feature badges in the history view.
- **Replacing all `consola.*` calls with bus events** — out of this PR. ConsoleSink's consola hijack remains (internalized, scoped, documented). A follow-up can eliminate it entirely.
- **Adding new sinks** (OTLP / Prometheus / file-tap) — out of this PR; the architecture **enables** them but adding them is a follow-up.

---

## 6. User decisions (closed)

All four open questions from RFC v3 were resolved by the user on 2026-06-13:

1. **count-tokens is out of observability entirely.** The route does not create a RequestContext, emits no bus events, and is exempted from middleware via `SYNTHETIC_PATHS` (§2.8 step 1). Existing `tuiLogger.updateRequest({ inputTokens })` calls are deleted without replacement. The route's `consola.info("[count_tokens] N tokens")` line remains for operator visibility. No `request.token_count_estimated` event is needed; that kind is removed from the union. This eliminates the only path that risked polluting `request-telemetry` per-model counters.

2. **WsSink forwards retry and feature events.** WsSink subscribes to `request.attempt_failed` and `request.feature_applied` in addition to the current message set, opening the door for a future "retry visualization" / "applied features badge" in the web UI. The wire format adds two new message types under the existing `history` / `status` topic shape; the front-end Vue work is a follow-up PR and the current UI ignores the new types gracefully (no-op on unknown `action`).

3. **ESLint rule takes the long-term-best form (§2.2):** ban `lib/{request,anthropic,openai,gemini,history,ws}/` → `~/lib/observability/*` **and** ban `routes/*` → `~/lib/observability/{sinks,bus}`. Route handlers mutate ctx exclusively. Only `src/start.ts` may directly construct the bus / mint scoped publishers.

4. **adaptive-rate-limiter emits bus events.** The 4 existing `notifyRateLimiterChanged` calls in [adaptive-rate-limiter.ts:295,344,362,563](../src/lib/adaptive-rate-limiter.ts) become `systemPub.publish({ kind: "system.rate_limit_state", ... })`. The `lib/ws/broadcast.ts:notifyRateLimiterChanged` export is removed in commit 4. WsSink translates `system.rate_limit_state` back to the existing `status` topic message shape. Brings rate limiter under one observability roof and eliminates the second parallel notification system (D9).

These decisions are now baked into §2.2, §2.3, §2.7, §2.8 and §5. No further user input is required to start implementation.

---

## 7. Verification (post-implementation)

1. `bun run typecheck` — clean
2. `bun run test:backend` — 2354+ tests pass (no regression)
3. `grep -rn "tuiLogger\|tuiLogId" src/` — zero matches outside `observability/middleware.ts` and a transitional compat shim if any
4. `grep -rn "TuiLogEntry\|TuiRenderer\|RetryInfo\|RequestUpdate" src/` — zero matches (all types deleted)
5. `grep -rn "notifyActiveRequestChanged\|notifyEntryAdded\|notifyEntryUpdated\|notifyStatsUpdated\|notifyHistoryCleared\|notifySessionDeleted\|notifyRateLimiterChanged\|notifyShutdownPhaseChanged" src/lib/observability/sinks/` — these are the only files that may call broadcast primitives; everywhere else: zero matches
6. Manual: trigger a real retry-eligible failure, confirm `[RETRY-n]` line still appears identically; confirm WS history UI still receives `entry_added` + `stats_updated` for the resulting entry
7. Manual: `curl /v1/messages/count_tokens` 10 times, confirm `request-telemetry` per-model success counter does NOT increase (proves §6 Q1 isolation)
8. Manual: kill -INT during in-flight requests, confirm `system.shutdown_phase_changed` event drains correctly (await publishAndFlush completes before next phase)
9. Manual: register sinks in **wrong** order in a test, confirm the sink-ordering integration test catches it

---

## 8. Effort estimate (informational, not a decision factor)

- ~1000 lines deleted (`lib/tui/` + `consumers.ts` + dead test infra)
- ~1500 lines added/modified (`observability/*` + ctx methods + sink tests)
- ~36 producer call sites rewritten
- ~10 affected test files rewritten

Per **architecture-health-first**, cost is not a decision factor. This estimate is for your visibility only.

---

## Summary

Today's TUI subsystem is an accretion that violates 6 of the 12 project principles (7, 8, 9 most prominently). It works only because of `idempotent finishRequest`, hijacked consola reporters, and a `tags: string[]` escape hatch — all of which are bypasses, not designs. The fix is to complete the design already started by `RequestContext` + `onEvent` + `RequestContextEventCallback`: introduce a typed event bus, move every sink behind subscription, delete `lib/tui/`, and enforce dependency direction structurally.

**Status:** All §6 open questions resolved 2026-06-13. Architecture (§2), cutover plan (§4), and out-of-scope (§5) are stable. Implementation may proceed in §4 cutover order at user's signal.
