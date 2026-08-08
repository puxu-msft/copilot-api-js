---
slug: impl-1
base: 92858d08606ad0ff02eb6ec7779f765e3e6109fe
branch: fix-long-resident-operations
worktree: /home/xp/src/copilot-api-js/.worktree/fix-long-resident-operations
plan: docs/plan/2026-08-08-long-resident-operation-lifecycle.md
agent_id: a-impl-1
session_id: pending
status: in-progress — Task 1～4 complete; B2 已闭合，待开 Task 5
---

# B1 lifecycle 实施进度

## 连续性裁定

- 分类：Task 1～3 需要同一 implementer 连续执行。
- 理由：Task 2 消费 Task 1 的精确类型，Task 3 又同时触及 dispatch／scheduler／candidate／coordinator cleanup ownership；拆实例会重复重建偏序和 error ownership，且容易把 plan 的同名接口实现成不同语义。
- 相位收口时由独立 reviewer 复核该连续性裁定。

## 剩余项

- B2（Task 4）已闭合：`RequestContextManager` 新增单一 release primitive `releaseTrackedOperationIfTerminal()`，两条 finalizer promise 分支（resolve／reject）均只调用它，不再各自 inline `operationScopes.delete`；`getTrackedOperationsSnapshot(now?)` 每次遍历重新聚合（不维护平行计数），四个非-`none` blocker 求和恒等于 `count`，若遇 `blocker === "none"` 立即抛 invariant error（证明 release 接缝漏执行，而不是把它计入公开聚合）；`drainModelOperationFinalizations()` → `drainLifecycleFailures()` 完成改名。
- Task 5～8 未开工。

## 由本轮（Task 4）发现并处置的 plan-vs-code 差异

- **发现**：plan Task 4 的「Files」清单只列 `Modify: src/lib/context/manager.ts`，但 manager 的 `drainModelOperationFinalizations()` 是 `RequestContextManager` 接口方法，其**唯一生产调用点**在 `src/lib/shutdown.ts:433`（`peekRequestContextManager()?.drainModelOperationFinalizations()`）——该文件与依赖字段改名（`drainModelOperationFinalizationsFn`/`FinalizeDeps.drainModelOperationFinalizations`）是 plan **Task 6** 的显式职责（Task 6 Files 清单含 `Modify: src/lib/shutdown.ts`，Interfaces 也写明 rename）。若 Task 4 只改 manager 而不动这一行调用，`bun run typecheck` 会在 Task 4 阶段就失败（`Property 'drainModelOperationFinalizations' does not exist on type 'RequestContextManager'`），但 Task 6 的其余 rename（`ShutdownDeps.drainModelOperationFinalizationsFn` 字段名、`FinalizeDeps.drainModelOperationFinalizations` 字段名、shutdown 单元测试里的 fixture key）尚未到期，不能在本轮提前做完（会侵占 Task 6 范围、且当前证据不足以判断 Task 6 是否还有额外理由保留旧字段名一段时间）。
- **处置**：只把 `shutdown.ts:433` 这一行**调用目标**从 `.drainModelOperationFinalizations()` 改为 `.drainLifecycleFailures()`（manager 侧新名），使 Task 4 的验收命令（含 `bun run typecheck`）可独立通过；`ShutdownDeps`/`FinalizeDeps` 的字段改名、`tests/shutdown/shutdown.unit.test.ts` 的 fixture key、`formatActiveRequestsSummary`/`getActive` 等其余 Task 6 重命名**原样保留给 Task 6**，并在改动处留了行内注释指向这条切分。这是最小必要的相邻改动（`fix-at-the-shared-base-not-where-you-noticed` 的反面同理适用——只动能让 Task 4 独立可验的那一行，不顺手把 Task 6 的范围做掉）。
- 同时把 `tests/context/manager-dual-registry.unit.test.ts` 里唯一引用旧方法名的断言（`manager.drainModelOperationFinalizations()`）同步改为 `manager.drainLifecycleFailures()`——这条测试在 plan Task 4 的「Files」清单内，属于本轮范围。

## 在途意图

- Task 1 已完成 reviewer 修复：sealed 且 child 未退出时 snapshot 保持 `quiesced: false`；delivery terminal 覆盖全部 state；canonical `failed` 是已登记终态。三项精确 mutation 均已按目标断言转红后恢复，Task 1 仍 complete。
- Task 2 已完成并采纳 reviewer 修复：RequestContext 发布 logical／operation／delivery／canonical snapshot；delivery outcome 与 canonical join 分离，首次 delivery outcome 不可覆盖；delivery/canonical failure 仅在 process shutdown lifecycle failure barrier callback 返回 true 后终结；两种合法 operation/delivery 先后、canonical commit failure 四种 barrier 结果均已覆盖；canonical failure tests 配置独立 in-memory raw capture fixture，正样本断言 ctx 创建后 lease 增一、reject 后恢复各例基线。
- Task 3 已完成并采纳两轮 review 修复：iterator `return()` cleanup error 以同一 identity reject `dispose()` 与 `quiesced`；scheduler cleanup failure 强制 dispatch failed verdict，按 cancel/dispose/quiesced 顺序保留全部 SameValueZero-distinct cleanup errors，并把已有 upstream error 与 cleanup errors 一起保留在 settlement diagnostics；内部 observer 防止未 join `quiesced` 时 unhandled rejection，公开 promise 仍原样 reject；adapter settlement throw 不占 settled guard，active slot 在 finally 释放且后续可补记。candidate verdict、coordinator reservation 与 active runtime 均在 release-first finally 路径收口。Task 3 的 verdict、multi-error、observer、adapter guard 与 undefined rejection mutation 均已通过针对性红测后恢复；补强测试现已直接证明 recording error 聚合与 scheduler live seam 的 undefined cleanup failure；经冻结 brief 裁决，顶层保持既有 `AggregateError` 包装，内层 `Error("undefined")` 可追溯该 primitive reason，且仍断言 failed settlement 与 active-slot release。第三轮将 consumed settle 收敛到同一错误聚合 primitive，覆盖 undefined quiescence、upstream＋quiescence diagnostics、recording adapter failure 后补记与 active-slot release。第四轮修复 scheduler richest diagnostic 到真实 recorder 的 presence 退化：dispatch settlement `error: undefined` 现在穿过 RequestContext 的位置参数 helper 后仍保留 canonical snapshot own property；普通 object spread 已自然透传字段，故移除冗余 driver presence 重述。真实终态 oracle 直接读取 `whenModelOperationFinalized()` 返回的 terminal record；无 error 的正常 settled dispatch 不含该字段。第五轮将 generation attempt settlement 重构为对象形状，移除位置参数与 `hasError` 双源，令 logical／explicit dispatch／superseded／response failure／attempt failure 五条路径都由对象字段存在性表达是否携带 error。
- B1 merged-state verifier I-1 的 Findings 1～3 实现与 focused tests 已完成：candidate recorder settlement 只在成功后占 guard；coordinator recovery／continuation／consumed／unconsumed 路径均先保留 dispatch/disposal error、再尝试 candidate settlement、finally释放 reservation和active，随后按顺序传播 distinct errors。candidate recorder throw-once 与 recovery／consumed／unconsumed adapter-failure focused tests 已完成；continuation dispatch-failure／dual-error／success controls 已完成；race/completeCandidate ownership production + primary-only race owner tests + delayed-hedge public-path owner/probe tests + M7-M9 mutation controls complete；完整 B1 focused gate 已通过（十文件 197 pass／0 fail／687 expect，`bun run test:backend` 6681 pass／0 fail，typecheck exit 0；证据存档 `docs/tmp/2026-08-08-long-resident-operation-lifecycle-task-3-report.md`）。B1 merged-state review 已闭合：reviewer approved（0 Critical／0 Important／1 Minor），verifier 0 findings。reviewer 判「两条 race 路径各有一份同型 owner 逻辑」为本轮应消除的结构问题：已抽出共用的 `settleRaceOutcome()`，`raceReadyCandidates()` 与 standalone `raceProbePromises()` 均改用它；同一条 mutation（owner-error 收集回退为丢弃）已验证同时使两条路径的 owner 测试变红，reverse-check 后精确恢复。
- `failureRegistered` 的权威含义是 process shutdown lifecycle failure barrier 已同步持有错误；不得改成 context-local ledger。
- Candidate reservation 的真实 owner 是 `coordinator.ts`；scheduler 只拥有 dispatch active slot，candidate 只拥有 verdict。
- Task 4：manager 侧新增的 `onLifecycleFailure` 实现按 `(requestId, phase)` 去重——同一 key 重复调用且携带同一 error identity 时幂等返回 `true`（不重复计入，避免同一失败被 canonical catch 与延迟 delivery-failure 重试各注册一次）；同一 key 携带**不同** error 时返回 `false`（该 barrier 是「每 phase 一个错误」的存在性登记闸门，不是多错误收集器——真正的多错误累积发生在 `drainLifecycleFailures()` 的 `modelOperationFinalizationFailures` 数组，那是跨请求的持久化 drain，两者职责不同不可合并）。
- Task 4 关闭前重跑过一次 mutation 双控（写在 `getTrackedOperationsSnapshot` 的 `oldestAgeMs` 计算上，把 `<` 误改成 `>`）：目标测试红（`oldestAgeMs`／`count` 断言不符），reverse 后精确恢复绿；未在正式 mutation 清单外新增独立文档，因为 Task 8 才是 exact-patch mutation 存档节点，本轮只是开发期自证。

## 已作废路线

- 作废：按逻辑 `failed` 从 shutdown drain 过滤。原因：会 false-green 地跳过仍在运行的 operation／delivery／canonical work。
- 作废：把 delivery finalizer登记成 operation child。原因：canonical join 会产生 self-join。
- 作废：吞掉 `iterator.return()` rejection 以换取 quiescence。原因：隐藏 cleanup failure，且无法证明资源真的成功释放。
- 作废：`failureRegistered` 只表示 context 本地记录。原因：独立 plan reviewer 证伪，违反冻结 spec。
- 作废（Task 4）：在两条 finalizer promise 回调（resolve／reject）内各自直接 `operationScopes.delete(id)`。原因：plan Step 3 明文禁止（"禁止在两条 promise callback 内直接 operationScopes.delete"）——那样会绕开对 `blocker` 的读取，让一个 canonical 失败但**未被 barrier 登记**（`onLifecycleFailure` 返回 false／抛错／缺失）的 ctx 被静默移出 registry，导致 shutdown drain 与 `/api/status` 假绿地报告"已收敛"。改为两条分支都只调用同一个 `releaseTrackedOperationIfTerminal()`。
- 作废（Task 4）：把 Task 6 的 `ShutdownDeps`/`FinalizeDeps` 字段改名与 `formatActiveRequestsSummary`/`getActive` 重命名一并在本轮做掉。原因：超出 Task 4「Files」清单声明的范围，且用户 kick-off 明确要求「不要碰 Task 5–8」；只做了让 Task 4 自身可独立 typecheck 通过所必需的单行调用目标切换（见上「plan-vs-code 差异」节）。

## 每 commit 更新纪律

每个实现 commit 必须同时更新本文件；只记剩余项、在途意图和作废路线，不复述 git log。B1 完成后运行 plan §6b 的 `--first-parent` 对账脚本。
