import {
  //
  isMainThread,
  parentPort,
  threadId,
} from "node:worker_threads"

import { createDatabase } from "~/lib/sqlite/driver"

import type {
  //
  HistoryPersistenceOutcome,
  HistorySqliteDriver,
  MainToHistoryWorkerMessage,
} from "./protocol"

import {
  //
  HISTORY_WORKER_PROTOCOL_VERSION,
  createRawTargetDescriptor,
  detectHistorySqliteDriver,
  parseMainToWorkerMessage,
} from "./protocol"

interface SqliteProbeResult {
  readonly selectedDriver: HistorySqliteDriver
  readonly n: number
}

const directProbe = process.argv.includes("--probe")

if (directProbe) {
  process.stdout.write(`${JSON.stringify(runSqliteProbe())}\n`)
} else if (!isMainThread && parentPort) {
  installHistoryWorker(parentPort)
}

function installHistoryWorker(port: NonNullable<typeof parentPort>): void {
  const outcomes: Record<number, HistoryPersistenceOutcome> = {}
  port.on("message", (value) => {
    let message: MainToHistoryWorkerMessage | undefined
    try {
      message = parseMainToWorkerMessage(value)
      handleMessage(port, message, outcomes)
    } catch (error) {
      send(port, {
        type: "fatal",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: message?.workerGeneration ?? readWorkerGeneration(value),
        ...(message && "requestId" in message && { requestId: message.requestId }),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

function handleMessage(port: NonNullable<typeof parentPort>, message: MainToHistoryWorkerMessage, outcomes: Record<number, HistoryPersistenceOutcome>): void {
  switch (message.type) {
    case "initialize": {
      const probe = runSqliteProbe()
      send(port, {
        type: "ready",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: message.workerGeneration,
        requestId: message.requestId,
        ready: {
          workerGeneration: message.workerGeneration,
          threadId,
          selectedDriver: probe.selectedDriver,
          configRevision: message.config.configRevision,
          rawTarget: createRawTargetDescriptor(message.config.configRevision, message.config.rawConfig),
        },
      })
      break
    }
    case "persist-operation": {
      outcomes[message.messageId] = "failed"
      send(port, {
        type: "persist-result",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: message.workerGeneration,
        messageId: message.messageId,
        outcome: "failed",
      })
      break
    }
    case "update-config": {
      send(port, {
        type: "config-applied",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: message.workerGeneration,
        requestId: message.requestId,
        revision: message.revision,
        rawTarget: createRawTargetDescriptor(message.revision, message.config.rawConfig),
      })
      break
    }
    case "stop-maintenance": {
      send(port, {
        type: "maintenance-stopped",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: message.workerGeneration,
        requestId: message.requestId,
      })
      break
    }
    case "drain": {
      send(port, {
        type: "drained",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: message.workerGeneration,
        requestId: message.requestId,
        result: { outcomes },
      })
      break
    }
    case "shutdown": {
      send(port, {
        type: "closed",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: message.workerGeneration,
        requestId: message.requestId,
      })
      port.close()
      break
    }
    default: {
      message satisfies never
    }
  }
}

function send(port: NonNullable<typeof parentPort>, message: unknown): void {
  // Node MessagePort has no browser targetOrigin parameter; keep the lint exception at this adapter boundary.
  // eslint-disable-next-line unicorn/require-post-message-target-origin
  port.postMessage(message)
}

function runSqliteProbe(): SqliteProbeResult {
  const db = createDatabase(":memory:")
  try {
    db.exec("CREATE TABLE history_worker_probe (n INTEGER NOT NULL)")
    db.prepare("INSERT INTO history_worker_probe (n) VALUES (?)").run(7)
    const row = db.prepare("SELECT n FROM history_worker_probe").get() as { n?: number } | null | undefined
    if (row?.n !== 7) throw new Error(`History Worker SQLite probe returned ${String(row?.n)}`)
    return { selectedDriver: detectHistorySqliteDriver(), n: row.n }
  } finally {
    db.close()
  }
}

function readWorkerGeneration(value: unknown): number {
  if (typeof value !== "object" || value === null) return 1
  const generation = (value as { workerGeneration?: unknown }).workerGeneration
  return Number.isSafeInteger(generation) && (generation as number) > 0 ? (generation as number) : 1
}
