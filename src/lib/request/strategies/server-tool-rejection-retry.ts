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
 * `anthropic.strip_server_tools: true` (an unconditional global opt-in).
 *
 * Reactive self-healing: on the first 400 we fixate the offending server tool
 * type prefix in the negotiation cache (so future same-(endpoint, model)
 * requests pre-emptively strip it on first prep) AND carry an authoritative
 * `PrepareHints.excludeServerToolTypes` so THIS attempt's retry strips it
 * deterministically — independent of the cache read.
 *
 * Scope: only `web_search` is covered (the sole tool with an observed upstream
 * message). The cache structure is generic per-toolType, so extending to
 * `web_fetch` etc. later only needs another pattern + prefix here.
 *
 * Unlike `unsupported-beta`'s laconic path, the upstream names the tool
 * unambiguously, so fixation happens directly in `handle` (no probe / no
 * `onResolved` deferral).
 */

import type { ApiError } from "~/lib/error"

import { markAnthropicServerToolUnsupported } from "~/lib/anthropic/feature-negotiation"
import { HTTPError } from "~/lib/error"

import type {
  //
  RetryAction,
  RetryContext,
  RetryStrategy,
} from "../pipeline"

/** Upstream message for an unsupported native web_search server tool. */
const WEB_SEARCH_NOT_SUPPORTED = /the use of the web search tool is not supported/i

/** The server tool type prefix to strip when web_search is rejected. */
const WEB_SEARCH_TYPE_PREFIX = "web_search_"

function extractErrorText(error: ApiError): string | null {
  // The wrapped message sometimes already contains the upstream text (e.g.
  // "HTTP 400: The use of the web search tool is not supported."). Otherwise
  // fall back to the raw HTTPError responseText where the upstream JSON lives.
  if (WEB_SEARCH_NOT_SUPPORTED.test(error.message)) return error.message
  if (error.raw instanceof HTTPError) return error.raw.responseText
  return null
}

export function createServerToolRejectionStrategy<TPayload extends { model: string }>(): RetryStrategy<TPayload> {
  // Per-instance one-shot guard. Strategies are built per-request (see
  // buildAnthropicStrategies), so this is request-scoped and cannot leak across
  // unrelated requests. Defense-in-depth alongside the idempotent cache mark.
  let attempted = false

  return {
    name: "server-tool-rejection-retry",

    canHandle(error: ApiError): boolean {
      if (error.type !== "bad_request" || error.status !== 400) return false
      if (attempted) return false
      const text = extractErrorText(error)
      return text !== null && WEB_SEARCH_NOT_SUPPORTED.test(text)
    },

    handle(_error: ApiError, currentPayload: TPayload, _context: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      attempted = true
      markAnthropicServerToolUnsupported(currentPayload.model, WEB_SEARCH_TYPE_PREFIX)
      return Promise.resolve({
        action: "retry",
        payload: currentPayload,
        prepareHints: { excludeServerToolTypes: [WEB_SEARCH_TYPE_PREFIX] },
        meta: { strippedServerTools: [WEB_SEARCH_TYPE_PREFIX] },
      })
    },
  }
}
