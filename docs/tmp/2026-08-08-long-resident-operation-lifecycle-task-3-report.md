> **来源**：`.superpowers/sdd/task-3-report.md`（SDD 流程活文件，位于 gitignored 路径，`git clean -xdf` 会删除它）。
> **内容**：B1 Task 1–3 的实施记录与全部 mutation 对照证据（M1–M9），含每条变异的目标测试、失败断言原文与恢复证据。
> **性质**：本副本是**可追踪存档**，只为防止证据丢失；SDD 流程的活文件仍是 `.superpowers/sdd/` 那一份。

# Task 3 实施报告

- status：DONE
- 实现 commits：`4de3cd6e134434b6246438c771af125514ace902`、`ccac5cbf130abca7c2de6455fb71ec0f52dbe677`，以及 reviewer-fix 整改提交 `d9713ed9e70cbd6c64c4922cfbbbc2f889a694b0`、第二轮 reviewer-fix 整改提交 `9e9cedd5d27956cee148464ff0c3be9f8b15713a`、第三轮 consumed-settlement 整改提交 `50897d729ce7f9dd8f31623936aecdd8efaf7d9b`、第四轮真实 recorder presence 整改提交 `4e6bbefe40fd1be3bec9687b182f9bb6515df114`、终态 dispatch error oracle 校正提交 `8bc324fc456857e5572a4256640ce232b2267ff8`、第五轮 generation settlement-shape 整改提交 `cf8f4380c9e91bad601ab02ae6d869f61c476916`、B1 candidate ownership failure 修复提交 `41b349ac9ad50573a280f22eb968d3e031e164fc`；尾部历史已本地 rebase 为 `40f15abd2f6ff35025785026a591447f1a3ecdc2`（test + progress fold）、`f55e8e82c8a2e3b280d720419906804488ad843c`（AggregateError oracle correction + progress）与 `39c53284a144ea4fd55b6497f1039a0fca56b919`（TS narrowing + final progress），均为本地提交，未 push。旧尾部 SHA 由本地 rebase 取代，恢复 ref 为 `backup/task3-pre-progress-fold-18d9aa1b`。
- 基线：实施前已核验 HEAD 为 `f05db881a4ada7db5c4495a35c37d68174f45404`。

## 已完成

1. `createDispatchLifecycle()` 的 iterator `return()` cleanup reject 现在用原始 error identity 同时 reject `dispose()` 与 `quiesced`；自然 EOF、成功 return 与重复 dispose 的原有正样本保留。
2. scheduler 将 active dispatch 删除与 settlement 写入放入 cleanup `finally`，使 dispose/quiesced reject 后 slot 仍释放，随后才传播原始 cleanup error。
3. candidate runtime 仍让 scheduler cleanup rejection 到达调用者，且 candidate verdict 由 coordinator 收口；coordinator 的 recovery disposal、consumed settlement 与 unconsumed disposal都在 `finally` 释放 candidate reservation 与 active runtime。
4. 进度文件已标记 Task 1～3 complete，唯一剩余项为 B1 merged-state review；本轮未执行该 review 或 Task 4。

## TDD 与验证证据

- 红测试命令：`bun test tests/transport/dispatch-lifecycle.unit.test.ts --test-name-pattern='return rejection|natural body completion'`
- 红测试结果：exit 1；原实现吞掉 iterator `return()` rejection，`dispose()` 错误 resolve，命中目标 failure-propagation 缺陷。
- lifecycle mutation：临时把 `complete(error)` 改为一律 resolve quiesced；`bun test tests/transport/dispatch-lifecycle.unit.test.ts --test-name-pattern='return rejection'` exit 1，`quiesced` 得到 `undefined` 而非同一 `cleanupError`。随后精确恢复 reject 分支。
- active-slot mutation：暂时移除 scheduler cleanup `finally` 的 `active.delete(dispatch)`；`bun test tests/pipeline/candidate-runtime.it.test.ts --test-name-pattern='cleanup rejection releases'` exit 1，后续 `settleDispatch()` 被遗留 active slot 的 rejected quiescence 阻断。恢复后该 focused test 通过。
- coordinator reservation mutation：暂时移除 recovery disposal `finally` 的 reservation release；`bun test tests/pipeline/generation-coordinator.it.test.ts --test-name-pattern='recovery disposal failure'` exit 1，budget 显示 `activeCandidates: 1` 而非 0。随后精确恢复。
- 绿测试命令：`bun test tests/transport/dispatch-lifecycle.unit.test.ts tests/pipeline/candidate-runtime.it.test.ts tests/pipeline/generation-recorder-driver.unit.test.ts tests/pipeline/generation-coordinator.it.test.ts`
- 绿测试结果：37 pass、0 fail、165 expect。
- typecheck 命令：`bun run typecheck`
- typecheck 结果：exit 0，执行 `tsc`。
- 静态检查：`git diff --check` exit 0；最终 `git status --short` 无输出。

## 改动路径

- `/home/xp/src/copilot-api-js/.worktree/agent-a46e6c56981b3cd1b/src/lib/transport/dispatch-lifecycle.ts`
- `/home/xp/src/copilot-api-js/.worktree/agent-a46e6c56981b3cd1b/src/lib/pipeline/generation/candidate.ts`
- `/home/xp/src/copilot-api-js/.worktree/agent-a46e6c56981b3cd1b/src/lib/pipeline/generation/dispatch-scheduler.ts`
- `/home/xp/src/copilot-api-js/.worktree/agent-a46e6c56981b3cd1b/src/lib/pipeline/types.ts`
- `/home/xp/src/copilot-api-js/.worktree/agent-a46e6c56981b3cd1b/tests/transport/dispatch-lifecycle.unit.test.ts`
- `/home/xp/src/copilot-api-js/.worktree/agent-a46e6c56981b3cd1b/tests/pipeline/candidate-runtime.it.test.ts`
- `/home/xp/src/copilot-api-js/.worktree/agent-a46e6c56981b3cd1b/tests/pipeline/generation-coordinator.it.test.ts`
- `/home/xp/src/copilot-api-js/.worktree/agent-a46e6c56981b3cd1b/docs/tmp/2026-08-08-long-resident-operation-lifecycle-progress-impl-1.md`

## 自审

- error identity：lifecycle 单元测试对 `dispose()` 使用 `rejects.toBe(cleanupError)`，对预先挂接的 `quiesced` rejection 捕获相同对象；driver existing regression 同样对 quiesce rejection 使用 `rejects.toBe(quiesceError)`。
- positive controls：自然 EOF、成功 iterator return、重复 dispose 在 lifecycle 测试绿；错误 return 的双 rejection 在同一测试红绿对照。
- scheduler 的 release 是 cleanup `finally` 的必经步骤；test 在 cleanup reject 后再次走 settle seam，以实际消除 active slot 证明不是只记录 settlement。
- coordinator 测试使用 `GenerationBudget.snapshot()` 确证 reservation 被释放，且保留 candidate failed verdict 与 original `disposeError` 在 AggregateError errors 中。
- `candidate.ts` 与 `coordinator.ts` 的其他 cleanup paths 已在本轮读取审查，既有 `finally` release / verdict settlement 满足 Task 3 契约，不进行无行为变更的重构。

## 结构怪味审查

- `/home/xp/src/copilot-api-js/.worktree/agent-a46e6c56981b3cd1b/src/lib/transport/dispatch-lifecycle.ts:54`；怪味类型：cleanup failure 被当作 best-effort，资源静止与错误 verdict 脱节；处置：本轮修复，单一 settled guard 同步 reject quiescence，并重新抛原始 error。
- `/home/xp/src/copilot-api-js/.worktree/agent-a46e6c56981b3cd1b/src/lib/pipeline/generation/dispatch-scheduler.ts:163`；怪味类型：active slot release 在可能 throw 的 cleanup 路径之后，容易遗留所有权；处置：本轮修复，移动到 `finally` 并以 mutation test 锁定。
- `/home/xp/src/copilot-api-js/.worktree/agent-a46e6c56981b3cd1b/src/lib/pipeline/generation/coordinator.ts:196`；怪味类型：reservation/runtime release 若脱离 finally 会因 disposal reject 泄漏预算；处置：本轮未改生产代码，因为已有 finally 正确覆盖；新增 budget snapshot mutation control 证实该共同基座。
- 扫描范围：Task 3 brief 指定的四个生产文件与四个测试文件；判据为 cleanup throw 前的 ownership release、error identity 包装/吞没与重复 disposal 正样本。未发现需在本阶段额外修改的 candidate/coordinator 结构怪味。

## Reviewer fixes disposition

四项 finding 均采纳。

1. scheduler 现将任意 cleanup failure 的 dispatch settlement 固定为 `verdict: "failed"`，保留调用方的 reason／retry diagnostics；candidate/coordinator regression 同步改为断言 failed dispatch，同时 candidate verdict 与 reservation/runtime release 保持原契约。
2. `disposeDispatch()` 按 cancel → dispose → quiesced 的阶段顺序收集 identity-distinct cleanup errors。单一 cleanup error 原样传播；多个 error 用原生 `AggregateError` 保留该顺序。settlement diagnostics 额外保留已有 upstream error 加全部 cleanup errors；调用方传播只包含 cleanup errors，理由是 frozen spec 要求传播原始 cleanup error／既有 AggregateError，upstream error 已在 settlement diagnostics 完整保留，避免把非 cleanup 根因误写为 cleanup failure。
3. `quiesced` 立即附加内部 `catch` observer；公开 promise 未替换，仍以原始 cleanup error reject。external abort regression 验证只捕获内部 dispose 时没有 `unhandledRejection`，显式 await 公开 `quiesced` 仍得到同一 identity。
4. 已更新 `UpstreamDispatchLifecycle` 注释，明确 natural completion／成功 disposal resolve，cleanup failure reject。

### Reviewer-fix mutation evidence

- verdict mutation：临时恢复“cleanup failure 保留 caller verdict”，`bun test tests/pipeline/candidate-runtime.it.test.ts --test-name-pattern='cleanup rejection releases'` exit 1，实际 discarded 与预期 failed 不符。
- multi-error mutation：临时丢弃 cancel error，前述 focused test exit 1，传播 AggregateError 少了首个 cancel error，失败来自目标阶段顺序／identity 断言。
- observer mutation：临时删除内部 `quiesced.catch`，`bun test tests/transport/dispatch-lifecycle.unit.test.ts --test-name-pattern='external abort catches'` exit 1，Bun 将未观察的 cleanup rejection 归为测试失败；随后精确恢复 observer。
- 最终命令：`bun test tests/transport/dispatch-lifecycle.unit.test.ts tests/pipeline/candidate-runtime.it.test.ts tests/pipeline/generation-recorder-driver.unit.test.ts tests/pipeline/generation-coordinator.it.test.ts && bun run typecheck`，38 pass／0 fail、170 expect、`tsc` exit 0；`git diff --check` exit 0。

## Second-review fixes disposition

两项 Important 均采纳。

1. `recordSettlement()` 现在先调用 adapter，成功返回后才写 `settled` guard。adapter throw 时 `disposeDispatch()` 捕获 recording error、在 finally 释放 active slot，并传播 cleanup errors 后接 recording error 的原生 AggregateError；后续 `settleDispatch()` 能成功补写唯一 terminal settlement。已有 upstream `settlement.error` 仅合入记录 diagnostics，不作为 cleanup／recording 执行失败传播。
2. unknown cleanup rejection 通过显式 `failed` 标记判断，而非 `error !== undefined`。`undefined`、`null`、string、`NaN` 都使 dispose／quiesced reject；`distinctErrors()` 的 `includes()` 提供 SameValueZero 去重。candidate cancel 也改用显式 failure flag，避免吞掉 `throw undefined`。

### Second-review mutation evidence

- settled guard mutation：将 `settled.add()` 移回 adapter 前，throw-once adapter case exit 1，后续 settlement 无法补写。
- 初次尝试不足：该 mutation 暂时丢弃 cancel cleanup error，只验证 cleanup phase 保留，不能证明 recording error 聚合；已由后文《Test discrimination reinforcement》的正确 recording-error mutation 取代。
- undefined mutation：将 lifecycle cleanup 调用回退为不带 failed 标记，unknown table exit 1，公开 quiesced 错误 resolve 而非 reject。
- 最终命令：`bun test tests/transport/dispatch-lifecycle.unit.test.ts tests/pipeline/candidate-runtime.it.test.ts tests/pipeline/generation-recorder-driver.unit.test.ts tests/pipeline/generation-coordinator.it.test.ts && bun run typecheck`，44 pass／0 fail、188 expect、`tsc` exit 0；`git diff --check` exit 0。

## Test discrimination reinforcement

测试判别力补强 test + durable progress 由 `40f15abd2f6ff35025785026a591447f1a3ecdc2` 落地；`AggregateError` oracle correction + progress 在 `f55e8e82c8a2e3b280d720419906804488ad843c`；TS narrowing + final progress 在 `39c53284a144ea4fd55b6497f1039a0fca56b919`。顶层 `undefined` identity 要求经冻结 brief 裁决为过严，保留既有 `AggregateError` 包装契约。

1. recording-error aggregation：`cleanup recording failure preserves errors and allows one terminal settlement retry` 走真实 scheduler + throw-once recording adapter；首次 cleanup 与 recording 都失败时，传播 AggregateError 依次保留 cleanup error 与 recording error，active slot 已释放，随后 `settleDispatch()` 成功补写唯一 terminal settlement。
2. undefined live seam：`undefined cleanup rejection fails settlement and releases the active dispatch` 让 `dispose()`／`quiesced` 都 reject `undefined`，先观察 promise 避免框架噪声；冻结 brief 裁决顶层沿用既有 `AggregateError` 包装，因此断言其唯一内层 `Error` 的 message 为 `undefined`，同时断言 dispatch settlement 为 failed，并借后续 settle seam 验证 active slot 已释放。

### Discrimination mutation evidence

- recording-error mutation：临时从 `propagationErrors` 移除 `recordingFailure`、但保留 cleanup errors；`bun test tests/pipeline/candidate-runtime.it.test.ts --test-name-pattern='cleanup recording failure'` exit 1，目标 AggregateError 缺 recording error identity。随后精确恢复。
- undefined-sentinel mutation：临时将 `hasCleanupFailure` 回退为错误的 `uniqueCleanupErrors[0] !== undefined` 哨兵；`bun test tests/pipeline/candidate-runtime.it.test.ts --test-name-pattern='undefined cleanup rejection'` exit 1，scheduler live seam 不再保留 failed cleanup settlement。随后精确恢复。
- 最终验证：`bun test tests/transport/dispatch-lifecycle.unit.test.ts tests/pipeline/candidate-runtime.it.test.ts tests/pipeline/generation-recorder-driver.unit.test.ts tests/pipeline/generation-coordinator.it.test.ts && bun run typecheck`，45 pass／0 fail、194 expect、`tsc` exit 0；`git diff --check` exit 0。

## Third-review finding disposition

采纳：`dispatch-scheduler.ts:settle` 曾以 `quiesceError !== undefined` 判定失败、在已有 upstream diagnostic 时遗漏 quiescence error，属于对 `disposeDispatch()` 已有错误语义的弱一档 sibling implementation。已将 `diagnosticError()`／`throwFailures()` 共享 primitive 同时用于 disposal 与 consumed settle：数组长度决定失败，SameValueZero 去重，diagnostics 保留 optional field presence，传播保持原始单项或有序 AggregateError。`settle()` 的 recording adapter throw 也在 active 删除之后传播，并允许第二次 settle 补记。

### Third-review mutation evidence

- failure-sentinel mutation：将 consumed settle 的长度判定回退为 `uniqueQuiescenceErrors[0] === undefined`；`bun test tests/pipeline/candidate-runtime.it.test.ts --test-name-pattern='consumed undefined'` exit 1，undefined quiescence 被错误当作成功。
- diagnostics mutation：回退为只保留已有 upstream diagnostic；`bun test tests/pipeline/candidate-runtime.it.test.ts --test-name-pattern='consumed quiescence preserves'` exit 1，记录 AggregateError 缺 quiescence error。
- recording aggregation mutation：回退为传播时丢弃 recording failure；`bun test tests/pipeline/candidate-runtime.it.test.ts --test-name-pattern='consumed quiescence plus'` exit 1，传播只剩 quiescence error。
- 共享 primitive seam：以上 consumed live-seam tests 直接经 `settle()` 使用 `diagnosticError()`／`throwFailures()`；绕过共享 primitive 会使 undefined 或 upstream＋quiescence assertions 转红。
- 最终验证：`bun test tests/transport/dispatch-lifecycle.unit.test.ts tests/pipeline/candidate-runtime.it.test.ts tests/pipeline/generation-recorder-driver.unit.test.ts tests/pipeline/generation-coordinator.it.test.ts && bun run typecheck`，48 pass／0 fail、204 expect、`tsc` exit 0；`git diff --check` exit 0。

## Fourth-review finding disposition

采纳：scheduler 可产生 `{ error: undefined }`，但真实 `RequestContext` 位置参数 helper 与 `ModelOperationRecorder` 曾在 value-based optional-field 判断中丢失它，而 fake row 对字段存在性更友好，形成“scheduler richest diagnostic 在真实 recorder 边界退化”的怪味。本轮将 dispatch settlement error contract 的 presence 传到共享 recorder base：`model-operation-record.ts` writer 与 snapshot 都用 own-property 判断；RequestContext helper 保留 input 的 `error` field presence；coordinator 用显式 failure flag，避免 consumed `throw undefined` 被误当作成功。普通 object spread 已自然透传字段，故移除冗余 driver presence 重述；真实 oracle 在 finalization 后直接读取 terminal record。

### Fourth-review mutation evidence

- writer mutation：临时将 recorder writer 回退为 `settlement.error !== undefined`；`bun test tests/pipeline/generation-recorder-driver.unit.test.ts --test-name-pattern='records an undefined consumed'` exit 1，真实 canonical snapshot 的 `error` own property 缺失。
- snapshot mutation：临时将 snapshot projection 回退为 `attempt.error !== undefined`；同一真实 recorder test exit 1，目标 own-property 断言失败。
- false-red mutation：临时无条件输出 snapshot error field；`bun test tests/pipeline/generation-recorder-driver.unit.test.ts --test-name-pattern='committed candidate'` exit 1，正常 committed dispatch 的无-error own-property negative control 触发。
- fake calibration：candidate-runtime fake row 现在仅在 `"error" in input` 时写 `settlementError`；它断言 scheduler→port presence，真实 driver／RequestContext／recorder test 才断言 canonical snapshot。
- terminal oracle refinement：移除冗余 driver `error` re-spread，真实 recovery test 在 finalization 后从 `whenModelOperationFinalized()` 返回的 terminal record 断言 failed dispatch／candidate 与 `error: undefined` own property；目标命令 `bun test tests/pipeline/generation-recorder-driver.unit.test.ts --test-name-pattern='records an undefined consumed'` exit 0。
- 最终验证：`bun test tests/transport/dispatch-lifecycle.unit.test.ts tests/pipeline/candidate-runtime.it.test.ts tests/pipeline/generation-recorder-driver.unit.test.ts tests/pipeline/generation-coordinator.it.test.ts && bun run typecheck`，49 pass／0 fail、213 expect、`tsc` exit 0；`git diff --check` exit 0。

## Fifth-review finding disposition

采纳：`settleGenerationAttempt(attempt, verdict, reason?, error?, hasError=false)` 把 error presence 分裂在位置参数、默认 boolean 与五个调用点；三个非undefined error 调用此前漏传 boolean，静默丢失诊断。本轮改为 settlement object，调用形状是唯一 presence source：logical terminal 仅在失败／中止且有值时携带 error；explicit dispatch 保留 own-property（含 undefined）；superseded 无 error；response failure 总携带 failure error field；attempt failure 仅在既有 `a.error` 非undefined 时携带 error。

### Fifth-review mutation evidence

- logical terminal mutation：原 reviewer 把 logical helper 列作可观察回归；实测 public `complete`／`fail`／`abort` 均先由 `setAttemptResponse` settle 同一 terminal attempt，删除 logical fallback error 字段目标测试仍绿，故该子命题不可达、不能作为 mutation gate，待原 reviewer 裁决。未改生产时序。保留 explicit dispatch canonical error case 作为可达的 presence gate。
- explicit dispatch mutation：临时删除 `settleGenerationDispatch(input)` object 的 error property；`bun test tests/context/request-context.unit.test.ts --test-name-pattern='selecting a recovery winner'` exit 1，primary dispatch error 缺失。
- response failure mutation：临时删除 response-failure object 的 error property；`bun test tests/context/request-context.unit.test.ts --test-name-pattern='records a failed response error'` exit 1，dispatch error 变为 undefined。
- attempt failure mutation：临时删除 attempt-failure object的 error property；`bun test tests/context/generation-recorder-lifecycle.unit.test.ts --test-name-pattern='unsupported beta'` exit 1，discarded dispatch error 缺失。
- D controls：真实 explicit `error: undefined` terminal own-property 与正常 committed no-error negative control 保留在 driver recorder tests。
- 最终验证：`bun test tests/context/generation-recorder-lifecycle.unit.test.ts tests/context/request-context.unit.test.ts` 为 91 pass／0 fail；Task 3 focused `bun test tests/transport/dispatch-lifecycle.unit.test.ts tests/pipeline/candidate-runtime.it.test.ts tests/pipeline/generation-recorder-driver.unit.test.ts tests/pipeline/generation-coordinator.it.test.ts && bun run typecheck` 为49 pass／0 fail／213 expect；`git diff --check` exit 0。

## B1 merged-state verifier I-1 checkpoint

B1 verifier Findings 1～3 的实现与 focused tests 已进入 checkpoint：candidate recorder settlement 成功后才占 guard；coordinator 的 recovery／continuation／consumed／unconsumed 路径收集 dispatch/disposal error 与 candidate settlement adapter error，在 finally 中释放 reservation／active 后按发生顺序传播 distinct errors。`bun test tests/pipeline/candidate-runtime.it.test.ts tests/pipeline/generation-coordinator.it.test.ts && bun run typecheck`：38 pass／0 fail、175 expect、`tsc` exit 0。完整 mutation controls 与 B1 nine-file gate 留待下一轮；B1 review 尚未闭合。

## B1 adapter-failure focused tests

补充 candidate recorder throw-once：首次 candidate settlement adapter rejection 不占 guard，第二次 public settle 成功补记，第三次幂等。recovery、consumed 与 unconsumed 现在各以真实 coordinator path 覆盖 candidate adapter throw-once：调用拒绝 recorder error、budget activeCandidates／activeDispatches 归零，随后 `completeCandidate()` 可补记 failed verdict。`bun test tests/pipeline/candidate-runtime.it.test.ts tests/pipeline/generation-coordinator.it.test.ts && bun run typecheck`：41 pass／0 fail、188 expect、`tsc` exit 0。

## B1 continuation focused tests

补充真实 coordinator continuation controls：dispatch settlement reject 不启动 child、parent failed、active budget归零并原样传播；dispatch error + candidate recorder throw-once 聚合为有序 `[dispatchError, recordingError]`，public `completeCandidate()` 可补记；成功 continuation 启动 child、parent continued，并在清理 child 后 active budget归零。`bun test tests/pipeline/generation-coordinator.it.test.ts && bun test tests/pipeline/candidate-runtime.it.test.ts && bun run typecheck`：25＋18 pass、0 fail、126＋74 expect。

## B1 mutation evidence M1–M3

- M1：冻结 candidate guard patch，将 `settled = true` 移至 adapter 调用前；`bun test tests/pipeline/candidate-runtime.it.test.ts --test-name-pattern='candidate settlement retries after a recording adapter rejection'` exit 1，第二次 adapter 调用被 guard 跳过，call count 从预期2变为1。reverse-check 后精确反向恢复并重跑绿。
- M2：冻结 recovery value-sentinel patch，使唯一 `undefined` disposal error 被视为无错误；`bun test tests/pipeline/generation-coordinator.it.test.ts --test-name-pattern='recovery rejects every cleanup failure value 0'` exit 1，目标调用错误 resolve。reverse-check 后精确反向恢复并重跑绿。
- M3：冻结 unconsumed value-sentinel patch，使唯一 `undefined` disposal error 被视为无错误；`bun test tests/pipeline/generation-coordinator.it.test.ts --test-name-pattern='unconsumed disposal rejects every cleanup failure value 0'` exit 1，目标调用错误 resolve。reverse-check 后精确反向恢复并重跑绿。

## B1 mutation evidence M4–M6 and full gate

- M4：冻结 patch，将 shared `settleAndRelease()` 的 reservation release／active clear 移入 runtime settlement 成功分支；recovery、consumed、unconsumed candidate-recording-failure tests 均 exit 1，目标 budget `activeCandidates` 从预期0泄漏为1。reverse-check 后精确反向恢复。
- M5：冻结 continuation early-await patch，dispatch reject 直接跳过 candidate settlement／release；continuation dispatch-failure test exit 1，parent candidate verdict 缺失。reverse-check 后精确反向恢复。
- M6：冻结 continuation aggregation omission patch，仅保留第一个 dispatch error；dual-error test exit 1，预期 AggregateError 实际收到单一 dispatch Error。reverse-check 后精确反向恢复。
- 最终修复提交还为 consumed 单一 unknown rejection 显式保留原样传播，避免 shared helper 默认 wrapper 造成契约回归；consumed `undefined` integration test 覆盖该行为。
- 旧 `b70c7ac3be68d8d4f46c331eeebd636e82ace481` 仅由本地备份 ref `backup/b1-pre-reword-b70c7ac3` 保留，当前产物为上述重写后的 `41b349ac9ad50573a280f22eb968d3e031e164fc`。
- 完整 B1 gate：九文件命令 `bun test tests/context/operation-lifecycle.unit.test.ts tests/context/operation-scope.unit.test.ts tests/context/request-context.unit.test.ts tests/context/generation-recorder-lifecycle.unit.test.ts tests/context/generation-finalization.unit.test.ts tests/transport/dispatch-lifecycle.unit.test.ts tests/pipeline/candidate-runtime.it.test.ts tests/pipeline/generation-recorder-driver.unit.test.ts tests/pipeline/generation-coordinator.it.test.ts`，182 pass／0 fail；`bun run typecheck`、`git diff --check` exit 0。

## B1 race ownership checkpoint

生产改动：`completeCandidate()`、`raceReadyCandidates()`、standalone `raceProbePromises()` 均改用 shared `settleAndRelease()`／`throwCoordinatorFailures()`；probe failures 与 recorder owner errors 分离，`hedgeFailures` 只保留真实 probe failures。新增 `tests/pipeline/coordinator-hedge.unit.test.ts` 两条：`a probe failure plus a candidate recording rejection surfaces both while hedgeFailures keeps only the probe`、`a terminal-without-boundary candidate with a recording rejection surfaces an owner-only aggregate`。early-primary owner 证据：`racePrimaryWithDelayedHedge()` 在 `first.kind === "primary"` 的 boundary／terminal／failure 分支直接返回，真实 owner 是调用方 `src/lib/pipeline/driver.ts`：failure 路径约 1051-1054 行调用 `releaseCandidate(primary)`，terminal 写完 frames 后约 1070 行 release selected candidate，winner 走后续 delivery lifecycle；本轮未改该分支。

`bun test tests/pipeline/coordinator-hedge.unit.test.ts tests/pipeline/generation-coordinator.it.test.ts tests/pipeline/candidate-runtime.it.test.ts`：56 pass／0 fail／234 expect；`bun run typecheck`、`git diff --check` exit 0。

## B1 delayed-hedge public path (commit `3fbd1164`)

新增两条 `tests/pipeline/coordinator-hedge.unit.test.ts` 用例，通过公开 `racePrimaryWithDelayedHedge()`（而非内部 `raceProbePromises()`）验证：`delayed hedge: an owner-only terminal recording rejection surfaces failure, not terminal success`（owner-only recorder throw 使结果为 `failure` 而非 `terminal`，`hedgeFailures` 为空，budget 归零）、`delayed hedge: a probe failure plus a candidate recording rejection surfaces both while hedgeFailures keeps only the probe`（probe error 与 recorder error 都进 AggregateError，`hedgeFailures` 只保留 probe）。`bun test tests/pipeline/coordinator-hedge.unit.test.ts`：14 pass／0 fail；`bun run typecheck`、`git diff --check` exit 0。

## B1 mutation controls M7–M9（针对 race／completeCandidate ownership 修复，R6 判别力证据）

每项均以冻结 exact patch 注入（`/tmp` 路径），运行目标测试确认红因，`git apply --reverse --check` 后精确反向恢复，随后确认 `git diff HEAD --stat` 与 `git status --short` 均为空。M7 与 M8 共用同一 `settleAndRelease` primitive 但分别定位在不同代码点（`raceProbePromises` 内的收集逻辑 vs. `settleAndRelease` 的 release 时机），故各自成立、未合并。

- **M7**（race owner-error 收集，`raceProbePromises` 内 `ownerErrors.push(...)` 与 `settlementErrors.length === 0` 判定回退为「settle 抛错不进聚合」）：目标测试 `delayed hedge: an owner-only terminal recording rejection surfaces failure, not terminal success` 红，失败断言 `expect(result.kind).toBe("failure")` → `Expected: "failure" / Received: "terminal"`；`a terminal-without-boundary candidate with a recording rejection surfaces an owner-only aggregate`（`raceReadyCandidates` primary-only 用例）仍绿，因该用例走的是 `raceReadyCandidates` 自身内联 `settleAndRelease` 调用点，未受本 patch 影响——这与本轮判别力目标一致，因为 M7 只针对 standalone helper。reverse-check 后精确恢复，两条测试均绿。
- **M8**（`settleAndRelease` 的 reservation release 从 `finally` 移出、settle 抛错时不再释放）：目标测试 `delayed hedge: an owner-only terminal recording rejection surfaces failure, not terminal success` 红，失败断言 `expect(budget.snapshot().activeCandidates).toBe(0)` → `Expected: 0 / Received: 1`。reverse-check 后精确恢复并重跑绿。
- **M9**（`completeCandidate()` 回退为直接 `runtime.settle()` 后才 `release()`）：目标测试 `completeCandidate releases ownership when candidate recording rejects once` 红，失败断言 `expect(budget.snapshot()).toMatchObject({ activeCandidates: 0, activeDispatches: 0 })` → `Expected - activeCandidates: 0 / Received + activeCandidates: 1`。reverse-check 后精确恢复并重跑绿。

三项 mutation 结束后 `git diff HEAD --stat` 为空，源码与测试文件均回到 `3fbd1164` 提交时的内容，本轮无生产/测试净改动，只有 report/progress 文档更新提交。

## B1 nine-file gate（含 coordinator-hedge，实际十个文件）

之前几轮命令记录里，「B1 九文件」这个称呼固定指以下九个 `context`／`transport`／`pipeline` focused 文件；本轮追加第十个文件 `tests/pipeline/coordinator-hedge.unit.test.ts`（B1 race ownership checkpoint 起新增覆盖），故实际执行清单为十个文件，与协调者给出的九文件清单一致外加该追加项：

`bun test tests/context/operation-lifecycle.unit.test.ts tests/context/operation-scope.unit.test.ts tests/context/request-context.unit.test.ts tests/context/generation-recorder-lifecycle.unit.test.ts tests/context/generation-finalization.unit.test.ts tests/transport/dispatch-lifecycle.unit.test.ts tests/pipeline/candidate-runtime.it.test.ts tests/pipeline/generation-recorder-driver.unit.test.ts tests/pipeline/generation-coordinator.it.test.ts tests/pipeline/coordinator-hedge.unit.test.ts`

结果：`197 pass／0 fail`，`687 expect() calls`，`Ran 197 tests across 10 files.`；`bun run typecheck` exit 0；`git diff --check` exit 0。

## B1 full backend tier (`bun run test:backend`)

`bun run test:backend` → `bun scripts/parallel-test.ts unit it http`：`16 shards · 6681 tests · 6681 pass · 0 fail · 31.47s`。全绿，无需分类失败（既无本轮改动引入的失败，也无 master 既有／环境性失败需要 skip）。

## Concerns

B1 merged-state review 尚未闭合。未执行 Task 4。

