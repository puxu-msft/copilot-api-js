import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import { getHistorySummaries } from "~/lib/history/queries"
import {
  //
  getSessionEntries,
  getSessionSummaries,
} from "~/lib/history/sessions"
import {
  //
  createModelOperationTerminalPublication,
  createRawOperationAttachmentOwner,
} from "~/lib/history/terminal-publication"
import {
  //
  drainModelOperationTerminalSubscribers,
  publishModelOperationTerminal,
} from "~/lib/history/v3/terminal-bus"

import { useIsolatedRuntime } from "../../helpers/isolated-fixture"
import { createFullTestApp } from "../../helpers/test-app"

function publishRecord(operationId: string, sessionId: string): void {
  const recorder = createModelOperationRecorder({
    identity: { operationId, kind: "generation", createdAt: 123, sessionId },
  })
  const record = recorder.commitTerminal({ outcome: "completed", metadata: { durationMs: 5 } })
  publishModelOperationTerminal(
    createModelOperationTerminalPublication(
      record,
      createRawOperationAttachmentOwner({ configRevision: 1, requested: false, maxObjectBytes: 1024 }),
    ),
  )
}

describe("pending terminal overlay read surfaces", () => {
  useIsolatedRuntime()

  test("list, sessions, session entries, and status expose the same unacknowledged operation once", async () => {
    const operationId = "overlay-read-surfaces"
    const sessionId = "overlay-session"
    publishRecord(operationId, sessionId)

    expect(getHistorySummaries({ operationKind: "all" }).entries.map((entry) => entry.id)).toContain(operationId)
    expect(getSessionSummaries().find((session) => session.sessionId === sessionId)?.requestCount).toBe(1)
    expect(getSessionEntries(sessionId).entries.map((entry) => entry.id)).toEqual([operationId])

    const response = await createFullTestApp().request("/api/status")
    expect(response.status).toBe(200)
    const body = (await response.json()) as { memory: { historyEntryCount: number } }
    expect(body.memory.historyEntryCount).toBe(1)
  })

  test("deduplicates acknowledged recent records against DB while retaining pending records", async () => {
    const sessionId = "overlay-three-source-session"
    publishRecord("overlay-acknowledged", sessionId)
    await drainModelOperationTerminalSubscribers()
    publishRecord("overlay-pending", sessionId)

    const summaries = getHistorySummaries({ operationKind: "all" })
    expect(summaries.entries.filter((entry) => entry.sessionId === sessionId).map((entry) => entry.id).sort()).toEqual([
      "overlay-acknowledged",
      "overlay-pending",
    ])
    expect(getSessionSummaries().find((session) => session.sessionId === sessionId)?.requestCount).toBe(2)
    expect(getSessionEntries(sessionId).entries.map((entry) => entry.id).sort()).toEqual(["overlay-acknowledged", "overlay-pending"])

    const response = await createFullTestApp().request("/api/status")
    const body = (await response.json()) as { memory: { historyEntryCount: number } }
    expect(body.memory.historyEntryCount).toBe(2)
  })
})
