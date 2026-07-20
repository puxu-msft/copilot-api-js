# Plan: 采纳 Umzug 迁移框架 —— 实现交接稿（hybrid,review 修正后）

> **实施状态：已完成**
> **落地**：—
> **现状锚点**：DESIGN schema 迁移行；`src/lib/history/sqlite/migrations/`（Umzug hybrid forward-runner）；spec/migration-framework-umzug.md
> **备注**：hybrid forward-runner 全落地；MIGRATIONS 初始空（地板=当前 schema），符合 plan

> 配 [migration-framework-umzug.md](migration-framework-umzug.md)（RFC，WHY + 契约）。本文是 **HOW**：phase DAG + factory-anchor 表（精确 file:line，已逐条核实）+ 命名常量 + 每 phase commit invariant。执行用 subagent-driven-development。
> **v2（对抗 review 修正）**:初稿的 "primary = initHistory 改 async + 重构 openDatabase" 经实测判不可行（async ripple ~20+ 文件 + chicken-and-egg:Umzug 在建 history_meta 表前就调 storage.executed()）。**正解 = hybrid**（openDatabase 地板不动 + 独立 async forward-runner），同时干净解掉这两个问题。
> 硬约束：bun-first（`bun run typecheck`/`test:backend`，非 npm）、不分号、严格 TS **无 any**、`eslint --fix`、细粒度 pathspec、subagent 全量工具 + 显式裁判轴。

## 集成方案（hybrid,定）

```
openDatabase(path)                          // sync,不动:inline reconcile = 幂等地板,建全 schema(含 history_meta)
initHistory(enable)                         // sync,不动
// start.ts 的 async runServer 内、initHistory(true) 之后、startServer 之前:
try { await applyForwardMigrations(getDatabase()) }
catch (e) { consola.error("[history] schema 迁移失败,拒绝启动", e); process.exit(1) }   // schema 硬阻断
```
- **地板(conceptual 000)= openDatabase 现 inline reconcile**,**不进 Umzug 账本**;Umzug 只追 **001+ 前向**。
- **chicken-egg 消失**:地板先建 history_meta,forward-runner 后跑表已在;`HistoryMetaStorage` 仍 guard(表缺返 [] / 构造建表)供 P1 隔离测试。
- **ripple 近零**:openDatabase/initHistory/全部测试**不动**;只 start.ts 已-async runServer 加一句。001+ 初始为空 → no-op。
- review 实测的"primary 不可行"证据:`initHistory` 12+ 测试调用者 + `test-bootstrap.ts` 的 `bootstrapTestRuntime`/`resetTestRuntime` 扇出整个 `useIsolatedRuntime`;`openInMemoryDatabase()` 8+ 调用者依赖 open 即建 schema。hybrid 全避开。

## 命名常量

| 常量/符号 | 值/位置 | 说明 |
|---|---|---|
| 迁移模块 | `src/lib/history/sqlite/migrations/index.ts` 的 `MIGRATIONS: Array<UmzugMigration>` | 数组非 glob;**初始空**(地板=当前态) |
| storage | `migrations/storage.ts` 的 `HistoryMetaStorage implements UmzugStorage` | 落 history_meta + **guard 表缺** |
| 账本 key | `meta.ts` 加 `MIGRATIONS_RUN_KEY = "schema_migrations"`（JSON string[]） | 与 SEARCH_INDEX_VERSION_KEY 并列 |
| runner | `migrations/run.ts` 的 `applyForwardMigrations(db): Promise<void>` | new Umzug + up();**失败 rethrow** |
| 迁移类型 | `MigrationFn<SqliteDatabase>`（umzug 导出）—— **不用 `any`** | spike 的 `({context}:any)` 违 no-any |
| logger | consola 适配器（Umzug 传对象给 logger,consola 会 dump） | `{info:m=>consola.info(...),...}` |

## P0 — Spike（双 runtime 门）

| 动作 | 文件 · 符号 |
|---|---|
| `bun add umzug` | 进 `package.json` deps;`find node_modules -name binding.gyp` 仍空（实测,非推断） |
| 扩展 | `exp/umzug-bun-spike/` —— 加 **node:sqlite** 实测（`node:sqlite` `DatabaseSync` 当 context、自定义 storage、有序 run-once）;结果记 RESULT.md。**注**:spike 须**先建 history_meta 再 up()**(模拟地板),或在 storage guard 表缺——记录哪种 |
| 门 | node:sqlite 跑通 → P1;不通 → BLOCKED 退 RFC |

**commit invariant**：spike + umzug 依赖;**零生产代码改动**（exp/ + package.json）。

## P1 — 迁移模块 + storage（隔离、未接线）

| 动作 | 文件 · 符号 |
|---|---|
| 新建 | `migrations/storage.ts` —— `HistoryMetaStorage implements UmzugStorage`（`import type { UmzugStorage } from "umzug"`）。构造接 `db: SqliteDatabase`,**构造或首用 `db.exec("CREATE TABLE IF NOT EXISTS history_meta(...)")`**(修 chicken-egg)。三 **async** 方法:`executed()` 读 `MIGRATIONS_RUN_KEY` JSON `string[]`(**表缺/key 缺返 `[]`**);`logMigration({name})` append;`unlogMigration({name})` remove。经 `meta.ts` `getMeta`/`setMeta` |
| 改 | `meta.ts` —— 加 `export const MIGRATIONS_RUN_KEY = "schema_migrations"` |
| 新建 | `migrations/index.ts` —— `export const MIGRATIONS: Array<...> = []`（**初始空**:地板=当前 schema、首条 001 留给下个变更）。导出迁移条目类型(`{name, up: MigrationFn<SqliteDatabase>}`,**无 any**) |
| 新建 | `migrations/run.ts` —— `applyForwardMigrations(db): Promise<void>`:`new Umzug({migrations: MIGRATIONS, context: db, storage: new HistoryMetaStorage(db), logger: <consola 适配器>})` → `await umzug.up()`。**失败 rethrow**(不吞;注释:DDL 基础、与数据 backfill never-throw 相反) |
| 测试 | `tests/history/sqlite/migrations.it.test.ts`：裸 `new Database(":memory:")`,storage guard 下 `applyForwardMigrations` 在空 MIGRATIONS 上 no-op 不抛;加一条临时测试迁移验有序 + run-once + ledger 持久 history_meta + `HistoryMetaStorage` round-trip + **表缺时 executed() 返 []** |

**commit invariant**：模块 + storage + 单测全绿;**未接 start.ts**（生产启动零变更）;openDatabase/initHistory **不动**。

## P2 — 接入 start.ts（一句 + 硬阻断）

| 动作 | 文件 · 符号 |
|---|---|
| 改 | `start.ts:353` 之后（`initHistory(true)` 后、`startServer`〔:517〕前）加 `await applyForwardMigrations(getDatabase())` 包 **targeted try/catch → `consola.error` + `process.exit(1)`**（schema 半迁移比不启动危险;镜像 config-parse abort start.ts:308-313 模式;**别靠全局 unhandledRejection**） |
| 不动 | `openDatabase`/`initHistory`/`isolated-fixture`/所有测试 —— 地板照建全 schema、契约不变 |
| 测试 | `tests/...`：start 路径迁移在服务前跑(集成测试 or 现有 http 测试覆盖);注入一条会抛的迁移 → `applyForwardMigrations` rethrow（不静默,P1 已可单测此） |

**commit invariant**：迁移先于服务;schema 失败硬阻断;全套件绿（openDatabase 不动 → 零测试破坏）。

## P3 — 双 runtime + 策略 + 文档化假设

| 动作 | 文件 · 符号 |
|---|---|
| 实测 | **node:sqlite 腿**端到端（真实模块 + node:sqlite context,Node ≥22.5,经项目 `driver.ts` nodeFactory 路径） |
| 不写 | `down` —— forward-only 启动迁移器永不调 `umzug.down()`,**省 down**（YAGNI）;若将来要 rollback CLI 再补 |
| 文档化 | **单写者假设**:Umzug `FileLocker` opt-in、未接;首批 001+ 须幂等(SQLite 无 `ADD COLUMN IF NOT EXISTS`→用 `wanted`-style table_info 探测);重叠重启下非幂等 001+ 无保护(注释 + RFC OQ-D) |
| RESETTERS | `applyForwardMigrations` 每次 `new Umzug`(无 module-global)→ 大概率免;若 storage/实例缓存成单例 → 加 `reset*ForTests` 登记 `RESETTERS` |

**commit invariant**：node:sqlite 验过;无 down 死代码;单写者假设文档化;RESETTERS 不漏。

## P4 — doc-sync

| 动作 | 文件 |
|---|---|
| doc | `docs/DESIGN.md` 迁移/history 段：openDatabase 地板 reconcile + start.ts 的 Umzug forward-runner(hybrid) + history_meta 统一账本 + schema-硬阻断 vs 数据-never-throw 对比;`migration-framework-umzug.md` 标落地态 |
| 收编 | 增量把 `user_version`/散落版本标志并入 history_meta（记 OQ、非一次性） |
| memory | Umzug-over-sync-driver 的 hybrid 集成（地板 + forward-runner 避 ripple/chicken-egg）;spike 自掩盖 bug 的教训（spike 须复现真实接线、别预建被测对象） |

## 验收/测试矩阵

- **storage**：history_meta round-trip + 表缺 guard（P1）。
- **迁移**：空 MIGRATIONS no-op、有序、run-once、ledger 持久（P1）。
- **接入**：start.ts 迁移先于服务、schema 失败硬阻断 process.exit（P2）。
- **双 runtime**：node:sqlite 端到端（P0 + P3）。
- 每 phase 收尾 subagent spec+quality review。
