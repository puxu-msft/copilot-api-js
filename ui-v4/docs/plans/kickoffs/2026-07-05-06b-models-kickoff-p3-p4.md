# Kick-off — Models 增强 P3 + P4（ui-v4 / React）

复制以下内容到新会话：

---

你在 copilot-api-js 仓库继续「Models 页面全面增强」的 **React ui-v4** 实现，做 **P3（详情面板）+ P4（CSV 导出 UI + 未关联遥测小节 + a11y + 文档）**。**P1+P2 已落地**（纯逻辑地基 + 富表格/过滤/列配置/遥测列）。

**先读**（按序）：
1. `ui-v4/docs/plans/2026-07-05-06b-models-page-enhancement.md`（本增强的 React 规划 + 已定决策 + P1/P2 落地状态）
2. `docs/spec/2026-07-05-ui-v4-models-enhancement.md`（设计 WHAT/WHY，§3/§6 详情分区字段清单——框架无关）
3. 现状：`ui-v4/src/components/models/`（ModelsPage/ModelsTable/ModelsFilterBar/ModelsColumnMenu）+ `ui-v4/src/lib/{model-telemetry,models-csv,model-columns,model-filters}.ts` + `hooks/{useModels,useModelTelemetry}.ts`

**关键约定/复用**（已在 P1/P2 建立）：
- `~backend` 纯模块可复用：`import type { Model } from "~backend/lib/models/client"`（type-only 破环）、`import { deriveCapabilities } from "~backend/lib/models/capabilities"`（能力矩阵同源）、`normalizeModelId` from `~backend/lib/models/normalize-id`。
- 后端 `request_headers` 已暴露（`/api/models` 删了 stripInternalFields）。
- ui-v4 约定：URL-as-truth（`list-store`）、tab 用 `DetailSubRail` 的 `SEGMENTS as const` 模式、`shared/Modal`、Terminal Amber token（`var(--color-primary/muted/border/surface/ok/fail)`、`.mono`、锐角）、`lib/format.ts`（formatNumber/formatDuration/formatUsageTokens）、`lib/export-entry.ts` 的 `triggerDownload`、`lib/clipboard.ts` copyText、`detail/CodeBlock`（shiki）/`tools/JsonTreeView`。
- 测试双 runner：纯逻辑 `tests/*.bun.test.ts`（`bun:test` 的 describe/expect/it）、组件 `tests/*.vitest.test.tsx`（@testing-library/react + `vi.mock` hook）。前端 vitest 坑见 skill `debugging-frontend-tests`。

**P3（详情面板）——已定决策**：选中态走 **URL query（`?model=<id>`）+ 右侧 split 面板视觉**（react-router `useSearchParams`；非全页、非居中 Modal）。面板内 6 tab 分区（`DetailSubRail` 式竖 tab）：Overview / Capabilities / Limits+Vision / Billing+Policy / Telemetry / Raw JSON——全字段（spec §3）、Capabilities 展示**完整 raw `capabilities.supports` map**（非仅派生子集，richest-data-flow）、Vision 条件区块、Telemetry 全 6 项 token（数据从 `telemetryForId(index, id)`）。ModelsTable 已有 `onSelect`/`selectedId` prop（P2 预留）。Esc 关闭（清 query）复用 ui-v4 键盘约定。布局壳自建（`flex min-h-0`：左表格 `flex-1 overflow-auto` + 右面板可调宽 `useResizableWidth`）。

**P4**：CSV 导出按钮（顶栏，调 `modelsToCsv`〔P1 已备〕→ `triggerDownload` text/csv Blob）；未关联遥测小节（`index.unmatched`〔P1 已备〕，表下方，多为纯别名失败请求，不静默丢弃）；a11y（tab role/aria、焦点、Esc）；回填 `ui-v4/docs/DESIGN.md` §7 Models + plan 状态改"已完成"。

**红线**：`~backend` 只引纯模块（否则 build 崩，见记忆 `feedback-verify-ui-with-build-not-just-typecheck`）；不前端重实现 `deriveCapabilities`；unmatched 不静默丢弃；类型走 `~backend` re-export。

**每 phase 收尾必跑**：`bun run typecheck:ui-v4` + **`bun run build:ui-v4`**（真 rollup，必验——Vue 版就栽在只 typecheck）+ `bun run test:ui-v4`（bun+vitest）+ `bunx eslint ui-v4/src/... | grep -v baseline`（0 error）→ 细粒度提交 → phase 末派 subagent audit（裁判轴：长远正确+完整+richest-data-flow，非 ROI/YAGNI）。不自启 dev server；需实测让用户开 5173 核对。

从 P3 开始。
