import { OpenAPIHono } from "@hono/zod-openapi"
import consola from "consola"
import { cors } from "hono/cors"
import { trimTrailingSlash } from "hono/trailing-slash"
import { type BlankEnv } from "hono/types"

import type { ErrorWireFormat } from "./lib/error"

import { applyConfigToState } from "./lib/config/config"
import { forwardError } from "./lib/error"
import { observabilityMiddleware } from "./lib/observability/middleware"
import { state } from "./lib/state"
import { ensureValidCopilotToken } from "./lib/token"
import { registerHttpRoutes } from "./routes"
import { registerOpenApiDocs } from "./routes/openapi"

export interface ServerOptions {
  externalUiUrl?: string
}

/**
 * Match the response wire format to the route family so SDK clients see an
 * envelope they can parse. Default = anthropic (covers `/v1/messages` and any
 * route not registered to a specific protocol). Used by the global onError
 * handler so unhandled exceptions still produce a protocol-correct envelope.
 */
function detectErrorWireFormat(path: string): ErrorWireFormat {
  if (path.startsWith("/v1beta")) return "gemini"
  const openaiPrefixes = ["/chat/completions", "/v1/chat/completions", "/openai", "/responses", "/v1/responses", "/embeddings", "/v1/embeddings"]
  if (openaiPrefixes.some((p) => path.startsWith(p))) return "openai"
  return "anthropic"
}

export { detectErrorWireFormat }

export function createServer(options: ServerOptions = {}) {
  // OpenAPIHono is a drop-in superclass of Hono — same routing/middleware API,
  // plus it collects `createRoute` definitions registered on it (and on
  // OpenAPIHono sub-apps mounted via `.route()`) so the management API can emit
  // an aggregated OpenAPI 3.1 document. Non-OpenAPI sub-apps (chat-completions,
  // messages, …) stay plain Hono and simply contribute no definitions.
  // Pinned to `BlankEnv` so it stays assignable to the plain `Hono` params used
  // by registerHttpRoutes / registerWsRoutes / createWebSocketAdapter (the
  // default `OpenAPIHono<Env>` widens `.fetch`'s env and breaks assignability).
  const server = new OpenAPIHono<BlankEnv>()

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
    return forwardError(c, error, detectErrorWireFormat(c.req.path))
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

  server.use(observabilityMiddleware())
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

  // Management-API OpenAPI 3.1 doc (/openapi.json) + Scalar UI (/docs). Must run
  // after registerHttpRoutes so the management routers' definitions are mounted.
  registerOpenApiDocs(server)

  return server
}
