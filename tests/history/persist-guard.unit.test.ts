import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  getHistoryPersistErrorStats,
  isTransientSqliteError,
  resetHistoryPersistErrorStats,
  runHistoryWrite,
} from "~/lib/history/persist-guard"

function sqliteError(message: string, code?: string): Error {
  const err = new Error(message)
  if (code) (err as { code?: string }).code = code
  return err
}

describe("history persist-guard", () => {
  afterEach(() => {
    resetHistoryPersistErrorStats()
  })

  describe("isTransientSqliteError", () => {
    test("classifies BUSY / LOCKED / IOERR (by code) as transient", () => {
      expect(isTransientSqliteError(sqliteError("x", "SQLITE_BUSY"))).toBe(true)
      expect(isTransientSqliteError(sqliteError("x", "SQLITE_LOCKED"))).toBe(true)
      expect(isTransientSqliteError(sqliteError("x", "SQLITE_IOERR_WRITE"))).toBe(true) // sub-code prefix
    })

    test("classifies BUSY / locked (by message) as transient when code is absent", () => {
      expect(isTransientSqliteError(sqliteError("database is locked"))).toBe(true)
      expect(isTransientSqliteError(sqliteError("disk I/O error"))).toBe(true)
    })

    test("classifies constraint / generic errors as permanent", () => {
      expect(isTransientSqliteError(sqliteError("FOREIGN KEY constraint failed", "SQLITE_CONSTRAINT"))).toBe(false)
      expect(isTransientSqliteError(sqliteError("string or blob too big", "SQLITE_TOOBIG"))).toBe(false)
      expect(isTransientSqliteError("not an error")).toBe(false)
    })
  })

  describe("runHistoryWrite", () => {
    test("returns ok on success and never bumps a counter", () => {
      const r = runHistoryWrite("finalize", () => {
        /* success */
      })
      expect(r).toEqual({ ok: true, transient: false })
      expect(getHistoryPersistErrorStats()).toEqual({})
    })

    test("swallows the throw, classifies, and counts by stage:class", () => {
      const r1 = runHistoryWrite("finalize", () => {
        throw sqliteError("database is locked", "SQLITE_BUSY")
      })
      expect(r1).toEqual({ ok: false, transient: true })

      const r2 = runHistoryWrite("stage", () => {
        throw sqliteError("FOREIGN KEY constraint failed", "SQLITE_CONSTRAINT")
      })
      expect(r2).toEqual({ ok: false, transient: false })

      expect(getHistoryPersistErrorStats()).toEqual({
        "finalize:transient": 1,
        "stage:permanent": 1,
      })
    })
  })
})
