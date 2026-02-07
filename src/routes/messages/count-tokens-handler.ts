import type { Context } from "hono"

import consola from "consola"

import { checkNeedsCompactionAnthropic, countTotalInputTokens } from "~/lib/auto-truncate/anthropic"
import { hasKnownLimits } from "~/lib/auto-truncate/common"
import { translateModelName } from "~/lib/model-resolver"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { requestTracker } from "~/lib/tui"
import { type AnthropicMessagesPayload } from "~/types/api/anthropic"

import { translateToOpenAI } from "./non-stream-translation"

/**
 * Handles token counting for Anthropic /v1/messages/count_tokens endpoint.
 *
 * Default: counts tokens directly on the Anthropic payload using native
 * counting functions. This avoids OpenAI translation overhead and potential
 * format conversion inaccuracies (tool_use/tool_result blocks being merged).
 *
 * With --redirect-count-tokens: translates to OpenAI format first, then
 * counts using OpenAI token counting logic.
 *
 * Per Anthropic docs:
 * - Returns { input_tokens: N } where N is the total input tokens
 * - Thinking blocks from previous assistant turns don't count as input tokens
 * - The count is an estimate
 */
export async function handleCountTokens(c: Context) {
  const trackingId = c.get("trackingId") as string | undefined

  try {
    const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

    // Resolve model name aliases and date-suffixed versions
    anthropicPayload.model = translateModelName(anthropicPayload.model)

    // Update tracker with model name
    if (trackingId) {
      const request = requestTracker.getRequest(trackingId)
      if (request) request.model = anthropicPayload.model
    }

    const selectedModel = state.models?.data.find((model) => model.id === anthropicPayload.model)

    if (!selectedModel) {
      consola.warn(`[count_tokens] Model "${anthropicPayload.model}" not found, returning input_tokens=1`)
      return c.json({ input_tokens: 1 })
    }

    // Check if auto-truncate would be triggered (only for models with known limits)
    // If so, return an inflated token count to encourage Claude Code auto-compact
    if (state.autoTruncate && hasKnownLimits(selectedModel.id)) {
      const truncateCheck = await checkNeedsCompactionAnthropic(anthropicPayload, selectedModel, {
        checkTokenLimit: true,
        checkByteLimit: true,
      })

      if (truncateCheck.needed) {
        const contextWindow = selectedModel.capabilities?.limits?.max_context_window_tokens ?? 200000
        const inflatedTokens = Math.floor(contextWindow * 0.95)

        consola.debug(
          `[count_tokens] Would trigger auto-truncate: `
            + `${truncateCheck.currentTokens} tokens > ${truncateCheck.tokenLimit}, `
            + `returning inflated count: ${inflatedTokens}`,
        )

        if (trackingId) {
          requestTracker.updateRequest(trackingId, { inputTokens: inflatedTokens })
        }

        return c.json({ input_tokens: inflatedTokens })
      }
    }

    // Count tokens using the appropriate method
    let inputTokens: number

    if (state.redirectCountTokens) {
      // Legacy: translate to OpenAI format, then count
      const { payload: openAIPayload } = translateToOpenAI(anthropicPayload)
      const tokenCount = await getTokenCount(openAIPayload, selectedModel)
      inputTokens = tokenCount.input + tokenCount.output

      consola.debug(
        `[count_tokens] ${inputTokens} tokens (via OpenAI translation) `
          + `(input: ${tokenCount.input}, output: ${tokenCount.output}, `
          + `tokenizer: ${selectedModel.capabilities?.tokenizer ?? "o200k_base"})`,
      )
    } else {
      // Default: count directly on Anthropic payload
      // Excludes thinking blocks from assistant messages per Anthropic spec
      inputTokens = await countTotalInputTokens(anthropicPayload, selectedModel)

      consola.debug(
        `[count_tokens] ${inputTokens} tokens (native Anthropic) `
          + `(tokenizer: ${selectedModel.capabilities?.tokenizer ?? "o200k_base"})`,
      )
    }

    if (trackingId) {
      requestTracker.updateRequest(trackingId, { inputTokens })
    }

    return c.json({ input_tokens: inputTokens })
  } catch (error) {
    consola.error("[count_tokens] Error counting tokens:", error)
    return c.json({ input_tokens: 1 })
  }
}
