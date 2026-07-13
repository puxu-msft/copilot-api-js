import type { Context } from "hono"

import consola from "consola"
import pc from "picocolors"

import {
  //
  postAnthropicUpstream,
  prepareAnthropicRequest,
} from "~/lib/anthropic/client"
import { runAnthropicPayloadRewrites } from "~/lib/anthropic/payload-rewrites"
import { countTotalInputTokens } from "~/lib/anthropic/token-counting"
import { calibrate } from "~/lib/auto-truncate"
import { createResponseHeaderTimeoutSignal } from "~/lib/fetch-utils"
import {
  //
  ENDPOINT,
  isEndpointSupported,
} from "~/lib/models/endpoint"
import { resolveModelName } from "~/lib/models/resolver"
import {
  //
  formatDuration,
  formatTime,
} from "~/lib/observability/projections/format"
import { publishRequestLine } from "~/lib/observability/synthetic-request-line"
import { state } from "~/lib/state"
import { type MessagesPayload } from "~/types/api/anthropic"

// ============================================================================
// GHC upstream token counting
// ============================================================================

/**
 * Forward token counting to GHC's upstream `/v1/messages/count_tokens` endpoint.
 * Returns the input_tokens count on success, or null to fall through to local
 * estimation.
 *
 * This is the DEFAULT channel (empirically confirmed — see
 * `docs/spec/2026-07-13-ghc-count-tokens-default.md` / the probe conclusions):
 *   - Uses the existing Copilot token (no separate Anthropic API key).
 *   - `payload` is ALREADY system-sanitized by the caller with the same rewrites
 *     the completion path applies at driver S3 (attribution strip, inline
 *     role:"system" handling, system-reminder removal), so `prepareAnthropicRequest`
 *     here produces the SAME wire the real `/v1/messages` request sends — the count
 *     reflects what GHC actually meters (more representative than the retired
 *     api.anthropic.com count, since the real completion also flows through GHC).
 *   - Support boundary ≈ the account's live `/models` catalog. We gate on
 *     `isEndpointSupported(model, MESSAGES)` to skip a doomed 400 round-trip for
 *     catalog models that don't serve `/v1/messages` (e.g. embeddings).
 */
async function countTokensViaGhc(
  c: Context,
  payload: MessagesPayload,
  selectedModel: NonNullable<ReturnType<typeof state.modelIndex.get>>,
): Promise<number | null> {
  // Skip the upstream round-trip for models that can't serve /v1/messages
  // (in-catalog embeddings etc. would 400). `modelIndex` membership alone is a
  // one-way signal (not-in-catalog ⟹ 400), NOT its converse.
  if (!isEndpointSupported(selectedModel, ENDPOINT.MESSAGES)) return null

  // Source client beta + headers EXACTLY as the completion codec does
  // (`codec.ts` parse) so the count wire's beta negotiation / header passthrough
  // matches the real request.
  const clientAnthropicBeta = c.req.raw.headers.get("anthropic-beta") ?? undefined
  const clientRequestHeaders = Object.fromEntries(c.req.raw.headers.entries())

  const { wire, headers } = prepareAnthropicRequest(payload, {
    resolvedModel: selectedModel,
    clientAnthropicBeta,
    clientRequestHeaders,
  })

  try {
    // Resolved outbound name (same key space the completion path uses for the
    // per-model timeout + 529 tag), falling back to the client name.
    const outboundModel = typeof wire.model === "string" ? wire.model : payload.model
    const response = await postAnthropicUpstream({
      path: "/v1/messages/count_tokens",
      wire,
      headers,
      model: outboundModel,
      signal: createResponseHeaderTimeoutSignal(outboundModel),
    })

    if (!response.ok) {
      consola.warn(`[count_tokens] GHC upstream failed: ${response.status} ` + `${await response.text().catch(() => "")} — falling back to local estimation`)
      return null
    }

    const result = (await response.json()) as { input_tokens: number }
    return result.input_tokens
  } catch (error) {
    consola.warn("[count_tokens] GHC upstream error — falling back to local estimation:", error)
    return null
  }
}

/**
 * Handles token counting for Anthropic /v1/messages/count_tokens endpoint.
 *
 * Default channel is GHC's upstream count_tokens (exact, no separate key); falls
 * back to local tiktoken estimation for unsupported models or upstream failures.
 *
 * Per Anthropic docs:
 * - Returns { input_tokens: N } where N is the total input tokens
 * - Thinking blocks from previous assistant turns don't count as input tokens
 * - The count is an estimate
 *
 * Note: count-tokens is intentionally OUT of observability per RFC §6 Q1.
 * No RequestContext, no bus events, no history entry. The terminal outcome is
 * rendered as a request-SHAPED line via `publishRequestLine` (display sinks
 * only — stdout + log file, never history/telemetry), so it reads like a normal
 * request line rather than an `[INFO]` syslog line.
 */
export async function handleCountTokens(c: Context) {
  const startTime = Date.now()
  const method = c.req.method
  const reqPath = c.req.path

  // Render the terminal outcome as a request-shaped line (count_tokens is
  // out-of-observability, so it can't flow through the normal request.completed
  // path — see synthetic-request-line.ts). `channel` = which counting path served it.
  const emitLine = (model: string, inputTokens: number, channel: string): void => {
    const durationMs = Date.now() - startTime
    publishRequestLine({
      prefix: "[ OK ]",
      time: formatTime(),
      method,
      path: reqPath,
      model,
      status: 200,
      duration: formatDuration(durationMs),
      durationMs,
      inputTokens,
      extra: pc.dim(` (${channel})`),
    })
  }

  try {
    const rawPayload = await c.req.json<MessagesPayload>()

    // Resolve model name aliases and date-suffixed versions
    rawPayload.model = resolveModelName(rawPayload.model)

    const selectedModel = state.modelIndex.get(rawPayload.model)

    // Sanitize once with the SAME system-message rewrites the completion path
    // applies at driver S3 (createAnthropicSanitizeRewrite → runAnthropicPayloadRewrites):
    // attribution-billing-line strip, inline role:"system" handling, and
    // system-reminder removal. Without this the counted body diverges from what a
    // real /v1/messages request sends (e.g. the attribution line, stripped in the
    // completion by default, would inflate the count). Tool-name mapping
    // (toolNameMapper) is skipped as immaterial to token counts. Never-throw: an
    // unexpected sanitize failure degrades to counting the raw payload.
    let payload = rawPayload
    try {
      payload = runAnthropicPayloadRewrites(rawPayload, { toolNameMapper: null }).payload
    } catch (error) {
      consola.warn("[count_tokens] payload sanitize failed — counting the raw payload:", error)
    }

    // Model not in the account catalog — nothing to count against locally
    // (countTotalInputTokens requires a Model). Matches the previous guard's
    // position (must precede local estimation).
    if (!selectedModel) {
      emitLine(payload.model, 1, "unknown model")
      return c.json({ input_tokens: 1 })
    }

    // Default channel: GHC upstream count_tokens (exact counts, uses copilot token).
    // Gated by `anthropic.use_upstream_count_tokens` (default on) — when off, skip the
    // upstream round-trip and use the local calibrated estimate only.
    if (state.useUpstreamCountTokens) {
      const ghcCount = await countTokensViaGhc(c, payload, selectedModel)
      if (ghcCount !== null) {
        emitLine(payload.model, ghcCount, "GHC upstream")
        return c.json({ input_tokens: ghcCount })
      }
    }

    // Fallback: local estimation (upstream disabled / unsupported model / failure).
    // Excludes thinking blocks from assistant messages per Anthropic spec, then applies
    // the learned size-aware calibration factor so the local estimate tracks the upstream
    // real count (`calibrate` is identity for an unlearned model). This is the calibration
    // model's honest-counting consumer post-auto-truncate-removal.
    const rawEstimate = await countTotalInputTokens(payload, selectedModel)
    const inputTokens = calibrate(selectedModel.id, rawEstimate)
    emitLine(payload.model, inputTokens, `local calibrated, ${selectedModel.capabilities?.tokenizer ?? "o200k_base"}`)

    return c.json({ input_tokens: inputTokens })
  } catch (error) {
    consola.error("[count_tokens] Error counting tokens:", error)
    return c.json({ input_tokens: 1 })
  }
}
