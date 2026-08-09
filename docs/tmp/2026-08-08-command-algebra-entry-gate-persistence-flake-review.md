# Commit -1 entry gate persistence timing fix review

## C1–C3

评审范围：commit `fb04255a` 的 C1–C3，仅评两个 persistence drain test hook、boolean 鉴别力及正确 frozen/unfrozen 路径；C4–C6 留待下一轮。

已读取／执行证据：目标 diff、`docs/tmp/2026-08-08-command-algebra-entry-gate-persistence-flake.md`、最终 `feature-negotiation.ts`／`calibration/engine.ts`／`states-flush-freeze.it.test.ts`／`atomic-fs.ts`；`bun test tests/restart/states-flush-freeze.it.test.ts --rerun-each=10`＝60 pass／0 fail，`bun test tests/infra/resetters-complete.unit.test.ts`＝3 pass／0 fail，`bun run typecheck` 退出 0，`bun run test:backend`＝6388 pass／0 fail。

总体 interim verdict：C1–C3 spec compliance＝可进入下一阶段；C1–C3 code quality＝可进入下一阶段。blocker：0。

### 环境证据

```text
pwd -P
/home/xp/src/copilot-api-js/.claude/worktrees/command-algebra-calibration-flake

git log --oneline -1
fb04255a test: make persistence freeze assertions deterministic

git show --stat HEAD
commit fb04255a134e7fced4fa854e88354406a8906355
Author: Pu Xu <puxu@microsoft.com>
Date:   Sat Aug 8 11:38:16 2026 +0000

    test: make persistence freeze assertions deterministic

 ...command-algebra-entry-gate-persistence-flake.md | 27 ++++++++++++++++++++++
 src/lib/anthropic/feature-negotiation.ts           | 10 ++++++++
 src/lib/models/calibration/engine.ts               | 10 ++++++++
 tests/infra/resetters-complete.unit.test.ts        |  3 +++
 tests/restart/states-flush-freeze.it.test.ts       | 24 ++++++++++---------
 5 files changed, 63 insertions(+), 11 deletions(-)
```

未发现 blocker／major。

- C1：两 hook 只读取、取消并清空各模块既有 `persistTimer`，再调用既有 serialized writer；它们没有被 production 调用，且未修改 `schedulePersist`／`flushAndFreezePersistence` 生产接线。
- C2：返回值由 timer 是否存在直接产生；frozen 下 `schedulePersist` 不建 timer，错误地在 frozen 下建 timer 会返回 `true`，与 frozen 测试的 `false` 断言冲突，不能假绿。
- C3：正确 frozen 路径返回 `false` 且磁盘保持旧快照；reset/SIGINT 后正确 unfrozen 路径建 timer、返回 `true`、await serialized writer 后核对真实磁盘新值。10× 正样本全绿，未见 false-red。

## C4–C6 最终评审

评审范围：同一 commit `fb04255a` 的 C4–C6；沿用上轮已读代码与测试，不重复 C1–C3。

总体 verdict：spec compliance＝可合；code quality＝可合。blocker：0；major：0。

未发现 blocker／major。

- C4：timer callback 确实会先把 `persistTimer` 置 `null` 再启动 serialized writer，此时单看 hook 的 `false` 不能表示“无 writer 在途”；但本测试所有 schedule→drain 均为同一同步调用栈内紧邻调用，中间没有任何 `await`／timer yield，且 debounce 为 1s／5s，callback 不可能抢先。handoff 前置 timer 又由已 await 的 `flushAndFreezePersistence` 清除并排空 writer，故当前用例不存在该误判竞态。
- C5：两条 EXEMPT 仍满足 guard 的原不变量：导出仍被枚举、逐项具名说明，且 hook 不拥有独立 module-global 状态；既有 registered resetter 分别清 timer、状态集合与 frozen flag。把 action hook 加入自动 reset 反会触发写盘，因此具名 EXEMPT 合理，未形成按改名或宽泛规则绕门的口子。
- C6：六条用例没有停在 boolean：每条随后都从 sandbox `PATHS.NEGOTIATION_STATES`／`PATHS.LEARNED_LIMITS` 读 JSON；unfrozen 路径断言新值真实落盘，frozen 路径断言 freeze 前快照存在且 freeze 后新值不在磁盘。hook boolean 与实际磁盘副作用是两个互补 oracle。

## Backend 计数口径

本 reviewer 在隔离评审运行中观测到 `16 shards · 6388 tests · 6388 pass · 0 fail · 7258 executed · 30 skipped`；协调者另一次运行观测为 `6733 tests · 6733 pass · 0 fail · 7258 executed · 30 skipped`。两者是不同运行环境／时点下 reporter 的独立计数，虽 `executed` 与 `skipped` 相同，`tests/pass` 相差 345 的具体来源本轮未独立定位；不得合并、平均或任选其一冒充统一永久基线。两次都只支持各自 checkout／环境下退出 0。
