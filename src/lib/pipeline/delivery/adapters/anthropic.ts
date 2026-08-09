import { anthropicErrorFrame } from "~/lib/anthropic/stream-error-frame"

import type {
  //
  DeliveryProtocolAdapter,
} from "../protocol"
import type { DeliveryControlCapability } from "../protocol"

import {
  //
  classifyCommonFinish,
  frameFailure,
  parseFramePayload,
} from "./shared"

/** Create the Anthropic wire classifier. Renderers land separately test-first. */
export interface AnthropicDeliveryAdapter extends DeliveryProtocolAdapter {
  readonly createProtocolPingCapability: () => DeliveryControlCapability
}

export function createAnthropicDeliveryProtocolAdapter(): AnthropicDeliveryAdapter {
  class AdapterControlCapability {
    readonly controlKind = "protocol-ping" as const
  }
  const issued = new WeakSet<object>()
  const issue = (): DeliveryControlCapability => {
    const capability = Object.freeze(new AdapterControlCapability())
    issued.add(capability)
    return capability as unknown as DeliveryControlCapability
  }
  const isControlCapability = (value: unknown, _kind: "protocol-ping"): value is DeliveryControlCapability =>
    typeof value === "object" && value !== null && issued.has(value) && value instanceof AdapterControlCapability
  return {
    deliveryMode: "unit",
    createProtocolPingCapability: issue,
    classify({ frame, controlCapability }) {
      const parsed = parseFramePayload(frame, "Anthropic")
      if (!parsed.ok) return parsed.classified
      const payload = parsed.payload as { type?: unknown; index?: unknown }
      if (payload.type === "ping" && isControlCapability(controlCapability, "protocol-ping")) {
        return { kind: "control", frame, capability: controlCapability }
      }
      const unit = () => {
        if (typeof payload.index !== "number") return undefined
        return { boundary: "content-block" as const, key: String(payload.index) }
      }
      switch (payload.type) {
        case "content_block_start": {
          const identity = unit()
          return identity ?
              { kind: "unit-open", unit: identity, frame }
            : frameFailure("malformed-frame", "content_block_start requires a numeric index", frame, undefined)
        }
        case "content_block_delta": {
          const identity = unit()
          return identity ?
              { kind: "unit-append", unit: identity, frame }
            : frameFailure("malformed-frame", "content_block_delta requires a numeric index", frame, undefined)
        }
        case "content_block_stop": {
          const identity = unit()
          return identity ?
              { kind: "unit-close", unit: identity, frame }
            : frameFailure("malformed-frame", "content_block_stop requires a numeric index", frame, undefined)
        }
        case "message_start": {
          return { kind: "structural", structuralKind: "envelope-open", frame }
        }
        case "message_delta": {
          return { kind: "structural", structuralKind: "usage", frame }
        }
        case "message_stop": {
          return {
            kind: "response-terminal",
            terminal: { semantic: "complete", sourceFrame: frame, diagnostic: { source: "wire-frame", terminal: "message_stop" } },
          }
        }
        // An in-band upstream error (H2 — overload / server_error) is a terminal upstream DECISION, not a transport cut: spec §5.3 M1 says commit it and fail, never retry.
        // Without this case the frame fell through to `unexpected-frame`, which is neither a unit-close (so the grammar could not project it into `commitBoundaries`) nor in `isUpstreamFailure` (so `sawUpstreamError` stayed false).
        // The buffered path then read the missing `message_stop` as a truncation and retried a terminal error.
        // Mirrors `adapters/responses.ts`, which maps `error` alongside `response.failed`.
        case "error": {
          return {
            kind: "response-terminal",
            terminal: { semantic: "failed", sourceFrame: frame, diagnostic: { source: "wire-frame", terminal: "error" } },
          }
        }
        default: {
          return frameFailure("unexpected-frame", `unsupported Anthropic frame type: ${String(payload.type)}`, frame, undefined)
        }
      }
    },
    classifyFinish: classifyCommonFinish,
    renderTerminal(terminal) {
      return terminal.sourceFrame ? [terminal.sourceFrame] : [{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) }]
    },
    renderError(error) {
      return [anthropicErrorFrame("api_error", error.detail)]
    },
    renderDone() {
      return []
    },
  }
}
