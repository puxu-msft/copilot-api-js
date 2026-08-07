import { geminiStreamErrorFromError } from "~/lib/gemini/stream-error"

import type {
  //
  DeliveryFinishClass,
  DeliveryFrameClass,
  DeliveryProtocolAdapter,
} from "../protocol"

export function createGeminiDeliveryProtocolAdapter(): DeliveryProtocolAdapter {
  return {
    deliveryMode: "response-terminal",
    classify({ frame }): DeliveryFrameClass {
      let payload: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(frame.data ?? "")
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("payload must be an object")
        payload = parsed as Record<string, unknown>
      } catch (cause) {
        return protocolError("malformed-frame", "Gemini frame is not a valid JSON object", frame, cause)
      }
      const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
      const finishReason = candidates
        .map((candidate) => (candidate && typeof candidate === "object" ? (candidate as { finishReason?: unknown }).finishReason : undefined))
        .find((value): value is string => typeof value === "string" && value.length > 0 && value !== "FINISH_REASON_UNSPECIFIED")
      if (payload.error && typeof payload.error === "object") return terminal(frame, "failed", finishReason ?? "error")
      if (finishReason) return terminal(frame, finishReason === "OTHER" ? "failed" : "complete", finishReason)
      if (payload.usageMetadata && candidates.length === 0) return { kind: "structural", structuralKind: "usage", frame }
      if (candidates.length > 0) return { kind: "response-append", frame }
      return protocolError("unexpected-frame", "unsupported Gemini frame", frame, undefined)
    },
    classifyFinish,
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
      const message = cause instanceof Error ? cause.message : String(cause)
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

function classifyFinish(result: Parameters<DeliveryProtocolAdapter["classifyFinish"]>[0]): DeliveryFinishClass {
  switch (result.kind) {
    case "complete":
      return { kind: "natural-drain" }
    case "valid-terminal-without-boundary":
      if (new TextEncoder().encode(result.terminal).byteLength > 256) return finishFailure("malformed-frame", "finish terminal diagnostic exceeds 256 UTF-8 bytes", undefined)
      return {
        kind: "valid-terminal-without-boundary",
        terminal: { semantic: "complete", sourceFrame: null, diagnostic: { source: "finish-result", terminal: result.terminal } },
      }
    case "truncated":
      return { kind: "truncated", error: { semantic: "truncated", detail: result.reason, sourceFrame: null, cause: undefined } }
    case "terminal-failure":
      return finishFailure("terminal-failure", result.error instanceof Error ? result.error.message : String(result.error), result.error)
  }
}

function protocolError(
  semantic: "malformed-frame" | "unexpected-frame",
  detail: string,
  sourceFrame: Parameters<DeliveryProtocolAdapter["classify"]>[0]["frame"],
  cause: unknown,
): DeliveryFrameClass {
  return { kind: "protocol-error", error: { semantic, detail, sourceFrame, cause } }
}

function finishFailure(semantic: "malformed-frame" | "terminal-failure", detail: string, cause: unknown): DeliveryFinishClass {
  return { kind: "terminal-failure", error: { semantic, detail, sourceFrame: null, cause } }
}
