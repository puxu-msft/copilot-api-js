/**
 * Server-tool rejection retry strategy.
 *
 * GHC's upstream rejects native server tools (e.g. Claude Code's
 * `web_search_20250305`) for models that don't support executing them
 * server-side, with:
 *
 *   HTTP 400 {"error":{"message":"The use of the web search tool is not
 *             supported.","code":"unsupported_value"}}
 *
 * No other retry strategy's `canHandle` matches this (its pattern is mutually
 * exclusive with effort / beta / body-field / deferred-tool). Without this
 * strategy the request fails outright unless the user pre-emptively sets
 * `anthropic.tool_strip_server: true` (an unconditional global opt-in).
 *
 * Reactive self-healing: on the first 400 we fixate the offending server tool
 * type prefix in the negotiation cache (so future same-(endpoint, model)
 * requests pre-emptively strip it on first prep) AND carry an authoritative
 * `PrepareHints.excludeServerToolTypes` so THIS attempt's retry strips it
 * deterministically — independent of the cache read.
 *
 * TABLE-DRIVEN (RFC gap E, O4): the upstream-message → type-prefix mapping is a
 * per-tool table, not a hardcoded regex. Adding a newly-observed server-tool
 * rejection = one data row; the cache structure is already generic per-toolType.
 * Today the table has exactly ONE row — `web_search`, the sole tool with an
 * OBSERVED upstream message. No speculative rows: an unmodelled rejection falls
 * through (canHandle false) rather than silently stripping an unknown tool.
 *
 * Strip arm of the reactive-rejection primitive: the primitive owns
 * parse/mark/canHandle/one-shot; the token IS the matched type prefix. Unlike
 * `unsupported-beta`'s laconic path, the upstream names the tool unambiguously,
 * so fixation happens directly (no probe / no `onResolved` deferral).
 */

import type { ApiError } from "~/lib/error"

import { markAnthropicServerToolUnsupported } from "~/lib/anthropic/feature-negotiation"
import { HTTPError } from "~/lib/error"
import { createReactiveRejectionStrategy } from "~/lib/request/strategies/reactive-rejection"

import type { RetryStrategy } from "../pipeline"

/**
 * Upstream-message pattern → server-tool type prefix to strip. Only tools with
 * an OBSERVED upstream rejection message earn a row (extend by adding a row).
 *
 * REGEX-vs-WIRE: `error.raw.responseText` is the RAW JSON body — patterns are
 * verified against it. The web_search message has no quotes / JSON-escapable
 * chars, so it reads identically in the wrapped `error.message` and the raw
 * `{"error":{"message":"The use of the web search tool is not supported.",…}}`.
 */
const SERVER_TOOL_REJECTION_TABLE: ReadonlyArray<{ pattern: RegExp; typePrefix: string }> = [
  { pattern: /the use of the web search tool is not supported/i, typePrefix: "web_search_" },
]

function extractErrorText(error: ApiError): string | null {
  // The wrapped message sometimes already contains the upstream text (e.g.
  // "HTTP 400: The use of the web search tool is not supported."). Otherwise
  // fall back to the raw HTTPError responseText where the upstream JSON lives.
  if (SERVER_TOOL_REJECTION_TABLE.some((row) => row.pattern.test(error.message))) return error.message
  if (error.raw instanceof HTTPError) return error.raw.responseText
  return null
}

/** Match against the table; returns the type prefix to strip, or null. */
function matchServerToolRejection(error: ApiError): string | null {
  const text = extractErrorText(error)
  if (text === null) return null
  return SERVER_TOOL_REJECTION_TABLE.find((row) => row.pattern.test(text))?.typePrefix ?? null
}

export function createServerToolRejectionStrategy<TPayload extends { model: string }>(): RetryStrategy<TPayload> {
  return createReactiveRejectionStrategy<TPayload>({
    name: "server-tool-rejection-retry",
    match: matchServerToolRejection,
    mark: (model, typePrefix) => markAnthropicServerToolUnsupported(model, typePrefix),
    remediate: ({ payload, token }) => ({
      action: "retry",
      payload,
      prepareHints: { excludeServerToolTypes: [token] },
      meta: { strippedServerTools: [token] },
    }),
  })
}
