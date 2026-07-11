# Kick-off：Requests 列完全可配置（策展 + resize + reorder）

复制到新会话或用于 subagent-driven 执行：

---

在 `copilot-api-js` 实施 ui-v4 特性「Requests 列完全可配置」。

**先读**（按序）：
1. 计划：`ui-v4/docs/plans/2026-07-11-requests-column-config.md`（4 Task、TDD、每步含代码/判据）。
2. 权威 spec：`ui-v4/docs/spec/2026-07-11-ui-v4-requests-column-config.md`（取舍 + §10 审查纪要）。
3. 现状锚点：`ui-v4/src/lib/request-columns.ts`（REQUEST_COLUMNS/COLUMN_WIDTHS/DEFAULT_COLUMN_VISIBILITY）、`HistoryList.tsx`（fixedHeaderContent th / itemContent td / useReactTable / session 特判）、`RequestsListPage.tsx`（现列可见性提升）、`RequestsColumnMenu.tsx`、`activity-row.ts`（tokenCacheRead/rowAnomaly/Signal）、`request-columns.bun.test.ts`（要更新的断言）。

**红线**（计划 Global Constraints，逐条守）：
- 仅固定列（`enableResizing!==false`）emit inline `width:getSize()`；preview/response 绝不设 width（保自适应，避 getSize()=150 陷阱）。
- resize 手柄须 `onPointerDown stopPropagation` + dnd PointerSensor `activationConstraint:{distance:4}`（否则拖边界误触 reorder）。
- session gutter 沿用特判 `p-0 w-[10px]`、排除 sizing、锁列序首、不入 dnd/菜单。
- 版本化键 `column-state:v1`，旧键弃用重 seed（存量显隐一次性重置）。
- cache 命中率分母含 creation、读原始 usage 数字。
- AgentLane/RequestRow 不改、清其陈旧「import 本表」死注释。
- 后端零改动、只碰 `ui-v4/**` + package.json。

**执行纪律**：逐 Task TDD（写挂测试→实现→跑绿→typecheck+eslint+全量 vitest 无回归→显式 pathspec 提交）；**no-auto-server**（不 `bun run dev`/start、不 kill；可 bunx tsc/eslint/vitest、bun test、bun add、bun run build:ui-v4）；conventional commits 无模型署名。已知基线（勿修勿计失败）：request-pages ×2 vitest + 4 tsc responsePreviewText。Task 4 人工视觉核验须请用户起服。

---
