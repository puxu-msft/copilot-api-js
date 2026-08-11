# 2026-08-10 收尾指令文本独立评审

## 评审范围

- `/home/xp/src/copilot-api-js/docs/memory/methodology-status-text-is-a-criterion-enumerate-the-state-space.md`
- `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md` 中 commit `86191ec2` 新增的索引钩子
- `/home/xp/src/copilot-api-js/.claude/skills/process-lifecycle-shutdown/SKILL.md` 在 `d2f66fa9..86191ec2` 的全部改动

## 已读取／执行的证据

- 当前仓库 HEAD：`11558f812a31e61669c6c5495ee13b80d64dfec5`；评审开始时分支为 `master`。
- 已读取当前 `src/lib/shutdown.ts` 的 `abandonDrain`、`describeDrainAbandonment`、`handleShutdownSignal`、`gracefulShutdown`／`finalize` 相关行。
- 已读取两份既有评审：`docs/tmp/2026-08-10-third-tier-signal-review-gpt.md` 与 `docs/tmp/2026-08-10-third-tier-signal-test-gaps-review.md`。
- 已读取 `git diff d2f66fa9..86191ec2 -- .claude/skills/process-lifecycle-shutdown/SKILL.md` 与 commit `86191ec2` 的 memory diff。

## 总体 verdict

待全部断言核验与发现闭合后填写。

**Blocker 数量：待定。**

## 事实性发现

## 聚焦复评：frontmatter `description`

**结论：1 个 major，0 blocker。** 当前行已正确删除旧的“两档／第二终止信号立即强退”契约；但对本轮最关键的“操作者状态文本撒谎”症状仍有召回缺口。

[major] `/home/xp/src/copilot-api-js/.claude/skills/process-lifecycle-shutdown/SKILL.md:2` — 新 description 没有覆盖“shutdown 横幅／状态文本说 `now flushing`，实际仍被 drain 阻塞”这一自然提问形态。现有“shutdown 状态真值”更像 lifecycle state 的内部真值，不能稳定召回 operator-facing banner／日志措辞错误；这是本轮新增方法论的核心触发场景，漏召回会让后续会话跳过该 skill。— 修复：在 description 中显式加入“shutdown 横幅／状态文本与实际 drain／flush 不符”。

**旧契约残留核验：通过。** `git show d2f66fa9:.claude/skills/process-lifecycle-shutdown/SKILL.md` 的旧行含“第二终止信号强退”；当前 `/home/xp/src/copilot-api-js/.claude/skills/process-lifecycle-shutdown/SKILL.md:2` 已替换为“重复终止信号的三档升级（放弃 drain 但仍 finalize vs 立即强退）”，与当前实现契约一致，不再把第二个终止信号一概描述为强退。

**旧触发词覆盖核验：通过。** 旧行中的“进程信号、Ctrl+C、SIGINT/SIGTERM、SIGUSR2 交接、首信号无损 drain、重复信号、TUI raw/cooked 恢复、runtime PID 投递、waitForShutdown latch、History/Telemetry/Diagnostic finalization、shutdown 状态真值”在新版均逐字保留或被更具体的“重复终止信号的三档升级”覆盖，没有因本轮改写丢失旧召回面。

**新增‘第二个信号后没退出’召回核验：通过。** 当前行同时含“重复终止信号的三档升级（放弃 drain 但仍 finalize vs 立即强退）”和“优雅重启时旧进程迟迟不退”，足以覆盖“第二个信号后进程没退出，是不是卡住了”；不应恢复旧的“第二终止信号强退”措辞。

**建议的新 description 全文：** `description: 当在 copilot-api-js 修改或排查进程信号、Ctrl+C、SIGINT/SIGTERM、SIGUSR2 交接、首信号无损 drain、重复终止信号的三档升级（放弃 drain 但仍 finalize vs 立即强退）、第二个终止信号后进程仍未退出／是否卡住、优雅重启时旧进程迟迟不退、shutdown 横幅／状态文本与实际 drain／flush 不符（如声称 now flushing 但仍被 operation 阻塞）、TUI raw/cooked 恢复、runtime PID 投递、waitForShutdown latch、History/Telemetry/Diagnostic finalization 或 shutdown 状态真值时使用。`

