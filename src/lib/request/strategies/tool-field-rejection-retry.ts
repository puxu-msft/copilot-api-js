/**
 * Tool-field rejection retry strategy.
 *
 * GHC's upstream Anthropic API rejects unknown TOP-LEVEL fields on custom tool
 * definitions with:
 *
 *   HTTP 400  tools.0.custom.eager_input_streaming: Extra inputs are not permitted
 *
 * Newer Claude Code attaches `eager_input_streaming` (a client-side tool-input
 * streaming hint) to every tool; the official Anthropic API accepts it but GHC's
 * (older) upstream does not. `stripToolFields`' built-in default already strips
 * `eager_input_streaming` proactively (zero round-trip), so this strategy exists
 * for the GENERAL case: any FUTURE unknown tool field the upstream starts
 * rejecting is learned here, stripped on retry, and fixated (endpoint-wide) so
 * subsequent requests pre-emptively strip it.
 *
 * SAFETY (why no known-safe-strip-target table, unlike server-tool /
 * structured-outputs): "Extra inputs are not permitted" means the upstream does
 * NOT model the field at all — stripping removes something the upstream would
 * ignore even if accepted, so there is no semantic loss. The ONE exception is a
 * field in `LEGIT_TOOL_KEYS`: if the upstream reports a field it DOES model as
 * "extra", that is a variant-misrouting signal (a transform corrupted the tool's
 * discriminator) and must surface as a LOUD 400, not be silently stripped. Such
 * fields are excluded from the parse → the request falls through to a bare 400
 * with a warning (root-cause over patch).
 *
 * MULTI-FIELD (H1): pydantic reports ALL offending fields in one response, but a
 * per-request one-shot retry fires once. We therefore parse EVERY offending
 * field via `matchAll` and strip the whole set in a single retry — otherwise a
 * request introducing two new fields would hard-fail (learn field 1 → retry →
 * rejected for field 2 → one-shot exhausted).
 *
 * MODEL-AGNOSTIC (M1): tool-field rejection is an upstream-version property, not
 * a per-model one, so the learned cache is keyed by endpoint only
 * (`markAnthropicUnsupportedToolFields`) — one 400 immunizes every model.
 *
 * SCOPE — main v4 pipeline only: this reactive strategy is registered in the v4
 * codec pipeline (`codec/anthropic/strategies.ts`), NOT the legacy pipeline that
 * the web_search double-hop still uses (`web-search-direct.ts` /
 * `web-search/orchestrator.ts` → `runAnthropicPipeline`), which by design omits
 * every reactive-rejection strategy (server-tool / structured-outputs too). This
 * is fine in practice: the PROACTIVE strip (`stripToolFields`: built-in default +
 * endpoint-learned cache + config) runs on BOTH paths via `prepareAnthropicRequest`,
 * so `eager_input_streaming` and any already-learned field are stripped on the
 * hop too, and the cache is shared endpoint-wide. The only residual gap is a
 * brand-new unknown field that appears FIRST and ONLY on a web_search hop — it
 * would 400 there without being learned. Deferred as consistent with the legacy
 * hop's simplified pipeline (see docs/todo/deferred-backlog.md).
 *
 * ORDERING: registered BEFORE `body-field-rejection` (which also matches
 * `... : Extra inputs are not permitted`). The body-field regex was tightened to
 * a top-level-only lookbehind so it no longer claims dotted tool paths, but
 * ordering this first is defense-in-depth against that coupling.
 *
 * Hand-written (not `createReactiveRejectionStrategy`) because the primitive's
 * single-token `match`/`mark(model, token)` shape does not fit batch (matchAll)
 * + model-agnostic marking — same reason `structured-outputs-rejection` is
 * hand-written.
 */

import consola from "consola"

import { markAnthropicUnsupportedToolFields } from "~/lib/anthropic/feature-negotiation"
import { LEGIT_TOOL_KEYS } from "~/lib/anthropic/message-tools"
import {
  //
  type ApiError,
  HTTPError,
} from "~/lib/error"

import type {
  //
  RetryAction,
  RetryContext,
  RetryStrategy,
} from "../pipeline"

/**
 * Capture EACH `tools.N.<variant>.<field>: Extra inputs are not permitted`. The
 * `\w+` variant segment tolerates dated/typed discriminators; the capture is a
 * TOP-LEVEL tool field (immediately followed by `:`), so nested paths like
 * `tools.0.custom.input_schema.properties.foo` do NOT match.
 */
const TOOL_FIELD_EXTRA_INPUTS = /tools\.\d+\.\w+\.([a-z_]\w*): Extra inputs are not permitted/gi
/** Non-global twin for a cheap presence test (matchAll needs the global flag). */
const TOOL_FIELD_PRESENT = /tools\.\d+\.\w+\.[a-z_]\w*: Extra inputs are not permitted/i

function extractErrorText(error: ApiError): string | null {
  if (TOOL_FIELD_PRESENT.test(error.message)) return error.message
  if (error.raw instanceof HTTPError) return error.raw.responseText
  return null
}

/**
 * Parse the set of unknown TOP-LEVEL tool fields the upstream rejected, EXCLUDING
 * any field in `LEGIT_TOOL_KEYS` (those signal variant-misrouting, not an unknown
 * field). Returns the deduped field list, or null when this is not a tool-field
 * "Extra inputs" rejection (or every offending field was a legit key).
 */
export function parseRejectedToolFields(error: ApiError): Array<string> | null {
  const text = extractErrorText(error)
  if (text === null) return null
  const fields = new Set<string>()
  let sawLegit = false
  for (const m of text.matchAll(TOOL_FIELD_EXTRA_INPUTS)) {
    const field = m[1]
    if (LEGIT_TOOL_KEYS.has(field)) {
      sawLegit = true
      continue
    }
    fields.add(field)
  }
  if (fields.size === 0) {
    if (sawLegit) {
      consola.warn(
        `[ToolFieldRejection] Upstream rejected a KNOWN tool key as "Extra inputs" — likely a variant-misrouting bug, not an unknown field. `
          + `Leaving the request to fail loudly for investigation: ${text.slice(0, 200)}`,
      )
    }
    return null
  }
  return [...fields]
}

export function createToolFieldRejectionStrategy<TPayload extends { model: string }>(): RetryStrategy<TPayload> {
  // Per-instance one-shot guard. Strategies are built per-request, so this is
  // request-scoped and cannot leak across unrelated requests.
  let attempted = false

  return {
    name: "tool-field-rejection-retry",

    canHandle(error: ApiError): boolean {
      if (error.type !== "bad_request" || error.status !== 400) return false
      if (attempted) return false
      return parseRejectedToolFields(error) !== null
    },

    handle(error: ApiError, currentPayload: TPayload, _context: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      attempted = true
      const fields = parseRejectedToolFields(error)
      // canHandle guarantees non-null; defend defensively.
      if (fields === null) return Promise.resolve({ action: "abort", error })
      // Endpoint-level (model-agnostic) fixation so future requests pre-strip.
      markAnthropicUnsupportedToolFields(fields)
      consola.warn(`[ToolFieldRejection] Upstream rejected unknown tool field(s): ${fields.join(", ")}; stripping and retrying (learned endpoint-wide).`)
      return Promise.resolve({
        action: "retry",
        payload: currentPayload,
        prepareHints: { excludeToolFields: fields },
        meta: { strippedToolFields: fields },
      })
    },
  }
}
