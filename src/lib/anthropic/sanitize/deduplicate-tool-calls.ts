import type { MessageParam } from "~/types/api/anthropic"

import { hasThinkingSignatureBlocks, isImmutableThinkingAssistantMessage } from "../thinking-immutability"

/**
 * Remove duplicate tool_use/tool_result pairs, keeping only the last occurrence
 * of each matching combination.
 */
export function deduplicateToolCalls(
  messages: Array<MessageParam>,
  mode: "input" | "result" = "input",
): {
  messages: Array<MessageParam>
  dedupedCount: number
  dedupedByTool: Record<string, number>
} {
  const toolUseKeys = new Map<string, string>()

  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        const key = `${block.name}:${JSON.stringify(block.input)}`
        toolUseKeys.set(block.id, key)
      }
    }
  }

  if (mode === "result") {
    const resultContentById = new Map<string, string>()
    for (const msg of messages) {
      if (msg.role !== "user" || typeof msg.content === "string") continue
      for (const block of msg.content) {
        if (block.type === "tool_result" && toolUseKeys.has(block.tool_use_id)) {
          const resultStr = typeof block.content === "string" ? block.content : JSON.stringify(block.content)
          resultContentById.set(block.tool_use_id, resultStr)
        }
      }
    }

    for (const [id, baseKey] of toolUseKeys) {
      const resultContent = resultContentById.get(id)
      if (resultContent !== undefined) {
        toolUseKeys.set(id, `${baseKey}::${resultContent}`)
      }
    }
  }

  const keeperIds = new Set<string>()
  const seenKeys = new Set<string>()

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant" || typeof msg.content === "string") continue
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j]
      if (block.type === "tool_use") {
        const key = toolUseKeys.get(block.id)
        if (!key) continue
        if (!seenKeys.has(key)) {
          seenKeys.add(key)
          keeperIds.add(block.id)
        }
      }
    }
  }

  const protectedIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue
    if (!hasThinkingSignatureBlocks(msg)) continue
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        protectedIds.add(block.id)
      }
    }
  }

  const removedIds = new Set<string>()
  for (const [id, key] of toolUseKeys) {
    if (seenKeys.has(key) && !keeperIds.has(id) && !protectedIds.has(id)) {
      removedIds.add(id)
    }
  }

  if (removedIds.size === 0) {
    return { messages, dedupedCount: 0, dedupedByTool: {} }
  }

  const dedupedByTool: Record<string, number> = {}
  for (const id of removedIds) {
    const key = toolUseKeys.get(id)
    if (key) {
      const toolName = key.slice(0, key.indexOf(":"))
      dedupedByTool[toolName] = (dedupedByTool[toolName] ?? 0) + 1
    }
  }

  const filtered: Array<MessageParam> = []
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      filtered.push(msg)
      continue
    }

    if (msg.role === "assistant") {
      const newContent = msg.content.filter((block) => block.type !== "tool_use" || !removedIds.has(block.id))
      if (newContent.length > 0) {
        if (newContent.length === msg.content.length) {
          filtered.push(msg)
        } else {
          filtered.push({ ...msg, content: newContent } as MessageParam)
        }
      }
    } else {
      const newContent = msg.content.filter(
        (block) => block.type !== "tool_result" || !removedIds.has(block.tool_use_id),
      )
      if (newContent.length > 0) {
        if (newContent.length === msg.content.length) {
          filtered.push(msg)
        } else {
          filtered.push({ ...msg, content: newContent } as MessageParam)
        }
      }
    }
  }

  const merged: Array<MessageParam> = []
  for (const msg of filtered) {
    const prev = merged.at(-1)
    if (prev && prev.role === msg.role) {
      if (prev.role === "assistant" && (isImmutableThinkingAssistantMessage(prev) || isImmutableThinkingAssistantMessage(msg))) {
        merged.push(msg)
        continue
      }

      const prevContent =
        typeof prev.content === "string" ? [{ type: "text" as const, text: prev.content }] : prev.content
      const currContent = typeof msg.content === "string" ? [{ type: "text" as const, text: msg.content }] : msg.content
      merged[merged.length - 1] = {
        ...prev,
        content: [...prevContent, ...currContent],
      } as MessageParam
    } else {
      merged.push(msg)
    }
  }

  return { messages: merged, dedupedCount: removedIds.size, dedupedByTool }
}
