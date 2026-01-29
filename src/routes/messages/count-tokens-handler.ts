import type { Context } from "hono"

import consola from "consola"

import { checkNeedsCompactionAnthropic } from "~/lib/auto-truncate-anthropic"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { type AnthropicMessagesPayload } from "~/types/api/anthropic"

import { translateToOpenAI } from "./non-stream-translation"

/**
 * Handles token counting for Anthropic messages.
 *
 * For Anthropic models (vendor === "Anthropic"), uses the official Anthropic tokenizer.
 * For other models, uses GPT tokenizers with appropriate buffers.
 *
 * When auto-truncate is enabled and the request would exceed limits,
 * returns an inflated token count to trigger Claude Code's auto-compact mechanism.
 */
export async function handleCountTokens(c: Context) {
  try {
    const anthropicBeta = c.req.header("anthropic-beta")

    const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

    const { payload: openAIPayload } = translateToOpenAI(anthropicPayload)

    const selectedModel = state.models?.data.find(
      (model) => model.id === anthropicPayload.model,
    )

    if (!selectedModel) {
      consola.warn("Model not found, returning default token count")
      return c.json({
        input_tokens: 1,
      })
    }

    // Check if auto-truncate would be triggered
    // If so, return an inflated token count to encourage Claude Code auto-compact
    if (state.autoTruncate) {
      const truncateCheck = await checkNeedsCompactionAnthropic(
        anthropicPayload,
        selectedModel,
      )

      if (truncateCheck.needed) {
        // Return 95% of context window to signal that context is nearly full
        const contextWindow =
          selectedModel.capabilities?.limits?.max_context_window_tokens
          ?? 200000
        const inflatedTokens = Math.floor(contextWindow * 0.95)

        consola.debug(
          `[count_tokens] Would trigger auto-truncate: ${truncateCheck.currentTokens} tokens > ${truncateCheck.tokenLimit}, `
            + `returning inflated count: ${inflatedTokens}`,
        )

        return c.json({
          input_tokens: inflatedTokens,
        })
      }
    }

    // Get tokenizer info from model
    const tokenizerName = selectedModel.capabilities?.tokenizer ?? "o200k_base"

    const tokenCount = await getTokenCount(openAIPayload, selectedModel)

    // Add tool use overhead (applies to all models with tools)
    if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
      let mcpToolExist = false
      if (anthropicBeta?.startsWith("claude-code")) {
        mcpToolExist = anthropicPayload.tools.some((tool) =>
          tool.name.startsWith("mcp__"),
        )
      }
      if (!mcpToolExist) {
        if (anthropicPayload.model.startsWith("claude")) {
          // Base token overhead for tool use capability
          // See: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview#pricing
          tokenCount.input = tokenCount.input + 346
        } else if (anthropicPayload.model.startsWith("grok")) {
          // Estimated base token overhead for Grok tool use (empirically determined)
          tokenCount.input = tokenCount.input + 480
        }
      }
    }

    let finalTokenCount = tokenCount.input + tokenCount.output

    // Apply buffer for models that may have tokenizer differences
    // Note: All models use GPT tokenizers per API info, but API-specific overhead may differ
    const isAnthropicVendor = selectedModel.vendor === "Anthropic"
    if (!isAnthropicVendor) {
      finalTokenCount =
        anthropicPayload.model.startsWith("grok") ?
          // Apply 3% buffer for Grok models (smaller difference from GPT tokenizer)
          Math.round(finalTokenCount * 1.03)
          // Apply 5% buffer for other models using GPT tokenizer
        : Math.round(finalTokenCount * 1.05)
    }

    consola.debug(
      `Token count: ${finalTokenCount} (tokenizer: ${tokenizerName})`,
    )

    return c.json({
      input_tokens: finalTokenCount,
    })
  } catch (error) {
    consola.error("Error counting tokens:", error)
    return c.json({
      input_tokens: 1,
    })
  }
}
