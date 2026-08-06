# A3 独立代码评审

- 评审范围：`2c9b5d6688c4c2d267d951647e0187224654a55c..c23ed8044e47b3313f74d4fd8d7e4627e0352567`。
- 绑定证据：隔离层拒绝用户指定的共享 checkout 命令；从同一 object database 执行 `git show -s --format=%H c23ed804` 得 `c23ed8044e47b3313f74d4fd8d7e4627e0352567`，并以该 commit 的 `git archive` 快照审查，未使用 isolation worktree HEAD。
- 总体 verdict：修复 major 后可进入下一阶段。
- 计数：0 blocker / 6 major。

## 双视角覆盖证据

- 机械核对：逐项对账 C1–C6 的 HTTP parsing、三源 merge、strict UDS protocol、daemon frontier、native filters/keyset/total、summary schema/type registry 与 SCC ratchet；`diff --check` 通过，SCC baseline 前后 SHA-256 相同，exact snapshot 的 SCC guard 为 2 pass / 0 fail。
- 第一人称执行：模拟 unavailable／旧协议／lag／poison／stale reference、同毫秒 boundary＋restart、older/newer cursor、persisted/recent/in-flight 在 sidecar await 前后换态、recent-persisted 绕过 ID、损坏 index＋旧 cursor、无效/极大 limit；主动构造了现有测试全绿但实现错误的场景。
- 测试证据：exact snapshot 上 summary＋HTTP 36 pass / 0 fail，native sidecar＋UDS＋真实 HTTP 42 pass / 0 fail；这些绿灯未覆盖下列六个反例，因而不构成 C1–C6 的完整证明。
- 未继续验证：全 backend/typecheck、百万级真实性能曲线与第三方替代方案；按收口指令标为 unverified，不据此新增 finding。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/src/lib/history/queries.ts:335-414` — 已持久化的 recent terminal 绕过 strict sidecar ID 集合。
证据/失败场景：335–338 独立全文匹配 recent，409 无条件合并；413 调用的 `compileSummaryWhere`（`v3/summary-store.ts:39-87`）不含 search。recent 行已落盘但 native 漏 ID 时，HTTP 仍返回该行且 total 不含它，错误 index 可 false-green。
修复建议：冻结时区分真正 transient 与已持久化；后者只以 sidecar membership 准入，并增加 sidecar 故意漏 recent-persisted ID 的真实链路 mutation。

[major] `/home/xp/src/copilot-api-js/src/lib/history/queries.ts:331-414` — sidecar await 前后重分类使 entries、total、cursor 不属同一快照。
证据/失败场景：331–344 冻结 recent/in-flight/target，354 await 后 413 又读 live DB。pending recent 在等待中落盘时仍进 entries，却既不计 frozen sidecar total 也不计 transient，可得 `entries.length=1,total=0`。
修复建议：请求前冻结每个 overlay ID 的持久化归属，或使用 versioned snapshot；用 deferred `listSearch` 在 await 窗口提交记录并断言三项一致。

[major] `/home/xp/src/copilot-api-js/src/lib/history/queries.ts:106-110,119-135` — `state` 覆盖 `success`，违反已冻结的 AND 语义，测试还把错误行为固化为正样本。
证据/失败场景：`statesForSearch` 有 state 即丢 success，内存 filter 也仅在无 state 时检查 success；spec `docs/spec/2026-07-28-history-filter-semantics.md:190-192` 要求冲突为空。`summary-query.it.test.ts:196-200` 却期待 failed 行通过 `state=failed&success=true`。
修复建议：建立 SQL/native/in-memory 共用的 filter 归一化，对冲突生成恒 false；将错误断言改为空，并做正负双控。

[major] `/home/xp/src/copilot-api-js/native/history-search/src/lib.rs:255-383` — list-search 每次物化并加载全部全文命中，资源复杂度随全库线性增长。
证据/失败场景：269–278 用 `TopDocs::with_limit(num_docs)` 收齐命中，287–383 再逐文档过滤、排序；计划 `docs/plan/2026-08-06-history-read-path-and-h2-diagnostics.md:133-135` 要求 fast-field keyset 与 `limit+1`。常见词/空 query 在大库会触发 5s timeout→503。
修复建议：collector 层下推结构 filter、target、tuple cursor，只保留 ordered `limit+1`；exact total 用 count collector，并建立大库常见词性能 gate。

[major] `/home/xp/src/copilot-api-js/src/routes/history/handler.ts:63-71` — list 参数没有枚举、有限数与范围校验，错误输入会变 500/503 或放大资源消耗。
证据/失败场景：数值直接 `parseInt`，枚举直接 cast；strict path 把结果送入 Rust `u32`（`native/history-search/src/lib.rs:46-65`）。负数、NaN、超 u32 limit 分别可触发 N-API/SQLite 错误，未知 direction 静默当 older。
修复建议：HTTP 边界共享 schema，校验整数/有限/上限、枚举与 from≤to，无效输入统一 400；普通与 strict path 共用 normalized DTO。

[major] `/home/xp/src/copilot-api-js/src/lib/history/search/daemon.ts:155-183,312-317,508-519` — durable cursor 未绑定 Tantivy generation，可把重建出的空 index 认证为完整。
证据/失败场景：启动直接把 `tail-cursor.json` 当 flushed frontier；native `open_index`（`native/history-search/src/lib.rs:111-140`）在 index 不可打开时新建空 index。实测保留 FORMAT＋cursor、删 index 数据后，native 返回 `total:0` 且 `invalidCursor:false`，旧 target 仍会通过 daemon attestation。
修复建议：cursor 与 index commit generation/identity 原子绑定并在启动交叉验证；不一致即失效 cursor、全量 re-tail，完成前拒绝 listSearch；补“旧 cursor＋空/损坏 index”重启反例。

## 主观建议

未提出；本报告只保留已闭合的 blocker/major。

## 增量复核：`c23ed804..fa2bfd2d`

- 绑定：`git show -s --format="%H %P %s" fa2bfd2d` → `fa2bfd2d902af444517b2fed1a44428c8bb47367 77cc765f... perf(history): keyset summary backfill`；区间仅含 `77cc765f`、`fa2bfd2d`。
- 变更面：`git diff --name-status c23ed804..fa2bfd2d` 仅改 `v3/store.ts`、`v3/summary-store.ts`、`summary-projection-migration.it.test.ts`；六条 finding 的核心实现文件 `queries.ts`、native `lib.rs`、`handler.ts`、`daemon.ts` 均无 diff。未重跑测试。
- 增量 verdict：0 blocker / 6 major，六条均仍成立；两个新提交只优化 summary backfill/readiness，不修 A3 strict list-search。

1. **仍成立** — recent-persisted 绕过 sidecar IDs：`fa2bfd2d:src/lib/history/queries.ts:335-338` 仍独立生成 recent，`:409` 仍无条件合并，`:413-414` 仍用不含 search 的 live SQL membership 计算 total。
2. **仍成立** — await 快照撕裂：`fa2bfd2d:src/lib/history/queries.ts:335-354` 先冻结 overlay/target 并 await，`:403,413-414` 仍分别使用 frozen sidecar total 与 await 后 live DB 重分类。
3. **仍成立** — state 覆盖 success：`fa2bfd2d:src/lib/history/queries.ts:106-110,131-135` 与 `src/lib/history/v3/projection.ts:467-470` 仍以 `!state` 为 success 检查前提；未见契约/测试修正。
4. **仍成立** — native 全命中物化：`fa2bfd2d:native/history-search/src/lib.rs:269-287,377-383` 仍以 `num_docs` 作为 TopDocs limit、逐文档过滤后全量排序。
5. **仍成立** — query parsing 无校验：`fa2bfd2d:src/routes/history/handler.ts:36-47,63-71,251` 仍直接 cast/`parseInt`，没有有限数、范围或枚举 gate。
6. **仍成立** — cursor 未绑定 index generation：`fa2bfd2d:src/lib/history/search/daemon.ts:315-316,508-519,552-554` 仍从独立 cursor 文件初始化 flushed frontier，并仅凭该 frontier 认证 target。

- C5 增量观察：`fa2bfd2d` 新 backfill keyset 位于 `v3/summary-store.ts:479-523` 附近，未触及 client registry/core SCC；本轮未重跑 SCC guard，故“fa2bfd2d 未增加 SCC”仅有变更面证据，运行态结论标为 unverified。
