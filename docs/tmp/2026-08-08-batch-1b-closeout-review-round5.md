# Batch 1b 收尾整改复审（Round 5，M1 专项）

- **评审范围：** 仅复审 Round 4 M1，即 canonical `requires` 图与整改后阶段表的逐 stage 传播。
- **已读取／执行的证据：** `/home/xp/.claude/skills/closing-a-development-session/SKILL.md:38-89,98-116`；`/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/tmp/2026-08-08-history-worker-batch-1b-terminal-report.md:97-125`；按依赖图从 stage 1、8 手工逐项传播。
- **总体 verdict：修复 major 后可进入下一阶段。M1 未闭合。**
- **blocker 数量：0。**

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/tmp/2026-08-08-history-worker-batch-1b-terminal-report.md:105,116,124-125` — 正文声称 stage 2–17 全部受阻，但「契约达成」列没有逐条表达该传播。
证据：canonical 图中 stage 8 依赖 stage 4 与 7，故除自身“未重审”外也受 stage 1 阻断；stage 16 经 15 传递受 1、8 阻断；stage 17 经 16 同样受 1、8 阻断。表内 stage 8／16／17 仅写 `❌ 未达成`，遗漏 `⛔ 受阻（1）`／`⛔ 受阻（1,8）`，与 `:105` 的“2–17 全部受阻”不一致。
修复建议：允许保留直接动作缺口，但在「契约达成」列同时写出传播状态，例如 stage 8 为“❌ 未达成；⛔受阻（1）”，stage 16／17 为“❌ 未达成；⛔受阻（1,8）”；或新增独立的“直接缺口”列，让「契约达成」列只呈现依赖图结果。

## 逐项结论

- stage 1：`❌ 未达成`正确；stage 2–7：`⛔受阻（1）`正确。
- stage 8：直接未达成正确，但漏报其同时受阻于 1。
- stage 9–15：`⛔受阻（1,8）`正确。
- stage 16–17：直接未达成不假，但漏报其同时受阻于 1、8；因此未满足本轮“传播结果逐条相符”的专项判据。
