/**
 * web_search-not-found retry strategy (RFC gap C).
 *
 * When a request carries prior-turn `server_tool_use{web_search}` history but the
 * upstream model was NOT provisioned with the native web_search tool (STRICT path
 * — Vertex / partner — validates the whole transcript), it 400s with
 * `Tool 'web_search' not found in provided tools`. This strategy reacts to that
 * 400: learn the model into the negotiation `serverToolHistoryDowngrade` set
 * (persisted), then re-run the S3 sanitize chain on the PRE-S3 baseline
 * (`context.originalPayload`) — `resolveServerToolHistoryMode` now downgrades the
 * server-tool history for the just-learned model, so sanitize rewrites the
 * `server_tool_use{web_search}` turns and the retry ships a clean payload.
 *
 * Re-sanitize arm of the reactive-rejection primitive — structurally identical to
 * system-reject-retry, only the regex + mark function differ. Feeding
 * `context.originalPayload` is a CORRECTNESS hard-constraint (RFC O6): feeding the
 * already-S3 currentPayload would double-apply the whole rewrite chain. Learned
 * reason is logged as an INFERENCE (Vertex is a known-but-not-asserted cause).
 */

import consola from "consola"

import type { AnthropicSanitizeFn } from "~/lib/anthropic/pipeline"
import type { ApiError } from "~/lib/error"
import type { MessagesPayload } from "~/types/api/anthropic"

import { markServerToolHistoryDowngrade } from "~/lib/anthropic/feature-negotiation"
import { HTTPError } from "~/lib/error"
import { createReactiveRejectionStrategy } from "~/lib/request/strategies/reactive-rejection"

import type { RetryStrategy } from "../pipeline"

/**
 * Upstream message for a `web_search` tool-not-provisioned rejection.
 *
 * DISTINCT from the deferred-tool strategy's `Tool reference '…' not found in
 * available tools` (different wording — RFC §1 C vs G): matching that here would
 * make C and G collide. Verified against the RAW `HTTPError.responseText` (the
 * untouched JSON body): single quotes are NOT JSON-escaped, so the raw carrier
 * literally reads `Tool 'web_search' not found in provided tools` — no `\\?`
 * escape guard is needed (unlike system-reject's escaped double-quotes).
 */
const WEB_SEARCH_NOT_IN_TOOLS = /Tool '[^']+' not found in provided tools/i

function extractErrorText(error: ApiError): string | null {
  if (WEB_SEARCH_NOT_IN_TOOLS.test(error.message)) return error.message
  if (error.raw instanceof HTTPError) return error.raw.responseText
  return null
}

export interface WebSearchNotFoundRetryDeps {
  resanitize: AnthropicSanitizeFn
  mark?: (model: string) => void
}

export function createWebSearchNotFoundRetryStrategy<TPayload extends MessagesPayload>(deps: WebSearchNotFoundRetryDeps): RetryStrategy<TPayload> {
  const mark = deps.mark ?? markServerToolHistoryDowngrade
  return createReactiveRejectionStrategy<TPayload>({
    name: "web-search-not-found-retry",
    match: (error) => {
      const text = extractErrorText(error)
      return text !== null && WEB_SEARCH_NOT_IN_TOOLS.test(text) ? "web_search:not-provisioned" : null
    },
    mark: (model) => {
      mark(model)
      consola.info(
        `[WebSearchNotFound] Inferred web_search not in provided tools for ${model} (Vertex is this account's known cause but not asserted); triggering server-tool-history downgrade + re-sanitizing + retrying.`,
      )
    },
    remediate: ({ context }) => {
      // Re-run the S3 chain on the PRE-S3 baseline — resolveServerToolHistoryMode
      // now downgrades server-tool history for the just-learned model. NEVER feed
      // currentPayload (already-S3 → double-apply). Mirrors system-reject-retry.
      const result = deps.resanitize(context.originalPayload)
      return { action: "retry", payload: result.payload as TPayload, meta: { sanitization: result.stats } }
    },
  })
}
