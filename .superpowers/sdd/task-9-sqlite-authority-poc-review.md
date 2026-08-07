# Task 9 SQLite controlled-maintenance PoC A/B1/B2 独立评审

评审范围：候选树 `/home/xp/src/copilot-api-js/.worktree/agent-a0b5eee4b161ab9ab`，A/B1/B2 初始 HEAD `346c692c09115bb9468bc82b806a0ea8962c55c3`，并复核后续修复 `07d1545340b5f6b5d480132affe76e5c922d73b5`。未审 B3。

已读证据：README、全部 A/B1/B2 probe 源码与 JSON、progress、`packages/foundation/src/sqlite/driver.ts`、冻结 Task 9 架构草案；复跑 A/B1/B2、`B2_MUTATE_CLEANUP=1`、`B2_MUTATE_SIDE_EFFECT_ORACLE=1`；检查 `.so` 平台和 checksum。

## 初轮事实性发现

[Important，已由后续提交修复] `probe-b2-bun.ts:49-52` 与 `probe-b2-node.mjs:38-42` 原只测无副作用 Promise／thenable，不能证明 callback 未在授权窗口写入。现已加入 executor／then getter 的事务外持久化负控和 transaction rollback 正控。

## 后续复核：`07d1545`

- 正常运行 Bun／Node B2 均成功：事务外 `promiseExecutorSideEffectPersistsWithoutTransaction` 与 `thenGetterSideEffectPersistsWithoutTransaction` 均在抛 `TypeError` 后确认行存在；transaction 版本均确认行不存在。所有这些 case 的 postcondition 均为 mode=0、普通 SQL 拒绝、第二 connection mode=0 且写入拒绝。
- `B2_MUTATE_CLEANUP=1` 两 runtime 都在 `normalScope` 非零失败，仍由残留 mode 的 postcondition 命中。
- 错误优先级未回归：正常输出仍为 callback／begin／commit 优先于 rollback／cleanup；`rollbackThrowOriginalWins` 与 `originalErrorWinsCleanupError` 两 runtime 通过。
- `B2_MUTATE_SIDE_EFFECT_ORACLE=1` 两 runtime 均在 `promiseSideEffectRollsBackWithTransaction` 非零失败，说明 rollback 正控确实由 `rowExists` 的目标断言咬住，而非其它 postcondition。
- README:39、76 已将 sync-only 收窄为返回值契约，并说明 SQLite transaction 才是原子边界；README 未把 host FFI 说成跨进程绝对不可伪造。

## 最终 verdict

Spec/capability：通过。Quality：批准，0 Blocker／0 Critical／0 Important／0 Minor。上述原 Important 已闭合，未发现复核范围内的新问题。

## 保留的主观建议／结构怪味

[建议] `probe-b2-{bun,node}` — 近同构状态机在两 runtime 分叉，未来 case 容易漂移。处置：正式实现再抽共享 fixture/case DSL；本 PoC 保持运行时可审计性。

[建议] `maintenance_mode_extension.c:42-53` — 进程内 `dlopen` 代码可调 exported setter，属于架构已声明的宿主信任边界，而非 SQL 绕过。处置：正式 artifact 再评估 opaque handle；不阻断当前 PoC。
