import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { Worker } from "node:worker_threads"

import type { ModelOperationRecord } from "~/lib/context/model-operation-record"
import type {
  //
  HistoryOperationEnvelope,
  HistoryPersistenceOutcome,
  HistoryWorkerStartConfig,
} from "~/lib/history/worker/protocol"
import type { HistoryWorkerTransport } from "~/lib/history/worker/runtime"

import { HISTORY_WORKER_PROTOCOL_VERSION } from "~/lib/history/worker/protocol"
import {
  //
  HistoryPersistenceRuntimeImpl,
  createInProcessHistoryPersistenceRuntime,
} from "~/lib/history/worker/runtime"

const workerUrl = new URL("../../../src/lib/history/worker/history-worker.ts", import.meta.url)
const fixtureWorkerUrl = new URL("./fixtures/worker-entry.ts", import.meta.url)

function startConfig(): HistoryWorkerStartConfig {
  return {
    semanticDbPath: ":memory:",
    configRevision: 1,
    rawConfig: { enabled: false, dbPath: "", maxObjectBytes: 1024 },
    persistRetry: { maxAttempts: 1, backoffMs: 1 },
    maintenanceIntervalMs: 60_000,
  }
}

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
    terminal: { sequence: 1, outcome: "completed" },
    extensions: {},
    lastSequence: 1,
  }
}

function envelope(operationId = "op-1"): HistoryOperationEnvelope {
  return {
    protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
    publication: {
      record: record(operationId),
      rawAttachment: {
        rawTarget: { configRevision: 1, requested: false, maxObjectBytes: 1024 },
        rawCommands: [{ sequence: 1, track: "upstream", kind: "sse", bytes: new Uint8Array([1, 2, 3]) }],
      },
    },
  }
}

async function exerciseRuntime(runtime: HistoryPersistenceRuntimeImpl): Promise<void> {
  const ready = await runtime.start(startConfig())
  expect(ready.configRevision).toBe(1)
  expect(ready.threadId).toBeGreaterThan(0)
  expect(runtime.snapshot().ready).toBe(true)

  const applied = await runtime.updateConfig(2, {
    rawConfig: { enabled: true, dbPath: "raw-test.db", maxObjectBytes: 2048 },
    maintenanceIntervalMs: 30_000,
  })
  expect(applied).toMatchObject({ configRevision: 2, requested: true, dbPath: "raw-test.db", maxObjectBytes: 2048 })
  await runtime.stopMaintenance()

  const outcome = new Promise<HistoryPersistenceOutcome>((resolve) => runtime.enqueue(envelope(), resolve))
  expect(await outcome).toBe("failed")
  expect(runtime.snapshot().pendingEnvelopes).toBe(0)

  expect(await runtime.drain()).toEqual({ outcomes: { 1: "failed" } })
  await runtime.shutdown()
  expect(runtime.snapshot().ready).toBe(false)
}

describe("HistoryPersistenceRuntime contract", () => {
  test("real source Worker executes ready, SQLite probe, failed ACK, drain, and close", async () => {
    await exerciseRuntime(new HistoryPersistenceRuntimeImpl({ workerUrl }))
  })

  test("in-process test backend runs the same contract", async () => {
    await exerciseRuntime(createInProcessHistoryPersistenceRuntime())
  })

  test("real Worker exposes deterministic error before exit", async () => {
    const worker = new Worker(fixtureWorkerUrl, { workerData: { crash: true } })
    const events: Array<string> = []
    const error = new Promise<Error>((resolve) =>
      worker.once("error", (value) => {
        events.push("error")
        resolve(value)
      }),
    )
    const exit = new Promise<number>((resolve) =>
      worker.once("exit", (code) => {
        events.push(`exit:${code}`)
        resolve(code)
      }),
    )

    expect((await error).message).toContain("deterministic fixture crash")
    const exitCode = await exit
    expect(events).toEqual(["error", `exit:${exitCode}`])
  })

  test("real Worker preserves Uint8Array and Map through structured clone", async () => {
    const worker = new Worker(fixtureWorkerUrl, { workerData: { roundtrip: true } })
    const message = new Promise<unknown>((resolve) => worker.once("message", resolve))
    const value = (await message) as { bytes: unknown; map: unknown }
    expect(value.bytes).toBeInstanceOf(Uint8Array)
    expect(value.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(value.map).toBeInstanceOf(Map)
    expect(value.map).toEqual(new Map([["n", 7]]))
    expect(await worker.terminate()).toBeGreaterThanOrEqual(0)
  })

  test("real Worker can be terminated after a successful message", async () => {
    const worker = new Worker(fixtureWorkerUrl)
    const message = new Promise<unknown>((resolve) => worker.once("message", resolve))
    expect(await message).toEqual({ ready: true })
    expect(await worker.terminate()).toBeGreaterThanOrEqual(0)
  })
})

class ControllableTransport implements HistoryWorkerTransport {
  readonly sent: Array<unknown> = []
  private readonly listeners = {
    message: new Set<(value: unknown) => void>(),
    error: new Set<(error: Error) => void>(),
    exit: new Set<(code: number) => void>(),
  }

  send(message: unknown): void {
    this.sent.push(message)
    const typed = message as { type?: string; protocolVersion?: number; workerGeneration?: number; requestId?: number }
    if (typed.type === "shutdown") {
      queueMicrotask(() =>
        this.emitMessage({
          type: "closed",
          protocolVersion: typed.protocolVersion,
          workerGeneration: typed.workerGeneration,
          requestId: typed.requestId,
        }),
      )
    }
  }

  on(event: "message", listener: (value: unknown) => void): this
  on(event: "error", listener: (error: Error) => void): this
  on(event: "exit", listener: (code: number) => void): this
  on(event: "message" | "error" | "exit", listener: ((value: unknown) => void) | ((error: Error) => void) | ((code: number) => void)): this {
    ;(this.listeners[event] as Set<typeof listener>).add(listener)
    return this
  }

  terminate(): Promise<number> {
    return Promise.resolve(0)
  }

  emitMessage(value: unknown): void {
    for (const listener of this.listeners.message) listener(value)
  }

  emitError(error: Error): void {
    for (const listener of this.listeners.error) listener(error)
  }

  emitExit(code: number): void {
    for (const listener of this.listeners.exit) listener(code)
  }
}

class ThrowingTransport extends ControllableTransport {
  private readonly throwOnType: string

  constructor(throwOnType: string) {
    super()
    this.throwOnType = throwOnType
  }

  override send(message: unknown): void {
    const type = (message as { type?: unknown }).type
    if (type === this.throwOnType) throw new Error(`send failed for ${this.throwOnType}`)
    super.send(message)
  }
}

function readyMessage(generation: number, requestId = 1): unknown {
  return {
    type: "ready",
    protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
    workerGeneration: generation,
    requestId,
    ready: {
      workerGeneration: generation,
      threadId: 42,
      selectedDriver: "bun:sqlite",
      configRevision: 1,
      rawTarget: { configRevision: 1, requested: false, maxObjectBytes: 1024 },
    },
  }
}

describe("HistoryPersistenceRuntime synchronous send failures", () => {
  test("rejects start and enters terminal-failed when initialize send throws", async () => {
    const transport = new ThrowingTransport("initialize")
    const runtime = new HistoryPersistenceRuntimeImpl({ workerFactory: () => transport })

    await expect(runtime.start(startConfig())).rejects.toThrow("send failed for initialize")
    expect(runtime.snapshot()).toMatchObject({ terminalFailed: true, pendingEnvelopes: 0 })
  })

  test("settles an envelope as failed when the in-process parser rejects send", async () => {
    const runtime = createInProcessHistoryPersistenceRuntime()
    await runtime.start(startConfig())
    const invalid = envelope()
    const invalidCommand = { ...invalid.publication.rawAttachment.rawCommands[0], sequence: -1 }
    const invalidEnvelope = {
      ...invalid,
      publication: {
        ...invalid.publication,
        rawAttachment: { ...invalid.publication.rawAttachment, rawCommands: [invalidCommand] },
      },
    }
    let calls = 0
    let outcome: HistoryPersistenceOutcome | undefined

    runtime.enqueue(invalidEnvelope, (value) => {
      calls++
      outcome = value
    })

    expect(outcome).toBe("failed")
    expect(calls).toBe(1)
    expect(runtime.snapshot()).toMatchObject({ terminalFailed: true, pendingEnvelopes: 0 })
  })

  test("rejects drain immediately after shutdown instead of registering an unsendable request", async () => {
    const transport = new ControllableTransport()
    const runtime = new HistoryPersistenceRuntimeImpl({ workerFactory: () => transport })
    const start = runtime.start(startConfig())
    transport.emitMessage(readyMessage(1))
    await start
    await runtime.shutdown()
    const sentBeforeDrain = transport.sent.length

    await expect(runtime.drain()).rejects.toThrow("not started")
    expect(transport.sent).toHaveLength(sentBeforeDrain)
  })
})

describe("HistoryPersistenceRuntime ACK state", () => {
  test("ignores stale-generation ACKs and tombstones matching duplicate outcomes", async () => {
    const transport = new ControllableTransport()
    const runtime = new HistoryPersistenceRuntimeImpl({ workerFactory: () => transport })
    const start = runtime.start(startConfig())
    transport.emitMessage(readyMessage(1))
    await start

    let outcomes = 0
    const messageId = runtime.enqueue(envelope(), () => outcomes++)
    transport.emitMessage({
      type: "persist-result",
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: 99,
      messageId,
      outcome: "failed",
    })
    expect(runtime.snapshot().staleMessagesTotal).toBe(1)
    expect(outcomes).toBe(0)

    const ack = {
      type: "persist-result",
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: 1,
      messageId,
      outcome: "failed",
    }
    transport.emitMessage(ack)
    transport.emitMessage(ack)
    expect(outcomes).toBe(1)
    expect(runtime.snapshot().duplicateAcksTotal).toBe(1)
    await runtime.shutdown()
  })

  test("routes a forged main-owned Worker status field through the fatal transition", async () => {
    const transport = new ControllableTransport()
    const runtime = new HistoryPersistenceRuntimeImpl({ workerFactory: () => transport })
    const start = runtime.start(startConfig())
    transport.emitMessage(readyMessage(1))
    await start

    let outcome: HistoryPersistenceOutcome | undefined
    runtime.enqueue(envelope(), (value) => {
      outcome = value
    })
    const drain = runtime.drain()
    expect(runtime.snapshot()).toMatchObject({ terminalFailed: false, pendingEnvelopes: 1 })

    transport.emitMessage({
      type: "status",
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: 1,
      status: { terminalFailed: true },
    })

    expect(outcome).toBe("failed")
    await expect(drain).rejects.toThrow("status.status contains unknown field: terminalFailed")
    expect(runtime.snapshot()).toMatchObject({ terminalFailed: true, pendingEnvelopes: 0 })
    expect(runtime.snapshot().lastError).toContain("status.status contains unknown field: terminalFailed")
  })

  test("settles ACK state before isolating an outcome callback error", async () => {
    const transport = new ControllableTransport()
    const runtime = new HistoryPersistenceRuntimeImpl({ workerFactory: () => transport })
    const start = runtime.start(startConfig())
    transport.emitMessage(readyMessage(1))
    await start

    const messageId = runtime.enqueue(envelope(), () => {
      throw new Error("callback exploded")
    })
    const ack = {
      type: "persist-result",
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: 1,
      messageId,
      outcome: "failed",
    }

    expect(() => transport.emitMessage(ack)).not.toThrow()
    expect(runtime.snapshot()).toMatchObject({ pendingEnvelopes: 0, outcomeCallbackErrorsTotal: 1, lastOutcomeCallbackError: "callback exploded" })
    transport.emitMessage(ack)
    expect(runtime.snapshot().duplicateAcksTotal).toBe(1)
  })

  test("settles every pending envelope when the first terminal callback throws", async () => {
    const transport = new ControllableTransport()
    const runtime = new HistoryPersistenceRuntimeImpl({ workerFactory: () => transport })
    const start = runtime.start(startConfig())
    transport.emitMessage(readyMessage(1))
    await start

    let secondCalls = 0
    runtime.enqueue(envelope("op-1"), () => {
      throw new Error("first callback exploded")
    })
    runtime.enqueue(envelope("op-2"), (outcome) => {
      expect(outcome).toBe("failed")
      secondCalls++
    })

    expect(() => transport.emitError(new Error("worker exploded"))).not.toThrow()
    expect(secondCalls).toBe(1)
    expect(runtime.snapshot()).toMatchObject({
      terminalFailed: true,
      pendingEnvelopes: 0,
      lastError: "worker exploded",
      outcomeCallbackErrorsTotal: 1,
      lastOutcomeCallbackError: "first callback exploded",
    })
  })

  test("evicts completed ACK tombstones at the configured capacity", async () => {
    const transport = new ControllableTransport()
    const runtime = new HistoryPersistenceRuntimeImpl({ workerFactory: () => transport, tombstoneCapacity: 1 })
    const start = runtime.start(startConfig())
    transport.emitMessage(readyMessage(1))
    await start

    const firstId = runtime.enqueue(envelope("op-1"), () => {})
    transport.emitMessage({
      type: "persist-result",
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: 1,
      messageId: firstId,
      outcome: "failed",
    })
    const secondId = runtime.enqueue(envelope("op-2"), () => {})
    transport.emitMessage({
      type: "persist-result",
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: 1,
      messageId: secondId,
      outcome: "failed",
    })
    transport.emitMessage({
      type: "persist-result",
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: 1,
      messageId: firstId,
      outcome: "failed",
    })

    expect(runtime.snapshot().terminalFailed).toBe(true)
    expect(runtime.snapshot().lastError).toContain(`ACK for unknown History message ${firstId}`)
  })

  test("fails terminally when a duplicate ACK changes outcome", async () => {
    const transport = new ControllableTransport()
    const runtime = new HistoryPersistenceRuntimeImpl({ workerFactory: () => transport })
    const start = runtime.start(startConfig())
    transport.emitMessage(readyMessage(1))
    await start

    let outcomes = 0
    const messageId = runtime.enqueue(envelope(), () => outcomes++)
    transport.emitMessage({
      type: "persist-result",
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: 1,
      messageId,
      outcome: "failed",
    })
    transport.emitMessage({
      type: "persist-result",
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: 1,
      messageId,
      outcome: "persisted",
    })

    expect(runtime.snapshot().terminalFailed).toBe(true)
    expect(runtime.snapshot().lastError).toContain("changed outcome from failed to persisted")
    expect(outcomes).toBe(1)
  })

  test("rejects startup when the Worker exits before ready", async () => {
    const transport = new ControllableTransport()
    const runtime = new HistoryPersistenceRuntimeImpl({ workerFactory: () => transport })
    const start = runtime.start(startConfig())
    transport.emitExit(2)

    await expect(start).rejects.toThrow("exited unexpectedly with code 2")
    expect(runtime.snapshot().terminalFailed).toBe(true)
  })

  test("surfaces transport failure and settles pending outcomes as failed", async () => {
    const transport = new ControllableTransport()
    const runtime = new HistoryPersistenceRuntimeImpl({ workerFactory: () => transport })
    const start = runtime.start(startConfig())
    transport.emitMessage(readyMessage(1))
    await start

    const outcome = new Promise<HistoryPersistenceOutcome>((resolve) => runtime.enqueue(envelope(), resolve))
    transport.emitError(new Error("worker exploded"))
    expect(await outcome).toBe("failed")
    expect(runtime.snapshot().terminalFailed).toBe(true)
    expect(runtime.snapshot().lastError).toContain("worker exploded")
  })
})
