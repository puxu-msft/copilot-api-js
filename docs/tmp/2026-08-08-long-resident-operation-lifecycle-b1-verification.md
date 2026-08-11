> **来源**：独立 verifier（agent `a925f50d415dc908c`）自有隔离 worktree 下的 `.superpowers/sdd/b1-verification.md`（gitignored 路径）。
> **性质**：可追踪存档。全部命题由 verifier 用真实生产 primitive 独立构造探针取证，**未采信实施侧的测试计数**。
> **范围**：首轮验收（`cf8f4380`）→ I-1 复验（`41b349ac`）→ I-2 复验（`af8bbf4d`，结论 0 findings）。

# B1 lifecycle 独立验收

- 构建锚点：`cf8f4380c9e91bad601ab02ae6d869f61c476916`，验证树：`/home/xp/src/copilot-api-js/.worktree/agent-a925f50d415dc908c`。
- 范围：冻结 spec §§5–7 与计划 Tasks 1–3；不评价 Task 4/B2 或父项目完成度。

## 验收矩阵

| 命题 | 结果 | 独立证据 |
|---|---|---|
| V1 blocker/state 表 | ✅ | `src/lib/context/operation-lifecycle.ts:27-36` 实现优先级；focused suite 含 registered/unregistered failed 与 canonical failed 正反例。|
| V2 RequestContext 偏序 | ✅ | `src/lib/context/request.ts:859-937` 在逻辑 terminal 后 seal、仅在 delivery terminal 后启动 finalizer；`tests/context/request-context.unit.test.ts:125-149` 两个方向。delivery 不作为 scope child 的状态证据在同文件:58-78。|
| V3 delivery/canonical barrier 四分支 | ✅ | `request.ts:884-914` 将 callback missing/false/throw 收窄为未登记；Task 2 的 table 与 canonical failure tests在 focused suite 中均通过。原始 error identity、metadata 与 raw lease release 有实现（`request.ts:909-936,1014`）和现有 targeted tests。|
| V4 iterator cleanup | ✅ | `dispatch-lifecycle.ts:38-90` 保持公开 `quiesced` rejection 且内部 observer 不替换 promise；`tests/transport/dispatch-lifecycle.unit.test.ts:44-165` 覆盖 EOF、return reject、unknown reject、重复 dispose、external abort。|
| V5 scheduler/candidate/coordinator | ❌ Important | 见 Finding I-1：coordinator 的两条 unconsumed/recovery disposal seam 把 `throw undefined` 判作成功，违背 Task 3 “不同 cancel/dispose/quiesced errors”与 spec §7.1 原始错误传播。|
| V6 consumed/unconsumed 同强度 | ❌ Important | consumed scheduler seam 使用 `cleanupFailed` boolean；unconsumed/recovery coordinator seam仍用 `disposalError !== undefined`。同一 `throw undefined` 输入一边失败、一边错误继续。|
| V7 real recorder field presence | ✅（已覆盖值域） | `request.ts:784-800,1557-1561` 与 `model-operation-record.ts:1108+` 走 own-property；`generation-recorder-driver.unit.test.ts:161-222` 真实 final record 有 `error: undefined`，同文件:154-158 正常 committed 无 own error。|
| V8 mutation claims | ⚠️ 收窄 | 实施报告的 Task 1–3 mutation 为线索，不作为本结论单独 oracle。独立 focused suite 为 158 pass/0 fail；I-1 证明报告与已有测试没有覆盖 coordinator unknown-rejection sibling。|
| V9 B1→Task4 接口 | ❌ | Task4 可消费 snapshot/callback，但 Task3 cleanup contract 尚不可靠，不能称 B1 independently verified 或进入 Task4。未声称父项目完成。|

## Finding I-1：coordinator 吞掉 `throw undefined` 的 disposal failure

- **严重度：Important；违反：spec §7.1、Task 3 interfaces/Step 4。** Cleanup 错误应在 finally 释放所有权后传播；错误值可为 `undefined`（本批 scheduler/dispatch 已明确测试该值）。
- **最小复现：** 在当前构建运行下列 probe：

```sh
bun -e 'import{createGenerationCoordinator as c}from"./src/lib/pipeline/generation/coordinator";let n=0,e=[];let r=role=>{let h=`candidate-${++n}`;return{handle:h,role,async run(){e.push(`${h}:run`);return{candidate:h,dispatch:`dispatch-${n}`,env:{},wire:{},dispatchedAtMonotonic:0,upstream:{},processor:{}}},async disposeReadyWithSettlement(){e.push(`${h}:dispose`);throw undefined},async cancel(){},settle(x){e.push(`${h}:settle:${x.verdict}`)},recovery(){throw Error()}}};let x=c({env:{},createCandidate:({role})=>r(role)}),p=await x.runPrimary(),o=await x.runRecovery(p,"undefined-cleanup",{}).then(v=>({state:"resolved",role:v.role}),error=>({state:"rejected",error}));console.log(JSON.stringify({outcome:o,events:e}))'
```

- **实际结果：** `{"outcome":{"state":"resolved","role":"recovery"},"events":["candidate-1:run","candidate-1:dispose","candidate-1:settle:failed","candidate-2:run"]}`。也就是说 primary disposal 明确 reject `undefined` 后，`runRecovery()` 被误判为成功并启动 recovery。交叉值域探针显示仅 `undefined` 漏判；`null`、string、NaN 都 reject，说明缺陷是 sentinel 而非所有 unknown 值。
- **根因位置：** `src/lib/pipeline/generation/coordinator.ts:191-202` 与 `:324-338` 用 `disposalError !== undefined` 作失败 sentinel；catch 能捕获 undefined，但丢失“catch 发生”这一事实。对照已正确的 `src/lib/pipeline/generation/candidate.ts:135-154` 和 `coordinator.ts:307-321` 使用显式 boolean。
- **现有测试缝：** `tests/pipeline/generation-coordinator.it.test.ts:268-335` 只注入 `Error`，没有 `undefined/null/string/NaN` disposal rejection；`tests/pipeline/candidate-runtime.it.test.ts:249-309` 只覆盖 scheduler unconsumed/consumed seam，因此全绿不能证 coordinator seam。
- **建议：** 在两条 coordinator disposal 路径改为 `let disposalFailed = false; catch { disposalFailed=true; ... }`，finally verdict/reason 和后续 throw 都按 flag；用 `undefined/null/string/NaN` 表驱动 recovery 与 unconsumed 两条路径，断言 active/reservation 归零、failed verdict、且公开 Promise 以原值或既有 AggregateError 语义 reject。交回 implementer；不改 spec/架构。

## 实跑

- `bun test tests/context/operation-lifecycle.unit.test.ts tests/context/operation-scope.unit.test.ts tests/context/request-context.unit.test.ts tests/context/generation-recorder-lifecycle.unit.test.ts tests/transport/dispatch-lifecycle.unit.test.ts tests/pipeline/candidate-runtime.it.test.ts tests/pipeline/generation-recorder-driver.unit.test.ts tests/pipeline/generation-coordinator.it.test.ts` → exit 0，158 pass／0 fail，8 files。
- `bun run typecheck` → exit 0（`tsc`）。
- `git diff --check d7bcd84a..cf8f4380` → exit 0。

## Verdict

**Acceptance ❌：1 Important，0 Critical，0 Minor。** B1 不能进入 Task 4，需先修 I-1 并以 coordinator 的 unknown rejection table 正负控复验。


## Re-verification：`41b349ac9ad50573a280f22eb968d3e031e164fc`

- 范围仅复验 I-1 整改与相邻 coordinator/candidate seam；本轮不重审 V1-V9 或 Task 4。
- **V1 已确认。** `coordinator.ts:212-238` 以 errors array 而非 value sentinel 记录 recovery disposal；独立 probe 对 `undefined/null/string/NaN/Error` 均输出 `rejected:primary`，没有启动 child。`generation-coordinator.it.test.ts:342-401` 同表断言 failed verdict 与 active/reservation 归零；其 targeted run exit 0，11 pass。
- **V2 已确认。** `coordinator.ts:352-364` 与 `tests/.../generation-coordinator.it.test.ts:403-498` 覆盖 unconsumed 同值域、failed verdict、预算归零与成功 caller verdict；同一 targeted run exit 0，11 pass。
- **V3 部分确认，但发现 I-2。** `settleAndRelease()`（`coordinator.ts:150-161`）正确让 recovery/consumed/unconsumed 在 candidate adapter throw 后 release-first；`candidate.ts:88-92` 也修正 guard 后置。adapter/continuation targeted commands均 exit 0（1 pass；5 pass）。但公开 sibling `completeCandidate()` 仍直接 `runtime.settle()` 后才 release（`coordinator.ts:366-369`），adapter throw 将跳过 release。
- **Finding I-2（Important）：** 真实最小 probe 在 final HEAD 构造 budget=1 的 primary，其 `runtime.settle()` throw `Error("record")`，调用 `completeCandidate(primary,"failed","x")`。输出 `{"out":"original","budget":{"activeCandidates":1,"totalCandidates":1,"activeDispatches":0,"totalDispatches":0}}`。即原始错误传播但 reservation 泄漏；违背 spec §7.1「catch 保存原始错误，finally 释放 reservation／active，随后重抛」以及本次“release-first all cleanup outcomes”目标。现有 retry tests仅在首个 adapter throw 后再调用 `completeCandidate()`，没有令 `completeCandidate()` 本身 throw，故全绿。建议令它复用 `settleAndRelease()`，并加 throw-once/throw-always control，断言 activeCandidates=0 和可补记。
- **V4 已确认。** `coordinator.ts:242-257` 在 continuation dispatch reject 后 release-first，阻止 child；`:626-680` 覆盖 dispatch reject、dispatch+recording 有序 AggregateError、成功 continuation 与预算归零。
- **V5/V6 收窄结论。** M1-M6 报告的对应机制有最终源码和 targeted tests支撑，但不能覆盖 `completeCandidate` 这条未共用 helper 的邻接路径；I-2 是“实现坏而新 tests 绿”的反例。

### Re-verification verdict

**Acceptance ❌：0 Critical，1 Important（I-2），0 Minor。** I-1 已修复；但 B1 尚不能独立验证、不得进入 Task 4。交回 implementer 修复 I-2 后复验。


## Re-verification 2：`af8bbf4d` (I-2 修复)

- Gate：`/home/xp/src/copilot-api-js/.worktree/agent-a925f50d415dc908c`（自有隔离树，`GIT_DISCIPLINE_OK=1 git checkout af8bbf4d` detached）；`pwd -P`／`git rev-parse HEAD`＝`af8bbf4db6dc964ab799c67c60466aed975997b8`。只读复验，未写实施树。
- **V-I2 已确认。** probe：budget=1 primary，`runtime.settle()` throw `e`，`completeCandidate(p.candidate,"failed","x")`。输出 `{"out":"original","budget":{"activeCandidates":0,...}}`——原始 error 原样传播且 reservation 已释放，`coordinator.ts:370-372` 复用 `settleAndRelease()`。**I-2 已修复。**
- **V-R1 已确认。** probe：单 terminal candidate（无 boundary）+ recorder throw，`raceReadyCandidates([primary])`。输出 `{"outcome":"rejected","isRecordingError":true,"budget":{"activeCandidates":0,...}}`——recording error 原样进入 aggregate，reservation 归零。`coordinator.ts:290-294` 复用 `settleAndRelease()`。
- **V-R2 已确认。** probe：`racePrimaryWithDelayedHedge`，primary 延迟 20ms terminal，hedge 立即 terminal 但 recorder throw。输出 `{"kind":"failure","isRecordingError":true,"hedgeFailures":[],"budget":{"activeCandidates":0,...}}`——两候选 reservation 都归零，结果为 failure 非 terminal 胜出。对应 `raceProbePromises()`（`coordinator.ts:393-427`）同一 `settleAndRelease` 注入。
- **V-P 已确认。** probe：primary probe throw + recorder throw 叠加。`err.errors` 顺序为 `[probe, recording]`，但 `hedgeFailures` 只含 probe（`hedgeFailuresContainsRecording:false`，`hedgeFailuresContainsProbe:true`，长度1）。Provenance 未被 owner recording error 污染，`coordinator.ts:424` 注释与实现一致。
- **V-FR 已确认，无过严误判。** 4 个正样本 probe：boundary win 单候选→`{"ok":true,"kind":"winner"}`；单纯 probe failure（无 recorder throw）→ `errorsLength:1`、`hedgeFailuresLength:1`，未被 owner 逻辑误吞或误加；delayed-hedge primary 快速 boundary win→`{"kind":"winner","budget":{"activeCandidates":1,...}}`（未被强行释放，符合“hedge 从未启动”语义）。单候选 terminal-without-boundary 且无错误时 `raceReadyCandidates` 仍 throw（`ok:false`）——核对 `coordinator.ts:266-301` 接口只声明 `HedgeWinner`（无 terminal 分支），该行为是既有设计（B1 修复前后一致），不计入本轮假红。

### Re-verification 2 verdict

**Acceptance ✅：0 Critical，0 Important，0 Minor（本轮范围：I-2 与相邻 race owner seam）。B1 可独立验证，可进入 Task 4。**
