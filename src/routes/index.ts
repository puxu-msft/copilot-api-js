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
import { debugRoutes } from "./debug/route"
import { embeddingsRoutes } from "./embeddings/route"
import { eventLoggingRoutes } from "./event-logging/route"
import { geminiRoutes } from "./gemini/route"
import { historyRoutes } from "./history/route"
import { hooksRoutes } from "./hooks/route"
import { logsRoutes } from "./logs/route"
import { messagesRoutes } from "./messages/route"
import { metricsRoutes } from "./metrics/route"
import {
  //
  anthropicModelsRoutes,
  internalModelsRoutes,
  modelsRoutes,
} from "./models/route"
import { negotiationRoutes } from "./negotiation/route"
import { responsesRoutes } from "./responses/route"
import { initResponsesWebSocket } from "./responses/ws"
import { statsRoutes } from "./stats/route"
import { statusRoutes } from "./status/route"
import { tokenRoutes } from "./token/route"

/**
 * Register all HTTP routes on the given Hono app.
 */

export function registerHttpRoutes(app: Hono) {
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
  app.route("/api/stats", statsRoutes)
  app.route("/api/tokens", tokenRoutes)
  app.route("/api/config", configRoutes)
  app.route("/api/logs", logsRoutes)
  app.route("/api/models", internalModelsRoutes)
  app.route("/api/debug", debugRoutes)
  app.route("/api/negotiation", negotiationRoutes)
  app.route("/api/hooks", hooksRoutes)

  // History API (Web UI is externalized — see docs/vue-ui-retirement.md and
  // the "自托管 UI" ops note in README.md; the main server is API-only).
  app.route("/history", historyRoutes)

  // Prometheus text-exposition endpoint (operational stats bridge).
  app.route("/metrics", metricsRoutes)
}

/**
 * Register all WebSocket routes on the given Hono app.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerWsRoutes(app: Hono, wsUpgrade: UpgradeWebSocket<any>) {
  initWebSocket(app, wsUpgrade)
  initResponsesWebSocket(app, wsUpgrade)
}
