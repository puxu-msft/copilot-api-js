/**
 * Core type contracts for the protocol-neutral semantic ledger — the direct transcription of RFC
 * §4 (`docs/rfc/2026-08-08-anthropic-responses-semantic-bridge.md`) plus the reasoning exchange
 * envelope of §3.3.
 *
 * The RFC is the authority for every shape in this file: when code and RFC disagree, the code is
 * wrong. Do not add or remove fields here to make a caller compile — change the caller, or take the
 * change back to the RFC first.
 *
 * This module is types only. The reducer that enforces the invariants stated alongside the types in
 * RFC §4 lives in `./ledger`.
 */

/* ---------------------------------------------------------------------------------------------- *
 * Identity
 * ---------------------------------------------------------------------------------------------- */

/** Branded so an item key can never be passed where a part key is expected, and vice versa. */
export type ItemKey = string & { readonly __itemKey: unique symbol }
export type PartKey = string & { readonly __partKey: unique symbol }
export type SegmentId = string & { readonly __segmentId: unique symbol }

export const asItemKey = (value: string): ItemKey => value as ItemKey
export const asPartKey = (value: string): PartKey => value as PartKey
export const asSegmentId = (value: string): SegmentId => value as SegmentId

/**
 * Who produced a piece of state. Opaque carrier bytes are only ever replayed when the *whole*
 * identity matches the target (RFC §3.3 invariant 2), so provider and resolved model are part of
 * identity rather than free-floating metadata.
 */
export type ModelIdentity = Readonly<{
  protocol: "anthropic" | "responses"
  provider: string
  model: string
}>

export type SourceRef = Readonly<{
  identity: ModelIdentity
  turn: number
  blockOrOutputIndex: number
  sourceId?: string
  callId?: string
}>

/* ---------------------------------------------------------------------------------------------- *
 * Degradation reasons
 * ---------------------------------------------------------------------------------------------- */

/**
 * Stable degradation codes. RFC §10 requires fail-closed paths to carry a stable code and forbids
 * retry/client logic from parsing English prose, so the code — not a message — is the contract.
 *
 * The RFC names the situations but does not freeze the set, so this object is the single source and
 * it grows as later slices land the domains that need new codes. Add here; never inline a bare
 * string at a call site.
 */
export const DEGRADATION_REASONS = {
  /** Opaque carrier belonged to a different protocol/provider/model than the target. */
  opaqueCarrierProvenanceMismatch: "opaque-carrier-provenance-mismatch",
  /** Carrier decoded to a kind the target does not understand; stripped rather than guessed. */
  opaqueCarrierUnknownKind: "opaque-carrier-unknown-kind",
  /** Source expressed a capability the target protocol has no equivalent for. */
  capabilityNoTargetEquivalent: "capability-no-target-equivalent",
  /** Item order had to be rewritten to satisfy the target protocol's ordering contract. */
  orderingNormalized: "ordering-normalized",
  /** Anthropic thinking signature cannot cross a model family boundary. */
  thinkingSignatureNotPortable: "thinking-signature-not-portable",
  /** Cut at a fallback segment boundary. */
  fallbackBoundaryPartial: "fallback-boundary-partial",
  /** Cut at a continuation segment boundary. */
  continuationBoundaryPartial: "continuation-boundary-partial",
  /** Upstream stream ended without a wire terminal. */
  upstreamEof: "upstream-eof",
  /** Request was aborted before the upstream produced a terminal. */
  upstreamAbort: "upstream-abort",
  /** Upstream emitted a malformed or erroring frame. */
  wireError: "wire-error",
  /** Structured output could not be constrained on the target and ran unconstrained. */
  structuredOutputUnconstrained: "structured-output-unconstrained",
  /** Source context-management directive has no target representation. */
  contextManagementNotRepresentable: "context-management-not-representable",
  /** Server-tool call/result has no target representation. */
  serverToolNotRepresentable: "server-tool-not-representable",
} as const

export type DegradationReason = (typeof DEGRADATION_REASONS)[keyof typeof DEGRADATION_REASONS]

/* ---------------------------------------------------------------------------------------------- *
 * Presentation × continuation dispositions (RFC §4.1)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Responses-side server-tool item types allowed into a continuation carrier. Deliberately a closed
 * set rather than a bare `string`: without it, a `responses-output-item` payload could carry an
 * arbitrary blob — including an Anthropic `web_search_tool_result` in disguise, which RFC §7's red
 * line forbids us to ever synthesise. Add entries as capabilities open; never widen to `string`.
 */
export type ResponsesServerToolItemType = "web_search_call"

/**
 * What we hand back to a compatible upstream so a continued turn can pick up where it left off.
 *
 * The reference and the whole item are two granularities of one capability, not two features. Measured against the real upstream on 2026-08-11 (`exp/responses-server-tool-continuation/`): the whole item and a bare `{type,id}` are both accepted, `item_reference` is **not** (404 for `web_search_call`) — but a *fabricated* short id is accepted too, so acceptance does not discriminate a real reference from a made-up one and cannot be used to narrow the shape. Hence `responses-output-item` stays the default: it is the only form that preserves the part we cannot inspect.
 */
export type ContinuationRecord =
  | Readonly<{ kind: "claude-signature"; opaque: string }>
  | Readonly<{ kind: "responses-encrypted"; opaque: string }>
  | Readonly<{ kind: "responses-item-reference"; ref: Readonly<{ type: ResponsesServerToolItemType; id: string }> }>
  | Readonly<{ kind: "responses-output-item"; item: Readonly<{ type: ResponsesServerToolItemType }> & Readonly<Record<string, unknown>> }>

/** What the target protocol's reader will see. */
export type PresentationDisposition =
  | Readonly<{ kind: "native" }>
  | Readonly<{ kind: "degraded"; reason: DegradationReason; correlationId?: string }>
  | Readonly<{ kind: "dropped"; reason: DegradationReason }>

/**
 * What survives the round trip. Independent of {@link PresentationDisposition} on purpose: the whole
 * defect class this contract exists to stop is an implementer reading "presentation degraded" as
 * permission to discard the opaque state too, which leaves a continued turn unable to resume.
 */
export type ContinuationDisposition =
  /** Judged to carry no cross-turn state. A finding, not a default for "I did not think about it". */
  | Readonly<{ kind: "none" }>
  /** The target protocol carries it natively; no carrier needed. */
  | Readonly<{ kind: "native" }>
  /** Round-tripped through a carrier (RFC §6.1). */
  | Readonly<{ kind: "carrier"; record: ContinuationRecord }>
  /** State exists but cannot be carried. Never silent — RFC §10 observation plus History. */
  | Readonly<{ kind: "rejected"; reason: DegradationReason }>

/** Both planes, answered together. Required on every settled item so neither can be skipped. */
export type ItemDisposition = Readonly<{
  presentation: PresentationDisposition
  continuation: ContinuationDisposition
}>

/* ---------------------------------------------------------------------------------------------- *
 * Reasoning exchange envelope (RFC §3.3)
 * ---------------------------------------------------------------------------------------------- */

/**
 * The proxy-owned, protocol-neutral reasoning envelope. Anthropic `thinking` and Responses
 * `reasoning` are wire *projections* of this, not the other way round — that inversion is the whole
 * point of the ADR behind this RFC.
 */
export type ReasoningExchangeItem = Readonly<{
  key: ItemKey
  ordinal: number
  source: ModelIdentity & {
    responseId?: string
  }
  visible: { kind: "summary"; text: string } | { kind: "omitted" } | { kind: "redacted" }
  opaque?: { kind: "claude-signature"; carrierVersion: 2; bytes: string } | { kind: "responses-encrypted"; carrierVersion: 2; bytes: string }
  boundary:
    | { kind: "normal" }
    | { kind: "fallback"; phase: "pre" | "post"; fallbackId: string }
    | { kind: "continuation"; phase: "pre" | "post"; continuationId: string }
  correlationId?: string
}>

/* ---------------------------------------------------------------------------------------------- *
 * Items, parts and terminals
 * ---------------------------------------------------------------------------------------------- */

export type ItemKind = "reasoning" | "text" | "function-call" | "function-result" | "server-tool-call" | "server-tool-result" | "degraded-text" | "drop"

/**
 * The terminal state of an item or a part. `partial` carries its provenance because the recovery
 * contract differs per cause: a fallback cut must carry the `fallbackId` that later segments key
 * off, while an EOF cut must NOT invent one. The union enforces that at the type level.
 */
export type ItemTerminal =
  | Readonly<{ kind: "complete" }>
  | Readonly<{ kind: "partial"; provenance: "fallback"; fallbackId: string; reason?: DegradationReason }>
  | Readonly<{ kind: "partial"; provenance: "continuation"; continuationId: string; reason?: DegradationReason }>
  | Readonly<{ kind: "partial"; provenance: "eof" | "abort" | "wire-error"; fallbackId?: never; continuationId?: never; reason?: DegradationReason }>
  | Readonly<{ kind: "discarded"; reason: DegradationReason }>

export type CallMetadata = Readonly<{
  callId: string
  name: string
}>

export type ResultMetadata = Readonly<{
  callId: string
  name?: string
  isError: boolean
  sourcePayload?: unknown
}>

/**
 * The settled, emitter-facing view of one item. Produced from {@link PerOutputItemState} only once
 * that item is terminal — the accumulation shape and the settled shape are deliberately different
 * types so no emitter can read a half-accumulated item as if it were final.
 */
export type SemanticItem =
  | Readonly<{ key: ItemKey; ordinal: number; kind: "reasoning"; reasoning: ReasoningExchangeItem; terminal: ItemTerminal; disposition: ItemDisposition }>
  | Readonly<{
      key: ItemKey
      ordinal: number
      kind: "text" | "degraded-text"
      text: string
      correlationId?: string
      terminal: ItemTerminal
      disposition: ItemDisposition
    }>
  | Readonly<{
      key: ItemKey
      ordinal: number
      kind: "function-call" | "server-tool-call"
      call: CallMetadata
      arguments: string
      terminal: ItemTerminal
      disposition: ItemDisposition
    }>
  | Readonly<{
      key: ItemKey
      ordinal: number
      kind: "function-result" | "server-tool-result"
      result: ResultMetadata
      output: string
      terminal: ItemTerminal
      disposition: ItemDisposition
    }>
  | Readonly<{
      key: ItemKey
      ordinal: number
      kind: "drop"
      reason: DegradationReason
      terminal: Extract<ItemTerminal, { kind: "discarded" }>
      disposition: ItemDisposition
    }>

/**
 * Every arm of {@link SemanticItem} carries a `disposition` — checked here rather than left to a consumer to notice.
 *
 * The load-bearing part is the `false` branch, not the brackets. Measured (tsc 5.9.3 `--strict`, four variants): with `: false` this catches a missing arm whether or not the conditional distributes; with `: never` it catches nothing either way, because `never` satisfies every constraint and `Assert<never>` passes silently. The brackets are kept because a whole-union check is what is meant, and it yields one boolean instead of a widened union — but they are not what makes this bite.
 *
 * Nor is the required field enough on its own: merely adding a union arm that omits it produces *no* diagnostic; that only surfaces where a consumer reads the field, and `SemanticItem` has no consumers yet. This alias is the enforcement.
 */
type Assert<T extends true> = T
export type _AllSemanticItemArmsCarryDisposition = Assert<[SemanticItem] extends [{ disposition: ItemDisposition }] ? true : false>

export type PartKind = "reasoning-summary" | "reasoning-content" | "text"

/**
 * A nested lifecycle inside an item. Responses nests summary/content parts under a reasoning item
 * and text parts under a message item, each with its own declare→delta→done cycle; RFC §4 forbids
 * inferring that a nested part finished just because its parent item did.
 */
export type PartState = Readonly<{
  key: PartKey
  itemKey: ItemKey
  kind: PartKind
  sourceIndex: number
  textDeltas: ReadonlyArray<string>
  authoritativeText?: string
  terminal?: ItemTerminal
}>

/** The mutable-in-spirit accumulation record for one output item, keyed by {@link ItemKey}. */
export type PerOutputItemState = Readonly<{
  key: ItemKey
  segmentId: SegmentId
  source: SourceRef
  ordinal: number
  kind: ItemKind
  call?: CallMetadata
  result?: ResultMetadata
  argumentDeltas: ReadonlyArray<string>
  authoritativeArguments?: string
  outputDeltas: ReadonlyArray<string>
  authoritativeOutput?: string
  parts: ReadonlyMap<PartKey, PartState>
  opaque?: ReasoningExchangeItem["opaque"]
  reasoningVisibleKind?: "summary" | "omitted" | "redacted"
  correlationId?: string
  terminal?: ItemTerminal
  /**
   * Optional while accumulating, required at `finish-item` — the accumulation shape and the settled
   * shape differ on purpose. A mapper often cannot decide the continuation plane until the opaque
   * state has actually arrived, so forcing it at declare time would only produce a guessed value.
   */
  disposition?: ItemDisposition
}>

/**
 * Exactly one of these settles a response. `completed` is reachable only from a wire terminal —
 * RFC §4 forbids an emitter from upgrading `incomplete`/`failed`/`cancelled` into it, which is why
 * `provenance` is part of the type rather than a log field.
 */
export type ResponseTerminal =
  | Readonly<{ kind: "completed"; usage?: unknown; provenance: "wire-terminal" }>
  | Readonly<{ kind: "incomplete"; reason: string; usage?: unknown; provenance: "wire-terminal" | "eof" }>
  | Readonly<{ kind: "incomplete"; reason: string; usage?: unknown; provenance: "fallback"; fallbackId: string }>
  | Readonly<{ kind: "incomplete"; reason: string; usage?: unknown; provenance: "continuation"; continuationId: string }>
  | Readonly<{ kind: "failed"; error: unknown; usage?: unknown; provenance: "wire-terminal" | "eof" | "abort" | "preflight-reject" }>
  | Readonly<{ kind: "cancelled"; reason: string; usage?: unknown; provenance: "abort" | "driver-cancel" }>

/* ---------------------------------------------------------------------------------------------- *
 * Reducer input
 * ---------------------------------------------------------------------------------------------- */

/** The complete set of transitions the ledger accepts. Wire decoders produce these; nothing else. */
export type LedgerUpdate =
  | Readonly<{
      type: "declare-item"
      key: ItemKey
      segmentId: SegmentId
      source: SourceRef
      ordinal: number
      kind: ItemKind
      call?: CallMetadata
      result?: ResultMetadata
      correlationId?: string
    }>
  | Readonly<{ type: "declare-part"; key: PartKey; itemKey: ItemKey; kind: PartKind; sourceIndex: number }>
  | Readonly<{ type: "append-part-text"; key: PartKey; delta: string }>
  | Readonly<{ type: "finish-part"; key: PartKey; text?: string; terminal: ItemTerminal }>
  | Readonly<{ type: "append-arguments"; key: ItemKey; delta: string }>
  | Readonly<{ type: "set-final-arguments"; key: ItemKey; arguments: string }>
  | Readonly<{ type: "append-result-output"; key: ItemKey; delta: string }>
  | Readonly<{ type: "set-final-result-output"; key: ItemKey; output: string }>
  | Readonly<{
      type: "set-reasoning-metadata"
      key: ItemKey
      visibleKind: "summary" | "omitted" | "redacted"
      opaque?: ReasoningExchangeItem["opaque"]
    }>
  | Readonly<{ type: "finish-item"; key: ItemKey; terminal: ItemTerminal; disposition: ItemDisposition }>
  | Readonly<{ type: "finish-response"; terminal: ResponseTerminal }>
