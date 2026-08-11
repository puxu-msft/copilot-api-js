import type {
  //
  ClientProtocolError,
  DeliveryFinishClass,
  DeliveryFrameClass,
  DeliveryProtocolAdapter,
} from "../protocol"

export type ParsedFrame = { readonly ok: true; readonly payload: Record<string, unknown> } | { readonly ok: false; readonly classified: DeliveryFrameClass }

export function parseFramePayload(frame: Parameters<DeliveryProtocolAdapter["classify"]>[0]["frame"], protocol: string): ParsedFrame {
  let data: string | undefined
  try {
    data = frame.data
  } catch (cause) {
    return { ok: false, classified: frameFailure("adapter-exception", `${protocol} frame access failed`, frame, cause) }
  }

  try {
    const parsed: unknown = JSON.parse(data ?? "")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, classified: frameFailure("malformed-frame", `${protocol} frame payload must be an object`, frame, undefined) }
    }
    return { ok: true, payload: parsed as Record<string, unknown> }
  } catch (cause) {
    return { ok: false, classified: frameFailure("malformed-frame", `${protocol} frame is not valid JSON`, frame, cause) }
  }
}

export function classifyCommonFinish(
  result: Parameters<DeliveryProtocolAdapter["classifyFinish"]>[0],
  terminalSemantic: "complete" | "incomplete" | "failed" = "complete",
): DeliveryFinishClass {
  switch (result.kind) {
    case "complete": {
      return { kind: "natural-drain" }
    }
    case "valid-terminal-without-boundary": {
      if (new TextEncoder().encode(result.terminal).byteLength > 256) {
        return finishFailure("malformed-frame", "finish terminal diagnostic exceeds 256 UTF-8 bytes", undefined)
      }
      return {
        kind: "valid-terminal-without-boundary",
        terminal: { semantic: terminalSemantic, sourceFrame: null, diagnostic: { source: "finish-result", terminal: result.terminal } },
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
}

export function frameFailure(
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

function assertNever(value: never): never {
  throw new Error(`Unexpected response finish result: ${String(value)}`)
}
