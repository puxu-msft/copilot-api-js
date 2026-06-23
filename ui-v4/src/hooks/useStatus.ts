import { useQuery } from "@tanstack/react-query"

import type { ServerStatus } from "@/types/status"

import { api } from "@/lib/api"

export function useStatus() {
  return useQuery({
    queryKey: ["status"],
    queryFn: () => api.get<ServerStatus>("/api/status"),
    refetchInterval: 3000,
  })
}
