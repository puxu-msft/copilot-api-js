import { createFullTestApp } from "../../helpers/test-app"

export interface InProcessProxy {
  baseURL: string
  close: () => void
}

/**
 * Serve the FULL proxy app on an ephemeral kernel-assigned port (never 4141) so a real client
 * SDK can hit it over genuine HTTP. Upstream GHC is shielded separately via
 * `setUpstreamFetchForTests` (which replaces the dedicated `activeUpstreamFetch`, NOT
 * `globalThis.fetch`), so the SDK's own `globalThis.fetch` reaches localhost untouched — the two
 * fetch paths are naturally isolated (no host-scoping needed).
 *
 * Note: `Bun.serve` has a default `idleTimeout` (10s) — Tier-1 scripted streams are fast so this is
 * fine; a slow-stream scenario would need to raise it. The full app registers a History WebSocket
 * route, but a bare `Bun.serve` (no `websocket` handler) won't upgrade — Tier-1 SDK scenarios don't
 * use WS, so that's out of scope here.
 */
export function serveInProcess(): InProcessProxy {
  const app = createFullTestApp()
  const server = Bun.serve({ fetch: app.fetch, port: 0 })
  return { baseURL: `http://localhost:${server.port}`, close: () => server.stop(true) }
}
