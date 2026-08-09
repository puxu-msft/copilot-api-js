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
    // The retired V2 modules were `sqlite/{read,sessions-agg,stats,write}`, and the specifier must END there — the closing quote is what distinguishes them from a longer name that merely starts the same way. Without it this rejected `sqlite/read-connection`, the main thread's readonly handle introduced by the Batch 2b Worker cutover, which is the opposite of what the guard is for.
    expect(text).not.toMatch(/sqlite\/(read|sessions-agg|stats|write)["']/)
    // Guard the retired V2 APIs without rejecting the intentionally same-named
    // V3 summary-store query. Module provenance distinguishes the contracts;
    // a bare identifier regex cannot and produced a false red here.
    expect(text).not.toMatch(/\b(queryEntries|computeStats|deleteSession)\b/)
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
      // Same segment-terminator reasoning as the sessions guard above: reject the retired V2 modules, not every specifier that starts with their name.
      expect(text).not.toMatch(/history\/sqlite\/(read|sessions-agg|stats)["']/)
      expect(text).toMatch(/~\/lib\/history/)
    }
  })

  test("History search forwards to the out-of-process sidecar, never reads embedded V2 or V3 indexes directly", () => {
    const search = source("src/lib/history/search.ts")
    expect(search).not.toMatch(/\.\/sqlite\/(?:search-query|meta|connection)/)
    expect(search).not.toMatch(/searchV3OperationIds|containingV3OperationIds|v3\/store/)
    // Phase 4 cutover (history-search-out-of-process plan): search now forwards
    // through the sidecar's UDS client rather than returning a hardcoded empty
    // result — but it still never reaches into an embedded V2/V3 search index
    // directly (the two `not.toMatch` assertions above), only the sidecar's
    // never-throw client + the standard `getSummary` History facade.
    expect(search).toContain("getHistorySearchClient")
    expect(search).toContain("getSummary")

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
