import consola from "consola"
import { threadId } from "node:worker_threads"

import type { ModelOperationRecord } from "~/lib/context/model-operation-record"
import type { Database } from "~/lib/history/sqlite/connection"

import { runHistoryWriteAsync } from "~/lib/history/persist-guard"
import { openOwnedHistoryDatabase } from "~/lib/history/sqlite/connection"
import { applyForwardMigrations } from "~/lib/history/sqlite/migrations/run"
import {
  //
  V3OperationConflictError,
  commitPreparedOperation,
  ensureV3Schema,
  prepareModelOperation,
  recoverV3Journal,
  runWithTransientRetry,
} from "~/lib/history/v3/store"

import type {
  //
  HistoryDrainResult,
  HistoryMessageId,
  HistoryOperationEnvelope,
  HistoryPersistenceOutcome,
  HistorySqliteDriver,
  HistoryWorkerHotConfig,
  HistoryWorkerStartConfig,
  MainToHistoryWorkerMessage,
  RawTargetDescriptor,
} from "./protocol"

import {
  //
  HISTORY_WORKER_PROTOCOL_VERSION,
  createRawTargetDescriptor,
  detectHistorySqliteDriver,
  parseMainToWorkerMessage,
} from "./protocol"

/**
 * Worker-side ownership of the History semantic database.
 *
 * Everything here runs on the Worker thread: the write connection, canonical prepare,
 * hashing/compression, the journal, the operation transaction and its transient-retry
 * budget. Nothing in this module may reach for a main-thread singleton — the whole point
 * of the migration is that these are the exact synchronous blocks that used to freeze the
 * proxy's event loop.
 *
 * Raw capture, backfill and query RPC land in later batches; this backend deliberately
 * exposes no placeholder for them rather than a shell that returns success.
 */
export interface HistoryWorkerBackendDeps {
  /** Injected so a fixture can wrap the handle; production owns its own via `openOwnedHistoryDatabase`. */
  readonly openSemanticDatabase?: (dbPath: string) => Database
  /** Injected backoff seam; production leaves it unset and `runWithTransientRetry` uses `abortableDelay`. */
  readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface HistoryWorkerBackendReady {
  readonly selectedDriver: HistorySqliteDriver
  readonly rawTarget: RawTargetDescriptor
  readonly recoveredJournalOperations: number
}

export interface HistoryWorkerBackend {
  /** Open, reconcile, migrate and recover. Throws on any unrecoverable startup condition. */
  initialize(config: HistoryWorkerStartConfig): Promise<HistoryWorkerBackendReady>
  persist(envelope: HistoryOperationEnvelope): Promise<HistoryPersistenceOutcome>
  applyConfig(revision: number, config: HistoryWorkerHotConfig): RawTargetDescriptor
  stopMaintenance(): void
  close(): void
}

export function createHistoryWorkerBackend(deps: HistoryWorkerBackendDeps = {}): HistoryWorkerBackend {
  const open = deps.openSemanticDatabase ?? openOwnedHistoryDatabase
  let database: Database | undefined
  let startConfig: HistoryWorkerStartConfig | undefined

  return {
    async initialize(config) {
      if (database) throw new Error("[history/worker] backend is already initialized")
      const opened = open(config.semanticDbPath)
      let recoveredJournalOperations: number
      try {
        ensureV3Schema(opened)
        // RETHROWS on failure: a half-applied schema migration must refuse to become
        // ready, so the runtime reports `fatal` and startup never listens (spec §8.1).
        await applyForwardMigrations(opened)
        recoveredJournalOperations = recoverV3Journal(opened)
      } catch (error) {
        opened.close()
        throw error
      }
      database = opened
      startConfig = config
      return {
        selectedDriver: detectHistorySqliteDriver(),
        rawTarget: createRawTargetDescriptor(config.configRevision, config.rawConfig),
        recoveredJournalOperations,
      }
    },

    async persist(envelope) {
      const db = database
      const config = startConfig
      if (!db || !config) throw new Error("[history/worker] persist called before initialize")

      let prepared
      try {
        // The wire record omits the non-enumerable `attempts` alias by contract
        // (structured clone drops it anyway); `prepareModelOperation` reads `dispatches`.
        prepared = prepareModelOperation(envelope.publication.record as unknown as ModelOperationRecord)
      } catch (error) {
        consola.error(`[history/worker] failed to prepare operation ${envelope.publication.record.identity.operationId}`, error)
        return "failed"
      }

      const outcome = await runWithTransientRetry(
        async () => {
          let attemptConflict = false
          const result = await runHistoryWriteAsync("history-worker-persist", async () => {
            try {
              commitPreparedOperation(db, prepared)
            } catch (error) {
              // A conflict is a data-contract violation, never a persistence failure:
              // report it as a settled attempt so the retry loop stops immediately.
              if (error instanceof V3OperationConflictError) {
                attemptConflict = true
                return
              }
              throw error
            }
          })
          return { ok: result.ok && !attemptConflict, transient: result.transient, conflict: attemptConflict }
        },
        {
          maxAttempts: config.persistRetry.maxAttempts,
          backoffMs: config.persistRetry.backoffMs,
          maxBackoffMs: config.persistRetry.maxBackoffMs,
          maxTotalMs: config.persistRetry.maxTotalMs,
          ...(deps.delay && { delay: deps.delay }),
        },
      )
      if (outcome.conflict) return "conflict"
      return outcome.ok ? "persisted" : "failed"
    },

    applyConfig(revision, config) {
      if (startConfig) startConfig = { ...startConfig, ...config, configRevision: revision }
      return createRawTargetDescriptor(revision, config.rawConfig)
    },

    stopMaintenance() {
      // Batch 2a owns no maintenance unit — no backfill, checkpoint, vacuum or optimize
      // runs in the Worker yet, so there is nothing to stop and nothing to wait for.
      // Deliberately NOT a flag: a gate that no code reads would suggest maintenance is
      // being suppressed. Batch 4b introduces the loops and must make this stop them.
    },

    close() {
      const opened = database
      database = undefined
      startConfig = undefined
      opened?.close()
    },
  }
}

/**
 * Bind the Worker's message port to a backend.
 *
 * Lives here rather than in the Worker entry so a test fixture can drive the REAL loop
 * with a wrapped backend. `history-worker.ts` stays a three-line entry, and there is no
 * second, friendlier implementation of the protocol for tests to pass against.
 *
 * Persistence is serialized through a single promise chain: SQLite has one writer, and
 * `drain` means "everything received so far has a terminal outcome", which is only
 * well-defined against an ordered queue.
 */
export function installHistoryWorkerMessageLoop(port: HistoryWorkerPort, backend: HistoryWorkerBackend): void {
  const outcomes: Record<HistoryMessageId, HistoryPersistenceOutcome> = {}
  let chain: Promise<unknown> = Promise.resolve()

  port.on("message", (value: unknown) => {
    let message: MainToHistoryWorkerMessage | undefined
    try {
      message = parseMainToWorkerMessage(value)
    } catch (error) {
      sendFatal(port, readWorkerGeneration(value), undefined, error)
      return
    }
    const parsed = message
    chain = chain
      .then(() => handleMessage(port, parsed, backend, outcomes))
      .catch((error: unknown) => {
        sendFatal(port, parsed.workerGeneration, "requestId" in parsed ? parsed.requestId : undefined, error)
      })
  })
}

export interface HistoryWorkerPort {
  postMessage(value: unknown): void
  on(event: "message", listener: (value: unknown) => void): unknown
  close(): void
}

async function handleMessage(
  port: HistoryWorkerPort,
  message: MainToHistoryWorkerMessage,
  backend: HistoryWorkerBackend,
  outcomes: Record<HistoryMessageId, HistoryPersistenceOutcome>,
): Promise<void> {
  switch (message.type) {
    case "initialize": {
      const ready = await backend.initialize(message.config)
      send(port, {
        type: "ready",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: message.workerGeneration,
        requestId: message.requestId,
        ready: {
          workerGeneration: message.workerGeneration,
          threadId: currentThreadId(),
          selectedDriver: ready.selectedDriver,
          configRevision: message.config.configRevision,
          rawTarget: ready.rawTarget,
        },
      })
      break
    }
    case "persist-operation": {
      const outcome = await backend.persist(message.envelope)
      outcomes[message.messageId] = outcome
      send(port, {
        type: "persist-result",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: message.workerGeneration,
        messageId: message.messageId,
        outcome,
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
        rawTarget: backend.applyConfig(message.revision, message.config),
      })
      break
    }
    case "stop-maintenance": {
      backend.stopMaintenance()
      send(port, {
        type: "maintenance-stopped",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: message.workerGeneration,
        requestId: message.requestId,
      })
      break
    }
    case "drain": {
      // Reaching this point in the serialized chain IS the barrier: every
      // `persist-operation` received before this message already has its outcome.
      const result: HistoryDrainResult = { outcomes: { ...outcomes } }
      send(port, {
        type: "drained",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: message.workerGeneration,
        requestId: message.requestId,
        result,
      })
      break
    }
    case "shutdown": {
      backend.close()
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

function send(port: HistoryWorkerPort, message: unknown): void {
  // Node MessagePort has no browser targetOrigin parameter; keep the lint exception at this adapter boundary.
  // eslint-disable-next-line unicorn/require-post-message-target-origin
  port.postMessage(message)
}

function sendFatal(port: HistoryWorkerPort, workerGeneration: number, requestId: number | undefined, error: unknown): void {
  send(port, {
    type: "fatal",
    protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
    workerGeneration,
    ...(requestId !== undefined && { requestId }),
    error: error instanceof Error ? error.message : String(error),
  })
}

function currentThreadId(): number {
  // `threadId` is 0 on the main thread; this loop only ever runs inside a Worker, and the
  // protocol requires a positive integer, so the fallback is a guard, not a normal path.
  return threadId > 0 ? threadId : 1
}

function readWorkerGeneration(value: unknown): number {
  if (typeof value !== "object" || value === null) return 1
  const generation = (value as { workerGeneration?: unknown }).workerGeneration
  return Number.isSafeInteger(generation) && (generation as number) > 0 ? (generation as number) : 1
}
