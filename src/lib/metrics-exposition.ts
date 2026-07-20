/**
 * `/metrics` — Prometheus text-exposition bridge over the telemetry registry.
 *
 * A purely generic projection of `DIMENSIONS × keys × counters` onto the
 * Prometheus text format (v0.0.4) — zero dependencies, no OpenTelemetry SDK. The
 * registry framework (see `request-telemetry.ts` + `observability/telemetry-dimensions.ts`)
 * makes this a mechanical fan-out: adding a dimension or a measure needs NO edit
 * here, because we iterate the registered dimension names and the open counters bag.
 *
 * **Source = `dimSinceStart` (process-lifetime cumulative).** Prometheus counters
 * are monotonic since process start; the 5min×7d rolling buckets are NOT (they
 * prune), so they'd violate counter semantics. A process restart resets the
 * counters — which is exactly the counter-reset Prometheus `rate()` already handles.
 *
 * **Cross-dimension semantics:** every settled request is counted under EVERY
 * dimension (model AND endpoint AND client AND agentKind AND tool), so the same
 * total appears once per dimension. They are PARALLEL views, not additive — a
 * scrape consumer filters by the `dimension` label and must NOT sum across
 * dimensions. This mirrors `/api/stats`. A leading comment in the output says so.
 */

import type {
  //
  DimensionBreakdownSnapshot,
  HistogramSummary,
} from "./request-telemetry"

import { TELEMETRY_DIMENSION_NAMES } from "./observability/telemetry-dimensions"
import {
  //
  getDimensionBreakdown,
  getRequestTelemetrySnapshot,
  TELEMETRY_HISTOGRAMS,
  TELEMETRY_MEASURE_NAMES,
} from "./request-telemetry"

/** Prometheus text exposition content-type (format version 0.0.4). */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"

const METRIC_PREFIX = "copilot_api_"
/** A high limit so the breakdown returns every key (no top-N folding); capped dims are already bounded at the cardinality cap + 1. */
const ALL_KEYS_LIMIT = 1_000_000

/** camelCase measure name → snake_case (requestCount → request_count, totalDurationMs → total_duration_ms). */
function toSnakeCase(name: string): string {
  return name.replaceAll(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)
}

/** Escape a Prometheus label value: backslash, double-quote, line-feed (the spec's reserved set), then strip the unescapable CR. */
function escapeLabelValue(value: string): string {
  return (
    value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', String.raw`\"`)
      .replaceAll("\n", String.raw`\n`)
      // `\r` has no escape sequence in the 0.0.4 format; left raw it would split line-oriented
      // tooling. Strip it (and only it — other chars are spec-legal inside a quoted value).
      .replaceAll("\r", "")
  )
}

/**
 * Format a counter value for the exposition. Prometheus accepts Go-style floats
 * (including JS exponential notation) but NOT the JS string `"Infinity"`; map the
 * non-finite cases to the spec literals so a poisoned value (a future float measure,
 * a bad upstream multiplier) still yields parseable output rather than a broken line.
 */
function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN"
  if (value === Infinity) return "+Inf"
  if (value === -Infinity) return "-Inf"
  return String(value)
}

/**
 * Render the Prometheus text exposition from per-dimension breakdowns + the global
 * accepted-request count. Pure (no module state) so it's directly unit-testable;
 * {@link buildMetricsExposition} is the wrapper that gathers live data.
 *
 * **Precondition**: `breakdowns` must carry DISTINCT dimension names, each with
 * distinct keys (the live caller satisfies this — `TELEMETRY_DIMENSION_NAMES` is
 * distinct and `getDimensionBreakdown` returns Map-derived keys). Duplicate
 * `(dimension,key)` pairs would emit duplicate sample lines (a strict-parser error).
 */
export function renderPrometheusMetrics(breakdowns: ReadonlyArray<DimensionBreakdownSnapshot>, acceptedSinceStart: number): string {
  const lines: Array<string> = [
    "# Each settled request is counted under EVERY dimension (model/endpoint/client/agentKind/tool);",
    "# filter by the `dimension` label and do NOT sum across dimensions (they are parallel views).",
  ]

  // Global accepted-request counter (no labels).
  const acceptedName = `${METRIC_PREFIX}accepted_requests_total`
  lines.push(
    `# HELP ${acceptedName} Requests accepted by the proxy since process start.`,
    `# TYPE ${acceptedName} counter`,
    `${acceptedName} ${formatValue(acceptedSinceStart)}`,
  )

  // One metric family per measure; samples carry {dimension,key} labels.
  for (const measure of TELEMETRY_MEASURE_NAMES) {
    const metricName = `${METRIC_PREFIX}${toSnakeCase(measure)}_total`
    const samples: Array<string> = []
    for (const breakdown of breakdowns) {
      const dimensionLabel = escapeLabelValue(breakdown.dimension)
      for (const entry of breakdown.keys) {
        const value = entry.counters[measure] ?? 0
        samples.push(`${metricName}{dimension="${dimensionLabel}",key="${escapeLabelValue(entry.key)}"} ${formatValue(value)}`)
      }
    }
    // Emit the family even with zero samples so scrapers see a stable schema.
    lines.push(`# HELP ${metricName} Cumulative ${measure} per (dimension,key) since process start.`, `# TYPE ${metricName} counter`, ...samples)
  }

  // Distribution histograms: standard Prometheus histogram (cumulative `_bucket{le}` +
  // `_sum` + `_count`) so scrapers compute quantiles via `histogram_quantile()`.
  for (const histogram of TELEMETRY_HISTOGRAMS) {
    const base = `${METRIC_PREFIX}${histogram.name}`
    const samples: Array<string> = []
    for (const breakdown of breakdowns) {
      const dimensionLabel = escapeLabelValue(breakdown.dimension)
      for (const entry of breakdown.keys) {
        const summary = entry.histograms[histogram.name] as HistogramSummary | undefined
        if (!summary) continue
        const labels = `dimension="${dimensionLabel}",key="${escapeLabelValue(entry.key)}"`
        let cumulative = 0
        for (let index = 0; index < summary.boundaries.length; index++) {
          cumulative += summary.buckets[index] ?? 0
          samples.push(`${base}_bucket{${labels},le="${formatValue(summary.boundaries[index])}"} ${cumulative}`)
        }
        cumulative += summary.buckets[summary.boundaries.length] ?? 0
        samples.push(
          `${base}_bucket{${labels},le="+Inf"} ${cumulative}`,
          `${base}_sum{${labels}} ${formatValue(summary.sum)}`,
          `${base}_count{${labels}} ${cumulative}`,
        )
      }
    }
    lines.push(`# HELP ${base} Distribution of ${histogram.name} per (dimension,key) since process start.`, `# TYPE ${base} histogram`, ...samples)
  }

  // Prometheus requires a trailing newline.
  return `${lines.join("\n")}\n`
}

/** Gather every registered dimension's process-lifetime breakdown + the accepted count, then render. */
export function buildMetricsExposition(now = Date.now()): string {
  const breakdowns = TELEMETRY_DIMENSION_NAMES.map((dimension) => getDimensionBreakdown(dimension, "sinceStart", ALL_KEYS_LIMIT, now))
  const acceptedSinceStart = getRequestTelemetrySnapshot(now).acceptedSinceStart
  return renderPrometheusMetrics(breakdowns, acceptedSinceStart)
}
