# Models 页面全面增强（ui-v4 / React）— 实施规划

> 日期：2026-07-05
> 目标前端：**`ui-v4/`（React 19 + react-router 7 + zustand + @tanstack/react-query + tailwind 4，跑在 5173）**
> 状态：规划待审（用户 review 后再实现）
> 设计依据（WHAT/WHY，框架无关，复用）：[docs/spec/2026-07-05-ui-v4-models-enhancement.md](../../../docs/spec/2026-07-05-ui-v4-models-enhancement.md)

## 0. 背景（为何是这份规划）

原始需求「全面增强 ui-v4 的 models 页面」中，ui-v4 = **React 新前端**（不是 Vue 的 `ui/`）。此前的实现误做进了 `ui/`（Vue，已提交、保留、真实增强了旧 UI）。本规划把同一设计**在 React ui-v4 重实现**，复用：
- **已落地的后端改动**（跨前端共享，正确）：`/api/models` 暴露 `request_headers`（删 `stripInternalFields`）；`src/lib/models/normalize-id.ts` 纯模块（`normalizeModelId`）。
- **设计 spec 的 WHAT/WHY**（数据完整性、遥测 join key 分裂、6 分区详情、过滤、CSV、未关联遥测）——框架无关。
- ui-v4 本就把「Models 完整扩展列 + 过滤栏」显式 defer 给本轮（见 `ui-v4/docs/plans/2026-06-23-06-overview-models-config.md`，当前 `ModelsPage.tsx` 是刻意最小版）。

## 1. 现状基线（React）

- `ui-v4/src/components/models/ModelsPage.tsx`（~55 行）：raw-JSON 切换 + 4 列表格（id/name/vendor/version），无排序/过滤/详情/遥测。
- `ui-v4/src/hooks/useModels.ts`：react-query `["models"]` → `api.get("/api/models")`（full Copilot `Model[]`）。
- `ui-v4/src/types/status.ts` 的 `ModelInfo` 是 frontend-loose（`[key:string]:unknown`），注释自承"理想应从 `~backend` re-export"。
- 路由 `/models` 已注册（`App.tsx:37`），nav 已有（`NavRail.tsx:7`）。

## 2. 复用后端纯模块（single-source-of-truth，已验证 build 可行）

ui-v4 有 `~backend` alias（`../src`），已 re-export `~backend/lib/history/store` 类型且 build 绿。Models 增强复用：
- `import type { Model } from "~backend/lib/models/client"` —— 收紧 `ModelInfo`（type-only，运行时擦除，不拉后端 state）。
- `import { deriveCapabilities, type DerivedCapabilities } from "~backend/lib/models/capabilities"` —— 纯函数（仅 `import type Model`），派生能力矩阵，与后端 `/models`/`/anthropic/v1/models` **零漂移同源**。
- `import { normalizeModelId } from "~backend/lib/models/normalize-id"` —— 纯模块（本轮为修 Vue 构建已抽出），遥测 join 用。

> **交付前必跑 `bun run build:ui-v4`**（真实 rollup bundle）——typecheck 会把 `~backend` runtime import 当类型放过，只有 build 暴露"拖入后端运行时"。见记忆 `feedback-verify-ui-with-build-not-just-typecheck`（这正是 Vue 版翻车的根因）。

## 3. 数据源

| 数据 | 来源 | Hook |
|---|---|---|
| 模型目录（full Model[]） | `/api/models` | 既有 `useModels`（收紧返回类型为 `Model[]`） |
| per-model 运行遥测 | `/api/status.requestTelemetry.{modelsSinceStart,modelsLast7d}[]`（`RequestTelemetryModelSnapshot`：requestCount/success/fail/avgDur/usage） | **新 `useModelTelemetry`**：react-query `["status"]`（或复用 `useStatus`），**无 `refetchInterval`** → 挂载/重访即加载、不轮询（react-query staleTime 兜缓存，honor 用户"重访即刷新、不轮询"偏好） |

遥测 parse + join 为**纯逻辑**（`lib/`）：从 `/api/status` 原始对象 parse 出 `RequestTelemetrySnapshot`（防御式，镜像后端形状），再 `buildModelTelemetryIndex`。

## 4. 架构与文件（React，遵循 ui-v4 约定）

```
ui-v4/src/
├── components/models/
│   ├── ModelsPage.tsx           改：编排(表格+过滤+详情+CSV+未关联遥测)
│   ├── ModelsTable.tsx          新：密集表(全字段列/排序/可配置列/遥测列/行选中)
│   ├── ModelsFilterBar.tsx      新：搜索/vendor/type/capability/premium/restricted-to/policy/has-telemetry
│   ├── ModelsColumnMenu.tsx     新：列显隐(localStorage)
│   ├── ModelDetail.tsx          新：详情(tab 分区,见 §5 决策)
│   ├── detail-tabs/*.tsx        新：Overview/Capabilities/LimitsVision/BillingPolicy/Telemetry/RawJson
│   └── UnmatchedTelemetry.tsx   新：未关联遥测小节
├── hooks/
│   └── useModelTelemetry.ts     新：/api/status 遥测(无轮询)
├── lib/
│   ├── model-telemetry.ts       新：parseRequestTelemetry + buildModelTelemetryIndex(纯,port 自 Vue) + unmatched
│   ├── models-csv.ts            新：CSV 序列化(纯,port)
│   └── model-columns.ts         新：列配置默认+合并(纯) — 持久化用既有 localStorage 约定
└── types/status.ts              改：ModelInfo → 收紧/re-export Model
```

**状态归属**（ui-v4 约定：URL-as-truth + 本地瞬态 state）：
- **选中模型**：走 URL（`/models?model=<id>` query，或 `/models/:id` 子路由）——与 `list-store` "选中真值由 URL 承载" 一致，非 Vue 的 v-model drawer。
- **排序/过滤/列配置**：本地 `useState` + `useMemo`（项目无 sort/filter 抽象，自建）；列配置持久化用既有 localStorage 约定。
- **遥测 join**：`useMemo(() => buildModelTelemetryIndex(snapshot, models), [snapshot, models])`。

**复用 util**：`lib/format.ts`（formatNumber/formatDuration/formatUsageTokens）、`lib/export-entry.ts` 的 `triggerDownload`（CSV 下载）、`lib/clipboard.ts` copyText、`shared/Modal`、`detail/CodeBlock`（shiki，Raw JSON 高亮）、`tools/JsonTreeView`（capabilities 树）。

## 5. 详情呈现（待你拍板）

ui-v4 无 Vue 那种右侧 v-model drawer；三个符合约定的选项：

- **A. `shared/Modal` + tab 分区（推荐）**：点行 → 居中 Modal（已有 Esc/backdrop/aria），内用 `DetailSubRail` 式 `SEGMENTS as const` 竖 tab 切 6 分区。最快、复用最多既有原语、最贴"点行看详情"。
- **B. URL 子路由 `/models/:id`**：最贴 ui-v4 "URL-as-truth" 约定（如 `/requests/:id` → `DetailPanel`），可分享/前进后退；但需新路由 + 布局(全页或 split)。
- **C. 右侧 split 面板**：最接近原 Vue drawer 观感，但 ui-v4 无既有 pattern，自建成本最高。

6 分区（同 spec §3/§6，全字段 + 完整 raw supports + Vision 条件块 + 全 6 token）：Overview / Capabilities / Limits+Vision / Billing+Policy / Telemetry / Raw JSON。

## 6. 表格与过滤

- **表格**：密集行（参照 `RequestRow` 的 flex-row 约定或保留 `<table>`）；列 = id/name/vendor/version/ctx/out/effort/[能力矩阵]/$×/req(7d)；表头点击排序；`title=` 原生 tooltip 截断；行选中 `border-l-2 border-l-[var(--color-primary)]`。列显隐由 `ModelsColumnMenu` 控。req(7d) 列来自遥测 join。
- **过滤**（本地 state + useMemo 谓词，纯谓词抽 `lib/` 便于 bun 测）：search（id/name）、vendor、type、capability（多选 AND）、premium、restricted-to（plan 多选）、policy state、has-telemetry。

## 7. CSV + 未关联遥测

- **CSV**：`lib/models-csv.ts`（port Vue 版纯序列化，RFC-4180 转义，遥测列同 join）→ `triggerDownload` 下 `text/csv` Blob。（formula-injection 按 ADR `internal-tool-security-posture` 不处理。）
- **未关联遥测小节**：`buildModelTelemetryIndex` 的 `unmatched`（归一化后无 catalog 匹配的遥测，多为纯别名失败请求）在表下方可见呈现，不静默丢弃（richest-data-flow）。

## 8. 测试（ui-v4 双 runner）

- **纯逻辑 `tests/*.bun.test.ts`（`bun:test`）**：parseRequestTelemetry、buildModelTelemetryIndex（含 key 分裂/date-suffix/unmatched，port 自 Vue 版测试）、过滤谓词、models-csv、列配置合并。
- **组件 `tests/*.vitest.test.tsx`（@testing-library/react + `vi.mock` hook）**：表格渲染/排序/列隐藏/req 列、详情 tab、过滤交互、CSV 按钮、未关联遥测小节。参照既有 `tests/ModelsPage.vitest.test.tsx`。

## 9. Phase 划分

1. **P1 纯逻辑地基**：`lib/model-telemetry.ts`(parse+join+unmatched) + `lib/models-csv.ts` + `lib/model-columns.ts` + 收紧 `ModelInfo`。全 bun 测。**无 UI**。
2. **P2 表格 + 过滤 + 列配置**：`ModelsTable`/`ModelsFilterBar`/`ModelsColumnMenu` + 遥测列 + `useModelTelemetry`。改 `ModelsPage` 编排。
3. **P3 详情**：`ModelDetail` + 6 tab（§5 定的方案）。
4. **P4 CSV + 未关联遥测 + a11y + 文档**：CSV 导出、unmatched 小节、键盘/aria、回填 ui-v4 docs。

每 phase：`bun run typecheck:ui-v4` + **`bun run build:ui-v4`** + `bun run test:ui-v4` 全绿 → 细粒度提交 → phase 末 subagent audit。不自启 dev server。

## 10. 待你拍板

1. **§5 详情呈现**：A（Modal+tab，推荐）/ B（URL 子路由）/ C（右侧 split）？
2. **遥测**：新建 `useModelTelemetry`（无轮询、重访即加载，推荐）还是复用既有 `useStatus`（3s 轮询）？
3. **范围**：全 4 phase 一次做完，还是先 P1+P2（表格/过滤/遥测列）看到真改动再继续？

## 非目标 / 复用既定
- 不改后端（`request_headers` 暴露 + normalize-id 已做）。不引虚拟滚动（项目无）。不引新状态库（zustand/react-query 足够）。类型走 `~backend` re-export，不前端重定义。
