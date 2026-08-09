import type { Database } from "./connection"

/**
 * Main-thread READONLY History handle for the write-first migration stage.
 *
 * The Worker owns the semantic write connection; the main thread keeps one independent
 * readonly handle so History queries keep working before the Batch 6 query-RPC cutover.
 * This registry deliberately does nothing but hold that handle: no schema reconcile, no
 * migration, no ANALYZE/VACUUM, no maintenance. Those are writes, and a second writer
 * against the same artifact is exactly what this whole migration exists to remove.
 *
 * The handle must come from `openDatabaseReadonly()`, which is physically incapable of
 * the writes above. This module is installed in Batch 2b and deleted in Batch 6c, when
 * the Worker becomes the sole owner of the semantic database.
 */
let readDatabase: Database | undefined

/** Publish the process-wide readonly handle. Refuses to silently replace a live one. */
export function installHistoryReadDatabase(database: Database): void {
  if (readDatabase && readDatabase !== database) {
    throw new Error("[history/sqlite] a History read database is already installed; close it before installing another")
  }
  readDatabase = database
}

export function getHistoryReadDatabase(): Database {
  if (!readDatabase) throw new Error("[history/sqlite] History read database is not installed")
  return readDatabase
}

/** Whether a readonly handle is currently published. Lets `initHistory` tell "already brought up" from "a test detached my handle". */
export function peekHistoryReadDatabase(): Database | undefined {
  return readDatabase
}

/**
 * Forget the published handle WITHOUT closing it.
 *
 * For tests whose read handle is owned by someone else — `openInMemoryDatabase()` publishes the write singleton so the app's read paths resolve against the same in-memory database the test is populating, and that singleton is closed by `closeDatabase()`, not here. Closing it twice would be the bug this exists to avoid.
 */
export function detachHistoryReadDatabaseForTests(): void {
  readDatabase = undefined
}

export function closeHistoryReadDatabase(): void {
  const database = readDatabase
  readDatabase = undefined
  database?.close()
}
