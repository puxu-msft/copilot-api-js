# PoC 结论：TanStack Table 替换 Models 手写表格

> 日期：2026-07-05 · 状态：**成功（可行 + 有实证收益）**
> 目的：为 [headless 组件栈 ADR](../../ui-v4/docs/decisions/2026-07-05-headless-component-stack.md) 提供实证——验证 **TanStack Table (v8)** 能否替掉 ui-v4 Models 表格里手写的排序 + 列可见性,并保持 Terminal Amber 定制视觉。
> PoC 代码（保留,受构建/测试保护,未接生产路由）：
> - 组件 [ui-v4/src/components/models/ModelsTableTanstack.poc.tsx](../../ui-v4/src/components/models/ModelsTableTanstack.poc.tsx)
> - 测试 [ui-v4/tests/ModelsTableTanstack.poc.vitest.test.tsx](../../ui-v4/tests/ModelsTableTanstack.poc.vitest.test.tsx)

## 验证结论（全部实测)

| 维度 | 手写现状 | TanStack Table | 结论 |
|---|---|---|---|
| **排序** | `model-filters.ts` `sortModels`（~30 行按 key 分支）+ ModelsPage `sort` state/`onSort`（~8 行）+ ModelsTable `caret`/`sortable`/`sortKey/sortDesc/onSort` props（~15 行） | `getSortedRowModel()` + `onSortingChange` + 每列 accessorFn;**智能默认**（数值列 desc-first、字符串 asc-first,实测）;多列排序/自定义 sortingFn 白送 | ✅ 删 ~50 行手写 plumbing,能力反增 |
| **列可见性** | `model-columns.ts`（MODEL_COLUMNS + DEFAULT + merge，~50 行）+ ModelsPage toggle/persist + ModelsColumnMenu 驱动 | TanStack `VisibilityState`（`Record<string,boolean>`）内建;菜单只改 state | ✅ 逻辑归库,菜单/持久化仍自控 |
| **派生列**（能力矩阵 ctx/out/caps） | ModelsTable 手写 `capsById` + 逐单元格渲染 | `accessorFn: r => r.caps.vision` —— TanStack **正确排序派生值**,零额外代码 | ✅ |
| **join 列**（Req 7d 遥测） | 手写 `telemetryFor(id).last7d.requestCount` 单元格 | `accessorFn: r => r.req`（数据预增广 caps+req 一次）—— 可排序 | ✅ |
| **视觉（Terminal Amber）** | 手写 `<table>` + tokens | **100% 自控**——TanStack headless,只给逻辑,我渲染同一 `<table>`/class/`data-*` | ✅ 零 styled-kit 视觉冲突 |
| **a11y** | 我 P3/P4 手补 `<th>` scope + 排序 button + aria-sort | 同样自渲染,`getToggleSortingHandler` + `getIsSorted()`→aria-sort;键盘可达 button 保留 | ✅ 平齐 |
| **bundle** | — | **实测 +13.7kB gzip**（index 224.5→238.2kB;raw 707→757kB），tree-shakeable（只含 import 的 row models） | ✅ 可接受 |
| **兼容** | — | `typecheck`/`build`/`eslint`/`test` 全绿;`~backend` 仅纯模块（deriveCapabilities/Model type） | ✅ |

## 关键实证细节
- **测试 3/3 绿**：派生+join 列渲染;点表头排序（数值 desc-first 智能默认 → asc）;隐藏列不渲染。
- **视觉自控是核心**：TanStack Table 是 headless（无任何自带样式）,与本项目 rounded:0/amber/mono 工业风零冲突——这正是"定制视觉项目该用 headless 逻辑库、不用 styled UI kit"的实证。
- **代码净减 + 能力净增**：删 ~80 行手写排序/列 plumbing,同时白送多列排序、自定义 sortingFn、faceting、grouping、分页等（本轮未用,但零成本可开）。
- **bundle 实测**：临时把 PoC 接进 ModelsPage build,量得 +13.7kB gzip,随即还原（ModelsPage 未改动)。

## 落地路径（非本 PoC 范围,ADR 记录）
PoC 成功 → 落地时用 TanStack Table 正式重写 `ModelsTable`（删手写 `sortModels`/`sort` state/`model-columns` 部分逻辑,ModelsColumnMenu 改驱动 `VisibilityState`),并作为 **Requests 列表 + 未来 6 维筛选** 的数据表地基。PoC 组件（`.poc.tsx`）在落地时删除或转正。

## 一句话
**成功。** TanStack Table 可行、有实证收益（删 ~80 行手写 + 能力反增 + 视觉零冲突 + 仅 +13.7kB gzip），是"手写数据表 → 领域最强 headless"的典型升级,给 headless 组件栈 ADR 背书。
