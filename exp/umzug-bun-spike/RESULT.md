# Umzug-under-Bun 实测(迁移框架选型)

`bun run spike.ts` 实测结果(2026-06,Bun 1.3.14):
- `bun add umzug@3.8.3` → 零 node-gyp(`find node_modules -name binding.gyp` 空、无 `*.node`)。
- 程序化 `new Umzug({migrations:[...], context: bunSqliteDb, storage})` 在 Bun 下跑通。
- 自定义 `UmzugStorage`(logMigration/unlogMigration/executed)落 `history_meta` 表 → 单一账本。
- 数组迁移(非 glob)、迁移体 `context.exec(ddl)` 同步执行。
- **有序 + run-once 实证**:run1 应用 [000,001];run2 应用 [](已执行不重跑);pending 空;ledger 持久在 history_meta;schema 真变(prev_id 列已加)。

结论:Umzug 在本项目 bun-first/双 driver 下技术可行(driver-无关、纯 JS、零 native)。对照:drizzle-orm 稳定版无 node:sqlite driver(只在 1.0.0-beta)、drizzle-kit autogenerate 丢部分索引 WHERE(bug #4688)——故弃 drizzle、取 Umzug。

## node:sqlite 腿(双 runtime 门第二腿)

`node spike-node.ts` 实测(2026-06,Node v24.16.0,`node:sqlite` `DatabaseSync`):
- **故意不预建 history_meta**(吸取 spike.ts line 5 预建掩盖 chicken-egg 的教训)——先用**无 guard** 的 storage 实测,**复现** chicken-egg:`up()` 抛 `no such table: history_meta`(Umzug 在跑迁移前就调 `storage.executed()` 读账本,而账本表此刻还不存在)。证明此 bug 真实存在、非推断。
- 再用 **guard 版** storage(构造时 `CREATE TABLE IF NOT EXISTS history_meta` + `executed()` 表缺返 `[]`)——即 P1 `HistoryMetaStorage` 将固化的同一 guard——**规避** chicken-egg:run1 应用 [000,001];run2 空(run-once);pending 空;ledger 持久 `history_meta`;schema 真变(entries 含 prev_id)。
- node:sqlite TS 文件经 Node ≥23.6 内建 type-stripping 直跑(无需 transpile);零 node-gyp。

**双 runtime 门:PASS**——bun:sqlite + node:sqlite 两腿均跑通有序/run-once/账本。采纳 Umzug(hybrid:openDatabase 地板不动 + 独立 async forward-runner)。

## P3 node:sqlite 端到端(真实生产模块)

`e2e-node.ts` 驱动 **真实生产模块**(`createDatabase`→node:sqlite `DatabaseSync`+手搓 tx wrapper、真实 `HistoryMetaStorage`、真实 `applyForwardMigrations`)——非 P0 的手搓 storage。Node 不解析 src 树内部的无扩展名相对 import(`./index`),故经 `bun build --target node` 打 node-target bundle(production tsdown 同类产物)后用**真 Node 运行时**跑:

```
bun build exp/umzug-bun-spike/e2e-node.ts --target node --outfile exp/umzug-bun-spike/e2e-node.bundle.mjs
node exp/umzug-bun-spike/e2e-node.bundle.mjs   # runtime=node;bundle 为临时产物,不入 git
```

全断言 PASS:`applyForwardMigrations` 空 MIGRATIONS 在 bare DB no-op(chicken-egg guard 自足);真实 `HistoryMetaStorage` + Umzug 有序应用 [001,002]、schema 真变(x,y)、run-once(二次 up 空、up body 不重跑)、ledger 持久 `history_meta`。证明 node:sqlite 的手搓 BEGIN/COMMIT 事务路径 + DatabaseSync 与 Umzug/真实 storage 端到端可用,不只 bun:sqlite。


