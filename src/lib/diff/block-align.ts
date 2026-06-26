/**
 * Backend block-alignment core (ported from the live UI tree
 * `ui/src/utils/block-diff.ts`).
 *
 * Per the search_index design (docs/rfc/search-index-content-addressed.md): a mature
 * library (jsdiff) handles the algorithmically-hard LCS alignment; we add only
 * the DOMAIN pairing a generic diff lib cannot express — aligning two message
 * sequences by role, with in-place "modified" pairing of an adjacent
 * removed→added run. The single generic aligner (`alignWithModified`) is reused
 * by the message axis here and (in later phases) the SSE-frame axis, so there is
 * one source, not several drifting copies.
 *
 * Differences from the UI source (deliberate, for the index use-case):
 * - compact `JSON.stringify` (no pretty-print) — the serialized text feeds
 *   `delta_text` storage and LIKE scans, where whitespace bloat is pure cost.
 * - `\0` (NUL) separator between role and text in the alignment key — a space
 *   can false-merge `role` and `content` boundaries (the `ui-v4` copy already
 *   uses `\0`; the older `ui/` copy used a space).
 * - `alignMessages` is a NEW export returning per-row CHANGED TEXT (not the
 *   message objects) — the projection later phases store as rewrite delta text.
 *
 * Pure functions only; no rendering, no `applyPatch`.
 */

import { diffArrays } from "diff"

// ── Generic domain aligner ──

export type AlignKind = "same" | "added" | "removed" | "modified"

export interface AlignRowOf<T> {
  kind: AlignKind
  left?: T
  right?: T
}

/**
 * Align two sequences by `keyOf` (LCS via jsdiff), then pair an adjacent
 * removed→added run positionally when items share `groupOf` (e.g. role) to
 * surface in-place "modified" rather than separate remove+add. `keyOf` decides
 * equality (same vs changed); `groupOf` decides what counts as "the same slot".
 */
export function alignWithModified<T>(
  left: ReadonlyArray<T>,
  right: ReadonlyArray<T>,
  keyOf: (t: T) => string,
  groupOf: (t: T) => string,
): Array<AlignRowOf<T>> {
  const parts = diffArrays(left as Array<T>, right as Array<T>, { comparator: (l, r) => keyOf(l) === keyOf(r) })
  const rows: Array<AlignRowOf<T>> = []
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

// ── Message-list alignment ──

/**
 * Minimal structural message shape this aligner needs. History's `MessageContent`
 * satisfies it; kept local so the diff core stays decoupled from history types.
 */
export interface DiffMessage {
  role: string
  content: string | Array<unknown> | null
}

/** Stable, compact text projection of a message's content for equality + diff. */
export function messageText(m: DiffMessage): string {
  if (typeof m.content === "string") return m.content
  return JSON.stringify(m.content ?? null)
}

/** Alignment key: role and serialized content, NUL-separated to avoid false merges. */
function messageKey(m: DiffMessage): string {
  return `${m.role}\0${messageText(m)}`
}

/**
 * One aligned row between two message sequences, carrying the CHANGED TEXT on
 * each side rather than the message objects:
 * - `same`     — both present, identical text (`left` === `right`)
 * - `added`    — present only on the right (`right` set, `left` absent)
 * - `removed`  — present only on the left (`left` set, `right` absent)
 * - `modified` — same role, different text (both `left` and `right` set)
 */
export interface AlignRow {
  kind: AlignKind
  left?: string
  right?: string
}

/**
 * Align two message sequences (e.g. inbound vs effective, or attempt N vs N+1)
 * and project each row to its per-side serialized text. Callers extract the
 * changed rows (`added` / `removed` / `modified`) to derive rewrite delta text.
 */
export function alignMessages(left: ReadonlyArray<DiffMessage>, right: ReadonlyArray<DiffMessage>): Array<AlignRow> {
  return alignWithModified(left, right, messageKey, (m) => m.role).map((r) => {
    const row: AlignRow = { kind: r.kind }
    if (r.left !== undefined) row.left = messageText(r.left)
    if (r.right !== undefined) row.right = messageText(r.right)
    return row
  })
}
