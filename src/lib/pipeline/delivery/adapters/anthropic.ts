import type {
  //
  DeliveryProtocolAdapter,
} from "../protocol"

/** Create the Anthropic wire classifier. Renderers land separately test-first. */
export function createAnthropicDeliveryProtocolAdapter(): DeliveryProtocolAdapter {
  return {
    deliveryMode: "unit",
    classify({ frame }) {
      let data: string | undefined
      try {
        data = frame.data
      } catch (cause) {
        return protocolError("adapter-exception", "Anthropic frame access failed", frame, cause)
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(data ?? "")
      } catch (cause) {
        return protocolError("malformed-frame", "Anthropic frame is not valid JSON", frame, cause)
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return protocolError("malformed-frame", "Anthropic frame payload must be an object", frame, undefined)
      }

      const payload = parsed as { type?: unknown; index?: unknown }
      const unit = () => {
        if (typeof payload.index !== "number") return undefined
        return { boundary: "content-block" as const, key: String(payload.index) }
      }
      switch (payload.type) {
        case "content_block_start": {
          const identity = unit()
          return identity ? { kind: "unit-open", unit: identity, frame } : protocolError("malformed-frame", "content_block_start requires a numeric index", frame, undefined)
        }
        case "content_block_delta": {
          const identity = unit()
          return identity ? { kind: "unit-append", unit: identity, frame } : protocolError("malformed-frame", "content_block_delta requires a numeric index", frame, undefined)
        }
        case "content_block_stop": {
          const identity = unit()
          return identity ? { kind: "unit-close", unit: identity, frame } : protocolError("malformed-frame", "content_block_stop requires a numeric index", frame, undefined)
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
        default: {
          return protocolError("unexpected-frame", `unsupported Anthropic frame type: ${String(payload.type)}`, frame, undefined)
        }
      }
    },
    classifyFinish(result) {
      switch (result.kind) {
        case "complete":
          return { kind: "natural-drain" }
        case "valid-terminal-without-boundary":
          return {
            kind: "valid-terminal-without-boundary",
            terminal: { semantic: "complete", sourceFrame: null, diagnostic: { source: "finish-result", terminal: result.terminal } },
          }
        case "truncated":
          return {
            kind: "truncated",
            error: { semantic: "truncated", detail: result.reason, sourceFrame: null, cause: undefined },
          }
        case "terminal-failure":
          return {
            kind: "terminal-failure",
            error: {
              semantic: "terminal-failure",
              detail: result.error instanceof Error ? result.error.message : String(result.error),
              sourceFrame: null,
              cause: result.error,
            },
          }
      }
    },
    renderTerminal() {
      throw new Error("[anthropic-delivery-adapter] terminal rendering is not implemented")
    },
    renderError() {
      throw new Error("[anthropic-delivery-adapter] error rendering is not implemented")
    },
    renderDone() {
      throw new Error("[anthropic-delivery-adapter] done rendering is not implemented")
    },
  }
}

function protocolError(
  semantic: "malformed-frame" | "unexpected-frame" | "adapter-exception",
  detail: string,
  sourceFrame: Parameters<DeliveryProtocolAdapter["classify"]>[0]["frame"],
  cause: unknown,
): ReturnType<DeliveryProtocolAdapter["classify"]> {
  return { kind: "protocol-error", error: { semantic, detail, sourceFrame, cause } }
}
