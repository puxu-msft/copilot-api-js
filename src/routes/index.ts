/**
 * Centralized route registration.
 * All API routes are registered here instead of scattered in server.ts.
 */

import type { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"

import { initWebSocket } from "~/lib/ws"

import { azureDeploymentRoutes } from "./azure-openai/route"
import { chatCompletionRoutes } from "./chat-completions/route"
import { configRoutes } from "./config/route"
import { embeddingsRoutes } from "./embeddings/route"
import { eventLoggingRoutes } from "./event-logging/route"
import { geminiRoutes } from "./gemini/route"
import { historyRoutes } from "./history/route"
import { logsRoutes } from "./logs/route"
import { messagesRoutes } from "./messages/route"
import {
  //
  anthropicModelsRoutes,
  internalModelsRoutes,
  modelsRoutes,
} from "./models/route"
import { responsesRoutes } from "./responses/route"
import { initResponsesWebSocket } from "./responses/ws"
import { statusRoutes } from "./status/route"
import { tokenRoutes } from "./token/route"
import {
  //
  type UiRoutesOptions,
  createUiRoutes,
} from "./ui/route"

/**
 * Register all HTTP routes on the given Hono app.
 */

export function registerHttpRoutes(app: Hono, options: UiRoutesOptions = {}) {
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

  // Azure OpenAI classic deployment-based format
  // e.g. POST /openai/deployments/{model}/chat/completions?api-version=2024-10-21
  app.route("/openai/deployments", azureDeploymentRoutes)

  // Azure OpenAI v1 format (standard OpenAI paths under /openai prefix)
  app.route("/openai/v1/chat/completions", chatCompletionRoutes)
  app.route("/openai/v1/models", modelsRoutes)
  app.route("/openai/v1/embeddings", embeddingsRoutes)
  app.route("/openai/v1/responses", responsesRoutes)

  // Anthropic-compatible endpoints
  app.route("/v1/messages", messagesRoutes)
  app.route("/anthropic/v1/messages", messagesRoutes)
  app.route("/anthropic/v1/models", anthropicModelsRoutes)
  app.route("/api/event_logging", eventLoggingRoutes)

  // Google Gemini-compatible endpoints
  // POST /v1beta/models/<model>:<method> where method ∈
  // generateContent | streamGenerateContent | countTokens
  app.route("/v1beta", geminiRoutes)

  // Management API
  app.route("/api/status", statusRoutes)
  app.route("/api/tokens", tokenRoutes)
  app.route("/api/config", configRoutes)
  app.route("/api/logs", logsRoutes)
  app.route("/api/models", internalModelsRoutes)

  // History API and standalone Web UI entry
  app.route("/history", historyRoutes)
  app.route("/ui", createUiRoutes(options))
}

/**
 * Register all WebSocket routes on the given Hono app.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerWsRoutes(app: Hono, wsUpgrade: UpgradeWebSocket<any>) {
  initWebSocket(app, wsUpgrade)
  initResponsesWebSocket(app, wsUpgrade)
}
