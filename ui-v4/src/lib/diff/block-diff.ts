/**
 * Layered, domain-aware block diff.
 *
 * Per the design (see plan §2b-diff): a mature library (jsdiff) handles the
 * algorithmically-hard LEAF text/word diff (L3); we build only the DOMAIN
 * alignment a generic diff lib cannot express — aligning by message role / SSE
 * frame type, with in-place "modified" pairing. One generic aligner backs both
 * the message-list axis (rewrite + attempt-to-attempt) and the SSE-frame axis
 * (upstream vs forwarded), so there is a single source, not three drifting ones.
 *
 * Pure functions only; rendering (theme highlight) lives in the components.
 */

import {
  //
  diffArrays,
  diffLines,
  diffWordsWithSpace,
} from "diff"

import type { MessageContent } from "@/lib/content/types"
import type { SseEventRecord } from "@/types"

// ── L3: leaf word/char diff (jsdiff) ──

export interface InlineDiffPart {
  value: string
  added?: boolean
  removed?: boolean
}

/** Word-level inline diff of two strings (significant/insignificant handled by jsdiff). */
export function diffText(a: string, b: string): Array<InlineDiffPart> {
  return diffWordsWithSpace(a, b).map((c) => ({ value: c.value, added: c.added, removed: c.removed }))
}

// ── Rich unified line+word diff (for the diff modal) ──

export interface DiffLineRow {
  kind: "same" | "add" | "del"
  /** Plain line text (used for same / lone add|del). */
  text: string
  /** 1-based line number on the original (old) side; undefined for added lines. */
  oldNo?: number
  /** 1-based line number on the effective (new) side; undefined for removed lines. */
  newNo?: number
  /** Word-level parts (only for paired del→add lines) — highlights the changed words. */
  words?: Array<InlineDiffPart>
}

/**
 * Git-style unified diff: line-level via jsdiff `diffLines`, with intra-line
 * word-level highlighting when a removed run is immediately followed by an added
 * run (the common "this line changed" case). Carries old/new line numbers for a
 * gutter. Powers the diff modal's unified view.
 */
export function diffLinesRich(a: string, b: string): Array<DiffLineRow> {
  const splitLines = (v: string) => v.replace(/\n$/, "").split("\n")
  const chunks = diffLines(a, b)
  const rows: Array<DiffLineRow> = []
  let oldNo = 0
  let newNo = 0
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]
    if (!c.added && !c.removed) {
      for (const line of splitLines(c.value)) rows.push({ kind: "same", text: line, oldNo: ++oldNo, newNo: ++newNo })
      continue
    }
    const next = i + 1 < chunks.length ? chunks[i + 1] : undefined
    if (c.removed && next?.added) {
      // Paired change: word-diff line-by-line so changed words highlight inline.
      const del = splitLines(c.value)
      const add = splitLines(next.value)
      const n = Math.max(del.length, add.length)
      for (let j = 0; j < n; j++) {
        const dl = j < del.length ? del[j] : undefined
        const al = j < add.length ? add[j] : undefined
        if (dl !== undefined && al !== undefined && dl === al) {
          // Identical line within the paired run → not a real change.
          rows.push({ kind: "same", text: dl, oldNo: ++oldNo, newNo: ++newNo })
          continue
        }
        if (dl !== undefined)
          rows.push({ kind: "del", text: dl, oldNo: ++oldNo, words: al !== undefined ? diffText(dl, al).filter((p) => !p.added) : undefined })
        if (al !== undefined)
          rows.push({ kind: "add", text: al, newNo: ++newNo, words: dl !== undefined ? diffText(dl, al).filter((p) => !p.removed) : undefined })
      }
      i++ // consumed the paired added chunk
      continue
    }
    if (c.removed) for (const line of splitLines(c.value)) rows.push({ kind: "del", text: line, oldNo: ++oldNo })
    else for (const line of splitLines(c.value)) rows.push({ kind: "add", text: line, newNo: ++newNo })
  }
  return rows
}

// ── Generic domain aligner (L1 / L2 / L4 share this) ──

export type AlignKind = "same" | "added" | "removed" | "modified"

/**
 * A per-message rewrite marker derived from an aligned diff row, used to visually
 * distinguish messages changed by the inbound→effective rewrites. `"same"` rows
 * carry no mark (undefined); only the three change kinds are surfaced.
 */
export type RewriteMark = "modified" | "added" | "removed"

export interface AlignRow<T> {
  kind: AlignKind
  left?: T
  right?: T
}

/**
 * Align two sequences by `keyOf` (LCS via jsdiff), then pair an adjacent
 * removed→added run positionally when items share `groupOf` (role / frame type)
 * to surface in-place "modified" rather than remove+add. `keyOf` decides
 * equality (same vs changed); `groupOf` decides what counts as "the same slot".
 */
export function alignWithModified<T>(left: ReadonlyArray<T>, right: ReadonlyArray<T>, keyOf: (t: T) => string, groupOf: (t: T) => string): Array<AlignRow<T>> {
  const parts = diffArrays(left as Array<T>, right as Array<T>, { comparator: (l, r) => keyOf(l) === keyOf(r) })
  const rows: Array<AlignRow<T>> = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p.added && !p.removed) {
      for (const v of p.value) rows.push({ kind: "same", left: v, right: v })
      continue
    }
    const next = i + 1 < parts.length ? parts[i + 1] : undefined
    if (p.removed && next?.added) {
      const rem = p.value
      const add = next.value
      const n = Math.min(rem.length, add.length)
      let paired = 0
      while (paired < n && groupOf(rem[paired]) === groupOf(add[paired])) {
        rows.push({ kind: "modified", left: rem[paired], right: add[paired] })
        paired++
      }
      for (let j = paired; j < rem.length; j++) rows.push({ kind: "removed", left: rem[j] })
      for (let j = paired; j < add.length; j++) rows.push({ kind: "added", right: add[j] })
      i++ // consumed the paired `added` run
      continue
    }
    if (p.removed) for (const v of p.value) rows.push({ kind: "removed", left: v })
    else for (const v of p.value) rows.push({ kind: "added", right: v })
  }
  return rows
}

// ── L1: message-list diff (rewrite axis + attempt-to-attempt) ──

/** Stable text projection of a message's content for equality + leaf diff. */
export function messageText(m: MessageContent): string {
  if (typeof m.content === "string") return m.content
  return JSON.stringify(m.content ?? null, null, 2)
}

function messageKey(m: MessageContent): string {
  return `${m.role}\0${messageText(m)}`
}

export interface MessageDiffRow {
  kind: AlignKind
  left?: MessageContent
  right?: MessageContent
  role?: string
  /** Inline word diff of the serialized content (only for `modified`). */
  textDiff?: Array<InlineDiffPart>
}

export function diffMessageList(left: ReadonlyArray<MessageContent>, right: ReadonlyArray<MessageContent>): Array<MessageDiffRow> {
  return alignWithModified(left, right, messageKey, (m) => m.role).map((r) => {
    const role = (r.right ?? r.left)?.role
    const row: MessageDiffRow = { kind: r.kind, left: r.left, right: r.right, role }
    if (r.kind === "modified" && r.left && r.right) row.textDiff = diffText(messageText(r.left), messageText(r.right))
    return row
  })
}

/** Counts for a compact "+a −r ~m" summary chip. */
export function diffStats(rows: ReadonlyArray<{ kind: AlignKind }>): { added: number; removed: number; modified: number; same: number } {
  const s = { added: 0, removed: 0, modified: 0, same: 0 }
  for (const r of rows) s[r.kind]++
  return s
}

// ── L4: SSE frame diff (upstream vs forwarded) ──

export type FrameDiffKind = AlignKind

export interface FrameDiffRow {
  kind: FrameDiffKind
  upstream?: SseEventRecord
  forwarded?: SseEventRecord
  type?: string
  /** Inline diff of the raw frame payload (only for `modified`/rewritten). */
  rawDiff?: Array<InlineDiffPart>
}

function frameKey(f: SseEventRecord): string {
  return `${f.type}\0${canonicalRaw(f.raw)}`
}

/**
 * Stable byte-form of an SSE frame's `raw`: parse JSON and re-stringify with keys
 * sorted, so semantically-equal frames whose producers emit keys in a different
 * order (Anthropic upstream `{"delta",…,"type"}` vs forwarded `{"type",…,"delta"}`)
 * compare equal. Non-JSON payloads (keepalive/ping) round-trip verbatim.
 */
function canonicalRaw(raw: string): string {
  try {
    return JSON.stringify(sortKeys(JSON.parse(raw)))
  } catch {
    return raw
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => sortKeys(x))
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    )
  }
  return v
}

/**
 * Coalesce consecutive `content_block_delta` frames that share an `index` AND a
 * concatenable subtype into one synthetic frame carrying the joined value.
 * Upstream and the forwarded stream chunk text at different boundaries (29 vs 27
 * deltas for the same total), so per-chunk raw never aligns; merging by block
 * makes equal total content compare equal. Only `text_delta` / `input_json_delta`
 * / `thinking_delta` merge (the streamed-in-pieces fields); `signature_delta` and
 * other one-shot subtypes never merge, so an in-place signature rewrite stays a
 * visible `modified`. Frame `offsetMs` keeps the first chunk's; only the diff
 * input is coalesced — FrameList still shows raw per-chunk frames.
 */
function coalesceDeltas(frames: ReadonlyArray<SseEventRecord>): Array<SseEventRecord> {
  const out: Array<SseEventRecord> = []
  for (const f of frames) {
    const cur = deltaMerge(f)
    const prev = out.at(-1)
    if (cur && prev && prev.type === "content_block_delta") {
      const p = deltaMerge(prev)
      if (p && p.index === cur.index && p.field === cur.field) {
        out[out.length - 1] = { ...prev, raw: mergeDeltaRaw(prev.raw, f.raw, cur.field) }
        continue
      }
    }
    out.push(f)
  }
  return out
}

/** Concatenable fields of a streamed content_block_delta (one-shot subtypes excluded). */
const MERGE_FIELDS: Record<string, string> = { text_delta: "text", input_json_delta: "partial_json", thinking_delta: "thinking" }

/** Block index + concatenable field of a delta frame, or null if not coalescable. */
function deltaMerge(f: SseEventRecord): { index: number; field: string } | null {
  if (f.type !== "content_block_delta") return null
  try {
    const j = JSON.parse(f.raw) as { index?: unknown; delta?: { type?: string } }
    const field = MERGE_FIELDS[j.delta?.type ?? ""]
    return typeof j.index === "number" && field ? { index: j.index, field } : null
  } catch {
    return null
  }
}

/** Merge two content_block_delta raws by concatenating the given field's text. */
function mergeDeltaRaw(a: string, b: string, field: string): string {
  try {
    const ja = JSON.parse(a) as { delta?: Record<string, string> }
    const jb = JSON.parse(b) as { delta?: Record<string, string> }
    const da = ja.delta ?? {}
    da[field] = (da[field] ?? "") + (jb.delta?.[field] ?? "")
    return JSON.stringify(ja)
  } catch {
    return a
  }
}

/**
 * Align upstream SSE frames against the frames actually forwarded to the client.
 * `modified` = a frame rewritten in place (e.g. thinking-signature shim); the
 * `dropped` (removed) / `added` kinds catch filtered or synthesized frames.
 */
export function diffSseFrames(upstream: ReadonlyArray<SseEventRecord>, forwarded: ReadonlyArray<SseEventRecord>): Array<FrameDiffRow> {
  return alignWithModified(coalesceDeltas(upstream), coalesceDeltas(forwarded), frameKey, (f) => f.type).map((r) => {
    const type = (r.right ?? r.left)?.type
    const row: FrameDiffRow = { kind: r.kind, upstream: r.left, forwarded: r.right, type }
    if (r.kind === "modified" && r.left && r.right) row.rawDiff = diffText(canonicalRaw(r.left.raw), canonicalRaw(r.right.raw))
    return row
  })
}
