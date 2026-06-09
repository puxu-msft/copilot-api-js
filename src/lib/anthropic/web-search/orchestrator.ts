/**
 * Double-hop web_search orchestration (Anthropic path only).
 *
 * When a request carries a native web_search server tool (or Claude Code's
 * `WebSearch` tool) and `web_search.enabled` is on, this orchestrator:
 *
 *   1. First hop — replaces the native web_search server tool with a plain
 *      function tool `web_search(query)` and calls the MAIN model (non-streaming)
 *      so it can decide whether (and what) to search.
 *   2. Search — runs the chosen query against the configured backend.
 *   3. Second hop — appends the assistant tool_use + a user tool_result carrying
 *      the search results, then calls the MAIN model again to produce the final
 *      answer text.
 *   4. Synthesis — assembles a standard Anthropic response with the canonical
 *      server_tool_use → web_search_tool_result → text block sequence.
 *
 * Round limit v1 = 1 (one search → one generation). Both model hops go through
 * `callMainModel`, which wraps `createAnthropicMessages` with a one-shot
 * token-refresh on 401/403 (the same refresh the pipeline's token-refresh
 * strategy uses) so an expired Copilot token does not hard-fail the hop. The
 * search is an independent sub-request.
 *
 * Known v1 limitation: the hops do NOT run through `executeRequestPipeline`, so
 * they lack adaptive rate-limiting, network-retry, and auto-truncate. See
 * docs/2606-bridge-features/design.md (Phase 4, deferred items) for the rationale
 * and the path to full pipeline reuse.
 *
 * If the first hop does NOT call web_search, the first-hop response is returned
 * as-is (no synthesis) — the model answered directly.
 */

import consola from "consola"

import type { Model } from "~/lib/models/client"
import type {
  //
  MessageParam,
  MessagesPayload,
  Tool,
} from "~/types/api/anthropic"

import {
  //
  createAnthropicMessages,
  type AnthropicMessageResponse,
  type CreateAnthropicMessagesOptions,
} from "~/lib/anthropic/client"
import { sanitizeAnthropicMessages } from "~/lib/anthropic/sanitize"
import { HTTPError } from "~/lib/error"
import { getCopilotTokenManager } from "~/lib/token"

import type { SearchExecutionResult } from "./backends"

import { executeWebSearch } from "./backends"
import { isWebSearchTool } from "./detect"
import {
  //
  buildWebSearchResponse,
  formatSearchResultsText,
} from "./synthesize"

// ============================================================================
// Constants
// ============================================================================

/** input_schema for the plain function `web_search` tool used on the first hop. */
const WEB_SEARCH_FUNCTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { query: { type: "string", description: "The web search query." } },
  required: ["query"],
}

// ============================================================================
// Result type
// ============================================================================

/** Outcome of the double-hop orchestration. */
export interface WebSearchOrchestrationResult {
  /** Synthesized (or pass-through) response to return to the client. */
  response: AnthropicMessageResponse
  /** True when a real search was performed and the response was synthesized. */
  searched: boolean
  /** The search sub-request result (for history recording); undefined when no search ran. */
  search?: SearchExecutionResult
  /**
   * Number of web_search tool_use blocks the first hop emitted beyond the one
   * acted on (round limit = 1). Non-zero means extra searches were dropped — the
   * caller surfaces this as a history warning so the truncation is observable.
   */
  droppedSearchCount?: number
}

// ============================================================================
// First-hop payload construction
// ============================================================================

/** Replace native web_search server tools with a plain function `web_search` tool. */
function toFirstHopTools(tools: Array<Tool> | undefined): Array<Tool> | undefined {
  if (!tools) return undefined
  return tools.map((tool) =>
    isWebSearchTool(tool) ?
      ({ name: "web_search", description: "Search the web for up-to-date information.", input_schema: WEB_SEARCH_FUNCTION_SCHEMA } satisfies Tool)
    : tool,
  )
}

/**
 * Extract `web_search` tool_use blocks from a first-hop response. Returns the
 * first usable one (id + non-empty query) plus the total count of web_search
 * tool_use blocks seen — the round limit is 1, so the orchestrator warns when
 * `total > 1` rather than silently dropping the extras (原则3).
 */
function findWebSearchToolUse(response: AnthropicMessageResponse): { first?: { id: string; query: string }; total: number } {
  let first: { id: string; query: string } | undefined
  let total = 0
  for (const block of response.content as unknown as Array<Record<string, unknown>>) {
    if (block.type !== "tool_use" || block.name !== "web_search") continue
    total++
    if (first) continue
    const id = typeof block.id === "string" ? block.id : ""
    const query = extractQuery(block.input)
    if (id && query) first = { id, query }
  }
  return { first, total }
}

/** Pull a non-empty `query` string out of a tool_use input (object or stringified JSON). */
function extractQuery(input: unknown): string | undefined {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown
      return extractQueryFromObject(parsed) ?? (input.trim() || undefined)
    } catch {
      return input.trim() || undefined
    }
  }
  return extractQueryFromObject(input)
}

function extractQueryFromObject(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const query = (value as Record<string, unknown>).query
  return typeof query === "string" && query.trim() ? query.trim() : undefined
}

// ============================================================================
// Search instruction text
// ============================================================================

/** Flatten a message's content into plain text for the search-model context. */
function textFromContent(content: MessageParam["content"]): string {
  if (typeof content === "string") return content
  return content
    .flatMap((block) => {
      if (block.type === "text") return [block.text]
      if (block.type === "tool_result") {
        const c = (block as { content?: unknown }).content
        if (typeof c === "string") return [c]
      }
      return []
    })
    .join("\n\n")
}

/** Flatten the payload's system prompt into plain text. */
function systemToText(system: MessagesPayload["system"]): string {
  if (typeof system === "string") return system
  if (Array.isArray(system)) return system.map((block) => block.text).join("\n\n")
  return ""
}

/** Build the search instruction text passed to the Copilot Responses search model. */
function buildSearchInput(payload: MessagesPayload, query: string): string {
  const systemText = systemToText(payload.system)

  const conversation = payload.messages.map((message) => `${message.role}: ${textFromContent(message.content)}`).join("\n\n")

  return [
    "You are fulfilling an Anthropic web_search server tool request for Claude Code.",
    "Search the web using the provided web_search_preview tool.",
    `Requested web search query: ${query}`,
    "Return useful search results as plain text lines in this exact shape:",
    "1. Title - https://example.com/page",
    "Include only real source URLs from the search results.",
    systemText ? `System context:\n${systemText}` : "",
    `Conversation:\n${conversation}`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

// ============================================================================
// Second-hop payload construction
// ============================================================================

/** Append the assistant tool_use + a user tool_result with the search results. */
function buildSecondHopMessages(messages: Array<MessageParam>, toolUseId: string, query: string, search: SearchExecutionResult): Array<MessageParam> {
  const resultText = formatSearchResultsText(search.results, query) || search.text || "Web search did not return search results."

  const assistantTurn: MessageParam = {
    role: "assistant",
    content: [{ type: "tool_use", id: toolUseId, name: "web_search", input: { query } }] as unknown as MessageParam["content"],
  }
  const userTurn: MessageParam = {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content: resultText }] as unknown as MessageParam["content"],
  }
  return [...messages, assistantTurn, userTurn]
}

/** Collect non-empty text from a response's content blocks. */
function collectText(response: AnthropicMessageResponse): string {
  return (response.content as unknown as Array<Record<string, unknown>>)
    .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("")
    .trim()
}

// ============================================================================
// Usage merging
// ============================================================================

interface ResponseUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/** Merge usage across the two model hops + the search sub-request. */
function mergeUsage(first: AnthropicMessageResponse, second: AnthropicMessageResponse | undefined, search: SearchExecutionResult) {
  const u1 = first.usage as unknown as ResponseUsage
  const u2 = (second?.usage ?? {}) as ResponseUsage
  const cacheRead = (u1.cache_read_input_tokens ?? 0) + (u2.cache_read_input_tokens ?? 0)
  const cacheCreation = (u1.cache_creation_input_tokens ?? 0) + (u2.cache_creation_input_tokens ?? 0)
  return {
    input_tokens: (u1.input_tokens ?? 0) + (u2.input_tokens ?? 0) + search.inputTokens,
    output_tokens: (u1.output_tokens ?? 0) + (u2.output_tokens ?? 0) + search.outputTokens,
    ...(cacheRead > 0 && { cache_read_input_tokens: cacheRead }),
    ...(cacheCreation > 0 && { cache_creation_input_tokens: cacheCreation }),
  }
}

// ============================================================================
// Main-model call with one-shot token refresh
// ============================================================================

/**
 * Call the main model, refreshing the Copilot token once on a 401/403 and
 * retrying — mirroring the pipeline's token-refresh strategy, which the hops
 * would otherwise miss (they don't run through `executeRequestPipeline`).
 */
async function callMainModel(payload: MessagesPayload, opts: CreateAnthropicMessagesOptions): Promise<AnthropicMessageResponse> {
  try {
    return (await createAnthropicMessages(payload, opts)) as AnthropicMessageResponse
  } catch (error) {
    if (!(error instanceof HTTPError) || (error.status !== 401 && error.status !== 403)) throw error
    const manager = getCopilotTokenManager()
    const refreshed = manager ? await manager.refresh() : null
    if (refreshed === null) throw error
    consola.debug("[WebSearch] Refreshed Copilot token after 401/403, retrying hop")
    return (await createAnthropicMessages(payload, opts)) as AnthropicMessageResponse
  }
}

// ============================================================================
// Orchestration
// ============================================================================

export interface OrchestrateWebSearchArgs {
  /** The sanitized/preprocessed Anthropic payload (post model-resolution). */
  payload: MessagesPayload
  /** Resolved model record (for header/billing context), if known. */
  resolvedModel: Model | undefined
  /** Client-sent anthropic-beta header, forwarded into both hops. */
  clientAnthropicBeta?: string
  /** Configured search backend value (`web_search.backend`). */
  backend: string | undefined
  /**
   * Aborts when the downstream client disconnects. Threaded into both model
   * hops and the search so a client cancel terminates upstream work instead of
   * letting the (non-streaming) hops run to `fetch_timeout`.
   */
  clientAbortSignal?: AbortSignal
}

/**
 * Run the double-hop web_search orchestration.
 *
 * Both model hops are forced non-streaming. Throws only on a hard model-call
 * failure (propagated to the caller's catch for `reqCtx.fail`); search failures
 * are absorbed into a structured `web_search_tool_result_error` block.
 */
export async function orchestrateWebSearch(args: OrchestrateWebSearchArgs): Promise<WebSearchOrchestrationResult> {
  const { payload, resolvedModel, clientAnthropicBeta, backend, clientAbortSignal } = args

  // ── First hop: let the main model decide whether/what to search ──────────
  // Sanitize like the normal path so historical orphan tool blocks don't 400.
  const firstHopBase: MessagesPayload = {
    ...payload,
    stream: false,
    tools: toFirstHopTools(payload.tools),
  }
  const firstHopPayload: MessagesPayload = {
    ...firstHopBase,
    messages: sanitizeAnthropicMessages(firstHopBase).payload.messages,
  }
  const firstResponse = await callMainModel(firstHopPayload, { resolvedModel, clientAnthropicBeta, clientAbortSignal })

  const { first: toolUse, total: searchCount } = findWebSearchToolUse(firstResponse)
  if (!toolUse) {
    // Model answered directly without searching — return the first-hop response.
    consola.debug("[WebSearch] First hop did not request a search; returning direct response")
    return { response: firstResponse, searched: false }
  }
  const droppedSearchCount = Math.max(0, searchCount - 1)
  if (droppedSearchCount > 0) {
    consola.warn(`[WebSearch] First hop requested ${searchCount} searches; round limit is 1, dropping ${droppedSearchCount} (v1 limitation)`)
  }

  // ── Search ───────────────────────────────────────────────────────────────
  consola.debug(`[WebSearch] First hop requested search: "${toolUse.query}" (backend: ${backend || "<none>"})`)
  const search = await executeWebSearch(
    {
      query: toolUse.query,
      searchInput: buildSearchInput(payload, toolUse.query),
      maxOutputTokens: payload.max_tokens,
      temperature: payload.temperature,
      topP: payload.top_p,
      clientAbortSignal,
    },
    backend,
  )
  if (!search.ok) {
    consola.warn(`[WebSearch] Search failed: ${search.text.split("\n")[0]}`)
  }

  // ── Second hop: feed results back for the final answer ───────────────────
  const secondHopMessages = buildSecondHopMessages(payload.messages, toolUse.id, toolUse.query, search)
  const secondHopPayload: MessagesPayload = {
    ...payload,
    stream: false,
    // Keep the plain function web_search tool available; the model normally
    // won't search again (round limit = 1) but tool_use references must resolve.
    tools: toFirstHopTools(payload.tools),
    messages: sanitizeAnthropicMessages({ ...payload, messages: secondHopMessages }).payload.messages,
  }
  const secondResponse = await callMainModel(secondHopPayload, { resolvedModel, clientAnthropicBeta, clientAbortSignal })

  const finalText = collectText(secondResponse) || search.text

  // ── Synthesis ─────────────────────────────────────────────────────────────
  const response = buildWebSearchResponse({
    query: toolUse.query,
    results: search.results,
    text: finalText,
    model: payload.model,
    usage: mergeUsage(firstResponse, secondResponse, search),
  })

  return { response, searched: true, search, ...(droppedSearchCount > 0 && { droppedSearchCount }) }
}
