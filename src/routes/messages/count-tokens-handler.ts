import type { Context } from "hono"

import consola from "consola"

import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { type AnthropicMessagesPayload } from "~/types/api/anthropic"

import { translateToOpenAI } from "./non-stream-translation"

/**
 * Handles token counting for Anthropic messages.
 *
 * For Anthropic models (vendor === "Anthropic"), uses the official Anthropic tokenizer.
 * For other models, uses GPT tokenizers with appropriate buffers.
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

    // Check if this is an Anthropic model (uses official tokenizer, no buffer needed)
    const isAnthropicModel = selectedModel.vendor === "Anthropic"

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

    // Apply buffer only for non-Anthropic models (Anthropic uses official tokenizer)
    if (!isAnthropicModel) {
      finalTokenCount =
        anthropicPayload.model.startsWith("grok") ?
          // Apply 3% buffer for Grok models (smaller difference from GPT tokenizer)
          Math.round(finalTokenCount * 1.03)
          // Apply 5% buffer for other models using GPT tokenizer
        : Math.round(finalTokenCount * 1.05)
    }

    consola.debug(
      `Token count: ${finalTokenCount} (${isAnthropicModel ? "Anthropic tokenizer" : "GPT tokenizer"})`,
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
