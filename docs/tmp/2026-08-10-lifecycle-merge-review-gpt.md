# 超长驻留 operation lifecycle Tasks 1–4 + B1 合并态评审

## 评审状态

- **评审范围**：集成提交 `cf3da6a9`、`420a8a09`、`43b30370`、`3df0e08d`、`0e0768ee`；重点核验 C1–C6、lossless shutdown 与 transport dispatch ownership 的语义接缝、以及夹带改动。
- **已读取／执行的证据**：`git status --short --branch`、`git rev-parse HEAD`、`git log --oneline --graph --decorate 0e0768ee~20..0e0768ee`。当前 checkout 为 `master`，HEAD `e120a49c90a66882bb5e865d1e30bae31179b4c2`，晚于目标提交；后续代码结论将锚定 `0e0768ee` 的 Git object，并先核对相关路径从 `0e0768ee` 到当前 HEAD 是否漂移。
- **总体 verdict**：修复 major 后可进入下一阶段。
- **blocker 数量**：0。

## 事实性发现

尚无已闭合的 blocker／major。

## 必核命题

### C1 — 已确认，未发现 blocker／major

- `0e0768ee:src/lib/context/manager.ts:425-435` 的唯一 release primitive 仅在 `blocker === "none"` 时删除 `operationScopes`，并在同一位置把 delivery／canonical 两个 barrier entry 移入 `modelOperationFinalizationFailures`；`618-625` 的 drain 先 join 全部 finalizer，再抛出队列中的 `AggregateError`。
- resolve 与 reject 两臂都在移除 pending finalizer 后调用该 primitive（`489-510`）；reject 臂仍保留 History reservation 的 `failBeforeTerminal`（`496-510`），但不再直接 delete／push，和 `git show --remerge-diff cf3da6a9 -- src/lib/context/manager.ts` 的冲突解法一致。
- 分支穷举：delivery failure 只有首次 outcome 能锁定（`request.ts:920-935`）；已注册 delivery failure会启动 canonical finalizer。canonical 成功、canonical 注册失败、或两 phase 都失败，最终均有 `blocker === "none"` 并经过 release；未注册 failure 则分别停在 `delivery-finalization`／`canonical-finalization`，有意保留在 shutdown registry 而不假报已排空（`operation-lifecycle.ts:28-37`、`request.ts:938-958`）。manager 的 callback 对 fresh `(id, phase)` 同步返回 true（`manager.ts:524-529`），故该未注册分支不是这条生产接线的漏口。
- 直接回归覆盖 canonical reject 单次上报、delivery-only failure 上报、barrier release-time eviction 与多请求隔离（`tests/context/manager-dual-registry.unit.test.ts:81-186`）。这些证据支持 C1 的生产接线完整；不把它扩大成“任意自定义 `createRequestContext` callback 都会释放”。

### C2 — 已确认，未发现 blocker／major

- `0e0768ee:src/lib/shutdown.ts:40-43,320-323` 保留 `stopHistoryAdmission`、`drainHistoryAdmissionHandoffs`、`drainHistoryAdmission` 三项生产依赖；`352-360` 在首次 registry snapshot 前执行 stop + handoff drain，`413-423` 把 lifecycle failure drain 与 admission drain 一并传入 finalization。
- 默认调用目标已改为 `peekRequestContextManager()?.drainLifecycleFailures()`（`312-320`），`finalize` 实际 await 该闭包（`426-452`），所以方法改名没有指错对象或变成 no-op。`tests/history/worker/admission-shutdown.unit.test.ts:109,136` 也改到新 manager 方法，并覆盖 handoff 后 finalizer failure 使 shutdown reject、reservation 降到 `reserved: 0`。
- `ShutdownDeps.drainModelOperationFinalizationsFn` 与 `FinalizeDeps.drainModelOperationFinalizations` 仍是旧字段名（`204-227,426-435`），但 `312-317` 有明确 Task 4／Task 6 接缝注释；进度权威也逐字记录仅切调用目标、其余 rename 留给 Task 6（`docs/tmp/2026-08-08-long-resident-operation-lifecycle-progress-impl-1.md:40-42,62`）。因此这是有意分期，不是漏改。

### C3 — 已收窄；最终合并态未发现 blocker／major

- 对 `174f0dea..cf3da6a9` 解析 JSON 集合：`files` 从 721 增到 722，差集仅 `tests/context/operation-lifecycle.unit.test.ts`，反向差集为空，`minimum_executed` 均为 7360；原命题对**主集成提交**成立。
- 它不适用于最终 `0e0768ee`：追 142 个提交的 `43b30370` 已把 floor 更新到 7613，`0e0768ee` 再更新为 7615。`43b30370` commit evidence 记录同一合并态 `7681 pass / 0 fail / 43 skipped`；该数值未由本轮另一次目标-tree 实跑交叉验证，故只按该 commit 的历史证据引用。
- 若只看 `cf3da6a9`，7360 仍是有效下界，却确实不能识别 7360 与当时实测 7435 之间的用例漏执行；精确 `files` 集合仍能识别整个文件漏 discovery。后续将 floor 收紧到 7613／7615 已消除“长期停在 7360”的问题，最终 floor 对 7681 仍保留 66 的保守余量。
- canonical 以两种原理核对：`scripts/entry-evidence-schema.ts:29-119` 要求字段顺序、bytewise 排序、唯一性和 `JSON.stringify(..., null, 2)+"\n"`；本轮逐 ref 解析并重序列化，`174f0dea`、`cf3da6a9`、`43b30370`、`0e0768ee` 均 byte-identical，且文件集合唯一、bytewise sorted。最终 target baseline 也由 parser 读得 `{minimum_executed:7615, files:735, skips:43}`。

### C4 — 已确认，无 blocker／major

- AST 邻接语句清点得到恰好 9 处：3 处 `Promise.reject(undefined)`、1 处 `throw undefined`、2 处参数化 `throw disposalError`、1 处参数化 `throw cleanupError`、1 处 `throw NaN`，以及一个 hedge test helper 的 `throw settleError`。
- non-Error 样本覆盖 `undefined`、`null`、string 与 `NaN`，并断言原值／presence／ownership release（`tests/pipeline/candidate-runtime.it.test.ts:288-345`、`tests/pipeline/generation-coordinator.it.test.ts:342-453`、`tests/pipeline/generation-recorder-driver.unit.test.ts:161-185`、`tests/transport/dispatch-lifecycle.unit.test.ts:83-133`），与冻结不变量“`throw undefined` 合法，存在性不能靠 value sentinel”一致（`/home/xp/src/copilot-api-js/docs/plan/2026-08-08-long-resident-operation-lifecycle/HANDOVER.md:54`）。

### C5 — 已确认，未发现 blocker／major

- 验证方法不是把 179 当作语义证明：先将 feature parent `695a7b33` 的 source 通过 `bunx prettier --check --stdin-filepath` 检查，得到非零退出，证明格式器确实有待修工作；再比较 `695a7b33..cf3da6a9` 的 feature-only 生命周期文件，`git diff --ignore-all-space` 只显示 line-wrap、import layout 与九处刻意的 ESLint 注释，没有 AST／控制流变更。
- 唯一源码差异为 `src/lib/pipeline/generation/coordinator.ts` 的 prettier 换行和 `dispatch-scheduler.ts` 去冗余括号；其余是测试布局和 C4 所列注释。`git diff --check` 对 merge delta 返回 0。
- 注意这个结论只覆盖宣称的 “179 prettier --fix” 子集，不把同一集成内 Tasks 1–4／B1 的实质生产与测试改动误称为格式改动。历史边界上 23 个文件由两边均改，`merge-tree e45536af 174f0dea 695a7b33` 显示其中 manager／request／types 等确有语义合并；它们已分别按接缝审查，不计入 C5 格式断言。

### C6 — [major] 交接文档在合并时没有同步，当前状态反向错误

- `43b30370:.superpowers/sdd/progress.md` 取 master 的 Mandatory Block Delivery ledger 是正确的：该控制器文件被 master 整份替换，回填 lifecycle 段会污染另一在飞特性；它不是 lifecycle 的 durable authority。
- lifecycle 的详细实施／评审信息确实仍在 `docs/tmp/2026-08-08-long-resident-operation-lifecycle-progress-impl-1.md:9,24-25,35,48-53` 与 `docs/plan/2026-08-08-long-resident-operation-lifecycle/HANDOVER.md:64,74,83-86`，因此没有丢失 Tasks 1–4／B1 的技术证据。
- 但二者在 `cf3da6a9` 合入代码后仍断言相反的当前状态：HANDOVER `:5` 写“代码没有合，仍只在 fix-long-resident-operations”；`:29` 要求“先合并 master，再动 Tasks 5–8”；KICKOFF `:14-16`重复该 gate。`git show --format=fuller cf3da6a9` 已证明这些代码当时进入 master，故这些 successor-facing 指令会让接手者在错误分支状态上操作。
- 修复：由文档所有者更新 HANDOVER／KICKOFF／progress frontmatter，明确 Tasks 1–4 + B1 已于 `cf3da6a9` 进入 master、移除“先合 master” gate，并将后续工作基线改为该集成提交。建议路由 `gpt-souls:doc-writer`；修后需独立复审这些 current-state 命题。

### 最高风险接缝：lossless shutdown × Task 3 dispatch cleanup × transport dispatch ownership — 已确认，未发现 blocker／major

- 生产链路为 scheduler 先创建真实 dispatch handle，再构造 `{dispatch, signal}` 交给 `input.open`（`0e0768ee:src/lib/pipeline/generation/dispatch-scheduler.ts:217-245`）；`driver.openPhysicalDispatch` 不丢 options，穿透 `PhysicalTransport.open` 或 `Transport.send`（`src/lib/pipeline/driver.ts:901-925`）。这满足 `c9a115a5` 所需的显式 owner，而不是从 ambient attempt 推断。
- Task 3 的 cleanup 仍由 scheduler 按 cancel／dispose／quiesced 聚合、记录 failed settlement，并在 finally 删除 active dispatch（`dispatch-scheduler.ts:153-199,373-404`）；candidate 的 ready `settleDispatch` 在 scheduler 收口后断言无残留 active slot（`candidate.ts:118-121`）。transport 新增 ownership 没有抢走 cleanup owner。
- merge diff 显示 `cf3da6a9..3df0e08d` 只改 driver、scheduler 与 hedge test；scheduler 的实质变动就是增 `dispatch` options（`237-238`）及语法性括号收敛。`0e0768ee..HEAD` 对上述实现及八个焦点测试路径无 diff；本轮在当前等价路径运行 8 个 lifecycle／cleanup／ownership 测试文件，结果 `182 pass / 0 fail`；entry schema 及 discovery matrix 结果 `10 pass / 0 fail`。日志里的 finalizer／shutdown error 是这些负路径测试的预期观测，不是测试失败。
- 证据边界：A4-1 尚未产生 transport diagnostic，故结论只覆盖 ownership handle 传递不破坏 Task 3 的 cleanup／settlement／shutdown drain；不主张未来 H2 diagnostic batches 已被本次测试证明。

### 夹带改动审计 — 已确认，无额外 major

- `174f0dea..cf3da6a9` 的净代码／测试文件均属于 lifecycle registry、Task 3 cleanup ownership、shutdown admission 接缝及其直接 tests；`docs/todo/deferred-backlog.md`、`.superpowers/sdd/progress.md` 与 `tests/infra/entry-test-discovery-baseline.json` 是相应状态／守卫同步。
- 后续 `43b30370`、`3df0e08d`、`0e0768ee` 引入的是 master 已存在的 142／3／16 个提交：History V3、mandatory block delivery、A4 transport ownership、entry-gate／atomic-fs／UI／UDS 等。它们是“追 master”的第二父系内容，不是 lifecycle feature branch 偷带；first-parent graph 与每个 merge 的父提交可复算此归属。
- 但“没有夹带 feature 改动”不等于文档已同步；C6 的 stale lifecycle handover 是本次唯一 major。

## 最终结论

- **总体 verdict**：修复 1 条 major 后可进入下一阶段。
- **blocker 数量**：0。
- **计数**：blocker 0，major 1。
