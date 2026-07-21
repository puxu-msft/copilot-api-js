/**
 * Pure cursor-persistence primitives from the history-search sidecar daemon
 * (docs/plan/2026-07-21-history-search-out-of-process.md Phase 1) — no SQLite/native
 * module involved, hence `.unit.test.ts` (mirrors `tests/restart/pidfile.unit.test.ts`'s
 * treatment of its own atomic-write/never-throw-read primitive).
 */

import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  //
  readTailCursor,
  writeTailCursor,
} from "~/lib/history/search/daemon"

const dirs: Array<string> = []
function freshIndexDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "daemon-cursor-unit-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe("tail cursor persistence (pure, no SQLite/native involved)", () => {
  test("write -> read round-trips exactly", () => {
    const indexPath = freshIndexDir()
    writeTailCursor(indexPath, { committedAt: 42, operationId: "op-a" })
    expect(readTailCursor(indexPath)).toEqual({ committedAt: 42, operationId: "op-a" })
  })

  test("readTailCursor: missing file -> null (fresh index, tail from the start)", () => {
    expect(readTailCursor(freshIndexDir())).toBeNull()
  })

  test("readTailCursor: corrupt JSON -> null (never-throw)", () => {
    const indexPath = freshIndexDir()
    writeFileSync(join(indexPath, "tail-cursor.json"), "{not json")
    expect(readTailCursor(indexPath)).toBeNull()
  })

  test("readTailCursor: JSON present but missing/wrong-typed fields -> null", () => {
    const indexPath = freshIndexDir()
    writeFileSync(join(indexPath, "tail-cursor.json"), JSON.stringify({ committedAt: "not-a-number", operationId: "op-a" }))
    expect(readTailCursor(indexPath)).toBeNull()

    writeFileSync(join(indexPath, "tail-cursor.json"), JSON.stringify({ committedAt: 1 }))
    expect(readTailCursor(indexPath)).toBeNull()
  })

  test("writeTailCursor: creates the index directory if it does not exist yet, never-throws on a valid path", () => {
    const parent = freshIndexDir()
    const notYetCreated = join(parent, "nested", "index")
    expect(() => writeTailCursor(notYetCreated, { committedAt: 1, operationId: "op-a" })).not.toThrow()
    expect(readTailCursor(notYetCreated)).toEqual({ committedAt: 1, operationId: "op-a" })
  })

  test("writeTailCursor: overwrites a previous cursor rather than appending", () => {
    const indexPath = freshIndexDir()
    writeTailCursor(indexPath, { committedAt: 1, operationId: "op-a" })
    writeTailCursor(indexPath, { committedAt: 2, operationId: "op-b" })
    expect(readTailCursor(indexPath)).toEqual({ committedAt: 2, operationId: "op-b" })
  })
})
