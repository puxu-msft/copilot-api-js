import { useQuery } from "@tanstack/react-query"

import type { ServerStatus } from "@/types/status"

import { api } from "@/lib/api"
import {
  //
  parseRequestTelemetry,
  type RequestTelemetrySnapshot,
} from "@/lib/model-telemetry"

/**
 * Per-model runtime telemetry from GET /api/status (requestTelemetry).
 *
 * No `refetchInterval` — loads once on mount and refetches on revisit
 * (react-query staleTime), not polling. Shares the ["status"] cache with any
 * other status consumer; `select` narrows to the parsed model telemetry snapshot.
 */
export function useModelTelemetry() {
  return useQuery({
    queryKey: ["status"],
    queryFn: () => api.get<ServerStatus>("/api/status"),
    select: (status): RequestTelemetrySnapshot | null => parseRequestTelemetry(status.requestTelemetry),
  })
}
