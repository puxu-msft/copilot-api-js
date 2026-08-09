import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Database } from "~/lib/history/sqlite/connection"

import {
  //
  openDatabaseReadonly,
  openOwnedHistoryDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  closeHistoryReadDatabase,
  getHistoryReadDatabase,
  installHistoryReadDatabase,
} from "~/lib/history/sqlite/read-connection"

/**
 * `read-connection.ts` is unwired until Batch 2b. Spec §11.2 only allows unwired code to
 * land when a test really executes it, so these run the registry's whole state machine
 * rather than leaving `bun run typecheck` as its only guard.
 */
const tempDirs: Array<string> = []
const strayHandles: Array<Database> = []

afterEach(() => {
  closeHistoryReadDatabase()
  for (const handle of strayHandles.splice(0)) {
    try {
      handle.close()
    } catch {
      // Already closed by the registry; this loop only catches handles a test never installed.
    }
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function readonlyHandleOnDisk(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-read-connection-"))
  tempDirs.push(dir)
  const dbPath = path.join(dir, "history-v3.db")
  // The owner marker only exists once a write handle has created it.
  openOwnedHistoryDatabase(dbPath).close()
  const handle = openDatabaseReadonly(dbPath)
  strayHandles.push(handle)
  return handle
}

describe("main-thread History read connection registry", () => {
  test("publishes the installed handle and hands back the same object", () => {
    const handle = readonlyHandleOnDisk()

    installHistoryReadDatabase(handle)

    expect(getHistoryReadDatabase()).toBe(handle)
    // A real readonly handle, not an opaque token: it must still answer queries. The owner marker
    // is what `openOwnedHistoryDatabase` itself writes — the V3 tables belong to `ensureV3Schema`,
    // which this registry deliberately never runs.
    expect(getHistoryReadDatabase().prepare("SELECT owner FROM history_store_identity").get()).toEqual({ owner: "copilot-api-history-v3" })
  })

  test("refuses to replace a live handle instead of silently swapping owners", () => {
    const first = readonlyHandleOnDisk()
    const second = readonlyHandleOnDisk()
    installHistoryReadDatabase(first)

    expect(() => installHistoryReadDatabase(second)).toThrow(/already installed/)
    expect(getHistoryReadDatabase()).toBe(first)
  })

  test("installing the same handle twice is idempotent", () => {
    const handle = readonlyHandleOnDisk()
    installHistoryReadDatabase(handle)

    expect(() => installHistoryReadDatabase(handle)).not.toThrow()
    expect(getHistoryReadDatabase()).toBe(handle)
  })

  test("reading before install, and after close, is an error rather than a silent undefined", () => {
    expect(() => getHistoryReadDatabase()).toThrow(/not installed/)

    const handle = readonlyHandleOnDisk()
    installHistoryReadDatabase(handle)
    closeHistoryReadDatabase()

    expect(() => getHistoryReadDatabase()).toThrow(/not installed/)
    // Closing really closed it — the registry owns the lifetime, not just the reference.
    expect(() => handle.prepare("SELECT 1").get()).toThrow()
  })

  test("closing with nothing installed is a no-op", () => {
    expect(() => closeHistoryReadDatabase()).not.toThrow()
    expect(() => closeHistoryReadDatabase()).not.toThrow()
  })

  test("a reinstall after close is allowed", () => {
    const first = readonlyHandleOnDisk()
    installHistoryReadDatabase(first)
    closeHistoryReadDatabase()

    const second = readonlyHandleOnDisk()
    expect(() => installHistoryReadDatabase(second)).not.toThrow()
    expect(getHistoryReadDatabase()).toBe(second)
  })
})
