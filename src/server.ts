import consola from "consola"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { trimTrailingSlash } from "hono/trailing-slash"

import { forwardError } from "./lib/error"
import { state } from "./lib/state"
import { tuiLogger } from "./lib/tui"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { eventLoggingRoutes } from "./routes/event-logging/route"
import { historyRoutes } from "./routes/history/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

// Global error handler - catches any unhandled errors from route handlers
server.onError((error, c) => {
  // WebSocket errors after upgrade - connection is already upgraded,
  // cannot send HTTP response; log at debug level since these are normal
  // (e.g. client disconnect)
  if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
    consola.debug("WebSocket error:", error)
    return c.text("", 500)
  }

  consola.error("Unhandled route error:", error)
  return forwardError(c, error)
})

server.use(tuiLogger())
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

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token", tokenRoute)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)
server.route("/api/event_logging", eventLoggingRoutes)

// History viewer (optional, enabled with --history flag)
server.route("/history", historyRoutes)
