import type { Model } from "~backend/lib/models/client"

import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"

/** GET /api/models — full Copilot model catalog (internal shape, verbatim). */
export function useModels() {
  return useQuery({
    queryKey: ["models"],
    queryFn: () => api.get<{ data: Array<Model> }>("/api/models"),
  })
}
