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

import {
  //
  closeDatabase,
  openDatabase,
  openDatabaseReadonly,
} from "~/lib/history/sqlite/connection"
import { projectSearchableText } from "~/lib/history/v3/projection"
import {
  //
  getV3StoredOperation,
  hydrateManifest,
  listV3StoredOperations,
  visitV3Summaries,
} from "~/lib/history/v3/store"

const FIXTURE_DIR = path.join(import.meta.dir, "fixtures", "transport-evidence")
const tmpDirs: Array<string> = []

function copyFixture(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-v3-legacy-fixture-"))
  tmpDirs.push(dir)
  const target = path.join(dir, "history-v3.db")
  fs.copyFileSync(path.join(FIXTURE_DIR, name), target)
  return target
}

function digestMap(db: ReturnType<typeof openDatabaseReadonly>): Map<string, string> {
  return new Map(
    (db.prepare("SELECT operation_id,digest FROM v3_operations ORDER BY operation_id").all() as Array<{ operation_id: string; digest: string }>).map((row) => [
      row.operation_id,
      row.digest,
    ]),
  )
}

afterEach(() => {
  closeDatabase()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("real History V3 legacy SQLite fixtures", () => {
  for (const fixture of [
    { file: "schema5-manifest-v1.db", ids: ["fixture-v1"] },
    { file: "schema5-manifest-v2-shared.db", ids: ["fixture-v2-a", "fixture-v2-b"] },
  ] as const) {
    test(`${fixture.file} remains readable through detail, readonly/search, summary, and direct hydrate`, () => {
      const dbPath = copyFixture(fixture.file)
      const writable = openDatabase(dbPath)
      const before = digestMap(writable)
      expect(writable.prepare("SELECT value FROM v3_meta WHERE key='schema_version'").get()).toEqual({ value: "5" })
      expect(writable.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='v3_transport_evidence'").get()).toBeNull()
      closeDatabase()

      const readonly = openDatabaseReadonly(dbPath)
      expect(
        listV3StoredOperations("generation", 100, readonly)
          .map(({ record }) => record.identity.operationId)
          .sort(),
      ).toEqual([...fixture.ids].sort())
      for (const id of fixture.ids) {
        const stored = getV3StoredOperation(id, readonly)
        expect(stored?.record.identity.operationId).toBe(id)
        expect(projectSearchableText(stored!.record)).toContain("shared payload")
        const row = readonly.prepare("SELECT manifest_gz FROM v3_operations WHERE operation_id=?").get(id) as { manifest_gz: Uint8Array }
        expect(hydrateManifest(readonly, row.manifest_gz, id).identity.operationId).toBe(id)
      }
      readonly.close()

      openDatabase(dbPath)
      const summaries: Array<string> = []
      visitV3Summaries((summary) => summaries.push(summary.id))
      expect(summaries.sort()).toEqual([...fixture.ids].sort())
      expect(digestMap(openDatabaseReadonly(dbPath))).toEqual(before)
    })
  }

  test("manifest-v2 fixture physically shares payload sequence objects across operations", () => {
    const dbPath = copyFixture("schema5-manifest-v2-shared.db")
    const readonly = openDatabaseReadonly(dbPath)
    expect((readonly.prepare("SELECT COUNT(*) AS n FROM v3_operations").get() as { n: number }).n).toBe(2)
    expect((readonly.prepare("SELECT COUNT(*) AS n FROM v3_objects WHERE kind='sequence-item'").get() as { n: number }).n).toBeLessThan(6)
    expect((readonly.prepare("SELECT COUNT(*) AS n FROM v3_sequence_nodes").get() as { n: number }).n).toBeLessThan(6)
    readonly.close()
  })
})
