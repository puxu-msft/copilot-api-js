# Prompts: 采纳 Umzug 迁移框架 —— 每 phase kickoff（hybrid,review 修正后）

> **类型**：kick-off prompt —— 非独立 plan，实施状态见父 plan [migration-framework-umzug-plan.md](migration-framework-umzug-plan.md)。

> 配 [migration-framework-umzug-plan.md](migration-framework-umzug-plan.md)（HOW + factory-anchor）+ [migration-framework-umzug.md](migration-framework-umzug.md)（WHY）。每 prompt 自包含；控制者按 DAG 贴给 implementer subagent（general-purpose、全量工具），每 phase 收尾派 spec + quality review。
> **方案 = hybrid**（openDatabase 地板不动 + 独立 async forward-runner）——initheavy primary 经实测判不可行（async ripple ~20+ 文件 + chicken-and-egg）。
>
> **公共头**（控制者粘贴时附上）：
> - **⛔ GIT**：可 `git add -p`/`git commit`（细粒度 pathspec、绝不 `-A`/`.`/`-am`、提交前 `git diff --cached --stat`）；**绝不** push/改写历史/`git checkout` 他人文件/`git stash`。并发会话——只提交本 phase 精确文件。
> - **裁判轴**：长远正确 + 范围内完整，**非** ROI/YAGNI/工期。
> - **bun-first**：`bun run typecheck`、`bun run test:backend`（**非 npm**）。不分号、三元行首、严格 TS **无 any**（迁移 `up` 用 `MigrationFn<SqliteDatabase>`,别抄任何 `({context}: any)`）、ESNext。`eslint --fix` 你改的文件。
> - **不起服务器**;**empirical-verification 亲手实测,别信文档/别预建被测对象**（本 RFC 的 bun spike 曾因 line 5 预建 history_meta 掩盖了 chicken-egg bug——教训）。
> - 完成报 **DONE/DONE_WITH_CONCERNS/BLOCKED/NEEDS_CONTEXT** + 命令结果 + 改动文件 + 确认零越界。

---

## P0 — Spike（双 runtime 门）

实测 Umzug 在本项目**两个 runtime**(Bun + Node)下都能跑——采纳的技术门。bun:sqlite 已验(`exp/umzug-bun-spike/`),补 **node:sqlite** 腿(核心约束、别只信一端)。

**任务**：
1. `bun add umzug`(进 `package.json` deps);`find node_modules -name binding.gyp` 确认仍空(零 node-gyp)。
2. 扩展 `exp/umzug-bun-spike/`：加 node:sqlite 脚本（Node ≥22.5 的 `node:sqlite` `DatabaseSync` 当 Umzug `context`、自定义 history_meta storage、有序数组迁移、跑两次验 run-once）。读 `spike.ts`(bun 版)作模板。**重要**:真实接线里 `history_meta` 由 openDatabase 地板先建,但 spike 是裸库——故 spike 须**显式先建 history_meta 再 up()**，或在 storage 的 `executed()` guard 表缺返 `[]`（P1 storage 也要这个 guard）。记录用了哪种 + 是否复现/规避了 "no such table: history_meta"。
3. 结果追加进 `exp/umzug-bun-spike/RESULT.md`（node:sqlite 段:跑通?run-once?ledger?）。

**先读**：`exp/umzug-bun-spike/spike.ts`、`src/lib/history/sqlite/driver.ts`(项目 node:sqlite 用法)。

**门**：node:sqlite 跑通 → DONE 继续 P1;不通 → BLOCKED + 具体失败 → 退 RFC。

**commit invariant**：spike 证据 + umzug 依赖;**零生产代码改动**（exp/ + package.json/lockfile）。

---

## P1 — 迁移模块 + storage（隔离、未接线）

建迁移框架核心 + 单测,**不接 start.ts**——纯新增、生产启动零变更。

**任务**：
1. 新建 `src/lib/history/sqlite/migrations/storage.ts`：`HistoryMetaStorage implements UmzugStorage`(`import type { UmzugStorage } from "umzug"`)。构造接 `db: SqliteDatabase`,**构造时 `db.exec("CREATE TABLE IF NOT EXISTS history_meta(key TEXT PRIMARY KEY, value TEXT)")`**(修 chicken-egg:Umzug 在跑迁移前就调 `executed()` 读 history_meta)。三 **async** 方法(Umzug 要求 async,sync 体自动包 Promise):`executed(): Promise<string[]>` 读 `MIGRATIONS_RUN_KEY` 的 JSON `string[]`(**表缺或 key 缺返 `[]`**);`logMigration({name})` append name;`unlogMigration({name})` remove name。经 `meta.ts` 的 `getMeta`/`setMeta`。
2. `src/lib/history/sqlite/meta.ts`：加 `export const MIGRATIONS_RUN_KEY = "schema_migrations"`(与 `SEARCH_INDEX_VERSION_KEY` 并列)。
3. 新建 `src/lib/history/sqlite/migrations/index.ts`：`export const MIGRATIONS: Array<{name: string; up: MigrationFn<SqliteDatabase>}> = []`(**初始空数组**——地板=当前 schema、首条 001 留给下个变更;`MigrationFn` 从 `umzug` 导入,**无 any**)。
4. 新建 `src/lib/history/sqlite/migrations/run.ts`：`applyForwardMigrations(db: SqliteDatabase): Promise<void>`——`new Umzug({migrations: MIGRATIONS, context: db, storage: new HistoryMetaStorage(db), logger: <适配器>})` → `await umzug.up()`。**logger 适配器**:Umzug 传**对象**给 logger(`logger.info({event,name})`),consola 会 dump 成对象 → 包 `{info: m => consola.info(\`[migrate] ${JSON.stringify(m)}\`), warn:..., error:..., debug:...}`。**失败 rethrow**(不吞;注释:DDL 是基础、半迁移比不启动危险、与数据 backfill never-throw 相反)。

**先读**：`exp/umzug-bun-spike/spike.ts`(storage + Umzug 范例,但注意它 line 5 预建 history_meta——你的 storage 改为自己 guard)、`src/lib/history/sqlite/{meta.ts(getMeta/setMeta), schema.ts, driver.ts(SqliteDatabase), connection.ts(history_meta 在 SCHEMA_SQL 里、地板会建)}`、`node_modules/umzug` 的 `UmzugStorage`/`MigrationFn` 类型。

**测试**：`tests/history/sqlite/migrations.it.test.ts`(裸 `new Database(":memory:")`:① **表缺时 `new HistoryMetaStorage(db).executed()` 返 []**不抛〔chicken-egg 守卫〕;② 空 `MIGRATIONS` 上 `applyForwardMigrations` no-op 不抛;③ 临时塞一条测试迁移〔`db.exec("CREATE TABLE t(x)")`〕验有序 + 二次 up 空〔run-once〕+ ledger 持久 `history_meta(schema_migrations)`;④ storage 三方法 round-trip)。**不接 openDatabase/start.ts**。

**commit invariant**：模块 + storage + 单测全绿;**未接 start.ts**(生产启动零变更);`openDatabase`/`initHistory` 一字不动。

---

## P2 — 接入 start.ts（一句 + 硬阻断;openDatabase 不动）

把 forward-runner 接进启动——**只改 start.ts 一处**。openDatabase/initHistory/测试全不动(地板照建全 schema)。

**任务**：
1. `src/start.ts`：在 `initHistory(true)`(line 353)之后、`startServer(...)`(line ~517)之前,加：
   ```ts
   try {
     await applyForwardMigrations(getDatabase())
   } catch (err: unknown) {
     consola.error("[history/sqlite] schema 迁移失败,拒绝启动(schema 半迁移比不启动更危险)", err)
     process.exit(1)
   }
   ```
   import `applyForwardMigrations` from `~/lib/history/sqlite/migrations/run`、`getDatabase` from `~/lib/history/sqlite/connection`。**targeted 错误 + 硬阻断**(镜像 start.ts:308-313 的 config-parse abort;别靠全局 unhandledRejection 出丑日志)。`runServer` 已是 async,await 是一行。
2. **不动**:`openDatabase`、`initHistory`、`isolated-fixture.ts`、所有测试(地板 reconcile 不变、契约不变 → 零 ripple)。

**先读**：`src/start.ts`(line 353 `initHistory(true)` + line 517 `startServer` + line 308-313 config-abort 模式)、`src/lib/history/sqlite/connection.ts`(`getDatabase`)。

**测试**：现有 http/启动测试覆盖"服务前迁移已跑";schema 失败硬阻断由 P1 的"会抛迁移 → applyForwardMigrations rethrow"单测 + 此处 try/catch 逻辑覆盖(集成层难测 process.exit,逻辑层测 rethrow 即可)。

**commit invariant**：迁移先于服务;schema 失败硬阻断;**全套件绿**(openDatabase 不动 → 零测试破坏)。

---

## P3 — node:sqlite 端到端 + 文档化假设

**任务**：
1. **node:sqlite 腿端到端实测**(不只 P0 spike):用项目 `driver.ts` 的 node:sqlite 路径(Node ≥22.5)开真实库 + 地板 + `applyForwardMigrations` + 验有序/run-once/账本。双 driver 是核心约束。
2. **不写 `down`**:forward-only 启动迁移器永不调 `umzug.down()` → 省 `down`(YAGNI);若将来要 rollback CLI 再补。
3. **文档化单写者假设**(`migrations/run.ts` 注释 + RFC OQ-D):Umzug `FileLocker` opt-in、未接;首批 001+ DDL 须**幂等**(SQLite 无 `ADD COLUMN IF NOT EXISTS`→加列用 `wanted`-style `PRAGMA table_info` 探测,复用 `migrateEntriesColumns` 的 primitive);重叠重启下非幂等 001+ 无保护。
4. **RESETTERS**:`applyForwardMigrations` 每次 `new Umzug`(无 module-global)→ 大概率免;确认无游离 module-global 状态;若有 → `reset*ForTests` + 登记 `RESETTERS`(L1 守卫 `tests/infra/resetters-complete.unit.test.ts`)。

**commit invariant**：node:sqlite 验过;无 `down` 死代码;单写者假设文档化;RESETTERS 不漏(L1 绿)。

---

## P4 — doc-sync

**任务**：
1. `docs/DESIGN.md` 迁移/history 段:hybrid——openDatabase 地板 reconcile(不动)+ start.ts 的 `applyForwardMigrations`(Umzug 001+)+ history_meta 统一账本 + schema-硬阻断 vs 数据-never-throw 对比。`migration-framework-umzug.md` 标落地态。
2. **增量收编**(记 OQ、非一次性):`user_version`/散落版本标志逐步并入 history_meta 账本。
3. memory:Umzug-over-sync-driver 的 hybrid(地板 + forward-runner 避 ripple/chicken-egg);**spike 须复现真实接线、别预建被测对象**(line 5 预建 history_meta 掩盖 chicken-egg 的教训)。
4. 验收:全套件绿;P0/P3 双 runtime 背书。

**commit invariant**：文档与代码同步;RFC 落地态;双 runtime 背书。

---

## 收尾（全 phase 后）

整体 review subagent(spec + 质量)跨全 5 phase;确认 commit invariants 链(P1 隔离 → P2 一句接入 → 每中间 commit 系统可用);doc-sync 完成(grep 扫旧 reconcile 叙述对齐 hybrid)。
