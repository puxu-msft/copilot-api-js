import consola from "consola"

import { getDatabase } from "./connection"

let timer: ReturnType<typeof setInterval> | null = null

export function runReaperOnce(limit: number): number {
  if (limit <= 0) return 0
  const db = getDatabase()
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM entries_v2").get() as { n: number }
  if (n <= limit) return 0
  const excess = n - limit
  const result = db
    .prepare(
      `DELETE FROM entries_v2 WHERE id IN (
         SELECT id FROM entries_v2 ORDER BY started_at ASC LIMIT ?
       )`,
    )
    .run(excess)
  const deleted = result.changes
  if (deleted > 0) consola.info(`[history/sqlite] reaper evicted ${deleted} entries (limit=${limit})`)
  return deleted
}

export function startReaper(limit: number, intervalSeconds: number): void {
  stopReaper()
  if (intervalSeconds <= 0 || limit <= 0) return
  timer = setInterval(() => {
    try {
      runReaperOnce(limit)
    } catch (err: unknown) {
      consola.warn("[history/sqlite] reaper tick failed", err)
    }
  }, intervalSeconds * 1000)
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    ;(timer as { unref: () => void }).unref()
  }
}

export function stopReaper(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
