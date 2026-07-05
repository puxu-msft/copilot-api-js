---
name: history-backfill
description: 当在 copilot-api-js 写或改 History 层的后台 backfill 时使用——可恢复骨架（history_meta version 守卫、(started_at,id) keyset 续跑、协作 stop、非阻塞分批、never-throw）与破坏性变换的三条铁律（per-row 标记列幂等、排除姊妹路径已变换的子集、双写列+blob 防 list/detail 分叉）。活范例 search-index-backfill / usage-normalize-backfill；接线在 state.ts。
---

# History 后台 Backfill

对历史行做后台重算/回填（建索引、重算派生列、变换已存字段）的操作手册。活范例：`src/lib/history/sqlite/search-index-backfill.ts`（建 search_index + 重算 preview_text）、`src/lib/history/sqlite/usage-normalize-backfill.ts`（usage 净值化）。

## 权威真相源（优先读，别凭记忆）

- 骨架与生命周期：`search-index-backfill.ts`（最完整的范例）。
- 接线：`src/lib/history/state.ts`（`startHistoryBackfills` 串联 usage→search、`stopHistoryBackgroundWork` 在 `closeDatabase` 前停）、`src/start.ts`（server 监听后 fire-and-forget）。
- 完成守卫/游标键：`src/lib/history/sqlite/meta.ts`。
- schema 列/表结构：skill `history-sqlite-schema`。

## 可恢复骨架（每个 backfill 都要有）

- **完成守卫**：`history_meta(xxx_version)`，跑完整表才置位；**绝不读 `PRAGMA user_version`**（旧库可能已 =1，会误判已完成而跳过）。
- **续跑游标**：`history_meta(xxx_cursor)` 存 coarse `started_at`；compound `(started_at, id)` keyset 分页跨 ties 无损（单列游标在同毫秒簇 > 批大小时丢行）。
- **协作停**：模块级 `stopXxx()` 置 flag，在**关资源之前**由 `stopHistoryBackgroundWork` 调（不订阅迟到的 abort signal——DB 可能已关，post-close prepare 会抛）；loop 每批经 getter 函数读 flag（防 TS 把 module-global narrow 成常量 false）。
- **非阻塞**：`start.ts` 监听后 fire-and-forget，每批 `await sleep(0)` 让出，批间不持事务，**绝不进 `openDatabase` 同步路径**；每 N 批 `PRAGMA wal_checkpoint(PASSIVE)`。
- **双重 never-throw**：每个 DB op try/catch（DB 在脚下关→优雅退出不崩）+ 顶层 catch（背景任务逃逸 reject 会崩进程）。
- **靶向解压**：只解需要的 stage，别 `assembleFullEntry` 拉全生命周期（含最大的 sse_events）——4.2G 库全解压卡 3m53s。

## 破坏性变换的三条铁律

变换是破坏性算术/覆盖（如 `input_tokens -= cache_read`、原地改字段）时，除骨架外必须：

### ① 幂等靠 per-row 标记列，不靠「结果是否已终态」自检

破坏性减法二次执行会腐蚀（`input=1000, cache=400` 跑两次 → 600 → 200）。`net === rawInput ? skip` 分不清「无缓存本就相等（1000−0）」与「已减过」，两者都误判跳过。

正解：加标记列（如 `entries_v2.usage_normalized INTEGER NOT NULL DEFAULT 0`），仿 `pinned` 走 `migrateEntriesColumns` 的 ALTER（`SCHEMA_SQL` 同写给新库；**非** Umzug DDL）。**新行 `buildHeadRow` 恒置 1**（生来即终态，且所有 `ON CONFLICT DO UPDATE SET` 路径都含 `= excluded.xxx`，eager/status/finalize 多次 upsert 不回退）；backfill scan `WHERE xxx=0`，per-entry tx 内「改数据 + 置 1」原子完成。标记是**唯一**防线（version 守卫只挡整表重跑；标记挡 re-finalize / 部署窗口 / 单行）。用**非 optional** TS 字段强制所有 `EntryRow` 构造点覆盖（编译期站点证明，含 legacy 迁移脚本）。

测试须显式证明：清标记再跑会二次减到 200 —— 文档化「行级自检不足以幂等」。

### ② 排除姊妹代码路径已变换过的子集

同一 endpoint 的两条腿语义可能不一致。实例：Gemini **流式**腿经 codec `convert-response.ts` 早已把 `promptTokenCount` 净化（2026-06-05 起），**非流式**腿才存含缓存总量——按 endpoint 一刀切减会把已净值的流式历史行**双减腐蚀**。

判据必须是**独立结构信号**，不是 coarse 分类（endpoint）。这里流式 ⟺ 有 `sseEvents`。**关键坑：结构信号的存储位置随历史漂移，须查全部位置**——`sseEvents` 存于两个 entry 字段（`context/request.ts` 确认穷尽）：`entry.sseEvents`（driver `setSseEvents` → top-level `sse_events` stage，2026-06-20 起）与 `entry.inboundResponse.sseEvents`（pump `setForwardedResponse` → `inbound_response` stage，全时期），且各有 stage-split 与 legacy-single-blob 两种落盘形态。只查 top-level `sse_events` stage 会漏 pre-driver 窗口的净值行 → 仍双减（见 `isGeminiAlreadyNet` 的三分支）。

**偏向「已变换/跳过」是安全方向**：误判 total 行 → 留 total 不腐蚀；误判 net 行 → 双减腐蚀。

### ③ 双写两处同改，防 list/detail 分叉

同一字段常存两处：列（list / sessions-agg / stats 读）与 blob 的 `outboundResponse.usage`（detail 页经 `assembleFullEntry` 读，finalized 落 `outbound_response` stage 行、legacy 落 head blob）。只改列不改 blob → 同行两视图分叉。两腿各自**独立读 + 独立减**，绝不共享一个 usage 对象对两源各减一次（内存别名会双减）。

## 测试纪律

- 用**真实写路径** `insertCompletedEntry`（→ stage-split 布局）造夹具，别手造 blob（自洽夹具测不到真实布局，见 [[feedback-pass-null-clean-not-self-validating]]）。
- 断言列**与** `getEntryById().outboundResponse.usage`（detail 路径）**同时**为终态值（防分叉）。
- 独立 oracle：期望值手算（如净值 = total − cached，对齐 GHC `translator.py`），别用被测代码回推。
- 覆盖矩阵：各布局（top-level stage / inbound_response stage / legacy 两种）× 已变换/未变换 × 坏 blob 跳过不标记 × 清标记二次跑腐蚀 × 协作停续跑 × ties。
- 隔离：`useIsolatedRuntime`，并在 `RESETTERS` 注册 `resetXxxBackfillForTests`（skill `test-isolation`）。

## 相关记忆

- [[methodology-recoverable-backfill-cooperative-stop-and-keyset]] —— 协作停/keyset/meta-flag/dedup tripwire 的更细战例。
- [[methodology-derived-column-backfill-targeted-and-nonblocking]] —— 靶向解压 + 非阻塞的踩坑记录。
