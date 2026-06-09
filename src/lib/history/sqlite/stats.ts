import type { HistoryStats } from "~/lib/history/types"

import {
  //
  getDatabase,
  isDatabaseOpen,
} from "./connection"

const EMPTY_STATS: HistoryStats = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  averageDurationMs: 0,
  modelDistribution: {},
  endpointDistribution: {},
  recentActivity: [],
  activeSessions: 0,
}

export function computeStats(): HistoryStats {
  if (!isDatabaseOpen()) return EMPTY_STATS
  const db = getDatabase()

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed,
              COALESCE(SUM(input_tokens), 0)  AS total_input,
              COALESCE(SUM(output_tokens), 0) AS total_output,
              COALESCE(AVG(duration_ms), 0)   AS avg_duration
         FROM entries_v2`,
    )
    .get() as {
    total: number
    completed: number | null
    failed: number | null
    total_input: number
    total_output: number
    avg_duration: number
  }

  const perModel = db
    .prepare(
      `SELECT model, COUNT(*) AS count
         FROM entries_v2 WHERE model IS NOT NULL GROUP BY model`,
    )
    .all() as Array<{ model: string; count: number }>

  const perEndpoint = db
    .prepare(
      `SELECT endpoint, COUNT(*) AS count
         FROM entries_v2 WHERE endpoint IS NOT NULL GROUP BY endpoint`,
    )
    .all() as Array<{ endpoint: string; count: number }>

  const hourly = db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:00:00Z', started_at / 1000, 'unixepoch') AS hour,
              COUNT(*) AS count
         FROM entries_v2
        WHERE started_at >= ?
        GROUP BY hour
        ORDER BY hour ASC`,
    )
    .all(Date.now() - 24 * 60 * 60 * 1000) as Array<{ hour: string; count: number }>

  const activeSessions = db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }

  const modelDistribution: Record<string, number> = {}
  for (const m of perModel) modelDistribution[m.model] = m.count

  const endpointDistribution: Record<string, number> = {}
  for (const e of perEndpoint) endpointDistribution[e.endpoint] = e.count

  return {
    totalRequests: totals.total,
    successfulRequests: totals.completed ?? 0,
    failedRequests: totals.failed ?? 0,
    totalInputTokens: totals.total_input,
    totalOutputTokens: totals.total_output,
    averageDurationMs: Math.round(totals.avg_duration),
    modelDistribution,
    endpointDistribution,
    recentActivity: hourly,
    activeSessions: activeSessions.n,
  }
}
