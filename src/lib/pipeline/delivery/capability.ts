/**
 * Generation emission command algebra — capability types and the profile registry.
 *
 * This is the type layer only (RFC `2026-08-03-generation-emission-command-algebra`, Commit 1).
 * Nothing here constructs a production owner, switches a call site, registers a timer, or samples.
 * The command port that consumes these types is published atomically in Commit 4.
 *
 * **Scope of this round** — ADR `2026-08-10-trust-the-caller-over-emission-authorization`: the
 * atomicity/serialization class and the type-narrowing class are in; the runtime authorization
 * class is not. So there is no classifier here, no `actualEffect`, and no intent-vs-effect
 * rejection. `expectedEffect` survives because it is derived from `command × profile` alone —
 * nothing observes the payload to produce it.
 *
 * The load-bearing idea: **a profile that cannot address indexed blocks should not be able to name
 * an indexed command at all**. `indexedBlockLifecycle` is a compile-time discriminant, and
 * {@link CommandsFor} turns it into presence or absence of the indexed port. That is a narrowing,
 * not a guard — nothing checks at runtime, because with the type in place there is nothing to
 * check.
 */

import type { ClientFormat } from "../envelope"
import type { LegToken } from "../types"
import type { DeliveryFrame } from "./types"

/** Physical carrier of a generation's client-visible frames. */
export type DeliveryTransport = "sse" | "ws"

/**
 * Whether this format has indexed content blocks with an owner-governed lifecycle.
 *
 * A **compile-time discriminant, not a runtime feature flag**: every profile states it explicitly,
 * and a missing value must never be read as `"none"` — that would silently hand the permissive
 * branch to a profile whose author simply forgot.
 */
export type IndexedBlockLifecycle = "none" | "anthropic"

/** Pure, format-owned frame construction. Concrete codecs implement it; the delivery layer only calls it. */
export interface CommonDeliveryBuilders {
  buildGeneric(payload: unknown): DeliveryFrame
  buildKeepalive(): DeliveryFrame
  buildTerminal(intent: TerminalIntent): ReadonlyArray<DeliveryFrame>
}

/** Anthropic adds the indexed-block builders on top of the common set. */
export interface AnthropicDeliveryBuilders extends CommonDeliveryBuilders {
  buildBlockStart(wireIndex: number, payload: unknown): DeliveryFrame
  buildBlockDelta(wireIndex: number, payload: unknown): DeliveryFrame
  buildBlockStop(wireIndex: number): DeliveryFrame
}

interface CommonDeliveryProfile<Format extends ClientFormat, Transport extends DeliveryTransport> {
  readonly format: Format
  readonly transport: Transport
  readonly indexedBlockLifecycle: IndexedBlockLifecycle
  readonly builders: CommonDeliveryBuilders
}

export interface AnthropicDeliveryProfile extends CommonDeliveryProfile<"anthropic", "sse"> {
  readonly indexedBlockLifecycle: "anthropic"
  readonly builders: AnthropicDeliveryBuilders
}

export interface ResponsesHttpDeliveryProfile extends CommonDeliveryProfile<"openai-responses", "sse"> {
  readonly indexedBlockLifecycle: "none"
}

export interface ResponsesWsDeliveryProfile extends CommonDeliveryProfile<"openai-responses", "ws"> {
  readonly indexedBlockLifecycle: "none"
}

export interface ChatCompletionsDeliveryProfile extends CommonDeliveryProfile<"openai-cc", "sse"> {
  readonly indexedBlockLifecycle: "none"
}

export interface GeminiDeliveryProfile extends CommonDeliveryProfile<"gemini", "sse"> {
  readonly indexedBlockLifecycle: "none"
}

/**
 * Every delivery profile the generation layer knows about.
 *
 * Azure Chat Completions is deliberately NOT a sixth member: it differs in how the deployment name
 * reaches `body.model`, which is settled before delivery ever sees the request. By the time a
 * profile is chosen it is a Chat Completions stream in every respect that matters here, and a
 * separate member would be a distinction the command algebra could never act on.
 */
export type FormatDeliveryProfile =
  | AnthropicDeliveryProfile
  | ChatCompletionsDeliveryProfile
  | GeminiDeliveryProfile
  | ResponsesHttpDeliveryProfile
  | ResponsesWsDeliveryProfile

/** Why a generation is ending. Carried into `terminate`; the profile's builders shape the frames. */
export type TerminalIntent = "client-aborted" | "complete" | "request-cancelled" | "upstream-exhausted" | "upstream-nonretryable"

/**
 * Whether the terminal frame reached the client.
 *
 * Orthogonal to {@link import("./owner-failure").OwnerCommandFailureDisposition} — that one answers
 * "what should the caller do after ANY command failed" and applies mostly to non-terminal commands.
 * The two axes meet only at "terminate itself failed" (RFC cutover-plan §11 #6, ruled 2026-08-11).
 */
export type TerminalFrameDisposition = "emitted" | "suppressed_client_gone" | "suppressed_session_terminating"

/**
 * The opaque result `terminate` hands back and `finalize` consumes.
 *
 * `finalize` accepts nothing else, which is what keeps it from becoming a second emission entry
 * point: it can only seal an operation this owner already terminated.
 */
export interface TerminalEmissionResult {
  readonly terminalFrameDisposition: TerminalFrameDisposition
  /** Frames the owner attempted, in order, whether or not each landed. */
  readonly attemptedSegments: ReadonlyArray<DeliveryFrame>
  /** The prefix of `attemptedSegments` the transport accepted. */
  readonly succeededSegments: ReadonlyArray<DeliveryFrame>
  /** What the route should record as forwarded; kept separate because sampling and wire can diverge on a torn write. */
  readonly forwardedSnapshot: ReadonlyArray<DeliveryFrame>
  /** WS only; `"none"` for SSE, where the response body ending is the close. */
  readonly socketCloseIntent: "close-abnormal" | "close-normal" | "none"
  /** Issued and checked by the owner. Not a security token — it exists so `finalize` cannot be handed a foreign object. */
  readonly issuer: symbol
}

/** Commands every profile has, regardless of block lifecycle. */
export interface CommonGenerationCommands {
  /** One already-built, format-native frame that carries no indexed-block effect. */
  emitGeneric(payload: unknown): Promise<void>
  /** A ping / application keepalive with no indexed target. Anchor and real-block keepalives are pulses, not this. */
  emitKeepalive(): Promise<void>
  /** Open the message envelope (the format's "a response starts here" frame), at most once per operation. */
  openMessageEnvelope(payload: unknown): Promise<void>
  /**
   * Run a batch inside ONE serializer callback: suspend heartbeat, build and validate everything,
   * execute in order, then re-arm a fresh interval — unless the batch contained the terminal.
   *
   * This exists so callers never touch heartbeat timers directly; they cannot, the methods are not
   * on this port.
   */
  runEmissionBatch(run: (batch: BatchScope) => Promise<void>): Promise<void>
  /** First terminal command wins. Does not settle ctx and does not run the delivery-finalized callback. */
  terminate(intent: TerminalIntent): Promise<TerminalEmissionResult>
  /** Seal the operation and fire the delivery-finalized callback exactly once. Constructs and sends nothing. */
  finalize(result: TerminalEmissionResult): Promise<void>
}

/** Commands only a profile with an indexed block lifecycle can name. */
export interface IndexedGenerationCommands {
  openAnchor(payload: unknown): Promise<void>
  closeOpenAnchor(): Promise<"closed" | "none">
  pulseAnchor(): Promise<"none" | "pulsed">
  openRealBlock(leg: LegToken, upstreamIndex: number, payload: unknown): Promise<void>
  writeRealBlockFrame(leg: LegToken, upstreamIndex: number, payload: unknown): Promise<void>
  pulseOpenBlock(): Promise<"none" | "pulsed">
  /** Close the open anchor and start a real block in ONE command, so no wire state exists between them. */
  closeAnchorThenOpenRealBlock(leg: LegToken, upstreamIndex: number, payload: unknown): Promise<void>
}

/**
 * The command port a given profile gets.
 *
 * A non-Anthropic profile cannot reference `openAnchor` — not "is rejected at runtime", cannot
 * name it. Narrow the union (`profile.indexedBlockLifecycle === "anthropic"`) before calling the
 * factory; reading a nested `owner.profile.indexedBlockLifecycle` afterwards does NOT narrow the
 * port, which TypeScript 5.9.3 was measured to confirm.
 */
export type CommandsFor<P extends FormatDeliveryProfile> =
  P["indexedBlockLifecycle"] extends "anthropic" ? CommonGenerationCommands & IndexedGenerationCommands : CommonGenerationCommands

/** The subset available inside `runEmissionBatch`; terminal and finalize are not re-entrant. */
export type BatchScope = Omit<CommonGenerationCommands, "finalize" | "runEmissionBatch" | "terminate">

/** Canonical command family names. Bounded on purpose — telemetry uses these as a dimension. */
export type GenerationCommandName =
  | "closeAnchorThenOpenRealBlock"
  | "closeOpenAnchor"
  | "emitGeneric"
  | "emitKeepalive"
  | "finalize"
  | "openAnchor"
  | "openMessageEnvelope"
  | "openRealBlock"
  | "pulseAnchor"
  | "pulseOpenBlock"
  | "terminate"
  | "writeRealBlockFrame"

/** The effect family a command produces, derived from the command alone. */
export type GenerationEffect = "envelope-open" | "indexed-block" | "keepalive" | "passthrough" | "terminal"

/**
 * `command → effect`, and which lifecycle may issue it.
 *
 * Deriving `expectedEffect` from this table is what lets telemetry carry an effect dimension with
 * no classifier: the answer depends on the command and the profile, never on the payload.
 */
export const GENERATION_COMMAND_REGISTRY = {
  closeAnchorThenOpenRealBlock: { effect: "indexed-block", requires: "anthropic" },
  closeOpenAnchor: { effect: "indexed-block", requires: "anthropic" },
  emitGeneric: { effect: "passthrough", requires: "any" },
  emitKeepalive: { effect: "keepalive", requires: "any" },
  finalize: { effect: "terminal", requires: "any" },
  openAnchor: { effect: "indexed-block", requires: "anthropic" },
  openMessageEnvelope: { effect: "envelope-open", requires: "any" },
  openRealBlock: { effect: "indexed-block", requires: "anthropic" },
  pulseAnchor: { effect: "indexed-block", requires: "anthropic" },
  pulseOpenBlock: { effect: "indexed-block", requires: "anthropic" },
  terminate: { effect: "terminal", requires: "any" },
  writeRealBlockFrame: { effect: "indexed-block", requires: "anthropic" },
} as const satisfies Readonly<Record<GenerationCommandName, { readonly effect: GenerationEffect; readonly requires: "any" | IndexedBlockLifecycle }>>

/** Whether `profile` may issue `command`. Mirrors what {@link CommandsFor} already enforces at compile time. */
export function isCommandCompatible(command: GenerationCommandName, profile: FormatDeliveryProfile): boolean {
  const requires = GENERATION_COMMAND_REGISTRY[command].requires
  return requires === "any" || requires === profile.indexedBlockLifecycle
}

/**
 * What every physical emission carries.
 *
 * The minimum property set, deliberately not a committed field layout — flat fields versus nested
 * objects versus opaque tokens gets decided in Commit 3, once the real callers are known.
 *
 * `commandId` is a diagnostic identity, NOT an authorization credential: nothing checks it before
 * emitting (ADR trust-the-caller). It exists so History and traces can tell an intentional command
 * apart from a frame that leaked out some other way.
 */
export interface ValidatedDeliveryEnvelope {
  readonly frame: DeliveryFrame
  readonly command: GenerationCommandName
  /** Unique within one operation. Deliberately NOT a telemetry dimension — unbounded cardinality. */
  readonly commandId: string
  readonly formatProfile: FormatDeliveryProfile
  /** From {@link GENERATION_COMMAND_REGISTRY}. There is no `actualEffect` this round — see the file header. */
  readonly expectedEffect: GenerationEffect
  /** Minted by the owner from its own lease/mapping registry for indexed effects; `"none"` otherwise. */
  readonly provenance: "anchor" | "keepalive" | "none" | "real-block" | "terminal"
  readonly targetKind: "anchor" | "none" | "operation" | "real_block" | "socket"
  /** Present only for indexed effects; the owner's authorization record, not a caller-supplied number. */
  readonly wireIndex?: number
  readonly legKind: "continuation" | "none" | "primary" | "recovery"
  /** Bumps on every owner state mutation, so a stale envelope is recognizable after the fact. */
  readonly ownerStateVersion: number
  readonly candidateId?: string
  readonly dispatchId?: string
  readonly observedAtMonotonic: number
  /** Past the C9 commit point: the client may already have seen bytes, so this attempt is not revocable. */
  readonly committed: boolean
  /** Which half of a compound command this frame belongs to; `"single"` for the ordinary case. */
  readonly compoundPhase: "close" | "single" | "start"
}
