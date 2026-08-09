import { openDatabaseReadonly } from "/home/xp/src/copilot-api-js/src/lib/history/sqlite/connection.ts"
import { getV3StoredOperation } from "/home/xp/src/copilot-api-js/src/lib/history/v3/store.ts"
import { recordToHistoryEntry } from "/home/xp/src/copilot-api-js/src/lib/history/v3/projection.ts"

const dbPath = "/home/xp/.local/share/copilot-api/history-v3-260807.db"
const db = openDatabaseReadonly(dbPath)
const ids = db.query<{ operation_id: string }, []>(`
  SELECT operation_id FROM v3_operations
  WHERE summary_json IS NOT NULL
    AND json_extract(summary_json,'$.responseError') LIKE '%NGHTTP2_CANCEL%'
  ORDER BY created_at
`).all().map((row) => row.operation_id)

const output = ids.map((id) => {
  const stored = getV3StoredOperation(id, db)
  if (!stored) throw new Error(`missing ${id}`)
  const entry = recordToHistoryEntry(stored.record, stored)
  const attempt = entry.attempts?.at(-1)
  const frames = attempt?.upstreamResponse?.sseEvents ?? []
  const last = frames.at(-1)
  const durationMs = attempt?.durationMs ?? entry.durationMs ?? 0
  const lastOffsetMs = last?.offsetMs ?? 0
  const upstreamBody = attempt?.upstreamRequest?.body as Record<string, unknown> | undefined
  let lastSequenceNumber: number | undefined
  if (last?.raw) {
    try {
      const parsed = JSON.parse(last.raw) as { sequence_number?: unknown }
      if (typeof parsed.sequence_number === "number") lastSequenceNumber = parsed.sequence_number
    } catch {
      // Non-JSON frames have no Responses sequence number.
    }
  }
  return {
    id,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    pid: entry.process?.pid,
    sessionId: entry.sessionId,
    requestModel: entry.model?.requested,
    responseModel: entry.model?.resolved,
    durationMs,
    upstreamHeadersAt: attempt?.timing?.upstreamHeadersAt,
    maxOutputTokens: upstreamBody?.max_output_tokens ?? upstreamBody?.max_tokens,
    lastSequenceNumber,
    requestBytes: entry.clientRequest?.body ? Buffer.byteLength(JSON.stringify(entry.clientRequest.body)) : undefined,
    responseBytes: frames.reduce((sum, frame) => sum + Buffer.byteLength(frame.raw ?? ""), 0),
    attemptCount: entry.attempts?.length ?? 0,
    frames: frames.length,
    firstType: frames[0]?.type ?? null,
    firstOffsetMs: frames[0]?.offsetMs ?? null,
    lastType: last?.type ?? null,
    lastOffsetMs: last?.offsetMs ?? null,
    silenceMs: durationMs - lastOffsetMs,
    terminalTypes: frames.filter((frame) => ["response.completed", "response.failed", "response.incomplete", "message_stop", "[DONE]"].includes(frame.type)).map((frame) => frame.type),
  }
})

process.stdout.write(JSON.stringify(output))
db.close()
