import type { HistoryEntry } from "~/lib/history/types"

import { PATHS } from "~/lib/config/paths"
import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import {
  //
  getDatabase,
  isDatabaseOpen,
  openDatabase,
  openOwnedHistoryDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  clearV3Store,
  commitPreparedOperation,
  ensureV3Schema,
  prepareModelOperation,
} from "~/lib/history/v3/store"
import {
  //
  detachHistoryReadDatabaseForTests,
  installHistoryReadDatabase,
} from "~/lib/history/sqlite/read-connection"
import { state } from "~/lib/state"

let seedDb: { path: string, db: ReturnType<typeof openOwnedHistoryDatabase> } | undefined
/** The seed handle outlives every individual test by design (reopening per test would be pure cost), so the close has to hang off process exit — the same shape `historyTestDbPath` uses for its temp dir. */
let seedDbExitHookInstalled = false

/**
 * A short-lived WRITE handle on the artifact under test, for seeding rows directly.
 *
 * Since the Batch 2b cutover the main thread has no write handle to borrow — `getDatabase()` throws, because the semantic write connection moved to the Worker. A seeding fixture is still legitimately a writer, so it opens its own connection to the same file; SQLite's WAL mode serializes it against the Worker's connection, and the main thread's readonly handle sees the rows on its next read. This is a test-only second connection, not a second production writer: nothing in `src/` may do this (see the architecture guard on `state.ts`).
 */
function seedWriteDatabase(): ReturnType<typeof openOwnedHistoryDatabase> {
  // A test that opened its OWN write singleton (`openInMemoryDatabase()`, or `openDatabase()` on its own artifact) is asserting against THAT database — it is also what the query layer reads, because `openInMemoryDatabase` publishes it as the read handle. Seeding anywhere else would write one database and read another, which looks exactly like "the rows vanished".
  if (isDatabaseOpen()) return getDatabase()
  // Otherwise seed the artifact the app under test opened. Same resolution `initHistory` uses, so an empty `historyDbPath` means the sandboxed default, not "no database".
  const path = state.historyDbPath || PATHS.HISTORY_V3_DB
  if (seedDb?.path === path) return seedDb.db
  seedDb?.db.close()
  const db = openOwnedHistoryDatabase(path)
  ensureV3Schema(db)
  seedDb = { path, db }
  if (!seedDbExitHookInstalled) {
    seedDbExitHookInstalled = true
    process.on("exit", () => seedDb?.db.close())
  }
  return db
}

/**
 * The fixtures' WRITE handle on the artifact under test, for tests that assert or seed with direct SQL.
 *
 * Replaces `getDatabase()` in test bodies: the main thread stopped opening the write singleton at the Batch 2b cutover, so that accessor now throws. Reads could go through `getHistoryReadDatabase()` instead, but a test that also writes needs one handle for both, and mixing the two invites assertions that read a different connection than they wrote.
 */
export function historyTestWriteDatabase(): ReturnType<typeof openOwnedHistoryDatabase> {
  return seedWriteDatabase()
}

/** Wipe every V3 table on the artifact under test. Backs `clearHistory()`'s persisted half, which production can no longer perform itself (see `setHistoryStoreWipeForTests`). */
export function clearHistoryStoreForTests(): void {
  clearV3Store(seedWriteDatabase())
}

/** Persist a terminal History-shaped fixture through the canonical V3 store. */
export function commitV3HistoryEntry(entry: HistoryEntry): void {
  const recorder = createModelOperationRecorder({
    identity: {
      operationId: entry.id,
      kind: entry.operationKind ?? "generation",
      createdAt: entry.startedAt,
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      process: entry.process,
    },
  })
  const clientBody = entry.clientRequest?.body ?? {
    model: entry.clientRequest?.model ?? entry.model?.requested,
    messages: entry.clientRequest?.messages ?? [],
    stream: entry.clientRequest?.stream,
    tools: entry.clientRequest?.tools,
    system: entry.clientRequest?.system,
  }
  const ingress = recorder.registerPayload(clientBody, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({
    format: entry.endpoint,
    method: entry.clientRequest?.method ?? "POST",
    path: entry.clientRequest?.path ?? "/",
    request: {
      payload: ingress,
      headers: entry.clientRequest?.headers ? Object.entries(entry.clientRequest.headers) : undefined,
      metadata: entry.clientRequest,
    },
  })
  recorder.recordRouting({
    requestedModel: entry.model?.requested ?? entry.clientRequest?.model,
    resolvedModel: entry.model?.resolved ?? entry.attempts?.at(-1)?.upstreamResponse?.model,
    clientFormat: entry.endpoint,
    upstreamEndpoint: entry.model?.outboundEndpoint,
    transport: entry.transport,
    metadata: { translated: entry.model?.translated },
  })

  let committedAttempt: ReturnType<typeof recorder.beginAttempt> | undefined
  for (const attempt of entry.attempts ?? []) {
    const effectiveBody = attempt.effectiveSource?.body
    const upstreamBody = attempt.upstreamRequest?.body
    const effective =
      effectiveBody === undefined ? undefined : recorder.registerPayload(effectiveBody, { origin: { stage: "effective-request", track: "proxy" } })
    const upstream = upstreamBody === undefined ? undefined : recorder.registerPayload(upstreamBody, { origin: { stage: "upstream-wire", track: "upstream" } })
    const handle = recorder.beginAttempt({
      strategy: attempt.strategy,
      transport: attempt.transport,
      effectiveRequest: effective === undefined ? undefined : { payload: effective, metadata: attempt.effectiveSource },
      upstreamRequest:
        upstream === undefined ? undefined : (
          {
            payload: upstream,
            headers: attempt.upstreamRequest?.headers ? Object.entries(attempt.upstreamRequest.headers) : undefined,
            metadata: attempt.upstreamRequest,
          }
        ),
      metadata: { transport: attempt.transport },
    })
    const response = attempt.upstreamResponse
    const responsePayload =
      response?.body === undefined ?
        undefined
      : recorder.registerPayload(response.body, { origin: { stage: "upstream-response", track: "upstream", attempt: handle } })
    const responseFrames = response?.sseEvents ?? []
    const frameHandles = responseFrames.map((frame) =>
      recorder.registerFrame(
        { event: frame.type, data: frame.raw },
        { origin: { stage: "upstream-capture", track: "upstream", attempt: handle }, mediaType: "text/event-stream" },
      ),
    )
    recorder.settleAttempt(handle, {
      verdict: response?.success === false ? "failed" : "committed",
      upstreamResponse: {
        payload: responsePayload,
        frames: frameHandles,
        frameObservations: frameHandles.map((frameHandle, index) => {
          const frame = responseFrames[index]
          return {
            handle: frameHandle,
            offsetMs: frame.offsetMs,
            type: frame.type,
            raw: frame.raw,
            ...(frame.synthetic === undefined ? {} : { synthetic: frame.synthetic }),
          }
        }),
        status: response?.status,
        headers: response?.headers ? Object.entries(response.headers) : undefined,
        metadata: { response, latencyMs: attempt.durationMs },
      },
      error: attempt.error,
    })
    if (response?.success !== false) committedAttempt = handle
  }

  const clientBodyOut = entry.clientResponse?.body
  const clientPayload =
    clientBodyOut === undefined ? undefined : recorder.registerPayload(clientBodyOut, { origin: { stage: "client-egress", track: "client" } })
  const clientFrames = (entry.clientResponse?.sseEvents ?? []).map((frame) =>
    recorder.registerFrame(frame, { origin: { stage: "client-sink", track: "client" }, mediaType: "text/event-stream" }),
  )
  recorder.recordEgress({
    upstream: {},
    client: {
      payload: clientPayload,
      frames: clientFrames,
      status: entry.clientResponse?.status ?? (entry.state === "completed" ? 200 : undefined),
      headers: entry.clientResponse?.headers ? Object.entries(entry.clientResponse.headers) : undefined,
    },
  })

  const outcome =
    entry.state === "completed" ? "completed"
    : entry.state === "aborted" ? "aborted"
    : entry.state === "interrupted" ? "interrupted"
    : "failed"
  const terminal = recorder.commitTerminal({
    outcome,
    committedAttempt,
    error: entry._index?.derived?.failureReason,
    metadata: { durationMs: entry.durationMs },
  })
  commitPreparedOperation(seedWriteDatabase(), prepareModelOperation(terminal))
}

/**
 * Open an on-disk V3 artifact as the write singleton AND publish it as the process-wide read handle.
 *
 * A test that seeds a database and then exercises the query APIs needs both ends pointing at the same file. Before the Batch 2b cutover one call did that implicitly, because the read paths resolved the write singleton; now they resolve `getHistoryReadDatabase()`, so the publication has to be explicit. This is the on-disk sibling of `openInMemoryDatabase()`, which has always done exactly this.
 *
 * Detaching first rather than closing: whatever is published belongs to whoever installed it — a live `initHistory` owns its readonly handle and will close it on its next transition. `closeDatabase()` withdraws this publication again.
 */
export function openTestDatabaseAsReadSource(dbPath: string): ReturnType<typeof openDatabase> {
  detachHistoryReadDatabaseForTests()
  const database = openDatabase(dbPath)
  installHistoryReadDatabase(database)
  return database
}
