# 交接：block 级缓冲重试执行（新会话 kick-off）

**给下一个会话的开场指令。** 复制下方「新会话开场」段落即可接续。

## 现状快照（2026-07-11）

- **spec 已获批**（三轮对抗审查定稿）：`docs/spec/2026-07-11-block-level-buffered-retry.md`。
- **plan 集就绪**（plan-review 收敛、契约已对齐）：`docs/plan/2026-07-11-block-level-buffered-retry/`——README（**冻结契约节 = 单一事实源**）+ P0-P4 + kickoff。
- **执行已启动**（subagent-driven，隔离 worktree）：
  - worktree `.worktrees/block-level-buffered-retry`（分支 `feat/block-level-buffered-retry`，从 master `88a11516`）。
  - **durable ledger** `.superpowers/sdd/progress.md`（**权威进度**——每 Task 状态 + commit 哈希 + 承重 concern + MINOR 待办）。
  - **P0 Task 1 DONE + 独立 review 通过**（commit `91f5e0f9`，spec✅/quality Approved；R1 字节中性双证）。
- **下一步 = P0 Task 2**（telemetry partial-degrade 终局 + vendor 维度 per-vendor Record + /api/status 聚合）。

## 为何交接

单会话从 req_484 分析 → spec(3 轮) → plan(plan-review) → 执行启动 + P0 Task 1，上下文已满。剩余 20+ Task（P0×2 + P1×7 含 2 处须用户跑的 PoC 门 + P2×7 + P3×4 + P4×3）跨多会话。基础设施（worktree + ledger + brief 脚本）已让接续零成本、避免执行中途丢上下文（技能警告的最贵失败）。

## 承重提醒（新会话必知）

1. **读 ledger 起步**：`cat .worktrees/block-level-buffered-retry/.superpowers/sdd/progress.md`——标 complete 的 Task 别重派，从第一个未完成的（Task 2）起。
2. **冻结契约是单一事实源**：P1-P4 消费的签名逐字见 README「冻结契约」节，任何 plan 局部代码样例与之冲突以契约为准。
3. **跨任务承重**：P1/P2 接线 `commitBoundaries` 时，必须把两 handler（messages/responses）的 `if(outcome==='partial-degrade')return` 临时 guard 换成真记账，否则静默丢 partial-degrade 遥测（ledger MINOR 待办已记）。
4. **红线 R1-R5**（README）：P0 行为中性（R1，landing 门）；默认翻转在 PoC/实证门后（R4）；每 phase 关对应 backlog 条（R5）。
5. **P1 有 2 处 PoC/实证门须用户手动执行**（no-auto-server）：Task 5 两段 anchor PoC（第二段跑真实 Claude Code）、各端点 keepalive idle oracle。到那些 Task 停下给用户命令 + 判据 + 三分支后续。
6. **subagent API 近期不稳**（多次 mid-response 失败）：implementer/reviewer 失败按技能 BLOCKED 处理（补上下文/换模型/或内联接管），别空转。
7. **纪律**：隔离 worktree 内正常提交；显式 pathspec；conventional commits 无模型署名；`bun test`/`typecheck`/`lint:all` 非服务器命令可跑。

## 新会话开场（复制这段）

```
接续「block 级缓冲重试」的 subagent-driven 执行。先读 worktree 内 ledger 定位进度：
cat /home/xp/src/copilot-api-js/.worktrees/block-level-buffered-retry/.superpowers/sdd/progress.md

用 superpowers:subagent-driven-development 技能。在 worktree .worktrees/block-level-buffered-retry（分支 feat/block-level-buffered-retry）继续。P0 Task 1 已 complete+review 通过（commit 91f5e0f9），从 P0 Task 2 起。

冻结契约 = docs/plan/2026-07-11-block-level-buffered-retry/README.md「冻结契约」节（单一事实源）。DAG：P0(剩 Task2/3) → P1(7,含 2 处须用户跑的 PoC/实证门) → P2/P3/P4(并行)。每 Task：task-brief 抽 brief → fresh implementer(指定模型) → review-package → 独立 task-reviewer(spec+质量) → 必要时 fix → 记 ledger → 下一 Task。红线 R1-R5 见 README。承重 concern 见 ledger 末尾 MINOR 待办。到 PoC 门停下给用户命令+判据。
```
