import type {
  //
  ContentBlock,
  EndpointType,
  MessageContent,
  SseEventRecord,
} from "./types"

/** Parse a frame's raw JSON payload, tolerating non-JSON (`[DONE]`, ping) frames. */
function parseFrame(raw: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(raw) as unknown
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

interface AnthropicBlockAcc {
  type: string
  text?: string
  thinking?: string
  signature?: string
  data?: string
  id?: string
  name?: string
  partialJson?: string
}

function accumulateAnthropic(framesIn: Array<SseEventRecord>): MessageContent | undefined {
  const blocks: Array<AnthropicBlockAcc | undefined> = []
  for (const f of framesIn) {
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
          input = { _raw: b.partialJson }
        }
      }
      content.push({ type: "tool_use", id: b.id ?? "", name: b.name ?? "", input } as ContentBlock)
    } else {
      const { partialJson: _drop, ...rest } = b
      if (rest.type === "text") rest.text = rest.text ?? ""
      else if (rest.type === "thinking") rest.thinking = rest.thinking ?? ""
      content.push(rest as ContentBlock)
    }
  }
  return content.length > 0 ? { role: "assistant", content } : undefined
}

function accumulateOpenAICC(framesIn: Array<SseEventRecord>): MessageContent | undefined {
  let text = ""
  const toolCalls = new Map<number, { id?: string; type: "function"; function: { name: string; arguments: string } }>()
  for (const f of framesIn) {
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

/** One accumulating Responses function_call output item (keyed by output_index). */
interface ResponsesToolAcc {
  id: string
  name: string
  args: string
}

/**
 * Responses: text via `response.output_text.delta` + function-call tool_use via
 * `response.output_item.added(item.type=function_call)` + `function_call_arguments.delta`.
 * (Extended over the original text-only accumulator so streaming tool calls surface
 * in BOTH the list preview and the detail Response tab.)
 */
function accumulateResponses(framesIn: Array<SseEventRecord>): MessageContent | undefined {
  let text = ""
  const tools = new Map<number, ResponsesToolAcc>()
  for (const f of framesIn) {
    const j = parseFrame(f.raw)
    if (!j) continue
    const outputIndex = typeof j.output_index === "number" ? j.output_index : 0
    switch (j.type) {
      case "response.output_text.delta": {
        if (typeof j.delta === "string") text += j.delta
        break
      }
      case "response.output_item.added": {
        const item = j.item as Record<string, unknown> | undefined
        if (item?.type === "function_call") {
          tools.set(outputIndex, {
            id: typeof item.id === "string" ? item.id : "",
            name: typeof item.name === "string" ? item.name : "",
            args: "",
          })
        }
        break
      }
      case "response.function_call_arguments.delta": {
        const t = tools.get(outputIndex)
        if (t && typeof j.delta === "string") t.args += j.delta
        break
      }
      default: {
        break
      }
    }
  }
  const content: Array<ContentBlock> = []
  if (text) content.push({ type: "text", text } as ContentBlock)
  for (const t of tools.values()) {
    let input: unknown = {}
    if (t.args) {
      try {
        input = JSON.parse(t.args)
      } catch {
        input = { _raw: t.args }
      }
    }
    content.push({ type: "tool_use", id: t.id, name: t.name, input } as ContentBlock)
  }
  return content.length > 0 ? { role: "assistant", content } : undefined
}

/**
 * Gemini: text + `functionCall` parts (whole per part — no arg deltas) → tool_use.
 * (Extended over the original text-only accumulator.)
 */
function accumulateGemini(framesIn: Array<SseEventRecord>): MessageContent | undefined {
  let text = ""
  const tools: Array<ContentBlock> = []
  for (const f of framesIn) {
    const j = parseFrame(f.raw)
    const parts = (j?.candidates as Array<{ content?: { parts?: Array<Record<string, unknown>> } }> | undefined)?.[0]?.content?.parts
    for (const p of parts ?? []) {
      if (typeof p.text === "string") text += p.text
      const fc = p.functionCall as { name?: string; args?: unknown } | undefined
      if (fc?.name) tools.push({ type: "tool_use", id: "", name: fc.name, input: fc.args ?? {} } as ContentBlock)
    }
  }
  const content: Array<ContentBlock> = []
  if (text) content.push({ type: "text", text } as ContentBlock)
  content.push(...tools)
  return content.length > 0 ? { role: "assistant", content } : undefined
}

/**
 * Reconstruct the assistant message the client actually received from the FORWARDED
 * (client-dialect) SSE frames. Format is chosen by the client `endpoint`. Returns
 * `undefined` when no renderable content accumulated. Shared by the detail Response
 * tab (via `~backend/*` re-export) and the backend response-preview summarizer.
 */
export function accumulateForwardedContent(framesIn: Array<SseEventRecord>, endpoint: EndpointType): MessageContent | undefined {
  switch (endpoint) {
    case "anthropic-messages": {
      return accumulateAnthropic(framesIn)
    }
    case "openai-chat-completions": {
      return accumulateOpenAICC(framesIn)
    }
    case "openai-responses": {
      return accumulateResponses(framesIn)
    }
    case "gemini-generate-content": {
      return accumulateGemini(framesIn)
    }
    default: {
      return undefined
    }
  }
}
