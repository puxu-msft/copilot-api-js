/**
 * Token counting: the public API.
 *
 * Same four functions, same signatures, same numbers as before — the only change is where the work happens. Each call is one round trip to the tokenizer Worker (`tokenizer-worker.ts`), with the identical computation on this thread as the fallback.
 *
 * The job is shipped whole rather than per-string on purpose. The natural chokepoint is `Encoder.encode()`, but it runs inside tight loops over messages, tool definitions, and parameters, so a thread boundary there would mean hundreds of round trips for one payload. At this level it is exactly one.
 */

import type {
  //
  ChatCompletionsPayload,
  Message,
} from "~/types/api/openai-chat-completions"

import type { Model } from "./client"

import {
  //
  runTokenizerJob,
} from "./tokenizer-client"
import {
  //
  computePerMessageTokenCounts,
  computeTextTokens,
  computeTokenCount,
  computeToolsTokenCount,
} from "./tokenizer-core"

export {
  //
  getTokenizerWorkerDiagnostics,
  shutdownTokenizerWorker,
} from "./tokenizer-client"

export {
  //
  getTokenizerFromModel,
  numTokensForTools,
} from "./tokenizer-core"

/**
 * Count tokens in a text string using the model's tokenizer.
 * This is a simple wrapper for counting tokens in plain text.
 */
export const countTextTokens = async (text: string, model: Model): Promise<number> =>
  await runTokenizerJob({ op: "text", model, text }, async () => await computeTextTokens(text, model))

/**
 * Calculate the token count of messages.
 * Uses the tokenizer specified by the GitHub Copilot API model info.
 * All models (including Claude) use GPT tokenizers (o200k_base or cl100k_base).
 */
export const getTokenCount = async (payload: ChatCompletionsPayload, model: Model): Promise<{ input: number; output: number }> =>
  await runTokenizerJob({ op: "payload", model, payload }, async () => await computeTokenCount(payload, model))

/**
 * Count tokens per message using the model's gpt tokenizer.
 * Returns an array where index i holds the token count for `messages[i]`.
 *
 * Used by the OpenAI auto-truncate binary search so its cumulative sums share
 * the SAME caliber as the gpt-derived token limit (mirrors the Anthropic
 * `countPerMessageTokens`). Using the char/4 `estimateMessageTokens` here would
 * misplace the preserve boundary relative to a gpt-caliber limit.
 */
export const getPerMessageTokenCounts = async (messages: Array<Message>, model: Model): Promise<Array<number>> =>
  await runTokenizerJob({ op: "perMessage", model, messages }, async () => await computePerMessageTokenCounts(messages, model))

/**
 * Count the gpt-caliber token overhead of a payload's tools array (0 if none).
 * Used by the OpenAI auto-truncate binary search so the preserve boundary accounts
 * for tool definitions — a many-tool payload carries 20k+ fixed tool tokens that
 * would otherwise be ignored, leaving the truncated result over the limit.
 */
export const getToolsTokenCount = async (payload: ChatCompletionsPayload, model: Model): Promise<number> =>
  await runTokenizerJob({ op: "tools", model, payload }, async () => await computeToolsTokenCount(payload, model))
