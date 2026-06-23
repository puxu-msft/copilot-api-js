/**
 * `GET /metrics` — Prometheus text-exposition endpoint.
 *
 * Always-on (the token/cost/request counters it exposes are already public via
 * `/api/stats`, so it adds no new exposure; an idle endpoint costs nothing). Plain
 * Hono (not OpenAPIHono) because it returns `text/plain` exposition, not JSON; it
 * is documented for discoverability via `openapi-compat.ts`.
 */

import { Hono } from "hono"

import {
  //
  buildMetricsExposition,
  PROMETHEUS_CONTENT_TYPE,
} from "~/lib/metrics-exposition"

export const metricsRoutes = new Hono()

metricsRoutes.get("/", (c) => c.body(buildMetricsExposition(), 200, { "content-type": PROMETHEUS_CONTENT_TYPE }))
