import { useQuery } from "@tanstack/react-query"

import type { ModelInfo } from "@/types/status"

import { api } from "@/lib/api"

export function useModels() {
  return useQuery({
    queryKey: ["models"],
    queryFn: () => api.get<{ data: Array<ModelInfo> }>("/api/models"),
  })
}
