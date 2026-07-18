# History V3 performance verification — 2026-07-16

Status: **passed deterministic offline gates**. No legacy database or external archiver was used.

## Workloads

- Long conversation with repeated prefixes.
- High-branch multi-attempt operation.
- 2,048-frame SSE operation.
- Buffered retry, count-token flood, and embedding batch fixtures.

## Results

| Gate | Result |
|---|---:|
| Prepare ratio after 256 prior operations | 0.61× |
| Commit ratio after 256 prior operations | 0.36× |
| V2 estimate / V3 SQLite page delta | **24.86×** |
| V2 estimate / V3 live blob bytes | **44.98×** |
| Search p95, 64 operations | 4.44 ms |
| Search p95, 256 operations | 12.58 ms |
| Search latency ratio for 4× corpus | 2.83× |
| Pending writer bytes / logical queued bytes | 805,179 / 1,861,677 |
| Unchanged frame sharing | 4,096 nodes / 8,192 track refs = **2×** |
| Large-SSE canonical capture median | 21.10 ms |

The physical-size target of at least 10× was exceeded. Search and commit cost remained sublinear with prior corpus size in the deterministic test range. RSS is guarded coarsely because Bun and SQLite retain allocator arenas; `pendingBytes` is the precise queue bound.

## Reproduction

Run:

- `bun test tests/history/v3/canonical-performance.unit.test.ts`
- `bun test tests/history/v3/store-performance.it.test.ts`

The tests print `HISTORY_V3_PERF` JSON lines and enforce complexity/size bounds.
