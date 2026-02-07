/**
 * Centralized route registration.
 * All API routes are registered here instead of scattered in server.ts.
 */

import type { Hono } from "hono"

import { completionRoutes } from "./chat-completions/route"
import { embeddingRoutes } from "./embeddings/route"
import { eventLoggingRoutes } from "./event-logging/route"
import { historyRoutes } from "./history/route"
import { messageRoutes } from "./messages/route"
import { modelRoutes } from "./models/route"
import { tokenRoute } from "./token/route"
import { usageRoute } from "./usage/route"

/**
 * Register all API routes on the given Hono app.
 */
export function registerRoutes(app: Hono) {
  // OpenAI-compatible endpoints
  app.route("/chat/completions", completionRoutes)
  app.route("/models", modelRoutes)
  app.route("/embeddings", embeddingRoutes)
  app.route("/usage", usageRoute)
  app.route("/token", tokenRoute)

  // OpenAI-compatible with /v1 prefix
  app.route("/v1/chat/completions", completionRoutes)
  app.route("/v1/models", modelRoutes)
  app.route("/v1/embeddings", embeddingRoutes)

  // Anthropic-compatible endpoints
  app.route("/v1/messages", messageRoutes)
  app.route("/api/event_logging", eventLoggingRoutes)

  // History viewer (optional, enabled with --history flag)
  app.route("/history", historyRoutes)
}
