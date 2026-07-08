# Spec: ui-v4 模型列表页对齐（达到并超越 Vue `ui/`）

- 日期：2026-07-08
- 状态：draft（待用户复审 → 转 plan）
- 归属：ui-v4 前端子项目；服务「增量淘汰 Vue `ui/`」路线图
- 相关：[docs/DESIGN.md](../DESIGN.md)、姊妹 spec [ui-v4-raw-json-dual-view](2026-07-08-ui-v4-raw-json-dual-view.md)（覆盖本页 Raw 视图回退项）

## 1. 目标与动机（what & why）

对比审计（2026-07-08）确认：ui-v4 模型列表页在交互/遥测呈现层已超越 Vue（URL 深链、requests7d 可排序、CSV 顺序对齐、Unmatched 归一化键、a11y），但在「用户能筛什么、能看什么」上有明确回退。本 spec 补齐这些缺口，使 ui-v4 模型列表页**达到并全面超越 Vue 版**，从而可下线 `/ui` 列表页。

Raw JSON 视图回退项由姊妹 spec 处理，本 spec 不重复。

## 2. 缺口清单与实现（8 项）

数据源 SSOT 优先复用后端，不移植 Vue 侧重复 util。

### 2.1 Endpoint 筛选（缺失）

- 后端已有 SSOT：`getEffectiveEndpoints(model)`（`src/lib/models/endpoint.ts`，返回 `supported_endpoints`，缺省按 `capabilities.type` 推断）。ui-v4 详情 OverviewTab 已 import 它。
- `model-filters.ts`：`ModelFilters` 加 `endpoint: string | null`；`filterModels` 加谓词 `getEffectiveEndpoints(m)?.includes(filters.endpoint)`。
- `ModelsPage.tsx` 的 `options` 加 `endpoints`：`[...new Set(models.flatMap((m) => getEffectiveEndpoints(m) ?? []))].sort()`。
- `ModelsFilterBar.tsx`：加一个 `FilterSelect`（`allLabel="all endpoints"`）。
- **优于 Vue**：复用后端推断逻辑，消除 Vue 前端 `model-endpoints.ts` 的重复实现。

### 2.2 Billing-rate 范围滑块筛选（缺失）

- `model-filters.ts`：`ModelFilters` 加 `billingRange: [number, number] | null`。
- **缺失-multiplier 语义（对齐 Vue oracle）**：Vue（`ui/src/composables/useModelsCatalog.ts:150-152`）把 `typeof m.billing?.multiplier !== "number"` 的模型的 multiplier **当作 0**，再判 `0 >= billingMin && 0 <= billingMax`——即当用户把下界 `billingMin` 抬离 0 时，无 multiplier 的模型**会被排除**。本 spec 采同一语义（缺失当 0），不偏离。
- **初始值与 clamp**：`billingRange` 初始为 `null`（= 不筛，等价于满量程 `[min, max]`）。边界 `[min, max]` 由 `ModelsPage` 跨目录算 `model.billing?.multiplier` 的 min/max。目录变化时对已选 range 做 re-clamp（对齐 Vue `useModelsCatalog.ts:115-129` 的 watch）。plan 阶段定 clamp 实现细节，但 null-初始 + 缺失当 0 两点在此写死。
- `ModelsFilterBar.tsx`：Radix `Slider`（range，双滑块，来自统一 `radix-ui` 包 v1.6.1，无需新依赖），显当前值 + 边界。

### 2.3 错误态渲染（真实缺陷）

- `useModels` 是 `useQuery`，天然有 `isError`/`error`——现 `ModelsPage.tsx:56` 只解构 `{ data, isLoading }`，请求失败会走空分支伪装成「No models match」。
- 解构 `isError`/`error`；在 `isLoading` 分支后加**独立错误分支**（图标 + 错误文案 + 可 retry），与「空结果」区分。对齐 Vue `VModelsPage.vue:174-185`。

### 2.4 Thinking 预算/adaptive 列提示（信息退化）

- `DerivedCapabilities`（`src/lib/models/capabilities.ts:32-46`）已含派生字段 **`thinking`** / **`adaptiveThinking`**（camelCase）/ **`maxThinkingBudget`**（camelCase，0 表无）——`adaptive_thinking`/`max_thinking_budget` 是原始 Copilot supports 键，派生名是 camelCase。详情 CapabilitiesTab 已在读。
- `model-table-columns.tsx` thinking 单元格：现由通用 `CAP_COLS` 循环渲染 ✓/·（`:137-144,226-234`），需把 thinking **从通用循环特判出来**单独定制 cell，派生 `≤N`（`maxThinkingBudget>0`）/`adaptive`（`adaptiveThinking`）文本 + `title` 悬浮。语义超越 Vue（Vue 正文仍 ✓、仅 `:title` 悬浮，`ModelsTable.vue:259-264`）。

### 2.5 active-filter 计数（缺失）

- 计算激活筛选数：标量/布尔/数组维度按「非空/非 null」计（search 非空、vendor/type/endpoint/policyState 非 null、premium/hasTelemetry 非 null、capabilities/restrictedTo 非空数组）。
- **billingRange 维度的 active 判据（对齐 Vue）**：不是「非 null」，而是「**窄于边界**」——`range !== null && (range[0] > min || range[1] < max)`（对齐 Vue `VModelsPage.vue:104`）。避免「初始化为满量程即恒 active」。
- `ModelsFilterBar.tsx`：显「N active」chip（对齐 Vue `ModelsFilterBar.vue:45-50`）+ 「clear all」动作（重置为 `EMPTY_FILTERS`）。**clear-all 是 ui-v4 超越项**（Vue 无此动作）。

### 2.6 空态引导文案（更弱）

- `ModelsPage.tsx` 空分支（`:178-179`）：由单行「No models match the current filters.」增强为含引导（「放宽搜索或清除某个筛选」），对齐 Vue `VModelsPage.vue:191-194`。区分「目录本身为空」与「筛选后为空」。

### 2.7 Vendor 颜色 chip（视觉退化，纳入本轮）

- Vue 有 `vendorColor` 映射（`useModelsCatalog.ts:160-167`）+ chip（`ModelsTable.vue:228-233`）；ui-v4 现纯文本（`model-table-columns.tsx:208-210`）。
- 加一个共享 `vendorColor(vendor)` 工具（前端 `ui-v4/src/lib/`），vendor 单元格渲染带色 chip。颜色映射从 Vue 移植/对齐。

### 2.8 头部 vendors/endpoints 计数（更弱，纳入本轮）

- Vue 头部显「N vendors · M endpoints」（`ModelsToolbar.vue:23-25`）；ui-v4 现只 `visible/total`（`ModelsPage.tsx:142-144`）。
- 头部计数区补 vendors 数 + endpoints 数（复用 §2.1 的 endpoints options + 现 vendors options）。

## 3. 非目标

- 不改后端 `/api/models` 返回形状。
- 不动已达标/已超越的部分（URL 深链、排序、CSV、Unmatched、a11y、列显隐持久化）。
- Raw JSON 视图 → 姊妹 spec。

## 4. 测试

- 单元（bun test，纯函数）：`model-filters.ts` 新增 endpoint/billingRange 谓词、active-filter 计数、`vendorColor` 映射、thinking 派生文案。
- 组件（vitest + @testing-library/react）：ModelsFilterBar 新控件（endpoint select、billing slider、active chip、clear all）、ModelsPage 错误分支 vs 空分支、thinking 列单元格文案、头部计数、vendor chip 着色。
- 遵循 [debugging-frontend-tests](../../.claude/skills/debugging-frontend-tests/SKILL.md)；否定断言先证正向能力。
- `~backend/*` 纯度守卫；交付跑 `bun run build:ui-v4`。

## 5. 验收标准

1. 8 项缺口全部落地，行为对齐或超越 Vue（逐项对照 §2 引用的 Vue file:line）。
2. 请求失败显真实错误态，不再伪装成空结果。
3. Endpoint 筛选复用后端 `getEffectiveEndpoints`（无前端重复 util）。
4. Billing 滑块用 Radix `Slider`，无新依赖。
5. `bun run build:ui-v4` 绿；`bun test`（新增用例）绿；`bunx eslint <改动文件>`（无缓存）绿。
6. 逐项消解**附录 A** 的对比审计「ui-v4 缺失/退化」清单（模型列表页项）。

## 附录 A：2026-07-08 模型列表页对比审计（验收 oracle）

来源：ui-v4 vs Vue `ui/` 模型列表页逐特性对比（2026-07-08）。下表是本 spec 8 项要消解的「ui-v4 缺失/退化」清单，验收 6 逐项复核。等价/已超越项不在此表（URL 深链、requests7d 可排序、CSV 顺序对齐、Unmatched 归一化键、列显隐持久化、a11y 均已达标或超越，不动）。

| 缺口 | Vue 证据 | ui-v4 现状证据 | 本 spec 落点 |
|---|---|---|---|
| Endpoint 筛选缺失 | `ModelsFilterBar.vue:67-73` + `useModelsCatalog.ts:91-95` | `model-filters.ts` 无 endpoint 维度 | §2.1 |
| Billing-rate 滑块缺失 | `ModelsFilterBar.vue:123-137` + `useModelsCatalog.ts:109-129,148-152` | `model-filters.ts` 无 billing 维度 | §2.2 |
| 错误态缺失（伪装成空） | `VModelsPage.vue:174-185` | `ModelsPage.tsx:56,137` 只判 isLoading | §2.3 |
| Thinking 预算/adaptive 退化 | `ModelsTable.vue:103-107,260-264` | `model-table-columns.tsx:226-234` 仅 ✓/· | §2.4 |
| active-filter 计数缺失 | `ModelsFilterBar.vue:45-50` + `VModelsPage.vue:97-110` | 无 | §2.5 |
| 空态引导文案更弱 | `VModelsPage.vue:191-194` | `ModelsPage.tsx:178-179` 仅一行 | §2.6 |
| Vendor 颜色 chip 退化 | `ModelsTable.vue:228-233` + `useModelsCatalog.ts:160-167` | `model-table-columns.tsx:208-210` 纯文本 | §2.7 |
| 头部 vendors/endpoints 计数更弱 | `ModelsToolbar.vue:23-25` | `ModelsPage.tsx:142-144` 仅 visible/total | §2.8 |

Raw JSON 视图退化项（审计亦发现）由姊妹 spec [ui-v4-raw-json-dual-view](2026-07-08-ui-v4-raw-json-dual-view.md) 处理，不在本表。
