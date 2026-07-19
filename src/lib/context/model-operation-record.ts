/** @deprecated P4-P8 transition only. Canonical code must use DispatchHandle. */
export type AttemptHandle = DispatchHandle
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

/** Known provenance labels for proxy- or hook-synthesized frames. */
export type OperationSyntheticKind =
  | "keepalive"
  | "anchor"
  | "synthetic-message-start"
  | "hook-mock"
  | "hook-rewrite"
  | "hook-replay"
  | "refusal-recovery"
  | "error-shaping-canonical"
  | "error-shaping-auq"
  | "synthetic"
  | "buffered-terminal-repair"

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
  readonly candidate?: CandidateHandle
  readonly dispatch?: DispatchHandle
  /** @deprecated Input compatibility only; freezeOrigin canonicalizes this to dispatch. */
  readonly attempt?: DispatchHandle
  readonly detail?: string
}

declare const payloadNodeHandleBrand: unique symbol

/** Opaque handle for a payload node in this record's arena. */
export type PayloadNodeHandle = string & { readonly [payloadNodeHandleBrand]: "PayloadNodeHandle" }

declare const frameNodeHandleBrand: unique symbol

/** Opaque handle for a frame node in this record's arena. */
export type FrameNodeHandle = string & { readonly [frameNodeHandleBrand]: "FrameNodeHandle" }

declare const dispatchHandleBrand: unique symbol

/** Opaque handle for one physical upstream dispatch in this record. */
export type DispatchHandle = string & { readonly [dispatchHandleBrand]: "DispatchHandle" }

declare const candidateHandleBrand: unique symbol

/** Opaque handle for one candidate generation branch. */
export type CandidateHandle = string & { readonly [candidateHandleBrand]: "CandidateHandle" }

/** Reference to either kind of arena node. */
export type ArenaNodeReference = Readonly<{ kind: "payload"; handle: PayloadNodeHandle }> | Readonly<{ kind: "frame"; handle: FrameNodeHandle }>

/** Common immutable fields for source and derived arena nodes. */
export interface ArenaNodeBase<Handle extends PayloadNodeHandle | FrameNodeHandle> {
  readonly handle: Handle
  readonly sequence: number
  /** Wall-clock epoch when this semantic node was captured. Independent from sequence ordering. */
  readonly occurredAt?: number
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
  readonly occurredAt?: number
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
  readonly frameObservations?: ReadonlyArray<OperationFrameObservation>
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
  /** Per-track timing/provenance for frame occurrences. Kept outside CAS semantic values. */
  readonly frameObservations?: ReadonlyArray<OperationFrameObservation>
  readonly status?: number
  readonly headers?: ReadonlyArray<OperationHeaderField>
  readonly trailers?: ReadonlyArray<OperationHeaderField>
  readonly rawCapture?: Readonly<{ capability: CaptureCapability; ref?: string; byteLength?: number; gap?: string }>
  readonly metadata?: unknown
  readonly extensions?: OperationExtensions
}

/** One occurrence of a semantic frame on a specific track. */
export interface OperationFrameObservation {
  readonly handle: FrameNodeHandle
  readonly offsetMs?: number
  readonly observedAt?: number
  readonly type?: string
  readonly raw?: string
  readonly synthetic?: OperationSyntheticKind
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
  readonly previousResponseId?: string | null
  readonly process?: Readonly<{ pid: number; bootTime?: number; version?: string; gitSha?: string; gitDirty?: boolean; synthetic?: boolean }>
  readonly extensions?: OperationExtensions
}

/** Client-to-proxy ingress capture. */
export interface ModelOperationIngress {
  readonly sequence: number
  readonly occurredAt?: number
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
  readonly occurredAt?: number
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
  readonly occurredAt?: number
  readonly transformId: string
  readonly stage: string
  readonly inputs: ReadonlyArray<ArenaNodeReference>
  readonly outputs: ReadonlyArray<ArenaNodeReference>
  readonly metadata?: unknown
  readonly extensions?: OperationExtensions
}

/** Physical dispatch settlement verdict, independent from candidate and operation outcomes. */
export type DispatchVerdict = "committed" | "discarded" | "failed" | "cancelled"

/** Candidate topology role and terminal verdict. */
export type CandidateRole = "primary" | "hedge" | "recovery"
export type CandidateVerdict = "winner" | "loser" | "failed" | "cancelled"

/** Diagnostic retained on the attempt that produced it. */
export interface AttemptDiagnostic {
  readonly sequence: number
  readonly occurredAt?: number
  readonly kind: string
  readonly severity: "info" | "warning" | "error"
  readonly message?: string
  readonly data?: unknown
  readonly extensions?: OperationExtensions
}

/** One physical upstream dispatch, including failed/discarded diagnostic history. */
export interface ModelOperationDispatch {
  readonly handle: DispatchHandle
  readonly candidate: CandidateHandle
  readonly sequence: number
  readonly occurredAt?: number
  readonly strategy?: string
  readonly transport?: OperationTransport
  readonly effectiveRequest?: OperationTrack
  readonly upstreamRequest?: OperationTrack
  readonly upstreamResponse?: OperationTrack
  readonly diagnostics: ReadonlyArray<AttemptDiagnostic>
  readonly verdict?: DispatchVerdict
  readonly settledSequence?: number
  readonly settledAt?: number
  readonly reason?: string
  readonly error?: unknown
  readonly metadata?: unknown
  readonly extensions?: OperationExtensions
  readonly settlementExtensions?: OperationExtensions
}

/** One generation candidate containing an ordered set of physical dispatches. */
export interface ModelOperationCandidate {
  readonly handle: CandidateHandle
  readonly sequence: number
  readonly occurredAt?: number
  readonly role: CandidateRole
  readonly parentCandidate?: CandidateHandle
  readonly dispatches: ReadonlyArray<DispatchHandle>
  readonly verdict?: CandidateVerdict
  readonly settledSequence?: number
  readonly settledAt?: number
  readonly reason?: string
  readonly metadata?: unknown
  readonly extensions?: OperationExtensions
}

/** Independent upstream and client egress tracks. */
export interface ModelOperationEgress {
  readonly sequence: number
  readonly occurredAt?: number
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
  /** Canonical operation terminal wall-clock epoch. */
  readonly occurredAt?: number
  readonly outcome: TerminalOutcome
  readonly winnerCandidate?: CandidateHandle
  readonly committedDispatch?: DispatchHandle
  /** @deprecated Projection compatibility through P8; aliases committedDispatch. */
  readonly committedAttempt?: DispatchHandle
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
  readonly candidates: ReadonlyArray<ModelOperationCandidate>
  readonly dispatches: ReadonlyArray<ModelOperationDispatch>
  /** @deprecated Projection compatibility through P8; aliases dispatches. */
  readonly attempts: ReadonlyArray<ModelOperationDispatch>
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
    readonly previousResponseId?: string | null
    readonly process?: Readonly<{ pid: number; bootTime?: number; version?: string; gitSha?: string; gitDirty?: boolean; synthetic?: boolean }>
    readonly extensions?: Readonly<Record<string, unknown>>
  }
  readonly extensions?: Readonly<Record<string, unknown>>
  /** Deterministic clock seam. Production callers omit it and use Date.now. */
  readonly now?: () => number
  /** Recovery seam for legacy records whose event wall clocks were never captured. */
  readonly captureTimestamps?: boolean
}

/** Ingress recording input. */
export interface RecordIngressInput {
  readonly request: OperationTrackInput
  readonly occurredAt?: number
  readonly format?: string
  readonly method?: string
  readonly path?: string
  readonly metadata?: unknown
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Routing recording input. */
export interface RecordRoutingInput {
  readonly occurredAt?: number
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
  readonly occurredAt?: number
  readonly metadata?: unknown
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Candidate start input. */
export interface BeginCandidateInput {
  readonly role: CandidateRole
  readonly occurredAt?: number
  readonly parentCandidate?: CandidateHandle
  readonly metadata?: unknown
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Physical dispatch start input. */
export interface BeginDispatchInput {
  readonly candidate: CandidateHandle
  readonly occurredAt?: number
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
  readonly occurredAt?: number
  readonly message?: string
  readonly data?: unknown
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Physical dispatch settlement input. */
export interface SettleDispatchInput {
  readonly verdict: DispatchVerdict
  readonly occurredAt?: number
  readonly upstreamResponse?: OperationTrackInput
  readonly reason?: string
  readonly error?: unknown
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Candidate settlement input. */
export interface SettleCandidateInput {
  readonly verdict: CandidateVerdict
  readonly occurredAt?: number
  readonly reason?: string
}

/** Egress recording input. */
export interface RecordEgressInput {
  readonly occurredAt?: number
  readonly upstream?: OperationTrackInput
  readonly client?: OperationTrackInput
  readonly metadata?: unknown
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Terminal commit input. */
export interface CommitTerminalInput {
  readonly outcome: TerminalOutcome
  readonly occurredAt?: number
  readonly winnerCandidate?: CandidateHandle
  readonly committedDispatch?: DispatchHandle
  /** @deprecated P4-P8 transition only. */
  readonly committedAttempt?: DispatchHandle
  readonly error?: unknown
  readonly usage?: OperationUsage
  readonly attribution?: ModelOperationTerminal["attribution"]
  readonly metadata?: unknown
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Typed, append-only recorder for a ModelOperationRecord. */
export interface ModelOperationRecorder {
  readonly sealed: boolean
  now(): number
  setIdentityContext(input: { readonly sessionId?: string; readonly agentId?: string }): void
  registerPayload(value: unknown, input: SourceNodeInput): PayloadNodeHandle
  derivePayload(value: unknown, input: DerivedPayloadInput): PayloadNodeHandle
  registerFrame(value: unknown, input: SourceNodeInput): FrameNodeHandle
  deriveFrame(value: unknown, input: DerivedFrameInput): FrameNodeHandle
  recordIngress(input: RecordIngressInput): void
  recordRouting(input: RecordRoutingInput): void
  recordTransform(input: RecordTransformInput): void
  beginCandidate(input: BeginCandidateInput): CandidateHandle
  settleCandidate(candidate: CandidateHandle, input: SettleCandidateInput): void
  beginDispatch(input: BeginDispatchInput): DispatchHandle
  setDispatchEffectiveRequest(dispatch: DispatchHandle, request: OperationTrackInput): void
  setDispatchTransport(dispatch: DispatchHandle, transport: OperationTransport): void
  setDispatchUpstreamRequest(dispatch: DispatchHandle, request: OperationTrackInput): void
  recordDispatchDiagnostic(dispatch: DispatchHandle, input: RecordAttemptDiagnosticInput): void
  settleDispatch(dispatch: DispatchHandle, input: SettleDispatchInput): void
  /** @deprecated P4-P8 transition adapters. */
  beginAttempt(input: Omit<BeginDispatchInput, "candidate">): DispatchHandle
  setAttemptEffectiveRequest(dispatch: DispatchHandle, request: OperationTrackInput): void
  setAttemptTransport(dispatch: DispatchHandle, transport: OperationTransport): void
  setAttemptUpstreamRequest(dispatch: DispatchHandle, request: OperationTrackInput): void
  recordAttemptDiagnostic(dispatch: DispatchHandle, input: RecordAttemptDiagnosticInput): void
  settleAttempt(dispatch: DispatchHandle, input: SettleDispatchInput): void
  recordEgress(input: RecordEgressInput): void
  setExtension(namespace: string, value: unknown): void
  commitTerminal(input: CommitTerminalInput): ModelOperationRecord
  snapshot(): ModelOperationRecord
}

interface MutableDispatch {
  handle: DispatchHandle
  candidate: CandidateHandle
  sequence: number
  occurredAt?: number
  strategy?: string
  transport?: OperationTransport
  effectiveRequest?: OperationTrack
  upstreamRequest?: OperationTrack
  upstreamResponse?: OperationTrack
  diagnostics: Array<AttemptDiagnostic>
  verdict?: DispatchVerdict
  settledSequence?: number
  settledAt?: number
  reason?: string
  error?: unknown
  metadata?: unknown
  extensions?: OperationExtensions
  settlementExtensions?: OperationExtensions
}

interface MutableCandidate {
  handle: CandidateHandle
  sequence: number
  occurredAt?: number
  role: CandidateRole
  parentCandidate?: CandidateHandle
  dispatches: Array<DispatchHandle>
  verdict?: CandidateVerdict
  settledSequence?: number
  settledAt?: number
  reason?: string
  metadata?: unknown
  extensions?: OperationExtensions
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
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- P4-P8 input adapter canonicalizes to dispatch below.
  const dispatch = origin.dispatch ?? origin.attempt
  return Object.freeze({
    stage: origin.stage,
    track: origin.track,
    ...(origin.candidate !== undefined && { candidate: origin.candidate }),
    ...(dispatch !== undefined && { dispatch }),
    ...(origin.detail !== undefined && { detail: origin.detail }),
  })
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
  let committedDispatch: DispatchHandle | undefined
  let legacyPrimaryCandidate: CandidateHandle | undefined
  const now = input.now ?? Date.now
  const captureTimestamps = input.captureTimestamps ?? true

  const payloads: Array<PayloadArenaNode> = []
  const frames: Array<FrameArenaNode> = []
  const payloadHandles = new Set<PayloadNodeHandle>()
  const frameHandles = new Set<FrameNodeHandle>()
  const transforms: Array<ModelOperationTransform> = []
  const candidates: Array<MutableCandidate> = []
  const dispatches: Array<MutableDispatch> = []
  const candidateByHandle = new Map<CandidateHandle, MutableCandidate>()
  const dispatchByHandle = new Map<DispatchHandle, MutableDispatch>()
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

  function nextEvent(occurredAt?: number): { sequence: number; occurredAt?: number } {
    let timestamp: number | undefined
    if (occurredAt !== undefined) timestamp = occurredAt
    else if (captureTimestamps) timestamp = now()
    return {
      sequence: nextSequence(),
      ...(timestamp === undefined ? {} : { occurredAt: timestamp }),
    }
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
    const frameObservations = source.frameObservations?.map((observation) => {
      assertFrameHandle(observation.handle)
      return Object.freeze({
        ...observation,
        ...(observation.extensions === undefined ? {} : { extensions: freezeExtensions(observation.extensions) }),
      })
    })
    if (frameObservations !== undefined) {
      const frames = source.frames ?? []
      if (frameObservations.length !== frames.length) throw new Error("[model-operation-record] frameObservations must align one-to-one with frames")
      for (const [index, observation] of frameObservations.entries()) {
        if (observation.handle !== frames[index]) throw new Error(`[model-operation-record] frame observation handle mismatch at index ${index}`)
      }
    }
    return Object.freeze({
      ...(source.payload === undefined ? {} : { payload: source.payload }),
      frames: Object.freeze([...(source.frames ?? [])]),
      ...(frameObservations === undefined ? {} : { frameObservations: Object.freeze(frameObservations) }),
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

  function getCandidate(handle: CandidateHandle): MutableCandidate {
    const candidate = candidateByHandle.get(handle)
    if (!candidate) throw new Error(`[model-operation-record] unknown candidate handle: ${handle}`)
    return candidate
  }

  function getDispatch(handle: DispatchHandle): MutableDispatch {
    const dispatch = dispatchByHandle.get(handle)
    if (!dispatch) throw new Error(`[model-operation-record] unknown dispatch handle: ${handle}`)
    return dispatch
  }

  function snapshotDispatch(attempt: MutableDispatch): ModelOperationDispatch {
    return Object.freeze({
      handle: attempt.handle,
      candidate: attempt.candidate,
      sequence: attempt.sequence,
      ...(attempt.occurredAt === undefined ? {} : { occurredAt: attempt.occurredAt }),
      ...(attempt.strategy === undefined ? {} : { strategy: attempt.strategy }),
      ...(attempt.transport === undefined ? {} : { transport: attempt.transport }),
      ...(attempt.effectiveRequest === undefined ? {} : { effectiveRequest: attempt.effectiveRequest }),
      ...(attempt.upstreamRequest === undefined ? {} : { upstreamRequest: attempt.upstreamRequest }),
      ...(attempt.upstreamResponse === undefined ? {} : { upstreamResponse: attempt.upstreamResponse }),
      diagnostics: Object.freeze([...attempt.diagnostics]),
      ...(attempt.verdict === undefined ? {} : { verdict: attempt.verdict }),
      ...(attempt.settledSequence === undefined ? {} : { settledSequence: attempt.settledSequence }),
      ...(attempt.settledAt === undefined ? {} : { settledAt: attempt.settledAt }),
      ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
      ...(attempt.error === undefined ? {} : { error: attempt.error }),
      ...(attempt.metadata === undefined ? {} : { metadata: attempt.metadata }),
      ...(attempt.extensions === undefined ? {} : { extensions: attempt.extensions }),
      ...(attempt.settlementExtensions === undefined ? {} : { settlementExtensions: attempt.settlementExtensions }),
    })
  }

  function snapshotCandidate(candidate: MutableCandidate): ModelOperationCandidate {
    return Object.freeze({
      handle: candidate.handle,
      sequence: candidate.sequence,
      ...(candidate.occurredAt === undefined ? {} : { occurredAt: candidate.occurredAt }),
      role: candidate.role,
      ...(candidate.parentCandidate === undefined ? {} : { parentCandidate: candidate.parentCandidate }),
      dispatches: Object.freeze([...candidate.dispatches]),
      ...(candidate.verdict === undefined ? {} : { verdict: candidate.verdict }),
      ...(candidate.settledSequence === undefined ? {} : { settledSequence: candidate.settledSequence }),
      ...(candidate.settledAt === undefined ? {} : { settledAt: candidate.settledAt }),
      ...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
      ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
      ...(candidate.extensions === undefined ? {} : { extensions: candidate.extensions }),
    })
  }

  function buildSnapshot(): ModelOperationRecord {
    if (finalRecord) return finalRecord
    const dispatchSnapshots = Object.freeze(dispatches.map((dispatch) => snapshotDispatch(dispatch)))
    const record = {
      identity: snapshotIdentity(),
      arena: Object.freeze({ payloads: Object.freeze([...payloads]), frames: Object.freeze([...frames]) }),
      ingress,
      routing,
      transforms: Object.freeze([...transforms]),
      candidates: Object.freeze(candidates.map((candidate) => snapshotCandidate(candidate))),
      dispatches: dispatchSnapshots,
      egress,
      terminal,
      extensions: Object.freeze({ ...extensions }),
      lastSequence: sequence,
    } as Omit<ModelOperationRecord, "attempts"> & Partial<Pick<ModelOperationRecord, "attempts">>
    Object.defineProperty(record, "attempts", { enumerable: false, configurable: false, get: () => dispatchSnapshots })
    return Object.freeze(record) as ModelOperationRecord
  }

  const recorder: ModelOperationRecorder = {
    get sealed(): boolean {
      return sealed
    },

    now(): number {
      return now()
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
        ...nextEvent(nodeInput.occurredAt),
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
        ...nextEvent(nodeInput.occurredAt),
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
        ...nextEvent(nodeInput.occurredAt),
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
        ...nextEvent(nodeInput.occurredAt),
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
        ...nextEvent(recordInput.occurredAt),
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
        ...nextEvent(recordInput.occurredAt),
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
          ...nextEvent(recordInput.occurredAt),
          transformId: recordInput.transformId,
          stage: recordInput.stage,
          inputs: Object.freeze(recordInput.inputs.map((reference) => freezeReference(reference))),
          outputs: Object.freeze(recordInput.outputs.map((reference) => freezeReference(reference))),
          ...(recordInput.metadata === undefined ? {} : { metadata: freezeCapturedValue(recordInput.metadata) }),
          ...(recordInput.extensions === undefined ? {} : { extensions: freezeExtensions(recordInput.extensions) }),
        }),
      )
    },

    beginCandidate(candidateInput): CandidateHandle {
      assertWritable()
      if (candidateInput.parentCandidate !== undefined) getCandidate(candidateInput.parentCandidate)
      const handle = `candidate:${candidates.length}` as CandidateHandle
      const candidate: MutableCandidate = {
        handle,
        ...nextEvent(candidateInput.occurredAt),
        role: candidateInput.role,
        dispatches: [],
        ...(candidateInput.parentCandidate === undefined ? {} : { parentCandidate: candidateInput.parentCandidate }),
        ...(candidateInput.metadata === undefined ? {} : { metadata: freezeCapturedValue(candidateInput.metadata) }),
        ...(candidateInput.extensions === undefined ? {} : { extensions: freezeExtensions(candidateInput.extensions) }),
      }
      candidates.push(candidate)
      candidateByHandle.set(handle, candidate)
      return handle
    },

    beginAttempt(attemptInput): DispatchHandle {
      const occurredAt = attemptInput.occurredAt ?? (captureTimestamps ? now() : undefined)
      legacyPrimaryCandidate ??= recorder.beginCandidate({
        role: "primary",
        ...(occurredAt === undefined ? {} : { occurredAt }),
        metadata: { compatibility: "attempt-adapter" },
      })
      return recorder.beginDispatch({ candidate: legacyPrimaryCandidate, ...attemptInput, ...(occurredAt === undefined ? {} : { occurredAt }) })
    },

    setAttemptEffectiveRequest(handle, request): void {
      recorder.setDispatchEffectiveRequest(handle, request)
    },

    setAttemptTransport(handle, transport): void {
      recorder.setDispatchTransport(handle, transport)
    },

    setAttemptUpstreamRequest(handle, request): void {
      recorder.setDispatchUpstreamRequest(handle, request)
    },

    recordAttemptDiagnostic(handle, diagnostic): void {
      recorder.recordDispatchDiagnostic(handle, diagnostic)
    },

    settleAttempt(handle, settlement): void {
      recorder.settleDispatch(handle, settlement)
    },

    settleCandidate(handle, settlement): void {
      assertWritable()
      const candidate = getCandidate(handle)
      if (candidate.verdict !== undefined) throw new Error(`[model-operation-record] candidate already settled: ${handle}`)
      const openDispatches = candidate.dispatches.filter((dispatch) => getDispatch(dispatch).verdict === undefined)
      if (openDispatches.length > 0) throw new Error(`[model-operation-record] candidate ${handle} has ${openDispatches.length} open dispatch(es)`)
      candidate.verdict = settlement.verdict
      const settled = nextEvent(settlement.occurredAt)
      candidate.settledSequence = settled.sequence
      candidate.settledAt = settled.occurredAt
      if (settlement.reason !== undefined) candidate.reason = settlement.reason
    },

    beginDispatch(dispatchInput): DispatchHandle {
      assertWritable()
      const candidate = getCandidate(dispatchInput.candidate)
      if (candidate.verdict !== undefined) throw new Error(`[model-operation-record] candidate already settled: ${candidate.handle}`)
      const handle = `dispatch:${dispatches.length}` as DispatchHandle
      const dispatch: MutableDispatch = {
        handle,
        candidate: candidate.handle,
        ...nextEvent(dispatchInput.occurredAt),
        diagnostics: [],
        ...(dispatchInput.strategy === undefined ? {} : { strategy: dispatchInput.strategy }),
        ...(dispatchInput.transport === undefined ? {} : { transport: dispatchInput.transport }),
        ...(dispatchInput.effectiveRequest === undefined ? {} : { effectiveRequest: freezeTrack(dispatchInput.effectiveRequest) }),
        ...(dispatchInput.upstreamRequest === undefined ? {} : { upstreamRequest: freezeTrack(dispatchInput.upstreamRequest) }),
        ...(dispatchInput.metadata === undefined ? {} : { metadata: freezeCapturedValue(dispatchInput.metadata) }),
        ...(dispatchInput.extensions === undefined ? {} : { extensions: freezeExtensions(dispatchInput.extensions) }),
      }
      dispatches.push(dispatch)
      dispatchByHandle.set(handle, dispatch)
      candidate.dispatches.push(handle)
      return handle
    },

    setDispatchEffectiveRequest(handle, request): void {
      assertWritable()
      const dispatch = getDispatch(handle)
      if (dispatch.verdict !== undefined) throw new Error(`[model-operation-record] dispatch already settled: ${handle}`)
      if (dispatch.effectiveRequest !== undefined) throw new Error(`[model-operation-record] dispatch effective request already recorded: ${handle}`)
      dispatch.effectiveRequest = freezeTrack(request)
    },

    setDispatchTransport(handle, transport): void {
      assertWritable()
      const dispatch = getDispatch(handle)
      if (dispatch.verdict !== undefined) throw new Error(`[model-operation-record] dispatch already settled: ${handle}`)
      dispatch.transport = transport
    },

    setDispatchUpstreamRequest(handle, request): void {
      assertWritable()
      const dispatch = getDispatch(handle)
      if (dispatch.verdict !== undefined) throw new Error(`[model-operation-record] dispatch already settled: ${handle}`)
      if (dispatch.upstreamRequest !== undefined) throw new Error(`[model-operation-record] dispatch upstream request already recorded: ${handle}`)
      dispatch.upstreamRequest = freezeTrack(request)
    },

    recordDispatchDiagnostic(handle, diagnosticInput): void {
      assertWritable()
      const dispatch = getDispatch(handle)
      if (dispatch.verdict !== undefined) throw new Error(`[model-operation-record] dispatch already settled: ${handle}`)
      requireNonEmpty(diagnosticInput.kind, "diagnostic.kind")
      dispatch.diagnostics.push(
        Object.freeze({
          ...nextEvent(diagnosticInput.occurredAt),
          kind: diagnosticInput.kind,
          severity: diagnosticInput.severity,
          ...(diagnosticInput.message === undefined ? {} : { message: diagnosticInput.message }),
          ...(diagnosticInput.data === undefined ? {} : { data: freezeCapturedValue(diagnosticInput.data) }),
          ...(diagnosticInput.extensions === undefined ? {} : { extensions: freezeExtensions(diagnosticInput.extensions) }),
        }),
      )
    },

    settleDispatch(handle, settlement): void {
      assertWritable()
      const dispatch = getDispatch(handle)
      if (dispatch.verdict !== undefined) throw new Error(`[model-operation-record] dispatch already settled: ${handle}`)
      if (settlement.verdict === "committed" && committedDispatch !== undefined) {
        throw new Error(`[model-operation-record] dispatch ${handle} cannot be committed: dispatch ${committedDispatch} is already committed`)
      }
      dispatch.verdict = settlement.verdict
      const settled = nextEvent(settlement.occurredAt)
      dispatch.settledSequence = settled.sequence
      dispatch.settledAt = settled.occurredAt
      if (settlement.upstreamResponse !== undefined) dispatch.upstreamResponse = freezeTrack(settlement.upstreamResponse)
      if (settlement.reason !== undefined) dispatch.reason = settlement.reason
      if (settlement.error !== undefined) dispatch.error = freezeCapturedValue(settlement.error)
      if (settlement.metadata !== undefined) {
        dispatch.metadata = freezeCapturedValue({ ...(dispatch.metadata as Readonly<Record<string, unknown>> | undefined), ...settlement.metadata })
      }
      if (settlement.extensions !== undefined) dispatch.settlementExtensions = freezeExtensions(settlement.extensions)
      if (settlement.verdict === "committed") committedDispatch = handle
    },

    recordEgress(recordInput): void {
      assertWritable()
      if (egress) throw new Error("[model-operation-record] egress already recorded")
      egress = Object.freeze({
        ...nextEvent(recordInput.occurredAt),
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
      let terminalOccurredAt = terminalInput.occurredAt
      if (legacyPrimaryCandidate !== undefined) {
        const legacy = getCandidate(legacyPrimaryCandidate)
        if (legacy.verdict === undefined) {
          terminalOccurredAt ??= captureTimestamps ? now() : undefined
          const legacyCommitted = legacy.dispatches.some((dispatch) => getDispatch(dispatch).verdict === "committed")
          recorder.settleCandidate(legacy.handle, {
            verdict: legacyCommitted ? "winner" : "failed",
            ...(terminalOccurredAt === undefined ? {} : { occurredAt: terminalOccurredAt }),
            reason: "attempt adapter terminal",
          })
        }
      }
      const openDispatches = dispatches.filter((dispatch) => dispatch.verdict === undefined)
      if (openDispatches.length > 0) throw new Error(`[model-operation-record] cannot commit terminal with ${openDispatches.length} open dispatch(es)`)
      const openCandidates = candidates.filter((candidate) => candidate.verdict === undefined)
      if (openCandidates.length > 0) throw new Error(`[model-operation-record] cannot commit terminal with ${openCandidates.length} open candidate(s)`)
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- P4-P8 terminal adapter; canonical field is committedDispatch.
      const requestedCommittedDispatch = terminalInput.committedDispatch ?? terminalInput.committedAttempt
      if (requestedCommittedDispatch !== undefined) {
        const selected = getDispatch(requestedCommittedDispatch)
        if (selected.verdict !== "committed") {
          throw new Error(`[model-operation-record] terminal committedDispatch must reference a committed dispatch: ${requestedCommittedDispatch}`)
        }
      }
      const terminalCommittedDispatch = requestedCommittedDispatch ?? committedDispatch
      const terminalWinnerCandidate =
        terminalInput.winnerCandidate ?? (terminalCommittedDispatch === undefined ? undefined : getDispatch(terminalCommittedDispatch).candidate)
      terminal = Object.freeze({
        ...nextEvent(terminalOccurredAt),
        outcome: terminalInput.outcome,
        ...(terminalWinnerCandidate === undefined ? {} : { winnerCandidate: terminalWinnerCandidate }),
        ...(terminalCommittedDispatch === undefined ? {} : { committedDispatch: terminalCommittedDispatch, committedAttempt: terminalCommittedDispatch }),
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
