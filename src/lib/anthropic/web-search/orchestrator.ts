/**
 * Double-hop web_search orchestration (Anthropic path only).
 *
 * When a request carries a native web_search server tool (or Claude Code's
 * `WebSearch` tool) and `server_tool_web_search.enabled` is on, this orchestrator:
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
  type AnthropicMessageResponse,
} from "~/lib/anthropic/client"
import {
  //
  type AnthropicSanitizeFn,
  expectNonStreamingResponse,
  runAnthropicPipeline,
} from "~/lib/anthropic/pipeline"
import { sanitizeAnthropicMessages } from "~/lib/anthropic/sanitize"

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

/**
 * Collect signed thinking / redacted_thinking blocks from a response, verbatim.
 *
 * Used by the second hop to inject the model's reasoning blocks into the synthesized
 * web_search response. The signature is self-contained (encrypts the thinking content
 * itself); blocks are echoed byte-for-byte so the upstream still accepts them on the
 * client's next turn. Returns `[]` when no thinking blocks are present (typical when
 * thinking is disabled or the second hop happened not to think).
 */
function collectThinkingBlocks(response: AnthropicMessageResponse): Array<Record<string, unknown>> {
  return (response.content as unknown as Array<Record<string, unknown>>).filter((block) => block.type === "thinking" || block.type === "redacted_thinking")
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
// Main-model call via the shared retry pipeline
// ============================================================================

/** Per-hop context needed to run a hop through the shared Anthropic pipeline. */
interface HopPipelineContext {
  selectedModel: Model | undefined
  clientAnthropicBeta: string | undefined
  clientAbortSignal?: AbortSignal
}

/**
 * Call the main model for one hop through `runAnthropicPipeline`, so each hop
 * gets auto-truncate, network-retry, token-refresh (replacing the old hand-rolled
 * one-shot 401/403 refresh), beta negotiation, and adaptive rate-limiting.
 *
 * `requestContext: undefined` — the hops deliberately do NOT record attempts on
 * the outer request context (that would leave unclosed/empty attempt shells and
 * flap the streaming→executing state machine); the web-search handler owns
 * finalization. Sanitize is the plain `sanitizeAnthropicMessages` (NOT the full
 * preprocessTools pipeline), so the first-hop tool downgrade (native server tool
 * → plain function tool) is not reverted by tool_search re-injection.
 */
async function callMainModel(payload: MessagesPayload, ctx: HopPipelineContext): Promise<AnthropicMessageResponse> {
  const sanitize: AnthropicSanitizeFn = (p) => sanitizeAnthropicMessages(p)
  const result = await runAnthropicPipeline({
    payload,
    originalPayload: payload,
    selectedModel: ctx.selectedModel,
    clientAnthropicBeta: ctx.clientAnthropicBeta,
    sanitize,
    resanitize: sanitize,
    headersCapture: {},
    requestContext: undefined,
    clientAbortSignal: ctx.clientAbortSignal,
  })
  return expectNonStreamingResponse(result)
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
   * letting the (non-streaming) hops run to `timeouts.response_header`.
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
/**
 * Outcome of the first hop ("probe"): the main model's response to the request
 * with web_search downgraded to a plain function tool, plus the decision of
 * whether (and what) to search. Carried into `completeWebSearch` when a search
 * is needed, or used by the caller to route a pass-through (no-search) request
 * back through the normal direct path.
 */
export interface WebSearchProbeResult {
  /** The first-hop main-model response (against the substituted toolset). */
  firstResponse: AnthropicMessageResponse
  /** The web_search tool_use the model chose to act on, or undefined when it did not search. */
  toolUse?: { id: string; query: string }
  /** Total web_search tool_use blocks the first hop emitted (round limit = 1; extras dropped). */
  searchCount: number
}

/**
 * First hop: call the main model with web_search downgraded to a plain function
 * tool so it can decide whether/what to search. Non-streaming. Does NOT touch
 * the outer request context (callMainModel uses `requestContext: undefined`), so
 * the caller can re-dispatch the original request on a no-search outcome.
 */
export async function runFirstHopProbe(args: OrchestrateWebSearchArgs): Promise<WebSearchProbeResult> {
  const { payload, resolvedModel, clientAnthropicBeta, clientAbortSignal } = args

  // Sanitize like the normal path so historical orphan tool blocks don't 400.
  // Take back BOTH messages and system — `merge` mode folds inline system text
  // into the top-level system, so dropping it here would lose that content.
  const firstHopBase: MessagesPayload = {
    ...payload,
    stream: false,
    tools: toFirstHopTools(payload.tools),
  }
  const firstHopSanitized = sanitizeAnthropicMessages(firstHopBase).payload
  const firstHopPayload: MessagesPayload = {
    ...firstHopBase,
    system: firstHopSanitized.system,
    messages: firstHopSanitized.messages,
  }
  const firstResponse = await callMainModel(firstHopPayload, { selectedModel: resolvedModel, clientAnthropicBeta, clientAbortSignal })

  const { first: toolUse, total: searchCount } = findWebSearchToolUse(firstResponse)
  return { firstResponse, toolUse, searchCount }
}

/**
 * Complete the double-hop AFTER a probe that decided to search: run the search,
 * feed results back for a second hop, and synthesize the canonical
 * server_tool_use → web_search_tool_result → text response.
 *
 * Precondition: `probe.toolUse` is defined (the caller handles the no-search
 * pass-through before calling this).
 */
export async function completeWebSearch(args: OrchestrateWebSearchArgs, probe: WebSearchProbeResult): Promise<WebSearchOrchestrationResult> {
  const { payload, resolvedModel, clientAnthropicBeta, backend, clientAbortSignal } = args
  const { firstResponse, toolUse, searchCount } = probe
  if (!toolUse) {
    // Defensive: callers must branch on the pass-through case themselves.
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
  const secondHopSanitized = sanitizeAnthropicMessages({ ...payload, messages: secondHopMessages }).payload
  const secondHopPayload: MessagesPayload = {
    ...payload,
    stream: false,
    // Keep the plain function web_search tool available; the model normally
    // won't search again (round limit = 1) but tool_use references must resolve.
    tools: toFirstHopTools(payload.tools),
    // Take back system too (merge mode folds inline system into it).
    system: secondHopSanitized.system,
    messages: secondHopSanitized.messages,
  }
  const secondResponse = await callMainModel(secondHopPayload, { selectedModel: resolvedModel, clientAnthropicBeta, clientAbortSignal })

  const finalText = collectText(secondResponse) || search.text
  const thinkingBlocks = collectThinkingBlocks(secondResponse)

  // ── Synthesis ─────────────────────────────────────────────────────────────
  const response = buildWebSearchResponse({
    query: toolUse.query,
    results: search.results,
    text: finalText,
    thinking: thinkingBlocks,
    model: payload.model,
    usage: mergeUsage(firstResponse, secondResponse, search),
  })

  return { response, searched: true, search, ...(droppedSearchCount > 0 && { droppedSearchCount }) }
}

/**
 * Run the full double-hop web_search orchestration (thin composition of
 * `runFirstHopProbe` + `completeWebSearch`).
 *
 * Both model hops are forced non-streaming. Throws only on a hard model-call
 * failure (propagated to the caller's catch for `reqCtx.fail`); search failures
 * are absorbed into a structured `web_search_tool_result_error` block.
 */
export async function orchestrateWebSearch(args: OrchestrateWebSearchArgs): Promise<WebSearchOrchestrationResult> {
  const probe = await runFirstHopProbe(args)
  if (!probe.toolUse) {
    // Model answered directly without searching — return the first-hop response.
    consola.debug("[WebSearch] First hop did not request a search; returning direct response")
    return { response: probe.firstResponse, searched: false }
  }
  return completeWebSearch(args, probe)
}
