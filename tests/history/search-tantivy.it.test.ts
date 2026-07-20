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

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import {
  //
  configureTantivySearch,
  drainTantivySearch,
  enqueueTantivyOperation,
  getTantivySearchStatus,
  resetTantivySearchForTests,
  searchTantivyOperations,
} from "~/lib/history/search-tantivy"

let directory: string | undefined

afterEach(async () => {
  await drainTantivySearch()
  resetTantivySearchForTests()
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function terminalRecord(id: string, kind: "generation" | "embeddings", text: string) {
  const recorder = createModelOperationRecorder({ identity: { operationId: id, kind, createdAt: 100 } })
  const payload = recorder.registerPayload({ messages: [{ role: "user", content: text }] }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ request: { payload } })
  return recorder.commitTerminal({ outcome: "completed" })
}

describe("Tantivy History search sidecar", () => {
  test("indexes canonical terminal content and filters by operation kind", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "history-tantivy-"))
    const indexPath = path.join(directory, "index")
    configureTantivySearch({ enabled: true, path: indexPath })

    await enqueueTantivyOperation(terminalRecord("generation-hit", "generation", "unique semantic needle"))
    await enqueueTantivyOperation(terminalRecord("embedding-hit", "embeddings", "unique semantic needle"))
    await drainTantivySearch()

    expect((await searchTantivyOperations("needle", undefined)).map((hit) => hit.operationId).sort()).toEqual(["embedding-hit", "generation-hit"])
    expect((await searchTantivyOperations("needle", "generation")).map((hit) => hit.operationId)).toEqual(["generation-hit"])
    expect(getTantivySearchStatus()).toMatchObject({ state: "ready", indexedOperations: 2, failedOperations: 0, pendingOperations: 0 })
    expect(fs.readFileSync(path.join(indexPath, "FORMAT"), "utf8")).toBe("copilot-api-history-search-tantivy-v1\n")
  })

  test("upsert replaces an operation document instead of duplicating it", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "history-tantivy-upsert-"))
    configureTantivySearch({ enabled: true, path: path.join(directory, "index") })

    await enqueueTantivyOperation(terminalRecord("same-operation", "generation", "obsolete phrase"))
    await enqueueTantivyOperation(terminalRecord("same-operation", "generation", "replacement phrase"))
    await drainTantivySearch()

    expect(await searchTantivyOperations("obsolete", undefined)).toEqual([])
    expect((await searchTantivyOperations("replacement", undefined)).map((hit) => hit.operationId)).toEqual(["same-operation"])
  })

  test("refuses a non-empty directory without the sidecar identity marker", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "history-tantivy-unowned-"))
    fs.writeFileSync(path.join(directory, "foreign.txt"), "do not touch")
    configureTantivySearch({ enabled: true, path: directory })

    await enqueueTantivyOperation(terminalRecord("must-not-write", "generation", "text"))
    await drainTantivySearch()

    expect(getTantivySearchStatus()).toMatchObject({ state: "degraded", indexedOperations: 0, failedOperations: 1 })
    expect(fs.readFileSync(path.join(directory, "foreign.txt"), "utf8")).toBe("do not touch")
    expect(fs.existsSync(path.join(directory, "FORMAT"))).toBe(false)
  })
})
