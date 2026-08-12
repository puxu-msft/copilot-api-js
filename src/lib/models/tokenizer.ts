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
 * Spawn the Worker and load its encoder before the first real request needs them.
 *
 * Measured: the first count in a process costs ~1443ms through the Worker and ~1188ms in-thread, almost all of it building the `o200k_base` merge table. Lazily, that whole cost lands on whichever request happens to be first — and after a restart the calibration sink counts tokens on the very first completed request, so it always lands on a real user.
 *
 * Fire-and-forget on purpose: the caller must not await it, because delaying readiness to save a later request is the wrong trade. If no Worker can be had, there is nothing to warm and this does nothing rather than loading the encoder on this thread.
 */
export const warmTokenizer = (): void => {
  // The `async () => 0` is the in-thread branch, and returning without working is the correct behaviour there: if no Worker can be had there is nothing to warm, and loading the encoder on this thread would inflict the very stall this exists to avoid. Nobody reads the value.
  const warming = runTokenizerJob({ op: "text", model: { capabilities: { tokenizer: "o200k_base" } } as Model, text: "warm" }, async () => 0)
  void warming.catch(() => {
    // Warming is an optimization and the client already logs its own failures. Failing a startup over it would be strictly worse than starting cold.
  })
}

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
