# Envelope round 3 merged-state review

裁决资格：具备。本评审者未参与被审的 envelope 四个提交或所列 peer 提交；审计对象固定为 `55d9d934d30ee46cf0810136c437b21f0429425a`。

## 结论

- C1：无 blocker／major。`src/lib/pipeline/driver.ts` 中无 `const envAtStart = env` 一类把 `RequestEnvelope` 当快照的捕获。仅有 `current = env`（`554-563`，同步重写链的当前值）、`currentEnv = env`（`1474-1475`，每次 recovery 后重绑为 `recovered.env`，`1915-1936`）与 `continuationOriginalBody`（`1498-1499`，有意保留初始 body 供 continuation）；后者不是 envelope 引用，且当前后续写入通过 `writeAttempt` 替换 `attempt.body` 槽位，不回写该对象。
- C2：无 blocker／major。候选 fork 在 `driver.ts:699-710` 对 `attempt.body`、`attempt.prepareHints` 分别 `structuredClone`，而 `forkEnvelope` 只共享 `request`、`ctx`（`src/lib/pipeline/envelope.ts:229-245`）。实 hedge 路径测试 `tests/pipeline/hedged-driver.it.test.ts:210-243` 同时证实两项 attempt 独占和 request 共享。post-terminal 只读选中候选的 `selected.processor.responseOpts`（`driver.ts:1145-1155`）；seal 提交 `49f52073` 位于 transport 层，按显式 dispatch 写 `env.ctx`，不保存 envelope 快照；deadline 提交仅在 `driver.ts:1888-1898` 对当前 attempt 的 cancellation kind 决定重试。
- C4：无 blocker／major。`git show` 的路径与语义逐项相符：`3f6fd34c` 更新可变 envelope 文档／hook 契约，`f686d2d6` 收紧处置与术语证据，`67c84f52` 在真实 hedge transport 断言 `prepareHints` 隔离，`55d9d934` 补处置表及记忆索引。
- 附加通过性证据：在隔离 worktree 的相同 HEAD 运行 `bun test tests/pipeline/hedged-driver.it.test.ts tests/pipeline/driver.unit.test.ts tests/pipeline/precontent-recovery-seal-race.it.test.ts`，输出为 `80 pass`、`0 fail`。

## Major

1. **C3 未满足：不能确认 `bun run test:backend` 为 0 fail。** 在隔离 worktree 的目标 HEAD，backend 的 unit shard 中 `tests/history/v3/migrations-wiring.it.test.ts` 有三例均在约 5 秒超时：in-flight summary backfill drain、legacy-authority integrity migration、injected `MIGRATIONS` 的真实 DDL。随后单独 `bun test --isolate tests/history/v3/migrations-wiring.it.test.ts` 复现同三例，故不是“单跑过、全套件才挂”的污染形态。两次 runner 均在报告这些超时后不退出；为清理本人隔离实验而精确终止，故 `test:backend` 的最终 `144` 是终止结果，不能冒充测试失败码。影响：C3 的 0-fail 验收尚未成立。建议交给 `gpt-souls:debugger` 定位 migrations test 的挂起／超时，再重跑完整 backend 档。

隔离 worktree `/home/xp/src/copilot-api-js/.worktrees/verify-envelope-r3` 已在确认 clean 后移除。