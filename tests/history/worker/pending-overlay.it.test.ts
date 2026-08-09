import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { ModelOperationTerminalPublication } from "~/lib/history/worker/protocol"

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
