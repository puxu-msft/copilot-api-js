import { geminiStreamErrorFromError } from "~/lib/gemini/stream-error"

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

export function createGeminiDeliveryProtocolAdapter(): DeliveryProtocolAdapter {
  return {
    deliveryMode: "response-terminal",
    classify({ frame }): DeliveryFrameClass {
      const parsed = parseFramePayload(frame, "Gemini")
      if (!parsed.ok) return parsed.classified
      const payload = parsed.payload
      const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
      const finishReason = candidates
        .map((candidate) => (candidate && typeof candidate === "object" ? (candidate as { finishReason?: unknown }).finishReason : undefined))
        .find((value): value is string => typeof value === "string" && value.length > 0 && value !== "FINISH_REASON_UNSPECIFIED")
      if (payload.error && typeof payload.error === "object") return terminal(frame, "failed", finishReason ?? "error")
      if (finishReason) return terminal(frame, finishReason === "OTHER" ? "failed" : "complete", finishReason)
      if (payload.usageMetadata && candidates.length === 0) return { kind: "structural", structuralKind: "usage", frame }
      if (candidates.length > 0) return { kind: "response-append", frame }
      return frameFailure("unexpected-frame", "unsupported Gemini frame", frame, undefined)
    },
    classifyFinish: classifyCommonFinish,
    renderTerminal(terminalValue) {
      if (terminalValue.sourceFrame) return [terminalValue.sourceFrame]
      return [
        {
          data: JSON.stringify({
            candidates: [{ content: { role: "model", parts: [] }, finishReason: terminalValue.diagnostic.terminal ?? "STOP", index: 0 }],
          }),
        },
      ]
    },
    renderError(error) {
      const cause = error.cause ?? new Error(error.detail)
      let message = error.detail
      if (cause instanceof Error) message = cause.message
      else if (typeof cause === "string") message = cause
      return [
        {
          data: JSON.stringify({
            candidates: [{ content: { role: "model", parts: [{ text: message }] }, finishReason: "OTHER", index: 0 }],
            error: { ...geminiStreamErrorFromError(cause), message },
          }),
        },
      ]
    },
    renderDone() {
      return []
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
