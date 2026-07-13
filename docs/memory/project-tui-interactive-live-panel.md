---
name: project-tui-interactive-live-panel
description: 交互式 TUI live 面板项目现状——P0/P1 已 merge，渲染模型分层重构（恒定高度区+detail备用屏）已落地，P2 破坏性动作待做，待用户真终端复验
metadata:
  type: project
---

交互式 TUI live query 面板（折叠分组 footer ↔ 展开逐条面板 ↔ 单条 detail，行级动作：高亮/回车详情/abort 在途请求/复制 req_id）。大型结构重构 + 新交互特性，RFC-first 分 P0/P1/P2 三阶段。

**⚠️ 渲染模型已重构（2026-07-11）**：P1 落地后用户真终端实测暴露 DECSTBM 几何 churn（视图切换吃日志行/留空行/footer 泄漏），已重构为**交互实例恒定高度区 + detail 备用屏 + fix A 自愈 + 三态 emergencyWrite 协调**（11 task 逐件过审 + 合并态 review 闭环，commit fb6cc508→2c8f826a）。**现状权威看 `docs/DESIGN.md`「交互式 live 面板」节 + spec/plan `2026-07-11-tui-render-model-layered` + ADR 决策 4 双补记**。下方旧 P0/P1 权威文档是那两阶段的时点产物（Region N=1 collapsed 等描述已被恒定高度取代）。

**权威文档**（现状看这些，非本 stub）：
- RFC `docs/rfc/2026-07-10-interactive-tui-live-panel.md`（v2，两轮对抗评审 consensus，PoC 结果回填）
- ADR `docs/decisions/2026-07-10-tui-terminal-ownership.md`（**Accepted**，用户 2026-07-10 签字；反转 observability-rewrite「ConsoleSink 只读」，呈现/逻辑两分演进为呈现/逻辑/控制三分）
- P0 计划 `docs/plan/2026-07-10-tui-terminal-reorg-p0.md`（已实施）
- PoC harness `exp/tui-rawmode/`（README 有 pty 实测结论）

**阶段状态**：
- **P0（终端层重组）已 merge 入 master**（2026-07-10，本地 subagent-driven，6 task 全绿 + 全分支最终 review 批准）。`ConsoleSink` 重组为 `src/lib/tui/` 层的 `TerminalUi`（bus 订阅者），footer/syslog 抽成 `tui/render/{footer,syslog}.ts` 纯模块，`format.ts`/`log-line.ts` 留 `projections/`，加 ESLint 边界 + L1 守卫。行为逐字等价（golden-fixture oracle `tests/tui/__fixtures__/console-golden.txt` + 90 回归）。`sinks/console.ts` 已删。
- **P1（只读交互面板）已 merge 入 master**（2026-07-11，本地 subagent-driven，8 task 全绿 + 逐 task 过审含 opus 集成审查 + 真终端反馈两修）。DECSTBM sticky region（PoC-2 byte 级选定）+ 展开/收回/导航 + detail（跨事件累积 attempts[]）+ 选中滚动触达溢出 + raw-mode 常驻（Reading B：仅显式注入 stdin 才 interactive，护 test-isolation、golden 零 churn）+ exit-hook/shutdown-scheme-A 还原。分层 keys/controller/render/terminal-ui（ESLint path-group 钉死）。真终端反馈修入：req_id 显全（`1c23e6f4`）、**面板固定高度 3 行消除空行 churn**（`cfc4f05e`，`panelContentRows` 共享 helper 对齐 controller/renderer 窗口 + F3 联合回归测试）。待用户真终端验收（清单在 plan 末）；残留打磨（help-toggle 滚动 F1、1↔2↔3 微动 F2）见 `docs/todo/deferred-backlog.md`。
- **P2（破坏性动作）待写计划**：abort（镜像 reaper `reapInFlight()`+终态 settle，新 `user-abort` provenance，见 RFC Q5）+ req_id 复制（OSC52）+ drain scheme A。

**PoC 实测状态**（`exp/tui-rawmode/`，pty 无人化）：Q1（Ctrl-C→0x03）/ Q4（exit-hook 同步 flush 还原）/ Q2（DECSTBM correct-by-construction）byte 级闭合；**待用户真终端复验**：Q2 原生滚动视觉锚点/闪烁观感、Q3 OSC52 系统剪贴板是否真写入（否则退回显示 req_id 供鼠标选）。

**相关待办**：footer 分组「按组数自适应显示 top-N elapsed」（1→5/2→3/3→1/4+→1）记 `docs/todo/deferred-backlog.md`，P0 后作独立 feat（改 `tui/render/footer.ts` + 有意的 golden 更新）。

**Related**: [[reference-node-modules-presence-not-lockfile-truth]]（选依赖前查 bun.lock，本项目弃 cli-truncate 的教训）。
