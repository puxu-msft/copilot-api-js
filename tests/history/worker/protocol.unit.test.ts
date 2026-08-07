import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import {
  //
  HISTORY_WORKER_PROTOCOL_VERSION,
  HistoryWorkerProtocolError,
  assertStructuredCloneSafe,
  parseMainToWorkerMessage,
  parseWorkerToMainMessage,
  type HistoryOperationEnvelope,
} from "~/lib/history/worker/protocol"

function record(operationId = "op-1") {
  return createModelOperationRecorder({ identity: { operationId, kind: "generation", createdAt: 1 } }).commitTerminal({ outcome: "completed" })
}

function envelope(): HistoryOperationEnvelope {
  return {
    protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
    publication: {
      record: record(),
      rawAttachment: {
        rawTarget: { configRevision: 1, requested: false, maxObjectBytes: 1024 },
        rawCommands: [{ sequence: 1, track: "upstream", kind: "sse", bytes: new Uint8Array([1, 2, 3]) }],
      },
    },
  }
}

describe("History Worker protocol", () => {
  test("accepts a production-shaped persistence envelope without losing structured-clone values", () => {
    const message = parseMainToWorkerMessage(
      structuredClone({
        type: "persist-operation",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: 2,
        messageId: 7,
        envelope: envelope(),
      }),
    )

    expect(message.type).toBe("persist-operation")
    if (message.type !== "persist-operation") throw new Error("wrong message type")
    expect(message.envelope.publication.record.identity.operationId).toBe("op-1")
    expect(message.envelope.publication.rawAttachment.rawCommands[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]))
  })

  test("rejects wrong versions and unknown message types in both directions", () => {
    expect(() => parseMainToWorkerMessage({ type: "drain", protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION + 1, workerGeneration: 1, requestId: 1 })).toThrow(
      HistoryWorkerProtocolError,
    )
    expect(() => parseMainToWorkerMessage({ type: "future-command", protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION, workerGeneration: 1 })).toThrow(
      HistoryWorkerProtocolError,
    )
    expect(() => parseWorkerToMainMessage({ type: "future-result", protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION, workerGeneration: 1 })).toThrow(
      HistoryWorkerProtocolError,
    )
  })

  test("rejects a nested envelope with the wrong protocol version", () => {
    const invalidEnvelope = { ...envelope(), protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION + 1 }
    expect(() =>
      parseMainToWorkerMessage({
        type: "persist-operation",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: 1,
        messageId: 1,
        envelope: invalidEnvelope,
      }),
    ).toThrow(HistoryWorkerProtocolError)
  })

  test("rejects a ready response with an unknown SQLite driver", () => {
    expect(() =>
      parseWorkerToMainMessage({
        type: "ready",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: 1,
        requestId: 1,
        ready: {
          workerGeneration: 1,
          threadId: 1,
          selectedDriver: "sqlite-magic",
          configRevision: 1,
          rawTarget: { configRevision: 1, requested: false, maxObjectBytes: 1024 },
        },
      }),
    ).toThrow(HistoryWorkerProtocolError)
  })

  test("rejects ready when its raw target revision does not match its published config revision", () => {
    expect(() =>
      parseWorkerToMainMessage({
        type: "ready",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: 1,
        requestId: 1,
        ready: {
          workerGeneration: 1,
          threadId: 1,
          selectedDriver: "bun:sqlite",
          configRevision: 2,
          rawTarget: { configRevision: 1, requested: false, maxObjectBytes: 1024 },
        },
      }),
    ).toThrow("ready.ready.rawTarget.configRevision must match ready.ready.configRevision")
  })

  test("rejects persistence envelopes without a canonical terminal", () => {
    const base = envelope()
    const terminalCases: Array<unknown> = [null, {}, { sequence: 2, outcome: "completed" }, { sequence: 1, outcome: "maybe" }]
    for (const terminal of terminalCases) {
      const invalidEnvelope = {
        ...base,
        publication: {
          ...base.publication,
          record: { ...base.publication.record, terminal },
        },
      }
      expect(() =>
        parseMainToWorkerMessage({
          type: "persist-operation",
          protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
          workerGeneration: 1,
          messageId: 1,
          envelope: invalidEnvelope,
        }),
      ).toThrow(HistoryWorkerProtocolError)
    }
  })

  test("rejects canonical terminal references that do not resolve inside the record", () => {
    const base = envelope()
    const candidate = { handle: "candidate-1", sequence: 1, role: "primary", dispatches: ["dispatch-1"] }
    const dispatch = { handle: "dispatch-1", candidate: "candidate-1", sequence: 2, diagnostics: [] }
    const recordWithTopology = {
      ...base.publication.record,
      candidates: [candidate],
      dispatches: [dispatch],
      lastSequence: 3,
    }
    const terminalCases = [
      { sequence: 3, outcome: "completed", winnerCandidate: "missing-candidate" },
      { sequence: 3, outcome: "completed", committedDispatch: "missing-dispatch" },
      { sequence: 3, outcome: "completed", committedDispatch: "dispatch-1", committedAttempt: "missing-dispatch" },
      { sequence: 3, outcome: "completed", committedAttempt: "dispatch-1" },
    ]

    for (const terminal of terminalCases) {
      const invalidEnvelope = {
        ...base,
        publication: {
          ...base.publication,
          record: { ...recordWithTopology, terminal },
        },
      }
      expect(() =>
        parseMainToWorkerMessage({
          type: "persist-operation",
          protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
          workerGeneration: 1,
          messageId: 1,
          envelope: invalidEnvelope,
        }),
      ).toThrow(HistoryWorkerProtocolError)
    }
  })

  test("accepts canonical terminal references that resolve inside the record", () => {
    const base = envelope()
    const candidate = { handle: "candidate-1", sequence: 1, role: "primary", dispatches: ["dispatch-1"] }
    const dispatch = { handle: "dispatch-1", candidate: "candidate-1", sequence: 2, diagnostics: [] }
    const validEnvelope = {
      ...base,
      publication: {
        ...base.publication,
        record: {
          ...base.publication.record,
          candidates: [candidate],
          dispatches: [dispatch],
          terminal: {
            sequence: 3,
            outcome: "completed",
            winnerCandidate: "candidate-1",
            committedDispatch: "dispatch-1",
            committedAttempt: "dispatch-1",
          },
          lastSequence: 3,
        },
      },
    }

    expect(() =>
      parseMainToWorkerMessage({
        type: "persist-operation",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: 1,
        messageId: 1,
        envelope: validEnvelope,
      }),
    ).not.toThrow()
  })

  test("rejects an enumerable deprecated attempts projection on the canonical wire", () => {
    const base = envelope()
    expect(() =>
      parseMainToWorkerMessage({
        type: "persist-operation",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: 1,
        messageId: 1,
        envelope: {
          ...base,
          publication: {
            ...base.publication,
            record: { ...base.publication.record, attempts: [] },
          },
        },
      }),
    ).toThrow("ModelOperationRecord.attempts must not be serialized; use dispatches")
  })

  test("rejects malformed nested main-to-Worker payloads", () => {
    const cases: Array<unknown> = [
      {
        type: "initialize",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: 1,
        requestId: 1,
        config: {},
      },
      {
        type: "update-config",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: 1,
        requestId: 1,
        revision: 2,
        config: { rawConfig: {}, maintenanceIntervalMs: -1 },
      },
      {
        type: "persist-operation",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: 1,
        messageId: 1,
        envelope: { ...envelope(), publication: { ...envelope().publication, record: {} } },
      },
    ]

    for (const value of cases) expect(() => parseMainToWorkerMessage(value)).toThrow(HistoryWorkerProtocolError)
  })

  test("accepts only Worker-owned fields in a partial status update", () => {
    expect(
      parseWorkerToMainMessage({
        type: "status",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: 1,
        status: { ready: true, selectedDriver: "bun:sqlite", threadId: 7, publishedRevision: 2, lastError: "worker warning" },
      }),
    ).toMatchObject({ status: { ready: true, selectedDriver: "bun:sqlite", threadId: 7, publishedRevision: 2, lastError: "worker warning" } })
  })

  test("rejects main-owned fields in Worker status updates", () => {
    const mainOwnedFields = [
      "workerGeneration",
      "terminalFailed",
      "pendingEnvelopes",
      "pendingBytes",
      "latestDesiredRevision",
      "restartsTotal",
      "replaysTotal",
      "staleMessagesTotal",
      "duplicateAcksTotal",
      "outcomeCallbackErrorsTotal",
      "statusObserverErrorsTotal",
      "lastOutcomeCallbackError",
      "lastStatusObserverError",
    ]

    for (const field of mainOwnedFields) {
      expect(() =>
        parseWorkerToMainMessage({
          type: "status",
          protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
          workerGeneration: 1,
          status: { [field]: field === "lastOutcomeCallbackError" ? "forged" : 1 },
        }),
      ).toThrow(HistoryWorkerProtocolError)
    }
  })

  test("rejects malformed nested Worker-to-main payloads", () => {
    const cases: Array<unknown> = [
      {
        type: "status",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: 1,
        status: { terminalFailed: "yes", pendingEnvelopes: -7 },
      },
      {
        type: "drained",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: 1,
        requestId: 1,
        result: { outcomes: { 1: "maybe" } },
      },
      {
        type: "config-applied",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: 1,
        requestId: 1,
        revision: 2,
        rawTarget: { configRevision: 2, requested: "yes", maxObjectBytes: -1 },
      },
    ]

    for (const value of cases) expect(() => parseWorkerToMainMessage(value)).toThrow(HistoryWorkerProtocolError)
  })

  test("rejects values that structured clone cannot carry", () => {
    expect(() => assertStructuredCloneSafe({ callback: () => "not cloneable" }, "test payload")).toThrow(HistoryWorkerProtocolError)
  })
})
