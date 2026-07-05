# Kick-off — Phase 3（表格遥测列 + 新过滤 + 列配置 + 未关联遥测小节）

复制以下内容到新会话：

---

你在 copilot-api-js 仓库实施「ui-v4 Models 页全面增强」的 **Phase 3（表格/过滤/列配置 + 未关联遥测小节）**。**前置：Phase 1-2 已完成**（join 核 + `useModelDetail` + 抽屉可用）。

先读（按序）：
1. `docs/plan/ui-v4-models-enhancement/README.md`
2. `docs/plan/ui-v4-models-enhancement/phase-3-table-filters-columns.md`（逐 task TDD）
3. `docs/spec/2026-07-05-ui-v4-models-enhancement.md` §4.3/§7

用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 逐 task 实施。

**本 phase 范围**：① `useModelColumns`（列显隐 + `useLocalStorage` 持久化 + retain-on-absence 合并）；② 新过滤谓词（premium/restricted-to/policy/has-telemetry，抽 exported 纯函数便于 bun 测；has-telemetry 经注入 `telemetryPredicate` 留在 catalog 统一 `filteredModels`、无双重过滤）；③ FilterBar 新控件 + Toolbar 齿轮菜单；④ ModelsTable 列显隐 + req(7d) 列 + 占比条；⑤ "未关联遥测"小节（消费 `useModelDetail.telemetryIndex.unmatched`）。

**红线**：**禁止手搓 localStorage**——用 `useLocalStorage`；has-telemetry 不引入双重过滤；unmatched 小节真呈现 join 不上的遥测；类型从 `~backend`；不碰 `CLAUDE.md`；pathspec 提交；命令走 `bun run`。

**验证**：`bun run typecheck:ui` + `bun run test:ui:bun`/`test:ui:vitest` 全绿。收尾派 subagent audit（裁判轴：过滤无双重/耦合、列配置 retain-on-absence、unmatched 真呈现；**非** ROI/最小化）。

从 phase-3 的 Task 1 开始。
