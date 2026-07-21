/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 4 — REST cutover. Forwards a search request to the independent
 * history-search sidecar SERVICE over its UDS client (`getHistorySearchClient()`,
 * state.ts), which never throws — a down/absent/crashed sidecar degrades this
 * function to an empty, `partial: true` result rather than propagating any
 * failure (the whole point of the out-of-process architecture, Phase 3′).
 *
 * **`source` is narrowed to `inbound` only** (user-approved scope cut, plan
 * Phase 4 note): the sidecar's Tantivy projection (`projectSearchableText`,
 * v3/projection.ts) indexes ONLY the client-facing conversation + response —
 * it has no facet for `rewrites-req`/`rewrites-resp`/`req-headers`/
 * `resp-headers` (those were flat per-request SQL columns in the retired
 * embedded-search engine, never carried into the sidecar's schema). Querying
 * any other facet returns an empty, `partial: true` result — `partial` here
 * means "this facet is not supported yet", not "no sidecar" and not "no
 * matches"; see docs/todo/deferred-backlog.md for what expanding the other 4
 * facets would require.
 *
 * **No pagination** (`nextCursor` is always `null`): the sidecar's native
 * search (`search_blocking`, native/history-search/src/lib.rs) is a single
 * top-N-by-score query — Tantivy's own ranking has no stable keyset to page
 * through, unlike the retired embedded search's `(started_at, id)` cursor.
 * See docs/todo/deferred-backlog.md.
 */

import type { SearchParams } from "./search-types"
import type {
  //
  EntrySummary,
  SearchResult,
  SearchResultRow,
} from "./types"

import { getSummary } from "./queries"
import { getHistorySearchClient } from "./state"

/** Sidecar-served facet — the ONLY source the Tantivy projection can answer (see
 *  module doc). Every other `SearchSource` value degrades to empty + `partial`. */
const SIDECAR_SERVED_SOURCE = "inbound"

/** Default page size, mirrors the retired embedded search's default. */
const DEFAULT_LIMIT = 30

/** `{rows:[], nextCursor:null, partial:true}` — the shared "sidecar cannot answer
 *  this request" shape (absent client or unsupported facet). `partial: true` is
 *  the honest signal that the search space was not exhaustively covered, NOT
 *  that zero results happen to be correct — see module doc. */
function emptyPartialResult(): SearchResult {
  return { rows: [], nextCursor: null, partial: true }
}

export async function searchHistory(params: SearchParams): Promise<SearchResult> {
  if (params.source !== SIDECAR_SERVED_SOURCE) return emptyPartialResult()

  const client = getHistorySearchClient()
  if (!client) return emptyPartialResult()

  const limit = params.limit && params.limit > 0 ? params.limit : DEFAULT_LIMIT
  const operationKind = params.filters?.operationKind ?? "generation"
  // `query()` never throws (uds-client.ts's never-throw contract) — a down/
  // absent/crashed sidecar resolves to `[]` here, which would then read as a
  // (misleading) `partial: false` empty result below if we didn't special-case
  // it — but there is no reliable "was the sidecar actually reachable" signal
  // from `query()` alone (that is deliberately `pingHistorySearchUdsClient`'s
  // job, not this one's). A `client` object existing at all only proves History
  // itself is enabled, not that the sidecar process is currently up — so an
  // empty `hits` array here is reported the same honest way the "no client"
  // branch above is: `partial: true`, since this function cannot distinguish
  // "genuinely zero matches" from "sidecar unreachable" without paying for a
  // second round-trip (a reachability probe) on every search request.
  const hits = await client.query(params.q, operationKind === "all" ? undefined : operationKind, limit)
  if (hits.length === 0) return emptyPartialResult()

  const rows: Array<SearchResultRow> = []
  for (const hit of hits) {
    // A hit's operation may have been reaped/evicted from History's own store
    // since the sidecar indexed it (the sidecar's index and History's row
    // retention are independent lifecycles) — skip rather than surface a
    // half-populated row; richest-data-flow does not apply to a search hit that
    // no longer has an owning record to describe.
    const summary: EntrySummary | undefined = getSummary(hit.operationId)
    if (!summary) continue
    rows.push({
      source: params.source,
      ownerReqId: hit.operationId,
      // The sidecar's wire response is `{operationId, createdAt, score}` only —
      // no snippet/offset data (unlike the retired embedded search's SQL LIKE,
      // which could center a window on the literal match). Tantivy's
      // `search_blocking` (native/history-search/src/lib.rs) does not return
      // match offsets/highlights, so there is no true match-centered snippet
      // to carry here — the summary's own preview text is the closest
      // available substitute.
      snippet: summary.previewText,
      summary,
    })
  }

  return { rows, nextCursor: null, partial: false }
}

export function searchContains(_hash: string): Array<string> {
  // The sidecar's Tantivy projection has no reverse hash->operation-id lookup
  // (that was a `v3_tracks.refs_json LIKE` scan in the retired embedded search,
  // over a column the sidecar's schema does not carry — see native/history-
  // search/src/lib.rs's schema: operation_id/operation_kind/content/created_at
  // only). Out of Phase 4 scope; retained as a stable compatibility surface.
  return []
}
