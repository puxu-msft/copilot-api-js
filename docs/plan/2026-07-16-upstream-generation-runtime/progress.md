# Upstream Generation Runtime Progress

- 2026-07-17：History V3 已合并 master；分支已 merge master（`6d569b23`），`bun run typecheck` 绿色。
- 2026-07-17：P0-T1 完成。新增五条 live route→driver→sink frame-order golden；初始空 expected 与删除 terminal mutation 均精确红，恢复后 10 连跑全绿，typecheck 绿。独立 reviewer PASS（0 blocker）。
- 2026-07-17：P0-T2 完成。锁定 synthetic scaffold、三类 open-block heartbeat、buffered recovery cadence、exhausted/nonretryable terminal、client-abort 与 terminal 后零 heartbeat。Mutation 精确红；独立 reviewer PASS，修复 FakeClock install 未清残留 timer 的 MEDIUM 后全绿。
