/**
 * OpenAPI 3.1 document + Scalar API-reference UI for the **management API**.
 *
 * Scope: only the project-owned management surface under `/api/*` (server
 * status, token/quota, effective config + config.yaml editing, internal model
 * catalog, and the dry-run-truncate inspector) is described here. The OpenAI /
 * Anthropic / Gemini / Azure compat endpoints mirror their upstream vendors'
 * published contracts (use the upstream specs) and are intentionally NOT
 * documented — they stay plain `Hono` and contribute no definitions. The
 * request-history REST API (`/history/api/*`), `/api/debug/dry-run-pipeline`,
 * and `/api/event_logging` are also excluded (see OPENAPI_DESCRIPTION below).
 *
 * Mechanism: `OpenAPIHono` collects `createRoute` definitions registered via
 * `.openapi()` on itself and on OpenAPIHono sub-apps mounted with `.route()`
 * (prefix applied). `createServer` / `createFullTestApp` build the root app as
 * `OpenAPIHono`, mount the management routers (which are OpenAPIHono), then call
 * this to expose `GET /openapi.json` (3.1 doc) and `GET /docs` (Scalar UI).
 */

import type { OpenAPIHono } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"

import { Scalar } from "@scalar/hono-api-reference"

import packageJson from "../../package.json"

/** Spec endpoint (machine-readable OpenAPI 3.1 JSON). */
const OPENAPI_SPEC_PATH = "/openapi.json"

/** Interactive Scalar API-reference UI. */
const OPENAPI_DOCS_PATH = "/docs"

const OPENAPI_DESCRIPTION = [
  "Management API for copilot-api — server status, token/quota, effective config",
  "and config.yaml editing, the internal model catalog, and the offline",
  "dry-run-truncate inspector.",
  "",
  "The OpenAI / Anthropic / Gemini / Azure compatibility endpoints are NOT listed",
  "here: they mirror each upstream vendor's published API contract — use the",
  "vendor's own OpenAPI spec for those.",
  "",
  "Also intentionally absent: the request-history REST API (/history/api/*), the",
  "pipeline dry-run inspector (/api/debug/dry-run-pipeline), and the event-logging",
  "telemetry sink (/api/event_logging) — their handlers return broad/dynamic shapes",
  "(or are write-only sinks) and are typed for the in-repo Vue UI rather than",
  "external consumers.",
].join("\n")

/**
 * Register the aggregated management-API OpenAPI document + Scalar UI on the
 * given root app. Must run AFTER the management routers are mounted (so their
 * `.openapi()` definitions are present); the document is generated lazily per
 * request, so registration order is otherwise unconstrained.
 */
export function registerOpenApiDocs(app: OpenAPIHono<BlankEnv>): void {
  app.doc31(OPENAPI_SPEC_PATH, {
    openapi: "3.1.0",
    info: {
      title: "copilot-api management API",
      version: packageJson.version,
      description: OPENAPI_DESCRIPTION,
    },
  })

  app.get(OPENAPI_DOCS_PATH, Scalar({ url: OPENAPI_SPEC_PATH, pageTitle: "copilot-api management API" }))
}
