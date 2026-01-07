import { Hono } from "hono"
import { cors } from "hono/cors"

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

server.use(tuiLogger())
server.use(cors())

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
