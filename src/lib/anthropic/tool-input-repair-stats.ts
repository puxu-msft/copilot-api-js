/**
 * Malformed tool-input repair telemetry (P6).
 *
 * A tiny in-memory aggregate counter of repair OUTCOMES — exposed via
 * `/api/status.tool_input_repair`. Mirrors `protect-streaming-stats.ts`:
 * a live-observation counter (resets on restart), paired with the per-request
 * `recordFeature("tool-input-repaired" | "tool-input-unrepairable")` tags that
 * carry the same engagements into history. `strip` = fixed by the `tags` item
 * (antml tag strip), `unicode` = fixed by the `unicode` item (whitespace-broken
 * `\uXXXX` escape), `jsonrepair` = fixed by the `jsonrepair` item, `unicode-lossy`
 * = fixed by the LOSSY best-effort item (un-completable `\uXXXX` → U+FFFD; ≥1 char
 * garbled), `unrepairable` = no enabled item produced valid JSON (the request was
 * failed by the handler).
 */

import consola from "consola"

import type { RequestContext } from "~/lib/context/types"

/** Repair outcome buckets. */
export interface ToolInputRepairStats {
  /** Repaired by the `tags` item (structure-aware antml-tag stripping). */
  strip: number
  /** Repaired by the `unicode` item (whitespace-broken `\uXXXX` escape fix). */
  unicode: number
  /** Repaired by the `jsonrepair` item (jsonrepair). */
  jsonrepair: number
  /** Repaired by the LOSSY `unicode-lossy` item (un-completable `\uXXXX` → U+FFFD; ≥1 garbled char). */
  "unicode-lossy": number
  /** No enabled repair item could produce valid JSON. */
  unrepairable: number
}

export type ToolInputRepairOutcome = keyof ToolInputRepairStats

const stats: ToolInputRepairStats = { strip: 0, unicode: 0, jsonrepair: 0, "unicode-lossy": 0, unrepairable: 0 }

/** Record one repair outcome. */
export function recordToolInputRepair(outcome: ToolInputRepairOutcome): void {
  stats[outcome] += 1
}

/** Snapshot the current counters (for `/api/status`). */
export function getToolInputRepairStats(): ToolInputRepairStats {
  return { ...stats }
}

/** Test-only: reset the module-global counters (registered in RESETTERS). */
export function resetToolInputRepairStatsForTests(): void {
  stats.strip = 0
  stats.unicode = 0
  stats.jsonrepair = 0
  stats["unicode-lossy"] = 0
  stats.unrepairable = 0
}

/**
 * Flush the committed attempt's repair outcomes (`ctx.repairOutcomes`) to observability: the
 * aggregate counter + a per-request feature tag + the `[REWRITE]` log line. Called by the handler
 * at the committed settle point (NOT in the decode closure) so L2 buffered-retry discarded attempts
 * don't inflate the counts — `onAttemptReset` clears the per-attempt outcomes, so at settle only the
 * committed attempt's outcomes remain. Does NOT clear: the handler's fail-gate reads the derived
 * `ctx.unrepairableToolInput` after this, and the ctx is discarded post-request.
 */
export function flushToolInputRepairObservability(ctx: RequestContext): void {
  for (const r of ctx.repairOutcomes) {
    recordToolInputRepair(r.outcome)
    if (r.outcome === "unrepairable") {
      ctx.recordFeature("tool-input-unrepairable", { tool: r.tool })
    } else {
      ctx.recordFeature("tool-input-repaired", { tool: r.tool, layer: r.outcome, field: r.field })
      consola.info(`[REWRITE] tool-input-repair tool=${r.tool}${r.field ? ` field=${r.field}` : ""} layer=${r.outcome} ${r.beforeLength}→${r.afterLength}B`)
    }
  }
}
