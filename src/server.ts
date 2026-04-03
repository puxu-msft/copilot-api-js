import consola from "consola"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { trimTrailingSlash } from "hono/trailing-slash"

import { applyConfigToState } from "./lib/config/config"
import { forwardError } from "./lib/error"
import { state } from "./lib/state"
import { ensureValidCopilotToken } from "./lib/token"
import { tuiMiddleware } from "./lib/tui"
import { registerHttpRoutes } from "./routes"

export interface ServerOptions {
  externalUiUrl?: string
}

export function createServer(options: ServerOptions = {}) {
  const server = new Hono()

  // Global error handler - catches any unhandled errors from route handlers
  server.onError((error, c) => {
    // WebSocket errors after upgrade - connection is already upgraded,
    // cannot send HTTP response; log at debug level since these are normal
    // (e.g. client disconnect)
    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      consola.debug("WebSocket error:", error)
      return c.text("", 500)
    }

    consola.error(`Unhandled route error in ${c.req.method} ${c.req.path}:`, error)
    return forwardError(c, error)
  })

  // Browser auto-requests (favicon, devtools config) — return 204 silently
  // to avoid [FAIL] 404 noise in TUI logs.
  const browserProbePaths = new Set(["/favicon.ico", "/.well-known/appspecific/com.chrome.devtools.json"])

  server.notFound((c) => {
    if (browserProbePaths.has(c.req.path)) {
      return c.body(null, 204)
    }
    return c.json({ error: "Not Found" }, 404)
  })

  // Config hot-reload: re-apply config.yaml settings before each request.
  // loadConfig() is mtime-cached — only costs one stat() syscall when config is unchanged.
  // Also proactively ensure the Copilot token is valid — if the last background
  // refresh failed or the token is about to expire, try refreshing now rather than
  // waiting for a 401 from the upstream API.
  server.use(async (_c, next) => {
    await applyConfigToState()
    await ensureValidCopilotToken()
    await next()
  })

  server.use(tuiMiddleware())
  server.use(cors())
  server.use(trimTrailingSlash())

  server.get("/", (c) => c.text("Server running"))

  // Health check endpoint for container orchestration (Docker, Kubernetes)
  server.get("/health", (c) => {
    const healthy = Boolean(state.copilotToken && state.githubToken)
    return c.json(
      {
        status: healthy ? "healthy" : "unhealthy",
        checks: {
          copilotToken: Boolean(state.copilotToken),
          githubToken: Boolean(state.githubToken),
          models: Boolean(state.models),
        },
      },
      healthy ? 200 : 503,
    )
  })

  // Register HTTP routes. WebSocket routes are injected later in start.ts after
  // a shared adapter is created for the concrete runtime/server instance.
  registerHttpRoutes(server, { externalUiUrl: options.externalUiUrl })

  return server
}
