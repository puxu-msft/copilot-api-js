/**
 * Centralized route registration.
 * All API routes are registered here instead of scattered in server.ts.
 */

import type { Hono } from "hono"

import { chatCompletionRoutes } from "./chat-completions/route"
import { configRoutes } from "./config/route"
import { embeddingsRoutes } from "./embeddings/route"
import { eventLoggingRoutes } from "./event-logging/route"
import { historyRoutes } from "./history/route"
import { logsRoutes } from "./logs/route"
import { messagesRoutes } from "./messages/route"
import { modelsRoutes } from "./models/route"
import { responsesRoutes } from "./responses/route"
import { statusRoutes } from "./status/route"
import { tokenRoutes } from "./token/route"

/**
 * Register all API routes on the given Hono app.
 */
export function registerRoutes(app: Hono) {
  // OpenAI-compatible endpoints
  app.route("/chat/completions", chatCompletionRoutes)
  app.route("/models", modelsRoutes)
  app.route("/embeddings", embeddingsRoutes)
  app.route("/responses", responsesRoutes)

  // OpenAI-compatible with /v1 prefix
  app.route("/v1/chat/completions", chatCompletionRoutes)
  app.route("/v1/models", modelsRoutes)
  app.route("/v1/embeddings", embeddingsRoutes)
  app.route("/v1/responses", responsesRoutes)

  // Anthropic-compatible endpoints
  app.route("/v1/messages", messagesRoutes)
  app.route("/api/event_logging", eventLoggingRoutes)

  // Management API
  app.route("/api/status", statusRoutes)
  app.route("/api/tokens", tokenRoutes)
  app.route("/api/config", configRoutes)
  app.route("/api/logs", logsRoutes)

  // History API (/history/api/*, /history/ws) + Web UI (/ui)
  app.route("/history", historyRoutes)
  app.route("/ui", historyRoutes)
}
