# HANDOVER：超长驻留 operation lifecycle（Tasks 1–4 已落地，5–8 待做）

**状态：草稿·未评审** —— 本文尚未过独立评审，接手方请把其中的判断当作待验证而非已核验。评审通过后须改掉这一行。

- **核验基线**：`3e418cdb03b93162e57c540ee4361d35f602835e`（2026-08-08）。下方所有「当前状态」断言都在该 commit 上取证。
- **分支 / worktree**：`fix-long-resident-operations` @ `/home/xp/src/copilot-api-js/.worktree/fix-long-resident-operations`。
- **未提交改动**：无（`git status --short` 为空）。**未追踪文件**：无。
- **已跑门禁（在 `e397720a`，其后仅文档/台账提交，代码未变）**：十文件 focused gate `197 pass / 0 fail / 687 expect`；`bun run typecheck` exit 0；`bun run test:backend` 连跑两次均 `0 fail`。Task 4 自身门禁在 `3e418cdb`：`26 pass / 0 fail / 62 expect`，typecheck 与 `git diff --check` 均 exit 0。
- **未推送**。分支自基线 `92858d08` 起共 32 个提交。

## 入口指引（按序读）

1. **本文**——先读「必须最先做的事」与「已确证的硬事实」。
2. `docs/plan/2026-08-08-long-resident-operation-lifecycle.md`——计划正文，Tasks 5–8 在第 384 行之后。**注意它对 `shutdown.ts` 的描述可能已陈旧，见下。**
3. `docs/tmp/2026-08-08-long-resident-operation-lifecycle-progress-impl-1.md`——逐轮进度、在途意图、**已作废路线（四条，别重试）**。
4. 三份评审证据（都已进仓库，不会被 `git clean` 删）：`docs/tmp/*-task-3-report.md`（M1–M9 变异证据）、`*-b1-verification.md`（verifier 三轮）、`*-b1-merged-review.md`（reviewer 三轮）。

## 必须最先做的事：先合并 master，再动 Tasks 5–8

**这是本次交接最重要的一条，不做会白干。**

- **证据**：本分支基线 `92858d08` 之后，master 已前进 **287** 个提交，其中 **11** 个改过 `src/lib/shutdown.ts`；`git diff --stat 92858d08 master -- src/lib/shutdown.ts` 显示 **403 行变动、净减 258 行**（复现命令即此）。同期 master 也改过 `src/lib/context/manager.ts`（+20）与 `src/lib/context/request.ts`（+23）——**正是 Task 4 与 Task 2 改的两个文件**。
- **为什么阻塞**：Tasks 5–8 的主要战场就是 `shutdown.ts`（Task 6「暴露 tracked-operation 运维真相」、Task 8 文案与验收）。master 的 lossless-shutdown 重写已经删改了计划正文引用的结构，照旧基线施工等于对着不存在的代码写。
- **前提仍成立（已核实，不必重查）**：master 版 `formatActiveRequestsSummary`（`master:src/lib/shutdown.ts:246-256`）**仍然打印 `request.state`**——正是产生 `(failed, 17620s)` 的那个字段。所以本项目要修的缺陷在当前 master 上依然存在，工作没有作废。措辞已由 `active request(s)` 改为 `accepted operation(s)`，**Task 8 里任何按旧文案写的断言都要重新校准**。
- **合并策略**：按 memory `methodology-remerge-stale-feature-across-subsystem-rewrite`——**取 master 的结构，重放我们的 delta**，不要把 master 的重写往回改成旧形状。
- **合并后必须重跑**：十文件 focused gate + `bun run typecheck` + `bun run test:backend`（只看 `0 fail`）。

## 已确证的硬事实（别再重新推导）

| 事实 | 证据等级 | 出处 |
|---|---|---|
| 退出日志矛盾的根因是**四类独立 lifecycle 事实被混为一谈**：logical terminal（`pending/executing/streaming/completed/failed/aborted`）、operation scope（`sealed`/`childCount`/`quiesced`）、delivery lifecycle（`open/finalizing/finalized/failed`）、canonical finalization（`waiting/running/completed/failed`）。`failed` ≠ quiesced。 | 源码读证 + 冻结 spec | spec §§5–7 |
| 合法终止是**偏序不是总序**：候选/派发所有权先闭合 → logical terminal seal operation scope → operation quiescence 与 delivery finalization 并行 → canonical finalizer join 二者 → manager 释放 registry。 | 源码读证 | spec §7 |
| `failureRegistered: true` 的权威语义是 **process shutdown lifecycle failure barrier 已同步持有该错误**。**不得**改成 context-local ledger。 | 独立 reviewer 证伪过后者 | 见进度文件「已作废路线」第 4 条 |
| candidate reservation 的真实 owner 是 `coordinator.ts`；scheduler 只拥有 dispatch active slot，candidate 只拥有 verdict。 | 源码读证 + 探针 | 进度文件 |
| **release-first ownership**：catch 保存原始错误 → finally 释放 → 之后传播。 | 冻结 spec §7.1 + 九轮评审 | spec |
| unknown rejection **不能用 value sentinel**（`throw undefined` 合法）；存在性必须由显式 flag 或数组长度表达。 | verifier 实测探针 | `*-b1-verification.md` Finding I-1 |
| 字段存在性用 `"error" in settlement` / `Object.hasOwn()` 区分，不能按值过滤。 | reviewer 实测 | `*-task-3-report.md` 第四轮 |

## 各 Task 当前状态

| Task | 状态 | 落地 commit | 备注 |
|---|---|---|---|
| 1 lifecycle 纯模型 + OperationScope snapshot | ✅ 完成并评审通过 | `62f572c1..8c9c85d5` | |
| 2 RequestContext 四事实状态机 | ✅ 完成并评审通过 | `0af6850b..f05db881` | |
| 3 dispatch cleanup failure ownership | ✅ 完成，历经六轮评审 | `4de3cd6e..cf8f4380` | |
| **B1 合并态评审** | ✅ **已闭合** | — | reviewer approved（0 Critical / 0 Important / 1 Minor）；verifier 0 findings。那条 Minor 已在 `4b961615` 消除 |
| 4 manager registry + lifecycle failure barrier | ⚠️ **已实现但评审未通过** | `3e418cdb` | 独立评审判 **1 blocker + 1 major**，**修掉前不可进入 Task 5**。报告已存档 `docs/tmp/*-task-4-review.md`。修复已派出，结论见该报告与后续 commit |
| 5 从真实 delivery owner 发布 begin/success/failure | ⬜ 未开工 | — | plan 第 384 行起 |
| 6 暴露 tracked-operation 运维真相 | ⬜ 未开工 | — | plan 第 454 行起；**受 master 重写影响最大** |
| 7 全 producer 与现场僵尸回归矩阵 | ⬜ 未开工 | — | plan 第 510 行起 |
| 8 Mutation、全量验收、文档与最终评审 | ⬜ 未开工 | — | plan 第 557 行起；**文案断言需按 master 新措辞校准** |

## 待办（每条带验收判据与证伪方式）

1. **闭合 Task 4 的评审发现**
   - 评审结论：**1 blocker + 1 major，Task 4 在修掉前不可通过、不得进入 Task 5**。完整报告已存档在 `docs/tmp/2026-08-08-long-resident-operation-lifecycle-task-4-review.md`（**仓库内，不会随 job 消失**）。
   - **BLOCKER**：已登记的 delivery failure 永不进入 drain——错误只写进 `manager.ts:272` 的 `lifecycleFailureBarrier`，该 map 全文件仅两处写、零处读，ctx 又已从 registry 删除，失败裁决在进程层彻底消失。plan Step 1 要求的那条用例从未写出，所以套件全绿是 false-green。
   - **MAJOR**：该 barrier 无任何驱逐、按 requestId 单调增长——**反长驻留的工作自己引入了一条进程级长驻留**。
   - 验收：`drainLifecycleFailures()` 在 delivery failure 后抛出含原始 error 的 AggregateError，且 barrier 被消费即清空；每条新断言配 exact-patch mutation 证明鉴别力。
   - 证伪：`grep -n lifecycleFailureBarrier src/lib/context/manager.ts` 若仍只有写、没有读，说明未修。
   - **两条已记录、本轮不改的观察**（见进度文件）：C2 的「未登记 failure」保护分支**生产不可达**（`request.ts:910` 的 outcome lock 在登记前就 return），只有推理无正负样本，**待独立裁决，别自行删除该分支**；C3 现实现下终态到 release 全是 microtask 链，`/api/status` 撞不上 `blocker==="none"` 的 invariant throw，**Task 6 接线时若在其间插入 await 就会变 500**。
2. **合并 master**（见上「必须最先做的事」）
   - 验收：合并后三道门禁全绿，且 `git log --oneline master..HEAD` 只含本项目的提交。
   - 证伪：`grep -n "state" src/lib/shutdown.ts` 若显示 drain 摘要仍直接读 `request.state` 而未经 lifecycle blocker 归一，说明缺陷仍在（这正是要修的）。
3. **Tasks 5–8 按计划推进**，但先做一次 **plan-vs-code 对账**
   - 验收：逐条核对 Tasks 5–8 引用的每个 `file:line` 与符号在合并后的树上仍存在；不存在的当场标注并改写计划。
   - 证伪：任一被引用符号 grep 不到，即证明该 Task 的步骤已陈旧。
   - 已知一处：Task 4 已发现 plan 的 Files 清单漏了 `src/lib/shutdown.ts`（被改名方法的唯一生产调用点在那里），**Task 6 会撞上同一接缝**，代码里已留注释标出切分点。

## 与既有裁决的对账

- 本项目所修的 drain 行为与 master 新落地的 **lossless shutdown** 系列（`04e6ecb1 fix: drain accepted requests losslessly on shutdown`、`d254d8ae refactor: remove shutdown-owned request cancellation`、`71c043cf docs: finalize lossless shutdown lifecycle`）**处在同一区域**。
- **尚未对账**：本文作者未逐条核对这两套工作的取舍是否冲突（例如「shutdown 不拥有 drain deadline，只有 request 级机制可终止工作」这条 master 新裁决，与本计划的 blocker 聚合是否一致）。
- **这是一条正式待办**：合并 master 后，**先读 `71c043cf` 引入的那份 lossless shutdown 文档，再动 Tasks 6/8**；若发现取舍冲突，交用户裁决，不要自行取舍。

## 本轮我犯过的错（每条绑复现点）

1. **把承重的类型断言当成多余的清理**——我判定 `failures.push(failure as HedgeRaceFailure)` 的 `as` 是冗余并删掉，typecheck 立刻报 TS2322（换条件后 `else` 分支不再收窄 `outcome`）。
   **复现点**：待办 3 做 plan-vs-code 对账时，凡想「顺手清理」类型断言，先跑 `bun run typecheck` 再下结论。
2. **据 mtime 判定 agent 已死**——我据 transcript 27 分钟不增长认定 reviewer 失败，随后 `SendMessage` 返回「已排队待送达」证明它仍在运行。mtime 只是弱信号。
   **复现点**：待办 1 等待评审结论时，不要据文件 mtime 判活；只有调用真的失败才算不可达。
3. **引用了不稳定的数字**——`bun run test:backend` 的测试总数在同树同 commit 连跑之间会变（4032/3756/6681），我一度把它当成范围差异去追。
   **复现点**：待办 2 合并后重跑门禁时，只引用 `0 fail`，别写总数。已记入 memory `reference-parallel-test-total-count-unstable`。
