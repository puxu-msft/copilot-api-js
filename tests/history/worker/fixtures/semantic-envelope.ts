import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type {
  //
  CandidateHandle,
  DispatchHandle,
  ModelOperationRecord,
} from "~/lib/context/model-operation-record"
import type {
  //
  HistoryOperationEnvelope,
  HistoryWorkerStartConfig,
} from "~/lib/history/worker/protocol"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import { HISTORY_WORKER_PROTOCOL_VERSION } from "~/lib/history/worker/protocol"

/**
 * Shared builders for the Batch 2a semantic-backend tests. The record is deliberately
 * *rich* — ingress, one candidate, one dispatch with all three dispatch tracks, and an
 * egress — because a bare `commitTerminal()` record produces zero `v3_tracks` rows, and a
 * persistence assertion that never looks at tracks cannot tell a real commit from a stub.
 */
export function buildTerminalRecord(operationId = "op-semantic-1", options: { readonly text?: string } = {}): ModelOperationRecord {
  const text = options.text ?? "ok"
  const recorder = createModelOperationRecorder({ identity: { operationId, kind: "generation", createdAt: 1000 } })
  const clientRequest = recorder.registerPayload({ model: "m", messages: [{ role: "user", content: "hi" }] }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({
    request: { payload: clientRequest, status: 200, headers: [["content-type", "application/json"]] },
    method: "POST",
    path: "/v1/messages",
  })
  recorder.recordRouting({ requestedModel: "m", resolvedModel: "m-resolved" })

  const candidate: CandidateHandle = recorder.beginCandidate({ role: "primary" })
  const upstreamRequest = recorder.registerPayload({ model: "m-resolved", stream: true }, { origin: { stage: "dispatch", track: "upstream", candidate } })
  const dispatch: DispatchHandle = recorder.beginDispatch({
    candidate,
    strategy: "direct",
    transport: "http",
    effectiveRequest: { payload: clientRequest },
    upstreamRequest: { payload: upstreamRequest },
  })
  const responseFrame = recorder.registerFrame(
    { type: "content_block_delta", delta: { text } },
    { origin: { stage: "upstream-response", track: "upstream", candidate, dispatch } },
  )
  recorder.settleDispatch(dispatch, { verdict: "committed", upstreamResponse: { frames: [responseFrame], status: 200 } })
  recorder.settleCandidate(candidate, { verdict: "winner" })

  const clientPayload = recorder.registerPayload({ role: "assistant", content: text }, { origin: { stage: "egress", track: "client" } })
  recorder.recordEgress({ upstream: { frames: [responseFrame] }, client: { payload: clientPayload, status: 200 } })

  return recorder.commitTerminal({
    outcome: "completed",
    winnerCandidate: candidate,
    committedDispatch: dispatch,
    usage: { inputTokens: 1, outputTokens: 2 },
  })
}

/** Track names `prepareModelOperation` derives from the record above, in `collectTracks` order. */
export const EXPECTED_TRACK_NAMES = [
  "client-ingress",
  "effective-request",
  "upstream-request",
  "upstream-response",
  "upstream-egress",
  "client-egress",
] as const

export function buildEnvelope(record: ModelOperationRecord = buildTerminalRecord()): HistoryOperationEnvelope {
  return {
    protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
    publication: {
      record,
      rawAttachment: {
        rawTarget: { configRevision: 1, requested: false, maxObjectBytes: 1024 },
        rawCommands: [],
      },
    },
  }
}

export function buildStartConfig(semanticDbPath: string, overrides: Partial<HistoryWorkerStartConfig> = {}): HistoryWorkerStartConfig {
  return {
    semanticDbPath,
    configRevision: 1,
    rawConfig: { enabled: false, dbPath: "", maxObjectBytes: 1024 },
    persistRetry: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0, maxTotalMs: 0 },
    maintenanceIntervalMs: 60_000,
    ...overrides,
  }
}

export interface TempSemanticDb {
  readonly dir: string
  readonly dbPath: string
  cleanup(): void
}

/** A private on-disk artifact per test — never the user's history DB. */
export function createTempSemanticDb(prefix = "history-worker-2a-"): TempSemanticDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return {
    dir,
    dbPath: path.join(dir, "history-v3.db"),
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}
