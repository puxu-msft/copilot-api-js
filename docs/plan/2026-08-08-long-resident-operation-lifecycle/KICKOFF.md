# KICKOFF：继续「超长驻留 operation lifecycle」（Tasks 5–8）

> 复制本文作为新会话第一条消息。完整档案在 `docs/plan/2026-08-08-long-resident-operation-lifecycle/HANDOVER.md`。

## 工作方式（硬性）

- 工作树 `/home/xp/src/copilot-api-js/.worktree/fix-long-resident-operations`，分支同名，基线 `3e418cdb`。每条 Bash 调用自带绝对路径根。**不要 push。**
- 代码改动派 implementer 到隔离 worktree；评审一律派 subagent，不在主会话自审。
- 派 implementer 前先读 skill `session-closeout` 的 §6b（进度文件协议）。本项目的进度文件是 `docs/tmp/2026-08-08-long-resident-operation-lifecycle-progress-impl-1.md`。

## 启动前的三道 gate（按序，前一道不过不要进下一道）

**Gate 1 —— 确认 Task 4 的独立评审结论。**
上一会话结束时该评审仍在进行，**结论未知**。报告应在 `/home/xp/.claude/jobs/36fcb851/tmp/task-4-review.md`；该路径属 job 临时目录，**job 一旦删除即消失**。文件不存在就重派一轮 Task 4 评审，**不得视为已通过**。详见 HANDOVER「待办 1」。

**Gate 2 —— 先合并 master，再动任何 Tasks 5–8 的代码。**
本分支落后 master **287** 个提交，其中 11 个重写了 `src/lib/shutdown.ts`（403 行变动、净减 258），而 Tasks 5–8 的主战场正是该文件。照旧基线施工会白干。策略、复现命令与合并后必跑的门禁见 HANDOVER「必须最先做的事」。

**Gate 3 —— 读 master 新落地的 lossless shutdown 文档（`71c043cf` 引入），再动 Tasks 6/8。**
它与本计划处在同一区域，两套取舍**尚未对账**。发现冲突交用户裁决，不要自行取舍。详见 HANDOVER「与既有裁决的对账」。

## 三道 gate 之后的第一步动作

对 Tasks 5–8 做 plan-vs-code 对账：逐条核对计划里引用的每个 `file:line` 与符号在合并后的树上是否仍存在，不存在的当场标注并改写计划。已知 Task 6 会撞上一处接缝（代码里已有注释标出）。判据与证伪方式见 HANDOVER「待办 3」。

## 批准状态

- **已批准、无需再问**：Tasks 1–8 的计划本身（用户已批准实施），以及「修根因不修表象」这一方向。
- **需用户先定的**：若 Gate 3 发现本计划与 master 的 lossless shutdown 取舍冲突，冲突点的取舍由用户裁决。
- **已闭合、不要重做**：Tasks 1–3 与 B1 合并态评审（reviewer approved、verifier 0 findings）。进度文件「已作废路线」里的四条**不要重试**。

## 这一轮反复踩的坑

- 不要据 transcript/文件 mtime 判定 agent 已死——只有调用真的失败才算不可达。
- 不要引用 `bun run test:backend` 的测试总数（同树同 commit 连跑会变），只引用 `0 fail`。
- 清理类型断言前先跑 `bun run typecheck`——本轮有一处 `as` 是承重的。

## 测试门禁现状（核验于 2026-08-08 / `3e418cdb`，接手第一件事是复验而非采信）

- 十文件 focused gate：`bun test tests/context/operation-lifecycle.unit.test.ts tests/context/operation-scope.unit.test.ts tests/context/request-context.unit.test.ts tests/context/generation-recorder-lifecycle.unit.test.ts tests/context/generation-finalization.unit.test.ts tests/transport/dispatch-lifecycle.unit.test.ts tests/pipeline/candidate-runtime.it.test.ts tests/pipeline/generation-recorder-driver.unit.test.ts tests/pipeline/generation-coordinator.it.test.ts tests/pipeline/coordinator-hedge.unit.test.ts` → 当时 `197 pass / 0 fail`。
- `bun run typecheck` → exit 0；`bun run test:backend` → `0 fail`。
- **禁区**：绝不杀死用户在 **4141 端口**的主服务器实例；要起测试服务器用别的端口，按 PID 精确清理自己起的那个。
