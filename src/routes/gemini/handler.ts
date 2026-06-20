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

import { HTTPError } from "~/lib/error"
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

  const resolved = resolveModelName(modelId)
  const model = state.modelIndex.get(resolved)
  if (!model) {
    throw new HTTPError(`Model "${modelId}" not found`, 404, `Model "${modelId}" not found`)
  }

  const text = collectCountTokensText(body)
  const totalTokens = await countTextTokens(text, model)

  const response: CountTokensResponse = {
    totalTokens,
    // Mirror agent-maestro: when client sends `cachedContent`, surface a
    // zero `cachedContentTokenCount` placeholder so clients that key on its
    // presence don't see an undefined field.
    ...(body.cachedContent ? { cachedContentTokenCount: 0 } : {}),
  }

  return c.json(response)
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
