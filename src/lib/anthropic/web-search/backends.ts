/**
 * Web search backends for the double-hop web_search implementation.
 *
 * Two backends are supported (chosen by `web_search.backend`):
 *   - Copilot Responses search model — calls Copilot `/responses` (forced
 *     non-streaming HTTP) with a `web_search_preview` server tool and parses
 *     the search result text + query out of the output items.
 *   - Local SearXNG — calls `http://localhost:8080/search?format=json` via the
 *     global fetch (proxy/timeout applied automatically).
 *
 * Both backends return a structured {@link SearchExecutionResult}. Failures are
 * reported as a structured result (empty `results` + actionable `text`), never
 * thrown — so a search outage cannot blow up the main request flow (原则8).
 *
 * Result parsing (markdown link / bare URL extraction + dedup) is ported from
 * the competitor's `parseSearchResults`.
 */

import consola from "consola"
import { randomUUID } from "node:crypto"

import type { ResponsesPayload } from "~/types/api/openai-responses"

import { createFetchSignal } from "~/lib/fetch-utils"
import { createResponses } from "~/lib/openai/responses-client"
import { combineAbortSignals } from "~/lib/stream"

// ============================================================================
// Constants
// ============================================================================

/** Max number of parsed search results returned to the caller. */
export const SEARCH_RESULT_LIMIT = 8

const DEFAULT_SEARXNG_BASE_URL = "http://localhost:8080"
const SEARXNG_READINESS_TIMEOUT_MS = 800
const SEARXNG_TIMEOUT_MS = 10_000

/** Copilot Responses search output token budget bounds. */
const SEARCH_MIN_OUTPUT_TOKENS = 256
const SEARCH_MAX_OUTPUT_TOKENS = 1200

const CONFIG_HINT = 'Set web_search.backend in config.yaml to a Copilot Responses search model id such as "gpt-5.5", or to "searxng".'

// ============================================================================
// Types
// ============================================================================

/** A single web search result. */
export interface SearchResult {
  title: string
  url: string
  snippet?: string
}

/** Result of executing a web search against a backend. */
export interface SearchExecutionResult {
  /** Synthetic message id used as the synthesized response id. */
  id: string
  /** Effective query that was searched (may be refined by the search model). */
  query: string
  /** Parsed structured results (deduped, capped at SEARCH_RESULT_LIMIT). */
  results: Array<SearchResult>
  /** Raw search text (formatted result lines or model output). */
  text: string
  /** Model id reported by the backend (for usage/history attribution). */
  model: string
  /** Search-side input tokens (0 for SearXNG). */
  inputTokens: number
  /** Search-side output tokens (0 for SearXNG). */
  outputTokens: number
  /** Whether the search succeeded (had results or non-empty text). */
  ok: boolean
}

/** Parsed backend selector. */
export type WebSearchBackend = { type: "not-configured" } | { type: "copilot-http"; model: string } | { type: "searxng" }

// ============================================================================
// Backend selection
// ============================================================================

/** Parse the `web_search.backend` string into a discriminated backend. */
export function parseWebSearchBackend(backend: string | undefined): WebSearchBackend {
  const value = backend?.trim()
  if (!value) return { type: "not-configured" }
  if (value.toLowerCase() === "searxng") return { type: "searxng" }
  return { type: "copilot-http", model: value }
}

// ============================================================================
// Result parsing (ported from competitor)
// ============================================================================

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Strip list markers / trailing separators from the text before a URL to derive a title. */
function cleanTitle(line: string, url: string): string {
  const beforeUrl = line.slice(0, line.indexOf(url))
  const cleaned = beforeUrl
    .replace(/^\s*(?:[-*]|\d+[.)])\s*/u, "")
    .replace(/\s*[-–—:|]\s*$/u, "")
    .trim()
  if (cleaned) return cleaned
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * Parse plain/markdown search text into structured results.
 * Extracts markdown links `[title](url)` or bare `https://…` URLs, one per
 * line, deduping by URL and capping at SEARCH_RESULT_LIMIT.
 */
export function parseSearchResults(text: string): Array<SearchResult> {
  const results: Array<SearchResult> = []
  const seenUrls = new Set<string>()

  for (const line of text.split(/\r?\n/u)) {
    const markdownMatch = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/u.exec(line)
    const url = markdownMatch?.[2] ?? /https?:\/\/[^\s)]+/u.exec(line)?.[0]
    if (!url || seenUrls.has(url)) continue

    seenUrls.add(url)
    results.push({
      title: markdownMatch?.[1]?.trim() || cleanTitle(line, url),
      url,
    })

    if (results.length >= SEARCH_RESULT_LIMIT) break
  }

  return results
}

/** Format structured results into a readable text block for the model second hop. */
export function formatSearchResultsText(results: Array<SearchResult>, query: string): string {
  if (results.length === 0) return ""
  return [
    `Web search results for query: "${query}"`,
    "",
    ...results.map((result, index) => {
      const snippet = result.snippet ? `\n   ${result.snippet}` : ""
      return `${index + 1}. ${result.title} - ${result.url}${snippet}`
    }),
  ].join("\n")
}

// ============================================================================
// Failure construction
// ============================================================================

function newMessageId(): string {
  return `msg_${randomUUID().replaceAll("-", "")}`
}

/** Build a structured failed search result (empty results + actionable text). */
function failedSearch(query: string, model: string, message: string): SearchExecutionResult {
  return { id: newMessageId(), query, results: [], text: message, model, inputTokens: 0, outputTokens: 0, ok: false }
}

// ============================================================================
// Copilot Responses search backend
// ============================================================================

/** Output item shapes we care about in the Responses search response (defensive — beyond the typed union). */
interface ResponsesSearchOutputItem {
  type?: string
  action?: { query?: unknown; queries?: unknown }
  content?: unknown
}

/** Extract the search model's chosen query from `web_search_call` output items. */
function extractSearchQuery(output: Array<ResponsesSearchOutputItem>, fallbackQuery: string): string {
  for (const item of output) {
    if (item.type !== "web_search_call") continue
    const action = isRecord(item.action) ? item.action : undefined
    if (typeof action?.query === "string") return action.query
    const queries = Array.isArray(action?.queries) ? action.queries : []
    if (typeof queries[0] === "string") return queries[0]
  }
  return fallbackQuery.slice(0, 200)
}

/** Extract concatenated `output_text` from message output items. */
function extractResponseText(output: Array<ResponsesSearchOutputItem>): string {
  return output
    .flatMap((item) => {
      if (item.type !== "message") return []
      const content = Array.isArray(item.content) ? item.content : []
      return content.flatMap((part) => (isRecord(part) && part.type === "output_text" && typeof part.text === "string" ? [part.text] : []))
    })
    .join("\n")
    .trim()
}

interface SearchBackendInput {
  /** Query the model asked to search for. */
  query: string
  /** Full search instruction text (system + conversation context). */
  searchInput: string
  /** Client-requested max_tokens, used to bound the search output budget. */
  maxOutputTokens?: number | null
  temperature?: number | null
  topP?: number | null
  /** Aborts the search fetch when the downstream client disconnects. */
  clientAbortSignal?: AbortSignal
}

/** Run a search via the Copilot Responses search model (forced non-streaming HTTP). */
async function searchViaCopilotResponses(input: SearchBackendInput, model: string): Promise<SearchExecutionResult> {
  const webSearchTool = { type: "web_search_preview" } as unknown as NonNullable<ResponsesPayload["tools"]>[number]
  const payload: ResponsesPayload = {
    model,
    input: input.searchInput,
    // web_search_preview is the Copilot/OpenAI Responses server-side search tool.
    tools: [webSearchTool],
    stream: false,
    max_output_tokens: Math.max(SEARCH_MIN_OUTPUT_TOKENS, Math.min(input.maxOutputTokens ?? 1024, SEARCH_MAX_OUTPUT_TOKENS)),
    temperature: input.temperature ?? undefined,
    top_p: input.topP ?? undefined,
  }

  let response: Awaited<ReturnType<typeof createResponses>>
  try {
    // stream:false routes through createResponsesViaHttp (WS only used for streaming).
    response = await createResponses(payload, { clientAbortSignal: input.clientAbortSignal })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    consola.warn(`[WebSearch] Copilot Responses search failed for model ${model}: ${detail}`)
    return failedSearch(
      input.query,
      model,
      [`Copilot web search is not available for model ${model}.`, detail ? `Error: ${detail}` : "", CONFIG_HINT].filter(Boolean).join("\n"),
    )
  }

  // Defensive: a non-streaming call must not return an async iterator.
  if (Symbol.asyncIterator in (response as object)) {
    return failedSearch(input.query, model, "Copilot web search returned an unexpected streaming response.")
  }

  const upstream = response as {
    id?: string
    model?: string
    output?: Array<ResponsesSearchOutputItem>
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  const output = Array.isArray(upstream.output) ? upstream.output : []
  const text = extractResponseText(output)
  const query = extractSearchQuery(output, input.query)
  const results = parseSearchResults(text)

  if (results.length === 0 && !text.trim()) {
    return failedSearch(input.query, upstream.model ?? model, "Copilot web search did not return search results.")
  }

  return {
    id: upstream.id ?? newMessageId(),
    query,
    results,
    text,
    model: upstream.model ?? model,
    inputTokens: upstream.usage?.input_tokens ?? 0,
    outputTokens: upstream.usage?.output_tokens ?? 0,
    ok: true,
  }
}

// ============================================================================
// SearXNG search backend
// ============================================================================

function searxngUrl(query: string): URL {
  const url = new URL("/search", DEFAULT_SEARXNG_BASE_URL)
  url.searchParams.set("q", query)
  url.searchParams.set("format", "json")
  return url
}

/** Quick reachability probe so an unreachable SearXNG fails fast with a clear hint. */
async function searxngUnavailableReason(): Promise<string | undefined> {
  const response = await fetch(DEFAULT_SEARXNG_BASE_URL, {
    headers: { accept: "text/html,application/json" },
    signal: AbortSignal.timeout(SEARXNG_READINESS_TIMEOUT_MS),
  }).catch((error: unknown) => error)

  if (response instanceof Response) return undefined
  const detail = response instanceof Error ? response.message : String(response)
  return ["Local SearXNG web search is not available.", detail ? `Error: ${detail}` : ""].filter(Boolean).join("\n")
}

/** Run a search via a local SearXNG instance. */
async function searchViaSearxng(query: string, clientAbortSignal?: AbortSignal): Promise<SearchExecutionResult> {
  const unavailable = await searxngUnavailableReason()
  if (unavailable) {
    return failedSearch(
      query,
      "searxng",
      [unavailable, 'Start SearXNG at http://localhost:8080, or set web_search.backend to a Copilot Responses search model id such as "gpt-5.5".'].join("\n"),
    )
  }

  const response = await fetch(searxngUrl(query), {
    headers: { accept: "application/json" },
    // createFetchSignal applies the configured timeouts.response_header (and proxy via global fetch);
    // fall back to a fixed cap so a hung SearXNG can't stall the request indefinitely.
    // A client disconnect (clientAbortSignal) terminates the search immediately.
    signal: combineAbortSignals(clientAbortSignal, createFetchSignal() ?? AbortSignal.timeout(SEARXNG_TIMEOUT_MS)),
  }).catch((error: unknown) => error)

  if (!(response instanceof Response)) {
    const detail = response instanceof Error ? response.message : String(response)
    return failedSearch(
      query,
      "searxng",
      ["Local SearXNG web search request failed.", detail ? `Error: ${detail}` : "", CONFIG_HINT].filter(Boolean).join("\n"),
    )
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    return failedSearch(
      query,
      "searxng",
      [`Local SearXNG web search failed with HTTP ${response.status}.`, detail ? `Response: ${detail.slice(0, 500)}` : "", CONFIG_HINT]
        .filter(Boolean)
        .join("\n"),
    )
  }

  const data = (await response.json().catch(() => ({}))) as { results?: Array<Record<string, unknown>> }
  const results = (data.results ?? [])
    .flatMap((result): Array<SearchResult> => {
      const title = typeof result.title === "string" ? result.title.trim() : ""
      const url = typeof result.url === "string" ? result.url.trim() : ""
      const snippet = typeof result.content === "string" ? result.content.trim() : undefined
      return title && url ? [{ title, url, snippet }] : []
    })
    .slice(0, SEARCH_RESULT_LIMIT)

  return {
    id: newMessageId(),
    query,
    results,
    text: formatSearchResultsText(results, query),
    model: "searxng",
    inputTokens: 0,
    outputTokens: 0,
    ok: results.length > 0,
  }
}

// ============================================================================
// Public dispatch
// ============================================================================

/**
 * Execute a web search against the configured backend.
 *
 * Never throws — backend failures are returned as a structured result with
 * `ok: false`, empty `results`, and an actionable `text` message.
 */
export async function executeWebSearch(input: SearchBackendInput, backendValue: string | undefined): Promise<SearchExecutionResult> {
  const backend = parseWebSearchBackend(backendValue)
  if (backend.type === "searxng") return searchViaSearxng(input.query, input.clientAbortSignal)
  if (backend.type === "copilot-http") return searchViaCopilotResponses(input, backend.model)
  // not-configured
  return failedSearch(input.query, "web_search", ["Web search backend is not configured.", CONFIG_HINT].join("\n"))
}
