import type { SearchParams } from "./search-types"
import type {
  //
  SearchResult,
} from "./types"
export function searchHistory(_params: SearchParams): SearchResult {
  // Embedded History search has been retired. Keep the HTTP contract stable
  // while the independent Tantivy sidecar is unavailable or rebuilding.
  return { rows: [], nextCursor: null, partial: false }
}

export function searchContains(_hash: string): Array<string> {
  return []
}
