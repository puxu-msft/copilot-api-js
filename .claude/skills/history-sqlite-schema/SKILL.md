---
name: history-sqlite-schema
description: 当需要了解 copilot-api-js 当前 History V3 SQLite 结构时使用——history-v3.db semantic CAS/manifest/tracks/timeline/journal/search、可选 raw.db exact-byte CAS、artifact identity、zstd 编码与直接查库。旧 history.db/archive.db 仅作退役 V2 取证，不是当前在线 schema。
---

# History SQLite Schema

## 权威真相源（优先用，别凭记忆）

- **专门活文档**：`docs/history-v3-schema.md`——当前表/列/PK/FK/索引、编码、journal、raw generation、运维查询的 SSOT。
- **Semantic DDL**：`src/lib/history/v3/store.ts` 的 `V3_SCHEMA_SQL`。
- **Raw DDL**：`src/lib/history/raw/manager.ts` 的 `RAW_SCHEMA`。
- **artifact identity / connection PRAGMA**：`src/lib/history/sqlite/connection.ts`。
- **驱动分流**：`src/lib/history/sqlite/driver.ts`（Bun `bun:sqlite` / Node `node:sqlite`）。
- **默认文件**：`~/.local/share/copilot-api/history-v3.db`；raw capture 开启时另有 `raw.db`。旧 `history.db` / `archive.db` 不被在线服务打开或迁移。

## 当前表

| 文件 | 表 | 角色 |
|---|---|---|
| `history-v3.db` | `history_store_identity` | owner marker；防误开旧库 |
| `history-v3.db` | `v3_meta` | V3 元数据预留表，当前无生产 reader/writer |
| `history-v3.db` | `v3_objects` | semantic payload/frame CAS |
| `history-v3.db` | `v3_operations` | terminal operation 根行、value-free manifest、pin |
| `history-v3.db` | `v3_tracks` | operation-local ordered payload/frame handles |
| `history-v3.db` | `v3_timeline_chunks` | sequence timeline chunks |
| `history-v3.db` | `v3_journal` | self-contained crash recovery journal；成功提交后删除 |
| `history-v3.db` | `v3_search_objects` / `v3_search_membership` / `v3_search_backlog` | 可重建搜索派生、operation membership、失败 backlog |
| `raw.db` | `raw_store_identity` | raw artifact generation identity + schema/codec |
| `raw.db` | `raw_objects` | exact-byte CAS |
| `raw.db` | `raw_refs` | operation/sequence/track → raw object 或显式 gap |

**dispatch timing 四刻无独立列**：`ModelOperationDispatch.timing` 的绝对 epoch 四刻（`upstreamHeadersAt` / `upstreamMessageStartAt` / `upstreamFirstTokenAt` / `upstreamLastTokenAt`，采集于 `src/lib/pipeline/driver.ts:642-643`）随 `v3_operations` 的 value-free manifest JSON（及 `v3_journal` 恢复态）序列化，**无 SQLite schema 迁移、无专列**——直接查库看不到独立字段，须经 `/history/api/entries/:id` 的 `attempts[].timing` 投影读出（`src/lib/history/v3/projection.ts:277-283`）。诊断用途见 spec `2026-07-23-upstream-silence-commit-timing.md` §3（GHC deferred-header）。

## 直接查库

```bash
sqlite3 ~/.local/share/copilot-api/history-v3.db ".tables"
sqlite3 ~/.local/share/copilot-api/history-v3.db ".schema v3_operations"
sqlite3 ~/.local/share/copilot-api/history-v3.db "SELECT operation_id,kind,revision,pinned,created_at,committed_at FROM v3_operations ORDER BY created_at DESC LIMIT 20"
sqlite3 ~/.local/share/copilot-api/history-v3.db "SELECT operation_id,revision,phase,error FROM v3_journal ORDER BY created_at"
sqlite3 ~/.local/share/copilot-api/raw.db "SELECT store_id,schema_version,codec FROM raw_store_identity"
sqlite3 ~/.local/share/copilot-api/raw.db "SELECT operation_id,sequence,track,capability,status,error FROM raw_refs WHERE capability <> 'available'"
```

完整运维 SQL 与列级解释见 `docs/history-v3-schema.md`。运行中一致性读取优先走 `/history/api/*`，不要跨多表手工拼装后声称得到原子快照。

## Legacy V2 边界

下文关于 `entries_v2`、`entry_stages`、`msg_blob`、backfill、reaper、Umzug 和旧 FTS 的内容只用于历史取证或理解退役代码；它们不是当前在线 History V3 schema。不得据此给 `history-v3.db` 写迁移，也不得把旧 `history.db` / `archive.db` 接回生产。

`blob_gz` 是 zstd（magic `28b52ffd`，旧库 gzip `1f8b`）：解压用 `compression.ts` 的 `decompress`。`entry_stages.stage`（**新写路径**）∈ client_request/client_response/effective_source/upstream_request/upstream_response/sse_events（finalized 后请求侧腿合并进 request_group 容器帧）；**legacy 只读**：旧行仍带 inbound_request/effective_request/outbound_request/outbound_response/inbound_response，读时经 `adaptLegacyLegsInPlace`（serialize.ts）适配为 client/upstream 新腿——`STAGE` 常量双列新旧名共存。**运行时 vs 持久化命名**：live `RequestContext`（`Attempt.{effectiveRequest,wireRequest,response}`、`_httpHeaders` 捕获袋）保留旧名，仅持久化 `HistoryEntry` 采用新腿。**勿对运行中库直读**——live churn 致 torn snapshot，用 `/history/api/entries/:id`（全腿全量 `assembleFullEntry`）。

## blob 压缩 / dedup 策略（为什么是合并帧）

要 dedup 多个**高度相似的大 blob**（同一请求逐 attempt 的 `effective_source`/`upstream_request` 请求体，>90% 共享 `env.body`——旧行则是 inbound/effective/outbound 三份；`client_request`/`client_response`/`upstream_response` **非**合并帧成员），**zstd `dictionary` 选项无用，合并帧才有效**（copilot-api 存储瘦身实测裁决）：

- **per-blob 字典无增益**：用 blob A 当字典压 blob B——`node:zlib zstdCompressSync(B,{dictionary:A})` 与 `Bun.zstdCompressSync(B,{dictionary:A})` 对大 blob 均无增益（245→245KB）。字典没把内容当匹配源（可能只对"大量小同构文档"有效）。
- **合并帧有效**：`[A+B+C]` 拼一个 buffer 单次 zstd → 3224KB raw 压到 231KB = 单份 A 同值，第 2/3 份近零成本。

所以纯 zstd 的 dedup = **把关联 payload 拼成 JSON 数组单次压缩存一行**（非二进制 framing——JSON 自表达边界、消手写 uint32/int16 可错面；非手动剪 JSON/存 diff——每份仍逐字 round-trip）。落地为 `request_group` 合并帧（`serialize.ts` `partitionStagesForWrite`/`decodeStageRows`）。

**gzip→zstd 升级（bun-first 合规）**：`node:zlib` 的 zstd 跨 Bun/Node 可用（`zstdCompressSync`/`zstdDecompressSync`，Bun 1.3.14 / Node ≥22.15 实测）——无新依赖、无 node-gyp。zstd L3 实测比 gzip 砍半（505→261KB）、~7ms/1.2MB。magic bytes `1f8b`(gzip)/`28b52ffd`(zstd) 可靠判别新旧格式做混存向后兼容，无需自定义版本字节。（存储瘦身里 VACUUM 才是 2GB 根因，zstd/dedup 是次要——见 skill `empirical-verification` 的 SQLite 膨胀节。）

## reaper / 双源

reaper 按 status 分桶（success/failure 各上限），active+pinned 行豁免、不计名额。读取 in-flight 优先（`getInFlight ?? getEntryById`），active 请求恒读内存全量。详见 docs/history.md。

## 迁移（Umzug hybrid forward-runner）

001+ 前向 DDL 进 `migrations/`，须幂等（`PRAGMA table_info` 探测）；openDatabase 的 inline reconcile 是 000 地板不进账本。bun:sqlite `db.transaction` 回调必须同步（跨 await 不回滚）。写/改后台 backfill 见 skill `history-backfill`。

把散落在 `openDatabase` 的命令式 schema reconcile **升级为一等迁移框架**（2026-06-28 采 Umzug、弃 drizzle-kit）时的可复用方法论：

- **集成用 hybrid，别动既有地板。** 想把 `initHistory`/`openDatabase` 改 async + 重构成 Umzug 跑全部——实测不可行：async ripple ~20+ 文件（12+ 测试调用者 + bootstrap 扇出）+ chicken-egg（Umzug 在建账本表前就调 `storage.executed()` 读账本，账本表此刻还不存在）。正解：既有幂等 reconcile（`SCHEMA_SQL`+`migrateEntriesColumns`+bespoke drop）留作 conceptual **000 地板、不进账本**；新增独立 async `applyForwardMigrations` 只追 **001+ 前向 DDL**，在 `initHistory(true)` 后、`startServer` 前跑一句。ripple 近零（只一处接入）。
- **storage 双 guard 使 runner 与开库顺序解耦。** `HistoryMetaStorage` 构造即 `CREATE TABLE IF NOT EXISTS history_meta` + `executed()` 表缺返 `[]`——即便无地板也自足、可隔离测（裸 `:memory:`）。账本落既有 KV 表（`history_meta(schema_migrations)`，与 `search_index_version` 同表）= 统一账本，非另起 migrations 表。
- **spike 须复现真实接线、别预建被测对象。** bun spike 的 `CREATE TABLE history_meta` 预建掩盖了 chicken-egg；node spike 故意不预建→先用无 guard storage **复现** `no such table` bug→再证 guard 规避。呼应 skill `empirical-verification`：别信"应该能跑"，探针要忠实复制生产顺序。
- **真实生产模块的跨-runtime e2e 需 bundle。** 验 node:sqlite 腿要跑**真实模块**（非手搓 storage）：Node strict ESM 拒 src 树内无扩展名相对 import（`./index`），经 `bun build --target node` 打 bundle（同 tsdown production 产物）后真 Node 跑才过。`bun test` 只覆盖 Bun 腿，Node 腿（driver `nodeFactory` 手搓 BEGIN/COMMIT）必须单独实测。
- **失败策略二分：schema-硬阻断 vs 数据-never-throw。** DDL 失败 rethrow→`process.exit(1)`（半迁移 schema 比不启动危险），与数据层 backfill 的 never-throw 相反（缺派生列可恢复）。单写者假设（Umzug `FileLocker` opt-in、未接；001+ DDL 须幂等）文档化即可。
- **partial-DDL wedge（对抗 review 抓到、两 runtime 实测确认的真坑）。** Umzug **不把 `up` 包事务**（grep umzug.js 零 BEGIN/COMMIT）且**仅在 `up` resolve 后才记账**；SQLite 未显式开事务时**每条 DDL 自动 commit**。故多语句迁移中途抛→前缀语句已 commit 但迁移**未记账**→下次重启从头重跑撞「table already exists」**永久卡死每次启动**。"硬阻断 rethrow"只挡"在半迁移 schema 上服务"，**挡不住**这个 wedge。修复在框架层：`sqlMigration(name, body)` 把 body 包进 driver `transaction()`（SQLite 支持事务化 DDL，**bun native `.transaction` 与 node:sqlite 手搓 BEGIN/COMMIT/ROLLBACK 两 runtime 实测 rollback 一致**）使多语句 all-or-nothing、失败可重试。非事务型（non-transactional PRAGMA/长数据 backfill）迁移则须逐语句 re-entrant（`IF NOT EXISTS`/`table_info` 探测）。教训："idempotent up"不够，须"**partial-application 后可重入**"；给安全构造 primitive（sqlMigration）+ 配 rollback 回归测试，比文档叮嘱作者手包事务可靠。
- **选型（battle-tested > hand-rolled）：** driver-无关纯 JS 的 Umzug 胜 drizzle-kit——后者稳定版无 node:sqlite driver（逼整个 drizzle-orm 降 beta）、autogenerate 丢部分索引 `WHERE`（reaper 依赖 `idx_..._active WHERE status IN(...)`）、裂双账本。详见 ADR `docs/decisions/2026-07-05-dependency-selection-bun-first.md`。落地权威态见 `docs/spec/migration-framework-umzug.md`（LANDED）。异步持久化不变量见 skill `persistence-async-invariants`。

## 内容寻址归一化（search_index 去重）

把结构化数据（消息）做内容寻址去重（git-blob 式 hash→存一次，落地 `src/lib/history/normalize-message.ts`）时，归一化投影的三条方法论：

- **① 哈希投影必须 config-无关、确定、稳定，且哈希输入 == 存储搜索文本（单一投影）。** 同消息恒同输出，与运行时 config 无关——**绝不**复用 config 驱动的清洗函数（`removeSystemReminderTags` 读 `state.rewriteSystemReminders`、默认 no-op → 投影随 config 变 + 跨运行不稳）。canonical = 递归剥易变 key（`cache_control`，Claude Code 每轮前移 ephemeral 断点的唯一易变源——实测两连续请求同消息仅此一处差、剥后字节相等）+ sorted-key JSON（key 序无关）。
- **② 剥注入样板用 own-line 边界锚定正则，绝不用全局 `<tag>.*</tag>`。** 真实 transcript 含**合法 inline 字面提及**同名标签（文档讨论 `<system-reminder>`/`<ide_opened_file>`——实测 9 处 inline vs 1 处结构注入）。全局正则会误删真内容。正解：`(?:^|\n)[ \t]*<tag>...lazy...</tag>[ \t\r]*(?=\n|$)`——只匹配自起一行+自终一行的结构块，inline backtick 提及（行中、无 own-line 闭合）天然不匹配。**坑**：边界要容 `\r`（CRLF transcript 否则漏剥→该块进哈希→每轮 re-hash）。
- **③ 易变子串清单靠真实数据实测枚举，不靠想象。** 从运行中后端 `/history/api/entries/:id` 拉真实消息（skill `empirical-verification`），取**同 session 连续两请求**对比哪些字段每轮变（cache_control 位置/ide_*/cwd/turn-counter）。漏一种→该类消息每轮 re-hash、去重退化、悄悄 bloat。安全网=dedup-ratio tripwire（见 skill `history-backfill`）。实测点须用 history 存储后的消息形状（经 `any`-typed content round-trip，非 live sanitize 输入）。
- **④ 测试要独立 oracle，自洽抓不到。** 同消息含/不含 cache_control 哈希相等的 golden 取**真实连续两请求**实测 pair（非合成）；config 切 true/false 哈希不变证 config-无关；inline 字面提及保留证 own-line 锚定正确。

## FTS5 external-content 三陷阱（全文搜索）

external-content FTS5（如 `entries_fts` 建在 `entries_v2` 上）有三个腐败/穿透陷阱，全部实测确认（`exp/fts-audit/`）——`bun-node-runtime-gotchas` 的 bun:sqlite 陷阱把 history 专有的这三条指到本节：

- **COUNT 穿透**：`SELECT COUNT(*) FROM entries_fts`（external-content）**穿透读 content 表**（entries_v2），即使索引为空也返回内容行数——**不能用它判索引是否已 build**（否则升级时 backfill 被跳过、老数据搜不到）。判 build 用「表是否存在 + 一次性 `'rebuild'`」，gate 在表存在性而非行数。
- **`'delete'` 腐败**：对**从未 insert 过的内容**发 `'delete'` 会 `SQLITE_CORRUPT_VTAB`。AFTER INSERT/UPDATE/DELETE 三触发器必须严格配对（delete 用 old 值、insert 用 new 值），任何路径不得漏发 insert 就 delete。
- **VACUUM renumber rowid**：entries_v2 是 TEXT PK → 隐式 rowid，full `VACUUM` 可能 renumber rowid，使 keyed-on-rowid 的 external-content 索引失配——故启动 VACUUM 后须 `'rebuild'`（`incremental_vacuum` 不 renumber，安全）。
- **trigram 大小写折叠是全 Unicode**：trigram tokenizer 让 `MATCH '"子串"'` 等价 `LIKE '%子串%'`（≥3 字符、子串非 token），但**大小写折叠覆盖全 Unicode**（`LIKE` 只折 ASCII）——非 ASCII 文本 FTS 是 LIKE 的超集，属改进非回归。

（触发器写入被 bun:sqlite 计入 `.run().changes`、故带触发器/级联的表行数用 `SELECT COUNT(*)` 而非 `.changes`——通用运行时分歧见 skill `bun-node-runtime-gotchas`。）

