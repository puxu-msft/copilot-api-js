# Kick-off prompt — LiveDock 在途浮窗 + active-request wire SSOT

复制以下内容到新会话即可开始实施(subagent-driven 推荐)。

---

请实施 [docs/plan/live-inflight-dock.md](live-inflight-dock.md),把 ui-v4 请求列表页的在途泳道改为底部停靠、点击向上展开的富信息浮层,并建立 active-request 的 wire 类型单一事实源。规格见 [docs/spec/live-inflight-dock.md](../spec/live-inflight-dock.md)。

**执行方式**:用 `superpowers:subagent-driven-development`,每个 Task 派新 subagent、任务间两阶段 review。按 Phase A → B → C 顺序(有依赖:A1 wire 类型 → B1 前端 re-export → B2/B3 → C)。

**本项目硬约束(务必遵守)**:
- 构建 gate 是 `bun run build:ui-v4`(不是 `build:ui` —— 那是旧 Vue `ui/`);它是唯一能暴露「type-only re-export 误拖后端运行时」的门。
- wire 类型模块 `src/lib/observability/active-request-wire.ts` 绝不 import `~/lib/state`(直接或传递);前端一律 `import type` 引用。
- 不启动服务器(no `bun run dev`/`start`,no kill);布局不变量由用户在浏览器人工核(Task C4 Step 6)。
- 每 Task 一提交,显式 pathspec(`git add -- <路径>`、`git commit -- <路径>`),conventional commits,不加模型署名。
- 每 Task 收尾:`bun run typecheck && bun run lint:all && bun test`;前端改动追加 `bun run build:ui-v4`。
- 遇既有测试失败/类型错误不当「与我无关」,先读实际代码确认根因再修。

**收尾(全部 Task 完成后)**:走 `session-closeout` —— ① subagent 交付前独立核验 ② doc-sync(更新 [docs/DESIGN.md](../DESIGN.md) 活的架构现状表,加 LiveDock 行 + active-request-wire 类型 SSOT 节;spec 头部标实施状态)③ 登记推迟项到 [docs/todo/deferred-backlog.md](../todo/deferred-backlog.md)(per-group 折叠 / 终态淡出动画 / 面板内 abort / 展开态焦点被遮自动滚入)④ 提炼教训维护记忆库 ⑤ 细粒度提交。
