/**
 * Server tool block filter for Anthropic SSE streams and non-streaming responses.
 *
 * Always active — matching vscode-copilot-chat behavior, which intercepts
 * server_tool_use and *_tool_result blocks unconditionally. These are server-side
 * artifacts (e.g. tool_search injected by copilot-api, web_search) that clients
 * don't expect and most SDKs can't validate.
 *
 * Also provides logging for server tool blocks (called before filtering,
 * so information is never lost even when blocks are stripped).
 */

import consola from "consola"

import type { StreamEvent } from "~/types/api/anthropic"

import type { AnthropicMessageResponse } from "./client"

// ============================================================================
// Server tool type detection
// ============================================================================

/** Check if a block type is a server-side tool result (ends with _tool_result, but not plain tool_result) */
export function isServerToolResultType(type: string): boolean {
  return type !== "tool_result" && type.endsWith("_tool_result")
}

/**
 * Check if a content block is a server-side tool block.
 * Matches `server_tool_use` (any name) and all server tool result types
 * (web_search_tool_result, tool_search_tool_result, code_execution_tool_result, etc.).
 */
export function isServerToolBlock(block: { type: string }): boolean {
  if (block.type === "server_tool_use") return true
  return isServerToolResultType(block.type)
}

// ============================================================================
// Server tool logging
// ============================================================================

/**
 * Log a single server tool block (server_tool_use or *_tool_result).
 * No-op for non-server-tool blocks — safe to call unconditionally.
 *
 * Called before filtering, so information is never lost even when blocks are stripped.
 */
export function logServerToolBlock(block: Record<string, unknown> & { type: string }) {
  if (block.type === "server_tool_use") {
    consola.debug(`[ServerTool] server_tool_use: ${block.name as string}`)
    return
  }

  if (!isServerToolResultType(block.type)) return

  const content = block.content as Record<string, unknown> | undefined
  if (!content) return

  const contentType = content.type as string | undefined

  // tool_search results: log discovered tool count and names
  if (contentType === "tool_search_tool_search_result") {
    const refs = content.tool_references as Array<{ tool_name?: string }> | undefined
    const toolNames = refs?.map((r) => r.tool_name).filter(Boolean) ?? []
    consola.debug(
      `[ServerTool] tool_search result: discovered ${toolNames.length} tools${toolNames.length > 0 ? ` [${toolNames.join(", ")}]` : ""}`,
    )
  } else if (contentType === "tool_search_tool_result_error") {
    consola.warn(`[ServerTool] tool_search error: ${content.error_code as string}`)
  } else {
    // Generic server tool result (web_search, code_execution, etc.)
    consola.debug(`[ServerTool] ${block.type}: ${contentType ?? "unknown"}`)
  }
}

/**
 * Log all server tool blocks from a non-streaming response content array.
 * Must be called before filterServerToolBlocksFromResponse() to preserve info.
 */
export function logServerToolBlocks(content: Array<Record<string, unknown> & { type: string }>) {
  for (const block of content) {
    logServerToolBlock(block)
  }
}

// ============================================================================
// Stream filter (SSE)
// ============================================================================

/**
 * Filters server tool blocks from the SSE stream before forwarding to the client.
 * Handles index remapping so block indices remain dense/sequential after filtering.
 *
 * Always active — matching vscode-copilot-chat behavior, which intercepts
 * server_tool_use and *_tool_result blocks unconditionally. These are server-side
 * artifacts (e.g. tool_search injected by copilot-api, web_search) that clients
 * don't expect and most SDKs can't validate.
 */
export function createServerToolBlockFilter() {
  const filteredIndices = new Set<number>()
  const clientIndexMap = new Map<number, number>()
  let nextClientIndex = 0

  function getClientIndex(apiIndex: number): number {
    let idx = clientIndexMap.get(apiIndex)
    if (idx === undefined) {
      idx = nextClientIndex++
      clientIndexMap.set(apiIndex, idx)
    }
    return idx
  }

  return {
    /** Returns rewritten data to forward, or null to suppress the event */
    rewriteEvent(parsed: StreamEvent | undefined, rawData: string): string | null {
      if (!parsed) return rawData

      if (parsed.type === "content_block_start") {
        const block = parsed.content_block as { type: string }
        if (isServerToolBlock(block)) {
          filteredIndices.add(parsed.index)
          return null
        }
        if (filteredIndices.size === 0) {
          getClientIndex(parsed.index)
          return rawData
        }
        const clientIndex = getClientIndex(parsed.index)
        if (clientIndex === parsed.index) return rawData
        const obj = JSON.parse(rawData) as Record<string, unknown>
        obj.index = clientIndex
        return JSON.stringify(obj)
      }

      if (parsed.type === "content_block_delta" || parsed.type === "content_block_stop") {
        if (filteredIndices.has(parsed.index)) return null
        if (filteredIndices.size === 0) return rawData
        const clientIndex = getClientIndex(parsed.index)
        if (clientIndex === parsed.index) return rawData
        const obj = JSON.parse(rawData) as Record<string, unknown>
        obj.index = clientIndex
        return JSON.stringify(obj)
      }

      return rawData
    },
  }
}

// ============================================================================
// Non-streaming filter
// ============================================================================

/** Filter server tool blocks from a non-streaming response */
export function filterServerToolBlocksFromResponse(response: AnthropicMessageResponse): AnthropicMessageResponse {
  const filtered = response.content.filter((block: { type: string }) => !isServerToolBlock(block))

  if (filtered.length === response.content.length) return response
  return { ...response, content: filtered }
}
