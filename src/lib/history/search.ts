import type { SearchParams } from "./search-types"
import type {
  //
  SearchResult,
} from "./types"
import { recordToEntrySummary } from "./v3/projection"
import {
  //
  containingV3OperationIds,
  getV3Operation,
  searchV3OperationIds,
} from "./v3/store"

export function searchHistory(params: SearchParams): SearchResult {
  const limit = params.limit && params.limit > 0 ? params.limit : 30
  const operationKind = params.filters?.operationKind ?? "generation"
  const ids = params.q ? searchV3OperationIds(params.q, operationKind === "all" ? undefined : operationKind, limit) : []
  const rows = ids.flatMap((id) => {
    const record = getV3Operation(id)
    return record ? [{ source: params.source, hash: id, ownerReqId: id, snippet: params.q, summary: recordToEntrySummary(record) }] : []
  })
  return { rows, nextCursor: rows.length === limit ? rows.at(-1)?.ownerReqId ?? null : null, partial: false }
}

export function searchContains(hash: string): Array<string> {
  return containingV3OperationIds(hash)
}
