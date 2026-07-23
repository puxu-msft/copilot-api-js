---
name: reference-bun-test-parallel-breaks-single-process-superlinear-degradation
description: bun test 单进程串行跑数百文件超线性退化(逐模块加起来 70s、一起 170s)；bun 原生 --parallel(隐含 --isolate 每文件独立 worker)破解并消除污染型 flaky；pty/e2e 不加
metadata: 
  node_type: memory
  type: reference
  originSessionId: 950c7328-ce3e-4272-93d9-4ed523568974
  modified: 2026-07-21T07:59:07.598Z
---

`bun test` **单进程串行跑数百文件会超线性退化**：module-global state / SQLite handle / GC 压力 / `afterEach` 的 RESETTERS 随已跑文件数累积。实测（copilot-api-js 440 文件 fast 档）——逐模块单独跑加起来仅 ~70s，但**一起塞一个进程跑 170s**（2.4× 退化）。

**根因修 = bun 原生 `bun test --parallel`**（隐含 `--isolate`：每文件独立 worker 进程，默认 worker 数 = CPU 核数）：实测 fast 档 **170s→14.7s**（11.5×）、全后端 409s→71s（5.7×），且**隔离顺带消除跨文件污染型 flaky**（h2-keepalive 争用、SIGINT 负载敏感在隔离下反而全绿）。`--shard=1/N` 供 CI 多 job 分片、`--max-concurrency` 调单文件内并发。

**How to apply:** 测试套件跑得慢先**逐模块单跑对账**（`bun test tests/<mod>` 各自 [Xs]），若「分开跑总和 ≪ 一起跑」就是单进程退化、非测试本身慢 → 脚本加 `--parallel`（`battle-tested` 原生 flag，别手搓 shell 分片/module 脚本）。**例外不加 `--parallel`**：pty（并发抢终端资源→失败，实测 1 fail）、e2e（直连真上游→限流）。踩坑：分档后默认档 170s 被判不可接受，误以为要「按模块拆脚本」，实测发现是单进程退化、一个 `--parallel` flag 解决（2026-07-20，`36b4f9a0`）。与 [[reference-gpt-tokenizer-pathological-on-repeated-chars]] 同属「慢的根因不在表面」；裁决靠实测拆解非推断（empirical-verification）。

**再进一层：`--parallel` 的 12s 里 ~6s 是 `--isolate` 强制的 440 次重导入（2026-07-21，`de7e6115`）。** `--parallel` 隐含 `--isolate`（每文件独立模块上下文），把重 `~/lib/*` 图重导入一次/文件；A/B 实测 `--parallel` 12s vs 8-way `--shard`（片内共享缓存）8-9s vs **按耗时 LPT 均衡分 nproc 桶（`scripts/parallel-test.ts`）5.5s**。地板卡在：每桶一次 import（不可免）+ 单文件 tall pole（rate-limiter 2.15s 不可再 split）。**权衡**：分片片内失去进程级 isolate、污染可能重现（fixture RESETTERS 仍逐测隔离）——`test:fast` 走均衡分片、`test:fast:isolated` 留 `--parallel` 查污染。**runner 必防 false-green**：崩溃桶（exit≠0 且无 fail summary）同桶隐藏失败会被归零 → 崩溃时用 `bun test --isolate <桶>` 逐文件重跑精确定位（verifier 对抗审查逼出的 HIGH）。**正交降 execution sum**：retry backoff 用 `abortableDelay` 延迟缩放 seam（fixture beforeEach 设 scale=0、声明 waitMs 账目不变）在测试下瞬时（`c8c7e28d`）；真秒级 timer（rate-limiter/shutdown）测的是时序行为、fake 有正确性风险故未动。
