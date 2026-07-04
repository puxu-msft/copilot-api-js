import type {
  //
  ContentBlock,
  MessageContent,
} from "@/lib/content/types"
import type {
  //
  EndpointType,
  SseEventRecord,
} from "@/types"

/** Parse a frame's raw JSON payload, tolerating non-JSON (`[DONE]`, ping) frames. */
function parseFrame(raw: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(raw) as unknown
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** One in-progress Anthropic content block being accumulated across deltas. */
interface AnthropicBlockAcc {
  type: string
  text?: string
  thinking?: string
  signature?: string
  data?: string
  id?: string
  name?: string
  /** Accumulated `input_json_delta.partial_json` for a tool_use block. */
  partialJson?: string
}

/**
 * Accumulate Anthropic SSE frames (content_block_start/delta/stop) into an assistant message.
 * Mirrors the client's own reconstruction so the Response tab shows what Claude Code renders.
 * A malformed tool_use input (the unrepairable case) is kept as `{ _raw }` so the broken JSON is
 * still visible rather than silently dropped.
 */
function accumulateAnthropic(frames: Array<SseEventRecord>): MessageContent | undefined {
  const blocks: Array<AnthropicBlockAcc | undefined> = []
  for (const f of frames) {
    const j = parseFrame(f.raw)
    if (!j) continue
    const type = j.type as string | undefined
    const index = typeof j.index === "number" ? j.index : undefined
    if (type === "content_block_start" && index !== undefined) {
      const cb = (j.content_block as Record<string, unknown> | undefined) ?? {}
      blocks[index] = { ...cb, type: typeof cb.type === "string" ? cb.type : "text", partialJson: "" } as AnthropicBlockAcc
    } else if (type === "content_block_delta" && index !== undefined) {
      const b = blocks[index]
      if (!b) continue
      const d = (j.delta as Record<string, unknown> | undefined) ?? {}
      const str = (v: unknown): string => (typeof v === "string" ? v : "")
      switch (d.type) {
        case "text_delta": {
          b.text = (b.text ?? "") + str(d.text)
          break
        }
        case "thinking_delta": {
          b.thinking = (b.thinking ?? "") + str(d.thinking)
          break
        }
        case "signature_delta": {
          b.signature = (b.signature ?? "") + str(d.signature)
          break
        }
        case "input_json_delta": {
          b.partialJson = (b.partialJson ?? "") + str(d.partial_json)
          break
        }
        default: {
          break
        }
      }
    }
  }

  const content: Array<ContentBlock> = []
  for (const b of blocks) {
    if (!b) continue
    if (b.type === "tool_use" || b.type === "server_tool_use") {
      let input: unknown = {}
      if (b.partialJson) {
        try {
          input = JSON.parse(b.partialJson)
        } catch {
          input = { _raw: b.partialJson } // malformed (unrepairable) — keep the broken JSON visible
        }
      }
      content.push({ type: "tool_use", id: b.id ?? "", name: b.name ?? "", input } as ContentBlock)
    } else {
      const { partialJson: _drop, ...rest } = b
      // A text block opened but never delta'd finalizes with `text: undefined`; the renderer
      // (`LineNumberedText.split`) needs a string. Default text/thinking so an empty block renders
      // as empty rather than an error box.
      if (rest.type === "text") rest.text = rest.text ?? ""
      else if (rest.type === "thinking") rest.thinking = rest.thinking ?? ""
      content.push(rest as ContentBlock)
    }
  }
  return content.length > 0 ? { role: "assistant", content } : undefined
}

/** Accumulate OpenAI Chat-Completions delta frames into an assistant message (content + tool_calls). */
function accumulateOpenAICC(frames: Array<SseEventRecord>): MessageContent | undefined {
  let text = ""
  const toolCalls = new Map<number, { id?: string; type: "function"; function: { name: string; arguments: string } }>()
  for (const f of frames) {
    const j = parseFrame(f.raw)
    const delta = (j?.choices as Array<{ delta?: Record<string, unknown> }> | undefined)?.[0]?.delta
    if (!delta) continue
    if (typeof delta.content === "string") text += delta.content
    for (const tc of (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
      const idx = typeof tc.index === "number" ? tc.index : 0
      const cur = toolCalls.get(idx) ?? { type: "function" as const, function: { name: "", arguments: "" } }
      if (typeof tc.id === "string") cur.id = tc.id
      const fn = tc.function as { name?: string; arguments?: string } | undefined
      if (fn?.name) cur.function.name = fn.name
      if (fn?.arguments) cur.function.arguments += fn.arguments
      toolCalls.set(idx, cur)
    }
  }
  const tcs = [...toolCalls.values()]
  if (!text && tcs.length === 0) return undefined
  return { role: "assistant", content: text, ...(tcs.length > 0 && { tool_calls: tcs }) } as MessageContent
}

/** Best-effort text accumulation for Responses (`response.output_text.delta`). */
function accumulateResponses(frames: Array<SseEventRecord>): MessageContent | undefined {
  let text = ""
  for (const f of frames) {
    const j = parseFrame(f.raw)
    if (j?.type === "response.output_text.delta" && typeof j.delta === "string") text += j.delta
  }
  return text ? { role: "assistant", content: text } : undefined
}

/** Best-effort text accumulation for Gemini (`candidates[].content.parts[].text`). */
function accumulateGemini(frames: Array<SseEventRecord>): MessageContent | undefined {
  let text = ""
  for (const f of frames) {
    const j = parseFrame(f.raw)
    const parts = (j?.candidates as Array<{ content?: { parts?: Array<{ text?: unknown }> } }> | undefined)?.[0]?.content?.parts
    for (const p of parts ?? []) if (typeof p.text === "string") text += p.text
  }
  return text ? { role: "assistant", content: text } : undefined
}

/**
 * Reconstruct the assistant message the client actually received from the forwarded SSE frames,
 * so the Response tab's Proxy→Client section renders semantic content (not a frame summary). Format
 * is chosen by the entry `endpoint`. Returns `undefined` when no renderable content accumulated
 * (e.g. a stream that carried only pings + a terminal error frame — surfaced separately).
 */
export function accumulateForwardedContent(frames: Array<SseEventRecord>, endpoint: EndpointType): MessageContent | undefined {
  switch (endpoint) {
    case "anthropic-messages": {
      return accumulateAnthropic(frames)
    }
    case "openai-chat-completions": {
      return accumulateOpenAICC(frames)
    }
    case "openai-responses": {
      return accumulateResponses(frames)
    }
    case "gemini-generate-content": {
      return accumulateGemini(frames)
    }
    default: {
      return undefined
    }
  }
}
