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

const FORMAT_MARKER = "copilot-api-history-search-tantivy-v2\n"

let directory: string | undefined

afterEach(async () => {
  await drainTantivySearch()
  resetTantivySearchForTests()
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

/** Minimal terminal record: only a client-inbound conversation payload. */
function terminalRecord(id: string, kind: "generation" | "embeddings", text: string) {
  const recorder = createModelOperationRecorder({ identity: { operationId: id, kind, createdAt: 100 } })
  const payload = recorder.registerPayload({ messages: [{ role: "user", content: text }] }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ request: { payload } })
  return recorder.commitTerminal({ outcome: "completed" })
}

/**
 * Rich terminal record covering all four boundaries so content-narrowing can be
 * proven: `ingress.request` (conversation), `egress.client` payload+frame
 * (response), and an `egress.upstream` frame that MUST NOT be indexed.
 */
function richTerminalRecord(id: string, tokens: { conversation: string; responseBody: string; responseFrame: string; upstreamOnly: string }) {
  const recorder = createModelOperationRecorder({ identity: { operationId: id, kind: "generation", createdAt: 100 } })
  const conversation = recorder.registerPayload(
    { messages: [{ role: "user", content: tokens.conversation }] },
    { origin: { stage: "ingress", track: "client" } },
  )
  recorder.recordIngress({ request: { payload: conversation } })
  const responsePayload = recorder.registerPayload({ content: tokens.responseBody }, { origin: { stage: "egress", track: "client" } })
  const responseFrame = recorder.registerFrame(
    { event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", delta: { text: tokens.responseFrame } }) },
    { origin: { stage: "egress", track: "client" } },
  )
  const upstreamFrame = recorder.registerFrame({ event: "raw", raw: tokens.upstreamOnly }, { origin: { stage: "upstream-response", track: "upstream" } })
  recorder.recordEgress({ client: { payload: responsePayload, frames: [responseFrame] }, upstream: { frames: [upstreamFrame] } })
  return recorder.commitTerminal({ outcome: "completed" })
}

/** Tantivy meta.json committed-segment count (external oracle for segment explosion). */
function segmentCount(indexPath: string): number {
  const meta = JSON.parse(fs.readFileSync(path.join(indexPath, "meta.json"), "utf8")) as { segments?: Array<unknown> }
  return meta.segments?.length ?? 0
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
    expect(fs.readFileSync(path.join(indexPath, "FORMAT"), "utf8")).toBe(FORMAT_MARKER)
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

  test("batched commit does not explode segments yet keeps every document searchable", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "history-tantivy-batch-"))
    const indexPath = path.join(directory, "index")
    configureTantivySearch({ enabled: true, path: indexPath })

    const count = 20
    for (let i = 0; i < count; i++) {
      await enqueueTantivyOperation(terminalRecord(`op-${i}`, "generation", `sharedneedle payload number ${i}`))
    }
    await drainTantivySearch()

    // A per-document commit would produce ~`count` segments; batched commit collapses to a handful.
    expect(segmentCount(indexPath)).toBeLessThan(count)
    // Guard against a false green where "few segments" hides "documents never indexed".
    expect((await searchTantivyOperations("sharedneedle", undefined)).length).toBe(count)
    expect(getTantivySearchStatus()).toMatchObject({ state: "ready", indexedOperations: count, failedOperations: 0 })
  })

  test("indexes only the client conversation and response, never upstream/intermediate frames", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "history-tantivy-narrow-"))
    configureTantivySearch({ enabled: true, path: path.join(directory, "index") })

    await enqueueTantivyOperation(
      richTerminalRecord("narrow-op", {
        conversation: "convtokenalpha",
        responseBody: "resptokenbeta",
        responseFrame: "resptokengamma",
        upstreamOnly: "upstreamtokendelta",
      }),
    )
    await drainTantivySearch()

    expect((await searchTantivyOperations("convtokenalpha", undefined)).map((hit) => hit.operationId)).toEqual(["narrow-op"])
    expect((await searchTantivyOperations("resptokenbeta", undefined)).map((hit) => hit.operationId)).toEqual(["narrow-op"])
    expect((await searchTantivyOperations("resptokengamma", undefined)).map((hit) => hit.operationId)).toEqual(["narrow-op"])
    // The upstream-only frame must never enter the searchable corpus.
    expect(await searchTantivyOperations("upstreamtokendelta", undefined)).toEqual([])
  })

  test("self-heals an index whose FORMAT marker is an older incompatible version", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "history-tantivy-heal-"))
    const indexPath = path.join(directory, "index")
    fs.mkdirSync(indexPath, { recursive: true })
    fs.writeFileSync(path.join(indexPath, "FORMAT"), "copilot-api-history-search-tantivy-v1\n")
    fs.writeFileSync(path.join(indexPath, "stale-segment.idx"), "garbage from an older format")

    configureTantivySearch({ enabled: true, path: indexPath })
    await enqueueTantivyOperation(terminalRecord("post-heal", "generation", "freshneedle"))
    await drainTantivySearch()

    expect(fs.readFileSync(path.join(indexPath, "FORMAT"), "utf8")).toBe(FORMAT_MARKER)
    expect(fs.existsSync(path.join(indexPath, "stale-segment.idx"))).toBe(false)
    expect((await searchTantivyOperations("freshneedle", undefined)).map((hit) => hit.operationId)).toEqual(["post-heal"])
    expect(getTantivySearchStatus()).toMatchObject({ state: "ready", failedOperations: 0 })
  })

  test("disabling the sidecar flushes uncommitted documents instead of dropping them", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "history-tantivy-disable-"))
    const indexPath = path.join(directory, "index")
    configureTantivySearch({ enabled: true, path: indexPath })

    // Enqueue an upsert (runs on the tail chain) but never call drain — the document
    // sits in the writer's uncommitted debounce window.
    await enqueueTantivyOperation(terminalRecord("survivor", "generation", "survivorneedle"))

    // Disabling must flush+close, not drop the writer (whose Drop does NOT commit).
    configureTantivySearch({ enabled: false, path: indexPath })
    await drainTantivySearch()

    // Re-open the same on-disk index and confirm the document was persisted.
    configureTantivySearch({ enabled: true, path: indexPath })
    await drainTantivySearch()
    expect((await searchTantivyOperations("survivorneedle", undefined)).map((hit) => hit.operationId)).toEqual(["survivor"])
  })
})
