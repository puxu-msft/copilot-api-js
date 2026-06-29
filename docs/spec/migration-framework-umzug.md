# RFC: 历史 schema 迁移框架 —— 采纳 Umzug(有序 run-once 迁移账本）

> Status: **LANDED**（2026-06-28 实现，P0–P4 全交付；权威落地态见 docs/DESIGN.md `src/lib/history/` 行的 "Umzug forward-runner（hybrid）" 段）。
> 决策经 2 路对抗 subagent 实证 + operator 拍板：**弃 drizzle-kit、取 Umzug**。基础经**亲手实测**坐实（`exp/umzug-bun-spike/`，非信文档——drizzle 选型时曾因信 beta 文档误判）。
> 立意（operator）：这是**架构级模块化**改进——把"schema 演进"从散落在 `openDatabase` 的命令式 reconcile 逻辑，提升为**一等的、有序的、有账本的迁移模块**。
> 落地态（hybrid，对抗 review 修正后）：openDatabase 地板（conceptual 000）不动 + 独立 async `applyForwardMigrations`（001+ 前向，`HistoryMetaStorage` over `history_meta(schema_migrations)`），干净避开初稿 primary 的 async ripple + chicken-egg。`MIGRATIONS` 当前空（地板=当前 schema）。

## 为什么是 Umzug（决策记录）

**现状**：`openDatabase` 用**幂等声明式 reconcile**（`SCHEMA_SQL` 的 `CREATE IF NOT EXISTS` + `migrateEntriesColumns` 按 `wanted` 表补列 + bespoke 一次性 drop + 各自 `history_meta`/`user_version` 版本标志守卫的数据 backfill）。它**没坏**、刚干净落地了 search_index/FTS 退役。唯一真缺口：**无显式有序账本**——依赖型破坏性步骤的顺序隐含在源码行序里（如 `dropLegacyFtsAndSearchText` 必须在写库前跑，因触发器引用 search_text），手工管对了，但不是声明式有序链。

**弃 drizzle-kit（2 路 review 实证的硬阻塞）**：
1. **稳定版无 `node:sqlite` driver**——只在 `1.0.0-beta`；本项目双 driver 的 Node 腿要用就得把整个 drizzle-orm 压到 beta，违稳定依赖纪律。
2. **autogenerate 表达不了部分索引 `WHERE`**（open bug #4688）——本项目 reaper 性能依赖的 `idx_entries_v2_active ... WHERE status IN(...)` 会被静默丢，逼手改、破单一真相源。
3. **招牌 autogenerate 对路线图最硬的迁移没用**——`entries_v2→v3` 是**数据重构**（读 v2→经规范写路径重派生→写 v3→删源行），无论用什么都 bespoke TS；DDL 那 5% RFC 已手写。
4. **裂成两个账本**（`__drizzle_migrations` + `history_meta`），与"统一账本"目标相反。

**取 Umzug**：它正是**对的那个成熟库**——纯 JS、driver-无关（DB 当 `context` 传）、零 node-gyp（实测）、给的就是缺的那半"**有序 run-once + 账本**"，**没有** autogenerate 错配。`battle-tested-over-hand-rolled`：库的差异化价值（有序运行框架 + 账本抽象 + dry-run/pending/executed 内省 + 错误处理）正是手搓 50 行会写糙的编排逻辑，故采库。

## 设计

### Umzug 作有序 DDL 迁移 runner（over 现有自定义 driver）

```ts
new Umzug({
  migrations: [ /* 有序数组,非 glob —— 本项目打包发布、glob 在 dist 脆 */
    { name: "000-baseline", up: ({context: db}) => { /* 见下:幂等 reconcile */ } },
    { name: "001-...", up: ({context: db}) => { db.exec(ddl) }, down: ... },
  ],
  context: getDatabase(),            // 自定义 SqliteDatabase（双 driver 已抽象,Umzug 不关心）
  storage: new HistoryMetaStorage(), // 自定义 storage → history_meta(统一账本)
  logger: consola,
})
await umzug.up()   // 跑所有 pending、按序、各一次(实测 exp/umzug-bun-spike)
```

实测确认（`exp/umzug-bun-spike/RESULT.md`）：Bun + bun:sqlite context + history_meta storage + 有序 run-once 全跑通、零 node-gyp。

### 自定义 `HistoryMetaStorage`（统一账本,化解"两系统"风险）

实现 `UmzugStorage` 三方法（`logMigration`/`unlogMigration`/`executed`），落到既有 `history_meta` KV 表（v3 RFC 已独立选定的单一账本）。→ **DDL 迁移与数据 backfill 都记在 `history_meta` 一张表**：Umzug 给 DDL 半套有序框架，数据半套保留 bespoke 后台 job，但**账本统一**。逐步收编散落的 `user_version`/各版本标志。

### baseline：地板（openDatabase 的 inline reconcile）= conceptual 000，不进账本

reviewer 实证：Umzug/drizzle 都**无一等 baseline/stamp 命令**。hybrid 巧妙绕开：**当前 openDatabase 的 inline reconcile**（`SCHEMA_SQL` 全表 `CREATE IF NOT EXISTS` + `migrateEntriesColumns` 补列 + `dropLegacyFtsAndSearchText` + 死表 drop）**就是 conceptual migration 000 = baseline**——它已是收敛的(全新库建全部、已迁库幂等 no-op)。
- **地板不进 Umzug 账本**（squashed-baseline:初始 schema 是"起点"而非被追踪的迁移）;Umzug 账本只追踪 **001+ 前向 delta**。
- **无需独立 baseline 步骤,也无需把地板搬进 Umzug**（这避开了 primary 方案的 openDatabase 重构 + chicken-and-egg）。经典"squashed 初始 schema + 前向 delta 迁移"模式。

### migrations 001+ = 严格有序前向（DDL 或 kick 数据 job）

每条是纯 TS：可 `db.exec(ddl)`（schema 变更），或 kick 一个后台数据 job（长迁移）。**首次采纳时 001+ 为空**(地板即当前态)→ forward-runner no-op;真正的首条 001 会是下一个 schema 变更(或 entries_v3 的 DDL)。

### 长数据迁移仍后台（resumable/non-blocking,但同账本）

search_index backfill、未来 entries_v3 数据搬迁是**可恢复、非阻塞、小时级**——这类**任何迁移工具都不原生支持**（Alembic/drizzle/Umzug 的 `up()` 都是跑到完成、阻塞）。故保留现有 post-listen 后台 job 模式（游标续跑、自家 history_meta 版本标志守卫），**Umzug 只管快 DDL**。分工：**Umzug=快 DDL（阻塞启动、有序）/ 后台 job=长数据（非阻塞、resumable）**,二者都在 `history_meta` 一张账本。v3 的 DDL（建 entries_v3/attempt_legs 表）作一条 Umzug 迁移、其数据搬迁作它 kick 的后台 job。

### 集成点（经对抗 review 修正：hybrid 是正解,非退路）

**实测教训**：初稿的 "primary = initHistory 改 async + 重构 openDatabase" 经 review 实测判不可行——① **async ripple ~20+ 文件**（initHistory 12+ 测试调用者 + `test-bootstrap.ts` 扇出 + 8 个 openInMemoryDatabase 调用者），远超阈值;② **chicken-and-egg**:Umzug 在 migration 000 建 `history_meta` 表**之前**就调 `storage.executed()` 读它 → 全新库抛 `no such table`（初稿 spike 因 line 5 手建该表而掩盖了此 bug,bun:sqlite 实测确认）。

**正解 = hybrid(openDatabase 地板不动 + 独立 async forward-runner)**：
```
openDatabase(path)               // sync,不动:现 inline reconcile = 幂等地板,建全 schema(含 history_meta)
initHistory(enable)              // sync,不动
// start.ts 的 async runServer 内、initHistory 之后、startServer 之前:
await applyForwardMigrations(getDatabase())   // Umzug 只跑 001+ 前向迁移;一句、零 ripple
```
- **地板(conceptual migration 000)= 现 openDatabase 的 inline reconcile**,**不进 Umzug 账本**（squashed-baseline 模式）;Umzug 账本只管 **001+ 前向**。
- **chicken-and-egg 自动消失**:地板先建 `history_meta`,forward-runner 后跑时表已在。**但 `HistoryMetaStorage` 仍须 guard**（`executed()` 在表缺时返 `[]`、构造或首用 `CREATE TABLE IF NOT EXISTS history_meta`）——供 P1 隔离测试（裸 `:memory:` + applyForwardMigrations,无地板）+ 防御。
- **ripple 几乎为零**:openDatabase/initHistory/所有测试**不动**（地板照建全 schema）;只 start.ts 的已-async runServer 加一句 await。首次采纳时 001+ 为空 → forward-runner no-op,更零风险。当真加 001+ 迁移、且某测试需它时,该测试 await applyForwardMigrations（届时增量加,非现在全改）。
- **schema 迁移失败硬阻断**:`applyForwardMigrations` rethrow → start.ts **加 targeted try/catch + `process.exit(1)` + 清晰错误**（镜像 start.ts 的 config-parse abort,别靠全局 unhandledRejection 出丑日志）。

### 反直觉/契约修正（review 补）

- **no-any**:迁移 `up` 须类型化为 `MigrationFn<SqliteDatabase>`,**别抄 spike 的 `({context}: any)`**（违项目 no-any）。
- **consola 作 logger 须适配**:Umzug 传**对象**给 logger（`logger.info({event,name})`）,consola 会 dump 成对象。包小适配器（`{info: m => consola.info(...), ...}`）或接受丑日志。
- **无并发迁移锁**:Umzug `FileLocker` 是 opt-in、本设计未接。地板(000)+ 当前全幂等故重启重叠安全;但**未来 001+ 非幂等 DDL**（SQLite 无 `ADD COLUMN IF NOT EXISTS`）在重叠重启下无保护——文档化"单写者假设"或届时接 `FileLocker`。
- **`down` 是 forward-only 死代码**:启动迁移器永不调 `umzug.down()`,故**不写 `down`**（YAGNI）,除非将来有 rollback CLI 用例。
- **`wanted` 列表存活作内部 primitive**:`migrateEntriesColumns` 的幂等 ADD-COLUMN-IF-missing 模式（`wanted` 表）保留,未来加列迁移复用它,**不解散**。

### reconcile 退场

**hybrid 下 reconcile 不退场**:现 `openDatabase` 的 inline schema 工作（`SCHEMA_SQL` + `migrateEntriesColumns` + `dropLegacyFtsAndSearchText` + 死表 drop）**保留为幂等地板**(conceptual 000),`openDatabase` 契约不变(故零 ripple、零 chicken-egg)。Umzug 只在 start.ts 的 async runServer 里、initHistory 之后跑 **001+ 前向**。（primary 方案"把 schema 搬进 migration 000 + openDatabase 改 async"经 review 判不可行,见集成点。）

## 模块化收益（operator 立意）

- schema 演进从"散在 openDatabase 的命令式 reconcile + 散落版本标志"→ **一等迁移模块**(`src/lib/history/sqlite/migrations/` 有序数组 + 统一 history_meta 账本)。
- 新 schema 变更 = 追加一条有序迁移,而非改 `wanted` 表 + 想清楚塞在 reconcile 哪一行。
- 版本可内省(`umzug.executed()`/`pending()`),不再靠读源码行序推断顺序。
- 为 entries_v3 大重构铺好框架:DDL 一条迁移、数据一个后台 job、都在账本里。

## 实现 phase（hybrid,review 修正后）—— **全 LANDED（2026-06-28）**

- **P0 spike(扩展现有 exp/)** ✅ `46df204`:bun:sqlite **已验**;补 **node:sqlite** 实测(`exp/umzug-bun-spike/spike-node.ts`,故意不预建 history_meta→**复现** chicken-egg 再证 guard 规避);`find node_modules -name binding.gyp` 仍空。
- **P1** ✅ `9f67f5d`:`HistoryMetaStorage`(UmzugStorage over history_meta,构造 `CREATE TABLE IF NOT EXISTS history_meta` + `executed()` 表缺返 `[]`——修 chicken-egg)+ `migrations/index.ts`(`MIGRATIONS` 初始空数组、地板在 openDatabase 不动)+ `applyForwardMigrations(db)`(new Umzug + up()、no-any `MigrationFn<SqliteDatabase>` + consola logger 适配器)+ 单测 `tests/history/sqlite/migrations.it.test.ts`(裸 `:memory:`、5 用例)。
- **P2** ✅ `86f2e43`:接入——start.ts 的 async runServer 内、`initHistory(true)` 之后、`startServer` 之前加 `await applyForwardMigrations(getDatabase())` + targeted try/catch → `consola.error` + `process.exit(1)`(schema 失败硬阻断,镜像 config-parse abort)。openDatabase/initHistory/测试全不动,全套件 3176 pass。
- **P3** ✅ `816190c`:node:sqlite **端到端实测真实生产模块**(`exp/umzug-bun-spike/e2e-node.ts`,经 `bun build --target node` bundle 后真 Node 跑);单写者假设文档化(`run.ts` JSDoc + 本 OQ-D);**不写 `down`**(forward-only,YAGNI);`wanted` 保留作内部 idempotent-ADD-COLUMN primitive。
- **P4** ✅:doc-sync(本文 + DESIGN.md `src/lib/history/` 行 + memory);`user_version`/版本标志增量收编记 OQ-C(非一次性)。

## Open Questions

- **OQ-A**:首条真实 001+ 迁移加列时——复用 `migrateEntriesColumns` 的 `wanted` 幂等 primitive,还是独立有序迁移?倾向独立有序(可内省),但 `wanted` primitive 保留可用。
- **OQ-B**:~~schema 迁移失败策略~~——**已定:硬阻断 + targeted 清晰错误 + `process.exit(1)`**(DDL 是基础;与数据 backfill never-throw 相反)。
- **OQ-C(landed-review 复核,已 moot)**:`user_version`/散落版本标志收编——**经 grep 实证无需做、且天真"收编"反而是错的**。(a) `PRAGMA user_version` 当前**零 live 读写**(仅 `search-index-backfill.ts` 注释提及"故意不读 user_version"),旧 preview-backfill 早已迁到 `history_meta(search_index_version)`,迁移已发生、无残留可收编。(b) 余下标志(`search_index_version`/`..._backfill_cursor`/`..._dedup_ratio`)**已在 `history_meta`** 统一 KV 表内,且是**数据-backfill** 标志(never-throw、resumable、监听后后台)——与 `schema_migrations` 账本的 **schema-硬阻断** 失败策略**正相反**;把它们折进 Umzug forward-runner 会**conflate 这两个对立失败策略**(本 RFC 刻意区分的 OQ-B 边界),故**应保持分离**。结论:OQ-C 无实现工作。
- **OQ-D(review 补)**:并发迁移——首批全幂等故安全;未来非幂等 001+ DDL 是否接 Umzug `FileLocker` vs 文档化"单写者假设"。倾向后者(本项目单进程为主,重叠重启是边缘)。
- **OQ-E(landed-review 补,已解)**:**partial-DDL wedge**——Umzug 不把 `up` 包事务、仅 resolve 后记账,SQLite 未显式开事务时每条 DDL 自动 commit,故多语句迁移中途抛→前缀已 commit 但未记账→重启从头重跑撞「already exists」永久卡死。"硬阻断 rethrow"(OQ-B)挡不住此 wedge。**已解:`sqlMigration(name, body)`** 把 body 包进 driver `transaction()`(SQLite 事务化 DDL,bun native + node:sqlite 手搓 BEGIN/COMMIT/ROLLBACK 两 runtime 实测 rollback 一致)使多语句 all-or-nothing、可重试;非事务型迁移须逐语句 re-entrant。教训:"idempotent up"不够,须"partial-application 后可重入"。
