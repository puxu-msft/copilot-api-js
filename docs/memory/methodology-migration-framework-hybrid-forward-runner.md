---
name: methodology-migration-framework-hybrid-forward-runner
description: "把命令式 schema reconcile 升级为迁移框架(Umzug)时,集成用 hybrid——既有幂等地板不动 + 独立 async forward-runner(只追 001+),避 init-改-async 的 ripple + chicken-egg;spike 须复现真实接线别预建被测对象;真实模块跨 runtime e2e 需 bundle"
metadata:
  node_type: memory
  type: feedback
---

把散落在 `openDatabase` 的命令式 schema reconcile **升级为一等迁移框架**(本项目 2026-06-28 采 **Umzug**,弃 drizzle-kit)时,几条可复用方法论:

**1. 集成用 hybrid,别动既有地板。** 初稿想把 `initHistory`/`openDatabase` 改 async + 重构成 Umzug 跑全部——实测不可行:async ripple ~20+ 文件(12+ 测试调用者 + bootstrap 扇出) + **chicken-egg**(Umzug 在建账本表前就调 `storage.executed()` 读账本,而账本表此刻还不存在)。**正解**:既有幂等 reconcile(`SCHEMA_SQL`+`migrateEntriesColumns`+bespoke drop)留作 conceptual **000 地板、不进账本**;新增独立 async `applyForwardMigrations` 只追 **001+ 前向 DDL**,在 `initHistory(true)` 后、`startServer` 前跑一句。ripple 近零(只一处接入)。两问题一起消失。

**2. storage 双 guard 使 runner 与开库顺序解耦。** `HistoryMetaStorage` 构造即 `CREATE TABLE IF NOT EXISTS history_meta` + `executed()` 表缺返 `[]`——故即便无地板也自足、可隔离测(裸 `:memory:`)。账本落**既有 KV 表**(`history_meta(schema_migrations)`,与 `search_index_version` 同表)= 统一账本,非另起 migrations 表。

**3. spike 须复现真实接线、别预建被测对象。** bun spike 的 line-5 `CREATE TABLE history_meta` 预建**掩盖了 chicken-egg**;node spike 故意**不预建**→先用无 guard storage **复现** `no such table` bug→再证 guard 规避。呼应 [[empirical-probe-via-history-api]] 的 empirical-verification:别信"应该能跑",写最小探针实测,且探针要忠实复制生产顺序。

**4. 真实生产模块的跨-runtime e2e 需 bundle。** 验 node:sqlite 腿要跑**真实模块**(非手搓 storage):Node strict ESM 拒 src 树内部无扩展名相对 import(`./index`),经 `bun build --target node` 打 bundle(同 tsdown production 产物)后真 Node 跑即过。`bun test` 只覆盖 Bun 腿,Node 腿(driver `nodeFactory` 手搓 BEGIN/COMMIT)永远走不到、必须单独实测。

**5. 失败策略二分:schema-硬阻断 vs 数据-never-throw。** DDL 失败 `rethrow`→`process.exit(1)`(半迁移 schema 比不启动危险),与数据层 backfill 的 never-throw **相反**(缺派生列可恢复)。单写者假设(Umzug `FileLocker` opt-in、未接;001+ DDL 须幂等)文档化即可,单进程项目重叠重启是边缘。

**5b. partial-DDL wedge(对抗 review 抓到、两 runtime 实测确认的真坑)。** **Umzug 不把 `up` 包事务**(grep umzug.js 零 BEGIN/COMMIT)且**仅在 `up` resolve 后才记账**;而 SQLite 未显式开事务时**每条 DDL 自动 commit**。故多语句迁移中途抛→前缀语句已 commit 但迁移**未记账**→下次重启从头重跑撞「table already exists」**永久卡死每一次启动**。"硬阻断 rethrow"只挡住"在半迁移 schema 上服务",**挡不住**这个 wedge。修复在框架层而非靠作者纪律:`sqlMigration(name, body)` 把 body 包进 driver `transaction()`(SQLite 支持事务化 DDL,**bun native `.transaction` 与 node:sqlite 手搓 BEGIN/COMMIT/ROLLBACK 两 runtime 实测 rollback 一致**)使多语句 all-or-nothing、失败可重试。非事务型(non-transactional PRAGMA / 长数据 backfill)迁移则须逐语句 re-entrant(`IF NOT EXISTS`/`table_info` 探测)。教训:"idempotent up"不够,须"**partial-application 后可重入**";给安全构造 primitive(sqlMigration)+ 配 rollback 回归测试,比文档叮嘱作者手包事务可靠。

**6. 选型(battle-tested-over-hand-rolled):** driver-无关纯 JS 的 Umzug 胜 drizzle-kit——后者稳定版无 node:sqlite driver(逼整个 drizzle-orm 降 beta)、autogenerate 丢部分索引 `WHERE`(本项目 reaper 依赖 `idx_..._active WHERE status IN(...)`)、裂双账本。Umzug 给的正是缺的那半"有序 run-once + 账本",无 autogenerate 错配。详见 [[feedback-bun-first-dependency-selection]]。

落地权威态见 docs/DESIGN.md `src/lib/history/` 行 + docs/rfc/migration-framework-umzug.md(LANDED)。扩展 [[methodology-sync-to-async-persistence-refactor-invariants]](本次没改既有同步路径故避开了那批不变量)。
