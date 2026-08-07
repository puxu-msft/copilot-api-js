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

export type CanonicalModelOperationWireRecord = Omit<ModelOperationRecord, "attempts">

export interface ModelOperationTerminalPublication {
  readonly record: CanonicalModelOperationWireRecord
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
  readonly outcomeCallbackErrorsTotal: number
  readonly statusObserverErrorsTotal: number
  readonly lastError?: string
  readonly lastOutcomeCallbackError?: string
  readonly lastStatusObserverError?: string
}

/** Fields produced by the Worker itself; all other runtime status fields remain main-owned. */
export interface HistoryWorkerStatusPatch {
  readonly threadId?: number
  readonly selectedDriver?: HistorySqliteDriver
  readonly ready?: boolean
  readonly publishedRevision?: number
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
  readonly status: HistoryWorkerStatusPatch
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
      assertHistoryWorkerStartConfig(message.config, "initialize.config")
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
      assertHistoryWorkerHotConfig(message.config, "update-config.config")
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
      assertRawTargetDescriptor(message.rawTarget, "config-applied.rawTarget")
      if (message.rawTarget.configRevision !== message.revision) {
        throw new HistoryWorkerProtocolError("config-applied.rawTarget.configRevision must match config-applied.revision")
      }
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
      assertHistoryWorkerStatusPatch(message.status)
      break
    }
    case "maintenance-stopped":
    case "closed": {
      assertPositiveInteger(message.requestId, `${message.type}.requestId`)
      break
    }
    case "drained": {
      assertPositiveInteger(message.requestId, "drained.requestId")
      assertHistoryDrainResult(message.result)
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
  assertModelOperationRecord(value.publication.record)
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

function assertHistoryWorkerStartConfig(value: unknown, label: string): asserts value is HistoryWorkerStartConfig {
  assertObject(value, label)
  assertHistoryWorkerHotConfigFields(value, label)
  if (typeof value.semanticDbPath !== "string" || value.semanticDbPath.length === 0) {
    throw new HistoryWorkerProtocolError(`${label}.semanticDbPath must be a non-empty string`)
  }
  assertNonNegativeInteger(value.configRevision, `${label}.configRevision`)
  assertObject(value.persistRetry, `${label}.persistRetry`)
  assertPositiveInteger(value.persistRetry.maxAttempts, `${label}.persistRetry.maxAttempts`)
  assertNonNegativeInteger(value.persistRetry.backoffMs, `${label}.persistRetry.backoffMs`)
  if (value.persistRetry.maxTotalMs !== undefined) {
    assertNonNegativeInteger(value.persistRetry.maxTotalMs, `${label}.persistRetry.maxTotalMs`)
  }
}

function assertHistoryWorkerHotConfig(value: unknown, label: string): asserts value is HistoryWorkerHotConfig {
  assertObject(value, label)
  assertHistoryWorkerHotConfigFields(value, label)
}

function assertHistoryWorkerHotConfigFields(value: Record<string, unknown>, label: string): void {
  assertHistoryWorkerRawConfig(value.rawConfig, `${label}.rawConfig`)
  assertNonNegativeInteger(value.maintenanceIntervalMs, `${label}.maintenanceIntervalMs`)
}

function assertHistoryWorkerRawConfig(value: unknown, label: string): asserts value is HistoryWorkerRawConfig {
  assertObject(value, label)
  if (typeof value.enabled !== "boolean") throw new HistoryWorkerProtocolError(`${label}.enabled must be a boolean`)
  if (typeof value.dbPath !== "string") throw new HistoryWorkerProtocolError(`${label}.dbPath must be a string`)
  assertNonNegativeInteger(value.maxObjectBytes, `${label}.maxObjectBytes`)
}

function assertModelOperationRecord(value: unknown): asserts value is ModelOperationRecord {
  assertObject(value, "persist-operation.envelope.publication.record")
  assertObject(value.identity, "ModelOperationRecord.identity")
  if (typeof value.identity.operationId !== "string" || value.identity.operationId.length === 0) {
    throw new HistoryWorkerProtocolError("ModelOperationRecord.identity.operationId must be a non-empty string")
  }
  if (!isOperationKind(value.identity.kind)) {
    throw new HistoryWorkerProtocolError(`ModelOperationRecord.identity.kind is invalid: ${safeString(value.identity.kind)}`)
  }
  assertFiniteNumber(value.identity.createdAt, "ModelOperationRecord.identity.createdAt")
  assertObject(value.arena, "ModelOperationRecord.arena")
  assertArenaNodes(value.arena.payloads, "ModelOperationRecord.arena.payloads")
  assertArenaNodes(value.arena.frames, "ModelOperationRecord.arena.frames")
  assertArray(value.transforms, "ModelOperationRecord.transforms")
  assertArray(value.candidates, "ModelOperationRecord.candidates")
  assertArray(value.dispatches, "ModelOperationRecord.dispatches")
  if (Object.prototype.propertyIsEnumerable.call(value, "attempts")) {
    throw new HistoryWorkerProtocolError("ModelOperationRecord.attempts must not be serialized; use dispatches")
  }
  for (const field of ["ingress", "routing", "egress"] as const) {
    if (value[field] !== null && (typeof value[field] !== "object" || Array.isArray(value[field]))) {
      throw new HistoryWorkerProtocolError(`ModelOperationRecord.${field} must be an object or null`)
    }
  }
  assertObject(value.extensions, "ModelOperationRecord.extensions")
  assertPositiveInteger(value.lastSequence, "ModelOperationRecord.lastSequence")
  assertCanonicalTerminal(value.terminal, value.lastSequence, value.candidates, value.dispatches)
}

function assertCanonicalTerminal(value: unknown, lastSequence: number, candidates: ReadonlyArray<unknown>, dispatches: ReadonlyArray<unknown>): void {
  assertObject(value, "ModelOperationRecord.terminal")
  assertPositiveInteger(value.sequence, "ModelOperationRecord.terminal.sequence")
  if (value.sequence !== lastSequence) {
    throw new HistoryWorkerProtocolError("ModelOperationRecord.terminal.sequence must equal ModelOperationRecord.lastSequence")
  }
  if (!isTerminalOutcome(value.outcome)) {
    throw new HistoryWorkerProtocolError(`ModelOperationRecord.terminal.outcome is invalid: ${safeString(value.outcome)}`)
  }
  const candidateHandles = collectHandles(candidates, "ModelOperationRecord.candidates")
  const dispatchHandles = collectHandles(dispatches, "ModelOperationRecord.dispatches")
  if (value.winnerCandidate !== undefined && (typeof value.winnerCandidate !== "string" || !candidateHandles.has(value.winnerCandidate))) {
    throw new HistoryWorkerProtocolError("ModelOperationRecord.terminal.winnerCandidate must reference an existing candidate")
  }
  if (value.committedDispatch !== undefined && (typeof value.committedDispatch !== "string" || !dispatchHandles.has(value.committedDispatch))) {
    throw new HistoryWorkerProtocolError("ModelOperationRecord.terminal.committedDispatch must reference an existing dispatch")
  }
  if (value.committedAttempt !== undefined && value.committedAttempt !== value.committedDispatch) {
    throw new HistoryWorkerProtocolError("ModelOperationRecord.terminal.committedAttempt must alias committedDispatch")
  }
}

function collectHandles(values: ReadonlyArray<unknown>, label: string): Set<string> {
  const handles = new Set<string>()
  for (const [index, value] of values.entries()) {
    assertObject(value, `${label}[${index}]`)
    if (typeof value.handle !== "string" || value.handle.length === 0) {
      throw new HistoryWorkerProtocolError(`${label}[${index}].handle must be a non-empty string`)
    }
    handles.add(value.handle)
  }
  return handles
}

function assertArenaNodes(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new HistoryWorkerProtocolError(`${label} must be an array`)
  for (const [index, node] of value.entries()) {
    assertObject(node, `${label}[${index}]`)
    if (typeof node.handle !== "string" || node.handle.length === 0) {
      throw new HistoryWorkerProtocolError(`${label}[${index}].handle must be a non-empty string`)
    }
    assertNonNegativeInteger(node.sequence, `${label}[${index}].sequence`)
    if (node.provenance !== "source" && node.provenance !== "derived") {
      throw new HistoryWorkerProtocolError(`${label}[${index}].provenance is invalid`)
    }
    assertObject(node.origin, `${label}[${index}].origin`)
  }
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
  if (value.rawTarget.configRevision !== value.configRevision) {
    throw new HistoryWorkerProtocolError("ready.ready.rawTarget.configRevision must match ready.ready.configRevision")
  }
}

function assertHistoryWorkerStatusPatch(value: unknown): asserts value is HistoryWorkerStatusPatch {
  assertObject(value, "status.status")
  const allowed = new Set(["threadId", "selectedDriver", "ready", "publishedRevision", "lastError"])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new HistoryWorkerProtocolError(`status.status contains unknown field: ${key}`)
  }
  if (value.threadId !== undefined) assertPositiveInteger(value.threadId, "status.status.threadId")
  if (value.selectedDriver !== undefined && value.selectedDriver !== "bun:sqlite" && value.selectedDriver !== "node:sqlite") {
    throw new HistoryWorkerProtocolError(`status.status.selectedDriver is invalid: ${safeString(value.selectedDriver)}`)
  }
  if (value.ready !== undefined && typeof value.ready !== "boolean") throw new HistoryWorkerProtocolError("status.status.ready must be a boolean")
  if (value.publishedRevision !== undefined) assertNonNegativeInteger(value.publishedRevision, "status.status.publishedRevision")
  if (value.lastError !== undefined && typeof value.lastError !== "string") throw new HistoryWorkerProtocolError("status.status.lastError must be a string")
}

function assertHistoryDrainResult(value: unknown): asserts value is HistoryDrainResult {
  assertObject(value, "drained.result")
  assertObject(value.outcomes, "drained.result.outcomes")
  for (const [messageId, outcome] of Object.entries(value.outcomes)) {
    if (!/^[1-9]\d*$/.test(messageId)) throw new HistoryWorkerProtocolError(`drained.result.outcomes has invalid message ID: ${messageId}`)
    if (!isPersistenceOutcome(outcome)) throw new HistoryWorkerProtocolError(`drained.result.outcomes[${messageId}] has invalid outcome: ${String(outcome)}`)
  }
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

function isOperationKind(value: unknown): boolean {
  return value === "generation" || value === "count_tokens" || value === "embeddings" || value === "responses_ws"
}

function isPersistenceOutcome(value: unknown): value is HistoryPersistenceOutcome {
  return value === "persisted" || value === "conflict" || value === "failed"
}

function isTerminalOutcome(value: unknown): boolean {
  return value === "completed" || value === "failed" || value === "cancelled" || value === "aborted" || value === "interrupted"
}

function safeString(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return String(value)
  return Object.prototype.toString.call(value)
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HistoryWorkerProtocolError(`${label} must be a finite number`)
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HistoryWorkerProtocolError(`${label} must be an object`)
}

function assertArray(value: unknown, label: string): asserts value is ReadonlyArray<unknown> {
  if (!Array.isArray(value)) throw new HistoryWorkerProtocolError(`${label} must be an array`)
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new HistoryWorkerProtocolError(`${label} must be a positive safe integer`)
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new HistoryWorkerProtocolError(`${label} must be a non-negative safe integer`)
}
