import type {
  //
  FrameNodeHandle,
  OperationFrameObservation,
  OperationHeaderField,
  OperationTrackInput,
} from "~/lib/context/model-operation-record"
import type {
  //
  HistoryEntry,
  SseEventRecord,
} from "~/lib/history/types"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"

function headerFields(headers: Record<string, string> | undefined): ReadonlyArray<OperationHeaderField> | undefined {
  return headers === undefined ? undefined : Object.entries(headers)
}

function recoveredFrames(
  recorder: ReturnType<typeof createModelOperationRecorder>,
  events: ReadonlyArray<SseEventRecord> | undefined,
  track: "upstream" | "client",
  attempt?: Parameters<ReturnType<typeof createModelOperationRecorder>["registerFrame"]>[1]["origin"]["attempt"],
): Pick<OperationTrackInput, "frames" | "frameObservations"> {
  const frames: Array<FrameNodeHandle> = []
  const frameObservations: Array<OperationFrameObservation> = []
  for (const event of events ?? []) {
    let recoveredType = event.type
    try {
      const parsed = JSON.parse(event.raw) as { type?: unknown }
      if (typeof parsed.type === "string") recoveredType = parsed.type
    } catch {
      // Non-JSON payloads retain the projected SSE event label.
    }
    const handle = recorder.registerFrame(
      { data: event.raw },
      {
        origin: {
          stage: "recovery-projection",
          track,
          ...(attempt === undefined ? {} : { attempt }),
          detail: "wire event name/id/retry and original offset were unavailable in the projected backup",
        },
        mediaType: "text/event-stream",
      },
    )
    frames.push(handle)
    frameObservations.push({
      handle,
      type: recoveredType,
      raw: event.raw,
      ...(event.synthetic === undefined ? {} : { synthetic: event.synthetic }),
      extensions: { "history-v3.recovery": { offsetSource: "unavailable", typeSource: recoveredType === event.type ? "projected" : "inferred-from-raw-json" } },
    })
  }
  return { frames, frameObservations }
}

function terminalOutcome(state: HistoryEntry["state"]): "completed" | "failed" | "cancelled" | "aborted" | "interrupted" {
  if (state === "completed") return "completed"
  if (state === "aborted") return "aborted"
  if (state === "interrupted") return "interrupted"
  return "failed"
}

/**
 * Recover a lossy HistoryEntry projection into an explicitly marked canonical
 * container. Missing wall clocks and wire fields remain unavailable; this never
 * fabricates sequence-derived milliseconds or claims byte-exact provenance.
 */
export function recoverProjectedHistoryEntry(entry: HistoryEntry, capturedAt: number) {
  const recorder = createModelOperationRecorder({
    identity: {
      operationId: entry.id,
      kind: entry.operationKind ?? "generation",
      createdAt: entry.startedAt,
      ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
      ...(entry.agentId === undefined ? {} : { agentId: entry.agentId }),
      ...(entry.process === undefined ? {} : { process: entry.process }),
      extensions: { "history-v3.recovery": { source: "projected-history-entry", capturedAt } },
    },
    captureTimestamps: false,
    extensions: {
      "history-v3.recovery": {
        source: "projected-history-entry",
        capturedAt,
        timing: "unavailable unless supplied by an external timing override",
        rawCapture: "unavailable",
      },
    },
  })

  const clientBody = entry.clientRequest?.body
  const ingressPayload =
    clientBody === undefined ? undefined : (
      recorder.registerPayload(clientBody, {
        origin: { stage: "recovery-ingress", track: "client" },
        mediaType: "application/json",
      })
    )
  recorder.recordIngress({
    format: entry.clientRequest?.format ?? entry.endpoint,
    method: entry.clientRequest?.method,
    path: entry.clientRequest?.path ?? entry.rawPath,
    request: {
      ...(ingressPayload === undefined ? {} : { payload: ingressPayload }),
      ...(entry.clientRequest?.headers === undefined ? {} : { headers: headerFields(entry.clientRequest.headers) }),
      metadata: entry.clientRequest,
      rawCapture: { capability: "unavailable", gap: "recovered from HistoryEntry projection; exact request bytes unavailable" },
    },
    extensions: { "history-v3.recovery": { projected: true } },
  })
  recorder.recordRouting({
    requestedModel: entry.model?.requested ?? entry.clientRequest?.model,
    resolvedModel: entry.model?.resolved,
    clientFormat: entry.clientRequest?.format ?? entry.endpoint,
    upstreamEndpoint: entry.model?.outboundEndpoint,
    transport: entry.transport,
    metadata: { translated: entry.model?.translated, recovery: true },
  })

  let lastUpstreamTrack: OperationTrackInput | undefined
  // Recovery intentionally targets the deprecated transition adapter until the P4-P8 migration removes this projection path.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  let committedAttempt: ReturnType<typeof recorder.beginAttempt> | undefined
  for (const [index, projected] of (entry.attempts ?? []).entries()) {
    const effectiveBody = projected.effectiveSource?.body
    const wireBody = projected.upstreamRequest?.body
    const effectivePayload =
      effectiveBody === undefined ? undefined : (
        recorder.registerPayload(effectiveBody, {
          origin: { stage: "recovery-effective", track: "proxy" },
          mediaType: "application/json",
        })
      )
    const wirePayload =
      wireBody === undefined ? undefined : (
        recorder.registerPayload(wireBody, {
          origin: { stage: "recovery-wire", track: "upstream" },
          mediaType: "application/json",
        })
      )
    // Recovery intentionally targets the deprecated transition adapter until the P4-P8 migration removes this projection path.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const handle = recorder.beginAttempt({
      strategy: projected.strategy,
      ...(projected.transport === "http" || projected.transport === "upstream-ws" || projected.transport === "upstream-ws-fallback" ?
        { transport: projected.transport }
      : {}),
      effectiveRequest: {
        ...(effectivePayload === undefined ? {} : { payload: effectivePayload }),
        metadata: projected.effectiveSource,
      },
      upstreamRequest: {
        ...(wirePayload === undefined ? {} : { payload: wirePayload }),
        ...(projected.upstreamRequest?.headers === undefined ? {} : { headers: headerFields(projected.upstreamRequest.headers) }),
        metadata: projected.upstreamRequest,
        rawCapture: { capability: "unavailable", gap: "recovered from HistoryEntry projection; exact upstream request bytes unavailable" },
      },
      metadata: { recovery: true },
    })
    const upstream = projected.upstreamResponse
    const responseBody = upstream?.body ?? upstream?.rawBody
    const responsePayload =
      responseBody === undefined ? undefined : (
        recorder.registerPayload(responseBody, {
          origin: { stage: "recovery-upstream-response", track: "upstream", attempt: handle },
          mediaType: "application/json",
        })
      )
    const observed = recoveredFrames(recorder, upstream?.sseEvents ?? projected.sseEvents, "upstream", handle)
    lastUpstreamTrack = {
      ...(responsePayload === undefined ? {} : { payload: responsePayload }),
      ...observed,
      ...(upstream?.status === undefined ? {} : { status: upstream.status }),
      ...(upstream?.headers === undefined ? {} : { headers: headerFields(upstream.headers) }),
      ...(upstream?.trailers === undefined ? {} : { trailers: headerFields(upstream.trailers) }),
      metadata: { response: upstream, recovery: true },
      rawCapture: { capability: "unavailable", gap: "recovered from HistoryEntry projection; exact upstream response bytes unavailable" },
    }
    const finalAttempt = index === (entry.attempts?.length ?? 0) - 1
    let verdict: "committed" | "discarded" | "failed" = "discarded"
    if (finalAttempt) verdict = entry.state === "completed" ? "committed" : "failed"
    recorder.settleAttempt(handle, {
      verdict,
      upstreamResponse: lastUpstreamTrack,
      ...(projected.error === undefined ? {} : { error: { message: projected.error } }),
      reason: "recovered from projected History V3 entry",
      extensions: { "history-v3.recovery": { projectedAttemptIndex: index } },
    })
    if (verdict === "committed") committedAttempt = handle
  }

  const clientBodyResponse = entry.clientResponse?.body
  const clientPayload =
    clientBodyResponse === undefined ? undefined : (
      recorder.registerPayload(clientBodyResponse, {
        origin: { stage: "recovery-client-response", track: "client" },
        mediaType: "application/json",
      })
    )
  const clientFrames = recoveredFrames(recorder, entry.clientResponse?.sseEvents, "client")
  recorder.recordEgress({
    upstream: lastUpstreamTrack,
    client: {
      ...(clientPayload === undefined ? {} : { payload: clientPayload }),
      ...clientFrames,
      ...(entry.clientResponse?.status === undefined ? {} : { status: entry.clientResponse.status }),
      ...(entry.clientResponse?.headers === undefined ? {} : { headers: headerFields(entry.clientResponse.headers) }),
      metadata: { content: clientBodyResponse, recovery: true },
      rawCapture: { capability: "unavailable", gap: "recovered from HistoryEntry projection; exact client response bytes unavailable" },
    },
    extensions: { "history-v3.recovery": { projected: true } },
  })

  const failureReason = entry._index?.derived?.failureReason
  return recorder.commitTerminal({
    outcome: terminalOutcome(entry.state),
    ...(committedAttempt === undefined ? {} : { committedAttempt }),
    ...(failureReason === undefined ? {} : { error: { message: failureReason } }),
    extensions: { "history-v3.recovery": { projected: true, originalState: entry.state } },
  })
}
