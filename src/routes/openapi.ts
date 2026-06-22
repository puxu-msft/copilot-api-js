/**
 * OpenAPI 3.1 document + Scalar API-reference UI for the **whole API surface**.
 *
 * Two tiers of fidelity:
 *  - Management API (`/api/*`): documented with PRECISE zod schemas via each
 *    router's `.openapi()` (status / tokens / config / logs / internal models /
 *    dry-run-truncate).
 *  - Everything else (OpenAI / Anthropic / Gemini / Azure compat, the
 *    request-history REST API, dry-run-pipeline, event-logging, health):
 *    documented with SIMPLE open-object schemas via `openAPIRegistry.registerPath`
 *    in `./openapi-compat` — pure docs, NO handler binding, so those plain-Hono
 *    routes keep working untouched. Vendor compat bodies mirror each provider's
 *    published contract; consult the vendor spec for field-level detail.
 *
 * Mechanism: `OpenAPIHono` collects `createRoute` definitions registered via
 * `.openapi()` on itself and on OpenAPIHono sub-apps mounted with `.route()`
 * (prefix applied), plus any path added directly to its `openAPIRegistry`.
 * `createServer` / `createFullTestApp` build the root app as
 * `OpenAPIHono`, mount the management routers (which are OpenAPIHono), then call
 * this to expose `GET /openapi.json` (3.1 doc) and `GET /docs` (Scalar UI).
 */

import type { OpenAPIHono } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"

import { Scalar } from "@scalar/hono-api-reference"

import packageJson from "../../package.json"
import { registerCompatPaths } from "./openapi-compat"

/** Spec endpoint (machine-readable OpenAPI 3.1 JSON). */
const OPENAPI_SPEC_PATH = "/openapi.json"

/** Interactive Scalar API-reference UI. */
const OPENAPI_DOCS_PATH = "/docs"

const OPENAPI_DESCRIPTION = [
  "Full API surface for copilot-api.",
  "",
  "The management API (/api/*) is documented with precise zod schemas. The OpenAI /",
  "Anthropic / Gemini / Azure compatibility endpoints, the request-history REST API",
  "(/history/api/*), and the diagnostic inspectors use SIMPLE (open-object) schemas —",
  "the vendor compat bodies mirror each provider's published contract, so consult the",
  "vendor's own spec for field-level request/response detail; here every endpoint is",
  "listed so the whole surface is discoverable.",
].join("\n")

/**
 * Register the aggregated management-API OpenAPI document + Scalar UI on the
 * given root app. Must run AFTER the management routers are mounted (so their
 * `.openapi()` definitions are present); the document is generated lazily per
 * request, so registration order is otherwise unconstrained.
 */
export function registerOpenApiDocs(app: OpenAPIHono<BlankEnv>): void {
  // Document the plain-Hono routes (compat / history / diagnostics) directly on
  // the registry — pure docs, no handler binding, so those routes keep working.
  registerCompatPaths(app.openAPIRegistry)

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
