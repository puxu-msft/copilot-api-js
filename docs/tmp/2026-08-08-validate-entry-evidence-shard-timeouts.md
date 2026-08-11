# validate-entry-evidence.unit 在 16-shard 下的 false-red 原始输出

> 摘自本会话 job 临时目录两次 `bun run test:backend`（`bun scripts/parallel-test.ts unit it http`，16 shards）的输出，已去 ANSI 转义。这是 [2026-08-08-lossless-shutdown-review-dispositions.md](2026-08-08-lossless-shutdown-review-dispositions.md) 与 `docs/memory/methodology-false-red-from-process-global-quantities-not-the-mechanism.md` 所引数字的原始来源。
>
> 两次超时**落在不同用例上**——这正是「逐条加 timeout 是打地鼠」的直接证据：染红的量（wall-clock 预算 vs shard 负载）是全局的，红在哪一条只取决于该轮调度。

## 第一次

来源：`$CLAUDE_JOB_DIR/tmp/backend-timeout-final.log:159-161`（2026-08-08 18:39）

```
tests/infra/validate-entry-evidence.unit.test.ts:
✗ entry evidence validator C7-C9 > accepts a symlink-like SAX package closure by content identity [7369.01ms]
  ^ this test timed out after 5000ms.
```

## 第二次

来源：`$CLAUDE_JOB_DIR/tmp/final-backend-after-review.log:162-164`（2026-08-08 18:22）

```
tests/infra/validate-entry-evidence.unit.test.ts:
✗ entry evidence validator C7-C9 > rejects every missing or modified runtime dependency before receipt publication [7355.61ms]
  ^ this test timed out after 5000ms.
```

## 口径与边界

- 两次均为 `bun run test:backend` 的 16-shard 运行；单文件独跑 43/43 全绿，逐用例耗时见 [2026-08-08-validate-entry-evidence-timings.xml](2026-08-08-validate-entry-evidence-timings.xml)（全文件 45.395 秒，最慢用例 4.561754 秒，均远低于 5 秒 per-test 预算）。
- **只有这两次留下了可达的原始输出。** 会话过程中还观察到过第三次同类超时，但其运行输出未落盘，无法复核具体毫秒数与用例名——因此本文件只记这两次；任何引用第三次数字的说法都应视为未交叉验证。
- 该现象在 `a6be256a` 给该文件设 `setDefaultTimeout(30_000)` 后不再出现；此后的 backend 运行为 6384 pass、0 fail。
