> **来源**：独立 reviewer（agent `a9e7348e297f3921f`）自有隔离 worktree 下的 `.superpowers/sdd/b1-merged-review.md`（gitignored 路径）。
> **性质**：可追踪存档。reviewer 在隔离副本 `/tmp/b1-parent/b1-mut` 独立复现了 M7/M8/M9，未采信实施侧的测试计数。
> **范围**：首轮合并态评审（`d7bcd84a..cf8f4380`）→ 复评（`cf8f4380..41b349ac`）→ 终轮复评（`41b349ac..af8bbf4d`，approved 0 Critical / 0 Important / 1 Minor）。
> **该 Minor 的处置**：reviewer 判「两条 race 路径同型 owner 逻辑」为本轮应消除，已在 `4b961615` 抽出 `settleRaceOutcome()` 并验证同一 mutation 使两侧同时变红。

# B1 Tasks 1–3 合并态独立代码评审

评审范围：`d7bcd84a..cf8f4380` 的 Tasks 1–3 最终集成状态；不评 Task 4/B2。

已读取／执行的证据：冻结 spec §§5–7、plan Tasks 1–3、durable progress、目标 commit 的最终源码与测试；`git diff d7bcd84a..cf8f4380`；9-file focused suite 为 166 pass／0 fail／570 expect；`bun run typecheck` exit 0；另对 coordinator/candidate 的 unknown rejection 与 recording failure运行 5 个生产 primitive 探针。

总体 verdict：修复 Important 后可进入 Task 4。Blocker／Critical 数量：0。

Spec compliance ❌

Code quality：Issues

计数：Critical 0；Important 3；Minor 0。

## Critical

无。

## Important

1. `src/lib/pipeline/generation/coordinator.ts:190-201,326-337` — coordinator 用 `undefined` 同时表示“未捕获异常”和合法的 thrown value，违反 M7。状态→错误结果：`disposeReadyWithSettlement()` 执行 `throw undefined` 后，`disposalError !== undefined` 为 false；实跑目标 commit 时 `runRecovery()` 仍 fulfilled 并打开 recovery，`disposeUnconsumedReady()` 也 fulfilled，cleanup failure 被吞。Reservation／active 虽释放，但失败状态假绿。建议：增加独立 `disposalFailed`，据它决定 candidate verdict 与重抛；为 recovery disposal 和 unconsumed disposal 增加 `throw undefined` seam 测试。

2. `src/lib/pipeline/generation/coordinator.ts:196-199,315-319,331-335`、`src/lib/pipeline/generation/candidate.ts:87-91` — 三条 Task 3 cleanup 收口路径都在 release 前调用可抛错的 `runtime.settle()`，candidate 又在 recorder 成功前先置 `settled=true`，违反 M6/M7 的 release-first、retry 补记和 verdict 保留。状态→错误结果：candidate recording adapter throw 时，recovery disposal／consumed settlement／unconsumed disposal 三条探针都保留 `activeCandidates=1`；candidate 的第二次补记表面成功但 recorder 总调用次数仍为 1。建议：candidate 仅在 recorder 成功后置 settled guard；coordinator 用共享 release primitive，保存 settlement error 后无条件清 reservation/active，再聚合传播；三条路径均补 adapter-throw＋retry 测试。

3. `src/lib/pipeline/generation/coordinator.ts:214-225` — continuation hand-off 是共享 cleanup owner 中弱一档 sibling，违反 M9。状态→错误结果：`parent.settleDispatch()` reject 时，candidate settlement、reservation release 与 active clear 全部跳过；实跑结果为 rejection 透传但 `activeCandidates=1` 且没有 candidate verdict。建议：复用同一 release primitive，把 dispatch settlement error 保存后将 candidate 标为 failed、释放 reservation/active，再传播原始／聚合错误；补 continuation settlement-reject 测试。此修复属于 B1 coordinator ownership，不是 Task 4/B2 manager职责。

## Minor

无。

## M1–M10 核验

- M1 ✅ `src/lib/context/operation-scope.ts:34-38,64-80`：snapshot 每次冻结；`quiesced` 机械等于 `sealed && childCount===0`；seal 前 transient zero 不 resolve。
- M2 ✅ `src/lib/context/operation-lifecycle.ts:27-36`：delivery terminal 与 blocker 优先级均在纯 primitive 单一来源；canonical `failed` 落到 none，未登记 delivery failure 非 terminal。
- M3 ✅ `src/lib/context/request.ts:883-913,1245-1253`：四事实发布；delivery outcome first-wins；callback 缺失／false／throw 均保持 `failureRegistered:false`。
- M4 ✅ `src/lib/context/request.ts:915-935`：canonical 在 delivery terminal 后启动并 await operation quiescence；两种先后测试均存在；delivery 未登记为 operation child；catch/finally 保留 barrier 语义并释放 raw-capture lease。
- M5 ✅ `src/lib/transport/dispatch-lifecycle.ts:38-50,58-90,133-153`：iterator return rejection同时拒绝 dispose/quiesced；内部 observer 只观察不改公开 promise；EOF、成功 return、重复 dispose 正样本通过。
- M6 ❌ dispatch scheduler 本身在 `src/lib/pipeline/generation/dispatch-scheduler.ts:128-199,372-403` 满足 error-presence、release-first 与 retry 补记；但 candidate recording failure 在上层形成 Finding 2，合并态命题不成立。
- M7 ❌ Findings 1–2；candidate reservation／active runtime 在 unknown rejection与 candidate-settlement throw 下不完整收敛。
- M8 ✅ `src/lib/pipeline/generation/dispatch-scheduler.ts:140-143,179-188` → `src/lib/context/request.ts:1555-1561,783-800` → `src/lib/context/model-operation-record.ts:757-778,1108-1122` 以 own-property 贯穿 `error:undefined`；clean settlement不加字段；focused tests 覆盖 logical／explicit／response／attempt errors。
- M9 ❌ Finding 3；continuation sibling 弱于本轮 consumed/recovery cleanup。此外未见把 B2 manager职责提前塞入 B1；dispatch listener 在 complete 时移除，公开 cleanup promise 不被内部 observer改写。
- M10 ✅ 连续同一 implementer 的依赖链理由合理，独立 merged review 确实发现跨 Task 3 seam 盲点；durable progress 的“Tasks 1–3 complete，B1 review pending”、剩余项与作废路线对当前阶段一致。因本报告发现 Important，progress 后续不得仍把 B1 写成可直接进入 Task 4。

## 双方向结论

错误状态假绿：已实证 `throw undefined` recovery／unconsumed cleanup 与 candidate recording throw 可越过现有绿测；因此当前 166 pass 不能放行 B1。

正确状态假红：正常成功、registered／unregistered delivery failure、canonical registered／unregistered failure、iterator正常 EOF／成功 return／重复 dispose、clean dispatch settlement均有正样本并通过；本轮未发现这些合法状态被现有 gate 误拒。

## 结构怪味

- `src/lib/pipeline/generation/coordinator.ts:181-225,306-338` — 怪味：相同“保存错误→结算 candidate→释放 reservation/active→传播”流程复制且强度不一；处置：本轮必须抽共享 release primitive，因为它直接导致 Findings 1–3，而非仅记 backlog。
- `src/lib/pipeline/generation/candidate.ts:87-91` — 怪味：settled guard 与外部 recorder commit 非原子，且比 dispatch scheduler 的成功后置 guard 弱；处置：本轮修。

修复路由建议：改法明确，交 `gpt-souls:implementer` 修复后由同一 reviewer 复评；不要进入 Task 4 后再用 manager 层掩盖 B1 ownership 缺陷。

---

# 复评追加：`cf8f4380..41b349ac`

评审范围：只复评首轮 Findings 1–3、整改 diff 与相邻 ownership 契约；不重审 M1–M5，不进入 Task 4。

已读取／执行的证据：fix package、`41b349ac` 的 final `candidate.ts`／`coordinator.ts`、更新 progress、Task 3 report；`git diff --check cf8f4380..41b349ac` exit 0；精确 9-file suite 实跑 182 pass／0 fail／643 expect；`bun run typecheck` exit 0；另对相邻 `completeCandidate` 与 race terminal 的 candidate-recorder throw 各跑生产 primitive 探针。

总体 verdict：修复 Important 后可进入 Task 4。Blocker／Critical 数量：0。

Spec compliance ❌

Code quality：Issues

计数：Critical 0；Important 1；Minor 0。

## 首轮 Findings 处置

- Finding 1 ✅ 已关闭。`src/lib/pipeline/generation/coordinator.ts:212-229,352-363` 以 `errors.length` 表达 failure，不再用 error value sentinel；`throwCoordinatorFailures()` 对单个 primitive unknown 包装并保留 cause。`tests/pipeline/generation-coordinator.it.test.ts:342-458` 覆盖 `undefined/null/string/NaN/Error`，并断言 recovery 不开 child、两路径 budget 归零；Task report M2/M3 mutation 均在回退 sentinel 后红。
- Finding 2 ✅ 在原三路径内关闭。`src/lib/pipeline/generation/candidate.ts:88-92` 将 settled guard 后置；`src/lib/pipeline/generation/coordinator.ts:150-160,212-229,339-363` 统一 `settleAndRelease()`，candidate recorder throw 仍在 finally 释放。`tests/pipeline/candidate-runtime.it.test.ts:189-210` 证明 throw-once 可补记且第三次幂等；coordinator adapter tests 与 Task report M4 mutation证明 recovery／consumed／unconsumed release 与有序聚合。
- Finding 3 ✅ 已关闭。`src/lib/pipeline/generation/coordinator.ts:242-257` 先收 dispatch error，再把 parent 结算为 failed／continued并 finally release；有 error 才阻止 child。`tests/pipeline/generation-coordinator.it.test.ts:595-679` 覆盖失败不建 child、dispatch＋recording有序聚合、成功 continuation 与最终 budget 归零；Task report M5/M6 mutation 分别击中 early-await 与漏聚合。

## 新 Important

1. `src/lib/pipeline/generation/coordinator.ts:266-293,388-420,366-370` — shared fix只覆盖 prompt 点名的三条路径，但相邻 candidate owner 仍有同型 release-before-throw 漏洞，R5 不成立。状态→错误结果：`raceReadyCandidates()`／`raceProbePromises()` 在 terminal/failure outcome 先调用可抛的 `runtime.settle()`，后 release reservation；`completeCandidate()` 同样如此。实跑 final commit：candidate recorder throw 时，`raceReadyCandidates([terminal])` reject 原 error 且 `activeCandidates=1`；`completeCandidate()` 也 throw 且 `activeCandidates=1`。真实 hedge path 会把前者 catch 成 stream failure并仅调用 `releaseCandidate(primary)`，若出错的是 hedge sibling，其 reservation仍泄漏。建议：让 race 两个实现和 `completeCandidate()` 也复用 `settleAndRelease()`；race 需把 candidate-recording error纳入既有 failure aggregate／terminal处理而非提前跳出，保留 candidate补记可能性，并分别加 primary-only terminal、hedge sibling terminal/failure、completeCandidate recorder-throw 测试。

## R1–R7

- R1 ✅ 见 Finding 1 关闭证据；成功 recovery/unconsumed 正控保留，未见 false-red。
- R2 ✅ 仅就整改指定的 recovery／consumed／unconsumed 三路径成立；见 Finding 2 关闭证据。
- R3 ✅ 见 Finding 3 关闭证据。
- R4 ✅ `src/lib/pipeline/generation/coordinator.ts:163-170,339-363`：consumed 明确 `wrapUnknown=false`，单一 unknown 原样传播；recovery/unconsumed/continuation默认包装 primitive、Error identity不变、多错误有序 AggregateError。未发现吞 error。
- R5 ❌ race 与 `completeCandidate` 仍存在同型相邻 owner 缺陷；`start()` catch、`cancel()` allSettled＋release、loser `cancel().finally(release)` 未被 shared 改动破坏。
- R6 ❌ 182-test gate、M1–M6 mutation能咬住已写目标，但没有 candidate recorder throw 的 race／completeCandidate 控制，故无法识别上述相邻缺陷；本轮探针已给反例。
- R7 ✅ progress 第 29 行准确写明 fixes 已完成、await reviewer/verifier、B1未闭合；提交序列每个实现 commit均包含该 progress 路径，未见陈旧闭合声称。

B1 merged state 尚未 approved，不可进入 Task 4。

---

# 复评追加：`41b349ac..af8bbf4d`（仅复核上轮新 Important 1）

证据（逐条追加中）：`git diff --stat/--check 41b349ac..af8bbf4d`；`af8bbf4d` 的最终 `coordinator.ts`；对两条 race 路径与 `completeCandidate` 各跑生产 primitive 探针；隔离 `/tmp/b1-mut` 复现 M7–M9。

- C1 ✅ 三处都释放。`src/lib/pipeline/generation/coordinator.ts:150-161` 的 `settleAndRelease()` 在 `finally` 释放 reservation 并清 active；`raceReadyCandidates` 291、`raceProbePromises` 417、`completeCandidate` 372 均改用它。探针：recorder throw 时 `raceReadyCandidates` 与 delayed-hedge 公开路径的 `activeCandidates` 均为 0，`completeCandidate` 抛原 error 且 `activeCandidates` 为 0。
- C2 ✅ 两条路径一致。`coordinator.ts:293-297` 与 `421-426` 把 owner error 追加进 aggregate，`hedgeFailures` 只由 probe failures 构成。探针：owner-only 得 `errors:["OWNER"], hedgeFailures:[]`；probe+owner 得 `errors:["PROBE","OWNER"], hedgeFailures:["PROBE"]`。
- C3 ✅ `coordinator.ts:420,423`：只有 settlement 无错的 terminal 才登记 `firstTerminal`，且仅在 `uniqueOwnerErrors` 为空时返回 terminal。探针 owner-only 返回 `kind:"failure"`，未把该 terminal 当赢家。
- C5 ✅ 未见 false-red。探针：clean terminal 返回 `kind:"terminal"` 且 budget 归零；纯 probe failure 返回 `kind:"failure"`、`hedgeFailures` 两条 PROBE、无 owner error；正常 boundary 胜出路径未改动（`coordinator.ts:285-289,406-414`）。
- C4 ✅ 三条 mutation 已由我在隔离副本 `/tmp/b1-parent/b1-mut`（`git archive af8bbf4d`）独立复现，全部改的是生产代码 `src/lib/pipeline/generation/coordinator.ts`：M7 回退 `raceProbePromises` 的 owner-error 收集 → 目标测试 `coordinator-hedge.unit.test.ts:359` 报 `Expected "failure" / Received "terminal"`；M8 把 `settleAndRelease` 的 release 移出 `finally` → 同一测试 `:364` 报 `Expected 0 / Received 1`；M9 回退 `completeCandidate` 为 settle-then-release → `generation-coordinator.it.test.ts:544` 报 `activeCandidates 0 → 1`。红因均落在目标断言而非旁路。逐条精确反向恢复后，文件与 `af8bbf4d:coordinator.ts` 字节一致，两文件 40 pass／0 fail。

## 结构问题裁决（`raceReadyCandidates` 与 `raceProbePromises` 两份同型 owner 逻辑）

判断：**是重复，且应本轮消除**，级别 major-adjacent 但不阻断——按长远正确＋完整轴，我判它为本轮必须处置项而非 backlog，但不构成新的 blocker/major 发现（下方计数按 minor 记）。理由三条：①两份逻辑的不变量完全相同（owner error 进聚合、`hedgeFailures` 只含 probe failure、terminal 不得在 owner 出错时胜出），而判别力实测是分裂的——我实跑的 M7 mutation 只让 `raceProbePromises` 的测试变红，`raceReadyCandidates` 的同名保护测试仍绿，这正是「守卫追不上第二处实现」的既有形态；②同型缺陷已在本会话连续三轮沿相同轴复发（recovery/consumed/unconsumed → continuation → race/completeCandidate），下一处新增 race 分支会以同样方式漏掉；③已有 `settleAndRelease()` 作为共同基座，抽出「settle-collect-classify」这层只需把两处循环体收敛为一个 helper，不改变任何已冻结行为。做法建议：抽 `settleRaceOutcome(runtime, outcome)` 返回 `{ ownerErrors, failure? }`，两条 race 路径与未来分支共用；抽完后 M7 mutation 必须能同时让两条路径的测试变红——这是该重构的验收判据。

## 本轮结论

Critical 0；Important 0；Minor 1（上述 race 逻辑重复，已给可验收的收敛判据）。

Spec compliance ✅ — C1–C5 全部以 file:line＋独立探针／mutation 复现证实；上轮新 Important 1 关闭。

Code quality Approved（附一条 minor）。

**B1 merged state approved，可进入 Task 4。** 最终证据：`af8bbf4d` 下 9-file B1 gate 加 `coordinator-hedge.unit.test.ts` 共 197 pass／0 fail／687 expect；`bun run typecheck` exit 0；`git diff --check 41b349ac..af8bbf4d` 仅报归档文档 `docs/tmp/2026-08-08-long-resident-operation-lifecycle-task-3-report.md:200` 的 EOF 空行（nit，非代码）。
