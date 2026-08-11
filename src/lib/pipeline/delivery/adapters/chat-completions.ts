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

export function createChatCompletionsDeliveryProtocolAdapter(): DeliveryProtocolAdapter {
  return {
    deliveryMode: "response-terminal",
    classify({ frame }): DeliveryFrameClass {
      const parsed = parseFramePayload(frame, "Chat Completions")
      if (!parsed.ok) return parsed.classified
      const payload = parsed.payload
      if (payload.error && typeof payload.error === "object") return terminal(frame, "failed", "error")
      const choices = Array.isArray(payload.choices) ? payload.choices : []
      if (payload.usage && typeof payload.usage === "object") return { kind: "structural", structuralKind: "usage", frame }
      if (choices.length > 0) return { kind: "response-append", frame }
      return frameFailure("unexpected-frame", "unsupported Chat Completions frame", frame, undefined)
    },
    classifyFinish: classifyCommonFinish,
    renderTerminal(terminalValue) {
      if (terminalValue.sourceFrame) return [terminalValue.sourceFrame]
      return [{ data: JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: terminalValue.diagnostic.terminal ?? "stop" }] }) }]
    },
    renderError(error) {
      return [openAIStreamErrorFrame(error.cause ?? new Error(error.detail))]
    },
    renderDone() {
      return [{ data: "[DONE]" }]
    },
  }
}

function terminal(
  sourceFrame: Parameters<DeliveryProtocolAdapter["classify"]>[0]["frame"],
  semantic: "complete" | "failed",
  diagnostic: string,
): DeliveryFrameClass {
  return { kind: "response-terminal", terminal: { semantic, sourceFrame, diagnostic: { source: "wire-frame", terminal: diagnostic } } }
}
