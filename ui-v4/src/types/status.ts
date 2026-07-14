/**
 * Frontend-loose shapes for GET /api/status, GET /api/models, GET /api/config/yaml.
 *
 * These are intentionally defensive (every nested object keeps a
 * `[key: string]: unknown` index) so pages render without crashing even as the
 * backend's runtime-dynamic status/quota/rateLimiter shapes evolve. The few
 * named fields below mirror the real backend handlers (src/routes/status/route.ts,
 * src/routes/models/internal.ts) — see this task's report for the full field map.
 * Ideal future state: the backend exports these and the FE re-exports via
 * ~backend/*; for now frontend-loose is acceptable.
 */

// SSOT: the request-telemetry snapshot is OWNED by the backend (single-source-of-truth-types). The FE
// re-exports the backend definition via `~backend/*` rather than re-declaring it. `import type` +
// `export type` keep this a pure type reference — the build (esbuild/rollup) elides it entirely, so it
// never pulls the backend module's value imports (`~/lib/state`, sqlite, consola) into the FE bundle.
import type { RequestTelemetrySnapshot } from "~backend/lib/request-telemetry"

export type { RequestTelemetrySnapshot } from "~backend/lib/request-telemetry"

/** GET /api/status — aggregated server status. Top-level keys mirror the handler. */
export interface ServerStatus {
  status?: string
  uptime?: number
  version?: string
  activeRequests?: { count?: number }
  quota?: Record<string, unknown>
  rateLimiter?: Record<string, unknown>
  requestTelemetry?: RequestTelemetrySnapshot
  memory?: Record<string, unknown>
  shutdown?: Record<string, unknown>
  models?: Record<string, unknown>
  upstream_ws?: Record<string, unknown>
  protect_streaming?: Record<string, unknown>
  [key: string]: unknown
}

/** One model from GET /api/models `{ data: ModelInfo[] }` (internal full Copilot shape). */
export interface ModelInfo {
  id?: string
  vendor?: string
  name?: string
  version?: string
  capabilities?: Record<string, unknown>
  billing?: Record<string, unknown>
  [key: string]: unknown
}

/** GET /api/config/yaml — parsed config.yaml as a JSON object (NOT a raw YAML string). */
export interface ConfigYaml {
  [key: string]: unknown
}
