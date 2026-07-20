/**
 * Rewrite native server-tool blocks in inbound message history (request side).
 *
 * Why this exists — residual `server_tool_use{web_search}` + `web_search_tool_result`
 * pairs in conversation history. GHC's Anthropic endpoint rejects a historical
 * `server_tool_use` block when the request's `tools` array no longer declares that
 * tool as a server tool (400: "`server_tool_use` block references `web_search`, but
 * `web_search` is not defined in `tools` as a server tool"). Such pairs originated
 * from the web_search double-hop (retired 2026-07-13); the rewriter is kept for two
 * live consumers that route residual/echoed server-tool blocks through it:
 *   - the reactive per-model learned downgrade (`resolveServerToolMode`), and
 *   - the always-on empty-encrypted fallback (`empty-encrypted-search-result.ts`).
 *
 * It runs inside `sanitizeAnthropicMessages` (before `processToolBlocks`), so all
 * Anthropic wire paths are covered by one hook. History's `inboundRequest` keeps
 * the unmodified client form — only the wire payload is rewritten.
 *
 * ── Critical protocol constraint ──────────────────────────────────────────
 * `tool_result` MUST live in a `user` message (it is the standard user-side tool
 * result; see types/api/anthropic.ts). A synthesized web_search turn carries all
 * blocks in ONE assistant message, so an in-place downgrade would produce an
 * assistant-role `tool_result` — swapping one 400 for another. Therefore
 * "downgrade" SPLITS the message: the `tool_use` (and any text/thinking) stays on
 * the assistant turn, and every paired `*_tool_result` moves to a new `user` turn
 * inserted immediately after.
 *
 * Matching is by block TYPE (`server_tool_use` / `*_tool_result`), not by tool
 * name, so web_search, web_fetch, code_execution, etc. are all covered uniformly.
 */

import type {
  //
  ContentBlockParam,
  MessageParam,
} from "~/types/api/anthropic"

import { isServerToolResultType } from "../server-tool-filter"

/** Rewrite mode. Currently only `"downgrade"`; the union keeps room for future modes (e.g. `"strip"`). */
export type RewriteServerToolMode = false | "downgrade"

export interface RewriteServerToolResult {
  messages: Array<MessageParam>
  /** Number of server_tool_use blocks rewritten into plain tool_use. */
  rewroteCount: number
}

/** A web_search_result item as carried on a synthesized web_search_tool_result block. */
interface WebSearchResultItem {
  title?: unknown
  url?: unknown
}

/** Structured server-tool-result error shape (e.g. `{type:"web_search_tool_result_error", error_code}`). */
interface ServerToolResultError {
  error_code?: unknown
}

/**
 * Render a server-tool-result `content` field into a plain text string for the
 * downgraded `tool_result`.
 *
 * History carries the synthesize.ts product shape — an array of
 * `{type:"web_search_result", title, url, ...}` items (no snippet) — NOT the
 * `SearchResult[]` shape `formatSearchResultsText` expects, so we rebuild the
 * text here from `{title, url}`. The `query` prefix mirrors
 * `backends.formatSearchResultsText` so the model recognizes this as a past
 * search snapshot rather than a fresh tool output.
 */
function stringifyServerToolResultContent(content: unknown, query: string | undefined): { text: string; isError: boolean } {
  if (typeof content === "string") return { text: content, isError: false }

  // Error-shaped result: { type: "*_tool_result_error", error_code }
  if (typeof content === "object" && content !== null && !Array.isArray(content)) {
    const err = content as ServerToolResultError
    const code = typeof err.error_code === "string" ? err.error_code : "unknown"
    return { text: `Web search failed: ${code}`, isError: true }
  }

  if (Array.isArray(content)) {
    const lines = (content as Array<WebSearchResultItem>)
      .map((item, index) => {
        const title = typeof item.title === "string" ? item.title : ""
        const url = typeof item.url === "string" ? item.url : ""
        if (!title && !url) return ""
        return `${index + 1}. ${title}${title && url ? " - " : ""}${url}`
      })
      .filter(Boolean)
    const header = query ? `Web search results for query: "${query}"` : "Web search results"
    return { text: lines.length > 0 ? [header, "", ...lines].join("\n") : header, isError: false }
  }

  return { text: "Web search did not return search results.", isError: false }
}

/** Whether a block is a server_tool_use (any tool name). */
function isServerToolUse(block: { type: string }): boolean {
  return block.type === "server_tool_use"
}

/** Whether a block is a server-tool-result (`*_tool_result`, excluding plain `tool_result`). */
function isServerToolResult(block: { type: string }): boolean {
  return isServerToolResultType(block.type)
}

/**
 * Rewrite native server-tool blocks in message history.
 *
 * `mode === false` → identity no-op (returns the same array reference).
 * `mode === "downgrade"` → server_tool_use → tool_use (id preserved); each paired
 * `*_tool_result` is converted to a user-side `tool_result` and moved into a new
 * user message inserted right after the assistant turn.
 *
 * Never mutates the input.
 */
export function rewriteServerToolBlocks(messages: Array<MessageParam>, mode: RewriteServerToolMode): RewriteServerToolResult {
  if (mode === false) return { messages, rewroteCount: 0 }

  const result: Array<MessageParam> = []
  let rewroteCount = 0
  let changed = false

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push(msg)
      continue
    }

    // user-side messages: a server-tool-result with no surviving use is downgraded
    // in place to a plain tool_result (it stays on the user turn).
    if (msg.role !== "assistant") {
      if (!msg.content.some((block) => isServerToolResult(block))) {
        result.push(msg)
        continue
      }
      changed = true
      const newContent = msg.content.map((block) => (isServerToolResult(block) ? toToolResult(block) : block))
      result.push({ ...msg, content: newContent } as MessageParam)
      continue
    }

    const hasServerTool = msg.content.some((b) => isServerToolUse(b) || isServerToolResult(b))
    if (!hasServerTool) {
      result.push(msg)
      continue
    }

    // Map server_tool_use.id → its query, so the extracted tool_result text can
    // carry the originating query prefix.
    const queryById = new Map<string, string | undefined>()
    for (const block of msg.content) {
      if (isServerToolUse(block)) {
        const b = block as unknown as { id?: string; input?: unknown }
        if (typeof b.id === "string") queryById.set(b.id, extractQuery(b.input))
      }
    }

    const assistantContent: Array<ContentBlockParam> = []
    const extractedToolResults: Array<ContentBlockParam> = []

    for (const block of msg.content) {
      if (isServerToolUse(block)) {
        rewroteCount++
        changed = true
        assistantContent.push(toToolUse(block))
      } else if (isServerToolResult(block)) {
        changed = true
        const tuId = (block as unknown as { tool_use_id?: string }).tool_use_id
        extractedToolResults.push(toToolResult(block, queryById.get(tuId ?? "")))
      } else {
        assistantContent.push(block)
      }
    }

    // Assistant keeps tool_use + text/thinking; tool_results move to a new user turn.
    if (assistantContent.length > 0) result.push({ ...msg, content: assistantContent } as MessageParam)
    if (extractedToolResults.length > 0) result.push({ role: "user", content: extractedToolResults } as MessageParam)
  }

  return { messages: changed ? result : messages, rewroteCount }
}

/** Convert a server_tool_use block to a plain tool_use (id/name/input preserved verbatim). */
function toToolUse(block: ContentBlockParam): ContentBlockParam {
  const b = block as unknown as { id?: string; name?: string; input?: unknown }
  return { type: "tool_use", id: b.id, name: b.name, input: b.input } as unknown as ContentBlockParam
}

/** Convert a server-tool-result block to a user-side tool_result with stringified content. */
function toToolResult(block: ContentBlockParam, query?: string): ContentBlockParam {
  const b = block as unknown as { tool_use_id?: string; content?: unknown }
  const { text, isError } = stringifyServerToolResultContent(b.content, query)
  const result: Record<string, unknown> = { type: "tool_result", tool_use_id: b.tool_use_id, content: text }
  if (isError) result.is_error = true
  return result as unknown as ContentBlockParam
}

/** Pull a `query` string out of a tool_use input (object or stringified JSON). */
function extractQuery(input: unknown): string | undefined {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown
      return queryFromObject(parsed)
    } catch {
      return undefined
    }
  }
  return queryFromObject(input)
}

function queryFromObject(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const query = (value as Record<string, unknown>).query
  return typeof query === "string" && query.trim() ? query.trim() : undefined
}
