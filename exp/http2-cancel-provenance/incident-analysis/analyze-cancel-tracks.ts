import { Database } from "bun:sqlite"

const dbPath = "/home/xp/.local/share/copilot-api/history-v3-260807.db"
const db = new Database(dbPath, { readonly: true, strict: true })
const decoder = new TextDecoder()

interface Row {
  operation_id: string
  summary_json: string
  attempt_index: number
  track_gz: Uint8Array
}

interface FrameRef {
  offsetMs?: number
  type?: string
  raw?: string
}

interface Track {
  frames?: Array<FrameRef>
}

const rows = db.query<Row, []>(`
  SELECT o.operation_id, o.summary_json, t.attempt_index, t.track_gz
  FROM v3_operations o
  JOIN v3_tracks t ON t.operation_id=o.operation_id
  WHERE o.summary_json IS NOT NULL
    AND json_extract(o.summary_json,'$.responseError') LIKE '%NGHTTP2_CANCEL%'
    AND t.track_name='upstream-response'
    AND t.track_gz IS NOT NULL
  ORDER BY o.created_at, t.attempt_index
`).all()

const output = rows.map((row) => {
  const summary = JSON.parse(row.summary_json) as Record<string, unknown>
  const track = JSON.parse(decoder.decode(Bun.zstdDecompressSync(row.track_gz))) as Track
  const frames = track.frames ?? []
  const first = frames[0]
  const last = frames.at(-1)
  const durationMs = Number(summary.durationMs ?? 0)
  const lastOffsetMs = Number(last?.offsetMs ?? 0)
  return {
    id: row.operation_id,
    attemptIndex: row.attempt_index,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    pid: summary.pid,
    sessionId: summary.sessionId,
    requestModel: summary.requestModel,
    responseModel: summary.responseModel,
    durationMs,
    requestBytes: summary.requestBytes,
    responseBytes: summary.responseBytes,
    attemptCount: summary.attemptCount,
    frames: frames.length,
    firstType: first?.type ?? null,
    firstOffsetMs: first?.offsetMs ?? null,
    lastType: last?.type ?? null,
    lastOffsetMs: last?.offsetMs ?? null,
    silenceMs: durationMs - lastOffsetMs,
    hasResponsesTerminal: frames.some((frame) => frame.type === "response.completed" || frame.type === "response.failed" || frame.type === "response.incomplete"),
    hasAnthropicTerminal: frames.some((frame) => frame.type === "message_stop"),
    hasDone: frames.some((frame) => frame.type === "[DONE]"),
  }
})

process.stdout.write(JSON.stringify(output))
db.close()
