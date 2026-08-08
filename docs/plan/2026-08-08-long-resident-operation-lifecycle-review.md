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

另一项自审修订：`failureRegistered` 由 RequestContext 自有 failure ledger 决定，不依赖 manager callback 是否存在；manager callback 只把同一 failure 收入 process shutdown barrier并去重。这样直接构造的 context 也能到达可 join delivery/canonical terminal。

## 复评门

复评必须逐条确认 P1～P4 closed，并核对新增 Task 3、failure ledger 单一所有权、Task 1～8 编号与接口一致、规格 §§2～12 全覆盖。只有 0 blocker／0 major 才可执行。
