import type { SearchParams } from "./search-types"
import type {
  //
  SearchResult,
} from "./types"

const UNSUPPORTED = "History V3 search is unsupported until the canonical search facade lands"

/** V3 has no stable search projection yet; never fall through to legacy V2 tables. */
export function searchHistory(_params: SearchParams): SearchResult {
  throw new Error(UNSUPPORTED)
}

/** V3 has no content-hash reverse lookup yet; never read the legacy req_msg index. */
export function searchContains(_hash: string): Array<string> {
  throw new Error(UNSUPPORTED)
}
