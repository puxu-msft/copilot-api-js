# Kick-off — Phase 4（Export CSV + 抽屉 a11y + 文档卫生）

复制以下内容到新会话：

---

你在 copilot-api-js 仓库实施「ui-v4 Models 页全面增强」的 **Phase 4（Export CSV + a11y + 文档卫生）**，这是**最后一个 phase**，含全计划收尾。**前置：Phase 1-3 已完成**。

先读（按序）：
1. `docs/plan/ui-v4-models-enhancement/README.md`
2. `docs/plan/ui-v4-models-enhancement/phase-4-csv-a11y-docs.md`（逐 task TDD + 收尾五步）
3. `docs/spec/2026-07-05-ui-v4-models-enhancement.md` §7/§8/§11

用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 逐 task 实施。

**本 phase 范围**：① `models-csv.ts` 纯序列化（含遥测列，同 join 策略、CSV 转义）；② Export CSV 按钮 + Blob 下载（复用/抽 `triggerDownload`）；③ 抽屉 a11y（`onKeyStroke` Esc + `isTyping()` 守卫、aria、焦点——**先实测 Vuetify `temporary` drawer 原生 scrim/focus 行为再决定补什么**，勿假设、勿手写 `onClickOutside`）；④ 文档卫生：`git mv docs/2604-ui-models docs/archive/2604-ui-models`、回填 `docs/DESIGN.md`/`ui/CLAUDE.md`。

**红线**：CSV 遥测列与表格 req 列同源同 join；**battle-tested > 手搓**（a11y 优先 Vuetify 原生）；`git mv` 归档不删（可恢复）；**不碰 `CLAUDE.md`**（并发会话所有——只改 `ui/CLAUDE.md`）；pathspec 提交。

**收尾（`session-closeout` 五步，无需用户提醒）**：① subagent audit ② doc-sync + 跨文档 grep 验证（`grep -rn "轮询\|usePolling\|ModelCard\|行内展开" docs/ ui/` 无遗留）③ 归档 plan（各 phase 文件头加实施状态注解）④ 提炼教训 + 维护记忆库（遥测 join key 分裂、抽屉替换行内展开、full supports 等）⑤ 最终确认全绿。

**验证**：`bun run typecheck:ui` + 全 UI 测试 + 后端 models 测试全绿。

从 phase-4 的 Task 1 开始。
