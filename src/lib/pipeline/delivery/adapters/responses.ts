import { openAIStreamErrorFrame } from "~/lib/openai/stream-error"

import type {
  //
  DeliveryFrameClass,
  DeliveryProtocolAdapter,
} from "../protocol"

import {
  //
  classifyCommonFinish,
  frameFailure,
  parseFramePayload,
} from "./shared"

export function createResponsesDeliveryProtocolAdapter({ transport }: { readonly transport: "http" | "ws" }): DeliveryProtocolAdapter {
  const deliveryMode = transport === "http" ? "unit" : "response-terminal"
  return {
    deliveryMode,
    classify({ frame }): DeliveryFrameClass {
      const parsed = parseFramePayload(frame, "Responses")
      if (!parsed.ok) return parsed.classified
      const payload = parsed.payload
      const type = typeof payload.type === "string" ? payload.type : frame.event
      const terminal = terminalClass(type, frame)
      if (terminal) return terminal
      if (transport === "ws") return { kind: "response-append", frame }
      if (type === "response.created" || type === "response.in_progress") return { kind: "structural", structuralKind: "envelope-open", frame }
      if (type === "response.output_item.added") {
        const key = itemKey(payload)
        return key ?
            { kind: "unit-open", unit: { boundary: "output-item", key }, frame }
          : frameFailure("malformed-frame", "response.output_item.added requires item.id, item_id, or output_index", frame, undefined)
      }
      if (type === "response.output_item.done") {
        const key = itemKey(payload)
        return key ?
            { kind: "unit-close", unit: { boundary: "output-item", key }, frame }
          : frameFailure("malformed-frame", "response.output_item.done requires item.id, item_id, or output_index", frame, undefined)
      }
      const key = itemKey(payload)
      if (key) return { kind: "unit-append", unit: { boundary: "output-item", key }, frame }
      if (type?.includes("usage")) return { kind: "structural", structuralKind: "usage", frame }
      return frameFailure("unexpected-frame", `unsupported Responses frame type: ${String(type)}`, frame, undefined)
    },
    classifyFinish: classifyCommonFinish,
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
  if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") return (item as { id: string }).id
  if (typeof payload.item_id === "string") return payload.item_id
  return typeof payload.output_index === "number" ? String(payload.output_index) : undefined
}
