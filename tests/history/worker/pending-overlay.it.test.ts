import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { ModelOperationRecord } from "~/lib/context/model-operation-record"
import type {
  //
  HistoryPersistenceOutcome,
  ModelOperationTerminalPublication,
} from "~/lib/history/worker/protocol"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import {
  //
  createModelOperationTerminalPublication,
  createRawOperationAttachmentOwner,
} from "~/lib/history/terminal-publication"
import {
  //
  getRecentModelOperationTerminal,
  getRecentModelOperationDurability,
  listRecentModelOperationTerminals,
  publishModelOperationTerminal,
  resetModelOperationTerminalBusForTests,
  settleRecentModelOperationDurability,
  subscribeModelOperationTerminals,
} from "~/lib/history/v3/terminal-bus"
import { LegacyHistoryTerminalSink } from "~/lib/history/worker/legacy-terminal-sink"

function terminalRecord(operationId: string) {
  return createModelOperationRecorder({
    identity: { operationId, kind: "generation", createdAt: 1 },
  }).commitTerminal({ outcome: "completed" })
}

function publication(operationId: string) {
  return createModelOperationTerminalPublication(
    terminalRecord(operationId),
    createRawOperationAttachmentOwner({
      configRevision: 7,
      requested: false,
      maxObjectBytes: 1024,
    }),
  )
}

beforeEach(() => resetModelOperationTerminalBusForTests())

describe("legacy terminal sink adapter", () => {
  test("returns stable message IDs and reports the old writer outcome exactly once", async () => {
    const persisted: Array<ReturnType<typeof terminalRecord>> = []
    const sink = new LegacyHistoryTerminalSink({
      enqueueRecord: async (record: ModelOperationRecord) => {
        persisted.push(record)
        return "conflict"
      },
    })
    const value = publication("legacy-conflict")
    let callbacks = 0
    const outcome = new Promise<string>((resolve) => {
      const messageId = sink.enqueue({ protocolVersion: 1, publication: value }, (result: HistoryPersistenceOutcome) => {
        callbacks++
        resolve(result)
      })
      expect(messageId).toBe(1)
    })

    await expect(outcome).resolves.toBe("conflict")
    expect(persisted).toEqual([value.record])
    expect(callbacks).toBe(1)
  })

  test("converts an unexpected old-writer rejection to failed without throwing", async () => {
    const sink = new LegacyHistoryTerminalSink({
      enqueueRecord: () => Promise.reject(new Error("legacy writer exploded")),
    })
    let resolveOutcome!: (outcome: HistoryPersistenceOutcome) => void
    const outcome = new Promise<HistoryPersistenceOutcome>((resolve) => {
      resolveOutcome = resolve
    })

    expect(() => sink.enqueue({ protocolVersion: 1, publication: publication("legacy-failed") }, resolveOutcome)).not.toThrow()
    await expect(outcome).resolves.toBe("failed")
  })
})

describe("model operation terminal publication ownership", () => {
  test("transfers an operation-owned raw attachment exactly once", () => {
    const owner = createRawOperationAttachmentOwner({
      configRevision: 3,
      requested: false,
      maxObjectBytes: 4096,
    })
    const record = terminalRecord("publication-once")

    const first = createModelOperationTerminalPublication(record, owner)
    expect(first.record).toBe(record)
    expect(first.rawAttachment).toEqual({
      rawTarget: { configRevision: 3, requested: false, maxObjectBytes: 4096 },
      rawCommands: [],
    })
    expect(() => createModelOperationTerminalPublication(record, owner)).toThrow(/already transferred/i)
  })

  test("publishes the complete publication to the unique persistence subscriber surface", () => {
    let observed: ModelOperationTerminalPublication | undefined
    const unsubscribe = subscribeModelOperationTerminals((value) => {
      observed = value
    })
    const value = publication("publication-subscriber")

    publishModelOperationTerminal(value)

    expect(observed).toBe(value)
    expect(getRecentModelOperationTerminal("publication-subscriber")).toBe(value.record)
    unsubscribe()
  })
})

describe("pending durability overlay", () => {
  test("retains every unacknowledged operation beyond the acknowledged recent cap", () => {
    const values = Array.from({ length: 512 }, (_, index) => publication(`pending-${index}`))
    for (const value of values) publishModelOperationTerminal(value)

    expect(listRecentModelOperationTerminals()).toHaveLength(512)
    expect(getRecentModelOperationTerminal("pending-0")).toBe(values[0].record)
    expect(getRecentModelOperationTerminal("pending-255")).toBe(values[255].record)
    expect(getRecentModelOperationTerminal("pending-511")).toBe(values[511].record)
    expect(getRecentModelOperationDurability("pending-0")).toBe("pending")
  })

  test("moves terminal outcomes into an independent 256-entry acknowledged cache", () => {
    const values = Array.from({ length: 512 }, (_, index) => publication(`acked-${index}`))
    for (const value of values) publishModelOperationTerminal(value)
    for (const value of values) settleRecentModelOperationDurability(value, "persisted")

    expect(listRecentModelOperationTerminals()).toHaveLength(256)
    expect(getRecentModelOperationTerminal("acked-0")).toBeUndefined()
    expect(getRecentModelOperationTerminal("acked-255")).toBeUndefined()
    expect(getRecentModelOperationTerminal("acked-256")).toBe(values[256].record)
    expect(getRecentModelOperationTerminal("acked-511")).toBe(values[511].record)
    expect(getRecentModelOperationDurability("acked-511")).toBeUndefined()
  })
})
