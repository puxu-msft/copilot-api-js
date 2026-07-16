/**
 * History V3's inert canonical record for one model operation.
 *
 * The recorder owns structural containers and recursively freezes captured JSON-like
 * values in place. No structured clone or JSON round-trip is performed: identity is
 * preserved, while producers must stop mutating values after registration. Opaque
 * platform objects are frozen at their outer boundary only.
 */

/** Kinds of model operations represented by the canonical record. */
export type OperationKind = "generation" | "count_tokens" | "embeddings" | "responses_ws"

/** Forward-compatible extension namespace. Values are intentionally opaque. */
export type OperationExtensions = Readonly<Record<string, unknown>>

/** Ordered HTTP field tuple. Repeated names and original ordering remain representable. */
export type OperationHeaderField = readonly [name: string, value: string]

/** Runtime capability of an exact raw capture boundary. */
export type CaptureCapability = "available" | "unavailable" | "not-requested"

/** Concrete transport selected for one generation attempt. */
export type OperationTransport = "http" | "upstream-ws" | "upstream-ws-fallback"

/** Cross-vendor usage with typed canonical counters and an open details bag. */
export interface OperationUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly toolSearchRequests?: number
  readonly details?: Readonly<Record<string, unknown>>
}

/** Provenance location for an arena node. */
export interface ArenaNodeOrigin {
  readonly stage: string
  readonly track: "client" | "upstream" | "proxy" | "internal"
  readonly attempt?: AttemptHandle
  readonly detail?: string
}

declare const payloadNodeHandleBrand: unique symbol

/** Opaque handle for a payload node in this record's arena. */
export type PayloadNodeHandle = string & { readonly [payloadNodeHandleBrand]: "PayloadNodeHandle" }

declare const frameNodeHandleBrand: unique symbol

/** Opaque handle for a frame node in this record's arena. */
export type FrameNodeHandle = string & { readonly [frameNodeHandleBrand]: "FrameNodeHandle" }

declare const attemptHandleBrand: unique symbol

/** Opaque handle for an attempt in this record. */
export type AttemptHandle = string & { readonly [attemptHandleBrand]: "AttemptHandle" }

/** Reference to either kind of arena node. */
export type ArenaNodeReference = Readonly<{ kind: "payload"; handle: PayloadNodeHandle }> | Readonly<{ kind: "frame"; handle: FrameNodeHandle }>

/** Common immutable fields for source and derived arena nodes. */
export interface ArenaNodeBase<Handle extends PayloadNodeHandle | FrameNodeHandle> {
  readonly handle: Handle
  readonly sequence: number
  readonly value: unknown
  readonly origin: Readonly<ArenaNodeOrigin>
  readonly mediaType?: string
  readonly extensions?: OperationExtensions
}

/** A node captured directly from one operation boundary. */
export interface SourceArenaNode<Handle extends PayloadNodeHandle | FrameNodeHandle> extends ArenaNodeBase<Handle> {
  readonly provenance: "source"
}

/** A node produced from another node by a named transform. */
export interface DerivedArenaNode<Handle extends PayloadNodeHandle | FrameNodeHandle> extends ArenaNodeBase<Handle> {
  readonly provenance: "derived"
  readonly derivedFrom: Handle
  readonly transformId: string
}

/** Immutable payload node. */
export type PayloadArenaNode = SourceArenaNode<PayloadNodeHandle> | DerivedArenaNode<PayloadNodeHandle>

/** Immutable frame node. */
export type FrameArenaNode = SourceArenaNode<FrameNodeHandle> | DerivedArenaNode<FrameNodeHandle>

/** Immutable payload/frame arena embedded in every canonical record snapshot. */
export interface ModelOperationArena {
  readonly payloads: ReadonlyArray<PayloadArenaNode>
  readonly frames: ReadonlyArray<FrameArenaNode>
}

/** Input accepted when registering an original payload or frame. */
export interface SourceNodeInput {
  readonly origin: ArenaNodeOrigin
  readonly mediaType?: string
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Input accepted when deriving a payload from another payload. */
export interface DerivedPayloadInput extends SourceNodeInput {
  readonly derivedFrom: PayloadNodeHandle
  readonly transformId: string
}

/** Input accepted when deriving a frame from another frame. */
export interface DerivedFrameInput extends SourceNodeInput {
  readonly derivedFrom: FrameNodeHandle
  readonly transformId: string
}

/** Arena-backed input for one independent request or response track. */
export interface OperationTrackInput {
  readonly payload?: PayloadNodeHandle
  readonly frames?: ReadonlyArray<FrameNodeHandle>
  readonly status?: number
  readonly headers?: ReadonlyArray<OperationHeaderField>
  readonly trailers?: ReadonlyArray<OperationHeaderField>
  readonly rawCapture?: Readonly<{ capability: CaptureCapability; ref?: string; byteLength?: number; gap?: string }>
  readonly metadata?: unknown
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Frozen track stored in the canonical record. */
export interface OperationTrack {
  readonly payload?: PayloadNodeHandle
  readonly frames: ReadonlyArray<FrameNodeHandle>
  readonly status?: number
  readonly headers?: ReadonlyArray<OperationHeaderField>
  readonly trailers?: ReadonlyArray<OperationHeaderField>
  readonly rawCapture?: Readonly<{ capability: CaptureCapability; ref?: string; byteLength?: number; gap?: string }>
  readonly metadata?: unknown
  readonly extensions?: OperationExtensions
}

/** Stable identity of one model operation. */
export interface ModelOperationIdentity {
  readonly operationId: string
  readonly kind: OperationKind
  readonly createdAt: number
  readonly parentOperationId?: string
  readonly sessionId?: string
  readonly agentId?: string
  readonly clientRequestId?: string
  readonly connectionId?: string
  readonly responseCreateId?: string
  readonly previousResponseId?: string
  readonly process?: Readonly<{ pid: number; bootTime?: number; version?: string; gitSha?: string; gitDirty?: boolean; synthetic?: boolean }>
  readonly extensions?: OperationExtensions
}

/** Client-to-proxy ingress capture. */
export interface ModelOperationIngress {
  readonly sequence: number
  readonly request: OperationTrack
  readonly format?: string
  readonly method?: string
  readonly path?: string
  readonly metadata?: unknown
  readonly extensions?: OperationExtensions
}

/** Model and transport routing decision. */
export interface ModelOperationRouting {
  readonly sequence: number
  readonly requestedModel?: string
  readonly resolvedModel?: string
  readonly clientFormat?: string
  readonly upstreamProtocol?: string
  readonly upstreamEndpoint?: string
  readonly transport?: string
  readonly metadata?: unknown
  readonly extensions?: OperationExtensions
}

/** One named transformation over arena nodes. */
export interface ModelOperationTransform {
  readonly sequence: number
  readonly transformId: string
  readonly stage: string
  readonly inputs: ReadonlyArray<ArenaNodeReference>
  readonly outputs: ReadonlyArray<ArenaNodeReference>
  readonly metadata?: unknown
  readonly extensions?: OperationExtensions
}

/** Attempt settlement verdict, independent from the operation terminal outcome. */
export type AttemptVerdict = "committed" | "discarded" | "failed"

/** Diagnostic retained on the attempt that produced it. */
export interface AttemptDiagnostic {
  readonly sequence: number
  readonly kind: string
  readonly severity: "info" | "warning" | "error"
  readonly message?: string
  readonly data?: unknown
  readonly extensions?: OperationExtensions
}

/** One upstream attempt, including failed/discarded diagnostic history. */
export interface ModelOperationAttempt {
  readonly handle: AttemptHandle
  readonly sequence: number
  readonly strategy?: string
  readonly transport?: OperationTransport
  readonly effectiveRequest?: OperationTrack
  readonly upstreamRequest?: OperationTrack
  readonly upstreamResponse?: OperationTrack
  readonly diagnostics: ReadonlyArray<AttemptDiagnostic>
  readonly verdict?: AttemptVerdict
  readonly settledSequence?: number
  readonly reason?: string
  readonly error?: unknown
  readonly metadata?: unknown
  readonly extensions?: OperationExtensions
  readonly settlementExtensions?: OperationExtensions
}

/** Independent upstream and client egress tracks. */
export interface ModelOperationEgress {
  readonly sequence: number
  readonly upstream: OperationTrack
  readonly client: OperationTrack
  readonly metadata?: unknown
  readonly extensions?: OperationExtensions
}

/** Final operation outcome. */
export type TerminalOutcome = "completed" | "failed" | "cancelled" | "aborted" | "interrupted"

/** Immutable terminal commit. */
export interface ModelOperationTerminal {
  readonly sequence: number
  readonly outcome: TerminalOutcome
  readonly committedAttempt?: AttemptHandle
  readonly error?: unknown
  readonly usage?: OperationUsage
  readonly attribution?: Readonly<{
    category?: "client" | "upstream" | "proxy" | "timeout" | "shutdown" | "reaper"
    code?: string
    detail?: string
  }>
  readonly metadata?: unknown
  readonly extensions?: OperationExtensions
}

/** Complete inert History V3 canonical record. */
export interface ModelOperationRecord {
  readonly identity: ModelOperationIdentity
  readonly arena: ModelOperationArena
  readonly ingress: ModelOperationIngress | null
  readonly routing: ModelOperationRouting | null
  readonly transforms: ReadonlyArray<ModelOperationTransform>
  readonly attempts: ReadonlyArray<ModelOperationAttempt>
  readonly egress: ModelOperationEgress | null
  readonly terminal: ModelOperationTerminal | null
  readonly extensions: OperationExtensions
  readonly lastSequence: number
}

/** Construction input for the canonical recorder. */
export interface CreateModelOperationRecorderInput {
  readonly identity: {
    readonly operationId: string
    readonly kind: OperationKind
    readonly createdAt: number
    readonly parentOperationId?: string
    readonly sessionId?: string
    readonly agentId?: string
    readonly clientRequestId?: string
    readonly connectionId?: string
    readonly responseCreateId?: string
    readonly previousResponseId?: string
    readonly process?: Readonly<{ pid: number; bootTime?: number; version?: string; gitSha?: string; gitDirty?: boolean; synthetic?: boolean }>
    readonly extensions?: Readonly<Record<string, unknown>>
  }
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Ingress recording input. */
export interface RecordIngressInput {
  readonly request: OperationTrackInput
  readonly format?: string
  readonly method?: string
  readonly path?: string
  readonly metadata?: unknown
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Routing recording input. */
export interface RecordRoutingInput {
  readonly requestedModel?: string
  readonly resolvedModel?: string
  readonly clientFormat?: string
  readonly upstreamProtocol?: string
  readonly upstreamEndpoint?: string
  readonly transport?: string
  readonly metadata?: unknown
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Transform recording input. */
export interface RecordTransformInput {
  readonly transformId: string
  readonly stage: string
  readonly inputs: ReadonlyArray<ArenaNodeReference>
  readonly outputs: ReadonlyArray<ArenaNodeReference>
  readonly metadata?: unknown
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Attempt start input. */
export interface BeginAttemptInput {
  readonly strategy?: string
  readonly transport?: OperationTransport
  readonly effectiveRequest?: OperationTrackInput
  readonly upstreamRequest?: OperationTrackInput
  readonly metadata?: unknown
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Attempt diagnostic input. */
export interface RecordAttemptDiagnosticInput {
  readonly kind: string
  readonly severity: "info" | "warning" | "error"
  readonly message?: string
  readonly data?: unknown
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Attempt settlement input. */
export interface SettleAttemptInput {
  readonly verdict: AttemptVerdict
  readonly upstreamResponse?: OperationTrackInput
  readonly reason?: string
  readonly error?: unknown
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Egress recording input. */
export interface RecordEgressInput {
  readonly upstream?: OperationTrackInput
  readonly client?: OperationTrackInput
  readonly metadata?: unknown
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Terminal commit input. */
export interface CommitTerminalInput {
  readonly outcome: TerminalOutcome
  readonly committedAttempt?: AttemptHandle
  readonly error?: unknown
  readonly usage?: OperationUsage
  readonly attribution?: ModelOperationTerminal["attribution"]
  readonly metadata?: unknown
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Typed, append-only recorder for a ModelOperationRecord. */
export interface ModelOperationRecorder {
  readonly sealed: boolean
  setIdentityContext(input: { readonly sessionId?: string; readonly agentId?: string }): void
  registerPayload(value: unknown, input: SourceNodeInput): PayloadNodeHandle
  derivePayload(value: unknown, input: DerivedPayloadInput): PayloadNodeHandle
  registerFrame(value: unknown, input: SourceNodeInput): FrameNodeHandle
  deriveFrame(value: unknown, input: DerivedFrameInput): FrameNodeHandle
  recordIngress(input: RecordIngressInput): void
  recordRouting(input: RecordRoutingInput): void
  recordTransform(input: RecordTransformInput): void
  beginAttempt(input: BeginAttemptInput): AttemptHandle
  setAttemptEffectiveRequest(attempt: AttemptHandle, request: OperationTrackInput): void
  setAttemptTransport(attempt: AttemptHandle, transport: OperationTransport): void
  setAttemptUpstreamRequest(attempt: AttemptHandle, request: OperationTrackInput): void
  recordAttemptDiagnostic(attempt: AttemptHandle, input: RecordAttemptDiagnosticInput): void
  settleAttempt(attempt: AttemptHandle, input: SettleAttemptInput): void
  recordEgress(input: RecordEgressInput): void
  setExtension(namespace: string, value: unknown): void
  commitTerminal(input: CommitTerminalInput): ModelOperationRecord
  snapshot(): ModelOperationRecord
}

interface MutableAttempt {
  handle: AttemptHandle
  sequence: number
  strategy?: string
  transport?: OperationTransport
  effectiveRequest?: OperationTrack
  upstreamRequest?: OperationTrack
  upstreamResponse?: OperationTrack
  diagnostics: Array<AttemptDiagnostic>
  verdict?: AttemptVerdict
  settledSequence?: number
  reason?: string
  error?: unknown
  metadata?: unknown
  extensions?: OperationExtensions
  settlementExtensions?: OperationExtensions
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`[model-operation-record] ${field} must not be empty`)
}

function freezeCapturedValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  // Typed arrays cannot be frozen when they contain elements. Their bytes are
  // raw-capture concerns; semantic callers must stop mutating after registration.
  if (!ArrayBuffer.isView(object)) {
    for (const nested of Object.values(object)) freezeCapturedValue(nested, seen)
    Object.freeze(object)
  }
  return value
}

function freezeExtensions(input: Readonly<Record<string, unknown>> | undefined): OperationExtensions | undefined {
  if (input === undefined) return undefined
  const copy = { ...input }
  for (const value of Object.values(copy)) freezeCapturedValue(value)
  return Object.freeze(copy)
}

function freezeHeaders(input: ReadonlyArray<OperationHeaderField> | undefined): ReadonlyArray<OperationHeaderField> | undefined {
  return input === undefined ? undefined : Object.freeze(input.map(([name, value]) => Object.freeze([name, value] as const)))
}

function freezeOrigin(origin: ArenaNodeOrigin): Readonly<ArenaNodeOrigin> {
  requireNonEmpty(origin.stage, "origin.stage")
  return Object.freeze({ ...origin })
}

/** Creates a new isolated canonical recorder. It does not attach to legacy History persistence. */
export function createModelOperationRecorder(input: CreateModelOperationRecorderInput): ModelOperationRecorder {
  requireNonEmpty(input.identity.operationId, "identity.operationId")

  let sequence = 0
  let sealed = false
  let finalRecord: ModelOperationRecord | null = null
  let ingress: ModelOperationIngress | null = null
  let routing: ModelOperationRouting | null = null
  let egress: ModelOperationEgress | null = null
  let terminal: ModelOperationTerminal | null = null
  let committedAttempt: AttemptHandle | undefined

  const payloads: Array<PayloadArenaNode> = []
  const frames: Array<FrameArenaNode> = []
  const payloadHandles = new Set<PayloadNodeHandle>()
  const frameHandles = new Set<FrameNodeHandle>()
  const transforms: Array<ModelOperationTransform> = []
  const attempts: Array<MutableAttempt> = []
  const attemptByHandle = new Map<AttemptHandle, MutableAttempt>()
  const extensions: Record<string, unknown> = { ...input.extensions }

  let identitySessionId = input.identity.sessionId
  let identityAgentId = input.identity.agentId

  function snapshotIdentity(): ModelOperationIdentity {
    return Object.freeze({
      operationId: input.identity.operationId,
      kind: input.identity.kind,
      createdAt: input.identity.createdAt,
      ...(input.identity.parentOperationId === undefined ? {} : { parentOperationId: input.identity.parentOperationId }),
      ...(identitySessionId === undefined ? {} : { sessionId: identitySessionId }),
      ...(identityAgentId === undefined ? {} : { agentId: identityAgentId }),
      ...(input.identity.clientRequestId === undefined ? {} : { clientRequestId: input.identity.clientRequestId }),
      ...(input.identity.connectionId === undefined ? {} : { connectionId: input.identity.connectionId }),
      ...(input.identity.responseCreateId === undefined ? {} : { responseCreateId: input.identity.responseCreateId }),
      ...(input.identity.previousResponseId === undefined ? {} : { previousResponseId: input.identity.previousResponseId }),
      ...(input.identity.process === undefined ? {} : { process: Object.freeze({ ...input.identity.process }) }),
      ...(input.identity.extensions === undefined ? {} : { extensions: freezeExtensions(input.identity.extensions) }),
    })
  }

  function assertWritable(): void {
    if (sealed) throw new Error("[model-operation-record] terminal already committed; recorder is sealed")
  }

  function nextSequence(): number {
    sequence += 1
    return sequence
  }

  function assertPayloadHandle(handle: PayloadNodeHandle): void {
    if (!payloadHandles.has(handle)) throw new Error(`[model-operation-record] unknown payload node handle: ${handle}`)
  }

  function assertFrameHandle(handle: FrameNodeHandle): void {
    if (!frameHandles.has(handle)) throw new Error(`[model-operation-record] unknown frame node handle: ${handle}`)
  }

  function freezeTrack(track: OperationTrackInput | undefined): OperationTrack {
    const source = track ?? {}
    if (source.payload !== undefined) assertPayloadHandle(source.payload)
    for (const frame of source.frames ?? []) assertFrameHandle(frame)
    return Object.freeze({
      ...(source.payload === undefined ? {} : { payload: source.payload }),
      frames: Object.freeze([...(source.frames ?? [])]),
      ...(source.status === undefined ? {} : { status: source.status }),
      ...(source.headers === undefined ? {} : { headers: freezeHeaders(source.headers) }),
      ...(source.trailers === undefined ? {} : { trailers: freezeHeaders(source.trailers) }),
      ...(source.rawCapture === undefined ? {} : { rawCapture: Object.freeze({ ...source.rawCapture }) }),
      ...(source.metadata === undefined ? {} : { metadata: freezeCapturedValue(source.metadata) }),
      ...(source.extensions === undefined ? {} : { extensions: freezeExtensions(source.extensions) }),
    })
  }

  function freezeReference(reference: ArenaNodeReference): ArenaNodeReference {
    if (reference.kind === "payload") assertPayloadHandle(reference.handle)
    else assertFrameHandle(reference.handle)
    return Object.freeze({ ...reference })
  }

  function getAttempt(handle: AttemptHandle): MutableAttempt {
    const attempt = attemptByHandle.get(handle)
    if (!attempt) throw new Error(`[model-operation-record] unknown attempt handle: ${handle}`)
    return attempt
  }

  function snapshotAttempt(attempt: MutableAttempt): ModelOperationAttempt {
    return Object.freeze({
      handle: attempt.handle,
      sequence: attempt.sequence,
      ...(attempt.strategy === undefined ? {} : { strategy: attempt.strategy }),
      ...(attempt.transport === undefined ? {} : { transport: attempt.transport }),
      ...(attempt.effectiveRequest === undefined ? {} : { effectiveRequest: attempt.effectiveRequest }),
      ...(attempt.upstreamRequest === undefined ? {} : { upstreamRequest: attempt.upstreamRequest }),
      ...(attempt.upstreamResponse === undefined ? {} : { upstreamResponse: attempt.upstreamResponse }),
      diagnostics: Object.freeze([...attempt.diagnostics]),
      ...(attempt.verdict === undefined ? {} : { verdict: attempt.verdict }),
      ...(attempt.settledSequence === undefined ? {} : { settledSequence: attempt.settledSequence }),
      ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
      ...(attempt.error === undefined ? {} : { error: attempt.error }),
      ...(attempt.metadata === undefined ? {} : { metadata: attempt.metadata }),
      ...(attempt.extensions === undefined ? {} : { extensions: attempt.extensions }),
      ...(attempt.settlementExtensions === undefined ? {} : { settlementExtensions: attempt.settlementExtensions }),
    })
  }

  function buildSnapshot(): ModelOperationRecord {
    if (finalRecord) return finalRecord
    return Object.freeze({
      identity: snapshotIdentity(),
      arena: Object.freeze({ payloads: Object.freeze([...payloads]), frames: Object.freeze([...frames]) }),
      ingress,
      routing,
      transforms: Object.freeze([...transforms]),
      attempts: Object.freeze(attempts.map((attempt) => snapshotAttempt(attempt))),
      egress,
      terminal,
      extensions: Object.freeze({ ...extensions }),
      lastSequence: sequence,
    })
  }

  const recorder: ModelOperationRecorder = {
    get sealed(): boolean {
      return sealed
    },

    setIdentityContext(context): void {
      assertWritable()
      if (context.sessionId !== undefined) {
        if (identitySessionId !== undefined && identitySessionId !== context.sessionId) {
          throw new Error("[model-operation-record] identity.sessionId cannot be replaced")
        }
        identitySessionId = context.sessionId
      }
      if (context.agentId !== undefined) {
        if (identityAgentId !== undefined && identityAgentId !== context.agentId) {
          throw new Error("[model-operation-record] identity.agentId cannot be replaced")
        }
        identityAgentId = context.agentId
      }
    },

    registerPayload(value, nodeInput): PayloadNodeHandle {
      assertWritable()
      const handle = `payload:${payloads.length}` as PayloadNodeHandle
      const node: SourceArenaNode<PayloadNodeHandle> = Object.freeze({
        handle,
        sequence: nextSequence(),
        value: freezeCapturedValue(value),
        origin: freezeOrigin(nodeInput.origin),
        provenance: "source",
        ...(nodeInput.mediaType === undefined ? {} : { mediaType: nodeInput.mediaType }),
        ...(nodeInput.extensions === undefined ? {} : { extensions: freezeExtensions(nodeInput.extensions) }),
      })
      payloads.push(node)
      payloadHandles.add(handle)
      return handle
    },

    derivePayload(value, nodeInput): PayloadNodeHandle {
      assertWritable()
      assertPayloadHandle(nodeInput.derivedFrom)
      requireNonEmpty(nodeInput.transformId, "transformId")
      const handle = `payload:${payloads.length}` as PayloadNodeHandle
      const node: DerivedArenaNode<PayloadNodeHandle> = Object.freeze({
        handle,
        sequence: nextSequence(),
        value: freezeCapturedValue(value),
        origin: freezeOrigin(nodeInput.origin),
        provenance: "derived",
        derivedFrom: nodeInput.derivedFrom,
        transformId: nodeInput.transformId,
        ...(nodeInput.mediaType === undefined ? {} : { mediaType: nodeInput.mediaType }),
        ...(nodeInput.extensions === undefined ? {} : { extensions: freezeExtensions(nodeInput.extensions) }),
      })
      payloads.push(node)
      payloadHandles.add(handle)
      return handle
    },

    registerFrame(value, nodeInput): FrameNodeHandle {
      assertWritable()
      const handle = `frame:${frames.length}` as FrameNodeHandle
      const node: SourceArenaNode<FrameNodeHandle> = Object.freeze({
        handle,
        sequence: nextSequence(),
        value: freezeCapturedValue(value),
        origin: freezeOrigin(nodeInput.origin),
        provenance: "source",
        ...(nodeInput.mediaType === undefined ? {} : { mediaType: nodeInput.mediaType }),
        ...(nodeInput.extensions === undefined ? {} : { extensions: freezeExtensions(nodeInput.extensions) }),
      })
      frames.push(node)
      frameHandles.add(handle)
      return handle
    },

    deriveFrame(value, nodeInput): FrameNodeHandle {
      assertWritable()
      assertFrameHandle(nodeInput.derivedFrom)
      requireNonEmpty(nodeInput.transformId, "transformId")
      const handle = `frame:${frames.length}` as FrameNodeHandle
      const node: DerivedArenaNode<FrameNodeHandle> = Object.freeze({
        handle,
        sequence: nextSequence(),
        value: freezeCapturedValue(value),
        origin: freezeOrigin(nodeInput.origin),
        provenance: "derived",
        derivedFrom: nodeInput.derivedFrom,
        transformId: nodeInput.transformId,
        ...(nodeInput.mediaType === undefined ? {} : { mediaType: nodeInput.mediaType }),
        ...(nodeInput.extensions === undefined ? {} : { extensions: freezeExtensions(nodeInput.extensions) }),
      })
      frames.push(node)
      frameHandles.add(handle)
      return handle
    },

    recordIngress(recordInput): void {
      assertWritable()
      if (ingress) throw new Error("[model-operation-record] ingress already recorded")
      ingress = Object.freeze({
        sequence: nextSequence(),
        request: freezeTrack(recordInput.request),
        ...(recordInput.format === undefined ? {} : { format: recordInput.format }),
        ...(recordInput.method === undefined ? {} : { method: recordInput.method }),
        ...(recordInput.path === undefined ? {} : { path: recordInput.path }),
        ...(recordInput.metadata === undefined ? {} : { metadata: freezeCapturedValue(recordInput.metadata) }),
        ...(recordInput.extensions === undefined ? {} : { extensions: freezeExtensions(recordInput.extensions) }),
      })
    },

    recordRouting(recordInput): void {
      assertWritable()
      if (routing) throw new Error("[model-operation-record] routing already recorded")
      routing = Object.freeze({
        sequence: nextSequence(),
        ...(recordInput.requestedModel === undefined ? {} : { requestedModel: recordInput.requestedModel }),
        ...(recordInput.resolvedModel === undefined ? {} : { resolvedModel: recordInput.resolvedModel }),
        ...(recordInput.clientFormat === undefined ? {} : { clientFormat: recordInput.clientFormat }),
        ...(recordInput.upstreamProtocol === undefined ? {} : { upstreamProtocol: recordInput.upstreamProtocol }),
        ...(recordInput.upstreamEndpoint === undefined ? {} : { upstreamEndpoint: recordInput.upstreamEndpoint }),
        ...(recordInput.transport === undefined ? {} : { transport: recordInput.transport }),
        ...(recordInput.metadata === undefined ? {} : { metadata: freezeCapturedValue(recordInput.metadata) }),
        ...(recordInput.extensions === undefined ? {} : { extensions: freezeExtensions(recordInput.extensions) }),
      })
    },

    recordTransform(recordInput): void {
      assertWritable()
      requireNonEmpty(recordInput.transformId, "transformId")
      requireNonEmpty(recordInput.stage, "transform.stage")
      transforms.push(
        Object.freeze({
          sequence: nextSequence(),
          transformId: recordInput.transformId,
          stage: recordInput.stage,
          inputs: Object.freeze(recordInput.inputs.map((reference) => freezeReference(reference))),
          outputs: Object.freeze(recordInput.outputs.map((reference) => freezeReference(reference))),
          ...(recordInput.metadata === undefined ? {} : { metadata: freezeCapturedValue(recordInput.metadata) }),
          ...(recordInput.extensions === undefined ? {} : { extensions: freezeExtensions(recordInput.extensions) }),
        }),
      )
    },

    beginAttempt(attemptInput): AttemptHandle {
      assertWritable()
      const handle = `attempt:${attempts.length}` as AttemptHandle
      const attempt: MutableAttempt = {
        handle,
        sequence: nextSequence(),
        diagnostics: [],
        ...(attemptInput.strategy === undefined ? {} : { strategy: attemptInput.strategy }),
        ...(attemptInput.transport === undefined ? {} : { transport: attemptInput.transport }),
        ...(attemptInput.effectiveRequest === undefined ? {} : { effectiveRequest: freezeTrack(attemptInput.effectiveRequest) }),
        ...(attemptInput.upstreamRequest === undefined ? {} : { upstreamRequest: freezeTrack(attemptInput.upstreamRequest) }),
        ...(attemptInput.metadata === undefined ? {} : { metadata: freezeCapturedValue(attemptInput.metadata) }),
        ...(attemptInput.extensions === undefined ? {} : { extensions: freezeExtensions(attemptInput.extensions) }),
      }
      attempts.push(attempt)
      attemptByHandle.set(handle, attempt)
      return handle
    },

    setAttemptEffectiveRequest(handle, request): void {
      assertWritable()
      const attempt = getAttempt(handle)
      if (attempt.verdict !== undefined) throw new Error(`[model-operation-record] attempt already settled: ${handle}`)
      if (attempt.effectiveRequest !== undefined) throw new Error(`[model-operation-record] attempt effective request already recorded: ${handle}`)
      attempt.effectiveRequest = freezeTrack(request)
    },

    setAttemptTransport(handle, transport): void {
      assertWritable()
      const attempt = getAttempt(handle)
      if (attempt.verdict !== undefined) throw new Error(`[model-operation-record] attempt already settled: ${handle}`)
      attempt.transport = transport
    },

    setAttemptUpstreamRequest(handle, request): void {
      assertWritable()
      const attempt = getAttempt(handle)
      if (attempt.verdict !== undefined) throw new Error(`[model-operation-record] attempt already settled: ${handle}`)
      if (attempt.upstreamRequest !== undefined) throw new Error(`[model-operation-record] attempt upstream request already recorded: ${handle}`)
      attempt.upstreamRequest = freezeTrack(request)
    },

    recordAttemptDiagnostic(handle, diagnosticInput): void {
      assertWritable()
      const attempt = getAttempt(handle)
      if (attempt.verdict !== undefined) throw new Error(`[model-operation-record] attempt already settled: ${handle}`)
      requireNonEmpty(diagnosticInput.kind, "diagnostic.kind")
      attempt.diagnostics.push(
        Object.freeze({
          sequence: nextSequence(),
          kind: diagnosticInput.kind,
          severity: diagnosticInput.severity,
          ...(diagnosticInput.message === undefined ? {} : { message: diagnosticInput.message }),
          ...(diagnosticInput.data === undefined ? {} : { data: freezeCapturedValue(diagnosticInput.data) }),
          ...(diagnosticInput.extensions === undefined ? {} : { extensions: freezeExtensions(diagnosticInput.extensions) }),
        }),
      )
    },

    settleAttempt(handle, settlement): void {
      assertWritable()
      const attempt = getAttempt(handle)
      if (attempt.verdict !== undefined) throw new Error(`[model-operation-record] attempt already settled: ${handle}`)
      if (settlement.verdict === "committed" && committedAttempt !== undefined) {
        throw new Error(`[model-operation-record] attempt ${handle} cannot be committed: attempt ${committedAttempt} is already committed`)
      }
      attempt.verdict = settlement.verdict
      attempt.settledSequence = nextSequence()
      if (settlement.upstreamResponse !== undefined) attempt.upstreamResponse = freezeTrack(settlement.upstreamResponse)
      if (settlement.reason !== undefined) attempt.reason = settlement.reason
      if (settlement.error !== undefined) attempt.error = freezeCapturedValue(settlement.error)
      if (settlement.extensions !== undefined) attempt.settlementExtensions = freezeExtensions(settlement.extensions)
      if (settlement.verdict === "committed") committedAttempt = handle
    },

    recordEgress(recordInput): void {
      assertWritable()
      if (egress) throw new Error("[model-operation-record] egress already recorded")
      egress = Object.freeze({
        sequence: nextSequence(),
        upstream: freezeTrack(recordInput.upstream),
        client: freezeTrack(recordInput.client),
        ...(recordInput.metadata === undefined ? {} : { metadata: freezeCapturedValue(recordInput.metadata) }),
        ...(recordInput.extensions === undefined ? {} : { extensions: freezeExtensions(recordInput.extensions) }),
      })
    },

    setExtension(namespace, value): void {
      assertWritable()
      requireNonEmpty(namespace, "extension namespace")
      extensions[namespace] = freezeCapturedValue(value)
    },

    commitTerminal(terminalInput): ModelOperationRecord {
      assertWritable()
      const openAttempts = attempts.filter((attempt) => attempt.verdict === undefined)
      if (openAttempts.length > 0) throw new Error(`[model-operation-record] cannot commit terminal with ${openAttempts.length} open attempt(s)`)
      if (terminalInput.committedAttempt !== undefined) {
        const selected = getAttempt(terminalInput.committedAttempt)
        if (selected.verdict !== "committed") {
          throw new Error(`[model-operation-record] terminal committedAttempt must reference a committed attempt: ${terminalInput.committedAttempt}`)
        }
      }
      const terminalCommittedAttempt = terminalInput.committedAttempt ?? committedAttempt
      terminal = Object.freeze({
        sequence: nextSequence(),
        outcome: terminalInput.outcome,
        ...(terminalCommittedAttempt === undefined ? {} : { committedAttempt: terminalCommittedAttempt }),
        ...(terminalInput.error === undefined ? {} : { error: freezeCapturedValue(terminalInput.error) }),
        ...(terminalInput.usage === undefined ? {} : { usage: freezeCapturedValue(terminalInput.usage) }),
        ...(terminalInput.attribution === undefined ? {} : { attribution: Object.freeze({ ...terminalInput.attribution }) }),
        ...(terminalInput.metadata === undefined ? {} : { metadata: freezeCapturedValue(terminalInput.metadata) }),
        ...(terminalInput.extensions === undefined ? {} : { extensions: freezeExtensions(terminalInput.extensions) }),
      })
      sealed = true
      finalRecord = buildSnapshot()
      return finalRecord
    },

    snapshot(): ModelOperationRecord {
      return buildSnapshot()
    },
  }

  return recorder
}
