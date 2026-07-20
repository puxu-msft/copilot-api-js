import type {
  //
  QueryOptions,
  SearchSource,
} from "./types"

export interface SearchParams {
  source: SearchSource
  q: string
  limit?: number
  cursor?: string
  filters?: QueryOptions
}
