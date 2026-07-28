/**
 * The config VOCABULARY: every type that describes the shape of a config-managed value, with no
 * reference to the state object that stores them.
 *
 * A zero-import leaf, and that is its entire job. `state.ts` and `state-defaults.ts` are being
 * reduced to a leaf pair that depends on nothing but language builtins
 * (docs/plan/2026-07-28-state-to-foundation/HANDOVER.md), and those two used to point at each other:
 * `state-defaults` took eleven type names plus an inline `import("./state").T` FROM `state`, while
 * `state` took the default VALUES from `state-defaults`. madge counts type edges, so that was a real
 * two-node cycle in the snapshot, and it would have travelled into foundation unchanged. Splitting
 * the vocabulary out breaks it without either file learning anything new: both now depend on this
 * leaf, and a leaf has no out-edges.
 *
 * **Keep this file import-free.** The `state.ts` re-exports below mean no existing consumer has to
 * learn a new module, so there is never a reason to reach outward from here.
 */

/**
 * Server-side context editing mode.
 * Controls how Anthropic's context_management trims older context when input grows large.
 * Mirrors VSCode Copilot Chat's `chat.anthropic.contextEditing.mode` setting.
 */
export type ContextEditingMode = "off" | "clear-thinking" | "clear-tooluse" | "clear-both"

/**
 * Cache control mode for Anthropic requests.
 * Controls how cache_control fields are handled in the wire payload.
 */
export type CacheControlMode = "disabled" | "passthrough" | "sanitize" | "proxied"

/**
 * Per-layer prompt-cache TTL for the extended-cache-ttl feature. `"5m"` is Anthropic's default
 * (emitted as a bare `{type:"ephemeral"}`); `"1h"` emits `{type:"ephemeral", ttl:"1h"}` and requires
 * the `extended-cache-ttl-2025-04-11` beta. Mirrors GHC's per-layer 5m-vs-1h choice.
 */
export type CacheTtl = "5m" | "1h"

/**
 * Policy for handling Claude Code "Warmup" requests.
 *
 * - `"allow"`  — pass through normally (default)
 * - `"reject"` — return HTTP 429 error
 * - `"drop"`   — return minimal empty success response without forwarding upstream
 * - `"fake"`   — return a realistic fake response with cache_creation_input_tokens
 */
export type WarmupPolicy = "allow" | "reject" | "drop" | "fake"

/**
 * Policy for assistant messages that contain `thinking` / `redacted_thinking` blocks.
 *
 * Empirically, Anthropic thinking `signature`s are self-contained — they encrypt the
 * thinking content itself (the upstream decrypts and rebuilds it) and do NOT bind to
 * surrounding context or array position. The only real constraints are that thinking blocks
 * must be echoed verbatim, kept in relative order, and never dropped (their adjacency,
 * however, is not preserved — see `preserve` below).
 *
 * - `preserve` — Keep thinking blocks verbatim, preserve their relative order, and never
 *                drop them, but allow all surrounding cleanup (drop orphan tools, downgrade
 *                server tools, edit/drop non-thinking blocks). Thinking *adjacency* is NOT
 *                protected: the de-stack pass (sanitize/assistant-block-layout.ts) may
 *                insert non-thinking blocks between consecutive thinking blocks to satisfy
 *                the upstream "no two thinking blocks adjacent" rule.
 * - `stripped` — Actively delete thinking blocks from old messages; delete the message if
 *                empty after stripping.
 */
export type ThinkingBlockMessagePolicy = "preserve" | "stripped"

/** A compiled rewrite rule (regex pre-compiled from config string) */
export interface CompiledRewriteRule {
  /** Pattern to match (regex in regex mode, string in line mode) */
  from: RegExp | string
  /** Replacement string (supports $0, $1, etc. in regex mode) */
  to: string
  /** Match method: "regex" (default) or "line" */
  method?: "regex" | "line"
  /** Compiled regex for model name filtering. undefined = apply to all models. */
  modelPattern?: RegExp
  /** Endpoint-scope set (ClientFormat values). undefined = apply to all endpoints. */
  endpointSet?: ReadonlySet<string>
}

/**
 * A compiled system-prompt prepend/append entry: the literal `text` plus the
 * pre-compiled model/endpoint scope (same two-axis AND semantics as
 * {@link CompiledRewriteRule}). A plain-string config entry compiles to
 * `{ text, modelPattern: undefined, endpointSet: undefined }` (unscoped).
 */
export interface CompiledSystemPromptEntry {
  /** The prepend/append text. */
  text: string
  /** Compiled regex for model name filtering. undefined = apply to all models. */
  modelPattern?: RegExp
  /** Endpoint-scope set (ClientFormat values). undefined = apply to all endpoints. */
  endpointSet?: ReadonlySet<string>
}

/**
 * Resolved buffered-retry caps for one vendor (`resolveBufferedCaps` return
 * shape). `maxRetries` = transport-close/truncation retry cap (loop/cost guard);
 * `bufferCapBytes` = OOM guard before retreating to live forwarding (0 =
 * unlimited); `heartbeatSec` = forced keepalive interval during the buffer window.
 */
export interface BufferedRetryCaps {
  maxRetries: number
  bufferCapBytes: number
  heartbeatSec: number
}

/**
 * Resolved continuation-retry settings for one vendor (`resolveContinuation` return). After the first
 * block commits, a mid-stream RST triggers a synthetic continuation turn (spec
 * 2026-07-22-continuation-retry-and-sequential-anchor §4). `enabled` gates it per vendor; `message` is
 * the synthetic user-turn text. Resolution mirrors caps: per-vendor override > shared > built-in
 * default (`{ enabled: true, message: "network issue. please continue" }`).
 */
export interface BufferedRetryContinuation {
  enabled: boolean
  message: string
}

export type MaxTokensContinuationTextStrategy = "continue" | "passthrough"
export type MaxTokensContinuationToolUseStrategy = "continue" | "passthrough"
export type MaxTokensContinuationThinkingStrategy = "passthrough" | "retry_with_budget"
export type MaxTokensContinuationVisibility = "transparent" | "passthrough" | "marker"

/**
 * Resolved max_tokens continuation policy for one vendor. P0 only resolves and records this
 * policy; P1 is the first phase allowed to consume it for continuation behavior.
 */
export interface MaxTokensContinuationConfig {
  enabled: boolean
  maxRounds: number
  classes: {
    text: MaxTokensContinuationTextStrategy
    toolUse: MaxTokensContinuationToolUseStrategy
    thinking: MaxTokensContinuationThinkingStrategy
  }
  message: string
  visibility: MaxTokensContinuationVisibility
  thinkingRetryBudget: number | null
}

export interface EffectiveMaxTokensContinuationConfig extends MaxTokensContinuationConfig {
  diagnostics: Array<"strategy-prevented-stitch">
}

/** Partial vendor override; class fields resolve independently so one override need not repeat every strategy. */
export interface MaxTokensContinuationOverride extends Omit<Partial<MaxTokensContinuationConfig>, "classes"> {
  classes?: Partial<MaxTokensContinuationConfig["classes"]>
}

/** unknown HTTP endpoint 日志级别（silent = 不打）。值须与 config/schema.ts 的 LOG_LEVELS 一致。 */
export type LogLevel = "silent" | "debug" | "info" | "warn" | "error"

/** unknown HTTP endpoint 按状态码分类的日志级别（404 = notFound / 405 = methodNotAllowed）。 */
export interface UnknownEndpointLogging {
  notFound: LogLevel
  methodNotAllowed: LogLevel
}

export type DiagnosticLogLevel = "silent" | "trace" | "debug" | "info" | "warn" | "error" | "fatal"

export interface LoggingConfigState {
  terminalLevel: DiagnosticLogLevel
  fileLevel: DiagnosticLogLevel
  fileEnabled: boolean
  fileDirectory: string
  fileMaxSizeMb: number
  fileMaxFilesPerProcess: number
  retentionDays: number
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Vocabulary whose OWNERSHIP was inverted (S5).
//
// Each of these used to be declared in the module that implements the behaviour, and `state` /
// `state-defaults` imported it from there — which is what made those two files depend on the
// anthropic, config, models and rate-limiter domains for nothing but a name. A leaf cannot import,
// so the name comes here and the implementation module imports it back. Nothing about the
// implementation moved.
//
// Two of them could not simply be relocated, because they were DERIVED from a runtime value
// (`(typeof X)[number]`, `z.infer<...>`) and the derivation cannot follow into an import-free file.
// Those are written out explicitly here and pinned to their source with a compile-time
// assignability assertion at the site that still owns the runtime value — so a change to the array
// or the zod schema is a type error rather than a silent divergence.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Compile-time assertion that `A` is assignable to `B`.
 *
 * Written as a CONSTRAINT (`A extends B` in the parameter list), not as a conditional type. The
 * conditional form — `type X = [A extends B ? true : never]` — is inert: a type alias is allowed to
 * evaluate to `never`, so nothing ever reports it, and the assertion silently accepts everything.
 * That version was written here first and measured: mutating the zod schema left typecheck green.
 * Use this one, and mutate the source of truth once to confirm the red actually comes from the
 * assertion rather than from some incidental error nearby.
 */
export type AssertAssignable<A extends B, B> = A & B

/** How the assistant block-layout repair reorders blocks. Implemented by `anthropic/sanitize/block-layout-contract`. */
export type AssistantBlockLayoutStrategy = "passthrough" | "move_blocks"

/**
 * Which synthetic separator carrier is emitted. Implemented by `anthropic/sanitize/separator-carrier`,
 * whose `SEPARATOR_CARRIERS` table is asserted key-equivalent to this union.
 */
export type SeparatorCarrier = "marker_v1"

/** Which emptiness makes a `thinking` block droppable. Implemented by `anthropic/sanitize/content-blocks`. */
export type ThinkingBlockSanitizeMode = "all_empty" | "signature_empty" | "thinking_empty" | "any_empty"

/**
 * A tool-input repair layer. Implemented by `anthropic/tool-input-repair`, whose `REPAIR_ITEMS`
 * array is asserted element-equivalent to this union — the order there is the cascade order and is
 * NOT expressible here, which is why the array stays the source of truth for sequencing.
 */
export type RepairItem = "tags" | "unicode" | "jsonrepair" | "unicode-lossy"

/** Config-managed per-model rate-limiter tuning. Implemented by `adaptive-rate-limiter`. */
export interface AdaptiveRateLimiterConfig {
  baseRetryIntervalSeconds: number
  maxRetryIntervalSeconds: number
  requestIntervalSeconds: number
  recoveryTimeoutSeconds: number
  consecutiveSuccessesForRecovery: number
  gradualRecoverySteps: Array<number>
}

/** The ingress formats `model_translation` can be keyed by. */
export type ModelTranslationIngress = "anthropic-messages" | "openai-cc" | "openai-responses" | "gemini"

/** The per-pair translation features a rule may request. */
export type ModelTranslationFeature = "strip-thinking-signature"

/** One `<model>@<format>` translation rule. */
export interface ModelTranslationRule {
  match: string
  features?: Array<ModelTranslationFeature>
}

/**
 * `model_translation`: per-ingress ordered rule lists, first match wins. Structurally equivalent to
 * `z.infer<typeof ModelTranslationSchema>` in `config/schema.ts`, which asserts the equivalence in
 * both directions — the zod schema stays the parser and the single source of validation.
 */
export type ModelTranslation = Partial<Record<ModelTranslationIngress, Array<ModelTranslationRule>>>
