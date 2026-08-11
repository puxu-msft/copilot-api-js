import type {
  //
  ClientFrame,
  ResponseFinishResult,
} from "../types"

/** Opaque authorization for a frame that may bypass real-frame buffering. */
declare const deliveryControlCapabilityBrand: unique symbol

export type DeliveryControlCapability = {
  readonly [deliveryControlCapabilityBrand]: true
  readonly controlKind: "keepalive" | "protocol-ping"
}

/** Adapter-normalized identity for one client-visible complete unit. */
export type DeliveryUnitIdentity = {
  readonly boundary: "content-block" | "output-item"
  readonly key: string
}

/** Closed set of client-protocol failures that the delivery owner can render. */
export type ClientProtocolError = {
  readonly semantic:
    | "malformed-frame"
    | "unexpected-frame"
    | "nested-unit"
    | "mismatched-unit"
    | "terminal-with-open-unit"
    | "finish-before-terminal"
    | "duplicate-terminal"
    | "post-terminal-frame"
    | "truncated"
    | "terminal-failure"
    | "adapter-exception"
  readonly detail: string
  readonly sourceFrame: ClientFrame | null
  readonly cause: unknown
}

export type ClientTerminal = {
  readonly semantic: "complete" | "incomplete" | "failed"
  readonly sourceFrame: ClientFrame | null
  readonly diagnostic: {
    readonly source: "wire-frame" | "finish-result"
    readonly terminal: string | null
  }
}

export type DeliveryFrameInput = {
  readonly frame: ClientFrame
  readonly controlCapability?: DeliveryControlCapability
}

/** The adapter's complete classification vocabulary; grammar never reparses wire frames. */
export type DeliveryFrameClass =
  | { readonly kind: "control"; readonly frame: ClientFrame; readonly capability: DeliveryControlCapability }
  | { readonly kind: "structural"; readonly frame: ClientFrame; readonly structuralKind: "envelope-open" | "usage" }
  | { readonly kind: "unit-open"; readonly unit: DeliveryUnitIdentity; readonly frame: ClientFrame }
  | { readonly kind: "unit-append"; readonly unit: DeliveryUnitIdentity; readonly frame: ClientFrame }
  | { readonly kind: "unit-close"; readonly unit: DeliveryUnitIdentity; readonly frame: ClientFrame }
  | { readonly kind: "response-append"; readonly frame: ClientFrame }
  | { readonly kind: "response-terminal"; readonly terminal: ClientTerminal }
  | { readonly kind: "protocol-error"; readonly error: ClientProtocolError }

export type DeliveryFinishClass =
  | { readonly kind: "natural-drain" }
  | { readonly kind: "valid-terminal-without-boundary"; readonly terminal: ClientTerminal }
  | { readonly kind: "truncated"; readonly error: ClientProtocolError }
  | { readonly kind: "terminal-failure"; readonly error: ClientProtocolError }

/** The only inputs accepted by the stateful grammar. */
export type DeliveryGrammarInput =
  | { readonly kind: "frame"; readonly classified: DeliveryFrameClass }
  | { readonly kind: "finish"; readonly classified: DeliveryFinishClass }

export type CompleteClientUnit = {
  readonly frames: ReadonlyArray<ClientFrame>
  readonly boundary: DeliveryUnitIdentity["boundary"]
}

/** Ordered ownership transfer requests consumed by the unique delivery owner. */
export type DeliveryOutcome =
  | { readonly kind: "buffer-real-frame"; readonly frame: ClientFrame }
  | { readonly kind: "stage-structural-frame"; readonly frame: ClientFrame; readonly structuralKind: "envelope-open" | "usage" }
  | { readonly kind: "deliver-control-frame"; readonly frame: ClientFrame; readonly capability: DeliveryControlCapability }
  | { readonly kind: "complete-unit"; readonly unit: CompleteClientUnit }
  | { readonly kind: "response-terminal"; readonly terminal: ClientTerminal; readonly responseFrames: ReadonlyArray<ClientFrame> }
  | { readonly kind: "protocol-error"; readonly error: ClientProtocolError }
  | { readonly kind: "discard-open-unit"; readonly reason: string }

export type DeliveryResult =
  | { readonly kind: "delivered" }
  | { readonly kind: "protocol-error"; readonly error: ClientProtocolError }
  | { readonly kind: "client-gone"; readonly committed: boolean }

/** Wire adapter contract; concrete adapters are intentionally introduced in Task 3. */
export interface DeliveryProtocolAdapter {
  readonly deliveryMode: "unit" | "response-terminal"
  classify(input: DeliveryFrameInput): DeliveryFrameClass
  classifyFinish(result: ResponseFinishResult): DeliveryFinishClass
  renderTerminal(terminal: ClientTerminal): ReadonlyArray<ClientFrame>
  renderError(error: ClientProtocolError): ReadonlyArray<ClientFrame>
  renderDone(): ReadonlyArray<ClientFrame>
}
