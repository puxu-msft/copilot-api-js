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

判据必须是**独立结构信号**，不是 coarse 分类（endpoint）。这里流式 ⟺ 有 `sseEvents`。**关键坑：结构信号的存储位置随历史漂移，须查全部位置**——`sseEvents` 存于两个 entry 字段（`context/request.ts` 确认穷尽；**注**：backfill 直读原始存储 blob，见到的是 **legacy 存储字段名**，非 getEntryById 读适配器映射后的 client/upstream 腿）：`entry.sseEvents`（driver `setSseEvents` → top-level `sse_events` stage，2026-06-20 起）与 `entry.inboundResponse.sseEvents`（pump `setForwardedResponse` → `inbound_response` stage，全时期；新写路径落 `client_response`/`upstream_response`，但新行生来 `usage_normalized=1`、backfill 不触及），且各有 stage-split 与 legacy-single-blob 两种落盘形态。只查 top-level `sse_events` stage 会漏 pre-driver 窗口的净值行 → 仍双减（见 `isGeminiAlreadyNet` 的三分支）。

**偏向「已变换/跳过」是安全方向**：误判 total 行 → 留 total 不腐蚀；误判 net 行 → 双减腐蚀。

**结构信号的存储位置还取决于本 backfill 在链中的位置**（2026-07-12 cache-write-backfill 实例）：usage-normalize 只见 legacy 布局（新行生来 `usage_normalized=1` 被跳过），故读 `sse_events` stage / `inbound_response` stage / legacy blob。但**由后加的标记列门控 + 串在 legacy-stage 迁移之后**的 backfill（如 `cache_write_backfilled`，列晚加故 post-migration 行也 =0）看到的是**已迁移的新布局**——`extractStagePayloads` 从不发独立 `sse_events` stage，把帧**嵌进 `upstream_response` stage payload 的 `.sseEvents`**（per attempt_index），且 legacy-stage 迁移 `DELETE FROM entry_stages` 清掉旧 stage、head blob 经 `extractHeadMetaPayload` 剥掉 `sseEvents`。此类 backfill 帧源**主读** `upstream_response` stage（max attempt_index，与列派生源 `attempts.at(-1).upstreamResponse` 对齐、与 usage 写回目标同一行），`sse_events` stage / head-blob 仅作未迁移 fallback。**踩坑**：手搓 `sse_events` stage 夹具时 6 个 golden 全绿，但对生产 post-migration 行是**静默 no-op + 永久误标记**（走 `!split` 分支 markStmt），合并态审查用真实 write-path 探针才逮住——正是下方「测试纪律」第一条的反面教材（先读本 skill 再写 backfill 可免此坑）。

### ③ 双写两处同改，防 list/detail 分叉

同一字段常存两处：列（list / sessions-agg / stats 读）与 blob 的 `upstreamResponse.usage`（detail 页经 `assembleFullEntry` 读，finalized 新行落 `upstream_response` stage 行；旧行落 `outbound_response` stage/head blob，经读适配器 `adaptLegacyLegsInPlace` 呈现为 `attempts[final].upstreamResponse.usage`）。只改列不改 blob → 同行两视图分叉。两腿各自**独立读 + 独立减**，绝不共享一个 usage 对象对两源各减一次（内存别名会双减）。

## 与 live 写路径共存的一次性迁移 backfill（telemetry JSON→SQLite 迁移实例，两条正交铁律）

当 backfill 是**把旧存储一次性吸收进一个 live 写路径也在并发写的新聚合 store**（本项目：旧 `request-telemetry.json` 吸收进 `telemetry.db`，而 dual-write 同时在写 `tel_raw`/`tel_cumulative`），除上述三条铁律外还有两条：

- **① disjointness 靠结构不靠时序——消费冻结快照，不重读可变源**：backfill 与 live 若对同一 store 写「不相交请求集」（旧数据=启动前 / dual-write=启动后），别让 backfill **重读那个 live 也在写的可变文件**——旧 JSON 会被 post-listen persist tick 折回 post-startup 数据，backfill 若在 persist 之后 `readFile` 就把 dual-write 已写的 post-startup 请求**再导一次**（当前桶双计）。默认配置几乎不可达、跨重启双计由 version 守卫结构性关闭，但**项目对双计持最高优先级**：改为 init 时刻把 JSON 内容 **stash 进模块变量冻结快照**（与载入 live cache 同一读），backfill 消费冻结快照而非重读 → disjointness 从时序保证升为**结构保证**。（合并态评审抓，root-cause-over-patch。footgun：若为消迁移 transient 而「backfill 后再 rebuild live cache」，注意 rebuild 若是覆盖非 merge 会丢未 drain 的 live 增量，须先 flush。）
- **② backfill 必须应用与 live 同一有损变换（cap 折叠）**：live 路径对 capped 维度做 `≥cap→"other"` 折叠、写有界的持久 store（`tel_cumulative` cap 权威由 `seedCumulativeCapKeys` 从它重建）。backfill 若**不折**、逐 legacy key 无条件写（legacy 跨桶 union 可 >cap），则持久 store 基数越界 → 下次重启 seed 继承 **over-cap 集** → live 的 `size>=cap` 恒真 → **停止跟踪新 key（活路径永久降级）**。故 backfill 对 capped 维度**必须复用 live 的同一 cap 折叠**（同 cap 值来自 config、同 `CAPPED_DIMENSION_NAMES`），结果与「live 遇同样 >cap 键」一致、忠实。这是 §②「排除姊妹路径」的镜像——不是排除已变换子集，而是**让 backfill 的变换与 live 一致**。有 bucket 维的 raw 腿不需额外折（legacy 已 per-bucket cap、逐桶导入即保留）。



- 用**真实写路径** `insertCompletedEntry`（→ stage-split 布局）造夹具，别手造 blob（自洽夹具测不到真实布局，见 [[feedback-pass-null-clean-not-self-validating]]）。
- 断言列**与** `getEntryById().attempts.at(-1)?.upstreamResponse?.usage`（detail 路径，经读适配器）**同时**为终态值（防分叉）。
- 独立 oracle：期望值手算（如净值 = total − cached，对齐 GHC `translator.py`），别用被测代码回推。
- 覆盖矩阵：各布局（top-level stage / inbound_response stage / legacy 两种）× 已变换/未变换 × 坏 blob 跳过不标记 × 清标记二次跑腐蚀 × 协作停续跑 × ties。
- 隔离：`useIsolatedRuntime`，并在 `RESETTERS` 注册 `resetXxxBackfillForTests`（skill `test-isolation`）。

## 相关记忆

- [[methodology-recoverable-backfill-cooperative-stop-and-keyset]] —— 协作停/keyset/meta-flag/dedup tripwire 的更细战例。
- [[methodology-derived-column-backfill-targeted-and-nonblocking]] —— 靶向解压 + 非阻塞的踩坑记录。
