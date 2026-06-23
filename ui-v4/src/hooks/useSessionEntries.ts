import { useQuery } from "@tanstack/react-query"

import type { SummaryResult } from "@/types"

import { api } from "@/lib/api"

export function useSessionEntries(sessionId: string | undefined) {
  return useQuery({
    queryKey: ["session-entries", sessionId],
    queryFn: () => api.get<SummaryResult>(`/history/api/entries?sessionId=${String(sessionId)}&limit=1000`),
    enabled: Boolean(sessionId),
  })
}
