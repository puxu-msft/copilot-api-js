# Kickoff: 续写重试 + 顺序 anchor 实施

复制以下内容开新会话启动实施。

---

你要实施「续写重试 + 顺序 anchor」特性。**先读**（按序）：

1. 权威 spec：`docs/spec/2026-07-22-continuation-retry-and-sequential-anchor.md`（什么/为何，单一事实源）+ ADR `docs/decisions/2026-07-22-continuation-retry-sequential-anchor.md`。
2. 计划总览：`docs/plan/2026-07-22-continuation-retry-sequential-anchor/README.md`（DAG + 冻结契约 + Global Constraints）。
3. 底座/前身 spec：`docs/spec/2026-07-11-block-level-buffered-retry.md`（已 landed，本特性完成其 Anthropic 未竟部分）。
4. 承重实证：`exp/block-level-anchor-sequential/FINDINGS.md`（顺序 anchor CLI-safe 已证）。

**执行环境**（项目 CLAUDE.md concurrent-sessions + protect-user-main-server）：
- 隔离 worktree `.worktrees/continuation-retry`，分支 `feat/continuation-retry` 从 master。用 `superpowers:using-git-worktrees`。
- durable ledger `.superpowers/sdd/progress.md` = 权威进度（每 task 状态 + commit + 承重 concern）。
- **绝不碰 4141**；测试服务器起非-4141、按 PID 精确清理。不跑 `bun run start/dev`。

**实施顺序（gate-first）：**
1. **先跑门簇** `plan-G-gates.md`（G1-G5，`exp/` 探针 + mock 上游 + 真客户端）。**门产出决定后续实现分支**——G2 FAIL 或 G4 FAIL 会改变 P1/P5 形状，未跑门前别写承重实现。
2. `plan-0-floor.md`（机制地基，纯新增、默认不变）。
3. `plan-1-sequential-anchor.md`（承重①，G1/G2 门后）→ `plan-2-continuation-driver.md`（承重②）→ `plan-3-anthropic-continuation.md`（治 incident）。
4. `plan-4-7-remaining.md`（Responses/CC/WS + 收口，各自门后）。

**方法（`superpowers:subagent-driven-development` 推荐）：** 每 task 独立 subagent + 两阶段审查（no-self-review）；异模型 reviewer 审 Claude 产出、prompt 显式写裁判轴（长远正确 + 完整，非 ROI/YAGNI）。TDD 逐 task；每 task 末显式 pathspec commit（`git commit -- <精确路径>`，conventional、无模型署名）。

**承重纪律（务必守）：**
- 顺序 anchor 打破 `ANCHOR_INDEX=0`+固定 `remap(,1)` 模型 → 运行时递增 index（P1 承重，非 sink 小改）。
- 续写撞 `driver.ts:1283` `!committedAny` 硬门 → 旁路 append 分支（P2 承重，非一句话扩展）。terminal-only 路径逐字不变（R1）。
- 合成轮打 `synthetic:"continuation"`、进 upstreamRequest 轨但**不污染上游原始轨**;ledger 只记 committed 块、跨 attempt 不清。
- wire 正确性用真实 SDK oracle（不自洽）;flaky/时序连跑 10-25 次;裁决实测 > 文档 > 声称。
- **默认翻转（P7）必在对应门 PASS 之后**——绝不先翻默认再验证。

**主目标验收：** incident req_162 形状（text 已 commit + tool_use mid-RST）经续写救回为完整响应（plan-3 Task 3.3）。
