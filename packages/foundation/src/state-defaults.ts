/**
 * Bundled default values for config-managed state fields.
 *
 * Extracted from state.ts (single-responsibility split): this module holds ONLY the default
 * data (`CONFIG_MANAGED_DEFAULTS`), decoupled from the State type shape, the setters, and the
 * singleton. state.ts imports and re-exports it, so existing `import { CONFIG_MANAGED_DEFAULTS }
 * from "~/lib/state"` sites keep working. Type-only imports are erased at runtime
 * (verbatimModuleSyntax), so there is no runtime cycle with state.ts.
 *
 * It has exactly ONE out-edge left, to the zero-import vocabulary leaf `./state-vocabulary`, and that
 * is the finished shape: this file is moving into `packages/foundation` alongside `state.ts`, where
 * the boundary guard permits nothing but `node:` builtins and relative paths. Every default value it
 * needs is therefore DECLARED here and re-exported by whichever domain consumes it, rather than the
 * other way round — the reverse arrangement is what kept `state` + `state-defaults` inside 52 and 50
 * of the repo's 70 import cycles. See docs/plan/2026-07-28-state-to-foundation/HANDOVER.md.
 */

import type {
  //
  BufferedRetryCaps,
  BufferedRetryContinuation,
  MaxTokensContinuationConfig,
  AssistantBlockLayoutStrategy,
  MaxTokensContinuationOverride,
  ModelTranslation,
  RepairItem,
  SeparatorCarrier,
  ThinkingBlockSanitizeMode,
  CacheControlMode,
  CacheTtl,
  CompiledRewriteRule,
  CompiledSystemPromptEntry,
  LoggingConfigState,
  ThinkingBlockMessagePolicy,
  UnknownEndpointLogging,
  WarmupPolicy,
} from "./state-vocabulary"

/**
 * The default texts + carrier this file hands to `CONFIG_MANAGED_DEFAULTS`.
 *
 * Declared HERE rather than imported from the domains that consume them, because that is the only
 * arrangement in which this file has no out-edge at all. S1 parked them on zero-import leaves as a
 * transitional step — that broke the import CYCLE but left two `~/` edges, which the foundation
 * boundary rejects regardless of whether the target is a leaf. The domains now import them back:
 * `anthropic/refusal-policy` and `anthropic/sanitize/separator-carrier` re-export these, so every
 * existing consumer path is unchanged.
 *
 * Being config DEFAULTS, this file is their natural owner anyway — the domain modules only ever read
 * them to describe what happens when the operator configured nothing.
 */

/**
 * DEFAULT for `anthropic.refusal_end_turn_text` (the `end_turn`-mode suppression text).
 *
 * Reports what happened WITHOUT asserting anything the wire does not support: it does not claim the
 * turn was "thinking-only" (the real `cyber` sample produced ZERO content blocks with thinking
 * disabled), and it does not call the block "transient" (unverified — the `bio` sample refused only
 * after 25,636 thinking tokens). It carries `{refusal_category}` but deliberately NOT
 * `{refusal_explanation}`: this text is a SUCCESSFUL assistant message that the client bakes into
 * conversation history, and the upstream explanation is diagnostic metadata about the request, not
 * the model's answer to the user's task — replaying it as assistant content pollutes the semantic
 * context. The explanation stays fully available in History, logs and the `error`-mode message.
 */
export const DEFAULT_REFUSAL_END_TURN_TEXT =
  "上游模型本轮以「拒绝（refusal）」结束，未产出可用回复（拒绝类别：{refusal_category}）。这是上游安全策略对本次请求的拦截，不代表任务本身有问题。请基于已有上下文换一种表述或拆分步骤后继续；若多次复现，考虑调整措辞、移除可能触发策略的内容，或改用其他模型。"

/**
 * DEFAULT for `anthropic.refusal_error_message` (the message carried by the synthetic Anthropic
 * `error` frame in the opt-in `error` mode; the client SDK surfaces it as the thrown `APIError`'s
 * message). Unlike the end_turn text this DOES carry `{refusal_explanation}` — an error frame is
 * never baked into the conversation history, so the full upstream diagnostic can ride along.
 */
export const DEFAULT_REFUSAL_ERROR_MESSAGE =
  "上游模型本轮以「拒绝（refusal）」结束、未产出可用回复（拒绝类别：{refusal_category}）。已按 error 策略中断本次请求。上游说明：{refusal_explanation}"

/** The Anthropic error `type` carried by a synthetic refusal `error` frame when config leaves it empty. */
export const DEFAULT_REFUSAL_ERROR_TYPE = "api_error"

/** The synthetic separator carrier emitted when config says nothing. */
export const DEFAULT_SEPARATOR_CARRIER: SeparatorCarrier = "marker_v1"

/**
 * Built-in model mapping. Intentionally EMPTY: model name mapping (short
 * aliases like opus/sonnet/haiku, redirects) is owned exclusively by the
 * bundled `config.yaml`, the single source of truth. If config.yaml can't be
 * read, the mapping stays empty and unknown aliases simply fail to resolve
 * (the upstream rejects them) rather than falling back to hardcoded names.
 */
export const DEFAULT_MODEL_MAPPINGS: Record<string, string> = {}

/** Built-in `model_translation` mapping. Intentionally EMPTY — see {@link DEFAULT_MODEL_MAPPINGS} rationale. */
export const DEFAULT_MODEL_TRANSLATION: ModelTranslation = {}

/**
 * Default values for config-managed scalar/runtime fields.
 * Single source of truth for mutableState initialization and resetConfigManagedState().
 * Model mapping continues to use DEFAULT_MODEL_MAPPINGS.
 */
export const CONFIG_MANAGED_DEFAULTS = {
  unknownEndpointLogging: { notFound: "warn", methodNotAllowed: "warn" } as UnknownEndpointLogging,
  logging: {
    terminalLevel: "info",
    fileLevel: "debug",
    fileEnabled: true,
    fileDirectory: "",
    fileMaxSizeMb: 10,
    fileMaxFilesPerProcess: 7,
    retentionDays: 7,
  } as LoggingConfigState,
  tuiEnabled: true,
  useUpstreamCountTokens: true,
  strictResponseHeaders: false,
  strictRequestHeaders: false,
  requestHeaderBlacklist: ["x-anthropic-billing-header"] as ReadonlyArray<string>,
  requestHeaderWhitelist: ["accept", "anthropic-dangerous-direct-browser-access", "x-app", "x-claude-code-*", "x-stainless-*"] as ReadonlyArray<string>,
  responseHeaderBlacklist: [] as ReadonlyArray<string>,
  responseHeaderWhitelist: ["request-id", "x-request-id", "anthropic-ratelimit-*", "anthropic-organization-id", "retry-after"] as ReadonlyArray<string>,
  stripAttributionHeader: true,
  streamKeepalivePingSec: 20,
  streamKeepaliveEscalateSec: 200,
  streamKeepaliveMode: "ping" as "ping" | "enveloped_ping" | "empty_text", // D2 partial reversal 2026-07-27: ping stays the normal shape; content delta/anchor is injected only near the 300s deadline
  streamCommitAfterSec: 180,
  protectStreamingGeneration: false as false | "on" | "tool_use_only",
  bufferedRetryShared: { maxRetries: 3, bufferCapBytes: 16_777_216, heartbeatSec: 15 } as BufferedRetryCaps,
  bufferedRetryOverrides: {} as Record<string, Partial<BufferedRetryCaps>>,
  bufferedRetryContinuationShared: { enabled: true, message: "network issue. please continue" } as BufferedRetryContinuation,
  bufferedRetryContinuationOverrides: {} as Record<string, Partial<BufferedRetryContinuation>>,
  maxTokensContinuationShared: {
    enabled: false,
    maxRounds: 1,
    classes: { text: "continue", toolUse: "passthrough", thinking: "passthrough" },
    message: "Please continue where you left off.",
    visibility: "transparent",
    thinkingRetryBudget: null,
  } as MaxTokensContinuationConfig,
  maxTokensContinuationOverrides: {} as Record<string, MaxTokensContinuationOverride>,
  // Default ON (P3 flip, 2026-07-14): buffering/generation-preservation beats the
  // downstream streaming UX for CC. See docs/decisions/ + plan README frozen contract.
  chatCompletionsBufferedRetry: true,
  protectStreamingEscalateContext: false,
  injectClaudeCodeOfficialTools: true,
  thinkingBlockMessagePolicy: "preserve" as ThinkingBlockMessagePolicy,
  thinkingBlockSanitizeCheck: "all_empty" as false | ThinkingBlockSanitizeMode,
  assistantBlockLayoutStrategy: "move_blocks" as AssistantBlockLayoutStrategy,
  /** EMIT axis: which synthetic separator carrier this process puts on the wire. */
  separatorCarrier: DEFAULT_SEPARATOR_CARRIER as SeparatorCarrier,
  /** ACCEPT axis: extra literals recognised as ours, on top of the built-in family + legacy set. */
  separatorAcceptExtra: [] as ReadonlyArray<string>,
  stripThinkingOnReject: true,
  poisonedThinkingQuarantine: true,
  poisonedThinkingTtlHours: 72,
  coerceAdaptiveThinking: "basic" as false | "basic" | "best_effort",
  systemDefaultMode: false as false | "drop_invalid" | "merge" | "as_user" | "as_assistant",
  systemRejectMode: "as_user" as false | "drop_invalid" | "merge" | "as_user" | "as_assistant",
  systemRejectModels: ["claude-sonnet-4.6", "claude-haiku-4.5"] as Array<string>,
  thinkingSignatureCompat: "signature_delta" as false | "signature_delta" | "redacted_thinking",
  dedupToolCalls: false as const,
  stripReadToolResultTags: false,
  contextEditingMode: "off" as const,
  contextEditingTrigger: 100_000,
  contextEditingKeepTools: 3,
  contextEditingKeepThinking: 1,
  toolSearchEnabled: true,
  cacheControlMode: "passthrough" as CacheControlMode,
  // Extended prompt-cache TTL (mirrors GHC extendedTtl / extendedTtlMessages). Off by default; when
  // enabled, tools/system default to 1h and messages to 5m (GHC's parent-on / sub-toggle-off shape).
  extendedCacheTtlEnabled: false,
  extendedCacheTtlToolsSystem: "1h" as CacheTtl,
  extendedCacheTtlMessages: "5m" as CacheTtl,
  extendedCacheTtlModels: [
    "claude-fable-5*",
    "claude-opus-4-5*",
    "claude-opus-4-6*",
    "claude-opus-4-7*",
    "claude-opus-4-8*",
    "claude-sonnet-4-5*",
    "claude-sonnet-4-6*",
    "claude-haiku-4-5*",
  ] as ReadonlyArray<string>,
  nonDeferredTools: [] as ReadonlyArray<string>,
  rewriteSystemReminders: false as const,
  systemPromptOverrides: [] as Array<CompiledRewriteRule>,
  systemPromptPrepend: [] as Array<CompiledSystemPromptEntry>,
  systemPromptAppend: [] as Array<CompiledSystemPromptEntry>,
  // Shared reactive-retry budget (was auto_truncate.max_retries). Inlined default 5.
  maxReactiveRetries: 5,
  generationHedgeEnabled: true,
  generationHedgeThresholdSec: 300,
  generationHedgeMaxSecondaryCandidates: 1,
  generationRecoveryMaxCandidates: 3,
  generationMaxActiveCandidates: 2,
  generationMaxTotalCandidates: 5,
  generationMaxActiveDispatches: 2,
  generationMaxTotalDispatches: 16,
  generationCleanupGraceSec: 10,
  generationHedgeAllowServerTools: false,
  sanitizeToolNames: false,
  forwardClientQuery: true,
  forwardClientQueryExclude: [] as ReadonlyArray<string>,
  recoverToolCallText: false,
  toolRepairMalformedInput: [] as ReadonlyArray<RepairItem>,
  refusalSseRewrite: "end_turn" as "refusal" | "end_turn" | "error",
  refusalEndTurnText: DEFAULT_REFUSAL_END_TURN_TEXT,
  refusalErrorMessage: DEFAULT_REFUSAL_ERROR_MESSAGE,
  refusalErrorType: DEFAULT_REFUSAL_ERROR_TYPE,
  errorShapingEnabled: true,
  errorAskUserQuestion: false,
  errorAuqTemplate: "",
  errorSelfhealDelegate: {} as Readonly<Record<string, "proxy" | "delegate">>,
  // Per-strategy retry-registry opt-out (`retry.strategies.<configKey>.enabled`, RFC §3.4). Empty by
  // default = all 16 registry entries enabled (byte-equivalent to the pre-config-switch behavior).
  retryStrategies: {} as Readonly<Record<string, { enabled?: boolean }>>,
  // Model-capability allowlists (explicit globs; see features.ts:matchModelCapability / model-pattern.ts).
  // A glob-free entry is now an EXACT match — family coverage ("a whole Claude generation") must use an
  // explicit `*`, e.g. `claude-opus-4*`. Mirror GHC's capability checks.
  contextEditingModels: ["claude-haiku-4-5*", "claude-sonnet-4*", "claude-opus-4*", "claude-opus-41*"] as ReadonlyArray<string>,
  // Tool-search is default-allow for Claude ≥4.5 (see features.ts:toolSearchDefaultAllow); this map
  // only holds per-model force-on/off overrides. Empty by default.
  toolSearchOverrides: {} as Record<string, boolean>,
  // Memory tool: default OFF (CAPI acceptance of memory_20250818 unverified). memoryModels mirrors GHC
  // modelSupportsMemory — the `claude-sonnet-4*` / `claude-opus-4*` globs are load-bearing (they cover
  // all sonnet-4.x / opus-4.x); the specific entries are redundant but kept as self-documentation.
  memoryToolEnabled: false,
  memoryModels: [
    "claude-fable-5*",
    "claude-haiku-4-5*",
    "claude-sonnet-4*",
    "claude-sonnet-4-5*",
    "claude-sonnet-4-6*",
    "claude-opus-4*",
    "claude-opus-4-1*",
    "claude-opus-4-5*",
    "claude-opus-4-6*",
    "claude-opus-4-7*",
    "claude-opus-4-8*",
  ] as ReadonlyArray<string>,
  interleavedThinkingModels: ["claude-sonnet-4*", "claude-haiku-4-5*", "claude-opus-4-5*"] as ReadonlyArray<string>,
  // Empty by default: adaptive thinking is driven by the upstream `/models` metadata
  // (`capabilities.supports.adaptive_thinking`) via modelHasAdaptiveThinking's tier-1 short-circuit.
  // This name-list is a tier-3 fallback that only fires when metadata is SILENT for a model — kept as
  // an optional config override (`anthropic.model_capabilities.adaptive_thinking`) for forcing a new
  // adaptive model before its `/models` metadata propagates; the reactive adaptive-thinking-rejection-
  // retry is the runtime safety net otherwise.
  adaptiveThinkingModels: [] as ReadonlyArray<string>,
  responseHeaderTimeout: 300,
  streamIdleTimeout: 300,
  upstreamKeepaliveDelay: 15,
  upstreamH2PingInterval: 15,
  maxConcurrentStreamsPerSession: 1,
  h2IdleSessionTimeout: 300,
  maxSessionsPerOrigin: 0,
  upstreamH2Favor: true,
  sessionConnectTimeout: 10,
  pooledConnectionIdleTimeout: 300,
  staleRequestMaxAge: 600,
  requestDeadline: 0,
  modelRefreshInterval: 600,
  shutdownGracefulWait: 60,
  shutdownAbortWait: 120,
  historyDbPath: "",
  historyRawCaptureEnabled: false,
  historyRawCaptureDbPath: "",
  historyRawCaptureMaxObjectBytes: 16 * 1024 * 1024,
  telemetryEnabled: true,
  telemetryDbPath: "",
  telemetryPersistInterval: 60,
  telemetryRollupInterval: 3600,
  telemetryCardinalityCap: 200,
  telemetrySketchGamma: 0.01,
  telemetryCumulative: true,
  telemetryRawResolutionMinutes: 5,
  telemetryRawRetentionDays: 7,
  telemetryHourlyRetentionDays: 90,
  telemetryDailyRetentionDays: 0,
  normalizeResponsesCallIds: true,
  upstreamWebSocket: false,
  // Default ON (P2/P4 flip, 2026-07-14): covers BOTH Responses-HTTP (P2) and
  // Responses-WS (P4, no independent key — ws.ts's resolveResponsesBufferedAndHeartbeat
  // reads this same field). Buffering/generation-preservation beats the downstream
  // streaming UX. P1 Anthropic stays default OFF (see protectStreamingGeneration above)
  // — block-level anchor-coexist shape is CLI-unsafe (tests/e2e-client/anthropic-coexist-cli.e2e.test.ts).
  responsesBufferedRetry: true,
  fixResponsesStreamIds: true,
  responsesBufferedMergeEventCompaction: "drop-delta" as "verbatim" | "drop-delta" | "item-summary",
  responsesBufferedMergeCompletedOutput: "repair-if-incomplete" as "upstream" | "repair-if-incomplete" | "rebuild",
  stripImageGenerationTool: false,
  clientWebsocketKeepOpen: false,
  maxWsFrameBytes: 0,
  maxClientWsConnections: 256,
  softMaxUpstreamWsConnections: 32,
  warmupPolicy: "allow" as WarmupPolicy,
  effortsOverrides: {} as Record<string, Array<string>>,
  // Empty by design — the bundled `gpt-5.5: 600` product default lives in
  // config.yaml (`timeouts.stream_idle_overrides`), NOT here, mirroring
  // `model_mappings` (H1: BUILTIN code-constant + union would be wrong; this is
  // per-key merge with the shippable config, degrading to scalar if config.yaml
  // is absent). See docs/spec/2026-07-12-per-model-idle-timeout.md §4.2.
  streamIdleTimeoutOverrides: {} as Record<string, number>,
  responseHeaderTimeoutOverrides: {} as Record<string, number>,
  stripBetaHeaders: {} as Record<string, Array<string>>,
  stripCacheControlSubfields: {} as Record<string, Array<string>>,
  stripPartnerFeatures: {} as Record<string, Array<string>>,
  stripToolFields: {} as Record<string, Array<string>>,
  keepToolFields: {} as Record<string, Array<string>>,
  rejectBodyFields: {} as Record<string, Array<string>>,
  decodeToolInputFields: { AskUserQuestion: ["questions"] } as Record<string, Array<string>>,
  backfillQuestionFromHeader: true,
  fixSendMessageRecipient: true,
  negotiationDefaultTtlMs: 30 * 86_400_000,
  negotiationTtlOverridesMs: { toolFields: 90 * 86_400_000, partnerFeatures: Number.POSITIVE_INFINITY } as Record<string, number>,
  disabledModels: [] as ReadonlyArray<string>,
  hooksUpstreamModule: "",
  hooksEnabled: false,
}
