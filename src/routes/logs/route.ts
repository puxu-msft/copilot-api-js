/**
 * Live log endpoint — recent EntrySummary snapshot for the log viewer page.
 *
 * Returns the most recent entries (newest first, capped at `limit`).
 * After initial load, the web client subscribes to /ws
 * WebSocket for real-time `entry_added` / `entry_updated` events.
 */

import {
  //
  createRoute,
  OpenAPIHono,
  z,
} from "@hono/zod-openapi"

import {
  //
  getHistorySummaries,
  isHistoryEnabled,
} from "~/lib/history"

export const logsRoutes = new OpenAPIHono()

/** A single request-history summary row. Shape is runtime-dynamic (mirrors the
 *  history store's `EntrySummary`); described loosely to avoid drift. */
const EntrySummarySchema = z.record(z.string(), z.unknown()).openapi("EntrySummary")

const LogsResponseSchema = z
  .object({
    entries: z.array(EntrySummarySchema),
    total: z.number().int(),
  })
  .openapi("LogsResponse")

const LogsErrorSchema = z.object({ error: z.string() }).openapi("LogsError")

const getLogsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["logs"],
  summary: "Recent request-history summaries",
  request: {
    query: z.object({
      // Documented as a string (query params ARE strings) and NOT constrained:
      // the handler coerces + clamps (non-numeric/0 → 100, >500 → 500), so the
      // OpenAPI layer must not reject — `.openapi()` auto-validates declared
      // query schemas, and a numeric/min/max schema here would 400 inputs the
      // handler used to clamp to 200.
      limit: z.string().optional().openapi({ description: "Max rows; non-numeric or absent → 100, values >500 are capped to 500" }),
    }),
  },
  responses: {
    200: { description: "Newest-first entry summaries", content: { "application/json": { schema: LogsResponseSchema } } },
    400: { description: "History recording disabled", content: { "application/json": { schema: LogsErrorSchema } } },
  },
})

logsRoutes.openapi(getLogsRoute, (c) => {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  const limit = Math.min(Number(c.req.query("limit")) || 100, 500)
  const result = getHistorySummaries({ limit })

  return c.json({ entries: result.entries, total: result.total }, 200)
})
