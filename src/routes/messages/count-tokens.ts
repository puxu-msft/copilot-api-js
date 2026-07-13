import type { Context } from "hono"

import consola from "consola"

import {
  //
  checkNeedsCompactionAnthropic,
  countTotalInputTokens,
} from "~/lib/anthropic/auto-truncate"
import {
  //
  postAnthropicUpstream,
  prepareAnthropicRequest,
} from "~/lib/anthropic/client"
import { runAnthropicPayloadRewrites } from "~/lib/anthropic/payload-rewrites"
import { hasKnownLimits } from "~/lib/auto-truncate"
import { createResponseHeaderTimeoutSignal } from "~/lib/fetch-utils"
import {
  //
  ENDPOINT,
  isEndpointSupported,
} from "~/lib/models/endpoint"
import { resolveModelName } from "~/lib/models/resolver"
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
 * No RequestContext, no bus events, no TUI line, no history entry. The
 * route's own `consola` lines below are the sole operator signal.
 */
export async function handleCountTokens(c: Context) {
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

    // Auto-truncate inflation check (moved to the front): if a prompt is over the
    // limit and auto-truncate is on, return an inflated count to encourage
    // Claude Code auto-compact. This is independent of the counting channel and
    // saves a doomed-to-inflate upstream round-trip. Only for models with known
    // limits.
    if (state.autoTruncate && selectedModel && hasKnownLimits(selectedModel.id)) {
      const truncateCheck = await checkNeedsCompactionAnthropic(payload, selectedModel, {
        checkTokenLimit: true,
      })

      if (truncateCheck.needed) {
        const contextWindow = selectedModel.capabilities?.limits?.max_context_window_tokens ?? 200000
        const inflatedTokens = Math.floor(contextWindow * 0.95)

        consola.info(
          `[count_tokens] Prompt too long: `
            + `${truncateCheck.currentTokens} tokens > ${truncateCheck.tokenLimit} limit, `
            + `returning inflated count ${inflatedTokens} to trigger client-side compaction`,
        )

        return c.json({ input_tokens: inflatedTokens })
      }
    }

    // Model not in the account catalog — nothing to count against locally
    // (countTotalInputTokens requires a Model). Matches the previous guard's
    // position (must precede local estimation).
    if (!selectedModel) {
      consola.warn(`[count_tokens] Model "${payload.model}" not found, returning input_tokens=1`)
      return c.json({ input_tokens: 1 })
    }

    // Default channel: GHC upstream count_tokens (exact counts, uses copilot token)
    const ghcCount = await countTokensViaGhc(c, payload, selectedModel)
    if (ghcCount !== null) {
      consola.info(`[count_tokens] ${ghcCount} tokens (GHC upstream)`)
      return c.json({ input_tokens: ghcCount })
    }

    // Fallback: local estimation (unsupported models / upstream failure).
    // Excludes thinking blocks from assistant messages per Anthropic spec.
    const inputTokens = await countTotalInputTokens(payload, selectedModel)

    consola.debug(`[count_tokens] ${inputTokens} tokens (local estimation) ` + `(tokenizer: ${selectedModel.capabilities?.tokenizer ?? "o200k_base"})`)

    return c.json({ input_tokens: inputTokens })
  } catch (error) {
    consola.error("[count_tokens] Error counting tokens:", error)
    return c.json({ input_tokens: 1 })
  }
}
