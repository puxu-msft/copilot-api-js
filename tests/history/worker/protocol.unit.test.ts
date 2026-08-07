import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ModelOperationRecord } from "~/lib/context/model-operation-record"

import {
  //
  HISTORY_WORKER_PROTOCOL_VERSION,
  HistoryWorkerProtocolError,
  assertStructuredCloneSafe,
  parseMainToWorkerMessage,
  parseWorkerToMainMessage,
  type HistoryOperationEnvelope,
} from "~/lib/history/worker/protocol"

function record(operationId = "op-1"): ModelOperationRecord {
  return {
    identity: { operationId, kind: "generation", createdAt: 1 },
    arena: { payloads: [], frames: [] },
    ingress: null,
    routing: null,
    transforms: [],
    candidates: [],
    dispatches: [],
    attempts: [],
    egress: null,
    terminal: null,
    extensions: {},
    lastSequence: 0,
  }
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
    const message = parseMainToWorkerMessage({
      type: "persist-operation",
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: 2,
      messageId: 7,
      envelope: envelope(),
    })

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

  test("rejects values that structured clone cannot carry", () => {
    expect(() => assertStructuredCloneSafe({ callback: () => "not cloneable" }, "test payload")).toThrow(HistoryWorkerProtocolError)
  })
})
