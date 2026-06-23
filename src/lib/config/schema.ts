/**
 * Single source of truth for `config.yaml` validation.
 *
 * Defines Zod schemas for every config section. TypeScript types are
 * inferred via `z.infer<typeof Schema>` and re-exported from
 * `./config.ts` to keep the public import surface stable.
 *
 * Why Zod (over hand-maintained Sets):
 *   - Validates field names AND types AND value ranges in one pass.
 *   - Eliminates drift between TS interfaces and runtime validation.
 *   - Can export to JSON Schema for YAML LSP / IDE auto-completion
 *     (see `scripts/generate-config-json-schema.ts`).
 *
 * Null handling:
 *   All scalar leaves accept `null` (via `.nullish()`) so the HTTP PUT
 *   `/api/config/yaml` endpoint can use `null` to mean "delete this key".
 *   The post-parse transform converts `null` → `undefined`, so the
 *   downstream apply logic only sees `T | undefined`.
 *
 * Strictness: top-level and section objects use `.strict()` so any
 * unknown key triggers a validation issue. Free-form `Record<string, T>`
 * fields (model_overrides, effort_overrides, …) are NOT strict —
 * their keys are user-defined.
 */

import { z } from "zod"

// ============================================================================
// Leaf helpers — common error messages + `null` acceptance
// ============================================================================

const POSITIVE_INT_MSG = "Must be a non-negative integer or null"
const BOOLEAN_MSG = "Must be a boolean or null"
const STRING_MSG = "Must be a string or null"

function nullableNonnegativeInt() {
  return z
    .number({ error: POSITIVE_INT_MSG })
    .int(POSITIVE_INT_MSG)
    .nonnegative(POSITIVE_INT_MSG)
    .nullable()
    .transform((v): number | undefined => v ?? undefined)
    .optional()
}

const UNIT_FLOAT_MSG = "Must be a number in (0, 1] or null"

/** A float in the half-open interval (0, 1] — e.g. auto_truncate.target_factor (0 would zero the limit). */
function nullableUnitFloat() {
  return z
    .number({ error: UNIT_FLOAT_MSG })
    .gt(0, UNIT_FLOAT_MSG)
    .lte(1, UNIT_FLOAT_MSG)
    .nullable()
    .transform((v): number | undefined => v ?? undefined)
    .optional()
}

function nullableBoolean() {
  return z
    .boolean({ error: BOOLEAN_MSG })
    .nullable()
    .transform((v): boolean | undefined => v ?? undefined)
    .optional()
}

function nullableString() {
  return z
    .string({ error: STRING_MSG })
    .nullable()
    .transform((v): string | undefined => v ?? undefined)
    .optional()
}

function nullableEnum<T extends readonly [string, ...Array<string>]>(values: T) {
  const message = `Must be one of: ${values.join(", ")}`
  return z
    .enum(values as unknown as [string, ...Array<string>], { error: message })
    .nullable()
    .transform((v): T[number] | undefined => v ?? undefined)
    .optional()
}

function nullableNonemptyStringArray() {
  const ITEM_MSG = "Must be a non-empty string"
  return z
    .array(z.string({ error: ITEM_MSG }).nonempty(ITEM_MSG))
    .nullable()
    .transform((v): Array<string> | undefined => v ?? undefined)
    .optional()
}

// ============================================================================
// Shared primitives
// ============================================================================

export const RewriteRuleSchema = z
  .object({
    from: z.string().nonempty("Must be a non-empty string"),
    to: z.string({ error: "Must be a string" }),
    method: z.enum(["line", "regex"], { error: "Must be 'line' or 'regex'" }).optional(),
    model: z.string().optional(),
  })
  .strict()

const RewriteRuleListSchema = z
  .array(RewriteRuleSchema)
  .nullable()
  .transform((v): Array<z.infer<typeof RewriteRuleSchema>> | undefined => v ?? undefined)
  .optional()
  .superRefine((rules, ctx) => {
    if (!rules) return
    for (const [index, rule] of rules.entries()) {
      if ((rule.method ?? "regex") === "regex") {
        // Strip leading inline-flag prefix (?flags) before testing — matches
        // compileRewriteRule() runtime behavior (see src/lib/config/config.ts).
        const stripped = rule.from.replace(/^\(\?[a-z]+\)/i, "")
        try {
          new RegExp(stripped)
        } catch {
          ctx.addIssue({
            code: "custom",
            message: "Invalid rewrite rule regex",
            path: [index, "from"],
            params: { rejectedValue: rule.from },
          })
        }
      }
    }
  })

// ============================================================================
// Section schemas
// ============================================================================

export const RateLimiterConfigSchema = z
  .object({
    retry_interval: nullableNonnegativeInt(),
    request_interval: nullableNonnegativeInt(),
    /** Seconds before attempting recovery from rate-limited mode (legacy `recovery_timeout` was minutes; compat layer migrates ×60). */
    recovery_interval: nullableNonnegativeInt(),
    consecutive_successes: nullableNonnegativeInt(),
  })
  .strict()

export const AnthropicConfigSchema = z
  .object({
    tool_strip_server: nullableBoolean(),
    /**
     * Inject Claude Code official tool stubs (Bash, Read, Write, …) when
     * referenced in message history but missing from the request's tools
     * array. Default true. Disable for non-Claude-Code clients to save
     * prompt budget and avoid biasing the model toward tool calls.
     */
    tool_inject_claude_code: nullableBoolean(),
    thinking_block_message_policy: nullableEnum(["preserve", "stripped"] as const),
    /**
     * Drop corrupt thinking blocks before sending upstream. Validity is decided
     * by the SIGNATURE, not the thinking text — a legitimate *encrypted* thinking
     * block has empty text but a valid signature, and is always kept.
     * `"empty_thinking"` (default) removes only double-empty blocks (both `thinking`
     * text AND `signature` empty, e.g. a `{thinking:"", signature:""}` block a client
     * echoed back), which upstream rejects with "each thinking block must contain
     * thinking". `"empty_any"` removes any thinking block with an empty signature,
     * regardless of text. `false` disables the pass.
     */
    thinking_block_sanitize: z
      .union([z.literal(false), z.literal("empty_thinking"), z.literal("empty_any"), z.null()], {
        error: "Must be one of: false, empty_thinking, empty_any",
      })
      .optional()
      .transform((v) => v ?? undefined),
    /**
     * Coerce legacy `thinking.type="enabled"` to `"adaptive"` for models that
     * only support adaptive thinking (opus 4.6/4.7/4.8). Solves the upstream
     * 400 when an old client sends `enabled` + `budget_tokens` to such a model.
     *   basic:       coerce to { type: "adaptive" }, drop budget_tokens (default)
     *   best_effort: also map budget_tokens to output_config.effort (only when
     *                the client did not send an explicit effort)
     *   false:       disabled — pass the client config through unchanged
     */
    thinking_coerce_adaptive: z
      .union([z.literal(false), z.literal("basic"), z.literal("best_effort"), z.null()], {
        error: "Must be one of: false, basic, best_effort",
      })
      .optional()
      .transform((v) => v ?? undefined),
    /**
     * Handle `role:"system"` messages mixed into the `messages` array — illegal for
     * the Anthropic Messages API (system must be the top-level `system` param),
     * which rejects them with `Unexpected role "system"`. Such inline system
     * messages come from OpenAI-habit clients or Claude Code's mid-conversation
     * context injections (hook output / rules / reminders).
     *   drop_invalid:  remove every inline system message
     *   merge:         pull their text out, append to the top-level `system`, drop the messages
     *   as_user:       rewrite role to "user" (keeps position — recommended)
     *   as_assistant:  rewrite role to "assistant" (experimental, not recommended —
     *                  disguises context as model output, highest risk)
     *   false:         passthrough unchanged (default — will 400 upstream if present)
     */
    system_messages_sanitize: z
      .union([z.literal(false), z.literal("drop_invalid"), z.literal("merge"), z.literal("as_user"), z.literal("as_assistant"), z.null()], {
        error: "Must be one of: false, drop_invalid, merge, as_user, as_assistant",
      })
      .optional()
      .transform((v) => v ?? undefined),
    /**
     * Client compatibility shim for the streaming thinking frame some Copilot
     * upstreams emit — `content_block_start {type:"thinking", thinking:"",
     * signature:S}` with NO trailing `signature_delta`. The upstream is the
     * protocol authority; standard clients just ignore a signature on
     * content_block_start (taking it only from signature_delta), so they drop it
     * and echo back a corrupt `{thinking:"", signature:""}` block which the
     * upstream then rejects. Applies to the client-facing stream only (history
     * keeps the raw upstream frames).
     *   "signature_delta" (default): emit an empty thinking start + a synthesized
     *                                 signature_delta (standard protocol shape).
     *   "redacted_thinking":         rewrite as redacted_thinking{data:S}.
     *   false:                       passthrough (no compat shim).
     */
    thinking_signature_compat: z
      .union([z.literal(false), z.literal("signature_delta"), z.literal("redacted_thinking"), z.null()], {
        error: "Must be one of: false, signature_delta, redacted_thinking",
      })
      .optional()
      .transform((v) => v ?? undefined),
    /**
     * Rewrite native server-tool blocks left in inbound message history before
     * sending upstream. The web_search double-hop surfaces a synthesized
     * `server_tool_use{web_search}` + `web_search_tool_result` pair to the client
     * (so results are visible); the client echoes it back, but the downgraded
     * `tools` array no longer declares `web_search` as a server tool → upstream 400.
     *   "downgrade": rewrite the pair into plain tool_use + tool_result, splitting
     *                the assistant turn so the tool_result lands in a user message.
     *   false:       passthrough (default).
     */
    tool_rewrite_history_server: z
      .union([z.literal(false), z.literal("downgrade"), z.null()], {
        error: "Must be one of: false, downgrade",
      })
      .optional()
      .transform((v) => v ?? undefined),
    tool_dedup_calls: z
      .union([z.boolean(), z.literal("input"), z.literal("result"), z.null()], {
        error: "Must be one of: false, true, input, result",
      })
      .optional()
      .transform((v) => v ?? undefined),
    tool_strip_read_result_tags: nullableBoolean(),
    system_rewrite_reminders: z
      .union([z.boolean(), z.array(RewriteRuleSchema), z.null()])
      .optional()
      .transform((v) => v ?? undefined),
    context_editing: nullableEnum(["off", "clear-thinking", "clear-tooluse", "clear-both"] as const),
    context_editing_trigger: nullableNonnegativeInt(),
    context_editing_keep_tools: nullableNonnegativeInt(),
    context_editing_keep_thinking: nullableNonnegativeInt(),
    tool_search: nullableBoolean(),
    cache_control: nullableEnum(["disabled", "passthrough", "sanitize", "proxied"] as const),
    tool_non_deferred: nullableNonemptyStringArray(),
    api_key: nullableString(),
    warmup: nullableEnum(["allow", "reject", "drop", "fake"] as const),
    // Free-form Records — key = model-name pattern, value = list
    effort_overrides: z.record(z.string(), z.array(z.string())).optional(),
    beta_strip_headers: z.record(z.string(), z.array(z.string())).optional(),
    partner_strip_features: z.record(z.string(), z.array(z.string())).optional(),
    retry_reject_body_fields: z.record(z.string(), z.array(z.string())).optional(),
    // Tool-name-keyed (NOT model-keyed): keys are matched verbatim against the
    // tool name — must NOT go through normalizeModelKeyedRecord, which would
    // fold case/separators and break lookups. Replace semantic (default).
    tool_decode_input_fields: z.record(z.string(), z.array(z.string())).optional(),
    tool_decode_all_input_fields: nullableBoolean(),
    tool_recover_call_text: nullableBoolean(),
    /**
     * Backfill a missing `AskUserQuestion` `questions[].question` from its `header` on the response wire (Claude Code rejects a question item with a header but no question).
     * Only items missing the `question` key are touched. Default true.
     */
    tool_backfill_question: nullableBoolean(),
    /**
     * Synthetic SSE keepalive ping cadence (seconds) for the client-facing live
     * Anthropic stream. `0` disables; default **45**. Claude Code's request
     * timeout is an IDLE watchdog at ~60s (Q2 oracle), so the cadence must be
     * < 60s to keep the client alive — the prior 120s default was ineffective.
     * Any positive integer is the minimum seconds between forwarded events that
     * must pass before the proxy injects an Anthropic-protocol `event: ping`
     * frame — covers BOTH mid-stream idle gaps (opus-4.8 adaptive thinking that
     * goes silent after `content_block_start`) AND the ③ pre-response-grace
     * commit keepalive. Heartbeats are PROXY-originated and do NOT reset the
     * upstream idle-timeout (so a genuinely dead upstream still fails). Recorded
     * in `forwardedSseEvents` (visible diagnostic), never in the raw upstream
     * `sseEvents`. The interval is captured at stream start — in-flight streams
     * keep their original value across hot-reload; new streams pick up the new
     * value. (Renamed from `stream_fake_sse_heartbeat`; old key auto-migrates.)
     */
    stream_keepalive_ping_sec: nullableNonnegativeInt(),
    /**
     * L2 — transactional buffered retry for streaming generations cut short by an
     * upstream mid-stream RST (GHC NGHTTP2_CANCEL on large Write/Edit). Buffers the
     * whole response and commits only after `message_stop`, re-running the exchange
     * on a transport-close / truncation, transparently to the client. See
     * docs/rfc/streaming-upstream-rst-buffered-retry.md.
     *   "on":            buffer every streaming Anthropic response.
     *   "tool_use_only": buffer only when the request carries `tools` (the large
     *                    Write/Edit scenario); pure-text chat stays live (no latency).
     *   false:           disabled (default) — live streaming, no buffering.
     */
    protect_streaming_generation: z
      .union([z.literal(false), z.literal("on"), z.literal("tool_use_only"), z.null()], {
        error: "Must be one of: false, on, tool_use_only",
      })
      .optional()
      .transform((v) => v ?? undefined),
    /**
     * Max transport-close / truncation retries for the buffered-retry path (a
     * loop/cost guard, NOT a timeout guard — the client is kept alive by the
     * forced heartbeat). `0` = no retry (buffer + commit only). Default 3.
     */
    protect_streaming_max_retries: nullableNonnegativeInt(),
    /**
     * L2 buffered-path memory guard: max bytes to buffer before ABANDONING buffering and
     * retreating to live forwarding for the rest of THIS response (the response then loses
     * L2 protection — a live RST fails as today). Prevents a pathologically huge generation
     * from buffering unbounded → OOM. `0` = unlimited. Default 16MiB.
     */
    protect_streaming_buffer_cap_bytes: nullableNonnegativeInt(),
    /**
     * On each buffered RST/truncation retry, FORCE a progressively aggressive native
     * `clear_tool_uses` context_management edit (lower trigger + smaller keep) to compress the
     * context so the generation finishes faster — within the next RST window (RFC §8). Independent
     * of `context_editing` (a retry-only emergency compression); skipped when the model doesn't
     * support context_management. Changes request semantics (drops more old context). Default false.
     */
    protect_streaming_escalate_context: nullableBoolean(),
    /**
     * Config-driven model-capability allowlists. Each is a list of model-name "family" prefixes
     * (normalized: lowercase, dots→dashes); a model has the capability when its normalized id equals
     * an entry or starts with `entry + "-"`. Bundled defaults mirror GHC's capability checks — edit
     * to add/remove models (e.g. a new Claude release) WITHOUT a code change. See features.ts.
     */
    model_capabilities: z
      .object({
        context_editing: nullableNonemptyStringArray(),
        tool_search: nullableNonemptyStringArray(),
        interleaved_thinking: nullableNonemptyStringArray(),
        adaptive_thinking: nullableNonemptyStringArray(),
      })
      .strict()
      .optional(),
    /**
     * Forced heartbeat interval (seconds) for the buffered-retry path. The buffered
     * sink withholds all real frames until `message_stop`, so the client would idle
     * out without a ping; the buffered path constructs a heartbeat UNCONDITIONALLY,
     * using `stream_keepalive_ping_sec` when positive, otherwise this fallback.
     * Default 15.
     */
    protect_streaming_heartbeat: nullableNonnegativeInt(),
  })
  .strict()

export const ShutdownConfigSchema = z
  .object({
    graceful_wait: nullableNonnegativeInt(),
    abort_wait: nullableNonnegativeInt(),
  })
  .strict()

export const ResponsesConfigSchema = z
  .object({
    normalize_call_ids: nullableBoolean(),
    upstream_ws: nullableBoolean(),
    fix_stream_ids: nullableBoolean(),
    client_ws_keep_open: nullableBoolean(),
    /**
     * Strip the `image_generation` builtin tool from inbound Responses
     * requests. The Copilot upstream rejects it (failing the whole request),
     * and some clients (e.g. Codex CLI) auto-inject it. Default false.
     */
    strip_image_generation_tool: nullableBoolean(),
    /** Optional cap on inbound WS frame bytes (default 0 = unlimited; set positive to opt into a hard cap). */
    max_ws_frame_bytes: nullableNonnegativeInt(),
    /** Max concurrent client WS connections (default 256; 0 = unlimited). */
    max_client_ws_connections: nullableNonnegativeInt(),
    /** Soft cap on upstream WS pool size (default 32; 0 = unlimited). */
    max_upstream_ws_connections: nullableNonnegativeInt(),
  })
  .strict()

export const HistoryConfigSchema = z
  .object({
    /** @deprecated 兼容旧配置;缺省的 success_limit/failure_limit 回退到它 */
    limit: nullableNonnegativeInt(),
    /** Max successful (non-failed) entries kept in SQLite (0 = unlimited). */
    success_limit: nullableNonnegativeInt(),
    /** Max failed entries kept in SQLite (0 = unlimited). */
    failure_limit: nullableNonnegativeInt(),
    reaper_interval: nullableNonnegativeInt(),
    db_path: nullableString(),
  })
  .strict()

export const WebSearchConfigSchema = z
  .object({
    /** Enable the double-hop web_search server-tool implementation (Anthropic path only). Default false. */
    enabled: nullableBoolean(),
    /**
     * Search backend selector:
     *   ""        — not configured / disabled (default)
     *   "searxng" — local SearXNG instance at http://localhost:8080
     *   other     — treated as a Copilot Responses search model id (e.g. "gpt-5.5")
     */
    backend: nullableString(),
  })
  .strict()

export const AutoTruncateConfigSchema = z
  .object({
    /** Enable reactive auto-truncate (retry with a truncated payload on upstream token-limit errors). Default false. Also settable via CLI --auto-truncate, which wins when explicitly passed. */
    enabled: nullableBoolean(),
    /** Truncation target as a fraction of the upstream-reported limit (target = limit × factor). (0, 1]; smaller = safer/more removed, larger = leaner. Default 0.9. */
    target_factor: nullableUnitFloat(),
    /** Max reactive auto-truncate retries per request. 0 = a single attempt, no retry. Default 5. */
    max_retries: nullableNonnegativeInt(),
    /** Compress old tool_result content before truncating messages. Default true. (Was top-level `compress_tool_results_before_truncate`.) */
    compress_tool_results: nullableBoolean(),
    /** Character-length threshold (NOT tokens) above which a tool_result block is compressed. 0 = compress everything. Default 10000. */
    compress_threshold: nullableNonnegativeInt(),
  })
  .strict()

export const TimeoutsConfigSchema = z
  .object({
    /** Max seconds between SSE events (0 = no timeout). Was top-level `stream_idle_timeout`. */
    stream_idle: nullableNonnegativeInt(),
    /** Max seconds from request start to receiving HTTP response headers (0 = no timeout). Was top-level `fetch_timeout`. */
    response_header: nullableNonnegativeInt(),
    /** Upstream TCP keepalive initial-probe delay in seconds (0 = use undici default 60s). Keeps GHC connection alive through long opus thinking silences so NAT/firewall idle reapers don't sever it. Node-only. */
    upstream_keepalive: nullableNonnegativeInt(),
    /** Max seconds an active request may live before the stale reaper forces failure (0 = disabled). Was top-level `stale_request_max_age`. */
    stale_request_max_age: nullableNonnegativeInt(),
  })
  .strict()

// ============================================================================
// Top-level Config schema
// ============================================================================

/**
 * Free-form Record<string, string> with non-empty key + non-empty value enforcement.
 *
 * Merge semantics: **per-key** (registered via `MERGE_STRATEGY` below). The
 * bundled defaults provide recommended alias mappings (e.g.
 * `opus → claude-opus-4.7-1m-internal`); the user's file only needs to
 * declare overrides for the keys they want to change. Bundled keys without
 * a user counterpart remain in effect.
 */
const ModelOverridesSchema = z.record(z.string(), z.string()).superRefine((value, ctx) => {
  for (const [k, v] of Object.entries(value)) {
    if (k.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Override key must be a non-empty string",
        path: [k],
        // Zod overrides `input` with the parent value, so stash the rejected
        // key under `params` for the issue formatter to read.
        params: { rejectedValue: k },
      })
    }
    if (typeof v !== "string" || v.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Override target must be a non-empty string",
        path: [k],
        params: { rejectedValue: v },
      })
    }
  }
})

/**
 * Explicit upstream GHC API base URL. Overrides the URL derived from
 * `accountType`. Useful when routing through a self-hosted GHC proxy or
 * when upstream's hostname-by-account-type convention doesn't fit the
 * deployment. Accepts `null` to clear via HTTP PUT.
 */
const GhcApiBaseUrlSchema = z
  .string({ error: STRING_MSG })
  .nullable()
  .transform((v): string | undefined => v ?? undefined)
  .optional()
  .superRefine((value, ctx) => {
    if (value === undefined || value === "") return
    try {
      const url = new URL(value)
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        ctx.addIssue({
          code: "custom",
          message: "ghc_api_base_url must use http or https scheme",
          params: { rejectedValue: value },
        })
      }
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "ghc_api_base_url must be a valid URL",
        params: { rejectedValue: value },
      })
    }
  })

const ProxySchema = z
  .string({ error: STRING_MSG })
  .nullable()
  .transform((v): string | undefined => v ?? undefined)
  .optional()
  .superRefine((value, ctx) => {
    if (value === undefined) return
    try {
      const url = new URL(value)
      if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)) {
        ctx.addIssue({
          code: "custom",
          message: "Proxy must use http, https, socks5, or socks5h scheme",
          params: { rejectedValue: value },
        })
      }
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Proxy must be a valid URL",
        params: { rejectedValue: value },
      })
    }
  })

/** Wrap a section schema so HTTP PUT can send `null` to delete it. */
function nullableSection<S extends z.ZodObject>(schema: S) {
  return schema
    .nullable()
    .transform((v): z.infer<S> | undefined => v ?? undefined)
    .optional()
}

export const ConfigSchema = z
  .object({
    proxy: ProxySchema,
    ghc_api_base_url: GhcApiBaseUrlSchema,
    system_prompt_overrides: RewriteRuleListSchema,
    system_prompt_prepend: nullableString(),
    system_prompt_append: nullableString(),
    rate_limiter: nullableSection(RateLimiterConfigSchema),
    anthropic: nullableSection(AnthropicConfigSchema),
    openai_responses: nullableSection(ResponsesConfigSchema),
    model_overrides: ModelOverridesSchema.nullable()
      .transform((v): z.infer<typeof ModelOverridesSchema> | undefined => v ?? undefined)
      .optional(),
    disabled_models: nullableNonemptyStringArray(),
    /**
     * Reactive auto-truncate settings (nested section). When `enabled`, an upstream
     * token-limit error (400/413) triggers a retry with a truncated payload instead
     * of surfacing the error. Top-level (not under `anthropic.*`) because it spans
     * both the Anthropic and Chat Completions retry pipelines. `enabled` is also
     * settable via the CLI `--auto-truncate` flag, which takes precedence when
     * explicitly passed. `target_factor` / `max_retries` / `compress_threshold` tune
     * the truncation behavior (config-only).
     */
    auto_truncate: nullableSection(AutoTruncateConfigSchema),
    /**
     * Sanitize tool names that violate the target model's constraints (illegal
     * characters like dots, over-length, collisions) into legal names before
     * sending upstream, restoring the client's original names in the response.
     * Spans Anthropic + Chat Completions + Responses paths. Default false.
     * Top-level (not under `anthropic.*`) because it is cross-protocol.
     */
    sanitize_tool_names: nullableBoolean(),
    history: nullableSection(HistoryConfigSchema),
    web_search: nullableSection(WebSearchConfigSchema),
    shutdown: nullableSection(ShutdownConfigSchema),
    timeouts: nullableSection(TimeoutsConfigSchema),
    model_refresh_interval: nullableNonnegativeInt(),
  })
  .strict()

// ============================================================================
// Legacy key migrations (renames / relocations / removals) live in ./compat.ts
// (see CONFIG_MIGRATIONS). schema.ts owns only the CURRENT valid shape.
// ============================================================================

// ============================================================================
// Merge-strategy registry — schema-driven, business-semantic merge behavior
// ============================================================================
//
// The schema-driven config merger (`mergeBySchema` in `./config.ts`) chooses
// how to combine bundled defaults with user overrides at each node based on
// the schema's shape PLUS, for `ZodRecord` nodes, this explicit registry.
//
// All overrides are **business-driven**: the schema alone (record vs object,
// array vs scalar) cannot distinguish, for example, "user adds one alias on
// top of bundled" (`model_overrides`) from "user takes full ownership of
// this strategy table" (`anthropic.effort_overrides`). We make those
// choices here as deliberate product decisions, not as type inferences.

/** Merge strategy for a `ZodRecord` schema node. */
export type RecordMergeStrategy = "per-key" | "replace"

/**
 * Per-schema merge strategy registry. Use a WeakMap so the strategy is
 * carried by the schema object itself (immune to .nullable() / .optional()
 * / .superRefine() wrapper chains that would otherwise reset `.meta()`).
 *
 * Only `ZodRecord` schemas need entries — `ZodObject` recurses by shape
 * automatically and `ZodArray` / scalars always replace. Records without
 * an entry default to `"replace"` (the more conservative choice: user
 * owns the table once they declare it).
 */
export const RECORD_MERGE_STRATEGIES = new WeakMap<z.ZodType, RecordMergeStrategy>()

RECORD_MERGE_STRATEGIES.set(ModelOverridesSchema, "per-key")
// effort_overrides / beta_strip_headers / partner_strip_features / retry_reject_body_fields intentionally
// omitted — they default to "replace": when the user sets one of these
// tables, they take responsibility for the entire policy.

// ============================================================================

export type RewriteRule = z.infer<typeof RewriteRuleSchema>
export type RateLimiterConfig = z.infer<typeof RateLimiterConfigSchema>
export type AnthropicConfig = z.infer<typeof AnthropicConfigSchema>
export type ShutdownConfig = z.infer<typeof ShutdownConfigSchema>
export type ResponsesConfig = z.infer<typeof ResponsesConfigSchema>
export type HistoryConfig = z.infer<typeof HistoryConfigSchema>
export type WebSearchConfig = z.infer<typeof WebSearchConfigSchema>
export type TimeoutsConfig = z.infer<typeof TimeoutsConfigSchema>
/** Config-file shape of the `auto_truncate` section (distinct from the engine's runtime `AutoTruncateConfig`). */
export type AutoTruncateConfigSection = z.infer<typeof AutoTruncateConfigSchema>
export type Config = z.infer<typeof ConfigSchema>
