<!-- 状态：已完成（2026-07-16）。零迁移；未调用或集成外部 archiver。 -->

# Source-governed History V3 implementation plan

Archived implementation record. The approved source plan was executed from Phase 0 through Phase 9.

- Phase 0: removed automatic terminal-record deletion and built-in archive/tier surfaces.
- Phase 1: introduced immutable `ModelOperationRecord` and shared payload/frame arena.
- Phase 2: wired generation, Responses WS, count tokens, embeddings, and Azure metadata.
- Phase 3: moved consumers to canonical terminal projections.
- Phase 4: added hot-reloadable independent raw store generations.
- Phase 5: added semantic CAS/manifests/timeline/search schema in `history-v3.db`.
- Phase 6: added self-contained journal, single writer, drain-before-close, and recovery.
- Phase 7: cut list/detail/session/stats/export/search reads to V3.
- Phase 8: stopped production V2 sink/migrations/backfills/reaper and removed count retention.
- Phase 9: passed independent acceptance and deterministic performance gates.

Canonical design: [source-governed History V3 RFC](../rfc/2026-07-16-source-governed-history-v3.md).
