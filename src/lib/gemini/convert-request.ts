/**
 * Gemini → OpenAI Chat Completions request conversion.
 *
 * The conversion delegates the tricky bits to companion modules:
 * - tool-call-pairing.ts: matches functionResponse parts to their preceding
 *   functionCall when the client omits ids (langchain-google-genai 4.x).
 * - schema-normalize.ts: lowercases JSON Schema `type` values and strips
 *   `TYPE_UNSPECIFIED` from tool parameter schemas.
 *
 * Notes on lossy/intentional mappings:
 * - `safetySettings`, `responseSchema`, `responseMimeType`, `cachedContent`,
 *   `thinkingConfig`, `routingConfig`, `audioTimestamp`, `mediaResolution`
 *   are not propagated (no OpenAI equivalent in our internal payload).
 * - `inlineData` is encoded as a `data:<mime>;base64,<data>` URL through the
 *   `image_url` content part (same shape OpenAI uses for vision input).
 */

import type {
  //
  Content,
  GenerateContentRequest,
  Part,
} from "~/types/api/gemini"
import type {
  //
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
  ToolCall,
} from "~/types/api/openai-chat-completions"

import { normalizeSchemaTypes } from "./schema-normalize"
import {
  //
  type PairingResult,
  SYNTHETIC_CALL_ID_PREFIX,
  pairFunctionCalls,
  resolveCallId,
  resolveResponseId,
} from "./tool-call-pairing"

/** Options that travel alongside the request body */
export interface ConvertRequestOptions {
  /** Effective model id (parsed from the `:method` path segment) */
  model: string
  /** Whether the OpenAI side should stream (set by route based on `:method`) */
  stream: boolean
}

/** Top-level Gemini fields with no OpenAI equivalent — recorded for warnings */
const LOSSY_TOP_LEVEL_KEYS = [
  "safetySettings",
  "responseSchema",
  "responseMimeType",
  "cachedContent",
  "thinkingConfig",
  "routingConfig",
  "audioTimestamp",
  "mediaResolution",
] as const

/** Output of `convertGeminiRequestToOpenAI` */
export interface ConvertedGeminiRequest {
  payload: ChatCompletionsPayload
  /** Top-level Gemini keys silently dropped during translation (for warnings) */
  droppedParams: Array<string>
}

/** Convert a Gemini `GenerateContentRequest` to an OpenAI ChatCompletionsPayload */
export function convertGeminiRequestToOpenAI(body: GenerateContentRequest, opts: ConvertRequestOptions): ConvertedGeminiRequest {
  const messages: Array<Message> = []

  // 1. systemInstruction → leading system message
  const systemText = extractTextFromContent(body.systemInstruction)
  if (systemText) {
    messages.push({ role: "system", content: systemText })
  }

  // 2. contents → user / assistant / tool messages
  const pairing = pairFunctionCalls(body.contents ?? [])
  for (const content of body.contents ?? []) {
    messages.push(...convertContentToMessages(content, pairing))
  }

  // 3. tools
  const tools = convertGeminiTools(body.tools)

  // 4. tool choice
  const toolChoice = convertToolChoice(body.toolConfig?.functionCallingConfig?.mode)

  // 5. generation config
  const gen = body.generationConfig ?? {}

  const payload: ChatCompletionsPayload = {
    model: opts.model,
    messages,
    stream: opts.stream,
  }
  if (gen.temperature !== undefined) payload.temperature = gen.temperature
  if (gen.topP !== undefined) payload.top_p = gen.topP
  if (gen.maxOutputTokens !== undefined) payload.max_completion_tokens = gen.maxOutputTokens
  if (gen.stopSequences && gen.stopSequences.length > 0) payload.stop = gen.stopSequences
  if (gen.frequencyPenalty !== undefined) payload.frequency_penalty = gen.frequencyPenalty
  if (gen.presencePenalty !== undefined) payload.presence_penalty = gen.presencePenalty
  if (gen.seed !== undefined) payload.seed = gen.seed
  if (tools && tools.length > 0) payload.tools = tools
  if (toolChoice !== undefined) payload.tool_choice = toolChoice
  if (opts.stream) payload.stream_options = { include_usage: true }

  const droppedParams = LOSSY_TOP_LEVEL_KEYS.filter((key) => (body as Record<string, unknown>)[key] !== undefined) as Array<string>

  return { payload, droppedParams }
}

// ============================================================================
// Helpers
// ============================================================================

function extractTextFromContent(content: Content | undefined): string {
  if (!content?.parts) return ""
  // systemInstruction is OpenAI `system` (plain string). Non-text parts have
  // no first-class place there; rather than silently dropping the data,
  // record a placeholder so downstream debugging shows the loss point.
  return content.parts
    .map((part) => {
      if (part.text !== undefined) return part.text
      if (part.inlineData) {
        const mime = part.inlineData.mimeType ?? "application/octet-stream"
        return `[inline data dropped: ${mime}]`
      }
      if (part.fileData?.fileUri) {
        return `[file data dropped: ${part.fileData.fileUri}]`
      }
      if (part.functionCall || part.functionResponse) {
        return "[function part dropped: not valid in systemInstruction]"
      }
      return ""
    })
    .filter((s) => s.length > 0)
    .join("")
}

/**
 * Convert one Gemini `Content` to one or more OpenAI messages.
 *
 * `user` content with `functionResponse` parts splits into individual `tool`
 * messages (OpenAI requires one tool message per tool_call_id). `model`
 * content with text + functionCall fuses into a single assistant message.
 */
function convertContentToMessages(content: Content, pairing: PairingResult): Array<Message> {
  const role = content.role ?? "user"
  const parts = content.parts ?? []

  if (role === "model") {
    return [convertAssistantContent(parts, pairing)]
  }

  // user role: separate functionResponse parts into individual tool messages.
  const out: Array<Message> = []
  const userParts: Array<Part> = []
  for (const part of parts) {
    if (part.functionResponse) {
      const callId = resolveResponseId(part, pairing)
      if (!callId) continue
      const responseText = part.functionResponse.response !== undefined ? JSON.stringify(part.functionResponse.response) : ""
      out.push({
        role: "tool",
        tool_call_id: callId,
        content: responseText,
      })
    } else {
      userParts.push(part)
    }
  }

  if (userParts.length > 0) {
    out.push({
      role: "user",
      content: convertUserParts(userParts),
    })
  }

  return out
}

function convertAssistantContent(parts: ReadonlyArray<Part>, pairing: PairingResult): Message {
  let textBuffer = ""
  const toolCalls: Array<ToolCall> = []

  for (const part of parts) {
    if (part.text !== undefined) {
      textBuffer += part.text
    } else if (part.functionCall?.name) {
      const id = resolveCallId(part, pairing) ?? `${SYNTHETIC_CALL_ID_PREFIX}fallback:${toolCalls.length}:${part.functionCall.name}`
      toolCalls.push({
        id,
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      })
    }
    // model-role functionResponse parts are illegal; ignore.
  }

  const msg: Message = {
    role: "assistant",
    content: textBuffer.length > 0 ? textBuffer : null,
  }
  if (toolCalls.length > 0) {
    msg.tool_calls = toolCalls
  }
  return msg
}

function convertUserParts(parts: ReadonlyArray<Part>): string | Array<ContentPart> {
  // Plain-text fast path.
  if (parts.every((p) => p.text !== undefined)) {
    return parts.map((p) => p.text ?? "").join("")
  }

  const out: Array<ContentPart> = []
  for (const part of parts) {
    if (part.text !== undefined) {
      out.push({ type: "text", text: part.text })
    } else if (part.inlineData?.data) {
      const mime = part.inlineData.mimeType ?? "application/octet-stream"
      out.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${part.inlineData.data}` },
      })
    } else if (part.fileData?.fileUri) {
      // Best-effort: pass file URI through as an image_url so vision models
      // can fetch it. Non-image MIME types may be rejected upstream — there's
      // no lossless mapping in OpenAI ChatCompletions.
      out.push({ type: "image_url", image_url: { url: part.fileData.fileUri } })
    } else {
      // Last resort: serialize unknown parts so data isn't silently dropped.
      out.push({ type: "text", text: JSON.stringify(part) })
    }
  }
  return out
}

function convertGeminiTools(tools: GenerateContentRequest["tools"]): Array<Tool> | undefined {
  if (!tools || tools.length === 0) return undefined
  const out: Array<Tool> = []
  for (const tool of tools) {
    if (!tool.functionDeclarations) continue
    for (const decl of tool.functionDeclarations) {
      if (!decl.name) continue
      const rawSchema = decl.parameters ?? decl.parametersJsonSchema ?? {}
      const parameters = normalizeSchemaTypes(rawSchema) as Record<string, unknown>
      out.push({
        type: "function",
        function: {
          name: decl.name,
          description: decl.description ?? "",
          parameters,
        },
      })
    }
  }
  return out.length > 0 ? out : undefined
}

function convertToolChoice(mode: string | undefined): ChatCompletionsPayload["tool_choice"] | undefined {
  if (!mode) return undefined
  // FunctionCallingConfigMode values: MODE_UNSPECIFIED | AUTO | ANY | NONE | VALIDATED
  if (mode === "AUTO" || mode === "VALIDATED") return "auto"
  if (mode === "ANY") return "required"
  if (mode === "NONE") return "none"
  return undefined
}
