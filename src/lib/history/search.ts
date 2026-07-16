/**
 * Public dedicated-search API (RFC P2). Wraps the SQL search facets with the
 * completion-flag gating: until the background backfill finishes, `inbound`
 * results cover only already-built rows and the response is flagged `partial`
 * with a rough `builtPct`. The list read path (queries.ts) is SEPARATE — it does
 * a fast `preview_text` filter and is NOT gated.
 */

import type {
  //
  QueryOptions,
  SearchResult,
  SearchResultRow,
  SearchSource,
} from "./types"

import { getArchiveDb } from "./sqlite/archive-db"
import { getDatabase } from "./sqlite/connection"
import { isSearchIndexComplete } from "./sqlite/meta"
import {
  //
  containingReqIds as containingReqIdsQuery,
  nextSearchCursor,
  searchAux,
  searchInbound,
} from "./sqlite/search-query"

const DEFAULT_LIMIT = 30

export interface SearchParams {
  source: SearchSource
  q: string
  limit?: number
  cursor?: string
  filters?: QueryOptions
}

/** Fraction (0–1) of terminal entries that already have an inbound index built. */
function computeBuiltPct(): number {
  const db = getDatabase()
  const total = (db.prepare("SELECT COUNT(*) AS n FROM entries_v2").get() as { n: number }).n
  if (total === 0) return 1
  const built = (db.prepare("SELECT COUNT(DISTINCT req_id) AS n FROM req_msg").get() as { n: number }).n
  return Math.min(1, built / total)
}

/** Run a dedicated search over one facet, with backfill-progress gating for `inbound`. */
export function searchHistory(params: SearchParams): SearchResult {
  // View-domain split (spec §4): `tier="archive"` searches the archive.db content
  // index (its own msg_blob / req_msg / req_aux / entries_v2); default = HOT. The
  // SAME facet SQL runs against either connection (identical schema), and summaries
  // are loaded from the SAME db so an archive hit resolves an archive summary.
  const db = params.filters?.tier === "archive" ? getArchiveDb() : getDatabase()
  const limit = params.limit && params.limit > 0 ? params.limit : DEFAULT_LIMIT
  const q = params.q

  let rows: Array<SearchResultRow>
  if (params.source === "inbound") {
    rows = q.length === 0 ? [] : searchInbound(db, q, params.filters, params.cursor, limit)
  } else {
    rows = q.length === 0 ? [] : searchAux(db, params.source, q, params.filters, params.cursor, limit)
  }

  const complete = isSearchIndexComplete(db)
  // Only `inbound` is content-addressed and thus affected by partial backfill; the
  // aux facets are written at finalize for new rows and (re)built by the backfill,
  // but the partial hint is most meaningful for the inbound corpus.
  const partial = !complete && params.source === "inbound"
  return {
    rows,
    nextCursor: nextSearchCursor(rows, limit),
    partial,
    ...(partial ? { builtPct: computeBuiltPct() } : {}),
  }
}

/** Lazy companion endpoint: every request id referencing a given message hash. */
export function searchContains(hash: string): Array<string> {
  return containingReqIdsQuery(getDatabase(), hash)
}
