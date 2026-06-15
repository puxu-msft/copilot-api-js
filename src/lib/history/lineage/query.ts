/**
 * Lineage query layer.
 *
 * Reads from `entry_lineage` + `entry_produced_tool_ids` (populated by the
 * write path in entries.ts:finalizeEntry + scripts/backfill-lineage.ts).
 *
 * See docs/rfc/request-lineage.md §5 for the query model.
 */

import type { LineageDigest } from "~/lib/history/lineage"

import {
  //
  LINEAGE_SCHEMA_VERSION,
  unpackTurnHashes,
} from "~/lib/history/lineage"
import { getDatabase } from "~/lib/history/sqlite/connection"

/** SQLite row shape for entry_lineage. */
interface LineageRow {
  entry_id: string
  schema_version: number
  root_hash: string
  turn_hashes_blob: Buffer
  post_response_hash: string | null
  back_tool_use_id: string | null
  computed_at: number
}

/** A neighbor entry in the lineage graph. */
export interface LineageNeighbor {
  id: string
  digest: LineageDigest
}

/** Parent entry, with the type of edge that links it to self. */
export interface LineageParent extends LineageNeighbor {
  /** `tool_id` — confirmed via O(1) tool_use_id reverse-link + hash verifier.
   *  `hash_only` — pure-text turn; identified via postResponseHash IN turnHashes scan. */
  edgeType: "tool_id" | "hash_only"
}

/** Child entry — same edge types as parent. */
export interface LineageChild extends LineageNeighbor {
  edgeType: "tool_id" | "hash_only"
}

/** Sibling kinds — see RFC §5.1.
 * - `fork` — both completed with different responses (two assistant branches).
 * - `retry_after_failure` — one of {self, sibling} has postResponseHash null.
 * - `retry_duplicate` — same turnHashes AND identical postResponseHash. */
export type SiblingKind = "fork" | "retry_after_failure" | "retry_duplicate"

export interface LineageSibling extends LineageNeighbor {
  kind: SiblingKind
}

export interface RootSummary {
  rootHash: string
  count: number
  earliestAt: number
  latestAt: number
}

export interface LineageResponse {
  entryId: string
  digest: LineageDigest | null
  parent: LineageParent | null
  children: Array<LineageChild>
  siblings: Array<LineageSibling>
  rootSummary: RootSummary | null
}

function rowToDigest(row: LineageRow): LineageDigest {
  return {
    v: row.schema_version as typeof LINEAGE_SCHEMA_VERSION,
    rootHash: row.root_hash,
    turnHashes: unpackTurnHashes(row.turn_hashes_blob),
    postResponseHash: row.post_response_hash,
    producedToolUseIds: loadProducedToolIds(row.entry_id),
    backToolUseId: row.back_tool_use_id,
    computedAt: row.computed_at,
  }
}

function loadProducedToolIds(entryId: string): Array<string> {
  const db = getDatabase()
  const rows = db.prepare("SELECT tool_use_id FROM entry_produced_tool_ids WHERE entry_id = ?").all(entryId) as Array<{ tool_use_id: string }>
  return rows.map((r) => r.tool_use_id)
}

function loadDigest(entryId: string): LineageDigest | null {
  const db = getDatabase()
  const row = db.prepare("SELECT * FROM entry_lineage WHERE entry_id = ?").get(entryId) as LineageRow | undefined
  if (!row) return null
  return rowToDigest(row)
}

/**
 * Locate the parent entry. Primary path: O(1) lookup via
 * `entry_produced_tool_ids.tool_use_id == self.backToolUseId`, then verify
 * `candidate.postResponseHash === self.turnHashes[candidate.turnHashes.length]`
 * (positional check — proves the candidate's response landed at the expected
 * slot in self's chain). Fallback path: pure-text turns scan within the same
 * rootHash for any digest whose postResponseHash appears in self.turnHashes.
 */
function findParent(self: LineageDigest, selfId: string): LineageParent | null {
  const db = getDatabase()

  // PRIMARY: tool-id reverse-link
  if (self.backToolUseId) {
    const row = db.prepare("SELECT entry_id FROM entry_produced_tool_ids WHERE tool_use_id = ?").get(self.backToolUseId) as { entry_id: string } | undefined
    if (row) {
      const candidate = loadDigest(row.entry_id)
      const offset = candidate?.turnHashes.length ?? -1
      if (candidate?.postResponseHash && offset >= 0 && offset < self.turnHashes.length && self.turnHashes[offset] === candidate.postResponseHash) {
        return { id: row.entry_id, digest: candidate, edgeType: "tool_id" }
      }
    }
  }

  // FALLBACK: hash-only scan within same root
  if (self.turnHashes.length === 0) return null
  const placeholders = self.turnHashes.map(() => "?").join(",")
  const hits = db
    .prepare(
      `SELECT entry_id, post_response_hash FROM entry_lineage
        WHERE post_response_hash IN (${placeholders})
          AND root_hash = ?
          AND entry_id != ?
        ORDER BY computed_at DESC
        LIMIT 25`,
    )
    .all(...self.turnHashes, self.rootHash, selfId) as Array<{ entry_id: string; post_response_hash: string }>

  // Pick the deepest positional match — the candidate whose postResponseHash
  // appears at the LARGEST offset in self.turnHashes (the most-recent parent
  // in the chain).
  let best: { id: string; digest: LineageDigest; offset: number } | null = null
  for (const hit of hits) {
    const candidate = loadDigest(hit.entry_id)
    if (!candidate || candidate.postResponseHash === null) continue
    const offset = candidate.turnHashes.length
    if (offset >= 0 && offset < self.turnHashes.length && self.turnHashes[offset] === candidate.postResponseHash && (best === null || offset > best.offset)) {
      best = { id: hit.entry_id, digest: candidate, offset }
    }
  }
  if (!best) return null
  return { id: best.id, digest: best.digest, edgeType: "hash_only" }
}

/**
 * Locate children of `parentId`. Primary path: for each tool_use_id this
 * entry produced, find entries whose `back_tool_use_id` matches AND whose
 * `turnHashes[parent.turnHashes.length] == parent.postResponseHash`.
 * Fallback path: pure-text-tail entries within the same root whose
 * turnHashes at the expected offset match parent.postResponseHash.
 */
function findChildren(parentId: string, parent: LineageDigest): Array<LineageChild> {
  const db = getDatabase()
  const out: Map<string, LineageChild> = new Map()
  const parentOffset = parent.turnHashes.length
  if (parent.postResponseHash === null) return [] // failed entries cannot have children

  // PRIMARY: tool-id reverse-link
  for (const toolUseId of parent.producedToolUseIds) {
    const hits = db.prepare("SELECT entry_id FROM entry_lineage WHERE back_tool_use_id = ?").all(toolUseId) as Array<{ entry_id: string }>
    for (const hit of hits) {
      if (hit.entry_id === parentId) continue
      const candidate = loadDigest(hit.entry_id)
      if (candidate && parentOffset < candidate.turnHashes.length && candidate.turnHashes[parentOffset] === parent.postResponseHash) {
        out.set(hit.entry_id, { id: hit.entry_id, digest: candidate, edgeType: "tool_id" })
      }
    }
  }

  // FALLBACK: hash-only — entries in same root with no back_tool_use_id
  // whose turnHashes[parentOffset] equals parent.postResponseHash.
  // Bounded by root size; the activity-detail UI cares about hundreds, not millions.
  const candidates = db
    .prepare(
      `SELECT entry_id FROM entry_lineage
        WHERE root_hash = ?
          AND back_tool_use_id IS NULL
          AND entry_id != ?`,
    )
    .all(parent.rootHash, parentId) as Array<{ entry_id: string }>
  for (const c of candidates) {
    if (out.has(c.entry_id)) continue
    const candidate = loadDigest(c.entry_id)
    if (candidate && parentOffset < candidate.turnHashes.length && candidate.turnHashes[parentOffset] === parent.postResponseHash) {
      out.set(c.entry_id, { id: c.entry_id, digest: candidate, edgeType: "hash_only" })
    }
  }

  return [...out.values()]
}

function classifySibling(selfDigest: LineageDigest, siblingDigest: LineageDigest): SiblingKind {
  if (selfDigest.postResponseHash === null || siblingDigest.postResponseHash === null) {
    return "retry_after_failure"
  }
  if (selfDigest.postResponseHash === siblingDigest.postResponseHash) {
    return "retry_duplicate"
  }
  return "fork"
}

function loadRootSummary(rootHash: string): RootSummary | null {
  const db = getDatabase()
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(e.started_at) AS e_at, MAX(e.started_at) AS l_at
         FROM entry_lineage el
         JOIN entries_v2 e ON e.id = el.entry_id
        WHERE el.root_hash = ?`,
    )
    .get(rootHash) as { n: number; e_at: number | null; l_at: number | null }
  if (row.n === 0 || row.e_at === null || row.l_at === null) return null
  return { rootHash, count: row.n, earliestAt: row.e_at, latestAt: row.l_at }
}

/**
 * One row in the conversations list — aggregated per `rootHash`.
 *
 * Built from `entry_lineage JOIN entries_v2`, so non-Anthropic / pre-backfill
 * entries (no lineage row) are excluded. Token totals come from entries_v2's
 * pre-projected `input_tokens` / `output_tokens` columns (no stage-row scan).
 */
export interface ConversationSummary {
  rootHash: string
  count: number
  earliestAt: number
  latestAt: number
  firstEntryId: string
  lastEntryId: string
  models: Array<string>
  totalInputTokens: number
  totalOutputTokens: number
}

export interface ConversationsListOptions {
  /** Page size; default 50. */
  limit?: number
  /** Opaque cursor; max-`latestAt` of last batch. */
  cursor?: string
}

export interface ConversationsListResult {
  conversations: Array<ConversationSummary>
  cursor?: string
}

interface ConversationRow {
  root_hash: string
  count: number
  earliest_at: number
  latest_at: number
  first_entry_id: string
  last_entry_id: string
  total_input_tokens: number | null
  total_output_tokens: number | null
}

interface ConversationModelRow {
  root_hash: string
  model: string
}

/**
 * List conversation roots (rootHash-clustered entries), newest activity first.
 *
 * For UI sidebars / "all my conversations" views. One query for the
 * aggregates + one for the per-root distinct model list (avoids GROUP_CONCAT
 * ordering ambiguities); results joined in memory by rootHash.
 *
 * Pagination uses a composite cursor `<latestAt>:<rootHash>` to handle
 * ties cleanly — when two roots share `latestAt` (likely in fast tests
 * or bursty traffic) a strict `<` cursor on `latestAt` alone would drop
 * one of them.
 */
export function listConversations(opts: ConversationsListOptions = {}): ConversationsListResult {
  const db = getDatabase()
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500))

  let cursorAt: number | null = null
  let cursorRootHash: string | null = null
  if (opts.cursor) {
    const colon = opts.cursor.indexOf(":")
    if (colon > 0) {
      cursorAt = Number.parseInt(opts.cursor.slice(0, colon), 10)
      cursorRootHash = opts.cursor.slice(colon + 1)
      if (!Number.isFinite(cursorAt)) {
        cursorAt = null
        cursorRootHash = null
      }
    }
  }
  const havingClause = cursorAt !== null && cursorRootHash !== null ? "HAVING latest_at < ? OR (latest_at = ? AND root_hash < ?)" : ""

  // Aggregate roots. first_entry_id / last_entry_id picked via correlated
  // ORDER BY trick on the projected MIN/MAX timestamp — SQLite returns
  // the row with the matching min/max within the group.
  const aggSql = `
    SELECT
      el.root_hash AS root_hash,
      COUNT(*) AS count,
      MIN(e.started_at) AS earliest_at,
      MAX(e.started_at) AS latest_at,
      (SELECT inner_e.id FROM entry_lineage inner_el
         JOIN entries_v2 inner_e ON inner_e.id = inner_el.entry_id
        WHERE inner_el.root_hash = el.root_hash
        ORDER BY inner_e.started_at ASC LIMIT 1) AS first_entry_id,
      (SELECT inner_e.id FROM entry_lineage inner_el
         JOIN entries_v2 inner_e ON inner_e.id = inner_el.entry_id
        WHERE inner_el.root_hash = el.root_hash
        ORDER BY inner_e.started_at DESC LIMIT 1) AS last_entry_id,
      SUM(e.input_tokens) AS total_input_tokens,
      SUM(e.output_tokens) AS total_output_tokens
    FROM entry_lineage el
    JOIN entries_v2 e ON e.id = el.entry_id
    GROUP BY el.root_hash
    ${havingClause}
    ORDER BY latest_at DESC, root_hash DESC
    LIMIT ?
  `
  const params: Array<number | string> = cursorAt !== null && cursorRootHash !== null ? [cursorAt, cursorAt, cursorRootHash, limit] : [limit]
  const aggRows = db.prepare(aggSql).all(...params) as Array<ConversationRow>

  if (aggRows.length === 0) return { conversations: [] }

  // Distinct models per root, scoped to the page we just fetched.
  const rootHashes = aggRows.map((r) => r.root_hash)
  const placeholders = rootHashes.map(() => "?").join(",")
  const modelRows = db
    .prepare(
      `SELECT DISTINCT el.root_hash, e.model
         FROM entry_lineage el
         JOIN entries_v2 e ON e.id = el.entry_id
        WHERE el.root_hash IN (${placeholders}) AND e.model IS NOT NULL
        ORDER BY el.root_hash, e.model`,
    )
    .all(...rootHashes) as Array<ConversationModelRow>

  const modelsByRoot = new Map<string, Array<string>>()
  for (const r of modelRows) {
    const existing = modelsByRoot.get(r.root_hash) ?? []
    existing.push(r.model)
    modelsByRoot.set(r.root_hash, existing)
  }

  const conversations: Array<ConversationSummary> = aggRows.map((r) => ({
    rootHash: r.root_hash,
    count: r.count,
    earliestAt: r.earliest_at,
    latestAt: r.latest_at,
    firstEntryId: r.first_entry_id,
    lastEntryId: r.last_entry_id,
    models: modelsByRoot.get(r.root_hash) ?? [],
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
  }))

  const last = aggRows.at(-1)
  const cursor = aggRows.length === limit && last ? `${last.latest_at}:${last.root_hash}` : undefined
  return cursor === undefined ? { conversations } : { conversations, cursor }
}

/** Top-level entry point — see LineageResponse. */
export function getLineage(entryId: string): LineageResponse {
  const self = loadDigest(entryId)
  if (!self) {
    return { entryId, digest: null, parent: null, children: [], siblings: [], rootSummary: null }
  }

  const parent = findParent(self, entryId)
  const children = findChildren(entryId, self)

  let siblings: Array<LineageSibling> = []
  if (parent) {
    const parentChildren = findChildren(parent.id, parent.digest)
    siblings = parentChildren.filter((c) => c.id !== entryId).map((c) => ({ id: c.id, digest: c.digest, kind: classifySibling(self, c.digest) }))
  }

  return {
    entryId,
    digest: self,
    parent,
    children,
    siblings,
    rootSummary: loadRootSummary(self.rootHash),
  }
}
