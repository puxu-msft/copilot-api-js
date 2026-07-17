# Source-governed History V3

Status: **LANDED 2026-07-16**

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
- `v3_operations`: compressed value-free manifest and terminal identity.
- `v3_tracks`: compact ordered operation-local references.
- `v3_timeline_chunks`: bounded lifecycle chunks.
- `v3_journal`: self-contained uncommitted terminal records for crash recovery; deleted after authoritative commit.
- `v3_search_objects` + membership: compressed unique payload search projection, rebuildable and non-authoritative.
- `v3_search_backlog`: derived projection failure ledger.

## Lifecycle invariants

1. Delivery finalization and logical outcome form a two-boundary join; the terminal sequence is after the final client frame.
2. Every attempt settles independently as committed, discarded, or failed; retry diagnostics are never reset out of History.
3. CPU preparation and compression run outside SQLite transactions; transactions remain synchronous and short.
4. Terminal subscriber and writer queues drain before database close.
5. Raw capture policy and codec bind to the acquired generation, never live config.
6. Search/raw/WS detail may degrade before semantic authority; any gap is explicit.

## Verification

- Independent acceptance: [2026-07-16-history-v3-acceptance.md](../audits/2026-07-16-history-v3-acceptance.md)
- Performance: [2026-07-16-history-v3-performance.md](../audits/2026-07-16-history-v3-performance.md)
