/**
 * v4 pipeline — Anthropic request rewrite wrapper (Stage A A0).
 *
 * Lifts the Anthropic request sanitize chain out of `codec.parse` (S1) into a
 * driver-S3 `RequestRewrite`, so "add a request-side interception/fix = register a
 * RequestRewrite" (symmetric with the response side). The transform reuses the
 * existing `runAnthropicRequestRewrites` chain verbatim (tool-preprocess → tool-name
 * → sanitize, ordering owned there); this wrapper adds the env adapter + the four
 * parse-time side-channel recordings that move to S3 with it:
 *   - `initialSanitizationInfo` (written back to the codec closure for retry rebuilds)
 *   - `pipelineInfo` (preprocessing + sanitization + messageMapping), gated exactly
 *     as parse did (orphan/block removal / system-reminder / fixedName / preprocessing)
 *   - the `thinking` feature
 *
 * The recordings need route-supplied `preprocessInfo` (not on the env), so this is a
 * per-request wrapper the codec builds (closing over `preprocessInfo` + the
 * `initialSanitizationInfo` setter) and hands the driver via `deps.requestRewrites`
 * — not a static module-global `REQUEST_REWRITES` entry.
 */

import type { PreprocessInfo } from "~/lib/history/types"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  RequestRewrite,
  RewriteResult,
} from "~/lib/pipeline/rewrite-registry"
import type { MessagesPayload } from "~/types/api/anthropic"

import { buildMessageMapping } from "~/lib/anthropic/message-mapping"
import { runAnthropicRequestRewrites } from "~/lib/anthropic/request-rewrites"
import { toSanitizationInfo } from "~/lib/anthropic/sanitize"

/** The history-facing sanitization-info envelope (subset of SanitizationStats). */
type SanitizationInfo = ReturnType<typeof toSanitizationInfo>

/** Per-request deps the codec injects (route info + closure write-back). */
export interface AnthropicRequestRewriteDeps {
  /** Message-level preprocess info computed by the route (for `pipelineInfo.preprocessing`). */
  preprocessInfo: PreprocessInfo
  /** Write the initial sanitization-info back to the codec closure (retry rebuild reads it). */
  onInitialSanitizationInfo: (info: SanitizationInfo) => void
}

const ORDER_SANITIZE = 300

/**
 * Build the Anthropic request-sanitize `RequestRewrite` for one request. `apply`
 * runs the canonical chain on the baseline (`env.body`, set un-sanitized by parse),
 * records the four side-channels to `env.ctx`, and returns the sanitized body.
 */
export function createAnthropicSanitizeRewrite(deps: AnthropicRequestRewriteDeps): RequestRewrite {
  return {
    name: "anthropic-sanitize",
    order: ORDER_SANITIZE,
    appliesTo: (env) => env.clientFormat === "anthropic",
    apply: (env) => applyAnthropicSanitize(env, deps),
  }
}

/** The S3 transform + recordings (was inlined in `parseAnthropic`, RFC §4.A0). */
function applyAnthropicSanitize(env: RequestEnvelope, deps: AnthropicRequestRewriteDeps): RewriteResult {
  const ctx = env.ctx
  const baseline = env.body as MessagesPayload
  const { payload: sanitized, sanitizeResult } = runAnthropicRequestRewrites(baseline, { toolNameMapper: ctx.toolNameMapper })
  const stats = sanitizeResult.stats

  const initialSanitizationInfo = toSanitizationInfo(stats)
  deps.onInitialSanitizationInfo(initialSanitizationInfo)

  // Same gate + mapping the parse path used (RFC §12.9): the baseline is the
  // preprocessed, pre-initial-sanitize messages (= this rewrite's input body).
  const hasPreprocessing = deps.preprocessInfo.dedupedToolCallCount > 0 || deps.preprocessInfo.strippedReadTagCount > 0
  if (stats.totalBlocksRemoved > 0 || stats.systemReminderRemovals > 0 || stats.fixedNameCount > 0 || hasPreprocessing) {
    const messageMapping = buildMessageMapping(baseline.messages, sanitized.messages)
    ctx.setPipelineInfo({
      preprocessing: deps.preprocessInfo,
      sanitization: [initialSanitizationInfo],
      messageMapping,
    })
  }

  return { env: env.with({ body: sanitized }), changed: sanitized !== baseline }
}
