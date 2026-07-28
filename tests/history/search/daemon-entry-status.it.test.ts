/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 3′ — `runHistorySearchDaemon`'s tail-progress status wiring (merged-state
 * review blocker 3, 2026-07-22). Drives the REAL process body in-process against a
 * short-lived `AbortSignal` (exactly as the module doc says
 * `daemon-entry.it.test.ts` should — the citty command wrapper itself is the thin,
 * untested-by-design process-lifecycle shim; this exercises everything else) with a
 * REAL on-disk db, REAL UDS server, and REAL native Tantivy index, so the status
 * a real operator would poll via `/api/status` is proven end to end, not just at
 * the wire-protocol level (see `uds-transport.it.test.ts`'s
 * `client.getTailStatus()` describe block for that layer).
 */

import {
  //
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import { isNativeHistorySearchAvailable } from "~/lib/history/search-native"
import { runHistorySearchDaemon } from "~/lib/history/search/daemon-entry"
import { createHistorySearchUdsClient } from "~/lib/history/search/uds-client"
import {
  //
  closeDatabase,
  openDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  commitPreparedOperation,
  prepareModelOperation,
} from "~/lib/history/v3/store"
import {
  //
  compressBytes,
  decompressBytes,
} from "~/lib/sqlite/compression"

import { primeUdsConnectForBunTest } from "../../helpers/prime-uds-for-bun-test"
import { waitUntil } from "../../helpers/wait-until"

// See prime-uds-for-bun-test.ts's doc comment.
beforeAll(primeUdsConnectForBunTest)

const tmpDirs: Array<string> = []
function freshDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function commitOperation(dbPath: string, id: string, needle: string): void {
  const db = openDatabase(dbPath)
  const recorder = createModelOperationRecorder({ identity: { operationId: id, kind: "generation", createdAt: 100 } })
  const payload = recorder.registerPayload({ messages: [{ role: "user", content: needle }] }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ request: { payload } })
  const attempt = recorder.beginAttempt({ effectiveRequest: { payload } })
  recorder.settleAttempt(attempt, { verdict: "committed" })
  recorder.recordEgress({ upstream: {}, client: {} })
  const record = recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt })
  commitPreparedOperation(db, prepareModelOperation(record))
  closeDatabase()
}

/** Poison a just-committed operation's manifest in place (same technique as
 *  store.it.test.ts / daemon.it.test.ts's blocker-1 regression). */
function poisonOperation(dbPath: string, id: string): void {
  const db = openDatabase(dbPath)
  const row = db.prepare("SELECT manifest_gz FROM v3_operations WHERE operation_id=?").get(id) as { manifest_gz: Uint8Array }
  const manifest = JSON.parse(new TextDecoder().decode(decompressBytes(row.manifest_gz))) as { formatVersion: number }
  manifest.formatVersion = 999
  db.prepare("UPDATE v3_operations SET manifest_gz=? WHERE operation_id=?").run(compressBytes(new TextEncoder().encode(JSON.stringify(manifest))), id)
  closeDatabase()
}

const activeControllers: Array<AbortController> = []
const activeDaemons: Array<Promise<void>> = []

/** Start `runHistorySearchDaemon` in-process (never a real OS process here -- see
 *  module doc) and return a controller to shut it down cleanly in `afterEach`. */
function startDaemon(options: { dbPath: string; socketPath: string; indexPath: string }): AbortController {
  const controller = new AbortController()
  activeControllers.push(controller)
  activeDaemons.push(runHistorySearchDaemon(options, controller.signal))
  return controller
}

afterEach(async () => {
  for (const controller of activeControllers.splice(0)) controller.abort()
  await Promise.allSettled(activeDaemons.splice(0))
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

// The native Tantivy `.node` is a gitignored build product and is no longer built by `bun install`
// (2026-07-28). These suites drive the real index, so they gate on its presence rather than fail:
// an environmental red is too easy to wave away as "pre-existing" — which is exactly what happened.
// Run them for real with `bun run build:history-search` first (CI's `test:ci` does).
const NATIVE = isNativeHistorySearchAvailable()

describe.skipIf(!NATIVE)("runHistorySearchDaemon's tail-progress status (merged-state review blocker 3, 2026-07-22)", () => {
  test("lastSuccessfulTailAt becomes non-null after the daemon's initial catch-up tail round, before any client search has ever been issued", async () => {
    const dbPath = path.join(freshDir("status-basic-db-"), "history-v3.db")
    const socketPath = path.join(freshDir("status-basic-sock-"), "history-search.sock")
    const indexPath = path.join(freshDir("status-basic-index-"), "index")

    commitOperation(dbPath, "status-basic-op", "statusBasicNeedle")
    startDaemon({ dbPath, socketPath, indexPath })

    const client = createHistorySearchUdsClient({ socketPath })
    await waitUntil(async () => typeof (await client.getTailStatus().catch(() => null))?.lastSuccessfulTailAt === "number", {
      timeout: 10_000,
      interval: 100,
      label: "daemon to complete its initial catch-up tail round",
    })

    const status = await client.getTailStatus()
    expect(status.lastSuccessfulTailAt).not.toBeNull()
    expect(status.lastSuccessfulTailAt).toBeLessThanOrEqual(Date.now())
    expect(status.poisonedCount).toBe(0)
    expect(status.lastTailError).toBeNull()
  })

  test("poisonedCount reflects a real poisoned row committed BEFORE the daemon starts (its initial catch-up tail must still isolate it, per B1)", async () => {
    const dbPath = path.join(freshDir("status-poison-db-"), "history-v3.db")
    const socketPath = path.join(freshDir("status-poison-sock-"), "history-search.sock")
    const indexPath = path.join(freshDir("status-poison-index-"), "index")

    commitOperation(dbPath, "status-poison-healthy", "statusPoisonHealthyNeedle")
    commitOperation(dbPath, "status-poison-bad", "statusPoisonBadNeedle")
    poisonOperation(dbPath, "status-poison-bad")

    startDaemon({ dbPath, socketPath, indexPath })

    const client = createHistorySearchUdsClient({ socketPath })
    await waitUntil(async () => typeof (await client.getTailStatus().catch(() => null))?.lastSuccessfulTailAt === "number", {
      timeout: 10_000,
      interval: 100,
      label: "daemon to complete its initial catch-up tail round",
    })

    const status = await client.getTailStatus()
    // THE CORE ASSERTION: an operator polling /api/status.history_search.tail can
    // SEE that something is being skipped -- not just "0 = everything is fine",
    // which is exactly the blind spot the review flagged (a wedged/lossy sidecar
    // would otherwise report `reachable: true` with nothing distinguishing it from
    // a genuinely healthy one).
    expect(status.poisonedCount).toBeGreaterThanOrEqual(1)
    expect(status.lastSuccessfulTailAt).not.toBeNull()

    // The healthy row is still findable (B1's actual guarantee -- this status
    // wiring is purely observational, never a substitute for B1's real fix).
    // The daemon's flush is debounced (FLUSH_IDLE_MS in daemon-entry.ts), so the
    // upsert being staged does not mean it is searchable yet -- poll for it.
    await waitUntil(async () => (await client.query("statusPoisonHealthyNeedle", undefined, 10)).length > 0, {
      timeout: 10_000,
      interval: 200,
      label: "the healthy row to become searchable once the debounced flush commits",
    })
    expect((await client.query("statusPoisonHealthyNeedle", undefined, 10)).map((hit) => hit.operationId)).toEqual(["status-poison-healthy"])
  }, 15_000)
})
