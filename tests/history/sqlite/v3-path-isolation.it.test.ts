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

import { PATHS } from "~/lib/config/paths"
import {
  //
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { createDatabase } from "~/lib/history/sqlite/driver"
import {
  //
  initHistory,
  shutdownHistory,
} from "~/lib/history/state"
import { setHistoryConfig } from "~/lib/state"

const originalLegacyPath = PATHS.HISTORY_DB
const originalV3Path = PATHS.HISTORY_V3_DB
let dir: string | undefined

afterEach(async () => {
  await shutdownHistory()
  setHistoryConfig({ historyDbPath: "" })
  PATHS.HISTORY_DB = originalLegacyPath
  PATHS.HISTORY_V3_DB = originalV3Path
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe("History V3 physical isolation", () => {
  test("default initialization opens history-v3.db without reading or mutating legacy history.db", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-v3-path-"))
    PATHS.HISTORY_DB = path.join(dir, "history.db")
    PATHS.HISTORY_V3_DB = path.join(dir, "history-v3.db")
    const legacyBytes = Buffer.from("legacy-history-sentinel\n")
    fs.writeFileSync(PATHS.HISTORY_DB, legacyBytes)
    const legacyStat = fs.statSync(PATHS.HISTORY_DB)

    setHistoryConfig({ historyDbPath: "" })
    initHistory(true)

    const databases = getDatabase().prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>
    expect(databases.find((database) => database.name === "main")?.file).toBe(PATHS.HISTORY_V3_DB)
    expect(fs.readFileSync(PATHS.HISTORY_DB)).toEqual(legacyBytes)
    expect(fs.statSync(PATHS.HISTORY_DB).mtimeMs).toBe(legacyStat.mtimeMs)
    expect(fs.existsSync(PATHS.HISTORY_V3_DB)).toBe(true)
  })

  test("refuses an existing unowned database before schema reconciliation", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-v3-owner-"))
    const unowned = path.join(dir, "history.db")
    const legacy = createDatabase(unowned)
    legacy.exec("CREATE TABLE legacy_sentinel (value TEXT); INSERT INTO legacy_sentinel VALUES ('preserve-me')")
    legacy.close()
    const sentinel = fs.readFileSync(unowned)
    setHistoryConfig({ historyDbPath: unowned })

    expect(() => initHistory(true)).toThrow("refusing to open unowned existing database")
    expect(fs.readFileSync(unowned)).toEqual(sentinel)
    // Keep teardown idempotent after the expected init failure.
    openInMemoryDatabase()
  })
})
