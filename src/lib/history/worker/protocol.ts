import type { ModelOperationRecord } from "~/lib/context/model-operation-record"

export const HISTORY_WORKER_PROTOCOL_VERSION = 1 as const

export type WorkerGeneration = number
export type HistoryMessageId = number
export type HistoryRequestId = number
export type HistoryPersistenceOutcome = "persisted" | "conflict" | "failed"
export type HistorySqliteDriver = "bun:sqlite" | "node:sqlite"

export interface RawTargetDescriptor {
  readonly configRevision: number
  readonly requested: boolean
  readonly dbPath?: string
  readonly storeId?: string
  readonly maxObjectBytes: number
  readonly workerLocalGeneration?: string
}

export interface RawCaptureCommand {
  readonly sequence: number
  readonly track: string
  readonly kind: string
  readonly bytes: Uint8Array
}

export interface RawOperationAttachment {
  readonly rawTarget: RawTargetDescriptor
  readonly rawCommands: ReadonlyArray<RawCaptureCommand>
}

export interface ModelOperationTerminalPublication {
  readonly record: ModelOperationRecord
  readonly rawAttachment: RawOperationAttachment
}

export interface HistoryOperationEnvelope {
  readonly protocolVersion: typeof HISTORY_WORKER_PROTOCOL_VERSION
  readonly publication: ModelOperationTerminalPublication
}

export interface HistoryWorkerRawConfig {
  readonly enabled: boolean
  readonly dbPath: string
  readonly maxObjectBytes: number
}

export interface HistoryPersistRetryConfig {
  readonly maxAttempts: number
  readonly backoffMs: number
  readonly maxTotalMs?: number
}

export interface HistoryWorkerHotConfig {
  readonly rawConfig: HistoryWorkerRawConfig
  readonly maintenanceIntervalMs: number
}

export interface HistoryWorkerStartConfig extends HistoryWorkerHotConfig {
  readonly semanticDbPath: string
  readonly configRevision: number
  readonly persistRetry: HistoryPersistRetryConfig
}

export interface HistoryWorkerReady {
  readonly workerGeneration: WorkerGeneration
  readonly threadId: number
  readonly selectedDriver: HistorySqliteDriver
  readonly configRevision: number
  readonly rawTarget: RawTargetDescriptor
}

export interface HistoryDrainResult {
  readonly outcomes: Readonly<Record<HistoryMessageId, HistoryPersistenceOutcome>>
}

export interface HistoryWorkerStatus {
  readonly workerGeneration: WorkerGeneration
  readonly threadId?: number
  readonly selectedDriver?: HistorySqliteDriver
  readonly ready: boolean
  readonly terminalFailed: boolean
  readonly pendingEnvelopes: number
  readonly pendingBytes: number
  readonly latestDesiredRevision: number
  readonly publishedRevision: number
  readonly restartsTotal: number
  readonly replaysTotal: number
  readonly staleMessagesTotal: number
  readonly duplicateAcksTotal: number
  readonly lastError?: string
}

interface MessageBase {
  readonly protocolVersion: typeof HISTORY_WORKER_PROTOCOL_VERSION
  readonly workerGeneration: WorkerGeneration
}

export interface InitializeMessage extends MessageBase {
  readonly type: "initialize"
  readonly requestId: HistoryRequestId
  readonly config: HistoryWorkerStartConfig
}

export interface PersistOperationMessage extends MessageBase {
  readonly type: "persist-operation"
  readonly messageId: HistoryMessageId
  readonly envelope: HistoryOperationEnvelope
}

export interface UpdateConfigMessage extends MessageBase {
  readonly type: "update-config"
  readonly requestId: HistoryRequestId
  readonly revision: number
  readonly config: HistoryWorkerHotConfig
}

export interface StopMaintenanceMessage extends MessageBase {
  readonly type: "stop-maintenance"
  readonly requestId: HistoryRequestId
}

export interface DrainMessage extends MessageBase {
  readonly type: "drain"
  readonly requestId: HistoryRequestId
}

export interface ShutdownMessage extends MessageBase {
  readonly type: "shutdown"
  readonly requestId: HistoryRequestId
}

export type MainToHistoryWorkerMessage =
  | InitializeMessage
  | PersistOperationMessage
  | UpdateConfigMessage
  | StopMaintenanceMessage
  | DrainMessage
  | ShutdownMessage

export interface ReadyMessage extends MessageBase {
  readonly type: "ready"
  readonly requestId: HistoryRequestId
  readonly ready: HistoryWorkerReady
}

export interface ConfigAppliedMessage extends MessageBase {
  readonly type: "config-applied"
  readonly requestId: HistoryRequestId
  readonly revision: number
  readonly rawTarget: RawTargetDescriptor
}

export interface PersistResultMessage extends MessageBase {
  readonly type: "persist-result"
  readonly messageId: HistoryMessageId
  readonly outcome: HistoryPersistenceOutcome
}

export interface StatusMessage extends MessageBase {
  readonly type: "status"
  readonly status: Partial<HistoryWorkerStatus>
}

export interface MaintenanceStoppedMessage extends MessageBase {
  readonly type: "maintenance-stopped"
  readonly requestId: HistoryRequestId
}

export interface DrainedMessage extends MessageBase {
  readonly type: "drained"
  readonly requestId: HistoryRequestId
  readonly result: HistoryDrainResult
}

export interface ClosedMessage extends MessageBase {
  readonly type: "closed"
  readonly requestId: HistoryRequestId
}

export interface FatalMessage extends MessageBase {
  readonly type: "fatal"
  readonly error: string
  readonly requestId?: HistoryRequestId
}

export type HistoryWorkerToMainMessage =
  | ReadyMessage
  | ConfigAppliedMessage
  | PersistResultMessage
  | StatusMessage
  | MaintenanceStoppedMessage
  | DrainedMessage
  | ClosedMessage
  | FatalMessage

export function detectHistorySqliteDriver(): HistorySqliteDriver {
  return typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? "node:sqlite" : "bun:sqlite"
}

export function createRawTargetDescriptor(revision: number, config: HistoryWorkerRawConfig): RawTargetDescriptor {
  return {
    configRevision: revision,
    requested: config.enabled,
    ...(config.enabled && { dbPath: config.dbPath }),
    maxObjectBytes: config.maxObjectBytes,
  }
}

export class HistoryWorkerProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "HistoryWorkerProtocolError"
  }
}

export function assertStructuredCloneSafe(value: unknown, label: string): void {
  try {
    structuredClone(value)
  } catch (error) {
    throw new HistoryWorkerProtocolError(`${label} is not structured-clone safe`, { cause: error })
  }
}

export function parseMainToWorkerMessage(value: unknown): MainToHistoryWorkerMessage {
  const message = parseBase(value, "main→History Worker")
  switch (message.type) {
    case "initialize": {
      assertPositiveInteger(message.requestId, "initialize.requestId")
      assertObject(message.config, "initialize.config")
      break
    }
    case "persist-operation": {
      assertPositiveInteger(message.messageId, "persist-operation.messageId")
      assertHistoryOperationEnvelope(message.envelope)
      break
    }
    case "update-config": {
      assertPositiveInteger(message.requestId, "update-config.requestId")
      assertNonNegativeInteger(message.revision, "update-config.revision")
      assertObject(message.config, "update-config.config")
      break
    }
    case "stop-maintenance":
    case "drain":
    case "shutdown": {
      assertPositiveInteger(message.requestId, `${message.type}.requestId`)
      break
    }
    default: {
      throw new HistoryWorkerProtocolError(`unknown main→History Worker message type: ${message.type}`)
    }
  }
  return message as unknown as MainToHistoryWorkerMessage
}

export function parseWorkerToMainMessage(value: unknown): HistoryWorkerToMainMessage {
  const message = parseBase(value, "History Worker→main")
  switch (message.type) {
    case "ready": {
      assertPositiveInteger(message.requestId, "ready.requestId")
      assertHistoryWorkerReady(message.ready, message.workerGeneration)
      break
    }
    case "config-applied": {
      assertPositiveInteger(message.requestId, "config-applied.requestId")
      assertNonNegativeInteger(message.revision, "config-applied.revision")
      assertObject(message.rawTarget, "config-applied.rawTarget")
      break
    }
    case "persist-result": {
      assertPositiveInteger(message.messageId, "persist-result.messageId")
      if (message.outcome !== "persisted" && message.outcome !== "conflict" && message.outcome !== "failed") {
        throw new HistoryWorkerProtocolError(`invalid persist-result.outcome: ${String(message.outcome)}`)
      }
      break
    }
    case "status": {
      assertObject(message.status, "status.status")
      break
    }
    case "maintenance-stopped":
    case "drained":
    case "closed": {
      assertPositiveInteger(message.requestId, `${message.type}.requestId`)
      if (message.type === "drained") assertObject(message.result, "drained.result")
      break
    }
    case "fatal": {
      if (typeof message.error !== "string" || message.error.length === 0) throw new HistoryWorkerProtocolError("fatal.error must be a non-empty string")
      if (message.requestId !== undefined) assertPositiveInteger(message.requestId, "fatal.requestId")
      break
    }
    default: {
      throw new HistoryWorkerProtocolError(`unknown History Worker→main message type: ${message.type}`)
    }
  }
  return message as unknown as HistoryWorkerToMainMessage
}

function assertHistoryOperationEnvelope(value: unknown): asserts value is HistoryOperationEnvelope {
  assertObject(value, "persist-operation.envelope")
  if (value.protocolVersion !== HISTORY_WORKER_PROTOCOL_VERSION) {
    throw new HistoryWorkerProtocolError(
      `persist-operation.envelope protocol version mismatch: expected ${HISTORY_WORKER_PROTOCOL_VERSION}, received ${String(value.protocolVersion)}`,
    )
  }
  assertObject(value.publication, "persist-operation.envelope.publication")
  assertObject(value.publication.record, "persist-operation.envelope.publication.record")
  assertObject(value.publication.rawAttachment, "persist-operation.envelope.publication.rawAttachment")
  assertRawTargetDescriptor(value.publication.rawAttachment.rawTarget, "persist-operation.envelope.publication.rawAttachment.rawTarget")
  if (!Array.isArray(value.publication.rawAttachment.rawCommands)) {
    throw new HistoryWorkerProtocolError("persist-operation.envelope.publication.rawAttachment.rawCommands must be an array")
  }
  for (const [index, command] of value.publication.rawAttachment.rawCommands.entries()) {
    assertObject(command, `persist-operation raw command ${index}`)
    assertNonNegativeInteger(command.sequence, `persist-operation raw command ${index}.sequence`)
    if (typeof command.track !== "string" || typeof command.kind !== "string" || !(command.bytes instanceof Uint8Array)) {
      throw new HistoryWorkerProtocolError(`persist-operation raw command ${index} has an invalid track, kind, or bytes value`)
    }
  }
  assertStructuredCloneSafe(value, "persist-operation.envelope")
}

function assertHistoryWorkerReady(value: unknown, messageGeneration: number): asserts value is HistoryWorkerReady {
  assertObject(value, "ready.ready")
  assertPositiveInteger(value.workerGeneration, "ready.ready.workerGeneration")
  if (value.workerGeneration !== messageGeneration) {
    throw new HistoryWorkerProtocolError(`ready.ready.workerGeneration ${value.workerGeneration} does not match message generation ${messageGeneration}`)
  }
  assertPositiveInteger(value.threadId, "ready.ready.threadId")
  if (value.selectedDriver !== "bun:sqlite" && value.selectedDriver !== "node:sqlite") {
    throw new HistoryWorkerProtocolError(`ready.ready.selectedDriver is invalid: ${String(value.selectedDriver)}`)
  }
  assertNonNegativeInteger(value.configRevision, "ready.ready.configRevision")
  assertRawTargetDescriptor(value.rawTarget, "ready.ready.rawTarget")
}

function assertRawTargetDescriptor(value: unknown, label: string): asserts value is RawTargetDescriptor {
  assertObject(value, label)
  assertNonNegativeInteger(value.configRevision, `${label}.configRevision`)
  if (typeof value.requested !== "boolean") throw new HistoryWorkerProtocolError(`${label}.requested must be a boolean`)
  if (value.dbPath !== undefined && typeof value.dbPath !== "string") throw new HistoryWorkerProtocolError(`${label}.dbPath must be a string`)
  if (value.storeId !== undefined && typeof value.storeId !== "string") throw new HistoryWorkerProtocolError(`${label}.storeId must be a string`)
  assertNonNegativeInteger(value.maxObjectBytes, `${label}.maxObjectBytes`)
  if (value.workerLocalGeneration !== undefined && typeof value.workerLocalGeneration !== "string") {
    throw new HistoryWorkerProtocolError(`${label}.workerLocalGeneration must be a string`)
  }
}

function parseBase(value: unknown, direction: string): Record<string, unknown> & { type: string; workerGeneration: number } {
  assertObject(value, `${direction} message`)
  if (value.protocolVersion !== HISTORY_WORKER_PROTOCOL_VERSION) {
    throw new HistoryWorkerProtocolError(
      `${direction} protocol version mismatch: expected ${HISTORY_WORKER_PROTOCOL_VERSION}, received ${String(value.protocolVersion)}`,
    )
  }
  assertPositiveInteger(value.workerGeneration, `${direction} workerGeneration`)
  if (typeof value.type !== "string" || value.type.length === 0) throw new HistoryWorkerProtocolError(`${direction} type must be a non-empty string`)
  return value as Record<string, unknown> & { type: string; workerGeneration: number }
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HistoryWorkerProtocolError(`${label} must be an object`)
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new HistoryWorkerProtocolError(`${label} must be a positive safe integer`)
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new HistoryWorkerProtocolError(`${label} must be a non-negative safe integer`)
}
