import { openAIStreamErrorFrame } from "~/lib/openai/stream-error"

import type {
  //
  ClientProtocolError,
  DeliveryFinishClass,
  DeliveryFrameClass,
  DeliveryProtocolAdapter,
} from "../protocol"

export function createResponsesDeliveryProtocolAdapter({ transport }: { readonly transport: "http" | "ws" }): DeliveryProtocolAdapter {
  const deliveryMode = transport === "http" ? "unit" : "response-terminal"
  return {
    deliveryMode,
    classify({ frame }): DeliveryFrameClass {
      let payload: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(frame.data ?? "")
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("payload must be an object")
        payload = parsed as Record<string, unknown>
      } catch (cause) {
        return failure("malformed-frame", "Responses frame is not valid JSON object", frame, cause)
      }
      const type = typeof payload.type === "string" ? payload.type : frame.event
      const terminal = terminalClass(type, frame)
      if (terminal) return terminal
      if (transport === "ws") return { kind: "response-append", frame }
      if (type === "response.created" || type === "response.in_progress") return { kind: "structural", structuralKind: "envelope-open", frame }
      if (type === "response.output_item.added") {
        const key = itemKey(payload)
        return key ?
            { kind: "unit-open", unit: { boundary: "output-item", key }, frame }
          : failure("malformed-frame", "response.output_item.added requires item.id", frame, undefined)
      }
      if (type === "response.output_item.done") {
        const key = itemKey(payload)
        return key ?
            { kind: "unit-close", unit: { boundary: "output-item", key }, frame }
          : failure("malformed-frame", "response.output_item.done requires item.id", frame, undefined)
      }
      const key = typeof payload.item_id === "string" ? payload.item_id : undefined
      if (key) return { kind: "unit-append", unit: { boundary: "output-item", key }, frame }
      if (type?.includes("usage")) return { kind: "structural", structuralKind: "usage", frame }
      return failure("unexpected-frame", `unsupported Responses frame type: ${String(type)}`, frame, undefined)
    },
    classifyFinish(result): DeliveryFinishClass {
      switch (result.kind) {
        case "complete": {
          return { kind: "natural-drain" }
        }
        case "valid-terminal-without-boundary": {
          if (new TextEncoder().encode(result.terminal).byteLength > 256)
            return finishFailure("malformed-frame", "finish terminal diagnostic exceeds 256 UTF-8 bytes", undefined)
          return {
            kind: "valid-terminal-without-boundary",
            terminal: { semantic: "complete", sourceFrame: null, diagnostic: { source: "finish-result", terminal: result.terminal } },
          }
        }
        case "truncated": {
          return { kind: "truncated", error: { semantic: "truncated", detail: result.reason, sourceFrame: null, cause: undefined } }
        }
        case "terminal-failure": {
          return finishFailure("terminal-failure", result.error instanceof Error ? result.error.message : String(result.error), result.error)
        }
        default: {
          return assertNever(result)
        }
      }
    },
    renderTerminal(terminal) {
      if (terminal.sourceFrame) return [terminal.sourceFrame]
      let type: "response.completed" | "response.incomplete" | "response.failed"
      if (terminal.semantic === "complete") type = "response.completed"
      else if (terminal.semantic === "incomplete") type = "response.incomplete"
      else type = "response.failed"
      return [{ event: transport === "http" ? type : undefined, data: JSON.stringify({ type, response: { status: terminal.semantic } }) }]
    },
    renderError(error) {
      return [openAIStreamErrorFrame(error.cause ?? new Error(error.detail))]
    },
    renderDone() {
      return []
    },
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected Responses finish result: ${String(value)}`)
}

function terminalClass(type: string | undefined, frame: Parameters<DeliveryProtocolAdapter["classify"]>[0]["frame"]): DeliveryFrameClass | undefined {
  let semantic: "complete" | "incomplete" | "failed" | undefined
  switch (type) {
    case "response.completed": {
      semantic = "complete"
      break
    }
    case "response.incomplete": {
      semantic = "incomplete"
      break
    }
    case "response.failed":
    case "error": {
      semantic = "failed"
      break
    }
    default: {
      semantic = undefined
    }
  }
  return semantic ?
      { kind: "response-terminal", terminal: { semantic, sourceFrame: frame, diagnostic: { source: "wire-frame", terminal: type ?? null } } }
    : undefined
}

function itemKey(payload: Record<string, unknown>): string | undefined {
  const item = payload.item
  return item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : undefined
}

function failure(
  semantic: ClientProtocolError["semantic"],
  detail: string,
  sourceFrame: ClientProtocolError["sourceFrame"],
  cause: unknown,
): DeliveryFrameClass {
  return { kind: "protocol-error", error: { semantic, detail, sourceFrame, cause } }
}

function finishFailure(semantic: "malformed-frame" | "terminal-failure", detail: string, cause: unknown): DeliveryFinishClass {
  return { kind: "terminal-failure", error: { semantic, detail, sourceFrame: null, cause } }
}
