/**
 * Operational stats endpoint — `GET /api/stats`.
 *
 * Generic per-dimension breakdown over the persistent telemetry registry
 * (model / endpoint / client / agentKind / tool / any future dimension). Kept
 * OFF the health-poll `/api/status` (which carries only the model summary) so
 * adding dimensions never bloats the frequently-polled status payload.
 *
 * Query params:
 *   - `dimension` (required) — one of the registered dimension names.
 *   - `window` — `sinceStart` (process-lifetime cumulative) | `7d` (rolling
 *     buckets + per-key series). Default `7d`.
 *   - `limit` — server-side top-N; the remainder folds into `"other"`. Default 20.
 */

import {
  //
  createRoute,
  OpenAPIHono,
  z,
} from "@hono/zod-openapi"

import { TELEMETRY_DIMENSION_NAMES } from "~/lib/observability/telemetry-dimensions"
import { getDimensionBreakdown } from "~/lib/request-telemetry"

export const statsRoutes = new OpenAPIHono()

/**
 * The breakdown shape is generic (the `counters` bag is open — includes the
 * per-token cost measures when present), so it's documented as an open object
 * to avoid schema drift as measures/dimensions evolve. See request-telemetry.ts
 * `DimensionBreakdownSnapshot` for the concrete shape.
 */
const DimensionBreakdownSchema = z
  .object({
    dimension: z.string(),
    window: z.string().openapi({ description: "sinceStart | 7d" }),
    bucketSizeMinutes: z.number(),
    windowDays: z.number(),
    totalKeys: z.number().int().openapi({ description: "Distinct key count before top-N truncation" }),
    truncated: z.boolean(),
    keys: z.array(
      z.object({
        key: z.string(),
        counters: z.record(z.string(), z.number()),
        series: z.array(z.object({ timestamp: z.number(), counters: z.record(z.string(), z.number()) })),
      }),
    ),
  })
  .openapi("DimensionBreakdown")

const getStatsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["status"],
  summary: "Operational stats — per-dimension telemetry breakdown",
  description: "Generic top-N breakdown for a registered telemetry dimension (model/endpoint/client/agentKind/tool/…). Overflow folds into an `other` key.",
  request: {
    query: z.object({
      dimension: z.string().openapi({ description: `Registered dimension name (${TELEMETRY_DIMENSION_NAMES.join(" | ")})`, example: "agentKind" }),
      window: z.enum(["sinceStart", "7d"]).optional().openapi({ description: "Time window (default 7d)" }),
      limit: z.coerce.number().int().positive().max(1000).optional().openapi({ description: "Top-N keys (default 20)" }),
    }),
  },
  responses: {
    200: { description: "Dimension breakdown", content: { "application/json": { schema: DimensionBreakdownSchema } } },
    400: {
      description: "Unknown or missing dimension",
      content: { "application/json": { schema: z.object({ error: z.string(), dimensions: z.array(z.string()) }) } },
    },
  },
})

statsRoutes.openapi(getStatsRoute, (c) => {
  const { dimension, window, limit } = c.req.valid("query")
  if (!TELEMETRY_DIMENSION_NAMES.includes(dimension)) {
    return c.json({ error: `unknown dimension "${dimension}"`, dimensions: [...TELEMETRY_DIMENSION_NAMES] }, 400)
  }
  return c.json(getDimensionBreakdown(dimension, window ?? "7d", limit), 200)
})
