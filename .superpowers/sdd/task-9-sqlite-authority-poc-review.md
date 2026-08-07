# Task 9 SQLite controlled-maintenance PoC A/B1/B2/B3 独立评审

## 范围、证据与结论

评审候选树：`/home/xp/src/copilot-api-js/.worktree/agent-a0b5eee4b161ab9ab`。审阅 A/B1/B2 的初始 HEAD `346c692c09115bb9468bc82b806a0ea8962c55c3`、B2 修复 `07d1545340b5f6b5d480132affe76e5c922d73b5`，以及 B3 commits `bc5f6065c106c8e8740a2f78caa5deccbcf4725c`、`be0044162e8e0d8d38b55571bc0a56bd9082ad89`。

已读取 README、所有 A/B1/B2/B3 probe 与 JSON、B3 汇总脚本、progress、`packages/foundation/src/sqlite/driver.ts` 与 Task 9 架构草案。已复跑 A/B1/B2、B2 cleanup／side-effect mutations、B3 correctness／invalidation mutation、B3 refs=32/256 KiB performance probe；独立从六份 raw JSON 重算全部 24 组 median 与 paired delta。

最终 verdict：A/B1/B2 capability 通过，B2 Quality 批准；B3 correctness 通过，B3 performance 仅作为 query-shape 与本机成本观察通过。Blocker 0，Critical 0，Important 0，Minor 0。

## A/B1 capability

- Bun 1.3.14 的公开 `Database` prototype 无 UDF／authorizer 注册；实测 `.so + Database.loadExtension() + bun:ffi.dlopen()` 可注册每 connection 只读 getter，并由 host setter 开关。普通 SQL 不能传参调用 getter，第二 connection 始终独立关闭。
- Node 24.16 的 `DatabaseSync.function()` 可用 closure 提供等价 getter，第二 connection 同样隔离。项目统一 driver 当前未暴露这些能力。
- `.so` 由本机 Linux x86-64 产出，SHA256：`a15766a2dc7cc5e9ce2912f1fa5eb2890203de3b616cfb624cf468eac2f91f9f`；不外推至其他 OS、libc、CPU 或无 C compiler/header 的环境。

## B2 初轮 finding 与闭合复核

[Important，已闭合] 初轮 `probe-b2-bun.ts:49-52`、`probe-b2-node.mjs:38-42` 只测无副作用 Promise／thenable，不能证明 callback 未在 mode 窗口发生同步写入。`07d1545` 新增 Promise executor 与 then getter 的负控：事务外两者都先持久化 INSERT、再抛 `TypeError`；包在 BEGIN/ROLLBACK 内时行均不存在。由此精确证明“sync-only”只是返回值契约，原子性必须由同一 helper 内 SQLite transaction 保证。

复跑 Bun/Node 的新旧 cases 均通过：nested same/different mode fail closed；每个 case 后 mode=off、普通 SQL 被拒、第二 connection mode=off 且写入拒绝。`B2_MUTATE_CLEANUP=1` 双 runtime 都在 `normalScope` 因残留 mode 非零失败；`B2_MUTATE_SIDE_EFFECT_ORACLE=1` 双 runtime 都在 rollback control 非零失败，证实新断言咬中目标机制。callback/begin/commit 原错误优先于 rollback/cleanup，且无原错误时 cleanup error 传播，未回归。Node trigger→host reentrancy 是真实 UDF 回调；Bun 明确 N/A，未用合成调用冒充。

## B3 correctness

- 生成口径可复核：512 rows × refs 0/4/32，分别为 0/2,048/16,384 refs，所有 correctness manifest 均 256 KiB。v1/v2/valid-v3 为 ready；future/digest/write-after-attestation 为 not-ready，正确状态未被误拒。
- `B3_MUTATE_DISABLE_INVALIDATION=1` 删除 operation invalidation 后，write-after-attestation 变 ready、进程非零，mutation 红来自目标机制。
- ordinary SQL 改 payload+digest 后再重写 integrity/status/summary/marker，`incorrectStateStillReady=true`，反例真实。它只否定范围 B 需要的不可伪造 derived authority；架构草案保留 A/B 范围分叉，未把它误写成范围 A 或冻结 spec 的结论。

## B3 performance

- 六份 raw JSON 覆盖 512 rows × refs 0/4/32 × payload 64 B/256 KiB；get/list/session/stats 的 baseline 与 integrity 使用同一 seeded ready 数据、投影和参数，24 组 `resultEquality=true`。
- 全部 integrity EXPLAIN 使用 operations/evidence covering index，不命名 `manifest_payload`、无 TEMP B-TREE，并有 `CORRELATED SCALAR SUBQUERY` 和 refs index search：该 SQL 形状不投影 blob，但每个候选 row 付 refs anti-join 成本。
- 每 query 15 轮随机 A/B 顺序 paired samples；独立重算 24 组 baseline median、integrity median、paired delta，全部与 raw／summary 一致。README 正确限定单机 Bun in-memory 观察，不声称生产、文件 I/O、冷缓存、WAL 或零回归；payload-size 只能支持本查询形状未 materialize blob，不能证明未来 query 或生产环境 size-independent。

## 实验二进制处置

结论：**不随 PoC 保留／提交 `maintenance_mode_extension.so`；保留 C 源码、build recipe、B1 probe 与上述 SHA256 作为本机已实测 artifact identity。**理由：项目约定 native `.node` 构建产物默认 gitignored、避免把特定机器二进制混同可移植源；此 ELF 仅 Linux x86-64，提交会制造跨平台可用的错觉；C 源 + 明确 header/compiler 前提可在适用环境复现，SHA 用于核对已测字节而不是要求下载二进制。正式采用 native extension 时另行决策多平台预构建／安装交付，不能让此 PoC artifact 静默变成产品分发机制。

## 结构怪味与处置

[建议] `probe-b3-performance.ts:28-48` — 四份 SQL 内嵌重复。处置：正式实现再抽共享 validated snapshot predicate；PoC 保持展开，因每条 SQL 是 EXPLAIN 证据。

[建议] `probe-b3-correctness.ts:43-62` — DML 覆盖仅 operation UPDATE、evidence UPDATE/DELETE。处置：正式 authority matrix 必补 evidence/ref INSERT OR REPLACE、PK UPDATE、FK-off 等控制；README 已披露，故不阻断 PoC。

[建议] `maintenance_mode_extension.c:42-53` — 同进程能 `dlopen` 的代码可调 exported setter；这是已声明的宿主信任边界，非 SQL 绕过。处置：正式 artifact 再评估 opaque handle，不阻断 PoC。
