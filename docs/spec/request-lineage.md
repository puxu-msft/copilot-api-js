# RFC: Request Lineage — Cross-Request Conversation Reconstruction

> **⚠️ DEPRECATED / 已废弃（2026-06-23）**：lineage 子系统已整体删除——内容哈希重建对话树在实测中零聚类（rootHash 含每轮漂移的 system[0]），仅 anthropic 路径、UI 零消费、codex 已有 `previous_response_id`。`lineage/*` 模块、`entry_lineage`/`entry_produced_tool_ids` 表、`/lineage`·`/conversations` REST 全部删除（commit `eacae48`/`3128b9b`/`cd54f21`）。本文仅作历史设计记录保留。后继方向是持久运营 stats，见 [operational-stats-and-lineage-removal.md](operational-stats-and-lineage-removal.md)。

**Status:** v3.1 — round-3 verification PASS; only spec-type and prose polish items remained from v3 and have been applied. Consensus reached across 3 adversarial review rounds.
**Author:** ECC, grounded in empirical probes of live history at `localhost:4141` on 2026-06-15.
**Driver:** No reliable way today to answer *"which earlier request did this one descend from?"* — `sessionId` covers only Responses-API chains and clients that send `x-session-id` headers (neither Claude Code nor the typical Anthropic-shaped clients do). History UI cannot show a conversation tree, debugging tool-call regressions across turns is manual, and there is no infrastructure to compute *"this request is a retry/fork/continuation of that one."*
**Scope:** Add a content-addressed lineage layer over `inboundRequest.messages` + `outboundResponse.content`, validated empirically. Persist a small per-entry digest **plus an indexed tool_use_id reverse-link table** for O(1) parent lookup. Expose `GET /history/api/entries/:id/lineage`. No behavior change to request handling; pure observability augmentation.

---

## 1. Problem statement

### 1.1 Today

| Mechanism | Coverage | Reliability |
|---|---|---|
| `x-session-id` / `x-conversation-id` headers ([sessions.ts:30](../../src/lib/history/sessions.ts#L30)) | Clients that opt-in | Strong when present — but Claude Code, OpenAI SDKs, and most Anthropic clients do not send these |
| `previous_response_id` chain ([handler.ts:167](../../src/routes/responses/handler.ts#L167)) | OpenAI Responses API only | Strong; built into the protocol |
| `previous_response_id` → `session_id` registration ([sessions.ts:47-65](../../src/lib/history/sessions.ts#L47)) | Responses API | Indirect — needs `registerResponseSession` to have fired earlier |

For the **dominant traffic** (Anthropic `/v1/messages` from Claude Code), `entry.sessionId` is **null** for every entry — empirically confirmed by `curl /history/api/entries?limit=200 | jq '.entries[].sessionId'` showing `null` on all 200 sampled rows.

### 1.2 Why this matters

- **History UI** cannot show "which earlier request led to this one" / "which other requests share this conversation with the current one" — the activity-detail RFC ([activity-detail-main-outline.md](activity-detail-main-outline.md)) lists this as a deferred capability.
- **Debugging** cross-turn regressions (tool_use_id mismatch, signature drift, system-reminder rewrites) requires manual `jq` scripting against `inboundRequest.messages`.
- **Forking** (retry vs. parallel tool-call branches) cannot be visualized at all.
- **Statistics** like "average turns per conversation" / "median conversation token growth" are impossible to compute.

### 1.3 What we already have that helps

- `inboundRequest.messages[]` is the **client's full echoed conversation** — stored verbatim in the `entry_stages` table under `stage='inbound_request'`. This is the lineage source of truth: every request a client makes embeds its memory of all prior turns.
- `outboundResponse.content` is the **server's assistant message** (always reconstructed by `buildAnthropicResponseData` for both streaming and non-streaming, per [recording.ts:97](../../src/lib/request/recording.ts#L97)) — the assistant message a future request will echo as `messages[len + 1]`. *(v1 incorrectly cited `inboundResponse.message`; that field does not exist — `inboundResponse` only carries `sseEvents`.)*
- `tool_use.id`s in that assistant message are upstream-minted 16-byte random nonces; when a successor sends a `tool_result.tool_use_id` referencing one of them, it is a **cryptographic-grade parent edge** with no canonicalization heuristics needed.
- `entry_stages` is content-addressed (one row per stage, gzip-compressed) and already cheap to extend with sibling tables.

---

## 2. Empirical findings (probe results, 2026-06-15)

All numbers are from probes against the local backend's `/history/api/entries/:id` endpoint. Scripts saved at `/tmp/lineage-probe*.sh`.

### 2.1 The prefix-match hypothesis holds — after canonicalization

Tested 8 consecutive Anthropic turns from one Claude Code conversation (`req_1781546294306_1898` → `req_1781546475541_1906`), message counts 1 → 17.

**Hypothesis:** if request *B* is the next turn after *A*, then `B.messages[0:A.messages.length]` should be byte-identical to `A.messages` after canonicalization.

**Result without canonicalization: 0/8 match.** Diff shows `cache_control: { type: "ephemeral" }` added to the last user message at send time and absent once that message becomes prefix.

**Result after stripping `cache_control` everywhere: 8/8 prefix-match.**

**Stronger validation: a 681-msg Claude Code conversation byte-matches across pairs.** Tested `(req_1891 mc=673) → (req_1892 mc=675) → (req_1893 mc=677) → (req_1894 mc=679) → (req_1895 mc=681)`: **0/679 message-position mismatches on all pairs after `cache_control` strip**. Even though Claude Code injects `<system-reminder>` tags inside tool_result strings (71 occurrences in one entry, 33 unique), they are **echoed verbatim across turns** — they do not drift.

### 2.2 But msg[0] alone is not unique

100 entries clustered by canonicalized `messages[0]` hash:

| Cluster | Count | Note |
|---|---|---|
| `5d60c9b2afc3` | 57 | Long conversation (msg counts 569–681) |
| `b1d3b44c0062` | 24 | Different long conversation (msg counts 561–567) |
| `72f84ec70883` | 17 | Yet another |
| `41bb4e82f3cb` | 1 | One-off |
| `2c6a1dba42a8` | 1 | One-off |

Clusters 1 and 2 share msg[1] hash but had different msg[0] hashes before reminder stripping. Reason: msg[0] contains a `<system-reminder>` text block that Claude Code injects **per-turn** with currentDate, MEMORY.md contents, and "TodoWrite hasn't been used" nudges.

**After also stripping `<system-reminder>` text blocks from `messages[].content[]`:** msg[0] hash unifies across all 3 sampled entries of cluster 1 → `3d6c3bffa4f3`. Cluster 1 and 2 collapse to the same first-turn hash — meaning **rootHash from msg[0] alone over-clusters** (false-merge across distinct conversations).

**v2 mitigation:** fold `sha256(canonical(system))` and `sha256(canonical(tools))` into `rootHash`. The `system` prompt is ~30 KB and per-agent stable; `tools` is per-agent stable. Both discriminate across agents/conversations without bloating per-turn hashes.

### 2.3 tool_use_id reverse-link is the *dominant* backbone signal in Claude Code traffic

Probed all 200 sampled entries:
- **104 completed multi-message entries**
- **103 of them (99%) have a `tool_result` block in `messages[-1]`** — i.e., the tail of a successor request points back at the parent's `tool_use.id`.
- The 1 outlier (`req_1781546447046_1904`) is a pure-text user reply mid-conversation (the current discussion's "可以写，写完多轮…" turn).

`tool_use.id` is a 128-bit random nonce; the reverse-link is cryptographic-strength. **This is the right primary index for parent lookup**, with the canonical hash chain as the verifier for the rare tool-free turn and as the forward-prefix oracle.

### 2.4 What canonicalization must do

| Strip / normalize | Why | Risk if skipped |
|---|---|---|
| `cache_control` field everywhere | Migrates forward each turn | 100% miss rate |
| `<system-reminder>` text blocks in `messages[].content[].text` (whole-block, `startsWith("<system-reminder>") && endsWith("</system-reminder>")` with trailing-whitespace tolerance) | Injected per-turn with drifting clock/state at top level | Cross-conversation collisions; intra-conversation drift |
| Image `source.data` → `sha256(source.data)` digest substitution | Base64 strings can be hundreds of KB; cumulative hash would touch them O(N) times per turn (a 50-turn convo with 5 images = ~250 MB hashed/request) | Perf regression; correctness OK |
| Fold `sha256(canonical(system))` + `sha256(canonical(tools))` into `rootHash` (NOT into per-turn hashes) | msg[0] alone collides across distinct conversations (§2.2) | False-cluster across agents |
| Tool_result whitespace trim | Trailing-newline variation between client SDKs | Low — defer to v1.1 calibration if a real drift case is found |
| Embedded `<system-reminder>` *inside* tool_result strings | **Empirically stable** across adjacent turns in Claude Code (0/679 mismatches on long-conversation pair) — don't strip in v1; revisit if cross-client drift surfaces | Low risk in current traffic |

The canonicalization is a **lineage-only** transformation; the stored `inboundRequest` is untouched (principle 7).

### 2.5 Things that do NOT need stripping from per-turn hashes

- `system` top-level prompt — folded into `rootHash` only (§2.4).
- `tools[]` — folded into `rootHash` only.
- `messages[].content[].cache_control`-stripped `tool_use.input` JSON — conversation-unique IDs increase discrimination.
- thinking-block signatures — per [[thinking-signature-self-contained]], signatures are stable across context; clients echo them verbatim.

---

## 3. Proposed mechanism

### 3.1 Lineage digest

```typescript
interface LineageDigest {
  /** Schema version of the canonicalization rules. Bump on rule changes for safe re-derivation. */
  v: 1
  /** SHA-256 of (sha256(canonical(system)) || sha256(canonical(tools)) || sha256(canonical(messages[0]))). Coarse partition. */
  rootHash: string          // 64-hex
  /** SHA-256 of canonical messages[0..i] for each i in [0, len). Cumulative Merkle; length = messageCount. */
  turnHashes: Array<string> // each 64-hex
  /**
   * SHA-256 of canonical (messages ++ [assistantResponse]). The hash a *successor* request will
   * produce as `turnHashes[len]`. Computed at finalizeEntry from outboundResponse.content.
   * NULL if entry is failed/interrupted (no usable assistant message → cannot be a parent in the lineage).
   */
  postResponseHash: string | null
  /** All tool_use ids emitted in the assistant response. Successors that send tool_result with these ids link back. */
  producedToolUseIds: Array<string>
  /** Tool_use_id of the FIRST tool_result block in messages[-1], if any. This entry's primary "back-edge to parent." */
  backToolUseId: string | null
  /** Computed-at timestamp (ms). */
  computedAt: number
}
```

### 3.2 Parent identification (two-source: tool-id index + hash verifier)

**Primary (O(1) indexed):** `B.backToolUseId` is non-null and identifies entry *A* via `entry_produced_tool_ids` table. *A* is *B*'s parent candidate.

**Verifier:** confirm `B.turnHashes[A.turnHashes.length] == A.postResponseHash`. This single hex-string compare proves `B.messages[0..A.turnHashes.length]` deep-equals `A.messages ++ [assistantResponse]` (cumulative SHA-256 with byte-canonical input is collision-resistant for our scale).

**Fallback (when `backToolUseId` is null — pure-text turns, ~1% of completed traffic):** scan candidate parents within the same `rootHash` whose `postResponseHash` appears anywhere in `B.turnHashes`. Indexed by `post_response_hash` column, so still cheap.

If verification fails (extremely improbable; would indicate a tool-id collision or a hash bug), the parent is rejected and the fallback path runs.

### 3.3 Canonicalization rules (v1)

```typescript
// observability/lineage/canonicalize.ts
function canonicalizeMessages(messages: Array<MessageParam>): Array<MessageParam> {
  return messages.map(canonicalizeMessage)
}

function canonicalizeMessage(msg: MessageParam): MessageParam {
  if (typeof msg.content === "string") return { role: msg.role, content: msg.content }
  const content = msg.content
    .map(stripCacheControlDeep)
    .map(substituteImageDataDigest)
    .filter((b) => !isSystemReminderTextBlock(b))
  return { role: msg.role, content }
}

function stripCacheControlDeep<T>(obj: T): T {
  // structuredClone preserves Uint8Array / Buffer semantics that JSON.parse(JSON.stringify) drops;
  // walk and delete cache_control after clone.
  const cloned = structuredClone(obj)
  walkObject(cloned, (node) => {
    if (node && typeof node === "object" && "cache_control" in node) {
      delete (node as Record<string, unknown>).cache_control
    }
  })
  return cloned
}

/**
 * Generic in-order tree walk; visits each object/array/scalar exactly once.
 * Anthropic message payloads are derived from JSON.parse and therefore acyclic;
 * this helper does NOT guard against cycles. If a future call site introduces
 * non-JSON-derived input (e.g. Buffer instances inside structuredClone output),
 * add a Set<unknown> visited guard.
 */
function walkObject(node: unknown, visit: (n: unknown) => void): void {
  visit(node)
  if (node && typeof node === "object") {
    for (const v of Array.isArray(node) ? node : Object.values(node)) {
      walkObject(v, visit)
    }
  }
}

function substituteImageDataDigest(block: ContentBlockParam): ContentBlockParam {
  if (block.type !== "image") return block
  const source = (block as { source?: { data?: string } }).source
  if (!source?.data) return block
  return { ...block, source: { ...source, data: undefined, _dataDigest: sha256Hex(source.data) } } as ContentBlockParam
}

function isSystemReminderTextBlock(block: ContentBlockParam): boolean {
  if (block.type !== "text") return false
  if (typeof block.text !== "string") return false
  const t = block.text.trimEnd()
  return t.startsWith("<system-reminder>") && t.endsWith("</system-reminder>")
}
```

**v1 scope notes:**
- Strict `startsWith && endsWith` for whole-block reminders (closes the v1 false-merge risk where partial-match could collapse different real prompts; see round-1 critic C4).
- Embedded reminders *inside* `tool_result.content` strings are NOT stripped in v1 — empirically stable across turns (§2.1). Revisit in v1.1 if cross-client drift is observed.

### 3.4 Hash algorithm (Merkle-style cumulative)

```typescript
// observability/lineage/hash.ts
import { createHash } from "node:crypto"

/** Stable, byte-deterministic serialization (sorted keys, no whitespace). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]"
  const keys = Object.keys(value).sort()
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k])).join(",") + "}"
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

/**
 * Cumulative hash: turnHashes[i] = SHA256(turnHashes[i-1] || canonicalJsonCache[i]).
 * Caches per-message canonical JSON to avoid O(N²) work on long conversations.
 */
export function computeTurnHashes(canonicalMessages: Array<MessageParam>): Array<string> {
  const out: Array<string> = []
  let prev = ""
  for (const m of canonicalMessages) {
    const cj = canonicalJson(m)  // computed once per message, O(message size)
    prev = sha256Hex(prev + cj)
    out.push(prev)
  }
  return out
}

/** postResponseHash = SHA256(turnHashes.last || canonicalJson(assistantMessage)) */
export function computePostResponseHash(turnHashes: Array<string>, assistantMessage: MessageParam): string {
  const seed = turnHashes.length === 0 ? "" : turnHashes[turnHashes.length - 1]
  return sha256Hex(seed + canonicalJson(assistantMessage))
}

/** rootHash binds the conversation root to the agent's system+tools, not msg[0] alone. */
export function computeRootHash(system: unknown, tools: unknown, canonicalFirstMessage: MessageParam): string {
  return sha256Hex(
    sha256Hex(canonicalJson(system ?? null)) +
    sha256Hex(canonicalJson(tools ?? null)) +
    sha256Hex(canonicalJson(canonicalFirstMessage))
  )
}
```

**Complexity:** `canonicalJson` per message is O(message size) once (cached during a single entry's compute). `sha256` per cumulative chain element is O(prev-hash + canonicalJson) — dominated by the per-message canonical bytes. For the 785-message worst case in current data (avg ~5 KB canonical/msg), the breakdown is:
- `canonicalJson`: ~4 MB JSON-stringify-and-sort total → ~80 ms in V8 (∼50 MB/s for moderate-depth objects).
- `sha256`: ~4 MB hashed → ~8 ms (∼500 MB/s).
- `structuredClone` + `walkObject` for cache_control strip: ~10-20 ms.

**Total p99 ~50-100 ms** for the worst-case entry. Typical (50-msg entry, ~250 KB canonical) ~5 ms. The §4.3 backfill estimate uses these realistic numbers.

### 3.5 Assistant message reconstruction — corrected source

`outboundResponse.content` (a `MessageContent` of `{role, content: [...blocks]}`) is the authoritative assistant message for **both** streaming and non-streaming paths — built by `buildAnthropicResponseData` from the accumulator at finalize. *(v1 incorrectly said "use `inboundResponse.message` for non-streaming"; that field does not exist.)*

Two caveats:

1. **Stream-filter normalization** ([recording.ts:20-27](../../src/lib/request/recording.ts#L20)): `outboundResponse.content` filters whitespace-only text blocks. Clients echo back the full assistant message; if a real assistant response contained whitespace-only blocks they would diverge. Empirically not observed in 0/679 long-conversation pair tests, but theoretically possible. Mitigation: canonicalization applies the same `text.trim() !== ""` filter to client-echoed assistant messages. Low priority — verify in §10 test 5.

2. **Web-search double-hop synthesis** ([web-search/synthesize.ts](../../src/lib/anthropic/web-search/synthesize.ts)): for entries that took the double-hop path, `outboundResponse.content` is hand-synthesized with `server_tool_use` + `web_search_tool_result` blocks. The next request's echo of these blocks may have:
   - SDK-level serialization differences (`encrypted_content: ""` vs omitted, `page_age: null` vs omitted).
   - The `rewriteHistoryServerTools: "downgrade"` config rewrites the next *inbound* `server_tool_use` to `tool_use` on the wire path — but `inboundRequest` stored is pre-transform, so this doesn't bite here.

   **v1 behavior:** lineage for web_search-using requests may show no parent edge. Documented limitation. **v1.1 mitigation:** add a canonicalizer pass that drops empty/null-valued `encrypted_content` and `page_age` fields before hashing.

3. **Failed / interrupted entries:** `outboundResponse.content` is null. `postResponseHash` = null. Entry can be a *child* (its `turnHashes` and `backToolUseId` still computable from `inboundRequest`) but not a *parent*.

### 3.6 Alternatives considered

#### On-demand compute (rejected)
Compute lineage at query time by scanning recent entries. **Rejected:** per-query cost is ~500ms-2s at the dominant root size of ~200 entries (decompress full `inboundRequest` from gzip stage rows for each candidate). Activity-detail UI opens lineage on every entry view; budget is <50ms p99.

#### Pure tool_use_id reverse-link (rejected as sole mechanism, adopted as primary index)
Skip the hash chain entirely; rely only on tool ID indexing. **Rejected** because:
- 1% of completed multi-msg entries are pure-text turns with no `tool_result` tail; need a fallback.
- Can't verify the link (tool IDs *could* collide; without `postResponseHash` verifier, a re-injected/replayed tool_use_id from elsewhere would falsely link).
- The general prefix-equality oracle is useful beyond parent lookup (e.g., "how many turns of this conversation diverged from that one?").
**Adopted as the primary index for O(1) parent lookup, with hash verifier on top.** Best of both.

#### Server-side header injection (`x-lineage-session-id` round-trip)
Synthesize a session id, inject into response, expect echo. **Rejected:** Claude Code SDK strips unknown `x-*` headers; only ~zero clients would cooperate.

#### Single-hash messages array (no cumulative chain)
Store `hash(messages)`; compare-prefix becomes O(N) per query. **Rejected:** the activity-detail UI's children query would be O(turns × LIKE-scan), 100×+ slower than indexed `postResponseHash` lookup.

---

## 4. Storage

### 4.1 Schema (additive, two-phase migration)

Fresh installs — add to `SCHEMA_SQL` in [schema.ts](../../src/lib/history/sqlite/schema.ts):

```sql
CREATE TABLE IF NOT EXISTS entry_lineage (
  entry_id            TEXT PRIMARY KEY,
  schema_version      INTEGER NOT NULL,
  root_hash           TEXT NOT NULL,
  turn_hashes_blob    BLOB NOT NULL,    -- packed 32-byte raw SHA-256s; halves storage vs hex JSON
  post_response_hash  TEXT,             -- nullable for failed/interrupted
  back_tool_use_id    TEXT,             -- nullable
  computed_at         INTEGER NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES entries_v2(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_entry_lineage_post ON entry_lineage(post_response_hash);
CREATE INDEX IF NOT EXISTS idx_entry_lineage_root ON entry_lineage(root_hash);
CREATE INDEX IF NOT EXISTS idx_entry_lineage_back ON entry_lineage(back_tool_use_id);

CREATE TABLE IF NOT EXISTS entry_produced_tool_ids (
  tool_use_id  TEXT NOT NULL,
  entry_id     TEXT NOT NULL,
  PRIMARY KEY (tool_use_id, entry_id),
  FOREIGN KEY (entry_id) REFERENCES entries_v2(id) ON DELETE CASCADE
);
-- Index on tool_use_id alone for the O(1) parent lookup (`WHERE tool_use_id = ?`).
-- The composite PK above only indexes (tool_use_id, entry_id) for uniqueness;
-- this single-column index serves equality lookups efficiently.
CREATE INDEX IF NOT EXISTS idx_produced_tool_only  ON entry_produced_tool_ids(tool_use_id);
CREATE INDEX IF NOT EXISTS idx_produced_tool_entry ON entry_produced_tool_ids(entry_id);
```

**PK choice (round-2 #8):** `(tool_use_id, entry_id)` composite — not `tool_use_id` alone. While the Anthropic SDK's `toolu_*` IDs are ~128-bit random nonces and global uniqueness is the realistic case, declaring the schema to require global uniqueness would silently corrupt data if upstream ever replays an ID across entries (vanishingly rare but currently undefended). The composite PK accepts duplicates safely; `INSERT OR IGNORE` in §11 means re-finalize / backfill replay is idempotent.

Existing installs — extend [`migrateEntriesColumns`](../../src/lib/history/sqlite/connection.ts) (per round-1 M2):

```typescript
// Run AFTER SCHEMA_SQL but before any reads. Idempotent guard: check sqlite_master.
function migrateLineageTables(db: Database): void {
  const exists = db.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('entry_lineage','entry_produced_tool_ids')`
  ).all().length
  if (exists === 2) return
  // Run the same CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS statements idempotently.
}
```

**No column added to `entries_v2`.** Lineage queries go via the `entry_lineage` join — keeps `entries_v2` schema stable and avoids a wide head row.

**Storage notes (revised per round-1 M1):**
- `turn_hashes_blob` stored as packed 32-byte SHA-256s (raw binary), not JSON-of-hex. 785-msg conversation = 25 KB raw vs 53 KB JSON-of-hex (~50% savings). Decode at query time.
- `entry_produced_tool_ids` is one row per emitted `tool_use.id`. Average ~2-5 tool_uses per assistant response × 100k entries = ~500k rows; tiny.

### 4.2 Write path (resolved transaction story per round-1 H3 + round-2 #7)

In `entries.ts:finalizeEntry` (currently 1 production caller; tests stay backward-compatible with optional digest arg):

```typescript
export function finalizeEntry(id: string): void {
  if (!historyState.enabled) return
  const entry = getInFlight(id)
  if (!entry) return

  // 1. Compute digest OUTSIDE the transaction. Throw == log + write entry-only.
  let digest: LineageDigest | undefined
  try {
    digest = computeLineageDigest(entry)
  } catch (err) {
    consola.warn("[lineage] digest compute failed for entry", id, err)
  }

  // 2. Single transaction: head + stages + (optional) lineage rows, atomic.
  try {
    insertCompletedEntry(entry, digest)
  } catch (err) {
    consola.error("[entries] insertCompletedEntry failed", id, err)
  }

  removeInFlight(id)
  publishEntryUpdated(toEntrySummary(entry))
  publishStatsChanged()
}
```

The extended `insertCompletedEntry` signature is `(entry: HistoryEntry, digest?: LineageDigest): void`. Inside its existing `db.transaction`, after the stage inserts, two new statements run when `digest` is non-null:
- `INSERT INTO entry_lineage (entry_id, schema_version, root_hash, turn_hashes_blob, post_response_hash, back_tool_use_id, computed_at) VALUES (...)`
- Batch `INSERT OR IGNORE INTO entry_produced_tool_ids (tool_use_id, entry_id) VALUES (...)` for each id in `digest.producedToolUseIds`.

Test callers continue passing one argument (digest defaults to undefined — lineage simply isn't written for that test entry).

### 4.3 Backfill

`scripts/backfill-lineage.ts`:
- Cursor through `entries_v2.id ORDER BY started_at DESC LIMIT 500 batches`.
- For each entry: load `inbound_request` + `outbound_response` from `entry_stages`, run `computeLineageDigest`, INSERT OR REPLACE on `entry_lineage` and `entry_produced_tool_ids`.
- Per-message `canonicalJson` is cached within an entry's compute (the algorithm is O(total bytes) per entry, not O(N²)).
- Estimate per round-1 M5 correction: 200 entries × ~10ms p99 (worst case is the 785-msg entry at ~50ms) = ~2s for current dataset. 50k entries production: ~5 min single-threaded; non-blocking. Run with `--concurrency=4` for ~1 min on multi-core.

### 4.4 Reaper compatibility

`entry_lineage` and `entry_produced_tool_ids` are both `ON DELETE CASCADE`-linked to `entries_v2`. Bucket-based reaper ([reaper.ts](../../src/lib/history/sqlite/reaper.ts)) cleans them automatically.

**Behavior note (round-1 M6):** when a middle entry B is reaped from chain A→B→C, C's `backToolUseId` (which pointed at B's produced tool_use_id, now CASCADE-deleted) returns no parent. C's `turnHashes` still contain B's `postResponseHash` hash, but that hash is also gone. Lineage degrades gracefully to "parent unknown" — documented behavior. UI shows the gap.

---

## 5. Query API

### 5.1 New endpoint

```typescript
GET /history/api/entries/:id/lineage

Response:
{
  entryId: string
  digest: LineageDigest | null
  parent: { id: string, digest: LineageDigest, edgeType: "tool_id" | "hash_only" } | null
  children: Array<{ id: string, digest: LineageDigest, edgeType: "tool_id" | "hash_only" }>
  siblings: Array<{ id: string, digest: LineageDigest, kind: "fork" | "retry_after_failure" | "retry_duplicate" }>
  rootSummary: {
    rootHash: string,
    count: number,
    earliestAt: number,
    latestAt: number,
  } | null
}
```

**Edge types:**
- `tool_id` — parent confirmed via tool_use_id reverse-link + hash verifier. Cryptographic strength.
- `hash_only` — pure-text turn, parent identified via `postResponseHash` IN `turnHashes` scan. Hash strength.

**Sibling kinds (round-1 H6 terminology fix + round-2 #6 completeness):**
- `fork` — shares parent, both have `postResponseHash` (both completed), different `postResponseHash`. Two different assistant responses to the same prompt prefix.
- `retry_after_failure` — shares parent (or shares the same `turnHashes`), at least one of {self, sibling} has `postResponseHash == null` (failed). The case "client retried after server failure / interrupt." Most common in practice (cross-model fallback chains like `1m-internal` → `4.7`).
- `retry_duplicate` — same `turnHashes` AND both have non-null `postResponseHash` AND `postResponseHash` is identical. Server produced byte-identical response twice (rare; only with cached / deterministic upstream).

Classification by `getSiblings(parentId, self)`:

```typescript
async function getSiblings(parentId: string, self: LineageDigest): Promise<Array<SiblingResult>> {
  // findChildren(parentId) reuses the children-resolution logic shown above
  // (primary tool-id reverse-link + hash-only fallback within the parent's root),
  // factored as a helper so getLineage(parent.id) and getSiblings share one path.
  const allChildren = await findChildren(parentId)
  return allChildren
    .filter((c) => c.entryId !== self.entryId)
    .map((c) => ({
      id: c.entryId,
      digest: c,
      kind:
        self.postResponseHash === null || c.postResponseHash === null ? "retry_after_failure"
        : self.postResponseHash === c.postResponseHash ? "retry_duplicate"
        : "fork",
    }))
}
```

### 5.2 Implementation (O(1) primary + indexed fallback)

```typescript
async function getLineage(entryId: string): Promise<LineageResponse> {
  const self = await loadDigest(entryId)
  if (!self) return emptyLineage(entryId)

  // PRIMARY: O(1) tool-id lookup
  let parent = null
  if (self.backToolUseId) {
    const row = await db.get(`SELECT entry_id FROM entry_produced_tool_ids WHERE tool_use_id = ?`, self.backToolUseId)
    if (row) {
      const candidate = await loadDigest(row.entry_id)
      // Verifier (round-2 #2 positional check, matches §3.2 prose):
      // candidate.postResponseHash must equal self.turnHashes[candidate.turnHashes.length]
      // (the exact position where the parent's response would land in this entry's chain).
      const offset = candidate?.turnHashes.length ?? -1
      if (
        candidate?.postResponseHash
        && offset >= 0
        && offset < self.turnHashes.length
        && self.turnHashes[offset] === candidate.postResponseHash
      ) {
        parent = { id: candidate.entryId, digest: candidate, edgeType: "tool_id" }
      }
    }
  }

  // FALLBACK: hash-only scan within same root, only if primary failed
  if (!parent) {
    const hashHits = await db.all<{ entry_id: string; post_response_hash: string }>(
      `SELECT entry_id, post_response_hash FROM entry_lineage
        WHERE post_response_hash IN (${placeholders(self.turnHashes)})
          AND root_hash = ?
          AND entry_id != ?
        ORDER BY computed_at DESC LIMIT 5`,
      ...self.turnHashes, self.rootHash, self.entryId,
    )
    // Pick the deepest match (longest prefix match implies the most recent parent in the chain).
    const best = await pickDeepestPositionalMatch(hashHits, self.turnHashes)
    if (best) parent = { id: best.entryId, digest: best, edgeType: "hash_only" }
  }

  // CHILDREN: scan produced_tool_ids index + lineage forward-link
  // O(producedToolIds × indexed lookup) — typically 1-5 lookups
  const childCandidates: Array<{ entry_id: string }> = []
  for (const tid of self.producedToolUseIds) {
    childCandidates.push(...await db.all(
      `SELECT el.entry_id FROM entry_lineage el WHERE el.back_tool_use_id = ?`, tid
    ))
  }
  // ALSO: hash-only children for the rare pure-text path. Bounded scan within the same root.
  // Strategy: a pure-text child has backToolUseId == null AND its turnHashes contains self.postResponseHash
  // somewhere. We can't filter on "contains hash" in SQL without a denormalized edge table; for v1 we
  // accept a bounded in-root scan: load every other entry's turn hashes blob and check positionally.
  if (self.postResponseHash) {
    const rootSiblings = await db.all<{ entry_id: string }>(
      `SELECT entry_id FROM entry_lineage WHERE root_hash = ? AND back_tool_use_id IS NULL AND entry_id != ?`,
      self.rootHash, self.entryId,
    )
    // Verify each: decode their turn_hashes_blob and check whether self.postResponseHash appears
    // at the correct offset (i.e., index == self.turnHashes.length, meaning they directly succeed self).
    const verified = await verifyHashChildren(rootSiblings, self.postResponseHash, self.turnHashes.length)
    childCandidates.push(...verified)
  }
  const children = await dedupAndShape(childCandidates, self)

  // SIBLINGS: children of self's parent, excluding self; classify by digest comparison
  const siblings = parent ? await getSiblings(parent.id, self) : []

  // ROOT SUMMARY: indexed
  const rootRow = await db.get(
    `SELECT COUNT(*) c, MIN(e.started_at) e_at, MAX(e.started_at) l_at FROM entry_lineage el JOIN entries_v2 e ON e.id = el.entry_id WHERE el.root_hash = ?`,
    self.rootHash,
  )

  return { entryId, digest: self, parent, children, siblings, rootSummary: rootRow }
}
```

**Performance:**
- Parent (primary): 1 indexed lookup → <1ms.
- Parent (fallback): indexed IN-scan over ≤785 hashes → <10ms.
- Children: `producedToolUseIds.length` × indexed lookup → typically <2ms.
- Sibling lookup: bounded by parent's children count → <5ms.
- Total p99: <20ms even for 785-turn conversations.

### 5.3 Extend existing entry endpoint

`GET /history/api/entries/:id` adds an optional `?include=lineage` query that returns `{ ..., lineage: LineageResponse }` inline. **Single-entry only** (round-1 M4) — list endpoints do not support `?include=lineage` to avoid N+1.

### 5.4 Root-grouping listing

`GET /history/api/conversations`:

```typescript
{
  conversations: Array<{
    rootHash: string,
    count: number,
    earliestAt: number,
    latestAt: number,
    firstEntryId: string,
    lastEntryId: string,
    models: Array<string>,
    totalInputTokens: number,
    totalOutputTokens: number,
  }>
  cursor?: string
}
```

Built from `SELECT el.root_hash, COUNT(*), MIN(e.started_at), MAX(e.started_at) FROM entry_lineage el JOIN entries_v2 e ON e.id = el.entry_id GROUP BY el.root_hash ORDER BY MAX(e.started_at) DESC LIMIT ?`.

---

## 6. UI

Out of scope here — defers to the activity-detail RFC's lineage section. This RFC commits to providing:

1. `GET /history/api/entries/:id/lineage` (above).
2. `GET /history/api/conversations` (above).

UI can render: a horizontal turn-tree on activity-detail; a "conversations" sidebar; "show all turns" badge on summaries.

`EntrySummary` is **NOT** extended in v1 (round-1 Q7 risk to typed WS consumers). The UI fetches lineage via the dedicated endpoint when it needs it.

---

## 7. Commit sequence (invariants)

Per [[methodology-commit-invariants]], every commit ends in a state where typecheck + lint + unit tests pass AND the production system has no functional regression.

| # | Commit | End state |
|---|---|---|
| 1 | `feat(lineage): canonicalize + hash modules + unit tests` | `observability/lineage/{canonicalize,hash,types}.ts` exist with full coverage including image-data substitution, system+tools rootHash binding, structuredClone correctness. Not wired to write path. Production unchanged. |
| 2 | `feat(lineage): SQLite schema + entry_lineage + entry_produced_tool_ids + migration` | Tables created on next open (idempotent `CREATE TABLE IF NOT EXISTS` for fresh + `migrateLineageTables` for existing). Reader code tolerant of empty tables. |
| 3 | `feat(lineage): compute digest in finalizeEntry + extend insertCompletedEntry transaction` | New entries get lineage rows atomically with entry write. Old entries still have no lineage row. `inboundRequest` capture unchanged. |
| 4 | `feat(lineage): backfill script + manual run` | Script `scripts/backfill-lineage.ts`. Run manually; documented in DESIGN.md. Idempotent. |
| 5 | `feat(lineage): /history/api/entries/:id/lineage endpoint` | New endpoint live. No UI consumer yet. Other endpoints unchanged. |
| 6 | `feat(lineage): /history/api/conversations endpoint` | New listing endpoint live. |
| 7 | `feat(lineage): UI integration (defer to activity-detail-main-outline RFC)` | Out of scope; tracked separately. |

After commit 3 the system has end-to-end lineage for new traffic. After commit 4 history is queryable. Commits 5-6 are read-only API surface additions.

---

## 8. Known v1 limitations (with explicit documentation, per [[feedback_complete_root_cause_fix]])

These are out of scope for v1 implementation but **must be documented in the UI** and **filed as separate issues** for v1.1+:

### 8.1 Cross-protocol lineage (OpenAI / Responses / Gemini)

v1 implements **Anthropic-only** canonicalization. Current sampled traffic is 100% Anthropic; OpenAI/Responses traffic was not probed. Lineage rows for non-Anthropic entries are not written. The `entry_lineage` schema is protocol-agnostic; v1.1 adds OpenAI canonicalization rules (similar shape, different field names for tool_call vs tool_use) without schema change.

The Responses API already has `previous_response_id` native lineage; the existing `registerResponseSession` path is unaffected.

### 8.2 Cross-model fallback chains (e.g., `1m-internal` → `4.7`)

Empirically observed: `req_1781546985683_1948` (failed, claude-opus-4-8 with inline-system error) → `req_1781546986323_1949` (completed retry 640ms later, same pid, restructured `messages`). The two requests are **two separate history entries** with **different message shapes** (Claude Code rewrites msg structure on retry-with-different-model), so they get different `rootHash` and no lineage link.

**v1 behavior:** these entries appear as two unrelated conversation roots. **v1.1 mitigation:** a `(pid, gitSha, Δt < 5s, first-text fuzzy match)` heuristic detects "retry-with-restructure" candidates and surfaces them as a special "client-retry" sibling kind.

### 8.3 Claude Code `/compact` continuation

`/compact` rewrites msg[0] to a synthetic "This session is being continued from a previous conversation [summary]…" — a new conversation gets a different `rootHash`. v1 cannot link a compacted thread to its predecessor.

**v1.1 mitigation:** detect `startsWith("This session is being continued from a previous conversation")` in msg[0] and emit a `continuesFromHint` field; UI can offer a manual "link to prior conversation" affordance.

### 8.4 Web-search double-hop

When `web_search.enabled` + `rewriteHistoryServerTools: "downgrade"` are active, `outboundResponse.content` is hand-synthesized. The next request's echo of `server_tool_use`/`web_search_tool_result` blocks may have SDK-level field-presence differences (`encrypted_content: ""` vs omitted, `page_age: null` vs omitted). v1 may show no parent edge for such requests.

**v1.1 mitigation:** add a canonicalizer that drops empty/null `encrypted_content`/`page_age` before hashing.

### 8.5 Embedded `<system-reminder>` inside tool_result strings

Empirically stable across turns in Claude Code traffic (0/679 mismatches on long-conversation pair). Not stripped in v1. If future client versions or alternative clients (Cursor, Cline) inject drifting reminders here, lineage breaks — strip in v1.1.

### 8.6 Hash schema versioning

`schema_version` is stored per row. If v1.1 changes canonicalization rules, old rows' hashes won't match new ones'. Resolution: on startup, if `min(schema_version)` in `entry_lineage` < current, log a warning and offer `scripts/backfill-lineage.ts --rebuild` to recompute. Queries continue to work; cross-version chains degrade to "parent unknown."

---

## 9. Non-goals (explicit)

- **Token-level diff between parent and child.** UI can compute on-demand from `inboundRequest`; not a lineage-layer concern.
- **Real-time lineage push over WebSocket.** Lineage is read-only metadata.
- **Conversation merging across clients.** Two clients independently sending identical prefix messages will collide on rootHash; distinguishing them is a human judgment supported by `pid`/`gitSha`/`transport`/`model` fields.
- **Replacing `sessionId` / `previous_response_id`.** Lineage is additive. Header-provided sessionId and Responses chain remain authoritative when present.

---

## 10. Verification plan

Before merge, the following must hold (mirrors the empirical probe approach):

1. **Unit:** Canonicalization is idempotent: `canonicalize(canonicalize(x)) == canonicalize(x)` over 1000 random fuzzed Anthropic messages.
2. **Unit:** Hash determinism: same input → same hash, byte-for-byte, across 1000 trials.
3. **Unit:** `structuredClone` correctness vs `JSON.parse(JSON.stringify())` for image-bearing payloads.
4. **Unit:** image-data digest substitution preserves all non-data fields; output is byte-stable for identical input data.
5. **Integration:** Backfill against the local DB's 200+ entries; verify the long Claude Code conversation (681-msg cluster) reconstructs as a single chain via tool-id reverse-link.
6. **Integration:** For the 8-pair predecessor/successor chain probed in §2.1, `getLineage(curr).parent.id == prev.id` for all 8, with `edgeType == "tool_id"` where the tail is a tool_result.
7. **Integration:** Empty-text-block edge case (round-1 H2) — construct an entry with a whitespace-only text block in assistant response; verify lineage still resolves (canonicalization filter matches on both sides).
8. **Integration:** Image-heavy entry — construct an entry with 5 base64 image-tool_results in a 50-turn conversation; verify hash compute under 50ms.
9. **Adversarial:** Construct two distinct conversations whose msg[0] would collide post-canonicalization but with different `system` prompts; verify they get different `rootHash`.
10. **Adversarial:** Construct a retry pair (same `turnHashes`, both failed); verify they appear as `kind: "retry_duplicate"` siblings, not as parent/child.
11. **Adversarial:** Construct a fork pair (same parent, different next-user-turns); verify `kind: "fork"`.
12. **Perf:** Single-request lineage compute ≤ 50ms p99 for 785-turn conversation; full-backfill of 50k entries ≤ 5 minutes single-threaded; lineage query p99 < 20ms.

---

## 11. Rollout / failure modes

| Failure | Detection | Recovery |
|---|---|---|
| Canonicalization throws on malformed payload | Try-catch around `computeLineageDigest`, log + continue; entry has no lineage row | Lineage queries return `digest: null`; UI shows "lineage unknown"; next backfill retries |
| Hash collision (cryptographically improbable) | The verifier in §3.2 — primary tool-id match must agree with hash chain | If verifier rejects, fallback path runs; collision visible as `parent: null` despite tool-id match (log warning) |
| Schema migration fails | `openDatabase` startup error | `DROP TABLE entry_lineage; DROP TABLE entry_produced_tool_ids`; CREATE statements are idempotent. UI gracefully degrades |
| Multi-process race on migration (round-1 Q3) | `CREATE TABLE IF NOT EXISTS` is SQLite-safe; both processes run identical idempotent DDL | None needed |
| Re-finalize double-insert (round-1 Q2) | INSERT OR REPLACE on `entry_lineage`; `entry_produced_tool_ids` uses `INSERT OR IGNORE` (composite PK on `(tool_use_id, entry_id)`, so an identical row is a no-op while the same `tool_use_id` under a different entry can still record an independent link) | Idempotent by construction |
| Production hot-path regression | finalizeEntry timing histogram (already in observability) | Lineage compute is in the same transaction as entry write — if it throws, entry write also fails. Mitigation: compute outside the txn, write inside; on compute failure, write entry-only without lineage |
| Backfill OOM on 785-msg entries | Cursor batching of 500 by default | Smaller batches or stream-process per-entry |

**Decision on transaction strategy (resolving round-1 H3 tension):** compute lineage **outside** the transaction; if compute succeeds, pass the digest into `insertCompletedEntry` which writes everything atomically; if compute fails, log + write entry without lineage. This avoids the "throw kills the entry" risk while preserving atomicity of "entry + its lineage row, together."

---

## 12. Cost summary

| Resource | v1 cost |
|---|---|
| Code | ~700 LOC (canonicalize 100, hash 60, persistence 180, query 240, backfill script 80, tests ~250) |
| Schema | 2 sibling tables, additive; migration idempotent |
| Runtime per request (worst case 785 msgs) | ~10-50ms compute (sha256 + structuredClone + canonicalJson + base64 digest substitution); ~5ms persist |
| Storage per entry | ~25 KB binary turn-hashes (785-msg worst case); typical ~3 KB |
| Read latency | parent: <1ms (tool-id) or <10ms (hash fallback); children: <2ms; root summary: <5ms |

---

## 13. Open questions for round-2 review

1. **Web-search synthesis in v1 (§8.4):** is "lineage may show no parent edge" acceptable as a documented v1 limitation, or should the simple field-stripping mitigation ship in v1?

2. **Transaction strategy in §11:** compute-outside-write-inside is safer but means a compute-only failure produces an entry without lineage that backfill must clean up later. Acceptable, or write lineage in a separate non-blocking transaction after the entry commits?

3. **Children query cost in long roots:** `entry_produced_tool_ids` index keeps the tool-id-children path O(1), but the hash-only-children fallback (for pure-text turns) does a `LIKE`-free indexed IN scan over the root. Bounded by root size. Confirm acceptable for the largest observed root (681 entries).

4. **`structuredClone` vs JSON round-trip:** `structuredClone` is slower (~3-5×) but correct for Buffer/Uint8Array. For Anthropic messages we likely never see these, but the cost is per-message-canonicalize. Worth a benchmark to decide.

5. **Should `rootHash` also fold the model name?** Two conversations on the same agent with different model selections (opus vs sonnet) might be considered different roots. v2 doesn't fold model into rootHash; argues for "same conversation, model switched mid-stream." Confirm or reverse.

---

## 14. Acknowledgements

This RFC is empirically grounded — every claim in §2 has a reproducible probe script. Round-1 adversarial review by three subagents (critic / alternative-approaches / edge-cases) caught:
- **§3.4 wrong source for assistant message** (was `inboundResponse.message`, doesn't exist; corrected to `outboundResponse.content`).
- **rootHash over-clustering** (msg[0] alone collides across conversations; v2 folds in `system` + `tools`).
- **tool_use_id reverse-link as the dominant signal** (99% of completed multi-msg entries; promoted to primary index).
- **Web-search synthesis bypass** (documented v1 limitation §8.4).
- **Storage layout** (binary turn-hashes blob, separate produced-tool-ids table).
- **Schema migration two-phase pattern.**
- **Sibling terminology** (fork vs retry_duplicate).

Findings the round-1 review made that did NOT change the design:
- **Embedded `<system-reminder>` in tool_result strings drift** (edge-cases C2) — empirically falsified: 0/679 mismatches on adjacent-pair long-conversation probe. Documented as v1.1 watch item.

The methodology mirrors [[empirical-probe-via-history-api]] (test against live data, not reason about it), [[feedback_reviewer_verify_critically]] (re-verify every subagent finding myself), and [[feedback_real_problems_over_risk]] (the problem is real: today, `entry.sessionId === null` for 200/200 Anthropic requests, and there is no way to ask "what came before this?").
