/**
 * OpenAPI documentation for the **compat + history + diagnostic** routes that are
 * served by plain Hono handlers (not `.openapi()`-bound).
 *
 * These are registered directly on the root app's `openAPIRegistry` via
 * `registerPath` — pure documentation that does NOT create routes, bind handlers,
 * or validate anything. So the real handlers (vendor compat pipelines, the
 * history REST API, the dry-run-pipeline inspector) keep working exactly as
 * before; this only makes them appear in `/openapi.json`.
 *
 * Schemas are intentionally SIMPLE (open objects): the OpenAI / Anthropic /
 * Gemini request & response bodies mirror each vendor's published contract — use
 * the vendor's own spec for field-level detail; here we document the surface
 * (path, method, purpose, prefix aliases) so every endpoint is discoverable.
 */

import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi"

import { z } from "@hono/zod-openapi"

const AnyObject = z.record(z.string(), z.unknown()).openapi("AnyObject")

const jsonContent = (schema: z.ZodType = AnyObject) => ({ content: { "application/json": { schema } } })
const ok200 = (description: string, schema: z.ZodType = AnyObject) => ({
  200: { description, ...jsonContent(schema) },
})

/**
 * Register every plain-Hono route on the OpenAPI document with simple schemas.
 * Management routes (status/tokens/config/logs/models-internal/debug-truncate)
 * are NOT here — they self-register via `.openapi()` with precise schemas.
 */
export function registerCompatPaths(registry: OpenAPIRegistry): void {
  // ── OpenAI-compatible (also under /v1 and /openai/v1 prefixes) ────────────
  registry.registerPath({
    method: "post",
    path: "/v1/chat/completions",
    tags: ["openai"],
    summary: "OpenAI Chat Completions (also at /chat/completions, /openai/v1/chat/completions)",
    description: "Body/response mirror the OpenAI Chat Completions API. Streaming via `stream: true` (SSE).",
    request: { body: jsonContent() },
    responses: { ...ok200("Chat completion (JSON or SSE stream)"), 400: { description: "Bad request", ...jsonContent() } },
  })
  registry.registerPath({
    method: "get",
    path: "/v1/models",
    tags: ["openai"],
    summary: "List models, OpenAI format (also at /models, /openai/v1/models)",
    responses: ok200("Model list"),
  })
  registry.registerPath({
    method: "get",
    path: "/v1/models/{model}",
    tags: ["openai"],
    summary: "Single model, OpenAI format",
    request: { params: z.object({ model: z.string() }) },
    responses: { ...ok200("Model"), 404: { description: "Model not found", ...jsonContent() } },
  })
  registry.registerPath({
    method: "post",
    path: "/v1/embeddings",
    tags: ["openai"],
    summary: "OpenAI Embeddings (also at /embeddings, /openai/v1/embeddings)",
    request: { body: jsonContent() },
    responses: ok200("Embeddings"),
  })
  registry.registerPath({
    method: "post",
    path: "/v1/responses",
    tags: ["openai"],
    summary: "OpenAI Responses API (also at /responses, /openai/v1/responses; WebSocket on GET)",
    description: "Body/response mirror the OpenAI Responses API. A WebSocket upgrade is also served at GET /responses.",
    request: { body: jsonContent() },
    responses: ok200("Response (JSON or SSE stream)"),
  })

  // ── Azure OpenAI classic deployment format ────────────────────────────────
  for (const [suffix, label] of [
    ["chat/completions", "Chat Completions"],
    ["embeddings", "Embeddings"],
    ["responses", "Responses"],
  ] as const) {
    registry.registerPath({
      method: "post",
      path: `/openai/deployments/{deployment}/${suffix}`,
      tags: ["azure"],
      summary: `Azure classic ${label} (deployment → model; api-version query stripped, not forwarded upstream)`,
      request: { params: z.object({ deployment: z.string() }), body: jsonContent() },
      responses: ok200(label),
    })
  }

  // ── Anthropic-compatible ──────────────────────────────────────────────────
  registry.registerPath({
    method: "post",
    path: "/v1/messages",
    tags: ["anthropic"],
    summary: "Anthropic Messages (also at /anthropic/v1/messages)",
    description: "Body/response mirror the Anthropic Messages API. Streaming via `stream: true` (SSE).",
    request: { body: jsonContent() },
    responses: { ...ok200("Message (JSON or SSE stream)"), 400: { description: "Bad request", ...jsonContent() } },
  })
  registry.registerPath({
    method: "post",
    path: "/v1/messages/count_tokens",
    tags: ["anthropic"],
    summary: "Anthropic token counting (local tokenizer)",
    request: { body: jsonContent() },
    responses: ok200("Token count"),
  })
  registry.registerPath({
    method: "get",
    path: "/anthropic/v1/models",
    tags: ["anthropic"],
    summary: "List models, Anthropic format (vendor=Anthropic only)",
    responses: ok200("Model list"),
  })
  registry.registerPath({
    method: "get",
    path: "/anthropic/v1/models/{model}",
    tags: ["anthropic"],
    summary: "Single model, Anthropic format",
    request: { params: z.object({ model: z.string() }) },
    responses: { ...ok200("Model"), 404: { description: "Not found", ...jsonContent() } },
  })

  // ── Google Gemini-compatible ──────────────────────────────────────────────
  for (const [method, label, stream] of [
    ["generateContent", "Gemini non-streaming generation", false],
    ["streamGenerateContent", "Gemini streaming generation (SSE)", true],
    ["countTokens", "Gemini token counting", false],
  ] as const) {
    registry.registerPath({
      method: "post",
      path: `/v1beta/models/{model}:${method}`,
      tags: ["gemini"],
      summary: label,
      request: { params: z.object({ model: z.string() }), body: jsonContent() },
      responses: ok200(stream ? "Generated content (SSE stream)" : label),
    })
  }

  // ── History REST API (/history/api/*) — documented, handlers untouched ─────
  const historyTag = ["history"]
  registry.registerPath({
    method: "get",
    path: "/history/api/entries",
    tags: historyTag,
    summary: "List request-history entries (cursor-paginated)",
    responses: ok200("Entries page"),
  })
  registry.registerPath({
    method: "get",
    path: "/history/api/entries/{id}",
    tags: historyTag,
    summary: "Single history entry (full request/response lifecycle)",
    request: { params: z.object({ id: z.string() }) },
    responses: { ...ok200("Entry"), 404: { description: "Not found", ...jsonContent() } },
  })
  registry.registerPath({
    method: "get",
    path: "/history/api/entries/{id}/export",
    tags: historyTag,
    summary: "Download one entry as a zstd-compressed .json.zst (full lifecycle)",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "zstd-compressed entry JSON" }, 404: { description: "Not found", ...jsonContent() } },
  })
  registry.registerPath({ method: "get", path: "/history/api/stats", tags: historyTag, summary: "History store statistics", responses: ok200("Stats") })
  registry.registerPath({
    method: "get",
    path: "/history/api/sessions",
    tags: historyTag,
    summary: "Per-session aggregate summaries",
    responses: ok200("Session summaries"),
  })
  registry.registerPath({ method: "get", path: "/history/api/export", tags: historyTag, summary: "Export history", responses: ok200("Exported history") })
  registry.registerPath({
    method: "get",
    path: "/history/api/search",
    tags: historyTag,
    summary: "Full-text search, forwarded to the independent history-search sidecar service (inbound facet only)",
    description:
      "Forwards to the out-of-process history-search sidecar (history-search-out-of-process plan) over a Unix domain socket. "
      + "Only `source=inbound` (client-facing conversation + response) is currently served by the sidecar's Tantivy projection — "
      + "the other 4 legacy facets (`rewrites-req`/`rewrites-resp`/`req-headers`/`resp-headers`) return `{rows:[],partial:true}` "
      + "(unsupported, not zero matches; see docs/todo/deferred-backlog.md for what expanding them would require). "
      + "The sidecar is an OPTIONAL, separately-started service (contrib/systemd/history-search.service) — when it is not "
      + "installed/running, `source=inbound` degrades the SAME way (`{rows:[],nextCursor:null,partial:true}`, HTTP 200, never a 500).",
    responses: ok200("Search results ({partial:true} when the requested facet is unsupported or the sidecar is unreachable)"),
  })
  registry.registerPath({
    method: "get",
    path: "/history/api/search/contains",
    tags: historyTag,
    summary: "Lazy companion: request ids referencing a given message hash",
    responses: ok200("Containing request ids"),
  })
  registry.registerPath({
    method: "post",
    path: "/history/api/entries/{id}/pin",
    tags: historyTag,
    summary: "Pin an entry (exempt from reaper GC)",
    request: { params: z.object({ id: z.string() }) },
    responses: { ...ok200("Updated entry"), 404: { description: "Not found", ...jsonContent() } },
  })
  registry.registerPath({
    method: "post",
    path: "/history/api/entries/{id}/unpin",
    tags: historyTag,
    summary: "Unpin an entry",
    request: { params: z.object({ id: z.string() }) },
    responses: { ...ok200("Updated entry"), 404: { description: "Not found", ...jsonContent() } },
  })

  // ── Diagnostics + infra ───────────────────────────────────────────────────
  registry.registerPath({
    method: "post",
    path: "/api/debug/dry-run-pipeline",
    tags: ["debug"],
    summary: "Offline pipeline dry-run inspector (all formats, request + response side)",
    description:
      "Replays a synthesized/replayed request or upstream response through the real v4 driver, short-circuiting GHC; output is per-format × per-stage intermediate state.",
    request: { body: jsonContent() },
    responses: { ...ok200("Selected-stage intermediate state"), 400: { description: "Bad input", ...jsonContent() } },
  })
  registry.registerPath({
    method: "post",
    path: "/api/event_logging/batch",
    tags: ["telemetry"],
    summary: "Anthropic-SDK event-logging sink (silently consumed)",
    request: { body: jsonContent() },
    responses: { 200: { description: "OK" } },
  })
  registry.registerPath({
    method: "get",
    path: "/health",
    tags: ["infra"],
    summary: "Health check (container orchestration)",
    responses: { ...ok200("Health"), 503: { description: "Unhealthy", ...jsonContent() } },
  })
  registry.registerPath({
    method: "get",
    path: "/health/readiness",
    tags: ["infra"],
    summary: "Readiness probe (can serve traffic — tokens/models loaded)",
    description:
      "Kubernetes-style readiness probe, equivalent to /health: 200 when the Copilot/GitHub tokens and model catalogue are loaded, 503 otherwise. Orchestrators use it to withhold or drain traffic (use /health/liveness for restart-on-hung).",
    responses: { ...ok200("Ready"), 503: { description: "Not ready", ...jsonContent() } },
  })
  registry.registerPath({
    method: "get",
    path: "/health/liveness",
    tags: ["infra"],
    summary: "Liveness probe (process responsiveness only)",
    description:
      'Cheap, dependency-free liveness probe — always 200 `{status:"alive"}` while the process can respond. Independent of upstream token/readiness state and of graceful shutdown (use /health for readiness/draining).',
    responses: { ...ok200("Alive") },
  })
  registry.registerPath({
    method: "get",
    path: "/",
    tags: ["infra"],
    summary: "Root path — redirects to /openapi.json",
    responses: { 302: { description: "Redirect to /openapi.json" } },
  })
  registry.registerPath({
    method: "get",
    path: "/metrics",
    tags: ["infra"],
    summary: "Prometheus metrics (operational stats bridge)",
    description:
      "Prometheus text exposition (v0.0.4) projecting the telemetry registry — `copilot_api_*_total{dimension,key}` counters. Same data as /api/stats, sinceStart window.",
    responses: { 200: { description: "Prometheus exposition", content: { "text/plain": { schema: z.string() } } } },
  })

  // ── WebSocket endpoints (101 Switching Protocols upgrade) ─────────────────
  // OpenAPI 3.1 has no first-class WebSocket modeling; documented as GET upgrade
  // endpoints so they appear on the surface. Registered on the live server (not
  // the HTTP-only test app) via registerWsRoutes.
  registry.registerPath({
    method: "get",
    path: "/responses",
    tags: ["openai"],
    summary: "OpenAI Responses upgrade to WebSocket (also at /v1/responses, /openai/v1/responses)",
    description: "WebSocket transport for the Responses API (opt-in via openai_responses.upstream_ws / client WS).",
    responses: { 101: { description: "Switching Protocols (WebSocket)" } },
  })
  registry.registerPath({
    method: "get",
    path: "/ws",
    tags: ["history"],
    summary: "History WebSocket (live entry/status/shutdown push)",
    responses: { 101: { description: "Switching Protocols (WebSocket)" } },
  })
}
