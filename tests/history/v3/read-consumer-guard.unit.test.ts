import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const source = (path: string): string => readFileSync(join(ROOT, path), "utf8")

describe("History V3 read-consumer cutover guard", () => {
  test("sessions facade has no V2 query, aggregate, stats, or delete dependency", () => {
    const text = source("src/lib/history/sessions.ts")
    expect(text).not.toMatch(/sqlite\/(read|sessions-agg|stats|write)/)
    expect(text).not.toMatch(/\b(queryEntries|querySessionSummaries|computeStats|deleteSession)\b/)
    expect(text).toContain("visitV3StoredOperations")
    expect(text).toContain("recordToHistoryEntry")
  })

  test("logs, debug, hook replay, and Responses rebuild consume the V3 history facade", () => {
    for (const path of [
      "src/routes/logs/route.ts",
      "src/routes/debug/route.ts",
      "src/routes/debug/dry-run-pipeline.ts",
      "src/lib/pipeline/hooks/toolkit.ts",
      "src/routes/responses/conversation-rebuild.ts",
    ]) {
      const text = source(path)
      expect(text).not.toMatch(/history\/sqlite\/(read|sessions-agg|stats)/)
      expect(text).toMatch(/~\/lib\/history/)
    }
  })

  test("V3 search and calibration startup never read legacy V2 indexes", () => {
    const search = source("src/lib/history/search.ts")
    expect(search).not.toMatch(/\.\/sqlite\/(?:search-query|meta|connection)/)
    expect(search).toMatch(/searchV3OperationIds/)

    const state = source("src/lib/history/state.ts")
    expect(state).not.toMatch(/runCalibrationBackfill|runSearchIndexBackfill|runLegacyStageBackfill|runUsageNormalizeBackfill/)
    expect(state).toMatch(/History V3 does not run V2 backfills/)
  })

  test("public History barrels expose no destructive persisted-row primitive", () => {
    for (const path of ["src/lib/history/index.ts", "src/lib/history/store.ts"]) {
      const text = source(path)
      expect(text).not.toMatch(/\bdeleteSession\b|\bdeleteEntries\b/)
    }
  })
})
