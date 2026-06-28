---
name: methodology-recoverable-backfill-cooperative-stop-and-keyset
description: 可恢复后台 backfill 的生命周期方法论——协作式 stop 须匹配关资源的 shutdown phase、compound keyset 跨 ties 无损、meta-flag 守卫非 user_version、内容寻址须 dedup-ratio tripwire
metadata:
  type: project
---

可恢复后台 backfill（search_index：历史行全量建索引）的四条生命周期方法论，扩展 [[methodology-derived-column-backfill-targeted-and-nonblocking]]（那条管"靶向解压+非阻塞"，本条管"可恢复+优雅中止"）。

**① 协作式 stop 必须匹配「关资源的 shutdown phase」，不订阅迟到的 abort signal。** 正解：新增模块级 `stopXxx()`（置 flag），在关资源**之前**调它；loop 每批查 flag（经 getter 函数读，防 TS 把 module-global narrow 成常量 false）。硬关兜底=每批存游标 + 每个 DB op try/catch（DB 在脚下关→优雅退出不崩）。**本项目现状**（finalize-async 重构后，见 [[methodology-sync-to-async-persistence-refactor-invariants]]）：`stopSearchIndexBackfill()` 由 `stopHistoryBackgroundWork()` 在 graceful Phase 1 早停（自有 flag、不靠 abort signal），而 `closeDatabase()` 已**从 Phase 1 移到 finalize() 阶段**（请求 drain 之后）——backfill 仍在 DB 关之前停住、契约不变，但"DB 在 Phase 1 关"这条旧事实已作废。**通用教训**：协作式取消的检查点与"谁先关掉它依赖的资源"必须对齐，别假设取消信号比资源回收先到，也别把"资源何时关"的具体相位硬编码进推理（它会随重构移动）。

**② compound `(主序, tiebreak)` keyset 分页跨 ties 无损；coarse cursor + skip-built 让 resume 不漏不重。** 单列 `started_at` 游标在 ties（同毫秒簇 > batch size）会丢行（advance +1 跳过簇内剩余 / 不 advance 死循环）。修=`WHERE started_at > ? OR (started_at = ? AND id > ?) ORDER BY started_at, id`。持久游标只存 coarse `started_at`（resume 时 `id > ""` 重含整个边界毫秒，已建行经 per-entry `SELECT 1 跳过`去重）。**测 ties 要造 >batch 同 ts 簇**；测协作 stop 要 >batch 行 + 在第一批同步跑完后的 `await sleep(0)` yield 期设 flag（确定性、非 flaky）。

**③ 迁移守卫用专属 `history_meta(version)` flag，绝不读 `PRAGMA user_version`。** 旧 preview-backfill 用了 user_version=1；新 backfill 若也读 user_version 会被旧标志误判"已完成"而跳过。专属 meta key 解耦各迁移的完成标志。

**④ 内容寻址 dedup 必须有 ratio tripwire。** `total req_msg / distinct msg_blob` 远低于实测基线（~40×）即 WARN——归一化 strip-list 漏一种易变子串→该类消息每轮 re-hash→去重退化→悄悄 bloat（正是本特性要消的 2.77GB 问题）。把隐性 landmine 变可检测回归，呼应 [[feedback-pass-null-clean-not-self-validating]]。完成时 + 每启动算并存 history_meta + 日志。

落地：`src/lib/history/sqlite/search-index-backfill.ts`、设计 `docs/rfc/search-index-content-addressed.md`。
