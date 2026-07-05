---
name: methodology-migration-framework-hybrid-forward-runner
description: 命令式 schema reconcile 升级迁移框架(Umzug hybrid)已归入 skill history-sqlite-schema 迁移节；见那里
metadata:
  node_type: memory
  type: feedback
---

**已归入 skill `history-sqlite-schema`（迁移：Umzug hybrid forward-runner）。** 钩子：hybrid（既有幂等 000 地板不动 + async forward-runner 只追 001+）避 async ripple + chicken-egg；storage 双 guard；spike 须复现真实接线；跨-runtime e2e 需 bundle；**partial-DDL wedge**（Umzug 不包事务 + SQLite DDL 自动 commit → 中途抛永久卡启动，修=`sqlMigration` 包 driver `transaction()`）；选型 Umzug 胜 drizzle-kit。ADR `docs/decisions/2026-07-05-dependency-selection-bun-first.md`、`docs/spec/migration-framework-umzug.md`。相关 [[methodology-sync-to-async-persistence-refactor-invariants]]。
