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
 * Uses a DISTINCT queryKey (not the shared ["status"]) so it never inherits
 * useStatus's 3s `refetchInterval` — `refetchInterval` is query-level, so
 * sharing the key would make this poll whenever any status observer is mounted.
 * With its own key + no interval it loads once on mount and refetches on revisit
 * (react-query staleTime), honoring "load on revisit, no polling". `select`
 * narrows the raw status to the parsed model telemetry snapshot.
 */
export function useModelTelemetry() {
  return useQuery({
    queryKey: ["model-telemetry"],
    queryFn: () => api.get<ServerStatus>("/api/status"),
    select: (status): RequestTelemetrySnapshot | null => parseRequestTelemetry(status.requestTelemetry),
  })
}
