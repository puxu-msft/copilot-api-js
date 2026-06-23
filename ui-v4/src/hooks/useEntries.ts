import { useQuery } from "@tanstack/react-query"

import type { SummaryResult } from "@/types"

import { api } from "@/lib/api"

/** 游标分页拉取 /history/api/entries(server-state via TanStack Query)。 */
export function useEntries(limit = 50) {
  return useQuery({
    queryKey: ["entries", { limit }],
    queryFn: () => api.get<SummaryResult>(`/history/api/entries?limit=${String(limit)}`),
  })
}
