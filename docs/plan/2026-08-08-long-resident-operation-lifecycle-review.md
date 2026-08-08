# 超长驻留 operation 生命周期实施计划评审

## 首轮

- 冻结 commit：`302cce2e4b3fc0eb8c0cd1bfd7a9f7bb1ccb6c7f`
- Reviewer：Claude `reviewer`，只读 `Read/Bash`
- Verdict：0 blocker／4 major，修订后可执行。

## 发现处置

全部属于可逆 plan 产物的 C 级裁定；主会话对照 plan、spec、代码与 `package.json` 复核后全部采纳，没有暂定驳回。

| ID | 发现 | 处置 | 修订 |
|---|---|---|---|
| P1 | `OperationScope.snapshot` 同时写成方法和 getter 属性 | 采纳 | 全文统一为 `readonly snapshot: OperationScopeSnapshot` getter |
| P2 | `byBlocker: Record<OperationBlocker,...>` 错误要求公开 `none` 键 | 采纳 | 新增 `TrackedOperationBlocker = Exclude<OperationBlocker,"none">`；聚合发现 `none` 时抛 invariant error |
| P3 | Task 8 只写五组 mutation，漏 candidate/dispatch release 与 blocker mapping | 采纳 | 恢复规格 §12 完整八项 mutation，并写明目标 oracle |
| P4 | Recovery 既有合同无逐项可执行命令，SDK E2E 不在 `test:backend` | 采纳 | 新增 recovery 合同命令表，显式运行 SDK E2E、History 双读、three modes、C9、budget 与 architecture guards |

## 计划自审额外发现

首轮 reviewer 之外，主会话自审发现规格要求处理 iterator cleanup reject，而初版计划只在最终矩阵测试、没有实现任务。已新增 Task 3：让 `createDispatchLifecycle.quiesced` 对 `iterator.return()` error reject，并要求 scheduler／candidate 在 `finally` 释放 active slot、reservation 与 verdict 后传播原始错误。

另一项首轮自审曾尝试把 `failureRegistered` 定义为 RequestContext 自有 failure ledger 已登记，不依赖 manager callback。第二轮 reviewer 以冻结 spec 证伪该解释：字段的权威含义是“process shutdown lifecycle failure barrier 已持有错误”。该尝试已由 P6 处置取代，不再是活计划。

## 复评门

复评必须逐条确认 P1～P4 closed，并核对新增 Task 3、failure barrier 单一所有权、Task 1～8 编号与接口一致、规格 §§2～12 全覆盖。只有 0 blocker／0 major 才可执行。

## 第二轮复评

- Reviewer：内置 Agent `reviewer`，冻结对象 `760146ce77e032d1b1bd1cd40f83795cb36dfe66`。
- 首次输出因 API mid-response 中断；主会话使用 `SendMessage` 恢复同一 reviewer，并把输出缩到 30～50 行。
- Verdict：0 blocker／2 major。

| ID | 发现 | 处置 | 修订 |
|---|---|---|---|
| P5 | Task 3 把 candidate reservation release 错归 `candidate.ts`；真实 owner 是 `coordinator.ts` | 采纳（C） | Task 3 加入 `coordinator.ts` 与 `generation-coordinator.it.test.ts`；明确 scheduler release dispatch slot、coordinator release candidate reservation／active runtime、candidate保留 verdict |
| P6 | Plan 把 `failureRegistered` 偷换成 context-owned ledger，违背 spec“已进入 shutdown lifecycle failure barrier” | 采纳（C） | 保持 spec 不变；`onLifecycleFailure` 改为同步返回 boolean，只有 manager barrier 确认持有 error 才置 `failureRegistered:true`／`canonical:failed`；无 callback／登记失败保持 blocker，不得伪装 terminal |

两条均经主会话对照 `coordinator.ts` 的 `candidateReservations` 所有权和 spec §§5.3／7.3 独立复核确认。修订后必须恢复同一 reviewer 复评 P5／P6，并检查没有新增 blocker／major。

## 第三轮复评

- Reviewer：恢复同一个内置 Agent `reviewer`。
- 冻结 commit：`6d28b1b7`。
- Verdict：**0 blocker／0 major，计划可执行。**

| ID | 结论 | 证据摘要 |
|---|---|---|
| P5 | closed | Task 3 将 `coordinator.ts` 明确列为 candidate reservation／active runtime 的真实 owner；focused test 与 commit pathspec 均包含 `generation-coordinator.it.test.ts` 和 `coordinator.ts` |
| P6 | closed | `onLifecycleFailure(...): boolean` 只在 shutdown barrier 已持有错误时返回 true；缺 callback、抛错或 false 均保持非终态 blocker，不误删 registry或伪装成功 |

Reviewer 还确认 Task 1～8 编号、其余接口和路径一致，修订没有引入新的 blocker／major。
