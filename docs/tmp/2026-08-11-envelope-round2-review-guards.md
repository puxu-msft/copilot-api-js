# RequestEnvelope round 2：守卫判别力验收

冻结对象：`4bdbe93a478c4ece6e70b1bb8bc867ed0330a07f`；审查范围仅为 `182ae415`、`05809c80`、`25a24f68`、`fdf8e06d`、`935ec9ba` 的判据判别力与守卫完整性。

## 验收矩阵

| 项 | 由契约导出的可观察判据 | 独立证据与结论 |
|---|---|---|
| C1 | 四个真实 codec 的 `parse` 必须保留 ingress snapshot 的同一对象，且热重载后仍不是新 capture。 | `tests/pipeline/semantic/config-snapshot-carry.it.test.ts:55-98`；隔离变异删除 Responses builder 的 `translationConfigSnapshot` 展开后为 6 pass / 2 fail，恢复后 8 pass / 0 fail。通过。 |
| C2 | 已产出 candidate 的 `body` 不得与源或兄弟残留别名。 | `tests/pipeline/candidate-state.unit.test.ts:111-128`；令 factory 返回 generation body 后 2 pass / 3 fail，含 post-fork 的 `:125`；另 `tests/pipeline/hedged-driver.it.test.ts:226` 会拒绝生产 driver 的 body alias。通过，但见 M1 的相邻 `prepareHints` 缝。 |
| C3 | migrated-cell 用例必须实际走 error/retry 的 strategy 解析，且 capability flag 缺失必须被拒绝。 | `tests/pipeline/driver.unit.test.ts:726-767`；删 `legSupplyReady` 后 0 pass / 1 fail，`strategyFactoryCalls` 为 1。将 transport 与结果断言一同改回 happy path 后，正确 flag 与缺失 flag 均 1 pass / 0 fail，确认旧判据确为恒真；当前修复通过。 |
| C4 | `resolveExchangeStrategies` 必须只在 error handling 中被调用，才能解释 C3 的旧假绿。 | `src/lib/pipeline/driver.ts:737-745`：唯一调用是 `createSemanticRetryPolicy` 的 `candidateStrategies ??=`，其输入为 dispatch 失败的 `error`。通过。 |
| C5 | cell-assembly fake 必须有真实 envelope 的非可选 `candidate` 形状，未来 cell 读取应落在业务断言而非 TypeError。 | 两个补点为 `tests/pipeline/cell-assembly.unit.test.ts:170,225`；`RequestEnvelope.candidate` 非可选于 `src/lib/pipeline/envelope.ts:180-186`，生产直接读取见 `src/lib/codec/openai-cc/openai-cc-cell.ts:68`、`src/lib/codec/anthropic/anthropic-cell.ts:65,73,122,154,159,162`。理由成立。 |
| C6 | baseline 只能收紧，且 ratchet 必须拒绝“成员未增加但新环增加”。 | `935ec9ba` diff 对 `cycles`/`members` 只有删除及 `count:37→12`；`tests/architecture/circular-deps-ratchet.unit.test.ts:44-67` 比较集合。隔离注入 `anthropic-cell→cc-family-strategies`，成员仍为 0 新增、环新增 1，ratchet 1 pass / 1 fail；恢复后 2 pass / 0 fail。通过。 |

## Major

### M1：生产 driver 的 `prepareHints` 候选隔离没有端到端守卫

- 违反的契约是每 candidate 独占 retry hints：`src/lib/pipeline/generation/candidate-state.ts:2-6,73-75`，而 `AttemptScope.prepareHints` 也属于下一 dispatch：`src/lib/pipeline/envelope.ts:153-167`。
- 最小复现：在隔离 worktree 将 `src/lib/pipeline/driver.ts:708` 的 `prepareHints: structuredClone(env.attempt.prepareHints)` 变为 `prepareHints: env.attempt.prepareHints`；变异存在性由该行输出确认。
- 同时运行 C1、C2、C3、C5、C6 和生产 hedge 测试：`bun test tests/pipeline/semantic/config-snapshot-carry.it.test.ts tests/pipeline/candidate-state.unit.test.ts tests/pipeline/driver.unit.test.ts tests/pipeline/cell-assembly.unit.test.ts tests/architecture/circular-deps-ratchet.unit.test.ts tests/pipeline/hedged-driver.it.test.ts` → 92 pass / 0 fail / rc 0。
- 因而现有 C2 只覆盖 body；任何候选对可变 `prepareHints` 的原地嵌套写入仍会污染兄弟 candidate 或源 attempt，而所有本轮守卫为绿。生产代码位置已证实，建议交回 implementer：在真实 hedge/driver 路径断言 source、primary、hedge 的 `prepareHints` 身份不同，并变异验证。

## 执行记录

隔离 worktree：`/home/xp/src/copilot-api-js/.worktrees/verify-envelope-r2`。恢复后的上述六文件最终回归为 92 pass / 0 fail；所有变异均以各自冻结 exact patch 反向应用恢复。
