import type { AnthropicMessageResponse } from "../client"

import {
  //
  findDowngradeMarkPos,
  isInvokeTerminal,
  isResidueWhitespaceAdjacent,
  recoverDowngradeTail,
  synthesizeToolUseId,
  type ToolParamTypes,
} from "./core"

export interface RecoverResponseDeps {
  enabled: boolean
  /** wire 工具名（P4 命中）。 */
  toolNames: ReadonlySet<string>
  toolSchemas: Map<string, ToolParamTypes>
}

/** 非流式响应：把降级 text block 重建为 tool_use。整块在手，stop_reason/P3 直接可读（无时序问题）。 */
export function recoverToolCallTextInResponse(response: AnthropicMessageResponse, deps: RecoverResponseDeps): AnthropicMessageResponse {
  if (!deps.enabled) return response
  const content = response.content as unknown as Array<Record<string, unknown> & { type: string }>
  if (content.some((b) => b.type === "tool_use")) return response

  const stopReason = response.stop_reason
  if (stopReason !== "end_turn" && stopReason !== "tool_use") return response

  let seq = 0
  let changed = false
  const out: Array<Record<string, unknown> & { type: string }> = []
  for (const block of content) {
    if (block.type !== "text" || typeof block.text !== "string") {
      out.push(block)
      continue
    }
    const text = block.text
    const markPos = findDowngradeMarkPos(text, deps.toolNames)
    if (markPos < 0) {
      out.push(block)
      continue
    }
    const tail = text.slice(markPos)
    if (stopReason === "end_turn" && (!isResidueWhitespaceAdjacent(text) || !isInvokeTerminal(text))) {
      out.push(block)
      continue
    }
    const result = recoverDowngradeTail(tail, deps.toolSchemas)
    if (!result.recovered) {
      out.push(block)
      continue
    }
    changed = true
    const prose = text.slice(0, markPos).replace(/\s+$/, "")
    if (prose.length > 0) out.push({ type: "text", text: prose })
    for (const rb of result.blocks) {
      if (rb.type === "tool_use") out.push({ type: "tool_use", id: synthesizeToolUseId(rb.name, seq++, tail), name: rb.name, input: rb.input })
      else out.push({ type: "text", text: rb.text })
    }
  }
  if (!changed) return response
  return { ...response, stop_reason: "tool_use", content: out as unknown as AnthropicMessageResponse["content"] }
}
