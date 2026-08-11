> **原始 reviewer 输出，逐字保存。** 本文是 subagent 的未编辑输出；仓库里另有蒸馏后的策展版（spec 评审见 `docs/spec/2026-08-08-long-resident-operation-lifecycle-review.md`，plan 评审见 `docs/plan/2026-08-08-long-resident-operation-lifecycle-review.md`）。策展版是权威，本文用于回溯「当时还挑战过什么、哪些没升级成 major」——那部分策展版没有收。

## 评审概况

- **评审范围：** 冻结 commit `302cce2e` 的 `docs/plan/2026-08-08-long-resident-operation-lifecycle.md`，对照同 commit 的 lifecycle spec、spec review 及相关接口代码。全程只使用 `git show 302cce2e:<path>` 类只读查询；未修改文件，未执行 `git status` 或其他 Git 状态操作。
- **总体 verdict：** **修复 major 后可进入执行。**
- **Blocker：** 0
- **Major：** 4

### 双视角覆盖证据

- **机械核对：** 逐节映射 spec §§2–12 到 Task 1–8；对账各 Task 的 Files、Interfaces、示例代码、测试命令和提交 pathspec；核查 spec review R1–R5 是否进入计划；核对冻结代码中的 `OperationScope`、`RequestContext`、manager、dispatch lifecycle、scheduler、candidate、delivery session、SSE／WS options 与 shutdown/status 接口；核实 recovery merge lineage `e45536af` → `bc71c1dc`，确认计划没有重复实施 recovery；同时核对 `package.json` 中 `test:backend` 与 `test:e2e` 的实际边界。
- **第一人称执行模拟：** 按 B1～B6 顺序模拟实现 Task 1–8；分别走过 dispatch `iterator.return()` reject、scheduler/candidate cleanup、delivery failure、canonical failure、operation/delivery 两种并行顺序、manager release、shutdown drain、SSE／WS／recovery／non-stream producer，以及 mutation 注入和反向恢复流程；同时从 false-green 与 false-red 两个方向检查每个 gate。

## 命题核验表

| 命题 | 结论 | 证据／说明 |
|---|---|---|
| P1：spec §§2–12 各有 task | **部分失败** | §§2–10 的主体分别落入 Task 1–7；§11.5 的 recovery 既有验证没有完整可执行任务；§12 的 8 项 mutation 仅落实了其中 6 类。 |
| P2：Task 1–8 接口名字、类型、路径一致 | **失败** | `OperationScope.snapshot` 同时写成方法和属性；`TrackedOperationsSnapshot.byBlocker` 的类型要求 `"none"`，示例及 API 契约却不包含它。文件路径抽查未发现其他阻断性错位。 |
| P3：dispatch `iterator.return()` reject 有红测、实现、release 与验收 | **通过** | plan:249–301 包含红测、原始错误传播、`quiesced` reject、scheduler active release、dispatch settlement、candidate/reservation 收口；Task 7 还有真实 candidate 路径验收。 |
| P4：delivery failure 使用 context-owned ledger，manager barrier 不重复且 join 不依赖 callback | **通过** | plan:212、216 明确先写 context-owned ledger，再发布 terminal，并以 never-throw callback 通知 manager；plan:357 用 request/phase/error identity 去重，finalizer callback 不再次登记同一错误。 |
| P5：operation/delivery 偏序无 self-join | **通过** | plan:214–220 同时验证两种合法并行顺序，并明确 delivery 不进入 `trackOperationBody`；与 spec:147–159 一致。 |
| P6：manager release 与 failure drain 触发可达 | **通过** | plan:347–361 规定 resolve/reject 都在 canonical terminal 状态发布后调用同一 release primitive；Task 6 将 shutdown 调用点统一改为 `drainLifecycleFailures`。 |
| P7：producer matrix 由 AST 枚举且有正负对照 | **通过** | plan:511–538 要求 TypeScript AST/resolver 冻结生产者位置，覆盖非 recovery SSE、recovery SSE、Responses WS、non-stream JSON；Task 8 对应漏 notification mutation。 |
| P8：mutation 恢复纪律符合共享 worktree 安全 | **通过** | plan:562–570 要求 committed real-implementation baseline、exact patch、`git apply --reverse --check`、反向应用同一 patch、恢复后跑绿；未使用整文件恢复。 |
| P9：每批独立验收且父项不会提前关闭 | **通过** | plan:27–36 为 B1～B6 分别给出独立价值、验收门与依赖，并明确父项目在全部批次完成前保持 `in progress`；plan:600、617–621 也阻止 spec/plan 提前标记 done。 |
| P10：recovery 已在 master，计划未重复实现 | **通过** | 冻结 lineage 显示 `bc71c1dc` 的第二父为 `e45536af`；plan:9、29 明确 recovery 已落 master，Task 1–8 没有再次 merge、cherry-pick 或重写 recovery。 |

## 事实性发现

### [major] `docs/plan/2026-08-08-long-resident-operation-lifecycle.md:71` — `OperationScope.snapshot` 被同时定义成方法和只读属性

**问题：** Interfaces 写成 `OperationScope.snapshot(): OperationScopeSnapshot`，但实现步骤在 plan:139–143 定义 getter，RequestContext 示例在 plan:207 也按 `operationScope.snapshot` 属性消费。

**证据或失败场景：** 执行者若按 Interfaces 实现方法，plan:207 会把函数本身放入 snapshot，`deriveOperationBlocker` 读取 `quiesced` 时得到错误值或直接 typecheck 失败；若按示例实现属性，则 Interfaces 契约不成立。这是正确实现可能被错误计划指令打成 false-red 的直接路径。

**修复建议：** 全文统一为现有消费方式对应的 `readonly snapshot: OperationScopeSnapshot` getter，并同步 Files／Interfaces／示例和验收措辞。

### [major] `docs/plan/2026-08-08-long-resident-operation-lifecycle.md:325` — `byBlocker` 类型包含 `"none"`，与示例及公开 API shape 冲突

**问题：** `Readonly<Record<OperationBlocker, number>>` 要求五个键，其中包括 `"none"`；但 plan:335–339、Task 6 的 “exact shape” 及 spec:240–251 都只暴露四种实际 blocker。

**证据或失败场景：** 按声明实现时，示例对象无法通过 TypeScript，因为缺少 `none`；为让它通过而增加 `"none": 0`，又会改变冻结的 `/api/status.trackedOperations.byBlocker` 契约。正确的 terminal context 应在聚合前被 release，因此 `"none"` 本来也不属于 blocker 聚合。

**修复建议：** 定义独立类型，例如 `type TrackedOperationBlocker = Exclude<OperationBlocker, "none">`，并让 `byBlocker` 使用该类型；增加断言 `sum(byBlocker) === count` 且 registry 中出现 `"none"` 时测试失败。

### [major] `docs/plan/2026-08-08-long-resident-operation-lifecycle.md:560` — Task 8 未落实 spec §12 的全部 mutation gate

**问题：** spec:364–375 明确列出 8 项 mutation；计划声称运行“五组”，但 plan:564–568 完全遗漏两项：删除 candidate cleanup `finally` 的 active-slot release，以及改错 blocker mapping。

**证据或失败场景：** Task 3 的普通红绿测试只能证明当前测试能观察一次 cleanup rejection，不能证明其 release oracle 会咬住未来删除 `active.delete`／candidate reservation release 的回归；同理，blocker 单元测试不能替代日志/status 接线 mutation。实现错误时，B6 仍可按计划全部通过，属于 false-green。spec review 对 R2/R5 的“mutation 已闭合”结论不能覆盖后来计划删掉的 mutation。

**修复建议：** Task 8 恢复 spec §12 的完整 8 项清单，至少新增：① 删除 dispatch/candidate release 的 exact-patch mutation，并断言 active slot、candidate verdict、reservation 和 registry；② 改错 blocker 映射，并断言 lifecycle unit、shutdown formatter 与 status 聚合均因目标机制转红。

### [major] `docs/plan/2026-08-08-long-resident-operation-lifecycle.md:572` — 没有可执行步骤完成 spec §11.5 的 recovery 既有合同验证

**问题：** spec:346–362 要求重新运行 direct recovery matrix、`@anthropic-ai/sdk` 离线 E2E、History/canonical 双读、three keepalive modes、abort provenance、clean EOF、hedge/candidate budget、recovery batch publication、architecture guards，并将时序用例连续运行 10～25 次。计划只连续运行三个测试文件，并最终运行 `test:backend`。

**证据或失败场景：** 冻结 `package.json:56` 的 `test:backend` 只组合 unit／it／http；`package.json:66` 的 E2E 是独立 `test:e2e`，因此 SDK 离线 E2E 不会被 Task 8 的命令覆盖。计划也没有具名命令证明 History 双读、three keepalive modes、abort provenance 和 budget 测试实际入选。执行者完全照计划完成后，plan:631 仍会声称这些合同“不回归”，形成无证据的 false-green。

**修复建议：** 在 Task 8 增加一张 spec §11.5 逐项命令表，明确每项对应的测试文件／`--test-name-pattern`；显式运行 SDK E2E，而不是依赖 `test:backend`；将所有时序相关项纳入 10～25 次循环，并在 review 文档记录 commit、命令、轮数和结果。

## 主观建议

未发现需要单列的主观建议；当前问题均为可复现的契约或验收缺口。

## 最终 verdict

**0 blocker／4 major。修复上述 major 后可进入执行；当前冻结计划不应直接开工。**
