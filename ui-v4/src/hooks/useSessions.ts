import { useQuery } from "@tanstack/react-query"

import type { SessionSummary } from "@/types"

import { api } from "@/lib/api"

export function useSessions() {
  return useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.get<{ sessions: Array<SessionSummary> }>("/history/api/sessions"),
  })
}
