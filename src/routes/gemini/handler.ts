/**
 * Google Gemini-compatible `countTokens` handler.
 *
 * generateContent / streamGenerateContent moved to the v4 driver (handler-v4);
 * this file retains only `countTokens`, which has no upstream API — it estimates
 * input tokens locally with the same `gpt-tokenizer` machinery used by the
 * Anthropic count-tokens handler (no pipeline / history / retry needed).
 */

import type { Context } from "hono"

import type {
  //
  Content as GeminiContent,
  CountTokensRequest,
  CountTokensResponse,
  Part as GeminiPart,
} from "~/types/api/gemini"

import { createLightweightModelOperation } from "~/lib/context/lightweight-model-operation"
import {
  //
  forwardError,
  HTTPError,
  isAbortError,
} from "~/lib/error"
import { resolveModelName } from "~/lib/models/resolver"
import { countTextTokens } from "~/lib/models/tokenizer"
import { state } from "~/lib/state"

/**
 * POST /v1beta/models/:model:countTokens
 *
 * This project has no upstream `countTokens` API. We approximate input tokens
 * locally with the same `gpt-tokenizer` machinery used by the Anthropic
 * count-tokens handler. We collect text from `body.contents` (and
 * `body.systemInstruction` if present), replacing non-text parts with short
 * placeholders, then tokenize the concatenated string. Naively tokenizing
 * `JSON.stringify(body)` over-counts by 2–4× because braces / quotes / field
 * names like `"contents"`, `"parts"` would be tokenized too, which causes
 * real Gemini clients to display false "over quota" UI states.
 */
export async function handleCountTokens(c: Context, modelId: string): Promise<Response> {
  const body = await c.req.json<CountTokensRequest>()
  const semanticInput = structuredClone(body)
  const operation = createLightweightModelOperation({
    kind: "count_tokens",
    request: c.req.raw,
    semanticRequest: semanticInput,
    format: "gemini",
    requestedModel: modelId,
    metadata: { source: "gemini", requestedModel: modelId },
  })
  const resolved = resolveModelName(modelId)
  operation.recordRouting({ resolvedModel: resolved, source: "local", metadata: { tokenizerSource: "local" } })
  const text = collectCountTokensText(body)
  const model = state.modelIndex.get(resolved)
  const attempt = operation.beginAttempt({
    source: "local",
    effectiveRequest: body,
    wireRequest: { tokenizerText: text, model: resolved, tokenizer: model?.capabilities?.tokenizer ?? null },
  })

  try {
    if (!model) {
      throw new HTTPError(`Model "${modelId}" not found`, 404, `Model "${modelId}" not found`)
    }

    const totalTokens = await countTextTokens(text, model)
    const responseBody: CountTokensResponse = {
      totalTokens,
      ...(body.cachedContent ? { cachedContentTokenCount: 0 } : {}),
    }
    attempt.commit({
      result: responseBody,
      usage: { inputTokens: totalTokens },
      metadata: { rawCount: totalTokens, calibratedCount: totalTokens, source: "local" },
    })
    const response = c.json(responseBody)
    await operation.complete(response, {
      usage: { inputTokens: totalTokens },
      metadata: { countTokens: { rawCount: totalTokens, calibratedCount: totalTokens, source: "local" } },
    })
    return response
  } catch (error) {
    attempt.fail({ error, reason: "local Gemini token count failed" })
    const response = forwardError(c, error, "gemini")
    const terminal = { metadata: { countTokens: { source: "local", status: "failed" } } }
    await (error instanceof Error && isAbortError(error) ? operation.abort(response, error, terminal) : operation.fail(response, error, terminal))
    return response
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Collect text from a Gemini `CountTokensRequest` for local tokenization.
 *
 * Walks every `Content` (from both `contents` and the optional
 * `generateContentRequest` wrapper, plus the optional `systemInstruction`)
 * and concatenates only the meaningful textual surface area:
 *
 * - `part.text` is included verbatim.
 * - `part.functionCall` / `part.functionResponse` are JSON-stringified so the
 *   token estimate accounts for their payload size but not for surrounding
 *   wire-protocol envelope keys.
 * - `inlineData` / `fileData` get short placeholder strings so we don't try
 *   to tokenize base64 binary payloads.
 *
 * We intentionally do NOT tokenize `JSON.stringify(body)` — that approach
 * over-counts by 2–4× because braces, quotes, and field names like
 * `"contents"` / `"parts"` get tokenized too, which surfaces in real Gemini
 * clients as false "over quota" UI states.
 */
function collectCountTokensText(body: CountTokensRequest): string {
  const fragments: Array<string> = []

  const visitContent = (content: GeminiContent | undefined): void => {
    if (!content?.parts) return
    for (const part of content.parts) {
      fragments.push(partToCountableText(part))
    }
  }

  visitContent(body.generateContentRequest?.systemInstruction)
  for (const content of body.generateContentRequest?.contents ?? []) {
    visitContent(content)
  }

  for (const content of body.contents ?? []) {
    visitContent(content)
  }

  return fragments.filter((s) => s.length > 0).join("\n")
}

function partToCountableText(part: GeminiPart): string {
  if (part.text !== undefined) return part.text
  if (part.functionCall) {
    return JSON.stringify({ name: part.functionCall.name, args: part.functionCall.args ?? {} })
  }
  if (part.functionResponse) {
    return JSON.stringify({ name: part.functionResponse.name, response: part.functionResponse.response ?? null })
  }
  if (part.inlineData) {
    const mime = part.inlineData.mimeType ?? "application/octet-stream"
    return `[inlineData:${mime}]`
  }
  if (part.fileData?.fileUri) {
    return `[fileData:${part.fileData.fileUri}]`
  }
  return ""
}
