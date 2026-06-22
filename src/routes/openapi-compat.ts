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
      summary: `Azure classic ${label} (deployment → model; api-version query ignored)`,
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
    path: "/anthropic/v1/models/{id}",
    tags: ["anthropic"],
    summary: "Single model, Anthropic format",
    request: { params: z.object({ id: z.string() }) },
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
    path: "/history/api/entries/{id}/lineage",
    tags: historyTag,
    summary: "Anthropic prefix-hash lineage for an entry",
    request: { params: z.object({ id: z.string() }) },
    responses: ok200("Lineage chain"),
  })
  registry.registerPath({
    method: "delete",
    path: "/history/api/entries",
    tags: historyTag,
    summary: "Clear history entries",
    responses: ok200("Deletion result"),
  })
  registry.registerPath({ method: "get", path: "/history/api/stats", tags: historyTag, summary: "History store statistics", responses: ok200("Stats") })
  registry.registerPath({ method: "get", path: "/history/api/export", tags: historyTag, summary: "Export history", responses: ok200("Exported history") })
  registry.registerPath({
    method: "get",
    path: "/history/api/conversations",
    tags: historyTag,
    summary: "Conversation rollups",
    responses: ok200("Conversations"),
  })
  registry.registerPath({ method: "get", path: "/history/api/sessions", tags: historyTag, summary: "List sessions", responses: ok200("Sessions") })
  registry.registerPath({
    method: "get",
    path: "/history/api/sessions/{id}",
    tags: historyTag,
    summary: "Single session",
    request: { params: z.object({ id: z.string() }) },
    responses: { ...ok200("Session"), 404: { description: "Not found", ...jsonContent() } },
  })
  registry.registerPath({
    method: "delete",
    path: "/history/api/sessions/{id}",
    tags: historyTag,
    summary: "Delete a session",
    request: { params: z.object({ id: z.string() }) },
    responses: ok200("Deletion result"),
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
}
