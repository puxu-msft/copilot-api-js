/**
 * search_index build + persist (RFC search-index, P1 dual-write).
 *
 * Two-phase split mirrors `insertCompletedEntry`'s "compute-outside, write-inside"
 * discipline:
 *   - `buildSearchIndexForEntry(entry)` — PURE, runs OUTSIDE the finalize
 *     transaction. Does the CPU/parse-heavy work (normalize + SHA-256 each inbound
 *     message, jsdiff-align the rewrite facets, concat headers) so the write lock
 *     is never held for it. Wrapped in one try/catch: any malformed-shape throw
 *     degrades THIS entry to an empty index but never aborts head/stage finalize
 *     (search is derived; finalize robustness wins — RFC reviewer M1).
 *   - `persistSearchIndex(db, reqId, built)` — runs INSIDE the finalize tx, atomic
 *     with the head/stage writes. Write-only, idempotent (clears the request's
 *     prior rows first so re-finalization is safe).
 *
 * Five facets (RFC decision 4): `inbound` (content-addressed messages → msg_blob
 * + req_msg) plus four flat per-request `req_aux` sources (rewrites-req /
 * rewrites-resp / req-headers / resp-headers). Outbound response body is
 * deliberately NOT indexed (it reappears as the next turn's inbound; search is
 * "find the request behind a result", served by rewrites/headers).
 */

import consola from "consola"

import type {
  //
  EndpointType,
  HistoryEntry,
  SseEventRecord,
} from "~/lib/history/types"

import {
  //
  type AlignRow,
  alignMessages,
  alignWithModified,
  type DiffMessage,
} from "~/lib/diff/block-align"
import {
  //
  hashMessage,
  type MessageFormat,
  normalizeMessageForIndex,
} from "~/lib/history/normalize-message"

import type { Database } from "./connection"

/** Separator between header legs / entries in a concatenated `req_aux` text. */
export const HEADER_SEP = "\x1e"

/** The five search facets (RFC decision 4). `inbound` is content-addressed; the rest are flat `req_aux`. */
export type SearchSource = "inbound" | "rewrites-req" | "rewrites-resp" | "req-headers" | "resp-headers"

/** The four non-inbound facets stored flat in `req_aux`. */
export type AuxSource = Exclude<SearchSource, "inbound">

/** One content-addressed inbound message reference. */
export interface BuiltMsg {
  pos: number
  hash: string
  text: string
}

/** One flat per-request aux row (omitted entirely when its text is empty). */
export interface BuiltAux {
  source: AuxSource
  text: string
}

/** Derived search index for one entry, computed outside the finalize tx. */
export interface SearchIndexBuilt {
  msgs: Array<BuiltMsg>
  aux: Array<BuiltAux>
}

const EMPTY_BUILT: SearchIndexBuilt = { msgs: [], aux: [] }

/** Map a persisted endpoint to the normalization format (Responses ≈ chat = openai). */
export function formatFromEndpoint(endpoint: EndpointType): MessageFormat {
  switch (endpoint) {
    case "anthropic-messages": {
      return "anthropic"
    }
    case "gemini-generate-content": {
      return "gemini"
    }
    default: {
      return "openai"
    }
  }
}

/** Content-addressed inbound messages: normalize + hash each, position-ordered. */
function buildInboundMsgs(entry: HistoryEntry, format: MessageFormat): Array<BuiltMsg> {
  const messages = entry.inboundRequest.messages ?? []
  return messages.map((msg, pos) => ({
    pos,
    hash: hashMessage(msg, format),
    text: normalizeMessageForIndex(msg, format),
  }))
}

/** Collect changed-row text (added ∪ removed ∪ both sides of modified) from aligned messages. */
function collectChangedText(rows: Array<AlignRow>): string {
  const parts: Array<string> = []
  for (const row of rows) {
    if (row.kind === "same") continue
    if (row.left !== undefined) parts.push(row.left)
    if (row.right !== undefined) parts.push(row.right)
  }
  return parts.join("\n")
}

/** rewrites-req: what the proxy changed between the client request and the wire request. */
function buildRewritesReq(entry: HistoryEntry): string {
  const inbound = (entry.inboundRequest.messages ?? []) as Array<DiffMessage>
  const outbound = entry.outboundRequest?.messages as Array<DiffMessage> | undefined
  if (!outbound || outbound.length === 0) return ""
  return collectChangedText(alignMessages(inbound, outbound))
}

/** Coerce an unknown forwarded-response content into the loose DiffMessage shape. */
function toResponseDiffMessage(value: unknown): DiffMessage {
  if (value && typeof value === "object" && "role" in value && "content" in value) {
    const obj = value as { role: unknown; content: unknown }
    const role = typeof obj.role === "string" ? obj.role : "assistant"
    return { role, content: coerceContent(obj.content) }
  }
  return { role: "assistant", content: coerceContent(value) }
}

/** Narrow an unknown to DiffMessage's `content` union; non-string/array objects are JSON-serialized so they stay searchable. */
function coerceContent(value: unknown): string | Array<unknown> | null {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value
  if (value === null || value === undefined) return null
  return JSON.stringify(value)
}

/**
 * rewrites-resp: what the proxy changed in the response, split by transport
 * (RFC round-3 MEDIUM-3). Streaming diffs the SSE frames (the dominant, precise
 * path); non-streaming diffs the single response message best-effort.
 *
 * NOTE: per-endpoint structural normalization of the forwarded non-streaming
 * `inboundResponse.content` (Anthropic message vs OpenAI message vs Gemini
 * response shapes) is a future refinement — P1 captures the whole-message changed
 * text (searchable) and relies on the streaming frame diff for the common case.
 * When `inboundResponse` is absent (no forwarded capture) the source is empty.
 */
function buildRewritesResp(entry: HistoryEntry): string {
  const upstreamFrames = entry.sseEvents
  const forwardedFrames = entry.inboundResponse?.sseEvents
  if ((upstreamFrames && upstreamFrames.length > 0) || (forwardedFrames && forwardedFrames.length > 0)) {
    if (!forwardedFrames) return ""
    return collectChangedFrameRaw(upstreamFrames ?? [], forwardedFrames)
  }

  const upstream = entry.outboundResponse?.content
  const forwarded = entry.inboundResponse?.content
  if (upstream === null || upstream === undefined || forwarded === undefined) return ""
  return collectChangedText(alignMessages([toResponseDiffMessage(upstream)], [toResponseDiffMessage(forwarded)]))
}

/** Align upstream vs forwarded SSE frames; collect the raw payload of changed frames. */
function collectChangedFrameRaw(upstream: Array<SseEventRecord>, forwarded: Array<SseEventRecord>): string {
  const rows = alignWithModified(
    upstream,
    forwarded,
    (frame) => `${frame.type}\0${frame.raw}`,
    (frame) => frame.type,
  )
  const parts: Array<string> = []
  for (const row of rows) {
    if (row.kind === "same") continue
    if (row.left !== undefined) parts.push(row.left.raw)
    if (row.right !== undefined) parts.push(row.right.raw)
  }
  return parts.join("\n")
}

/** Serialize one header leg as sorted `key: value` lines (empty when absent). */
function headerLeg(headers: Record<string, string> | undefined): string {
  if (!headers) return ""
  return Object.keys(headers)
    .sort()
    .map((key) => `${key}: ${headers[key]}`)
    .join("\n")
}

/** Join the present legs of a header group with HEADER_SEP. */
function joinHeaderLegs(legs: Array<Record<string, string> | undefined>): string {
  return legs
    .map((leg) => headerLeg(leg))
    .filter((leg) => leg.length > 0)
    .join(HEADER_SEP)
}

/** Build the four flat aux sources, dropping any whose text is empty. */
function buildAux(entry: HistoryEntry): Array<BuiltAux> {
  const headers = entry.httpHeaders
  const candidates: Array<BuiltAux> = [
    { source: "rewrites-req", text: buildRewritesReq(entry) },
    { source: "rewrites-resp", text: buildRewritesResp(entry) },
    { source: "req-headers", text: joinHeaderLegs([headers?.inboundRequest, headers?.outboundRequest]) },
    { source: "resp-headers", text: joinHeaderLegs([headers?.outboundResponse, headers?.inboundResponse, headers?.outboundResponseTrailers]) },
  ]
  return candidates.filter((aux) => aux.text.length > 0)
}

/**
 * Compute the derived search index for one entry. PURE + transaction-OUTSIDE.
 * Any throw (malformed message / unexpected shape) degrades to an empty index
 * rather than aborting the surrounding head/stage finalize (RFC reviewer M1).
 */
export function buildSearchIndexForEntry(entry: HistoryEntry): SearchIndexBuilt {
  try {
    const format = formatFromEndpoint(entry.endpoint)
    return { msgs: buildInboundMsgs(entry, format), aux: buildAux(entry) }
  } catch (err: unknown) {
    consola.warn(`[search-index] build failed for ${entry.id}; entry indexed empty`, err)
    return EMPTY_BUILT
  }
}

const INSERT_MSG_BLOB_SQL = `INSERT OR IGNORE INTO msg_blob (hash, text) VALUES (?, ?)`
const INSERT_REQ_MSG_SQL = `INSERT INTO req_msg (req_id, pos, hash) VALUES (?, ?, ?)`
const INSERT_REQ_AUX_SQL = `INSERT INTO req_aux (req_id, source, text) VALUES (?, ?, ?)`

/**
 * prev_req_id = the most-recent prior request in the same (session, agent) group.
 * Self-contained correlated subquery (no params beyond the row id): `IS` matches
 * NULL session/agent (main-agent) symmetrically, strict `<` excludes self.
 * O(1) via idx_entries_v2_session_agent; negligible inside the finalize tx (the
 * stage compression already dominates it), and atomic — no stale-read window vs a
 * separate tx-outside read. Best-effort: rows with NULL session_id all `IS`-match
 * each other (not a meaningful group) and a same-millisecond predecessor is missed
 * by strict `<` — acceptable since prev_req_id is decoupled from search.
 */
const UPDATE_PREV_REQ_ID_SQL = `
UPDATE entries_v2 SET prev_req_id = (
  SELECT e2.id FROM entries_v2 e2
  WHERE e2.session_id IS entries_v2.session_id
    AND e2.agent_id IS entries_v2.agent_id
    AND e2.started_at < entries_v2.started_at
  ORDER BY e2.started_at DESC LIMIT 1
) WHERE id = ?`

/**
 * Persist the built index for one request. MUST run inside the finalize tx
 * (atomic with head/stage). Idempotent: clears this request's prior req_msg /
 * req_aux first, so a re-finalization rebuilds cleanly. msg_blob uses
 * INSERT OR IGNORE (content-addressed, shared across requests — never deleted
 * here; the orphan GC reclaims unreferenced blobs).
 */
export function persistSearchIndex(db: Database, reqId: string, built: SearchIndexBuilt): void {
  db.prepare("DELETE FROM req_msg WHERE req_id = ?").run(reqId)
  db.prepare("DELETE FROM req_aux WHERE req_id = ?").run(reqId)

  const insertBlob = db.prepare(INSERT_MSG_BLOB_SQL)
  const insertReqMsg = db.prepare(INSERT_REQ_MSG_SQL)
  for (const msg of built.msgs) {
    insertBlob.run(msg.hash, msg.text)
    insertReqMsg.run(reqId, msg.pos, msg.hash)
  }

  const insertAux = db.prepare(INSERT_REQ_AUX_SQL)
  for (const aux of built.aux) insertAux.run(reqId, aux.source, aux.text)

  db.prepare(UPDATE_PREV_REQ_ID_SQL).run(reqId)
}
