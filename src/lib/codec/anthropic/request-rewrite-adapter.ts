/**
 * v4 pipeline — Anthropic request rewrite wrapper (Stage A A0).
 *
 * Lifts the Anthropic request sanitize chain out of `codec.parse` (S1) into a
 * driver-S3 `RequestRewrite`, so "add a request-side interception/fix = register a
 * RequestRewrite" (symmetric with the response side). The transform reuses the
 * existing `runAnthropicPayloadRewrites` chain verbatim (tool-preprocess → tool-name
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
 * — not a static module-global `BUILTIN_REQUEST_REWRITES` entry.
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
import { runAnthropicPayloadRewrites } from "~/lib/anthropic/payload-rewrites"
import {
  //
  destackActed,
  toSanitizationInfo,
} from "~/lib/anthropic/sanitize"
import { ENDPOINT } from "~/lib/models/endpoint"

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
    // Two-axis gate (RFC §3.1 / §7.1): the sanitize chain produces the UPSTREAM Anthropic
    // `/v1/messages` wire, so it gates on the OUTBOUND leg (`targetEndpoint`), not the inbound
    // `clientFormat`. Byte-identical to the prior `clientFormat==="anthropic"` gate in Phase 1
    // (anthropic-direct has both axes co-true; no translation leg exists yet).
    appliesTo: (env) => env.targetEndpoint === ENDPOINT.MESSAGES,
    apply: (env) => applyAnthropicSanitize(env, deps),
  }
}

/** The S3 transform + recordings (was inlined in `parseAnthropic`, RFC §4.A0). */
function applyAnthropicSanitize(env: RequestEnvelope, deps: AnthropicRequestRewriteDeps): RewriteResult {
  const ctx = env.ctx
  const baseline = env.body as MessagesPayload
  const { payload: sanitized, sanitizeResult } = runAnthropicPayloadRewrites(baseline, { toolNameMapper: ctx.toolNameMapper })
  const stats = sanitizeResult.stats

  const initialSanitizationInfo = toSanitizationInfo(stats)
  deps.onInitialSanitizationInfo(initialSanitizationInfo)
  // Also record it as a ctx side-channel (RFC §11.2 re-homing) so the CellAssembly-routed direct leg's
  // retry rebuild reads it from ctx (`ctx.initialSanitizationInfo`) instead of a codec accessor — the
  // rewrite owns writing its own side-channel, regardless of who supplies it (codec or assembly).
  ctx.setInitialSanitizationInfo(initialSanitizationInfo)

  // Same gate + mapping the parse path used (RFC §12.9), PLUS the terminal de-stack
  // (pure insertion — invisible to the block-removal counters, so OR'd in via
  // destackActed so its telemetry is never dropped): the baseline is the
  // preprocessed, pre-initial-sanitize messages (= this rewrite's input body).
  const hasPreprocessing = deps.preprocessInfo.dedupedToolCallCount > 0 || deps.preprocessInfo.strippedReadTagCount > 0
  if (stats.totalBlocksRemoved > 0 || stats.systemReminderRemovals > 0 || stats.fixedNameCount > 0 || destackActed(stats) || hasPreprocessing) {
    const messageMapping = buildMessageMapping(baseline.messages, sanitized.messages)
    ctx.setPipelineInfo({
      preprocessing: deps.preprocessInfo,
      sanitization: [initialSanitizationInfo],
      messageMapping,
    })
  }

  return { env: env.with({ body: sanitized }), changed: sanitized !== baseline }
}
