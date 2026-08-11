import { OpenAPIHono } from "@hono/zod-openapi"
import consola from "consola"
import { type Context } from "hono"
import { cors } from "hono/cors"
import { trimTrailingSlash } from "hono/trailing-slash"
import { type BlankEnv } from "hono/types"

import { state } from "~/lib/state"
import {
  //
  getTokenCredentials,
  peekTokenRuntime,
} from "~/lib/token"

import type { ErrorWireFormat } from "./lib/error"

import { applyConfigToState } from "./lib/config/config"
import { forwardError } from "./lib/error"
import {
  //
  observabilityMiddleware,
  shutdownConnectionCloseMiddleware,
} from "./lib/observability/middleware"
import {
  //
  classifyUnknownEndpoint,
  getShadowIndex,
  UNKNOWN_ENDPOINT_CTX_KEY,
  unknownEndpointFinalizer,
} from "./lib/observability/unknown-endpoint"
import { registerHttpRoutes } from "./routes"
import { registerOpenApiDocs } from "./routes/openapi"

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

/**
 * Readiness check — reports whether the proxy can serve traffic right now (the
 * Copilot/GitHub tokens and the model catalogue are loaded). Returns 503 until
 * ready so orchestrators withhold or drain traffic. Shared by `/health` (legacy
 * name) and `/health/readiness` (Kubernetes-style name), and re-exported so the
 * HTTP test app mirrors identical behavior from a single source.
 */
export function readinessCheck(c: Context): Response {
  const credentials = getTokenCredentials()
  const healthy = Boolean(credentials.copilotToken && credentials.githubToken)
  return c.json(
    {
      status: healthy ? "healthy" : "unhealthy",
      checks: {
        copilotToken: Boolean(credentials.copilotToken),
        githubToken: Boolean(credentials.githubToken),
        models: Boolean(state.models),
      },
    },
    healthy ? 200 : 503,
  )
}

export function createServer() {
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

  // Browser auto-requests (favicon, devtools config) — return 204 silently so
  // they never enter the unknown-endpoint logging pipeline (see notFound below).
  const browserProbePaths = new Set(["/favicon.ico", "/.well-known/appspecific/com.chrome.devtools.json"])

  server.notFound((c) => {
    if (browserProbePaths.has(c.req.path)) {
      return c.body(null, 204)
    }
    // Classify unknown endpoints into three states (see docs/spec/2026-07-14-…):
    //  - method-not-allowed → real 405 + Allow header (path exists, wrong method)
    //  - unknown-not-found   → 404 (real routing miss)
    //  - route-owned-not-found → a matched handler called c.notFound() itself;
    //    keep its 404, don't rewrite to 405, don't log.
    // The finalizer middleware (registered outside trimTrailingSlash) reads the
    // stashed classification + final status and logs at the configured level.
    const cls = classifyUnknownEndpoint(getShadowIndex(server), c.req.method, c.req.path)
    if (cls.kind === "method-not-allowed") {
      c.set(UNKNOWN_ENDPOINT_CTX_KEY as never, { classification: cls, method: c.req.method, path: c.req.path, ua: c.req.header("user-agent") ?? "-" } as never)
      return c.json({ error: "Method Not Allowed" }, 405, { Allow: cls.allow.join(", ") })
    }
    if (cls.kind === "unknown-not-found") {
      c.set(UNKNOWN_ENDPOINT_CTX_KEY as never, { classification: cls, method: c.req.method, path: c.req.path, ua: c.req.header("user-agent") ?? "-" } as never)
    }
    return c.json({ error: "Not Found" }, 404)
  })

  // Liveness probe — reports only that the process is responsive. Registered
  // BEFORE the config/token middleware below so it never touches upstream: a
  // liveness check must stay 200 even when the Copilot token is stale or the
  // upstream is down (orchestrators use readiness `/health`, not liveness, to
  // drain traffic; a failing liveness probe triggers a pod restart). Also stays
  // 200 during graceful shutdown since it sits ahead of the shutdown gate.
  server.get("/health/liveness", (c) => c.json({ status: "alive" }))

  // Outermost ingress rule: anything we reject while shutting down tells the client to drop the connection.
  // Registered BEFORE the config/token middleware below because that middleware's awaits are themselves a rejection path during shutdown — see shutdownConnectionCloseMiddleware's doc comment.
  server.use(shutdownConnectionCloseMiddleware())

  // Config hot-reload: re-apply config.yaml settings before each request.
  // loadConfig() is mtime-cached — only costs one stat() syscall when config is unchanged.
  // Also proactively ensure the Copilot token is valid — if the last background
  // refresh failed or the token is about to expire, try refreshing now rather than
  // waiting for a 401 from the upstream API.
  server.use(async (c, next) => {
    // Stamped BEFORE the awaits below, because they are exactly what makes the stamp
    // necessary: `ensureValidCopilotToken()` can spend real seconds on retries with
    // backoff, and the Anthropic delayed-commit window is a deadline measured from
    // request ingress (its budget is shared with the client's own pre-header limit,
    // which starts at the client's dispatch — see handler-v4's commit window).
    ;(c as Context).set("ingressAtMs", Date.now())
    await applyConfigToState()
    await peekTokenRuntime()?.ensureValidCopilotToken()
    await next()
  })

  server.use(observabilityMiddleware())
  // Registered OUTSIDE trimTrailingSlash so its after-next sees the FINAL status
  // (trailing-slash 404→301 rewrite already applied). Reads the notFound-stashed
  // classification and logs unknown endpoints at the configured level. Not merged
  // into observabilityMiddleware: unknown endpoints don't create a RequestContext.
  server.use(unknownEndpointFinalizer())
  server.use(cors())
  server.use(trimTrailingSlash())

  server.get("/", (c) => c.redirect("/openapi.json"))

  // Readiness check for container orchestration (Docker, Kubernetes). `/health`
  // is the legacy name; `/health/readiness` is the Kubernetes-style companion to
  // `/health/liveness` above. Both share readinessCheck.
  server.get("/health", readinessCheck)
  server.get("/health/readiness", readinessCheck)

  // Register HTTP routes. WebSocket routes are injected later in start.ts after
  // a shared adapter is created for the concrete runtime/server instance.
  registerHttpRoutes(server)

  // Management-API OpenAPI 3.1 doc (/openapi.json) + Scalar UI (/docs). Must run
  // after registerHttpRoutes so the management routers' definitions are mounted.
  registerOpenApiDocs(server)

  return server
}
