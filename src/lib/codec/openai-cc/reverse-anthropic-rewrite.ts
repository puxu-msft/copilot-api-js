/**
 * v4 pipeline — REVERSE-leg Anthropic request sanitize rewrite (Phase 5, T5.2 BLOCK 疑点 2).
 *
 * A cc/responses/gemini client pinned to `@messages` reaches a direct-Anthropic upstream leg: the hub
 * translated the CC-canonical body to an Anthropic Messages body (S2 translateOut), which may carry orphan
 * `tool_result` blocks or leftover system-reminders the CC→Anthropic translator can't clean up. The Anthropic
 * wire prep (`prepareAnthropicRequest`) only does B1-B12 wire shaping — NOT orphan/reminder removal — so
 * without this sanitize the reverse wire hits a GHC 400 (RFC §3.1/§7.1: a reverse leg's `targetEndpoint===
 * /v1/messages` MUST fire the Anthropic upstream rewrites).
 *
 * Why NOT reuse `createAnthropicSanitizeRewrite` (the forward/direct one): its `apply` reads
 * `ctx.toolNameMapper`, which on a reverse leg is the CC mapper (the cc codec's parse built it) — feeding a
 * CC mapper into the Anthropic tool-name sanitize is semantically wrong. This reverse-specific rewrite is
 * fed the Anthropic tool-name mapper (built from the TRANSLATED Anthropic body's tools) via a shared holder,
 * and uses an empty `preprocessing` envelope (a reverse leg has no Anthropic message-level preprocess).
 *
 * The SAME {@link ReverseAnthropicMapperHolder} instance is shared with the strategies' `resanitize`
 * (auto-truncate re-sanitizes with it) — one mapper source, never two (fix-all-comparison-sites).
 */

import type { AnthropicSanitizeFn } from "~/lib/anthropic/pipeline"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  RequestRewrite,
  RewriteResult,
} from "~/lib/pipeline/rewrite-registry"
import type { ToolNameMapper } from "~/lib/tool-name-mapper"
import type { MessagesPayload } from "~/types/api/anthropic"

import { buildMessageMapping } from "~/lib/anthropic/message-mapping"
import { runAnthropicPayloadRewrites } from "~/lib/anthropic/payload-rewrites"
import {
  //
  destackActed,
  toSanitizationInfo,
} from "~/lib/anthropic/sanitize"
import { buildAnthropicToolNameMapper } from "~/lib/anthropic/sanitize/tool-name-sanitize"
import { ENDPOINT } from "~/lib/models/endpoint"

const ORDER_SANITIZE = 300

/**
 * A per-request memoized Anthropic tool-name mapper for the reverse leg. Built LAZILY from the first
 * translated Anthropic body seen (the sanitize rewrite's S3 `apply`), then reused by the strategies'
 * `resanitize` — so both sanitize the reverse wire with the SAME mapper. Usually `null` (the CC codec's
 * parse already sanitized the client tool names, so the Anthropic pass finds nothing to rewrite).
 */
export interface ReverseAnthropicMapperHolder {
  /** Memoized resolve: builds the mapper from `body.tools` on the first call, returns the cached one after. */
  resolve(body: MessagesPayload): ToolNameMapper | null
}

/** Build a {@link ReverseAnthropicMapperHolder} for one reverse request (resolved model name + vendor). */
export function createReverseAnthropicMapperHolder(resolvedName: string, vendor?: string): ReverseAnthropicMapperHolder {
  let built = false
  let mapper: ToolNameMapper | null = null
  return {
    resolve(body) {
      if (!built) {
        built = true
        mapper = buildAnthropicToolNameMapper(body.tools, resolvedName, vendor)
      }
      return mapper
    },
  }
}

/**
 * Build the reverse Anthropic sanitize `AnthropicSanitizeFn` over the shared holder — the SAME closure the
 * strategies' auto-truncate `resanitize` reuses (so both sanitize the translated body identically).
 */
export function buildReverseResanitize(holder: ReverseAnthropicMapperHolder): AnthropicSanitizeFn {
  return (p) => runAnthropicPayloadRewrites(p, { toolNameMapper: holder.resolve(p) }).sanitizeResult
}

/**
 * Build the reverse Anthropic-sanitize `RequestRewrite` (gates the OUTBOUND `/v1/messages` leg). `apply`
 * runs the canonical Anthropic sanitize chain on the translated body with the Anthropic mapper + records
 * the sanitization info to `ctx.setPipelineInfo` when it acted (empty `preprocessing` — reverse has none).
 */
export function createReverseAnthropicSanitizeRewrite(holder: ReverseAnthropicMapperHolder): RequestRewrite {
  return {
    name: "reverse-anthropic-sanitize",
    order: ORDER_SANITIZE,
    // Two-axis gate (RFC §3.1): the Anthropic sanitize produces the UPSTREAM /v1/messages wire, so it
    // gates on the OUTBOUND leg — fires exactly on a reverse cc/responses/gemini → messages leg.
    appliesTo: (env) => env.targetEndpoint === ENDPOINT.MESSAGES,
    apply: (env) => applyReverseAnthropicSanitize(env, holder),
  }
}

function applyReverseAnthropicSanitize(env: RequestEnvelope, holder: ReverseAnthropicMapperHolder): RewriteResult {
  const ctx = env.ctx
  const baseline = env.body as MessagesPayload
  const { payload: sanitized, sanitizeResult } = runAnthropicPayloadRewrites(baseline, { toolNameMapper: holder.resolve(baseline) })
  const stats = sanitizeResult.stats

  const sanitizationInfo = toSanitizationInfo(stats)
  // Record when the sanitize acted (orphan/reminder/fixed-name/de-stack). Reverse legs have no Anthropic
  // message-level preprocess, so `preprocessing` is the empty envelope.
  if (stats.totalBlocksRemoved > 0 || stats.systemReminderRemovals > 0 || stats.fixedNameCount > 0 || destackActed(stats)) {
    const messageMapping = buildMessageMapping(baseline.messages, sanitized.messages)
    ctx.setPipelineInfo({
      preprocessing: { strippedReadTagCount: 0, dedupedToolCallCount: 0 },
      sanitization: [sanitizationInfo],
      messageMapping,
    })
  }

  return { env: env.with({ body: sanitized }), changed: sanitized !== baseline }
}
