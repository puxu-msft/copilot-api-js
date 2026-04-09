import type { ContentBlock, EntrySummary, HistoryEntry, MessageContent } from "@/types"

export function getPreviewText(entry: HistoryEntry): string {
  const messages = entry.request.messages ?? []
  if (messages.length === 0) return ""

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "tool") continue
    if (msg.role !== "user") continue

    if (Array.isArray(msg.content) && msg.content.every((b: ContentBlock) => b.type === "tool_result")) {
      continue
    }

    const text = extractText(msg.content)
    if (text) return text.slice(0, 100)
    break
  }

  const last = messages.at(-1)
  if (!last) return ""
  if (last.role === "assistant" && last.tool_calls && last.tool_calls.length > 0) {
    const names = last.tool_calls.map((tc: { function: { name: string } }) => tc.function.name).join(", ")
    return `[tool_call: ${names}]`.slice(0, 100)
  }
  if (last.role === "tool") {
    return `[tool_result: ${last.tool_call_id ?? "unknown"}]`.slice(0, 100)
  }
  return extractText(last.content).slice(0, 100)
}

export function extractText(content: string | Array<ContentBlock> | null): string {
  if (!content) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((b) => {
      if (b.type === "text" && "text" in b) return b.text
      if (b.type === "thinking" && "thinking" in b) return b.thinking
      if (b.type === "tool_use" && "name" in b) return `[Tool: ${b.name}]`
      if (b.type === "tool_result") return "[Tool Result]"
      return ""
    })
    .filter(Boolean)
    .join(" ")
}

export function getStatusClass(entry: HistoryEntry | EntrySummary): "success" | "error" | "pending" {
  if ("previewText" in entry) {
    if (entry.responseSuccess === undefined) return "pending"
    if (entry.responseSuccess) return "success"
    return "error"
  }
  if (!entry.response) return "pending"
  if (entry.response.success) return "success"
  return "error"
}

export function getMessageSummary(entry: HistoryEntry): string {
  const messages = entry.request.messages ?? []
  const msgCount = messages.length
  const toolCount = messages.filter((m: MessageContent) => {
    if (m.tool_calls && m.tool_calls.length > 0) return true
    if (typeof m.content === "string") return false
    return Array.isArray(m.content) && m.content.some((b: ContentBlock) => b.type === "tool_use")
  }).length
  let summary = `${msgCount} msg`
  if (toolCount > 0) summary += `, ${toolCount} tool`
  return summary
}
