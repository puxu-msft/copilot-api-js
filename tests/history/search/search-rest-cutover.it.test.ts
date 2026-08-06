/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 4 — REST cutover, end-to-end: real HTTP request through the History
 * `handleSearch`/`handleSearchContains` handlers → the main process's UDS
 * client (`getHistorySearchClient()`, wired by `initHistory`) → a REAL
 * independently-running sidecar process (`history-search-daemon`, spawned
 * exactly as an operator/systemd would — mirroring
 * `daemon-service.it.test.ts`'s crash-isolation tests) tailing a REAL
 * on-disk `history-v3.db` and serving a REAL Tantivy index.
 *
 * Covers the plan's Phase 4 acceptance list:
 *  - `source=inbound` returns genuine search hits end to end over HTTP
 *  - any other `source` facet degrades to empty + `partial: true` (the
 *    sidecar's projection has no data for those facets — see search.ts)
 *  - an unreachable/absent sidecar degrades the SAME way (empty + partial),
 *    200 never 500, main process never crashes
 */

import {
  //
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { PATHS } from "~/lib/config/paths"
import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import { isNativeHistorySearchAvailable } from "~/lib/history/search-native"
import {
  //
  closeDatabase,
  openDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  initHistory,
  shutdownHistory,
  startHistoryBackfills,
} from "~/lib/history/state"
import {
  //
  commitPreparedOperation,
  prepareModelOperation,
} from "~/lib/history/v3/store"
import { setHistoryConfig } from "~/lib/state"
import {
  //
  handleGetEntries,
  handleSearch,
  handleSearchContains,
} from "~/routes/history/handler"

import { primeUdsConnectForBunTest } from "../../helpers/prime-uds-for-bun-test"
import { waitUntil } from "../../helpers/wait-until"

// See prime-uds-for-bun-test.ts's doc comment: this file's UDS interactions
// (through the real HTTP handler -> real UDS client) are exactly the
// `bun test`-only scenario that needs priming.
beforeAll(primeUdsConnectForBunTest)

const app = new Hono()
app.get("/api/entries", handleGetEntries)
app.get("/api/search", handleSearch)
app.get("/api/search/contains", handleSearchContains)

async function get(path: string): Promise<Response> {
  return app.request(path)
}
async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T
}

const tmpDirs: Array<string> = []
function freshDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** Commit one real, terminal operation through the production write path. */
function commitOperation(dbPath: string, id: string, needle: string): void {
  const db = openDatabase(dbPath)
  const recorder = createModelOperationRecorder({ identity: { operationId: id, kind: "generation", createdAt: 100 } })
  const payload = recorder.registerPayload({ messages: [{ role: "user", content: needle }] }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ format: "anthropic-messages", request: { payload } })
  const attempt = recorder.beginAttempt({ effectiveRequest: { payload } })
  recorder.settleAttempt(attempt, { verdict: "committed" })
  recorder.recordEgress({ upstream: {}, client: {} })
  const record = recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt })
  commitPreparedOperation(db, prepareModelOperation(record))
  closeDatabase()
}

const devEntryPath = path.resolve(import.meta.dir, "..", "..", "..", "packages", "cli", "src", "main.ts")

function spawnSidecar(args: ReadonlyArray<string>): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, devEntryPath, "history-search-daemon", ...args], { stdout: "ignore", stderr: "ignore" })
}

const spawnedChildren: Array<ReturnType<typeof Bun.spawn>> = []
const originalSocketPath = PATHS.HISTORY_SEARCH_SOCKET

afterEach(async () => {
  await shutdownHistory()
  setHistoryConfig({ historyDbPath: "" })
  PATHS.HISTORY_SEARCH_SOCKET = originalSocketPath
  for (const child of spawnedChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    await child.exited
  }
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

// The native Tantivy `.node` is a gitignored build product and is no longer built by `bun install`
// (2026-07-28). These suites drive the real index, so they gate on its presence rather than fail:
// an environmental red is too easy to wave away as "pre-existing" — which is exactly what happened.
// Run them for real with `bun run build:history-search` first (CI's `test:ci` does).
const NATIVE = isNativeHistorySearchAvailable()

describe.skipIf(!NATIVE)("GET /history/api/search — real end-to-end sidecar (Phase 4 cutover)", () => {
  test("GET entries?search traverses real HTTP -> UDS -> sidecar -> Tantivy and returns the narrow summary page", async () => {
    const dbDir = freshDir("search-list-cutover-db-")
    const dbPath = path.join(dbDir, "history-v3.db")
    const socketPath = path.join(freshDir("search-list-cutover-sock-"), "history-search.sock")
    const indexPath = path.join(freshDir("search-list-cutover-index-"), "index")

    commitOperation(dbPath, "list-cutover-op", "distinctiveListCutoverNeedle")
    commitOperation(dbPath, "list-nonmatch-op", "deliberatelyUnrelatedNeedle")
    PATHS.HISTORY_SEARCH_SOCKET = socketPath
    setHistoryConfig({ historyDbPath: dbPath })
    await initHistory(true)
    startHistoryBackfills()

    const sidecar = spawnSidecar(["--db", dbPath, "--socket", socketPath, "--index", indexPath])
    spawnedChildren.push(sidecar)

    await waitUntil(
      async () => {
        const res = await get("/api/entries?search=distinctiveListCutoverNeedle")
        if (res.status !== 200) return false
        const body = await json<{ entries: Array<{ id: string }> }>(res)
        return body.entries[0]?.id === "list-cutover-op"
      },
      { timeout: 15_000, interval: 200, label: "strict list-search sidecar to cover the frozen target" },
    )

    const res = await get("/api/entries?search=distinctiveListCutoverNeedle")
    expect(res.status).toBe(200)
    expect(await json<{ entries: Array<{ id: string }>; total: number }>(res)).toMatchObject({ entries: [{ id: "list-cutover-op" }], total: 1 })
  }, 20_000)

  test("source=inbound with a reachable sidecar returns genuine hits, mapped to full EntrySummary rows", async () => {
    const dbDir = freshDir("search-cutover-db-")
    const dbPath = path.join(dbDir, "history-v3.db")
    const socketPath = path.join(freshDir("search-cutover-sock-"), "history-search.sock")
    const indexPath = path.join(freshDir("search-cutover-index-"), "index")

    commitOperation(dbPath, "cutover-op", "distinctiveCutoverNeedle")

    // Point BOTH sides at the same temp paths: the main process's client (via
    // PATHS.HISTORY_SEARCH_SOCKET, read by initHistory) and the sidecar we spawn.
    PATHS.HISTORY_SEARCH_SOCKET = socketPath
    setHistoryConfig({ historyDbPath: dbPath })
    await initHistory(true)

    const sidecar = spawnSidecar(["--db", dbPath, "--socket", socketPath, "--index", indexPath])
    spawnedChildren.push(sidecar)

    await waitUntil(
      async () => {
        const res = await get("/api/search?source=inbound&q=distinctiveCutoverNeedle")
        const body = await json<{ rows: Array<unknown> }>(res)
        return body.rows.length > 0
      },
      { timeout: 15_000, interval: 200, label: "sidecar to tail and serve the query over real HTTP" },
    )

    const res = await get("/api/search?source=inbound&q=distinctiveCutoverNeedle")
    expect(res.status).toBe(200)
    const body = await json<{
      rows: Array<{ ownerReqId: string; source: string; snippet: string; summary: { id: string } }>
      nextCursor: null
      partial: boolean
    }>(res)
    expect(body.partial).toBe(false)
    expect(body.nextCursor).toBeNull()
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]?.ownerReqId).toBe("cutover-op")
    expect(body.rows[0]?.source).toBe("inbound")
    expect(body.rows[0]?.summary.id).toBe("cutover-op")
    expect(typeof body.rows[0]?.snippet).toBe("string")
  }, 20_000)

  test("a facet other than inbound returns empty + partial even with a reachable sidecar (projection has no data for it)", async () => {
    const dbDir = freshDir("search-cutover-facet-db-")
    const dbPath = path.join(dbDir, "history-v3.db")
    const socketPath = path.join(freshDir("search-cutover-facet-sock-"), "history-search.sock")
    const indexPath = path.join(freshDir("search-cutover-facet-index-"), "index")

    commitOperation(dbPath, "facet-op", "facetNeedle")

    PATHS.HISTORY_SEARCH_SOCKET = socketPath
    setHistoryConfig({ historyDbPath: dbPath })
    await initHistory(true)

    const sidecar = spawnSidecar(["--db", dbPath, "--socket", socketPath, "--index", indexPath])
    spawnedChildren.push(sidecar)

    // Confirm the sidecar really is reachable and indexing (inbound works)...
    await waitUntil(
      async () => {
        const res = await get("/api/search?source=inbound&q=facetNeedle")
        const body = await json<{ rows: Array<unknown> }>(res)
        return body.rows.length > 0
      },
      { timeout: 15_000, interval: 200, label: "sidecar to index the fixture" },
    )

    // ...yet a non-inbound facet still returns empty + partial (unsupported, not "no matches").
    const res = await get("/api/search?source=rewrites-req&q=facetNeedle")
    expect(res.status).toBe(200)
    expect(await json<{ rows: Array<unknown>; partial: boolean }>(res)).toMatchObject({ rows: [], partial: true })
  }, 20_000)

  test("an unreachable sidecar (no process listening) degrades to empty + partial — 200, never 500", async () => {
    const dbDir = freshDir("search-cutover-unreachable-db-")
    const dbPath = path.join(dbDir, "history-v3.db")
    // A socket path that nothing is listening on -- no sidecar spawned at all.
    const socketPath = path.join(freshDir("search-cutover-unreachable-sock-"), "history-search.sock")

    PATHS.HISTORY_SEARCH_SOCKET = socketPath
    setHistoryConfig({ historyDbPath: dbPath })
    await initHistory(true)

    const res = await get("/api/search?source=inbound&q=anything")
    expect(res.status).toBe(200)
    expect(await json<{ rows: Array<unknown>; partial: boolean }>(res)).toMatchObject({ rows: [], partial: true })
  })

  test("History disabled still 400s before ever touching the sidecar client", async () => {
    await shutdownHistory()
    const res = await get("/api/search?source=inbound&q=anything")
    expect(res.status).toBe(400)
  })
})
