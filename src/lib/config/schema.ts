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
 * fields (model_mappings, effort_overrides, …) are NOT strict —
 * their keys are user-defined.
 */

import { z } from "zod"

import {
  //
  REPAIR_ITEMS,
  type RepairItem,
} from "~/lib/anthropic/tool-input-repair"

// ============================================================================
// Leaf helpers — common error messages + `null` acceptance
// ============================================================================

const POSITIVE_INT_MSG = "Must be a non-negative integer or null"
const POSITIVE_NUMBER_MSG = "Must be a positive number or null"
const BOOLEAN_MSG = "Must be a boolean or null"
const STRING_MSG = "Must be a string or null"
const REPAIR_ITEMS_MSG = `Must be a comma-separated subset of: ${REPAIR_ITEMS.join(", ")} (empty string = off)`

function nullableNonnegativeInt() {
  return z
    .number({ error: POSITIVE_INT_MSG })
    .int(POSITIVE_INT_MSG)
    .nonnegative(POSITIVE_INT_MSG)
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

/** A strictly-positive number — durations/limits where 0 or negative is nonsensical (e.g. poisoned_thinking_ttl_hours; a 0h TTL would never quarantine). */
function nullablePositiveNumber() {
  return z
    .number({ error: POSITIVE_NUMBER_MSG })
    .gt(0, POSITIVE_NUMBER_MSG)
    .nullable()
    .transform((v): number | undefined => v ?? undefined)
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

/**
 * Endpoint-scope values for system-prompt rules/entries. MUST stay in sync with
 * `ClientFormat` in `~/lib/pipeline/envelope.ts` — inlined here (not imported) to
 * keep the config schema layer free of a pipeline import. A rule/entry is applied
 * only when the request's inbound client format is in this set (undefined = all).
 */
export const ENDPOINT_SCOPE_VALUES = ["anthropic", "openai-cc", "openai-responses", "gemini"] as const

/** `endpoint?: <one> | [<many>]` — a single endpoint value or an array of them. */
const endpointScope = () =>
  z.union([z.enum(ENDPOINT_SCOPE_VALUES), z.array(z.enum(ENDPOINT_SCOPE_VALUES)).nonempty("Must be a non-empty array of endpoints")]).optional()

export const RewriteRuleSchema = z
  .object({
    from: z.string().nonempty("Must be a non-empty string"),
    to: z.string({ error: "Must be a string" }),
    method: z.enum(["line", "regex"], { error: "Must be 'line' or 'regex'" }).optional(),
    /** Model-name regex filter (case-insensitive). undefined = all models. */
    model: z.string().optional(),
    /** Endpoint scope. undefined = all endpoints. */
    endpoint: endpointScope(),
  })
  .strict()

/**
 * A single scoped system-prompt prepend/append entry: the `text` plus optional
 * `model` / `endpoint` scope (same two-axis AND semantics as {@link RewriteRuleSchema}).
 */
export const SystemPromptEntrySchema = z
  .object({
    text: z.string({ error: "Must be a string" }),
    /** Model-name regex filter (case-insensitive). undefined = all models. */
    model: z.string().optional(),
    /** Endpoint scope. undefined = all endpoints. */
    endpoint: endpointScope(),
  })
  .strict()

/**
 * `system_prompt_prepend` / `system_prompt_append` accept, for backward compat:
 *   - a plain string (legacy; unscoped single entry), or
 *   - a single {@link SystemPromptEntrySchema}, or
 *   - an array of entries (evaluated top-down, matching entries concatenated).
 */
const SystemPromptTextListSchema = z
  .union([z.string(), SystemPromptEntrySchema, z.array(SystemPromptEntrySchema)])
  .nullable()
  .transform((v): string | z.infer<typeof SystemPromptEntrySchema> | Array<z.infer<typeof SystemPromptEntrySchema>> | undefined => v ?? undefined)
  .optional()

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

/**
 * Vendor-neutral buffered-retry caps override. Shared shape for:
 *   - top-level `buffered_retry` (shared caps, no `enabled` semantic),
 *   - `anthropic.buffered_retry` (per-vendor cap override; Anthropic's mode
 *     switch is the tri-state `protect_streaming_generation`, so `enabled` is
 *     ignored here),
 *   - `openai_responses.buffered_retry` / `chat_completions.buffered_retry`
 *     (per-vendor override PLUS the `enabled` mode switch — see
 *     {@link nullableBufferedRetry}, which also accepts a bare boolean as the
 *     `enabled` shorthand).
 *
 * Resolution priority (see `resolveBufferedCaps` in state.ts): per-vendor
 * override > shared `buffered_retry.*` > built-in default (max_retries 3 /
 * buffer_cap_bytes 16777216 / heartbeat_sec 15).
 */
export const BufferedRetryOverrideSchema = z
  .object({
    /** Mode switch (responses / chat_completions only; ignored for shared + anthropic). */
    enabled: nullableBoolean(),
    /** Max transport-close / truncation retries (loop/cost guard; 0 = no retry). */
    max_retries: nullableNonnegativeInt(),
    /** Max bytes to buffer before retreating to live forwarding (OOM guard; 0 = unlimited). */
    buffer_cap_bytes: nullableNonnegativeInt(),
    /** Forced heartbeat interval (seconds) for the buffered path; clamped < client idle deadline. */
    heartbeat_sec: nullableNonnegativeInt(),
  })
  .strict()

/**
 * `buffered_retry` value schema for vendors that carry an `enabled` mode switch
 * (Responses / Chat Completions): either a bare boolean (`enabled` shorthand)
 * or the full {@link BufferedRetryOverrideSchema} map.
 */
function nullableBufferedRetry() {
  return z
    .union([z.boolean(), BufferedRetryOverrideSchema])
    .nullable()
    .transform((v): boolean | z.infer<typeof BufferedRetryOverrideSchema> | undefined => v ?? undefined)
    .optional()
}

/**
 * Response-wire fix group — TEXT blocks. Fixes applied to `text` content blocks in the Anthropic
 * response before forwarding to the client.
 */
const ResponseTextFixSchema = z
  .object({
    /**
     * Convert a leaked `<invoke name=…>` tool call that upstream emitted as plain `text` into a real
     * `tool_use` block (the client otherwise renders it as text and never executes the tool). Default true.
     */
    invoke_in_text: nullableBoolean(),
  })
  .strict()

/**
 * Response-wire fix group — TOOL_USE blocks. Fixes applied to `tool_use` content blocks in the Anthropic
 * response before forwarding to the client. History keeps the upstream-original bytes; only the forwarded
 * stream/response is repaired.
 */
const ResponseToolUseFixSchema = z
  .object({
    /**
     * Repair malformed `tool_use` input that upstream emitted as invalid JSON. A **comma-separated set of
     * repair items** — a subset of `tags` (structure-aware antml-tag stripping), `unicode` (whitespace-broken
     * `\uXXXX` escape fix), `jsonrepair` (jsonrepair structural fix), and `unicode-lossy` (LOSSY best-effort:
     * un-completable `\uXXXX` escapes → U+FFFD, garbling ≥1 char to rescue an otherwise-dead input). Items
     * cascade in a fixed canonical order (spelling order is ignored) and stack on each other; the lossy
     * `unicode-lossy` runs LAST, only when every lossless item failed. Empty string (default) = off.
     */
    malformed_input: z
      .string({ error: REPAIR_ITEMS_MSG })
      .nullable()
      .transform((v, ctx): ReadonlyArray<RepairItem> | undefined => {
        if (v === null) return undefined
        const tokens = v
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
        const invalid = tokens.filter((t) => !(REPAIR_ITEMS as ReadonlyArray<string>).includes(t))
        if (invalid.length > 0) {
          ctx.addIssue({ code: "custom", message: `${REPAIR_ITEMS_MSG} — got invalid item(s): ${invalid.join(", ")}` })
          return z.NEVER
        }
        // Dedup + canonical order (REPAIR_ITEMS order == cascade order). Empty set = off.
        const set = new Set(tokens)
        return REPAIR_ITEMS.filter((it) => set.has(it))
      })
      .optional(),
    /**
     * Tool name → list of top-level `tool_use` input fields to decode from a stringified JSON string back
     * to structured form (e.g. `AskUserQuestion.questions` arriving as a JSON string). Keys matched verbatim
     * against the tool name (NOT model-keyed — no case/separator folding).
     */
    decode_top_level_field: z.record(z.string(), z.array(z.string())).optional(),
    /**
     * Recover a missing SendMessage `to` recipient from a misnamed `agentId` alias (the client rejects a
     * SendMessage call whose required `to` is absent). Only touched when `to` is absent and `agentId` is a
     * non-empty string. Default true.
     */
    send_message_to_missing: nullableBoolean(),
    /**
     * Backfill a missing `AskUserQuestion` `questions[].question` from its `header` (Claude Code rejects a
     * question item with a header but no question). Only items missing the `question` key are touched. Default true.
     */
    ask_user_question_question_missing: nullableBoolean(),
  })
  .strict()

export const AnthropicConfigSchema = z
  .object({
    /** Forward `/v1/messages/count_tokens` to the GHC upstream (exact counts, uses the copilot token). Default true. When false, count_tokens uses the local calibrated tiktoken estimate only. */
    use_upstream_count_tokens: nullableBoolean(),
    /**
     * Upstream→client response-header forwarding MODE (Anthropic path). `false`
     * (default) = BLACKLIST: forward everything except `response_header_blacklist`.
     * `true` = WHITELIST: forward ONLY headers matching `response_header_whitelist`.
     * Both modes apply the same security floor first (`PROXY_CONTROLLED_RESPONSE_HEADERS`
     * always removed). Client-side mirror of `strict_request_headers`.
     * See `lib/anthropic/header-policy/response-header-forward.ts`.
     */
    strict_response_headers: nullableBoolean(),
    /**
     * BLACKLIST-mode glob list (header name, `*`/`?`): upstream response header names
     * stripped from the forwarded set (active when `strict_response_headers: false`). Acts
     * on the security-floor subset only (never `PROXY_CONTROLLED_RESPONSE_HEADERS`). Default
     * `[]` strips nothing — equivalent to the old permissive `strict_response_headers:false`.
     * `[]` clears; absence retains the running value. Empty-string items rejected.
     */
    response_header_blacklist: nullableNonemptyStringArray(),
    /**
     * WHITELIST-mode glob list (header name, `*`/`?`): the ONLY upstream response header
     * names forwarded (active when `strict_response_headers: true`). `[]` forwards nothing
     * (full isolation). Default = the known-safe allowlist (request-id, x-request-id,
     * anthropic-ratelimit-*, anthropic-organization-id, retry-after) — equivalent to the old
     * strict `strict_response_headers:true`. Absence retains; empty-string items rejected.
     */
    response_header_whitelist: nullableNonemptyStringArray(),
    /**
     * Client→upstream request-header forwarding MODE (Anthropic path). `false`
     * (default) = BLACKLIST: forward client headers except `request_header_blacklist`.
     * `true` = WHITELIST: forward ONLY client headers matching `request_header_whitelist`.
     * Both modes apply the same security floor first (proxy core keys win + sensitive
     * denylist always removed; the whitelist cannot re-admit a credential). Request-side
     * mirror of `strict_response_headers`. See `lib/anthropic/header-policy/request-header-forward.ts`.
     */
    strict_request_headers: nullableBoolean(),
    /**
     * BLACKLIST-mode glob list (header name, `*`/`?`): client header names stripped
     * from the forwarded set (active when `strict_request_headers: false`). Acts on the
     * security-floor subset only (never the proxy core/anthropic-beta headers), so `["*"]`
     * empties the set (= core-only). Default `["x-anthropic-billing-header"]` strips the
     * HTTP-header form of Claude Code's attribution (defensive — current Claude Code carries
     * attribution in the body, handled by `strip_attribution_header`). `[]` clears; absence
     * retains the running value. Empty-string items rejected.
     */
    request_header_blacklist: nullableNonemptyStringArray(),
    /**
     * WHITELIST-mode glob list (header name, `*`/`?`): the ONLY client header names
     * forwarded (active when `strict_request_headers: true`), beyond the proxy's rebuilt
     * core headers. `[]` forwards nothing (core-only). Listing a true core header is a
     * no-op (stripped by the floor, re-injected as core). Default covers the safe Claude
     * Code / SDK headers beyond core (x-stainless-*, x-claude-code-*, x-app, accept,
     * anthropic-dangerous-direct-browser-access). Absence retains; empty-string items rejected.
     */
    request_header_whitelist: nullableNonemptyStringArray(),
    /**
     * Strip the Claude Code attribution billing line carried as a `system` block in
     * the request BODY. Current Claude Code injects `x-anthropic-billing-header: …`
     * as `system[0]` (a header-shaped line inside the body), which the HTTP-header
     * `request_header_blacklist` cannot reach. `true` (default) removes the leading
     * billing line from the system param (string or `system[0]`); a block emptied by
     * the strip is dropped. Anthropic path only; complements `request_header_blacklist`.
     */
    strip_attribution_header: nullableBoolean(),
    /**
     * Inject Claude Code official tool stubs (Bash, Read, Write, …) when
     * referenced in message history but missing from the request's tools
     * array. Default true. Disable for non-Claude-Code clients to save
     * prompt budget and avoid biasing the model toward tool calls.
     */
    tool_inject_claude_code: nullableBoolean(),
    thinking_block_message_policy: nullableEnum(["preserve", "stripped"] as const),
    /**
     * De-stack adjacent `thinking`/`redacted_thinking` blocks so no two are
     * consecutive in an assistant message — GHC rejects an echoed history with
     * stacked thinking ("thinking blocks cannot be modified" 400). Idempotent:
     * a message without adjacent thinking passes through byte-identical.
     *   passthrough — leave stacked thinking as-is
     *   insert_text — insert a synthetic text separator between adjacent thinking
     *   move_blocks — interleave thinking with real non-thinking blocks (order-
     *                 preserving), synthetic marker only when insufficient (default)
     */
    thinking_destack_strategy: nullableEnum(["passthrough", "insert_text", "move_blocks"] as const),
    /**
     * Reactive fallback (L2) for the GHC "thinking ... cannot be modified" 400
     * that L1 de-stack (`thinking_destack_strategy`) did not preempt: strip ALL
     * `thinking`/`redacted_thinking` blocks from the echoed history and retry the
     * turn once. `true` (default) enables the one-shot strip-and-retry; `false`
     * lets the 400 surface unmodified.
     */
    strip_thinking_on_reject: nullableBoolean(),
    /**
     * L3 durable quarantine (master switch) for the "thinking ... cannot be
     * modified" 400. When `true` (default), a successful L2 strip-all retry
     * REMEMBERS the offending `(session, agent)` conversation in a sidecar SQLite
     * store, so subsequent turns are proactively stripped ahead of the request
     * instead of paying the reactive 400+retry round-trip again. `false` disables
     * the remember/quarantine step (L2 still reacts per-turn).
     */
    poisoned_thinking_quarantine: nullableBoolean(),
    /**
     * Sliding TTL (hours) for an L3 quarantine entry. A poisoned conversation is
     * treated as poisoned for this long since its last observed poison hit; a
     * conversation quiet longer than this drops out (its thinking is no longer
     * pre-stripped). Default `72`.
     */
    poisoned_thinking_ttl_hours: nullablePositiveNumber(),
    /**
     * Drop corrupt thinking blocks before sending upstream. Validity is decided
     * by the SIGNATURE, not the thinking text — a legitimate *encrypted* thinking
     * block has empty text but a valid signature, and (except in the aggressive
     * text-based modes) is kept. The mode names WHICH field being empty triggers
     * the drop:
     * `"all_empty"` (default) removes only double-empty blocks (both `thinking`
     * text AND `signature` empty, e.g. a `{thinking:"", signature:""}` block a client
     * echoed back), which upstream rejects with "each thinking block must contain
     * thinking". `"signature_empty"` removes any thinking block with an empty
     * signature, regardless of text. `"thinking_empty"` removes any block with empty
     * text, regardless of signature (AGGRESSIVE — also deletes legitimate encrypted
     * thinking). `"any_empty"` removes when EITHER field is empty. `false` disables
     * the pass.
     */
    thinking_block_sanitize: z
      .union([z.literal(false), z.literal("all_empty"), z.literal("signature_empty"), z.literal("thinking_empty"), z.literal("any_empty"), z.null()], {
        error: "Must be one of: false, all_empty, signature_empty, thinking_empty, any_empty",
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
     * DEFAULT inline-`role:"system"` handling mode — the fallback applied to every
     * model NOT in `system_reject_models`. (Rejecters in that set use the
     * `system_reject_mode` override instead; the two keys share this same mode enum
     * and differ only in which model bucket they apply to.)
     *
     * Whether an inline system message needs handling at all is PER UPSTREAM
     * BACKEND: STRICT backends (empirically claude-sonnet-4.6 / claude-haiku-4.5 on
     * this account) 400 with `Unexpected role "system"`, while others (e.g. Opus)
     * accept it — hence the `false` default. Such inline system messages come from
     * OpenAI-habit clients or Claude Code's mid-conversation context injections
     * (hook output / rules / reminders).
     *   false:         passthrough unchanged (DEFAULT) — correct for accepters like
     *                  Opus; a not-yet-known rejecter's first request 400s, then
     *                  reactive learning marks it (permanent, no TTL) and retries
     *   drop_invalid:  remove every inline system message
     *   merge:         pull their text out, append to the top-level `system`, drop the messages
     *   as_user:       rewrite role to "user" (keeps position — recommended)
     *   as_assistant:  rewrite role to "assistant" (experimental, not recommended —
     *                  disguises context as model output, highest risk)
     */
    system_default_mode: z
      .union([z.literal(false), z.literal("drop_invalid"), z.literal("merge"), z.literal("as_user"), z.literal("as_assistant"), z.null()], {
        error: "Must be one of: false, drop_invalid, merge, as_user, as_assistant",
      })
      .optional()
      .transform((v) => v ?? undefined),
    /**
     * Models whose upstream STRICT backend rejects inline `role:"system"` messages
     * (observed SYMPTOM — Vertex is this account's known cause but NOT asserted).
     * A substring set matched against the resolved OUTBOUND model name (normalized).
     * A matched model uses `system_reject_mode`; unmatched models fall back to the
     * global `system_default_mode`. Also grows at runtime (reactive learning).
     * Default `[claude-sonnet-4.6, claude-haiku-4.5]` (empirically confirmed).
     */
    system_reject_models: nullableNonemptyStringArray(),
    /**
     * OVERRIDE mode for models in `system_reject_models` (∪ the reactively-learned
     * reject set) — models whose upstream is known to reject inline `role:"system"`.
     * Same mode enum as `system_default_mode` (see there for what each value does);
     * this key only changes WHICH mode the reject bucket gets. Default `as_user`
     * (keeps position — most prompt-cache-friendly). `false` here would passthrough
     * and re-trigger the upstream 400, so it is rarely useful.
     */
    system_reject_mode: z
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
    // Anthropic memory tool (native memory_20250818 — a client-EXECUTED typed tool, NOT a
    // server tool; the model drives it, the client runs /memories). Default off — rewrites a
    // client tool named `memory` to the {name,type} descriptor + forces the context-management beta.
    server_tool_memory: nullableBoolean(),
    cache_control: nullableEnum(["disabled", "passthrough", "sanitize", "proxied"] as const),
    // Extended prompt-cache TTL (extended-cache-ttl-2025-04-11). Upgrades the cache_control breakpoints
    // the proxy WRITES (cache_control: proxied/sanitize) from the default 5m to 1h. `enabled` is the
    // master switch (default off). `tools_system_ttl` / `messages_ttl` pick 5m|1h per layer; messages
    // is clamped ≤ tools_system (Anthropic: longer TTLs must appear earlier in tools→system→messages).
    extended_cache_ttl: z
      .object({
        enabled: nullableBoolean(),
        tools_system_ttl: nullableEnum(["5m", "1h"] as const),
        messages_ttl: nullableEnum(["5m", "1h"] as const),
      })
      .strict()
      .optional(),
    tool_search_non_deferred: nullableNonemptyStringArray(),
    warmup: nullableEnum(["allow", "reject", "drop", "fake"] as const),
    // Free-form Records — key = model-name pattern, value = list
    effort_overrides: z.record(z.string(), z.array(z.string())).optional(),
    beta_strip_headers: z.record(z.string(), z.array(z.string())).optional(),
    // GHC 未支持的 cache_control 子字段黑名单（model-name pattern → 子字段列表；"*" = 所有模型）。
    // passthrough 模式下剥除。ADDS to 内置 {scope} + reactive learned cache。
    cache_control_strip_subfields: z.record(z.string(), z.array(z.string())).optional(),
    partner_strip_features: z.record(z.string(), z.array(z.string())).optional(),
    // Custom-tool top-level field names to strip / keep (model-name pattern → field list;
    // `"*"` = all models). tool_strip_fields ADDS to the built-in default
    // (`eager_input_streaming`) + reactive learned cache; tool_keep_fields SUBTRACTS
    // (the reversibility escape hatch — e.g. re-enable a field a future upstream supports).
    tool_strip_fields: z.record(z.string(), z.array(z.string())).optional(),
    tool_keep_fields: z.record(z.string(), z.array(z.string())).optional(),
    retry_reject_body_fields: z.record(z.string(), z.array(z.string())).optional(),
    // Tool-name-keyed (NOT model-keyed): keys are matched verbatim against the
    // tool name — must NOT go through normalizeModelKeyedRecord, which would
    // fold case/separators and break lookups. Replace semantic (default).
    // Response-wire fixes are grouped under `response_text_fix` (text blocks) and
    // `response_tool_use_fix` (tool_use blocks); see those section schemas below.
    response_text_fix: nullableSection(ResponseTextFixSchema),
    response_tool_use_fix: nullableSection(ResponseToolUseFixSchema),
    refusal_sse_rewrite: nullableEnum(["refusal", "end_turn", "error"] as const),
    /** `end_turn` 模式注入的 recovery text 模板（会被客户端 baked 进下一轮请求）。支持占位符 `{model}`/`{request_id}`/`{thinking_tokens}`，未知占位符原样保留。空串=不追加 text 块（仅改 end_turn）。未配=内置默认（逐字节等价旧固定文案）。 */
    refusal_end_turn_text: nullableString(),
    /** `error` 模式合成 error 帧的 message 模板（客户端 `APIError.message`）。占位符同上。未配=内置默认。 */
    refusal_error_message: nullableString(),
    /** `error` 帧的 `error.type`（纯字面、不做模板渲染）。空串回落 `api_error`。未配=内置默认。 */
    refusal_error_type: nullableString(),
    /** 上游错误 → 客户端可行动形态整形总开关。关闭时三个终点（forward.ts / 终点①② / S5 canonical rewrite）逐字节回退现状。默认 true。 */
    error_shaping_enabled: nullableBoolean(),
    /** B 类：content_filtered / 402 / 403(token-refresh 耗尽) 是否合成 AskUserQuestion 轮次而非拍平成错误帧。仅交互式部署应开启（无服务端探测信号，见 plan D-0）。默认 false。 */
    error_ask_user_question: nullableBoolean(),
    /** AUQ 问题文案模板，占位符 {model}/{request_id}/{error_type}/{status}，复用 renderRefusalTemplate。空=内置默认。 */
    error_auq_template: nullableString(),
    /** D 类：按反应式策略名配置「proxy 自修 vs 透传委派 CC 自愈」。键=策略 .name（如 "adaptive-thinking-rejection-retry"），值 "proxy"|"delegate"。未列=proxy（默认更可控）。 */
    error_selfheal_delegate: z.record(z.string(), z.enum(["proxy", "delegate"])).optional(),
    /**
     * Synthetic SSE keepalive ping cadence (seconds) for the client-facing live
     * Anthropic stream. `0` disables; default **20**, clamped to a large margin
     * under the ~60s Claude Code body-idle deadline (Q2 oracle; empirical safe
     * ceiling ~45s). Any positive integer is the MINIMUM seconds between pings
     * (a real frame or a ping advances the anchor) before the proxy injects an
     * Anthropic-protocol `event: ping` frame — covers BOTH mid-stream idle gaps
     * (opus-4.8 adaptive thinking that goes silent after `content_block_start`)
     * AND the cold-start commit keepalive (the `streamCommitAfterSec` delayed-
     * commit window fires one immediate ping, then this throttles the rest).
     * Heartbeats are PROXY-originated and do NOT reset the
     * upstream idle-timeout (so a genuinely dead upstream still fails). Recorded
     * in `forwardedSseEvents` (visible diagnostic), never in the raw upstream
     * `sseEvents`. The interval is captured at stream start — in-flight streams
     * keep their original value across hot-reload; new streams pick up the new
     * value. (Renamed from `stream_fake_sse_heartbeat`; old key auto-migrates.)
     */
    stream_keepalive_ping_sec: nullableNonnegativeInt(),
    /**
     * Keepalive FRAME type for the client-facing Anthropic stream. `empty_text` (default) is the
     * unconditionally timeout-safe mode: when a forwarded block is open it injects an EMPTY content
     * delta matching that block (thinking→thinking_delta, text→text_delta, tool_use→input_json_delta);
     * ADDITIONALLY, in buffered mode with NO open block yet (pre-commit long silence), it lazily injects
     * a synthetic empty text ANCHOR block so an empty `text_delta` can reset Claude Code's 300s
     * no-real-content deadline (real content stays buffered; the anchor closes and real blocks flush at
     * index+1 on commit; spec 2026-07-08-buffered-keepalive-empty-text-anchor). `ping` is the legacy
     * bare-`event: ping` escape hatch — a ping is NOT counted as a "chunk" so it does NOT reset the 300s
     * deadline (may time out; see exp/cc-idle-280s/REPORT.md). `enveloped_ping` (experimental, expected
     * to time out) synthesizes an envelope then emits a bare ping. redacted_thinking / unknown open
     * blocks fall back to ping either way.
     */
    stream_keepalive_mode: nullableEnum(["ping", "enveloped_ping", "empty_text"] as const),
    /**
     * Delayed-commit window (seconds) for streaming Anthropic requests. The proxy waits up to this
     * long for runRequest to settle before opening the 200 SSE stream — an upstream error within the
     * window keeps its real HTTP status (client retries natively); a stall past it commits 200 +
     * keepalive. `0` commits immediately. Clamped < 60. Default 20.
     */
    stream_commit_after_sec: nullableNonnegativeInt(),
    /**
     * L2 — transactional buffered retry for streaming generations cut short by an
     * upstream mid-stream RST (GHC NGHTTP2_CANCEL on large Write/Edit). Buffers the
     * whole response and commits only after `message_stop`, re-running the exchange
     * on a transport-close / truncation, transparently to the client. See
     * docs/archive/2606-landed-rfcs/streaming-upstream-rst-buffered-retry.md.
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
     * Per-vendor buffered-retry cap override for the Anthropic path (max_retries /
     * buffer_cap_bytes / heartbeat_sec). Overrides the shared top-level
     * `buffered_retry.*`, which overrides the built-in defaults (3 / 16777216 / 15).
     * The `enabled` field is IGNORED here — Anthropic's buffered mode switch is the
     * tri-state `protect_streaming_generation` above. (Legacy
     * `protect_streaming_{max_retries,heartbeat,buffer_cap_bytes}` migrate here;
     * see CONFIG_MIGRATIONS in compat.ts.)
     */
    buffered_retry: nullableSection(BufferedRetryOverrideSchema),
    /**
     * On each buffered RST/truncation retry, FORCE a progressively aggressive native
     * `clear_tool_uses` context_management edit (lower trigger + smaller keep) to compress the
     * context so the generation finishes faster — within the next RST window (RFC §8). Independent
     * of `context_editing` (a retry-only emergency compression); skipped when the model doesn't
     * support context_management. Changes request semantics (drops more old context). Default false.
     */
    protect_streaming_escalate_context: nullableBoolean(),
    /**
     * Config-driven model-capability allowlists. Each list is a set of model-name "family" prefixes
     * (normalized: lowercase, dots→dashes); a model has the capability when its normalized id equals
     * an entry or starts with `entry + "-"`. Bundled defaults mirror GHC's capability checks — edit
     * to add/remove models (e.g. a new Claude release) WITHOUT a code change. See features.ts.
     *
     * `tool_search_overrides` is NOT a list: tool-search is default-allow for Claude ≥4.5 (Haiku +
     * pre-4.5 denied), so it needs no allowlist. The overrides map holds per-model force-on/off
     * decisions only (keys = model-name substrings, `"*"` = wildcard; value true=force-on/false=off),
     * checked after declared metadata but before the built-in default-allow matcher.
     */
    model_capabilities: z
      .object({
        context_editing: nullableNonemptyStringArray(),
        interleaved_thinking: nullableNonemptyStringArray(),
        adaptive_thinking: nullableNonemptyStringArray(),
        extended_cache_ttl: nullableNonemptyStringArray(),
        memory: nullableNonemptyStringArray(),
        tool_search_overrides: z.record(z.string(), z.boolean()).optional(),
      })
      .strict()
      .optional(),
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
    /**
     * Opt-in mid-stream buffered retry for the Responses SSE/HTTP path (default false; Codex
     * auto-retry is opt-in). Accepts a bare boolean (`enabled` shorthand) or a map
     * `{ enabled, max_retries, buffer_cap_bytes, heartbeat_sec }` whose caps override the
     * shared top-level `buffered_retry.*` for this vendor (see resolveBufferedCaps).
     */
    buffered_retry: nullableBufferedRetry(),
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

/**
 * `chat_completions` top-level section. Currently holds only the buffered-retry
 * mode switch + per-vendor cap override (P3 net-new terminal-only buffering for
 * the Chat Completions path). Boolean shorthand = `enabled`; map form overrides
 * the shared `buffered_retry.*` caps for the `chat_completions` vendor.
 */
export const ChatCompletionsConfigSchema = z
  .object({
    buffered_retry: nullableBufferedRetry(),
  })
  .strict()

/**
 * Ad-hoc TS hook module for mocking/intercepting the upstream transport (dev/test only).
 * `upstream_module` is the path loaded by `loadUpstreamHookSafe` at startup (and, in future
 * phases, a reload API); `enabled` gates whether it is loaded at all — the feature is fully
 * off unless explicitly true. Declarative only: this schema/state wiring never triggers the
 * module load itself (see `applyConfigToState` / `start.ts`).
 */
export const HooksConfigSchema = z
  .object({
    upstream_module: nullableString(),
    enabled: nullableBoolean(),
  })
  .strict()
export type HooksConfig = z.infer<typeof HooksConfigSchema>

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


/**
 * `telemetry.*` —— 分层遥测持久化（独立 telemetry.db）。近期/远期分辨率与保留均可配。
 * 业务级校验（sketch_gamma 下限、resolution 整除 60）在 config apply 层做 warn-continue，非 zod。
 */
export const TelemetryTiersConfigSchema = z
  .object({
    raw: nullableSection(
      z
        .object({
          resolution_minutes: nullableNonnegativeInt(),
          retention_days: nullableNonnegativeInt(),
        })
        .strict(),
    ),
    hourly: nullableSection(z.object({ retention_days: nullableNonnegativeInt() }).strict()),
    daily: nullableSection(z.object({ retention_days: nullableNonnegativeInt() }).strict()),
  })
  .strict()

export const TelemetryConfigSchema = z
  .object({
    /** 总开关（默认 true = 旧行为一直开）。 */
    enabled: nullableBoolean(),
    /** 独立 DB 路径（默认 <APP_DIR>/telemetry.db）。 */
    db_path: nullableString(),
    /** raw 落盘/flush 间隔秒（默认 60）。 */
    persist_interval: nullableNonnegativeInt(),
    /** rollup 上卷间隔秒（默认 3600，独立于 persist，≫ persist）。 */
    rollup_interval: nullableNonnegativeInt(),
    /** capped 维度（client/tool）key 上限（默认 200）。 */
    cardinality_cap: nullableNonnegativeInt(),
    /** DDSketch 相对误差 γ（默认 0.01=1%；apply 层下限 ~0.005，配更紧警告回落）。上限/下限业务校验在 apply 层。 */
    sketch_gamma: nullablePositiveNumber(),
    /** 终身累计层开关（默认 true）。 */
    cumulative: nullableBoolean(),
    /** 分层保留（近期 raw / 中期 hourly / 远期 daily）。 */
    tiers: nullableSection(TelemetryTiersConfigSchema),
  })
  .strict()


export const RetryConfigSchema = z
  .object({
    /** Shared per-request cap on ALL reactive retry strategies (network / server-error / token-refresh / 400-class negotiation etc.). 0 = a single attempt, no retry. Default 5. Was `auto_truncate.max_retries`. */
    max_reactive_retries: nullableNonnegativeInt(),
  })
  .strict()

/**
 * Per-model timeout override maps (seconds). Named const so the base `ZodRecord`
 * reference is stable for `RECORD_MERGE_STRATEGIES` (WeakMap key) — an inline
 * `z.record(...)` inside the parent shape would get a fresh object each access
 * and the per-key merge would silently degrade to `replace`.
 */
const StreamIdleOverridesSchema = z.record(z.string(), z.number({ error: POSITIVE_INT_MSG }).int(POSITIVE_INT_MSG).nonnegative(POSITIVE_INT_MSG))
const ResponseHeaderOverridesSchema = z.record(z.string(), z.number({ error: POSITIVE_INT_MSG }).int(POSITIVE_INT_MSG).nonnegative(POSITIVE_INT_MSG))

export const TimeoutsConfigSchema = z
  .object({
    /** Max seconds between SSE events (0 = no timeout). Was top-level `stream_idle_timeout`. */
    stream_idle: nullableNonnegativeInt(),
    /** Max seconds from request start to receiving HTTP response headers (0 = no timeout). Was top-level `fetch_timeout`. */
    response_header: nullableNonnegativeInt(),
    /**
     * Per-model stream-idle timeout override (seconds), keyed by model-name
     * substring with `"*"` wildcard. A match wins over `stream_idle`; 0 = disabled.
     * Bundled default `{ gpt-5.5: 600 }`. Per-key merged with the user table
     * (a user `{}` does NOT wipe the bundled entry). App-guard only — does not
     * touch the undici dispatcher. See ADR 2026-07-12-per-model-idle-timeout-is-app-guard-only.
     */
    stream_idle_overrides: StreamIdleOverridesSchema.nullable()
      .transform((v): z.infer<typeof StreamIdleOverridesSchema> | undefined => v ?? undefined)
      .optional(),
    /**
     * Per-model response-header (first-byte) timeout override (seconds), same
     * keying/merge semantics as `stream_idle_overrides`. A match wins over
     * `response_header`; 0 = disabled. Bundled default `{}` (no built-in value).
     */
    response_header_overrides: ResponseHeaderOverridesSchema.nullable()
      .transform((v): z.infer<typeof ResponseHeaderOverridesSchema> | undefined => v ?? undefined)
      .optional(),
    /** Upstream TCP keepalive initial-probe delay in seconds (0 = use undici default 60s). Keeps GHC connection alive through long opus thinking silences so NAT/firewall idle reapers don't sever it. Node-only. */
    upstream_keepalive: nullableNonnegativeInt(),
    /** Upstream HTTP/2 PING keepalive interval in seconds (0 = disabled). Application-layer complement to `upstream_keepalive`: GHC does NOT forward Anthropic's SSE `ping` frames, so a long thinking silence is a truly idle stream a connection-idle reaper (middlebox/GHC edge) severs WITHOUT `message_stop` (a real cut fired at ~112s) — a periodic PING puts a real frame on the wire. Default 15. Node-only (node:http2 transport). */
    upstream_h2_ping: nullableNonnegativeInt(),
    /** Max seconds an active request may live before the stale reaper forces failure (0 = disabled). Was top-level `stale_request_max_age`. */
    stale_request_max_age: nullableNonnegativeInt(),
    /**
     * Hard total-duration deadline (seconds) for a single request — a user-facing SLA enforced by a
     * per-request timer (NOT the periodic stale reaper, which fires late — RFC RC2). 0 = disabled,
     * behavior then byte-identical to the stale-reaper-only path. Bundled default is an explicit value
     * (intentional product default); the stale reaper stays as the leak safety-net (`stale_request_max_age`
     * should be > `request_deadline`).
     */
    request_deadline: nullableNonnegativeInt(),
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
const ModelMappingsSchema = z.record(z.string(), z.string()).superRefine((value, ctx) => {
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
 * Ingress format enum for `model_translation` (RFC §6.1) — the client's inbound
 * protocol, mirroring `ClientFormat` in `~/lib/pipeline/envelope.ts` but spelled
 * out with the `-messages`/`-cc`/`-responses` suffixes to match the vendor-scoped
 * naming used elsewhere in config (`ENDPOINT_SCOPE_VALUES` uses the terser
 * `anthropic`/`openai-cc`/`openai-responses`/`gemini` form for a different concern —
 * this is intentionally its own enum, not a reuse, since the two config surfaces
 * are allowed to diverge without one accidentally constraining the other).
 */
export const MODEL_TRANSLATION_INGRESS_VALUES = ["anthropic-messages", "openai-cc", "openai-responses", "gemini"] as const

/**
 * Per-pair translation features (RFC §6.1) — declared per `(ingress, model@format)`
 * match to disambiguate the two round-trip scenarios a proxy cannot infer on its
 * own (stable-model full round-trip vs mid-conversation model switch, where a
 * carried-over `signature`/`encrypted_content` from a DIFFERENT upstream model is no
 * longer valid and must be stripped rather than round-tripped). Currently a single
 * feature; the array shape is deliberately open for future additions.
 */
export const MODEL_TRANSLATION_FEATURE_VALUES = ["strip-thinking-signature"] as const

/**
 * A single `model_translation` match rule: `match` pins a `<model>@<format>` pair
 * against the FINAL routed target (post `model_mappings` resolution, post router
 * decision — never the client's raw requested model name; see RFC §6.1). `features`
 * lists which translation features apply to that pair; omitted/empty = scenario A
 * (full round-trip, no stripping).
 *
 * v1 `match` is EXACT-STRING ONLY (no wildcard/glob) — RFC §6.1 OQ2 defers wildcard
 * support (`*@openai-responses`) to a future extension; this schema doesn't need to
 * change to add it later (a superset string syntax parsed downstream), so no
 * placeholder is added here.
 */
const ModelTranslationRuleSchema = z
  .object({
    match: z.string({ error: STRING_MSG }).min(1, "match must be a non-empty string"),
    features: z.array(z.enum(MODEL_TRANSLATION_FEATURE_VALUES)).optional(),
  })
  .strict()

/**
 * `model_translation` (RFC §6.1): per-ingress-format list of per-pair translation
 * rules. Key = ingress format (client's inbound protocol); value = ordered rule
 * list, first match wins (mirrors `findMostSpecific`-style config precedent but
 * simpler — v1 has no specificity ranking since match is exact-string only).
 *
 * `z.partialRecord` (not `z.record`) so an unrecognized ingress key raises a
 * standard `invalid_key` issue on THAT key alone — `cleanInvalidPaths()` drops
 * just the offending ingress entry (warn-and-continue, never fails config load).
 */
const ModelTranslationSchema = z.partialRecord(z.enum(MODEL_TRANSLATION_INGRESS_VALUES), z.array(ModelTranslationRuleSchema))

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

/** unknown HTTP endpoint 日志级别（silent = 不打）。见 UnknownEndpointLoggingSchema。 */
export const LOG_LEVELS = ["silent", "debug", "info", "warn", "error"] as const

/**
 * unknown HTTP endpoint（打到代理但没匹配任何业务路由）的按状态码分类日志级别。
 * not_found = 404（真正未匹配路径）；method_not_allowed = 405（路径存在但 method 不对）。
 * 用 nullableEnum → 每字段接受 null（PUT `/api/config/yaml` 用 null 删除单键）。默认 warn/warn
 * 由 bundled config.yaml + CONFIG_MANAGED_DEFAULTS 提供（非 leaf schema default）。
 */
const UnknownEndpointLoggingSchema = z
  .object({
    not_found: nullableEnum(LOG_LEVELS),
    method_not_allowed: nullableEnum(LOG_LEVELS),
  })
  .strict()

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
    system_prompt_prepend: SystemPromptTextListSchema,
    system_prompt_append: SystemPromptTextListSchema,
    rate_limiter: nullableSection(RateLimiterConfigSchema),
    anthropic: nullableSection(AnthropicConfigSchema),
    openai_responses: nullableSection(ResponsesConfigSchema),
    chat_completions: nullableSection(ChatCompletionsConfigSchema),
    /**
     * Vendor-neutral SHARED buffered-retry caps (`max_retries` / `buffer_cap_bytes`
     * / `heartbeat_sec`). Overridden per-vendor by `anthropic.buffered_retry` /
     * `openai_responses.buffered_retry` / `chat_completions.buffered_retry`, and in
     * turn overrides the built-in defaults (3 / 16777216 / 15). Top-level (not under
     * a vendor) because the caps are protocol-neutral; only the `enabled` mode switch
     * is per-vendor. The `enabled` field here is ignored (there is no shared mode
     * switch). See resolveBufferedCaps in state.ts.
     */
    buffered_retry: nullableSection(BufferedRetryOverrideSchema),
    model_mappings: ModelMappingsSchema.nullable()
      .transform((v): z.infer<typeof ModelMappingsSchema> | undefined => v ?? undefined)
      .optional(),
    /**
     * Per-pair (ingress format → match rule list) translation feature declarations
     * (RFC 2026-07-14-anthropic-responses-direct-bridge §6.1). Consumed by the
     * format-agnostic bridge-selection layer (Phase 5), not per-cell translateOut —
     * keeps the two round-trip scenarios (stable model vs mid-conversation switch)
     * from drifting out of sync across call sites. Default (key absent, or ingress
     * present with an empty/absent rule list) = scenario A, full round-trip, no
     * features stripped.
     */
    model_translation: ModelTranslationSchema.nullable()
      .transform((v): z.infer<typeof ModelTranslationSchema> | undefined => v ?? undefined)
      .optional(),
    disabled_models: nullableNonemptyStringArray(),
    /**
     * Reactive-retry budget shared by ALL retry strategies (400-class negotiation,
     * network, server-error, token-refresh, …). Was `auto_truncate.max_retries`,
     * hoisted out because it never was truncation-specific.
     */
    retry: nullableSection(RetryConfigSchema),
    /**
     * Sanitize tool names that violate the target model's constraints (illegal
     * characters like dots, over-length, collisions) into legal names before
     * sending upstream, restoring the client's original names in the response.
     * Spans Anthropic + Chat Completions + Responses paths. Default false.
     * Top-level (not under `anthropic.*`) because it is cross-protocol.
     */
    sanitize_tool_names: nullableBoolean(),
    history: nullableSection(HistoryConfigSchema),
    hooks: nullableSection(HooksConfigSchema),
    shutdown: nullableSection(ShutdownConfigSchema),
    timeouts: nullableSection(TimeoutsConfigSchema),
    telemetry: nullableSection(TelemetryConfigSchema),
    model_refresh_interval: nullableNonnegativeInt(),
    /**
     * Reactive-learning (feature-negotiation) TTL lifecycle. `default_ttl_days`
     * (default 30) applies to any category without an override; `ttl_days` maps a
     * category id (camelCase identifier, e.g. `toolFields`) to its TTL in days.
     * `0` / `null` = never auto-expire. Kept as raw `.nullable().optional()`
     * (NOT nullableSection) so an explicit `null` survives validation and the
     * config-UI round-trip can delete the whole section.
     */
    negotiation_learning: z
      .object({
        default_ttl_days: z.number().int().nonnegative().nullable().optional(),
        ttl_days: z.record(z.string(), z.number().int().nonnegative()).nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    unknown_endpoint_logging: nullableSection(UnknownEndpointLoggingSchema),
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
// top of bundled" (`model_mappings`) from "user takes full ownership of
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

RECORD_MERGE_STRATEGIES.set(ModelMappingsSchema, "per-key")
RECORD_MERGE_STRATEGIES.set(StreamIdleOverridesSchema, "per-key")
RECORD_MERGE_STRATEGIES.set(ResponseHeaderOverridesSchema, "per-key")
// effort_overrides / beta_strip_headers / partner_strip_features / tool_strip_fields /
// tool_keep_fields / retry_reject_body_fields intentionally
// omitted — they default to "replace": when the user sets one of these
// tables, they take responsibility for the entire policy.

// ============================================================================

export type RewriteRule = z.infer<typeof RewriteRuleSchema>
export type SystemPromptEntry = z.infer<typeof SystemPromptEntrySchema>
/** Endpoint-scope value — one of {@link ENDPOINT_SCOPE_VALUES}; mirrors `ClientFormat`. */
export type EndpointScope = (typeof ENDPOINT_SCOPE_VALUES)[number]
export type RateLimiterConfig = z.infer<typeof RateLimiterConfigSchema>
export type AnthropicConfig = z.infer<typeof AnthropicConfigSchema>
export type ShutdownConfig = z.infer<typeof ShutdownConfigSchema>
export type ResponsesConfig = z.infer<typeof ResponsesConfigSchema>
export type ChatCompletionsConfig = z.infer<typeof ChatCompletionsConfigSchema>
export type BufferedRetryOverride = z.infer<typeof BufferedRetryOverrideSchema>
export type HistoryConfig = z.infer<typeof HistoryConfigSchema>
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>
export type TimeoutsConfig = z.infer<typeof TimeoutsConfigSchema>
export type RetryConfigSection = z.infer<typeof RetryConfigSchema>
export type ModelTranslationIngress = (typeof MODEL_TRANSLATION_INGRESS_VALUES)[number]
export type ModelTranslationFeature = (typeof MODEL_TRANSLATION_FEATURE_VALUES)[number]
export type ModelTranslationRule = z.infer<typeof ModelTranslationRuleSchema>
export type ModelTranslation = z.infer<typeof ModelTranslationSchema>
export type Config = z.infer<typeof ConfigSchema>
