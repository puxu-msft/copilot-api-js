import { openAIStreamErrorFrame } from "~/lib/openai/stream-error"

import type {
  //
  DeliveryFinishClass,
  DeliveryFrameClass,
  DeliveryProtocolAdapter,
} from "../protocol"

export function createChatCompletionsDeliveryProtocolAdapter(): DeliveryProtocolAdapter {
  return {
    deliveryMode: "response-terminal",
    classify({ frame }): DeliveryFrameClass {
      let payload: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(frame.data ?? "")
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("payload must be an object")
        payload = parsed as Record<string, unknown>
      } catch (cause) {
        return protocolError("malformed-frame", "Chat Completions frame is not a valid JSON object", frame, cause)
      }
      if (payload.error && typeof payload.error === "object") return terminal(frame, "failed", "error")
      const choices = Array.isArray(payload.choices) ? payload.choices : []
      const finishReason = choices
        .map((choice) => (choice && typeof choice === "object" ? (choice as { finish_reason?: unknown }).finish_reason : undefined))
        .find((value): value is string => typeof value === "string" && value.length > 0)
      if (finishReason) return terminal(frame, "complete", finishReason)
      if (payload.usage && typeof payload.usage === "object") return { kind: "structural", structuralKind: "usage", frame }
      if (choices.length > 0) return { kind: "response-append", frame }
      return protocolError("unexpected-frame", "unsupported Chat Completions frame", frame, undefined)
    },
    classifyFinish: classifyFinish,
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
