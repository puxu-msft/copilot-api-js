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
 * fields (model_overrides, efforts_overrides, …) are NOT strict —
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
    recovery_timeout: nullableNonnegativeInt(),
    consecutive_successes: nullableNonnegativeInt(),
  })
  .strict()

export const AnthropicConfigSchema = z
  .object({
    strip_server_tools: nullableBoolean(),
    /**
     * Inject Claude Code official tool stubs (Bash, Read, Write, …) when
     * referenced in message history but missing from the request's tools
     * array. Default true. Disable for non-Claude-Code clients to save
     * prompt budget and avoid biasing the model toward tool calls.
     */
    inject_claude_code_tools: nullableBoolean(),
    thinking_block_message_policy: nullableEnum(["stripped", "immutable", "fixed-index"] as const),
    dedup_tool_calls: z
      .union([z.boolean(), z.literal("input"), z.literal("result"), z.null()], {
        error: "Must be one of: false, true, input, result",
      })
      .optional()
      .transform((v) => v ?? undefined),
    strip_read_tool_result_tags: nullableBoolean(),
    rewrite_system_reminders: z
      .union([z.boolean(), z.array(RewriteRuleSchema), z.null()])
      .optional()
      .transform((v) => v ?? undefined),
    context_editing: nullableEnum(["off", "clear-thinking", "clear-tooluse", "clear-both"] as const),
    context_editing_trigger: nullableNonnegativeInt(),
    context_editing_keep_tools: nullableNonnegativeInt(),
    context_editing_keep_thinking: nullableNonnegativeInt(),
    tool_search: nullableBoolean(),
    cache_control: nullableEnum(["disabled", "passthrough", "sanitize", "proxied"] as const),
    non_deferred_tools: nullableNonemptyStringArray(),
    api_key: nullableString(),
    warmup: nullableEnum(["allow", "reject", "drop", "fake"] as const),
    // Free-form Records — key = model-name pattern, value = list
    efforts_overrides: z.record(z.string(), z.array(z.string())).optional(),
    strip_beta_headers: z.record(z.string(), z.array(z.string())).optional(),
    reject_body_fields: z.record(z.string(), z.array(z.string())).optional(),
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
    upstream_websocket: nullableBoolean(),
    fix_stream_ids: nullableBoolean(),
    client_websocket_keep_open: nullableBoolean(),
    /** Hard cap on inbound WS frame bytes (default 1 MiB; 0 = unlimited). */
    max_ws_frame_bytes: nullableNonnegativeInt(),
    /** Max concurrent client WS connections (default 256; 0 = unlimited). */
    max_client_ws_connections: nullableNonnegativeInt(),
    /** Soft cap on upstream WS pool size (default 32; 0 = unlimited). */
    max_upstream_ws_connections: nullableNonnegativeInt(),
  })
  .strict()

export const HistoryConfigSchema = z
  .object({
    limit: nullableNonnegativeInt(),
    reaper_interval: nullableNonnegativeInt(),
    db_path: nullableString(),
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
 * Per-family preferred model order. Each family is optional; supplying a
 * family replaces its built-in default list entirely. Arrays must be
 * non-empty so `findPreferredModel()` always has a fallback candidate.
 */
const FamilyPreferenceList = z
  .array(z.string().nonempty("Must be a non-empty string"))
  .nonempty("Preference list must contain at least one model ID")
  .nullable()
  .transform((v): Array<string> | undefined => v ?? undefined)
  .optional()

export const ModelPreferenceSchema = z
  .object({
    opus: FamilyPreferenceList,
    sonnet: FamilyPreferenceList,
    haiku: FamilyPreferenceList,
  })
  .strict()

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
    "openai-responses": nullableSection(ResponsesConfigSchema),
    model_overrides: ModelOverridesSchema.nullable()
      .transform((v): z.infer<typeof ModelOverridesSchema> | undefined => v ?? undefined)
      .optional(),
    model_preference: nullableSection(ModelPreferenceSchema),
    disabled_models: nullableNonemptyStringArray(),
    compress_tool_results_before_truncate: nullableBoolean(),
    history: nullableSection(HistoryConfigSchema),
    shutdown: nullableSection(ShutdownConfigSchema),
    stream_idle_timeout: nullableNonnegativeInt(),
    fetch_timeout: nullableNonnegativeInt(),
    stale_request_max_age: nullableNonnegativeInt(),
    model_refresh_interval: nullableNonnegativeInt(),
  })
  .strict()

// ============================================================================
// Deprecated keys — preserved for back-compat detection only.
//
// These are NOT part of `ConfigSchema` (so `.strict()` would normally flag
// them as unknown). `validateConfig()` removes them from the raw payload
// before strict parsing and emits the dedicated migration warning instead
// of the generic "unknown key" message.
// ============================================================================

export interface DeprecatedKey {
  /** Dot-path of the deprecated key in the raw YAML object */
  path: string
  /** Parent path to look the key up from ("" for top-level) */
  parentPath: string
  /** Leaf key name */
  key: string
  /** User-facing migration message (without `[Config] ` prefix) */
  message: string
  /**
   * Optional translator: receives the legacy value, returns a partial
   * Config patch to merge in (e.g. `auto_cache_control: true` → `{ anthropic: { cache_control: "proxied" } }`).
   */
  translate?: (legacy: unknown) => Record<string, unknown> | undefined
}

export const DEPRECATED_KEYS: ReadonlyArray<DeprecatedKey> = [
  {
    path: "anthropic.immutable_thinking_messages",
    parentPath: "anthropic",
    key: "immutable_thinking_messages",
    message:
      'anthropic.immutable_thinking_messages is removed; use thinking_block_message_policy ("immutable" | "stripped" | "fixed-index")',
    translate(legacy) {
      if (typeof legacy !== "boolean") return undefined
      return { anthropic: { thinking_block_message_policy: legacy ? "immutable" : "stripped" } }
    },
  },
  {
    path: "anthropic.auto_cache_control",
    parentPath: "anthropic",
    key: "auto_cache_control",
    message:
      'anthropic.auto_cache_control is removed; use cache_control ("disabled" | "passthrough" | "sanitize" | "proxied")',
    translate(legacy) {
      if (typeof legacy !== "boolean") return undefined
      return { anthropic: { cache_control: legacy ? "proxied" : "disabled" } }
    },
  },
  {
    path: "history.min_entries",
    parentPath: "history",
    key: "min_entries",
    message: "history.min_entries is removed (was tied to the deleted in-memory history store); ignoring",
  },
]

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
// this strategy table" (`anthropic.efforts_overrides`). We make those
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
// efforts_overrides / strip_beta_headers / reject_body_fields intentionally
// omitted — they default to "replace": when the user sets one of these
// tables, they take responsibility for the entire policy.

// ============================================================================

export type RewriteRule = z.infer<typeof RewriteRuleSchema>
export type RateLimiterConfig = z.infer<typeof RateLimiterConfigSchema>
export type AnthropicConfig = z.infer<typeof AnthropicConfigSchema>
export type ShutdownConfig = z.infer<typeof ShutdownConfigSchema>
export type ResponsesConfig = z.infer<typeof ResponsesConfigSchema>
export type HistoryConfig = z.infer<typeof HistoryConfigSchema>
export type ModelPreferenceConfig = z.infer<typeof ModelPreferenceSchema>
export type Config = z.infer<typeof ConfigSchema>
