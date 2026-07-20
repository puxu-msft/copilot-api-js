# Source-governed History V3

Status: **LANDED 2026-07-16; FORMAT-V2 CORRECTION 2026-07-18**

## Decisions

- The internal authority is backend-owned `ModelOperationRecord`, not `HistoryEntry` or a SQLite row.
- All model operations are represented: generation, Responses WS, count tokens, embeddings, and Azure metadata.
- Producers capture once at ingress/routing/attempt/upstream/client-delivery boundaries; consumers use typed terminal projections.
- Upstream and client tracks remain independently reconstructable. Unchanged frames share arena nodes; rewrite/filter/translation/synthetic frames retain provenance.
- Semantic V3 starts empty in `history-v3.db`. The service does not open, read, migrate, backfill, archive, or delete legacy History artifacts.
- Built-in tiered archive and count retention are retired. No external archiver is invoked or integrated.
- Exact raw bytes are optional, disabled by default, and stored in independent `raw.db`. Hot reload rotates artifact generations for new operations only.
- Persistence cannot fail the model request. Canonical terminal publication is fire-and-forget, tracked for shutdown drain, and failures remain observable.

## Storage

- `v3_objects`: versioned semantic CAS with full-byte collision verification.
- `v3_operations`: compressed value-free manifest, terminal identity, and lightweight product summary.
- `v3_sequence_nodes`: persistent prefix DAG for object-array sequences; occurrence overlays restore volatile cache hints.
- `v3_tracks`: format-v2 compressed full tracks (`track_gz`) plus legacy compact-reference fallback.
- `v3_timeline_chunks`: bounded lifecycle chunks.
- `v3_journal`: self-contained uncommitted terminal records for crash recovery; deleted after authoritative commit.
- History schema v5 drops all `v3_search_*` tables; authoritative commits contain no full-text projection.
- `history-search/`: independent Tantivy v1 sidecar fed by canonical terminal records; disposable and never part of the History transaction.
- `v3_summary_backlog`: poison ledger for V3-only summary backfill.

## Lifecycle invariants

1. Delivery finalization and logical outcome form a two-boundary join; the terminal sequence is after the final client frame.
2. Every attempt settles independently as committed, discarded, or failed; retry diagnostics are never reset out of History.
3. CPU preparation and compression run outside SQLite transactions; transactions remain synchronous and short. This does **not** imply worker-thread isolation: preparation currently remains synchronous on the main JS thread.
4. Terminal subscriber and writer queues drain before database close.
5. Raw capture policy and codec bind to the acquired generation, never live config.
6. Tantivy/raw/WS detail may degrade before semantic authority; any gap is explicit. Search API does not fall back to SQLite.
7. Format-v1 operations remain readable and are never rewritten online; format-v2 only governs new writes and uses a distinct hash domain.

## Verification

- Independent acceptance: [2026-07-16-history-v3-acceptance.md](../audits/2026-07-16-history-v3-acceptance.md)
- Performance: [2026-07-16-history-v3-performance.md](../audits/2026-07-16-history-v3-performance.md)
