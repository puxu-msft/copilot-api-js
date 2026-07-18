---
name: archive-background-lifecycle
description: 当在 copilot-api-js 修改 History Archive 的 HOT→T1 搬迁、T1 compact、T2 seal、后台 worker、shutdown/重启续跑、seal file/locator/manifest 提交协议时使用——durable unit 边界协作停、producer seal→owned-unit drain→close、并发 sibling 所有权、不可变 session-generation、file+directory fsync、多 artifact 可重放提交与真实恢复测试。
---

# Archive 后台任务生命周期与可恢复提交

Archive 是**可恢复后台维护**，不是 shutdown durability。History terminal record 与 Telemetry outbox 必须在首次关闭信号下尽力 drain；Archive backlog 则在首信号时停止领取新工作，只让已领取 durable unit 完成到可恢复提交点，剩余工作下次启动继续。

## 1. 三类 durable unit

- HOT→T1：一个 session-atomic migration batch。每条 entry 按 copy archive→verify all sub-tables→delete HOT 提交；batch 返回后才 checkpoint。
- T1 compact：一个 session generation。把当前 session 可见 entry 写入不可变 T1 seal file，发布文件后在一个 archive transaction 更新 locators；旧 generation 仅在 DB 证明零引用后删除。
- T2 seal：一个 session generation。发布不可变 T2 seal file，随后在一个 archive transaction 写 manifest、清 T1 locator、删 T1 head。

**停止点只能在 unit 提交后。** 不在 SQLite transaction 中、不在 temp file 写到一半时、不在 manifest/locator 之前响应 graceful stop。第二个终止信号仍由进程 lifecycle 直接强退，Archive 不拦截。

## 2. 正确 shutdown 顺序

1. `stopArchiveBackgroundWork()` seal producer，禁止领取下一个 unit。
2. 已领取 unit 完成自己的 file/DB commit。
3. 每个 unit 后 macrotask yield，再读 stop flag。
4. `drainArchiveBackgroundWork()` 等全部**已领取** unit settle。
5. 才允许 `closeDatabase()` / `closeArchiveDb()`。

禁止在 shutdown 中调用“drain whole backlog”、compact all、seal until cap、schema migration或新 retry pass。`shutdownHistory()` 可以 drain/retry 已接受的 terminal finalizations；它们是 canonical durability，不是 Archive maintenance。

## 3. 并发 worker 所有权

有界并发意味着 stop 到达时最多已有 `concurrency` 个 unit 被领取。必须全部完成或失败后，外层 tracked worker 才能 settle。

- 禁止 `Promise.all()` fail-fast 后直接结束 tracked promise：一个 sibling reject 时，其他 sibling 仍可能写文件/DB；shutdown 会误判静止并关闭 DB。
- worker pool 每次只领取一个 unit，完成后 checkpoint；任一失败设置“停止新领取”，但仍 `await` 全部已领取 sibling。
- tracked fire-and-forget promise 必须 never-reject；业务错误在 pipeline 边界日志化，不能由派生 `.finally()` rejection 落到全局 `unhandledRejection`。
- `activeWorkers` 是资源所有权集合，不是进度统计。只有真正静止才能删除。

活实现：`src/lib/history/sqlite/archive-worker.ts`。

## 4. 不可变 session-generation

“一个 session 永久一个文件”是错误形状：session 已封存后可能继续产生新请求。若后续 generation 覆盖同名文件，旧 locator/manifest 会静默指向新内容。

- T1/T2 文件名必须包含 session identity + generation identity。
- generation identity 由本轮有序 entry-id 集合的 SHA-256 截断派生；同一未提交 unit 重试复用 orphan 文件名，后续新增 entry 产生新文件。
- 不用 32-bit hash 做 generation disambiguator；碰撞后果是旧 generation 被覆盖，属于数据丢失。
- 增量 T1 compact 提交新 locators 后，只删除全库 locator 查询确认零引用的旧 generation。
- T2 seal transaction 同步删除被封存 entry 的 T1 locator，避免长期 orphan rows。

## 5. 文件与 SQLite 双 artifact 提交

Seal file 和 locator/manifest 是两个 artifact，无法用一个 SQLite transaction 原子覆盖。正确顺序：

1. 写唯一 `.tmp`。
2. `fsync(tmp file)`。
3. atomic rename 到 final immutable path。
4. `fsync(parent directory)`，保证 rename 目录项在 POSIX power loss 后持久。
5. SQLite transaction 写 locator/manifest，并删上一层源行。

Crash 前缀必须都可重放：

- 写 tmp 前/中崩溃：下次删 tmp 重写。
- final file 已发布、DB 未提交：源行仍在，下次以同 generation 名重写/复用后提交。
- DB 已提交：manifest/locator 指向已 durable-published 文件。

Legacy rename 不能“rename old→new，再 update manifest”：中间崩溃会让 manifest 指向不存在的旧名，且新名不再匹配 legacy scanner。改用 copy old→tmp→durable publish new→update manifest→delete old；每个 crash prefix 都仍有至少一对可读 file+pointer，下次可重放。

## 6. 可恢复进度来源

不要为 Archive backlog 额外维护脆弱的内存 cursor：

- HOT→T1 由 HOT 剩余行查询恢复。
- T1 compact 由“无 `tier1_locator` 的 archive head”查询恢复。
- T2 seal 由 archive head + live size cap 查询恢复。
- 已完成 generation 由 locator/manifest 指向 immutable files。

内存 `stopRequested` 只控制当前进程是否继续领取，不是真相源。新 `initHistory` generation 必须明确 reset seal；测试 reset 必须登记 `RESETTERS`。

## 7. 测试 oracle

必须覆盖以下真实 seam，不能只测人工 promise：

- HOT→T1：stop 后完成当前 batch，HOT 剩余行下一次 worker 全部迁完。
- T1 compact：同 session 首 generation→新增 entry→二次 compact；旧新 entry 都读回正确，旧零引用 file 被回收。
- T2 seal：同 session 首 generation→新增 entry→二次 seal；两个 manifest 指向不同 immutable files，旧新内容都正确。
- sibling failure：一个 unit 立即 reject、另一个卡 barrier；外层 worker/drain 在 sibling 完成前不得 settle。
- shutdown drain：stop→drain 期间 DB 保持可查询；drain 返回后才能 close。
- restart 接线：运行实例日志 sha 晚于提交；HOT API 必须正常；Archive API 在 config disabled 时返回 `409 archive_unavailable`，在 enabled 且 initialized 时返回正常响应，绝不能抛内部“DB not initialized”500。
- 正向校准：临时恢复 fail-fast 或去掉 generation hash时，相应测试必须红；绿不自证。

## 8. 与相邻 skill 的边界

- `process-lifecycle-shutdown`：进程两信号契约、请求 drain/abort/force、History/Telemetry durability barrier 与 PTY 验收。
- `history-backfill`：行级 backfill 的 meta/version、compound keyset、每批协作停。
- `persistence-async-invariants`：canonical terminal/outbox 的 drain-before-close、pending set、never-throw。
- 本 skill：跨文件+SQLite artifact 的 Archive durable units、worker ownership、immutable generations 与 shutdown/restart 恢复。
