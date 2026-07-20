# History V3 performance verification — 2026-07-16（2026-07-18 corrected）

Status: **format-v2 passes the deterministic offline capacity gate**.

> The original 24.86×／44.98× result is withdrawn. Its V2 side mixed compressed head bytes with uncompressed stage JSON, so it was not comparable to compressed V3 SQLite storage. A corrected compressed V2 baseline showed the pre-fix V3 at only about 0.69× page ratio and 1.26× live-blob ratio.

## Corrected workload

`tests/history/v3/store-performance.it.test.ts` builds 48 long-conversation operations with repeated prefixes and large semantic payloads. It writes:

- a V2-equivalent baseline using the same compression codec for head and stage blobs;
- format-v2 V3 with value-free manifests, compressed external tracks, sequence-prefix DAG nodes, and volatile occurrence overlays. The later schema-v5 measurement excludes embedded search because those tables are retired.

The test measures both SQLite page growth and the sum of live V3 blobs. This distinguishes physical allocation from logically live data.

## Corrected results

| Metric | Result |
|---|---:|
| Compressed V2 equivalent | 50,380,624 bytes |
| V3 SQLite page delta | 2,506,752 bytes |
| V3 live blobs | 1,281,725 bytes |
| V2 / V3 physical page ratio | **about 20.1×** |
| V2 / V3 live-blob ratio | **about 39.3×** |

Both capacity ratios exceed the frozen 10× gate in this deterministic fixture. Exact page deltas can vary slightly with SQLite allocation/runtime details; the test enforces the 10× bound rather than one captured decimal. The former SQLite-search latency result is historical and no longer a product gate.

## Production format-v1 observation

A read-only audit of the existing user V3 artifact found approximately **3.996 GB for 2,113 operations**:

| Area | Approximate bytes |
|---|---:|
| compressed manifests | 1.034 GB |
| semantic objects | 1.385 GB |
| tracks | 145 MB |
| search objects | 1.359 GB |

The largest compressed manifest was about 6.53 MB (about 18.35 MB decoded). This is evidence of the old format's duplication, not a format-v2 benchmark. The audit did not mutate, vacuum, migrate, or delete the real database.

## What the gate does not prove

- It does not shrink existing format-v1 rows; no online rewrite is performed.
- It does not prove event-loop isolation. `prepareModelOperation()` still performs canonicalization, hashing, and compression synchronously on the JS thread even though queue draining crosses Promise boundaries.
- Tantivy v1 performance/backfill/product-query gates are separate work; this benchmark covers authoritative History storage only.
- Ratios are fixture-specific and should be tracked for regression, not generalized as universal production compression factors.

## Reproduction

```bash
bun test tests/history/v3/canonical-performance.unit.test.ts
bun test tests/history/v3/store-performance.it.test.ts
```

The store test prints a `HISTORY_V3_PERF` JSON line and enforces the corrected compressed baseline and ≥10× capacity bounds.
