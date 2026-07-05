# ADR: ui-v4 采用 headless 组件栈(Radix + TanStack + rhf + cmdk),不采 styled UI kit

- **状态**：Accepted（方向已定，PoC 实证背书；增量落地）
- **日期**：2026-07-05
- **相关**：[decisions/2026-07-05-adopt-radix-primitives.md](2026-07-05-adopt-radix-primitives.md)（本 ADR 升级/扩展它——从"交互原语"扩到"完整组件能力栈"）、PoC 实证 [exp/tanstack-table-poc/conclusion.md](../../exp/tanstack-table-poc/conclusion.md)、[DESIGN.md §2](../DESIGN.md)（技术栈）；user-rule `60-feat-dev-workflow` `battle-tested-over-hand-rolled`

## 背景

Radix 迁移（P0–P3）解决了**交互原语**（Dialog/Tabs/Menu/Select/Collapsible）。但"引入强大的 React 组件库"的本意**远不止行为原语**——还需**数据表格、表单、虚拟列表、命令面板**等重能力。Radix Primitives **不含**这些（它是 headless 行为原语库，无 Table/Form/VirtualList/Command）。

实现现状暴露的缺口：
- **Models 表格**手写了排序（`sortModels` + `sortKey/sortDesc/onSort` plumbing）+ 列可见性（`model-columns` 逻辑）——这些是数据表格库的领域。
- **Config 表单**（spec 待实施）手写 dirty tracking / 校验接线——表单库的领域。
- **Requests 6 维筛选** + **全局全文搜索**（TODO.md 退役 gating 缺口，未建）——需 Combobox/命令面板。

问题：是引入一个**功能全的组件库**，还是继续手写 + 只用 Radix？关键分岔在**视觉体系**。

## 定夺

**ui-v4 采用「headless 逻辑库栈」——各领域最强的 headless 库拼装，视觉 100% 自控（Terminal Amber）；不采用自带视觉的 styled UI kit。**

栈构成：

| 领域 | 库 | 状态 |
|---|---|---|
| 交互原语 | **Radix Primitives** | 已迁（Radix ADR） |
| **数据表格** | **TanStack Table (v8)** | **PoC 实证**（见下）；落地替 Models 表格 + Requests/筛选地基 |
| 虚拟滚动 | **TanStack Virtual** | 按需（DESIGN §1 现列非目标；长 History 列表触发时引） |
| 表单 | **react-hook-form + zod resolver** | 随 Config 表单落地 |
| 命令面板/搜索 | **cmdk** | 随全局搜索落地 |

这**正是 shadcn/ui 生态的构成**（shadcn DataTable=Radix+TanStack Table、Form=Radix+rhf、Command=cmdk）——DESIGN §2 选 shadcn/ui 时**本就隐含此栈**，只是初期连 Radix 都没落地。本 ADR 把它显式化 + 去 shadcn 成品样式。

### PoC 实证（TanStack Table，2026-07-05）
[exp/tanstack-table-poc/conclusion.md](../../exp/tanstack-table-poc/conclusion.md) 用 TanStack Table 重写 Models 表格（[.poc.tsx](../../src/components/models/ModelsTableTanstack.poc.tsx) + 测试 3/3 绿）实测：
- **删 ~80 行手写排序/列 plumbing**，能力**反增**（多列排序、自定义 sortingFn、faceting、grouping 白送）。
- 派生列（能力矩阵）+ join 列（遥测）用 `accessorFn` 正确排序，零额外代码。
- **视觉 100% 自控**（headless → 自渲染 Terminal Amber `<table>`），零冲突。
- **bundle 实测 +13.7kB gzip**（tree-shakeable），typecheck/build/eslint/test 全绿，`~backend` 仅纯模块。

## 后果

**正面**：各领域领域标准 + 视觉自控（与工业风零冲突）+ 删手写重造（排序/列/校验/搜索）+ a11y/键盘/焦点白送（Radix）+ 表格能力白送（TanStack）。与 `battle-tested-over-hand-rolled` 对齐。

**负面/成本（如实记录）**：
- 多个库，但**全是 headless、tree-shakeable**，只按需引入实际用的（Virtual/rhf/cmdk 不用不装）；bundle 增量逐库 `build:ui-v4` 实测把关。
- 学习曲线（TanStack Table/rhf 各有 API 面）+ 多库版本维护。
- 每库仍需自写 Terminal Amber 渲染层（headless 的代价 = 视觉自控的收益，同一枚硬币）。

## 未采纳的方案（record-not-adopted）

1. **Styled UI Kit（MUI / Ant Design / Mantine / Chakra）** —— 否。功能虽全，但**每个自带一套 Material/企业级视觉体系**，与本项目 Terminal Amber 工业风（rounded:0 / 高密度 / mono / amber）冲突，套用需持续覆写默认样式、破坏视觉一致性。这与拒绝 shadcn 成品样式（Radix ADR）、拒绝给 native `title` 套 Radix 是**同一判断**：定制视觉项目里，styled kit 的"全"换来样式对抗，得不偿失。**headless 逻辑 + 自控视觉**才是正解。
2. **继续手写数据表 / 表单 / 搜索** —— 否。Models P3/P4 手写排序/列配置 + a11y 逐个手补已实证「反复重造 + 踩坑」；表单/搜索会重蹈。
3. **AG Grid（专业数据表格）** —— 否。重、自带视觉、商业授权、远超需求；TanStack Table headless + 自渲染已足够。
4. **全套 shadcn/ui CLI（带样式成品组件）** —— 否（同 Radix ADR）：取其底座栈（Radix + TanStack + rhf + cmdk），弃其成品样式。

## 实施

**增量、分领域**，各随对应功能落地时贯彻 headless + Terminal Amber：
- **优先 TanStack Table**（PoC 已过）：正式重写 `ModelsTable`（删手写 `sortModels`/`sort` state/部分 `model-columns` 逻辑，ColumnMenu 驱动 `VisibilityState`），并作 Requests 列表 + 6 维筛选的数据表地基。
- **react-hook-form + zod**：随 [Config 结构化表单](../../../docs/plan/2026-07-05-ui-v4-config-form.md) 落地（其 spec 手写的 dirty/校验可接 rhf 地基）。
- **cmdk**：随全局搜索（TODO.md 退役 gating）落地。
- **TanStack Virtual**：长列表性能触发时引（现非目标）。

每次落地：门禁全绿（含 `build:ui-v4` 验 bundle + `~backend` 纯）→ 细粒度提交 → subagent audit。
