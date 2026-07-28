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

function nullablePositiveInt() {
  return z
    .number({ error: POSITIVE_NUMBER_MSG })
    .int(POSITIVE_NUMBER_MSG)
    .positive(POSITIVE_NUMBER_MSG)
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
 * Resolution priority (see `resolveBufferedCaps` in ./model-overrides.ts): per-vendor
 * override > shared `buffered_retry.*` > built-in default (max_retries 3 /
 * buffer_cap_bytes 16777216 / heartbeat_sec 15).
 */
export const MaxTokensContinuationClassesSchema = z
  .object({
    text: nullableEnum(["continue", "passthrough"] as const),
    tool_use: nullableEnum(["continue", "passthrough"] as const),
    thinking: nullableEnum(["passthrough", "retry_with_budget"] as const),
  })
  .strict()
  .describe("Per-truncation-class max_tokens continuation strategies.")

export const MaxTokensContinuationOverrideSchema = z
  .object({
    enabled: nullableBoolean(),
    max_rounds: nullableNonnegativeInt(),
    classes: nullableSection(MaxTokensContinuationClassesSchema),
    message: nullableString(),
    visibility: nullableEnum(["transparent", "passthrough", "marker"] as const),
    thinking_retry_budget: nullableNonnegativeInt(),
  })
  .strict()
  .describe("Opt-in max_tokens continuation policy. Disabled by default so terminal frames pass through unchanged.")

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
    /**
     * Continuation-retry settings (spec 2026-07-22). After the first block commits, a mid-stream RST
     * triggers a synthetic continuation turn instead of `partial-degrade`. `enabled` gates it (default
     * true); `message` is the synthetic user-turn text (default "network issue. please continue").
     * Valid on the shared `buffered_retry` AND any per-vendor `<vendor>.buffered_retry` (per-vendor wins).
     */
    continuation: nullableSection(
      z
        .object({
          enabled: nullableBoolean(),
          message: z.string().nullable().optional(),
        })
        .strict(),
    ),
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
     * Repair the block layout of assistant messages in the echoed history to the THREE
     * shapes GHC hard-rejects with a 400 (spec 2026-07-26-thinking-terminal-block-layout):
     * C1 two adjacent `thinking`/`redacted_thinking` blocks, C2 a message ending on
     * thinking, C3 a message carrying `tool_use` that does not end on it (reported with
     * the misleading "does not support assistant message prefill" wording). C3 fires on
     * messages with no thinking at all. Idempotent: an already-legal message passes
     * through byte-identical.
     *   passthrough — leave the client's block layout as-is (repair disabled)
     *   move_blocks — interleave thinking with real non-thinking blocks (order-
     *                 preserving) and reserve a terminator (the last tool_use when the
     *                 message has one); synthetic marker only when insufficient (default)
     */
    assistant_block_layout_strategy: nullableEnum(["passthrough", "move_blocks"] as const),
    /**
     * EMIT axis for the synthetic block-layout separator: WHICH carrier this process puts on the
     * wire when `move_blocks` has to synthesize one (no real non-thinking block is spare).
     *
     * A closed enum on purpose — a free-form string would let a whitespace-only value through, and
     * upstream strips those, manufacturing the very 400 the repair exists to prevent. New carriers
     * (e.g. a minimal invisible-Unicode one) land here only after a real-upstream PoC.
     * `marker_v1` = the visible versioned marker, the only carrier confirmed accepted upstream.
     */
    separator_carrier: nullableEnum(["marker_v1"] as const),
    /**
     * ACCEPT axis: EXTRA literals to also recognise as one of our synthetic separators, on top of
     * the built-in prefix family and the spellings older builds emitted.
     *
     * Open list, and monotone *on the wire*: widening recognition can never make a payload
     * illegal, it only classifies more blocks as ours. This is the axis that makes carrier
     * migration and third-party/historical values work: pin whatever a previous deployment
     * emitted and this build will still recognise it.
     *
     * Monotone is not the same as harmless. Recognition feeds a DESTRUCTIVE consumer —
     * `stripAllThinking` treats a recognised block as an orphan separator and removes it — so a
     * value that collides with real assistant text authorises deleting that text on the L2/L3
     * fallback path. Pin only unambiguous, collision-resistant literals. Values pinned here are
     * compared trimmed and in full — never as a substring — so a normal message that merely
     * mentions the text is safe; the built-in carriers, by contrast, match by namespaced prefix
     * so that an old build still recognises a future carrier.
     */
    separator_accept_extra: nullableNonemptyStringArray(),
    /**
     * Reactive fallback (L2) for the GHC "thinking ... cannot be modified" 400
     * that L1 layout repair (`assistant_block_layout_strategy`) did not preempt: strip ALL
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
    // Free-form Records — key = model-name pattern, value = list.
    // Key matching (shared `per-model-config.ts`): a plain key is a model-name SUBSTRING; a key with a
    // glob metachar (`*`/`?`) is an ANCHORED GLOB; `"*"` = all models. Aggregation differs by map:
    // `effort_overrides` is a WHITELIST (`findMostSpecific`: most-specific wins, specificity literal >
    // glob > `"*"` then longest key); every other Record here is an additive STRIP-LIST
    // (`collectAllMatching`: union of ALL matching keys incl. `"*"`).
    effort_overrides: z.record(z.string(), z.array(z.string())).optional(),
    beta_strip_headers: z.record(z.string(), z.array(z.string())).optional(),
    // GHC 未支持的 cache_control 子字段黑名单（model-name pattern / glob → 子字段列表；"*" = 所有模型；additive `collectAllMatching`）。
    // passthrough 模式下剥除。ADDS to 内置 {scope} + reactive learned cache。
    cache_control_strip_subfields: z.record(z.string(), z.array(z.string())).optional(),
    partner_strip_features: z.record(z.string(), z.array(z.string())).optional(),
    // Custom-tool top-level field names to strip / keep (model-name pattern / glob → field list;
    // `"*"` = all models; additive `collectAllMatching`). tool_strip_fields ADDS to the built-in
    // default (`eager_input_streaming`) + reactive learned cache; tool_keep_fields SUBTRACTS
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
    /** `end_turn`（抑制）模式注入的 text 模板（会被客户端 baked 进下一轮请求）。占位符 `{model}`/`{request_id}`/`{thinking_tokens}`/`{output_tokens}`/`{refusal_category}`/`{refusal_explanation}`；未知值渲染 `unknown`、上游显式 null 的 category 渲染 `uncategorized`；未知占位符原样保留。**空串=不追加 text 块**，实测会让 Claude Code 空转一轮。未配=内置默认。 */
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
     * Seconds without a client-visible content_block_delta before ping keepalive escalates to an
     * empty content delta. `0` disables escalation. Default 200 (100s margin before CC's 300s
     * event-idle watchdog). Existing open block → matching empty delta; no block → lazy anchor.
     */
    stream_keepalive_escalate_sec: nullableNonnegativeInt(),
    /**
     * Keepalive FRAME type for the client-facing Anthropic stream. `ping` (default) is the normal
     * low-impact cadence. It does not itself reset Claude Code's 300s event-idle watchdog; the separate
     * `stream_keepalive_escalate_sec` deadline upgrades to an empty content delta only when needed.
     * `empty_text` remains selectable for always-on content-delta mode. Block-level CLI-safety comes from
     * strict index-ordered output; on-demand pre-content escalation reuses the anchor only near deadline.
     */
    stream_keepalive_mode: nullableEnum(["ping", "enveloped_ping", "empty_text"] as const),
    /**
     * Delayed-commit window (seconds) for streaming Anthropic requests. The proxy waits up to this
     * long for runRequest to settle before opening the 200 SSE stream — an upstream error within the
     * window keeps its real HTTP status (client retries natively); a stall past it commits 200 +
     * keepalive. `0` commits immediately. Default 180. Clamped to 240s, keeping a margin under the
     * ~300s pre-header limit measured in exp/silence-recovery-gates/FINDINGS.md (undici's default
     * headersTimeout, below anything the SDK or CC configures). Nothing is sent before the commit, so
     * this window and that limit share one clock — reaching the limit aborts the attempt.
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
    /** Per-vendor override for the top-level max_tokens_continuation policy. */
    max_tokens_continuation: nullableSection(MaxTokensContinuationOverrideSchema),
    /**
     * On each buffered RST/truncation retry, FORCE a progressively aggressive native
     * `clear_tool_uses` context_management edit (lower trigger + smaller keep) to compress the
     * context so the generation finishes faster — within the next RST window (RFC §8). Independent
     * of `context_editing` (a retry-only emergency compression); skipped when the model doesn't
     * support context_management. Changes request semantics (drops more old context). Default false.
     */
    protect_streaming_escalate_context: nullableBoolean(),
    /**
     * Config-driven model-capability allowlists. Each list is a set of model-name patterns; a glob-free
     * entry matches EXACTLY (normalized: lowercase, dots→dashes), and family coverage ("a whole Claude
     * generation") uses an explicit GLOB (`*`/`?`), e.g. `claude-opus-4*` or the dash-precise
     * `claude-opus-4-*`. Bundled defaults mirror GHC's capability checks — edit to add/remove models
     * (e.g. a new Claude release) WITHOUT a code change. See features.ts.
     *
     * `!` NEGATION (`!pattern` SUBTRACTS from the set). Semantics: a model has the capability iff it
     * matches ≥1 positive entry AND no `!` entry (self-contained list, exclusion-always-wins,
     * order-independent); a list with only `!` entries → empty set. The implicit family-prefix matcher
     * has been retired (2026-07-23) — see docs/spec/2026-07-23-model-capabilities-glob-and-negation.md.
     * YAML: patterns beginning with `!` or `*` MUST be quoted (`- "!claude-haiku-*"`, `- "*claude"`).
     *
     * `tool_search_overrides` is NOT a list: tool-search is default-allow for Claude ≥4.5 (Haiku +
     * pre-4.5 denied), so it needs no allowlist. The overrides map holds per-model force-on/off
     * decisions only (keys = model-name substrings OR glob patterns, `"*"` = wildcard; value
     * true=force-on/false=off), checked after declared metadata but before the built-in default-allow
     * matcher. Key specificity when multiple match: literal substring > glob > `"*"` (then longest key).
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
    /** Per-vendor override for the top-level max_tokens_continuation policy. */
    max_tokens_continuation: nullableSection(MaxTokensContinuationOverrideSchema),
    fix_stream_ids: nullableBoolean(),
    /**
     * Strip the `image_generation` builtin tool from inbound Responses
     * requests. The Copilot upstream rejects it (failing the whole request),
     * and some clients (e.g. Codex CLI) auto-inject it. Default false.
     */
    strip_image_generation_tool: nullableBoolean(),
    /**
     * Responses buffered flush 语义压缩 + 终结对账两个正交旋钮（spec 2026-07-14-responses-buffered-block-merge §3）。
     * 惰性：`buffered_retry` OFF 时本键无效（无 buffer 可归并）。
     */
    buffered_merge: z
      .object({
        event_compaction: nullableEnum(["verbatim", "drop-delta", "item-summary"] as const),
        completed_output: nullableEnum(["upstream", "repair-if-incomplete", "rebuild"] as const),
      })
      .strict()
      .optional(),
  })
  .strict()

/**
 * `server.responses_ws.*` — inbound client-facing Responses WebSocket ingress
 * limits (D6: moved out of `openai_responses.*` as a whole group, since these
 * govern the DOWNSTREAM client connection, not the upstream GHC connection —
 * distinct axis from `upstream_transport.websocket.*`).
 */
export const ResponsesWsIngressConfigSchema = z
  .object({
    /** Keep the client WS connection open across turns instead of closing after each response. Was `openai_responses.client_ws_keep_open`. Default false. */
    keep_open: nullableBoolean(),
    /** Optional cap on inbound WS frame bytes (default 0 = unlimited; set positive to opt into a hard cap). Was `openai_responses.max_ws_frame_bytes`. */
    max_frame_bytes: nullableNonnegativeInt(),
    /** Max concurrent client WS connections (default 256; 0 = unlimited). Was `openai_responses.max_client_ws_connections`. */
    max_connections: nullableNonnegativeInt(),
  })
  .strict()
export type ResponsesWsIngressConfig = z.infer<typeof ResponsesWsIngressConfigSchema>

/** `server.*` — inbound/ingress-facing server configuration (currently just `responses_ws`). */
export const ServerConfigSchema = z
  .object({
    responses_ws: nullableSection(ResponsesWsIngressConfigSchema),
  })
  .strict()
export type ServerConfig = z.infer<typeof ServerConfigSchema>

/**
 * `chat_completions` top-level section. Currently holds only the buffered-retry
 * mode switch + per-vendor cap override (P3 net-new terminal-only buffering for
 * the Chat Completions path). Boolean shorthand = `enabled`; map form overrides
 * the shared `buffered_retry.*` caps for the `chat_completions` vendor.
 */
export const ChatCompletionsConfigSchema = z
  .object({
    buffered_retry: nullableBufferedRetry(),
    /** Per-vendor override for the top-level max_tokens_continuation policy. */
    max_tokens_continuation: nullableSection(MaxTokensContinuationOverrideSchema),
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
    /** Startup-only master switch. false means no History database is opened. */
    enabled: nullableBoolean(),
    raw_capture: nullableSection(
      z
        .object({
          enabled: nullableBoolean(),
          db_path: nullableString(),
          max_object_bytes: nullableNonnegativeInt(),
        })
        .strict(),
    ),
    /**
     * Terminal-persistence transient retry (DI-5). A commit that fails with a
     * transient SQLite error (WAL BUSY/LOCKED/IOERR) is retried with linear
     * backoff instead of dropping the entry on the first failure. `max_attempts`
     * caps the retries (a transient storm can't spin forever); `backoff_ms` is
     * the base linear step. `max_total_ms` is a per-commit wall-clock soft cap
     * (DI-5-followup-2): the linear backoff sum grows quadratically and each
     * attempt can itself block (SQLite busy_timeout), so a large
     * `max_attempts × backoff_ms` product or slow attempts could wedge the drain —
     * and shutdown, which has no abort signal here — for minutes; the cap bounds
     * the total elapsed time one entry spends retrying (`0` = disabled). Permanent
     * failures / conflicts are never retried.
     */
    persist_retry: nullableSection(
      z
        .object({
          max_attempts: nullableNonnegativeInt(),
          backoff_ms: nullableNonnegativeInt(),
          max_total_ms: nullableNonnegativeInt(),
        })
        .strict(),
    ),
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

/**
 * The 16 declarative retry-strategy registry `configKey`s (RFC 2026-07-21-retry-strategy-registry §3.3/§3.4,
 * plan Task 4). Inlined here (not imported from `~/lib/request/retry-registry.ts`) to keep the config schema
 * layer free of a business-logic import — the same convention as `ENDPOINT_SCOPE_VALUES` above (mirrors
 * `ClientFormat`). **MUST stay in sync** with `RETRY_STRATEGY_ORDER`'s key set in `retry-registry.ts`; a
 * parity test (`tests/config/retry-strategies.it.test.ts`) asserts the two enumerate the same 16 keys so drift
 * fails CI loudly rather than silently letting a renamed/added strategy go un-configurable or mis-typed.
 */
export const RETRY_STRATEGY_CONFIG_KEYS = [
  "network",
  "serverError",
  "tokenRefresh",
  "effortLearning",
  "toolFieldRejection",
  "bodyFieldRejection",
  "cacheControlSubfield",
  "legacyThinking",
  "adaptiveThinkingRejection",
  "poisonedThinking",
  "unsupportedBeta",
  "serverToolRejection",
  "structuredOutputsRejection",
  "systemReject",
  "webSearchNotFound",
  "deferredTool",
] as const

/** One `retry.strategies.<configKey>` switch — `enabled` only (order is a correctness contract, not user-tunable; RFC §3.4 decision 1). */
const RetryStrategySwitchSchema = z.object({ enabled: z.boolean().optional() }).strict()

export const RetryConfigSchema = z
  .object({
    /** Shared per-request cap on ALL reactive retry strategies (network / server-error / token-refresh / 400-class negotiation etc.). 0 = a single attempt, no retry. Default 5. Was `auto_truncate.max_retries`. */
    max_reactive_retries: nullableNonnegativeInt(),
    /**
     * Per-strategy retry-registry opt-out (RFC §3.4). Keys are `configKey`s (see
     * {@link RETRY_STRATEGY_CONFIG_KEYS}) — an ENUM record so a typo'd key is a hard schema error (an
     * `unrecognized_keys`-style `invalid_key` issue) rather than a silently-ignored no-op switch.
     * `z.partialRecord` (not `z.record`) so an unrecognized key raises the error on THAT key alone
     * (mirrors `ModelTranslationSchema` above) — `cleanInvalidPaths()` drops just the offending entry
     * (warn-and-continue on `config.yaml` load), never crashes the file-load path. Absent key / absent
     * section = enabled (all 16 strategies on — the current pre-config-switch behavior, byte-equivalent).
     * Only `enabled` bool is exposed — NOT `order` (declared assembly order is a correctness contract, RFC
     * §3.4 decision 1). Distinct from `anthropic.error_selfheal_delegate` (D-class, keyed by strategy
     * `.name` not `configKey`, "delegate to client self-heal" not "remove entirely" — RFC §3.4a, the two
     * open switches are NOT merged/unified).
     */
    strategies: z.partialRecord(z.enum(RETRY_STRATEGY_CONFIG_KEYS), RetryStrategySwitchSchema).optional(),
  })
  .strict()

const GenerationHedgeConfigSchema = z
  .object({
    enabled: nullableBoolean(),
    threshold_sec: nullableNonnegativeInt(),
    max_secondary_candidates: nullableNonnegativeInt(),
    allow_server_tools: nullableBoolean(),
  })
  .strict()

const GenerationRecoveryConfigSchema = z
  .object({
    max_candidates: nullableNonnegativeInt(),
  })
  .strict()

export const GenerationConfigSchema = z
  .object({
    hedge: nullableSection(GenerationHedgeConfigSchema),
    recovery: nullableSection(GenerationRecoveryConfigSchema),
    max_active_candidates: nullablePositiveInt(),
    max_active_dispatches: nullablePositiveInt(),
    max_total_candidates: nullablePositiveInt(),
    max_total_dispatches: nullablePositiveInt(),
    cleanup_grace_sec: nullableNonnegativeInt(),
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
     * substring OR glob (`*`/`?`) with `"*"` wildcard (specificity: literal > glob >
     * `"*"`, then longest key). A match wins over `stream_idle`; 0 = disabled.
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

export const UpstreamTransportHttp2ConfigSchema = z
  .object({
    /**
     * Whether to prefer HTTP/2 (node:http2) for every `https://` upstream. Default `true`.
     *
     * `false` routes `https://` upstreams through undici (HTTP/1.1) instead — an
     * escape hatch that only works honestly on **Node** (`dist/main.mjs`). Under
     * **Bun** (`dev`/`start`), undici's HTTP/1.1 parser hangs forever on the
     * Copilot hosts' chunked responses (Node finalizes in 0.4s, Bun never returns
     * — the exact reason h2 is the default; see transport/upstream-fetch.ts). The
     * value is honored literally on both runtimes; a loud warning is logged when
     * `false` is applied on Bun. Plaintext `http://` upstreams (local SearXNG)
     * always use undici regardless of this flag.
     */
    favor: nullableBoolean(),
    /** Upstream HTTP/2 PING keepalive interval in seconds (0 = disabled). Same semantics as the migrated `timeouts.upstream_h2_ping`. Default 15. Works on both Bun and Node (node:http2 transport is runtime-neutral). */
    ping_interval: nullableNonnegativeInt(),
    /**
     * TCP connect + TLS handshake deadline in seconds for a single h2 session
     * establishment attempt (0 = no timeout). This is a per-attempt connect
     * ceiling, NOT a total request deadline — a proxied connection tunnels a
     * pre-TLS socket then layers TLS, so the worst case is up to 2x this value
     * (connect-to-proxy + TLS-through-tunnel). See
     * docs/decisions/2026-07-14-transport-config-three-axis-organization.md D3.
     * Default 10 (mirrors the previous hardcoded CONNECT_TIMEOUT_MS).
     *
     * `0` genuinely disables the deadline for direct connections and HTTP
     * CONNECT proxies (see plan-2 Step 3). It CANNOT be honestly disabled
     * when the configured proxy is SOCKS — the `socks` package floors its
     * own connect timeout at 30s regardless (`this.options.timeout ||
     * DEFAULT_TIMEOUT`, `DEFAULT_TIMEOUT = 30_000`; verified by reading
     * `node_modules/socks` source). `ConfigSchema`'s top-level
     * `.superRefine()` (see Task 3 Step 6+ below) rejects `0` here whenever
     * `proxy` resolves to a `socks5:`/`socks5h:` URL, rather than silently
     * accepting `0` and getting the library's 30s default instead of the
     * disabled behavior the user asked for (D3/D5 "诚实表达能力边界").
     */
    session_connect_timeout: nullableNonnegativeInt(),
    /**
     * Soft cap on concurrent streams multiplexed onto a SINGLE upstream h2
     * session (0 = unlimited). When a session is at its cap, a new request opens
     * (or reuses another) session for the same origin instead of piling on; the
     * capped session stays routable once its in-flight streams drain. Default 1
     * — each concurrent request gets its own connection, so a session-level
     * upstream teardown (GOAWAY / edge drain) takes down at most one in-flight
     * request instead of every concurrent stream sharing the connection. 0
     * restores the old single-session multiplex. Hot-reloadable; a change only
     * affects future routing, never in-flight streams.
     */
    max_concurrent_streams_per_session: nullableNonnegativeInt(),
    /**
     * Idle timeout in seconds for a pooled h2 session with no in-flight streams
     * before it is proactively closed (0 = never idle-close). Under a finite
     * `max_concurrent_streams_per_session` the pool grows to peak concurrency;
     * this reaps the surplus once a burst subsides. Default 300 (mirrors the WS
     * pool's `websocket.pooled_connection_idle_timeout`, kept a separate h2-only
     * knob). Hot-reloadable.
     */
    idle_session_timeout: nullableNonnegativeInt(),
    /**
     * Cap on the TOTAL live h2 sessions per origin (routable + in-flight
     * creations, 0 = unlimited). Bounds the sessions a finite
     * `max_concurrent_streams_per_session` accumulates. Enforced as a HARD cap: at
     * cap with every session busy, a new request BLOCKS (upstream-side, the client
     * connection stays alive via the handler delayed-commit keepalive) until a
     * slot frees, rather than growing the pool. Default 0 (unlimited) —
     * `idle_session_timeout` converges the long tail; this bounds pathological
     * same-origin fan-out. Max concurrent in-flight streams per origin = this ×
     * max_concurrent_streams_per_session. Hot-reloadable.
     */
    max_sessions_per_origin: nullableNonnegativeInt(),
  })
  .strict()
export type UpstreamTransportHttp2Config = z.infer<typeof UpstreamTransportHttp2ConfigSchema>

export const UpstreamTransportWebsocketConfigSchema = z
  .object({
    /**
     * Idle timeout in seconds for a pooled (not-in-use) upstream Responses WS
     * connection before it is proactively closed (0 = never idle-close).
     * Default 300 (mirrors the previous hardcoded DEFAULT_IDLE_TIMEOUT_MS = 5min).
     */
    pooled_connection_idle_timeout: nullableNonnegativeInt(),
    /** Soft cap on upstream WS pool size (default 32; 0 = unlimited). Was `openai_responses.max_upstream_ws_connections`. */
    soft_max_connections: nullableNonnegativeInt(),
  })
  .strict()
export type UpstreamTransportWebsocketConfig = z.infer<typeof UpstreamTransportWebsocketConfigSchema>

/**
 * `upstream_transport.*` — outbound connection behavior toward the GHC upstream,
 * organized by protocol (D1 three-axis reorg). Distinct from `timeouts.*`
 * (protocol-agnostic request-lifecycle watchdogs) and `server.responses_ws.*`
 * (inbound client-facing WS ingress limits).
 */
export const UpstreamTransportConfigSchema = z
  .object({
    /** Upstream TCP keepalive initial-probe delay in seconds (0 = use undici/Node default, NOT "disabled" — see compat.ts migration for the legacy 0→absence special case). Was `timeouts.upstream_keepalive`. Default 15. Works on both Bun and Node. */
    tcp_keepalive_probe_delay: nullableNonnegativeInt(),
    http2: nullableSection(UpstreamTransportHttp2ConfigSchema),
    websocket: nullableSection(UpstreamTransportWebsocketConfigSchema),
  })
  .strict()
export type UpstreamTransportConfig = z.infer<typeof UpstreamTransportConfigSchema>

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
export const DIAGNOSTIC_LOG_LEVELS = ["silent", "trace", "debug", "info", "warn", "error", "fatal"] as const

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

const LoggingFileConfigSchema = z
  .object({
    enabled: nullableBoolean(),
    directory: nullableString(),
    max_size_mb: nullableNonnegativeInt(),
    max_files_per_process: nullableNonnegativeInt(),
    retention_days: nullableNonnegativeInt(),
  })
  .strict()

const LoggingConfigSchema = z
  .object({
    terminal_level: nullableEnum(DIAGNOSTIC_LOG_LEVELS),
    file_level: nullableEnum(DIAGNOSTIC_LOG_LEVELS),
    file: LoggingFileConfigSchema.nullable()
      .transform((value): z.infer<typeof LoggingFileConfigSchema> | undefined => value ?? undefined)
      .optional(),
  })
  .strict()

const TuiConfigSchema = z.object({ enabled: nullableBoolean() }).strict()

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
     * switch). See resolveBufferedCaps in ./model-overrides.ts.
     */
    buffered_retry: nullableSection(BufferedRetryOverrideSchema),
    /**
     * Vendor-neutral max_tokens continuation policy. Per-vendor overrides use the matching
     * `anthropic` / `openai_responses` / `chat_completions` sections and win over this base.
     * Disabled by default: P0 records diagnostics but never changes client wire behavior.
     */
    max_tokens_continuation: nullableSection(MaxTokensContinuationOverrideSchema),
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
    generation: nullableSection(GenerationConfigSchema),
    /**
     * Sanitize tool names that violate the target model's constraints (illegal
     * characters like dots, over-length, collisions) into legal names before
     * sending upstream, restoring the client's original names in the response.
     * Spans Anthropic + Chat Completions + Responses paths. Default false.
     * Top-level (not under `anthropic.*`) because it is cross-protocol.
     */
    sanitize_tool_names: nullableBoolean(),
    /**
     * Forward the client's inbound query string to the upstream completion
     * endpoint (Anthropic / Chat Completions / Responses / Gemini). Format-agnostic,
     * top-level (not under `anthropic.*`). Security-floor keys
     * (api-version/key/access_token/alt) are always stripped. Default true.
     */
    forward_client_query: nullableBoolean(),
    /** Extra query keys to strip beyond the built-in floor (case-insensitive union). */
    forward_client_query_exclude: z.array(z.string()).optional(),
    history: nullableSection(HistoryConfigSchema),
    hooks: nullableSection(HooksConfigSchema),
    shutdown: nullableSection(ShutdownConfigSchema),
    timeouts: nullableSection(TimeoutsConfigSchema),
    upstream_transport: nullableSection(UpstreamTransportConfigSchema),
    server: nullableSection(ServerConfigSchema),
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
    logging: nullableSection(LoggingConfigSchema),
    tui: nullableSection(TuiConfigSchema),
    /**
     * 优雅重启（零停机换代）裸手动路径的 pidfile 路径覆盖。缺省用 `PATHS.PIDFILE`
     * （`~/.local/share/copilot-api/copilot-api.pid`）。仅裸手动路径读取（supervisor
     * 环境跳过整个 pidfile 机制），且只在 boot 时读一次（不参与热重载——见
     * config-hot-reload.it.test.ts EXEMPT，与 `ghc_api_base_url` 同理）。
     */
    pidfile: nullableString(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const sessionConnectTimeout = cfg.upstream_transport?.http2?.session_connect_timeout
    if (sessionConnectTimeout !== 0 || !cfg.proxy) return
    let scheme: string
    try {
      scheme = new URL(cfg.proxy).protocol
    } catch {
      return // malformed proxy URL is already flagged by ProxySchema's own superRefine; don't double-report
    }
    if (scheme !== "socks5:" && scheme !== "socks5h:") return
    ctx.addIssue({
      code: "custom",
      path: ["upstream_transport", "http2", "session_connect_timeout"],
      message:
        "session_connect_timeout: 0 (disable connect deadline) cannot be honored with a SOCKS proxy — the socks library floors the connect timeout at its own 30s default regardless (node_modules/socks source verified). Set an explicit positive value, or use a direct connection / HTTP CONNECT proxy where 0 genuinely disables the deadline.",
      params: { rejectedValue: sessionConnectTimeout },
    })
  })

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
export type MaxTokensContinuationOverride = z.infer<typeof MaxTokensContinuationOverrideSchema>
export type HistoryConfig = z.infer<typeof HistoryConfigSchema>
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>
export type TimeoutsConfig = z.infer<typeof TimeoutsConfigSchema>
export type RetryConfigSection = z.infer<typeof RetryConfigSchema>
export type GenerationConfigSection = z.infer<typeof GenerationConfigSchema>
export type ModelTranslationIngress = (typeof MODEL_TRANSLATION_INGRESS_VALUES)[number]
export type ModelTranslationFeature = (typeof MODEL_TRANSLATION_FEATURE_VALUES)[number]
export type ModelTranslationRule = z.infer<typeof ModelTranslationRuleSchema>
export type ModelTranslation = z.infer<typeof ModelTranslationSchema>
export type Config = z.infer<typeof ConfigSchema>
