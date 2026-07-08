/**
 * Backward-compatibility redirect layer for `config.yaml`.
 *
 * Single home for every legacy→current config-key migration: renamed keys,
 * relocated keys (top-level→section, cross-section), unit/semantic value
 * changes, and removed keys. `schema.ts` owns the *current* valid shape; this
 * module owns *old→new* redirection.
 *
 * Consumed by `validation.ts`' `extractAndTranslateDeprecated()` on BOTH paths:
 *   - file load (`validateConfig`)        — graceful migrate + warn
 *   - HTTP PUT (`validateConfigInput`)    — normalize old-key bodies before parse
 *
 * Each migration locates the legacy key via `parentPath`+`key`, deletes it,
 * warns once, then deep-merges `translate()`'s patch in *missing-only* (so a
 * user-set new key always wins over the migrated legacy value).
 */

/** A single legacy→current config migration rule. */
export interface ConfigMigration {
  /** Dot-path of the legacy key (used for warn dedup). */
  path: string
  /** Parent path to navigate to before deleting the leaf (`""` = top-level). */
  parentPath: string
  /** Leaf key name to delete from the located parent. */
  key: string
  /** User-facing migration message (without the `[Config] ` prefix). */
  message: string
  /**
   * Optional translator: receives the legacy value, returns a partial Config
   * patch to deep-merge (missing-only) into the payload. Return `undefined` to
   * migrate nothing (e.g. a legacy value of an unexpected type).
   */
  translate?: (legacy: unknown) => Record<string, unknown> | undefined
  /**
   * Optional value-gate for in-place *value* migrations on a key that stays
   * valid (e.g. enum-value consolidation). When present, the migration fires
   * ONLY if this returns true for the current value — so already-valid values
   * are not deleted/warned by the locator's otherwise-unconditional delete+warn.
   */
  isLegacyValue?: (value: unknown) => boolean
}

// ============================================================================
// Declarative migration builders
//
// These reify the path-reverse-engineering that the validation locator
// depends on: `key` = last segment, `parentPath` = prefix, `path` = full
// legacy path. Getting this wrong leaves the legacy key in the payload, where
// `.strict()` + cleanInvalidPaths() silently drop it (user setting lost).
// ============================================================================

/** Build a nested object from a dot-path and a leaf value: `["a","b"], v → {a:{b:v}}`. */
function buildNested(pathParts: ReadonlyArray<string>, value: unknown): Record<string, unknown> {
  return pathParts.reduceRight<unknown>((acc, k) => ({ [k]: acc }), value) as Record<string, unknown>
}

/** Split a dot-path into the `{ path, parentPath, key }` triple the locator needs. */
function splitLegacyPath(oldPath: string): { path: string; parentPath: string; key: string } {
  const parts = oldPath.split(".")
  const key = parts.at(-1) ?? oldPath
  const parentPath = parts.slice(0, -1).join(".")
  return { path: oldPath, parentPath, key }
}

interface RenameLeafOptions {
  /** Transform the legacy value before placing it at `newPath` (e.g. unit conversion). Return `undefined` to skip migration entirely. */
  transform?: (legacy: unknown) => unknown
  /** Override the default migration message. */
  message?: string
}

/**
 * Migrate a single leaf from `oldPath` to `newPath` — rename and/or relocate
 * (top-level or nested), optionally transforming the value. Multiple
 * `renameLeaf` rules targeting the same new section accumulate via the
 * missing-only deep merge in `validation.ts` (each contributes one field).
 */
export function renameLeaf(oldPath: string, newPath: string, opts: RenameLeafOptions = {}): ConfigMigration {
  const located = splitLegacyPath(oldPath)
  const newParts = newPath.split(".")
  return {
    ...located,
    message: opts.message ?? `${oldPath} is renamed to ${newPath}; update your config.yaml`,
    translate(legacy) {
      const value = opts.transform ? opts.transform(legacy) : legacy
      // `undefined` skips the migration; `null` is preserved (PUT delete semantic).
      if (value === undefined) return undefined
      return buildNested(newParts, value)
    },
  }
}

interface RenameSectionOptions {
  /** Rename inner fields while moving the section (old field name → new field name). */
  fieldRenames?: Record<string, string>
  /** Override the default migration message. */
  message?: string
}

/**
 * Rename a whole top-level section from `oldKey` to `newKey`, optionally
 * renaming inner fields. Inner fields NOT listed in `fieldRenames` are kept
 * verbatim. Any renamed inner field MUST be listed here — otherwise the legacy
 * field name lands under the new (strict) section and gets stripped, losing
 * the user's value.
 */
export function renameSection(oldKey: string, newKey: string, opts: RenameSectionOptions = {}): ConfigMigration {
  const fieldRenames = opts.fieldRenames ?? {}
  return {
    path: oldKey,
    parentPath: "",
    key: oldKey,
    message: opts.message ?? `the "${oldKey}" config section is renamed to "${newKey}"; update your config.yaml`,
    translate(legacy) {
      if (legacy === null || typeof legacy !== "object" || Array.isArray(legacy)) return undefined
      const remapped: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(legacy as Record<string, unknown>)) {
        remapped[fieldRenames[k] ?? k] = v
      }
      return { [newKey]: remapped }
    },
  }
}

/** Remove a legacy key entirely (warn-only, no replacement). */
export function removeKey(oldPath: string, message: string): ConfigMigration {
  return { ...splitLegacyPath(oldPath), message }
}

/**
 * In-place value migration: consolidate/rename legacy *values* of a key that
 * itself stays valid (e.g. enum-value consolidation). Unlike `renameLeaf`, this
 * fires ONLY when `isLegacy(value)` is true — already-valid values pass through
 * with no warn and no delete. `translate` re-adds the same key with `newValue`
 * (via the missing-only merge, after the locator deletes the legacy value).
 */
export function migrateValue(oldPath: string, isLegacy: (value: unknown) => boolean, newValue: unknown, message: string): ConfigMigration {
  const located = splitLegacyPath(oldPath)
  const parts = oldPath.split(".")
  return {
    ...located,
    message,
    isLegacyValue: isLegacy,
    translate: () => buildNested(parts, newValue),
  }
}

// ============================================================================
// Migration registry — evaluated top-down by extractAndTranslateDeprecated()
// ============================================================================

export const CONFIG_MIGRATIONS: ReadonlyArray<ConfigMigration> = [
  // ── Historical migrations (carried over from schema.ts) ───────────────────
  renameLeaf("anthropic.immutable_thinking_messages", "anthropic.thinking_block_message_policy", {
    transform: (v) => {
      if (typeof v !== "boolean") return undefined
      return v ? "preserve" : "stripped"
    },
    message: 'anthropic.immutable_thinking_messages is removed; use thinking_block_message_policy ("preserve" | "stripped")',
  }),
  // thinking_block_message_policy value consolidation: the old "immutable" (whole-message
  // freeze) and "fixed-index" (length-preserve) levels were empirically shown to protect
  // nothing real (thinking signatures are self-contained; cleanup never touches thinking
  // blocks), so both collapse into "preserve". Value-gated so already-valid preserve/stripped
  // pass through silently.
  migrateValue(
    "anthropic.thinking_block_message_policy",
    (v) => v === "immutable" || v === "fixed-index",
    "preserve",
    'anthropic.thinking_block_message_policy "immutable"/"fixed-index" are consolidated into "preserve"; update your config.yaml',
  ),
  renameLeaf("anthropic.auto_cache_control", "anthropic.cache_control", {
    transform: (v) => {
      if (typeof v !== "boolean") return undefined
      return v ? "proxied" : "disabled"
    },
    message: 'anthropic.auto_cache_control is removed; use cache_control ("disabled" | "passthrough" | "sanitize" | "proxied")',
  }),
  // refusal_recover_text (boolean) → refusal_sse_rewrite (enum): true → "end_turn" (the old
  // synthesize-text behavior), false → "refusal" (the old passthrough). Same bool→enum shape as
  // auto_cache_control above.
  renameLeaf("anthropic.refusal_recover_text", "anthropic.refusal_sse_rewrite", {
    transform: (v) => {
      if (typeof v !== "boolean") return undefined
      return v ? "end_turn" : "refusal"
    },
    message: 'anthropic.refusal_recover_text is removed; use refusal_sse_rewrite ("refusal" | "end_turn" | "error")',
  }),
  removeKey("history.min_entries", "history.min_entries is removed (was tied to the deleted in-memory history store); ignoring"),
  // Tool-search moved from a manual allowlist to a default-allow matcher (Claude ≥4.5; Haiku + pre-4.5
  // denied), so the old `model_capabilities.tool_search` list is gone. Per-model exceptions now live in
  // `model_capabilities.tool_search_overrides` ({ <model-substring>: true|false }).
  removeKey(
    "anthropic.model_capabilities.tool_search",
    "anthropic.model_capabilities.tool_search is removed — tool-search is now default-allow for Claude ≥4.5 (Haiku + pre-4.5 denied); use model_capabilities.tool_search_overrides { <model-substring>: true|false } to force-enable/disable specific models",
  ),

  // ── Naming-cleanup batch ──────────────────────────────────────────────────
  // section rename + inner ws/websocket unification
  renameSection("openai-responses", "openai_responses", {
    fieldRenames: { upstream_websocket: "upstream_ws", client_websocket_keep_open: "client_ws_keep_open" },
  }),
  // anthropic.* renames (consistency + name-vs-reality)
  renameLeaf("anthropic.efforts_overrides", "anthropic.effort_overrides"),
  renameLeaf("anthropic.thinking_block_sanitize_check", "anthropic.thinking_block_sanitize"),
  // anthropic.* concern-prefix normalization (RFC anthropic-rewrite-reorg §6, Phase 4):
  // every key is concern-first (thinking_/tool_/system_/beta_/retry_/stream_). Behavior
  // unchanged — only the user-facing yaml key spelling. Already-grouped keys (thinking_block_*,
  // context_editing*, tool_search, cache_control, system_messages_sanitize, …) keep their names.
  renameLeaf("anthropic.coerce_adaptive_thinking", "anthropic.thinking_coerce_adaptive"),
  // server-tool sub-concern regrouping: the four keys dealing with Anthropic NATIVE
  // server tools (web_search / memory / code_execution …) move under a `server_tool_*`
  // sub-prefix, distinguishing them from the custom/client-tool keys that keep `tool_*`.
  // `strip_server_tools` (strip declarations) and `rewrite_history_server_tools` (rewrite
  // residual prior-turn blocks) previously carried a trailing `_server` suffix; the ancient
  // legacy names below now point DIRECTLY at the final `server_tool_*` names (no chaining).
  renameLeaf("anthropic.strip_server_tools", "anthropic.server_tool_strip"),
  renameLeaf("anthropic.tool_strip_server", "anthropic.server_tool_strip"),
  renameLeaf("anthropic.rewrite_history_server_tools", "anthropic.server_tool_rewrite"),
  renameLeaf("anthropic.tool_rewrite_history_server", "anthropic.server_tool_rewrite"),
  renameLeaf("anthropic.memory_tool", "anthropic.server_tool_memory"),
  // web_search is a TOP-LEVEL section (not under anthropic.*) — renamed to
  // server_tool_web_search to disambiguate the native server tool from any custom
  // client tool named "web_search". Inner fields (enabled/backend) keep their names.
  renameSection("web_search", "server_tool_web_search"),
  renameLeaf("anthropic.inject_claude_code_tools", "anthropic.tool_inject_claude_code"),
  renameLeaf("anthropic.dedup_tool_calls", "anthropic.tool_dedup_calls"),
  renameLeaf("anthropic.strip_read_tool_result_tags", "anthropic.tool_strip_read_result_tags"),
  renameLeaf("anthropic.non_deferred_tools", "anthropic.tool_search_non_deferred"),
  // tool_non_deferred → tool_search_non_deferred: the non-defer allowlist only
  // applies when tool_search is enabled, so it now carries the tool_search_ sub-concern
  // prefix. Same string[]→string[] shape, no value transform.
  renameLeaf("anthropic.tool_non_deferred", "anthropic.tool_search_non_deferred"),
  renameLeaf("anthropic.decode_tool_input_fields", "anthropic.tool_decode_input_fields"),
  renameLeaf("anthropic.decode_all_tool_input_fields", "anthropic.tool_decode_all_input_fields"),
  renameLeaf("anthropic.recover_tool_call_text", "anthropic.tool_recover_call_text"),
  renameLeaf("anthropic.backfill_question_from_header", "anthropic.tool_backfill_question"),
  renameLeaf("anthropic.rewrite_system_reminders", "anthropic.system_rewrite_reminders"),
  renameLeaf("anthropic.strip_beta_headers", "anthropic.beta_strip_headers"),
  // strip_request_headers → request_header_blacklist: the HTTP request-header strip is
  // now the BLACKLIST half of the blacklist/whitelist forwarding model (sibling
  // request_header_whitelist added). Same glob[]→glob[] shape, no value transform.
  renameLeaf("anthropic.strip_request_headers", "anthropic.request_header_blacklist"),
  renameLeaf("anthropic.reject_body_fields", "anthropic.retry_reject_body_fields"),
  renameLeaf("anthropic.fake_sse_heartbeat", "anthropic.stream_keepalive_ping_sec"),
  renameLeaf("anthropic.stream_fake_sse_heartbeat", "anthropic.stream_keepalive_ping_sec"),
  // rate_limiter unit unification: minutes → seconds (value auto-converted ×60)
  renameLeaf("rate_limiter.recovery_timeout", "rate_limiter.recovery_interval", {
    transform: (v) => (typeof v === "number" ? v * 60 : v),
    message: "rate_limiter.recovery_timeout (minutes) is renamed to recovery_interval (seconds); value auto-converted ×60",
  }),
  // top-level timeouts → timeouts section (three rules accumulate into one section)
  renameLeaf("stream_idle_timeout", "timeouts.stream_idle"),
  renameLeaf("fetch_timeout", "timeouts.response_header"),
  renameLeaf("stale_request_max_age", "timeouts.stale_request_max_age"),
  // compress toggle joins its threshold under auto_truncate
  renameLeaf("compress_tool_results_before_truncate", "auto_truncate.compress_tool_results"),
]
