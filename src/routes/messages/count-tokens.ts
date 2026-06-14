import type { Context } from "hono"

import consola from "consola"

import {
  //
  checkNeedsCompactionAnthropic,
  countTotalInputTokens,
} from "~/lib/anthropic/auto-truncate"
import { sanitizeInlineSystemMessages } from "~/lib/anthropic/sanitize/system-messages"
import { hasKnownLimits } from "~/lib/auto-truncate"
import { createFetchSignal } from "~/lib/fetch-utils"
import { resolveModelName } from "~/lib/models/resolver"
import { state } from "~/lib/state"
import { type MessagesPayload } from "~/types/api/anthropic"

// ============================================================================
// Anthropic direct token counting
// ============================================================================

/** Resolve the effective Anthropic API key from config or env var */
function getAnthropicApiKey(): string | undefined {
  return state.anthropicApiKey || process.env.ANTHROPIC_API_KEY || undefined
}

/**
 * Forward token counting to Anthropic's real /v1/messages/count_tokens endpoint.
 * Returns the input_tokens count on success, or null to fall through to local estimation.
 *
 * The endpoint is free (no per-token cost, rate-limited to 100 RPM at Tier 1).
 * Only used for Claude models when an Anthropic API key is available.
 */
async function countTokensViaAnthropic(payload: MessagesPayload): Promise<number | null> {
  if (!payload.model.startsWith("claude")) return null

  const apiKey = getAnthropicApiKey()
  if (!apiKey) return null

  // Copilot uses dotted names (claude-opus-4.6) but Anthropic requires dashes (claude-opus-4-6)
  const model = payload.model.replaceAll(".", "-")

  // Strip inline role:"system" messages the same way the request path does —
  // otherwise the real Anthropic endpoint rejects them with `Unexpected role
  // "system"` and we waste a failed upstream request before falling back.
  const inlineSystem = sanitizeInlineSystemMessages(payload.messages, payload.system, state.systemMessagesSanitize)
  const countPayload = { ...payload, model, system: inlineSystem.system, messages: inlineSystem.messages }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "token-counting-2024-11-01",
      },
      body: JSON.stringify(countPayload),
      signal: createFetchSignal(),
    })

    if (!response.ok) {
      consola.warn(`[count_tokens] Anthropic API failed: ${response.status} ` + `${await response.text().catch(() => "")} — falling back to local estimation`)
      return null
    }

    const result = (await response.json()) as { input_tokens: number }
    return result.input_tokens
  } catch (error) {
    consola.warn("[count_tokens] Anthropic API error — falling back to local estimation:", error)
    return null
  }
}

/**
 * Handles token counting for Anthropic /v1/messages/count_tokens endpoint.
 *
 * Counts tokens directly on the Anthropic payload using native counting functions.
 *
 * Per Anthropic docs:
 * - Returns { input_tokens: N } where N is the total input tokens
 * - Thinking blocks from previous assistant turns don't count as input tokens
 * - The count is an estimate
 */
export async function handleCountTokens(c: Context) {
  try {
    const anthropicPayload = await c.req.json<MessagesPayload>()

    // Resolve model name aliases and date-suffixed versions
    anthropicPayload.model = resolveModelName(anthropicPayload.model)

    // Note: count-tokens is intentionally OUT of observability per RFC §6 Q1.
    // No RequestContext, no bus events, no TUI line, no history entry. The
    // route's own `consola.info("[count_tokens] N tokens")` lines below are
    // the sole operator signal. The middleware will skip ctx creation for
    // this path entirely in commit 3e (SYNTHETIC_PATHS).

    const selectedModel = state.modelIndex.get(anthropicPayload.model)

    // Try Anthropic's real endpoint first for Claude models (free, exact counts)
    const anthropicCount = await countTokensViaAnthropic(anthropicPayload)
    if (anthropicCount !== null) {
      consola.info(`[count_tokens] ${anthropicCount} tokens (Anthropic API)`)
      return c.json({ input_tokens: anthropicCount })
    }

    // Fallback: local estimation (also used for non-Claude models)

    if (!selectedModel) {
      consola.warn(`[count_tokens] Model "${anthropicPayload.model}" not found, returning input_tokens=1`)
      return c.json({ input_tokens: 1 })
    }

    // Check if auto-truncate would be triggered (only for models with known limits)
    // If so, return an inflated token count to encourage Claude Code auto-compact
    if (state.autoTruncate && hasKnownLimits(selectedModel.id)) {
      const truncateCheck = await checkNeedsCompactionAnthropic(anthropicPayload, selectedModel, {
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

    // Count tokens directly on Anthropic payload
    // Excludes thinking blocks from assistant messages per Anthropic spec
    const inputTokens = await countTotalInputTokens(anthropicPayload, selectedModel)

    consola.debug(`[count_tokens] ${inputTokens} tokens (native Anthropic) ` + `(tokenizer: ${selectedModel.capabilities?.tokenizer ?? "o200k_base"})`)

    return c.json({ input_tokens: inputTokens })
  } catch (error) {
    consola.error("[count_tokens] Error counting tokens:", error)
    return c.json({ input_tokens: 1 })
  }
}
