/**
 * Declarative reactive-retry strategy registry (RFC 2026-07-21 §3.1–§3.3 / plan Task 2).
 *
 * Replaces the per-leg hard-coded `buildXxxStrategies` arrays (`codec/anthropic/strategies.ts`,
 * `codec/openai-cc/strategies.ts`, `codec/openai-responses/strategies.ts`) with a single declarative
 * registry: each of the 16 reactive retry strategies is registered ONCE with a declared `order` (the
 * assembly-sort key, replacing "comment-maintained array position") and an `appliesTo` leg gate (the
 * cross-leg dedup mechanism). `assembleRetryStrategies` filters by `appliesTo` ∧ per-strategy config
 * enable, sorts by `order`, then instantiates (adapting payload-oriented strategies to the driver's
 * env-based `RetryStrategy` shape via {@link adaptPayloadStrategy}; the one NATIVE env strategy —
 * poisoned-thinking — is used as-is).
 *
 * The three `buildXxxStrategies` functions call `assembleRetryStrategies`, so this registry is the live shared strategy source for Anthropic, OpenAI Chat Completions, and OpenAI Responses codec legs.
 *
 * **appliesTo is `targetEndpoint === ENDPOINT.MESSAGES`, NOT `clientFormat === "anthropic"`** (RFC §3.3
 * — load-bearing). The current `buildAnthropicStrategies` 16-strategy stack serves FOUR `@messages`
 * cells: the direct anthropic client AND the three REVERSE `@messages` legs (openai-cc / openai-responses
 * / gemini clients routed to a Claude model via `anthropicMessagesLeg.buildLegStrategies`). Gating on
 * `clientFormat==="anthropic"` would silently drop all 13 400-class strategies on the three reverse legs.
 *
 * **deps are optional + throwMissing, never `?? []` (RFC §3.1)**: `betaProbe`/`resanitize` are optional
 * on {@link RetryStrategyDeps} because the CC-family direct legs (openai-cc / openai-responses direct)
 * never populate them — only entries gated to `targetEndpoint===MESSAGES` need them, and those FOUR legs
 * always populate both (`RequestState.betaProbe`/`resanitize`, RFC known WS-reverse-leg footnote aside —
 * that path throws earlier, at `reverseMapperHolder`, before strategies assembly is ever reached). The
 * consuming entries assert this invariant explicitly (`?? throwMissing(...)`) rather than silently
 * degrading to an empty candidate list / no-op resanitize — a wiring bug (appliesTo/config drifting from
 * the populate invariant) must fail loudly, not silently misbehave.
 */

import type {
  //
  AnthropicSanitizeFn,
  BetaProbe,
} from "~/lib/anthropic/pipeline"
import type { Model } from "~/lib/models/client"
import type {
  //
  ClientFormat,
  UpstreamEndpoint,
} from "~/lib/pipeline/envelope"
import type { AttemptRef } from "~/lib/pipeline/payload-strategy-adapter"
import type { RetryStrategy as EnvRetryStrategy } from "~/lib/pipeline/types"
import type { RetryStrategy as PayloadRetryStrategy } from "~/lib/request/retry-types"
import type { MessagesPayload } from "~/types/api/anthropic"

import { createPoisonedThinkingRetryStrategy } from "~/lib/codec/anthropic/poisoned-thinking-retry"
import { ENDPOINT } from "~/lib/models/endpoint"
import { adaptPayloadStrategy } from "~/lib/pipeline/payload-strategy-adapter"
import { createAdaptiveThinkingRejectionRetryStrategy } from "~/lib/request/strategies/adaptive-thinking-rejection-retry"
import { createCacheControlSubfieldRejectionStrategy } from "~/lib/request/strategies/cache-control-subfield-rejection-retry"
import { createBodyFieldRejectionStrategy } from "~/lib/request/strategies/context-management-retry"
import { createDeferredToolRetryStrategy } from "~/lib/request/strategies/deferred-tool-retry"
import { createEffortLearningRetryStrategy } from "~/lib/request/strategies/effort-learning-retry"
import { createLegacyThinkingRetryStrategy } from "~/lib/request/strategies/legacy-thinking-retry"
import { createNetworkRetryStrategy } from "~/lib/request/strategies/network-retry"
import { createServerErrorRetryStrategy } from "~/lib/request/strategies/server-error-retry"
import { createServerToolRejectionStrategy } from "~/lib/request/strategies/server-tool-rejection-retry"
import { createStructuredOutputsRejectionStrategy } from "~/lib/request/strategies/structured-outputs-rejection-retry"
import { createSystemRejectRetryStrategy } from "~/lib/request/strategies/system-reject-retry"
import { createTokenRefreshStrategy } from "~/lib/request/strategies/token-refresh"
import { createToolFieldRejectionStrategy } from "~/lib/request/strategies/tool-field-rejection-retry"
import { createUnsupportedBetaRetryStrategy } from "~/lib/request/strategies/unsupported-beta-retry"
import { createWebSearchNotFoundRetryStrategy } from "~/lib/request/strategies/web-search-not-found-retry"

// ============================================================================
// Contracts (RFC §3.1)
// ============================================================================

/** Leg-gate input `appliesTo` decides on (RFC §3.1 — NOT the full `RequestEnvelope`, just the two
 *  orchestration facts the gate needs). */
export interface RetryStrategyContext {
  readonly clientFormat: ClientFormat
  readonly targetEndpoint: UpstreamEndpoint
}

/**
 * Per-request supply `create(deps)` factories close over (RFC §3.1). Deliberately a flat OPTIONAL bundle
 * (not per-entry discriminated deps): `betaProbe`/`resanitize` are populated ONLY by the four `@messages`
 * legs — the entries that need them are ALL gated `targetEndpoint===MESSAGES`, so "entry needs it ⟺
 * appliesTo gates to @messages ⟺ that leg always supplies it" holds as an invariant, asserted at the
 * consuming entry via {@link throwMissing} rather than trusted silently.
 */
export interface RetryStrategyDeps {
  readonly attemptRef: AttemptRef
  readonly originalPayload: unknown
  readonly model: Model | undefined
  readonly maxRetries: number
  /** Populated only on the four `@messages` legs (direct anthropic + 3 reverse). */
  readonly betaProbe?: BetaProbe
  /** Populated only on the four `@messages` legs (direct anthropic + 3 reverse). */
  readonly resanitize?: AnthropicSanitizeFn
}

/** A registry `create(deps)` factory returns either a payload-oriented strategy (adapted below) or —
 *  for the one native entry (poisoned-thinking) — an already env-shaped strategy. */
type PayloadOrEnvStrategy = EnvRetryStrategy | PayloadRetryStrategy<unknown>

/** One declared retry-strategy registration (RFC §3.1). */
export interface RetryStrategyEntry {
  readonly name: string
  /** Declarative assembly-sort key, replacing "array position + comment" (RFC §3.3). */
  readonly order: number
  /** Leg gate — the cross-leg dedup mechanism (shared entries: `() => true`; anthropic-only: `targetEndpoint===MESSAGES`). */
  appliesTo(ctx: RetryStrategyContext): boolean
  /** `retry.strategies.<configKey>.enabled` config key (RFC §3.4). */
  readonly configKey: string
  /** `"payload"` → wrapped by {@link adaptPayloadStrategy}; `"env"` → used as-is (native, e.g. poisoned-thinking reads `env.ctx`). */
  readonly kind: "env" | "payload"
  /** Per-request factory (registry entries are declarations, not instances — `assembleRetryStrategies` calls this once per request). */
  create(deps: RetryStrategyDeps): PayloadOrEnvStrategy
}

/** Asserts a request-lifecycle-stable dep the invariant above guarantees is present; a throw here means
 *  `appliesTo`/config drifted from the populate invariant — a wiring bug, not a runtime possibility to
 *  silently paper over (never-swallow-errors; mirrors `codec/anthropic/anthropic-cell.ts`'s local helper). */
function throwMissing(field: string): never {
  throw new Error(`[retry-registry] deps.${field} missing on a @messages-gated entry — appliesTo/config drifted from the populate invariant`)
}

/** `appliesTo` gate shared by all 13 anthropic-only (400-class) entries (RFC §3.3 — targetEndpoint, NOT clientFormat). */
function appliesToMessages(ctx: RetryStrategyContext): boolean {
  return ctx.targetEndpoint === ENDPOINT.MESSAGES
}

// ============================================================================
// Declared order (RFC §3.3 — 16 keys, 100/200/300 shared; 400-520 anthropic-only;
// 410/420/430 10-step defense-in-depth: tool-field < body-field < cache-control)
// ============================================================================

export const RETRY_STRATEGY_ORDER = {
  network: 100,
  serverError: 200,
  tokenRefresh: 300,
  effortLearning: 400,
  toolFieldRejection: 410,
  bodyFieldRejection: 420,
  cacheControlSubfield: 430,
  legacyThinking: 440,
  adaptiveThinkingRejection: 450,
  poisonedThinking: 460,
  unsupportedBeta: 470,
  serverToolRejection: 480,
  structuredOutputsRejection: 490,
  systemReject: 500,
  webSearchNotFound: 510,
  deferredTool: 520,
} as const

// ============================================================================
// Declared registry (RFC §3.3 table + §3.6 cross-leg dedup)
// ============================================================================

export const RETRY_STRATEGY_REGISTRY: ReadonlyArray<RetryStrategyEntry> = [
  // ── shared (all legs) ──
  {
    name: "network-retry",
    order: RETRY_STRATEGY_ORDER.network,
    appliesTo: () => true,
    configKey: "network",
    kind: "payload",
    create: () => createNetworkRetryStrategy<unknown>(),
  },
  {
    name: "server-error-retry",
    order: RETRY_STRATEGY_ORDER.serverError,
    appliesTo: () => true,
    configKey: "serverError",
    kind: "payload",
    create: () => createServerErrorRetryStrategy<unknown>(),
  },
  {
    name: "token-refresh",
    order: RETRY_STRATEGY_ORDER.tokenRefresh,
    appliesTo: () => true,
    configKey: "tokenRefresh",
    kind: "payload",
    create: () => createTokenRefreshStrategy<unknown>(),
  },

  // ── anthropic-only (@messages: direct + 3 reverse legs, RFC §3.3) ──
  {
    name: "effort-learning",
    order: RETRY_STRATEGY_ORDER.effortLearning,
    appliesTo: appliesToMessages,
    configKey: "effortLearning",
    kind: "payload",
    create: () => createEffortLearningRetryStrategy<MessagesPayload>() as unknown as PayloadRetryStrategy<unknown>,
  },
  {
    // tool-field-rejection BEFORE body-field: both match `... : Extra inputs are not permitted`,
    // 10-step order gap is the declared defense-in-depth (RFC §3.3).
    name: "tool-field-rejection-retry",
    order: RETRY_STRATEGY_ORDER.toolFieldRejection,
    appliesTo: appliesToMessages,
    configKey: "toolFieldRejection",
    kind: "payload",
    create: () => createToolFieldRejectionStrategy<MessagesPayload>() as unknown as PayloadRetryStrategy<unknown>,
  },
  {
    name: "body-field-rejection-retry",
    order: RETRY_STRATEGY_ORDER.bodyFieldRejection,
    appliesTo: appliesToMessages,
    configKey: "bodyFieldRejection",
    kind: "payload",
    create: () => createBodyFieldRejectionStrategy<MessagesPayload>() as unknown as PayloadRetryStrategy<unknown>,
  },
  {
    name: "cache-control-subfield-rejection-retry",
    order: RETRY_STRATEGY_ORDER.cacheControlSubfield,
    appliesTo: appliesToMessages,
    configKey: "cacheControlSubfield",
    kind: "payload",
    create: () => createCacheControlSubfieldRejectionStrategy<MessagesPayload>() as unknown as PayloadRetryStrategy<unknown>,
  },
  {
    name: "legacy-thinking-retry",
    order: RETRY_STRATEGY_ORDER.legacyThinking,
    appliesTo: appliesToMessages,
    configKey: "legacyThinking",
    kind: "payload",
    create: () => createLegacyThinkingRetryStrategy<MessagesPayload>() as unknown as PayloadRetryStrategy<unknown>,
  },
  {
    name: "adaptive-thinking-rejection-retry",
    order: RETRY_STRATEGY_ORDER.adaptiveThinkingRejection,
    appliesTo: appliesToMessages,
    configKey: "adaptiveThinkingRejection",
    kind: "payload",
    create: () => createAdaptiveThinkingRejectionRetryStrategy<MessagesPayload>() as unknown as PayloadRetryStrategy<unknown>,
  },
  {
    // NATIVE env strategy — deliberately NOT adapted: onResolved reads `env.ctx` (L3 quarantine),
    // which adaptPayloadStrategy would drop (RFC §3.1 payload-vs-native).
    name: "poisoned-thinking-retry",
    order: RETRY_STRATEGY_ORDER.poisonedThinking,
    appliesTo: appliesToMessages,
    configKey: "poisonedThinking",
    kind: "env",
    create: () => createPoisonedThinkingRetryStrategy(),
  },
  {
    name: "unsupported-beta-retry",
    order: RETRY_STRATEGY_ORDER.unsupportedBeta,
    appliesTo: appliesToMessages,
    configKey: "unsupportedBeta",
    kind: "payload",
    create: (deps) =>
      createUnsupportedBetaRetryStrategy<MessagesPayload>({
        getProbeCandidates: () => (deps.betaProbe ?? throwMissing("betaProbe")).getCandidates(),
      }) as unknown as PayloadRetryStrategy<unknown>,
  },
  {
    name: "server-tool-rejection-retry",
    order: RETRY_STRATEGY_ORDER.serverToolRejection,
    appliesTo: appliesToMessages,
    configKey: "serverToolRejection",
    kind: "payload",
    create: () => createServerToolRejectionStrategy<MessagesPayload>() as unknown as PayloadRetryStrategy<unknown>,
  },
  {
    name: "structured-outputs-rejection-retry",
    order: RETRY_STRATEGY_ORDER.structuredOutputsRejection,
    appliesTo: appliesToMessages,
    configKey: "structuredOutputsRejection",
    kind: "payload",
    create: () => createStructuredOutputsRejectionStrategy<MessagesPayload>() as unknown as PayloadRetryStrategy<unknown>,
  },
  {
    name: "system-reject-retry",
    order: RETRY_STRATEGY_ORDER.systemReject,
    appliesTo: appliesToMessages,
    configKey: "systemReject",
    kind: "payload",
    create: (deps) =>
      createSystemRejectRetryStrategy<MessagesPayload>({
        resanitize: deps.resanitize ?? throwMissing("resanitize"),
      }) as unknown as PayloadRetryStrategy<unknown>,
  },
  {
    name: "web-search-not-found-retry",
    order: RETRY_STRATEGY_ORDER.webSearchNotFound,
    appliesTo: appliesToMessages,
    configKey: "webSearchNotFound",
    kind: "payload",
    create: (deps) =>
      createWebSearchNotFoundRetryStrategy<MessagesPayload>({
        resanitize: deps.resanitize ?? throwMissing("resanitize"),
      }) as unknown as PayloadRetryStrategy<unknown>,
  },
  {
    name: "deferred-tool-retry",
    order: RETRY_STRATEGY_ORDER.deferredTool,
    appliesTo: appliesToMessages,
    configKey: "deferredTool",
    kind: "payload",
    create: () => createDeferredToolRetryStrategy<MessagesPayload>() as unknown as PayloadRetryStrategy<unknown>,
  },
]

// ============================================================================
// Config opt-out (RFC §3.4 — enabled-only, default true = current 16-on behavior)
// ============================================================================

/** `retry.strategies.<key>.enabled !== false` — absent key / absent config ⇒ enabled (preserves the
 *  current all-16-on behavior byte-for-byte, RFC §3.4). */
export function isStrategyEnabled(config: Record<string, { enabled?: boolean } | undefined> | undefined, key: string): boolean {
  return config?.[key]?.enabled !== false
}

// ============================================================================
// Assembler (RFC §3.2 — replaces the three `buildXxxStrategies`)
// ============================================================================

/**
 * Assemble the env-based retry-strategy stack for one request: `filter(appliesTo ∧ enabled)` →
 * `sort(order)` → instantiate (`kind:"payload"` → {@link adaptPayloadStrategy}; `kind:"env"` → as-is).
 * `Array.prototype.sort` is stable, so registry-declaration order breaks any (theoretical) order tie —
 * today's 16 orders are all distinct, so this is belt-and-suspenders.
 */
export function assembleRetryStrategies(
  ctx: RetryStrategyContext,
  deps: RetryStrategyDeps,
  config: Record<string, { enabled?: boolean } | undefined> | undefined,
): ReadonlyArray<EnvRetryStrategy> {
  return RETRY_STRATEGY_REGISTRY.filter((entry) => entry.appliesTo(ctx) && isStrategyEnabled(config, entry.configKey))
    .sort((a, b) => a.order - b.order)
    .map((entry): EnvRetryStrategy => {
      const instance = entry.create(deps)
      if (entry.kind === "env") return instance as EnvRetryStrategy
      return adaptPayloadStrategy(instance as PayloadRetryStrategy<unknown>, {
        attemptRef: deps.attemptRef,
        originalPayload: deps.originalPayload,
        model: deps.model,
        maxRetries: deps.maxRetries,
      })
    })
}

// ============================================================================
// Registry diagnostics (RFC §3.5 — "注册集（声明了哪些 + 各自 enabled 态）作诊断,
// 经既有 pipelineInfo 通道或 GET /api/config 暴露声明态"; plan Task 5)
// ============================================================================

/** Representative `RetryStrategyContext` probes used to derive a declared entry's SCOPE from its
 *  `appliesTo` gate rather than hardcoding a name→scope table (which would silently drift from the
 *  registry — RFC §3.3's gate is the single source of truth for leg applicability). */
const MESSAGES_PROBE_CTX: RetryStrategyContext = { clientFormat: "anthropic", targetEndpoint: ENDPOINT.MESSAGES }
const CC_DIRECT_PROBE_CTX: RetryStrategyContext = { clientFormat: "openai-cc", targetEndpoint: ENDPOINT.CHAT_COMPLETIONS }

/** One declared registry entry's diagnostic projection (name/configKey/order + derived scope + live enabled state). */
export interface RetryStrategyDiagnosticEntry {
  readonly name: string
  readonly configKey: string
  readonly order: number
  /** Derived from `appliesTo` against the two representative probes above — `"shared"` = applies to
   *  every leg (`appliesTo() === true` for both probes); `"messages-only"` = the 13 anthropic-only
   *  400-class entries (RFC §3.3, gated `targetEndpoint===MESSAGES`, not `clientFormat`). */
  readonly scope: "shared" | "messages-only"
  /** Live `retry.strategies.<configKey>.enabled` state (RFC §3.4 — absent config/key ⇒ true). */
  readonly enabled: boolean
}

/**
 * Project the FULL declared registry (all 16 entries, regardless of `enabled` state) into a
 * diagnostic view — "which strategies are declared + what's each one's live enabled state" (RFC
 * §3.5's "注册集…作诊断"). Consumed by `GET /api/config` (`routes/config/route.ts`) as
 * `retryStrategyRegistry`. Ordered by declared `order` (mirrors `assembleRetryStrategies`' sort) so a
 * reader sees the same assembly-sort sequence the driver actually consumes.
 *
 * `scope` is PROBED via `appliesTo`, never hardcoded — a future entry whose `appliesTo` gate is wired
 * wrong would otherwise silently mis-report here too (the same class of bug the golden guards against
 * in the assembled stack).
 */
export function getRetryStrategyRegistryDiagnostics(
  config: Record<string, { enabled?: boolean } | undefined> | undefined,
): ReadonlyArray<RetryStrategyDiagnosticEntry> {
  return [...RETRY_STRATEGY_REGISTRY]
    .sort((a, b) => a.order - b.order)
    .map((entry) => ({
      name: entry.name,
      configKey: entry.configKey,
      order: entry.order,
      scope: entry.appliesTo(MESSAGES_PROBE_CTX) && entry.appliesTo(CC_DIRECT_PROBE_CTX) ? "shared" : "messages-only",
      enabled: isStrategyEnabled(config, entry.configKey),
    }))
}
