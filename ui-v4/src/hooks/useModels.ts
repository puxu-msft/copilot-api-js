import type { InternalModelsResponse } from "~backend/lib/models/client"

import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"

/** GET /api/models — full Copilot catalog (unfiltered) + `disabled[]` (config-disabled ids). */
export function useModels() {
  return useQuery({
    queryKey: ["models"],
    queryFn: () => api.get<InternalModelsResponse>("/api/models"),
  })
}
