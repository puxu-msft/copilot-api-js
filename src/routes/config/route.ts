/** Current effective runtime configuration (read-only, sanitized) */

import { Hono } from "hono"

import { state } from "~/lib/state"

export const configRoutes = new Hono()

configRoutes.get("/", (c) => {
  return c.json({
    // ─── General ───
    verbose: state.verbose,

    // ─── Anthropic pipeline ───
    autoTruncate: state.autoTruncate,
    compressToolResultsBeforeTruncate: state.compressToolResultsBeforeTruncate,
    stripServerTools: state.stripServerTools,
    immutableThinkingMessages: state.immutableThinkingMessages,
    dedupToolCalls: state.dedupToolCalls,
    contextEditingMode: state.contextEditingMode,
    rewriteSystemReminders: serializeRewriteSystemReminders(state.rewriteSystemReminders),
    stripReadToolResultTags: state.stripReadToolResultTags,
    systemPromptOverridesCount: state.systemPromptOverrides.length,

    // ─── OpenAI Responses ───
    normalizeResponsesCallIds: state.normalizeResponsesCallIds,

    // ─── Timeouts ───
    fetchTimeout: state.fetchTimeout,
    streamIdleTimeout: state.streamIdleTimeout,
    staleRequestMaxAge: state.staleRequestMaxAge,

    // ─── Shutdown ───
    shutdownGracefulWait: state.shutdownGracefulWait,
    shutdownAbortWait: state.shutdownAbortWait,

    // ─── History ───
    historyLimit: state.historyLimit,
    historyMinEntries: state.historyMinEntries,

    // ─── Model overrides ───
    modelOverrides: state.modelOverrides,

    // ─── Rate limiter (config snapshot, not live state) ───
    rateLimiter: state.adaptiveRateLimitConfig ?? null,
  })
})

/**
 * Serialize rewriteSystemReminders for API output.
 * CompiledRewriteRule contains RegExp objects which don't serialize well —
 * convert back to a human-readable form.
 */
function serializeRewriteSystemReminders(
  value: typeof state.rewriteSystemReminders,
): boolean | Array<{ from: string; to: string; method?: string; model?: string }> {
  if (typeof value === "boolean") return value
  return value.map((rule) => ({
    from: rule.from instanceof RegExp ? rule.from.source : rule.from,
    to: rule.to,
    ...(rule.method ? { method: rule.method } : {}),
    ...(rule.modelPattern ? { model: rule.modelPattern.source } : {}),
  }))
}
