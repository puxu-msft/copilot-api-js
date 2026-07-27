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
 *     buckets + per-key series) | `30d` | `90d` | `lifetime`. Default `7d`.
 *   - `limit` — server-side top-N; the remainder folds into `"other"`. Default 20.
 *
 * **Window → tier routing (P5, byte-compat invariant 8)**: `sinceStart`/`7d` are
 * UNCHANGED — they still read the in-memory `getDimensionBreakdown` verbatim, byte
 * for byte, exactly as before this task. `30d`/`90d`/`lifetime` are net-new: they
 * read the SQLite tiered store (`~/lib/telemetry/read.ts`) instead — `lifetime` from
 * `tel_cumulative` (permanent, no time dimension), `30d`/`90d` from `tel_hourly` when
 * the window fits within `state.telemetryHourlyRetentionDays`, else `tel_daily`
 * (spec §rollup 语义: one fully-covering tier per query, never cross-tier stitching).
 * These SQLite-backed windows additionally carry a `distributions` field per key —
 * DDSketch-derived percentile summaries (`duration_ms`/`queue_wait_ms`/`input_tokens`/
 * `output_tokens`) absent from the in-memory windows (which have no sketch data).
 */

import {
  //
  createRoute,
  OpenAPIHono,
  z,
} from "@hono/zod-openapi"

import {
  //
  DEFAULT_BREAKDOWN_LIMIT,
} from "~/lib/request-telemetry"
import { state } from "~/lib/state"
import { TELEMETRY_DIMENSION_NAMES } from "~/lib/telemetry-dimension-names"
import { getTelemetryRuntime } from "~/lib/telemetry-runtime"
import {
  //
  type DistributionSummary,
  readCumulativeBreakdown,
  readCumulativeSketchQuantiles,
  readJsonBackfillBoundaryTs,
  readTierBreakdown,
  readTierSketchQuantiles,
  type TierKeyCounters,
} from "~/lib/telemetry/read"

export const statsRoutes = new OpenAPIHono()

const DistributionSummarySchema = z.object({
  count: z.number(),
  sum: z.number(),
  min: z.number(),
  max: z.number(),
  p50: z.number(),
  p90: z.number(),
  p95: z.number(),
  p99: z.number(),
})

/**
 * The breakdown shape is generic (the `counters` bag is open — includes the
 * per-token cost measures when present), so it's documented as an open object
 * to avoid schema drift as measures/dimensions evolve. See request-telemetry.ts
 * `DimensionBreakdownSnapshot` for the concrete `sinceStart`/`7d` shape.
 *
 * `series`/`distributions`/`constituentKeys` are mutually near-exclusive in practice
 * (memory windows populate `series`; SQLite-tiered windows populate `distributions` +
 * `constituentKeys` instead) but declared optional rather than as a discriminated union
 * to keep this schema documentation-only and additive — this project's zod response
 * schemas are NOT runtime-enforced (OpenAPI docs only), so widening it here cannot
 * regress the actual bytes returned by the untouched `sinceStart`/`7d` path.
 */
const DimensionBreakdownSchema = z
  .object({
    dimension: z.string(),
    window: z.string().openapi({ description: "sinceStart | 7d | 30d | 90d | lifetime" }),
    bucketSizeMinutes: z.number(),
    windowDays: z.number(),
    totalKeys: z.number().int().openapi({ description: "Distinct key count before top-N truncation" }),
    truncated: z.boolean(),
    preMigrationSketchGap: z.boolean().optional().openapi({
      description:
        "SQLite-tiered windows only (30d/90d/lifetime). True when the window spans the pre-migration era: legacy request-telemetry.json history was absorbed into telemetry.db WITHOUT sketch data (the old fixed buckets can't losslessly rebuild DDSketch), so per-key `distributions` for that era are absent — this flag distinguishes 'no sketch precision before migration' from 'genuinely no observations'. Scalar counters are fully absorbed and exact regardless.",
    }),
    keys: z.array(
      z.object({
        key: z.string(),
        counters: z.record(z.string(), z.number()),
        series: z.array(z.object({ timestamp: z.number(), counters: z.record(z.string(), z.number()) })).optional(),
        distributions: z.record(z.string(), DistributionSummarySchema).optional().openapi({
          description:
            "SQLite-tiered windows only (30d/90d/lifetime) — DDSketch-derived percentile distributions per measure. Absent for sinceStart/7d (no sketch data in the in-memory path) and omitted per-measure when that measure has zero observations in the window.",
        }),
        constituentKeys: z.array(z.string()).optional().openapi({
          description:
            'SQLite-tiered windows only — the raw key names folded into this row (diagnostic). A normal row lists just itself; the synthetic "other" row lists every key folded into it (including a pre-existing cardinality-cap "other" row, if any).',
        }),
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
      window: z.enum(["sinceStart", "7d", "30d", "90d", "lifetime"]).optional().openapi({ description: "Time window (default 7d)" }),
      limit: z.coerce.number().int().positive().max(1000).optional().openapi({ description: "Top-N keys (default 20)" }),
    }),
  },
  responses: {
    200: { description: "Dimension breakdown", content: { "application/json": { schema: DimensionBreakdownSchema } } },
    400: {
      description: "Unknown or missing dimension",
      content: { "application/json": { schema: z.object({ error: z.string(), dimensions: z.array(z.string()) }) } },
    },
    500: {
      description: "SQLite-tiered read failed (corrupt sketch blob, γ mismatch, …) — 30d/90d/lifetime windows only",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
    503: {
      description: "telemetry SQLite store unavailable (telemetry disabled or db not yet initialized) — 30d/90d/lifetime windows only",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
  },
})

/** Project a `TierKeyCounters` row + its sketch distributions into the response key shape. */
function toResponseKey(
  entry: TierKeyCounters,
  distributions: Record<string, DistributionSummary>,
): { key: string; counters: Record<string, number>; distributions: Record<string, DistributionSummary>; constituentKeys: Array<string> } {
  return { key: entry.key, counters: entry.counters, distributions, constituentKeys: [...entry.constituentKeys] }
}

statsRoutes.openapi(getStatsRoute, (c) => {
  const { dimension, window, limit } = c.req.valid("query")
  if (!TELEMETRY_DIMENSION_NAMES.includes(dimension)) {
    return c.json({ error: `unknown dimension "${dimension}"`, dimensions: [...TELEMETRY_DIMENSION_NAMES] }, 400)
  }

  const effectiveWindow = window ?? "7d"

  // sinceStart/7d: UNCHANGED in-memory path — byte-compat invariant 8, this task never touches it.
  // Passes `limit` through exactly as before (possibly `undefined`, letting getDimensionBreakdown's
  // own default param apply) rather than pre-resolving it, to keep this call expression identical
  // to the pre-task code.
  if (effectiveWindow === "sinceStart" || effectiveWindow === "7d") {
    return c.json(getTelemetryRuntime().getDimensionBreakdown(dimension, effectiveWindow, limit), 200)
  }

  const effectiveLimit = limit ?? DEFAULT_BREAKDOWN_LIMIT

  // 30d/90d/lifetime: net-new SQLite-tiered path.
  const db = getTelemetryRuntime().getTelemetryDb()
  if (!db) {
    return c.json({ error: "telemetry SQLite store unavailable (telemetry disabled or db not yet initialized)" }, 503)
  }

  try {
    const now = Date.now()
    // Migration boundary (tel_meta['json_backfill_boundary_ts']): timestamp the legacy JSON was absorbed.
    // Buckets before it carry fully-absorbed scalar counters but NO sketch data (see readJsonBackfillBoundaryTs).
    const migrationBoundary = readJsonBackfillBoundaryTs(db)

    if (effectiveWindow === "lifetime") {
      const breakdown = readCumulativeBreakdown(db, dimension, effectiveLimit)
      const keys = breakdown.keys.map((entry) => toResponseKey(entry, readCumulativeSketchQuantiles(db, dimension, entry.constituentKeys)))
      // lifetime has no time-bucket concept (tel_cumulative carries no bucket dimension) — 0/0 are
      // documented sentinels, not "no data" (contrast with sinceStart/7d, where these are real values).
      // The cumulative seed includes pre-migration history with no sketch precision → gap whenever a
      // migration ran at all.
      return c.json(
        {
          dimension,
          window: effectiveWindow,
          bucketSizeMinutes: 0,
          windowDays: 0,
          totalKeys: breakdown.totalKeys,
          truncated: breakdown.truncated,
          preMigrationSketchGap: migrationBoundary !== null,
          keys,
        },
        200,
      )
    }

    const windowDays = effectiveWindow === "30d" ? 30 : 90
    const tier = windowDays <= state.telemetryHourlyRetentionDays ? "tel_hourly" : "tel_daily"
    const sinceTs = now - windowDays * 24 * 60 * 60 * 1000
    const breakdown = readTierBreakdown(db, dimension, tier, sinceTs, now, effectiveLimit)
    const keys = breakdown.keys.map((entry) => toResponseKey(entry, readTierSketchQuantiles(db, dimension, tier, entry.constituentKeys, sinceTs, now)))
    return c.json(
      {
        dimension,
        window: effectiveWindow,
        bucketSizeMinutes: tier === "tel_hourly" ? 60 : 24 * 60,
        windowDays,
        totalKeys: breakdown.totalKeys,
        truncated: breakdown.truncated,
        // Gap only when the window's start reaches back before the migration boundary (its early buckets
        // lack sketch data). A window entirely after migration has full sketch coverage → no gap.
        preMigrationSketchGap: migrationBoundary !== null && sinceTs < migrationBoundary,
        keys,
      },
      200,
    )
  } catch (error) {
    // never-throw route surface (红线): a structural read failure (corrupt blob, γ mismatch fail-loud
    // from mergeSketch, …) becomes a 500, not an unhandled crash — see read.ts's never-throw docstring.
    return c.json({ error: `telemetry SQLite read failed: ${error instanceof Error ? error.message : String(error)}` }, 500)
  }
})
