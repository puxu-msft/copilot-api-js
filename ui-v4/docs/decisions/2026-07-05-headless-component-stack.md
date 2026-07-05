# ADR: ui-v4 采用 headless 组件栈,不采 styled UI kit

- **状态**：**Proposed**（方向定：headless + 视觉自控 > styled kit;但**四库栈 vs react-aria 的具体选型待评估**，见 §「待评估的强替代」——对抗审查 2026-07-05 指出四库栈锁定前未在表格/表单/搜索**扩展语境**下评估 react-aria）
- **日期**：2026-07-05
- **相关**：[decisions/2026-07-05-adopt-radix-primitives.md](2026-07-05-adopt-radix-primitives.md)（前置 ADR，在**交互原语**语境拒 react-aria——该理由在本 ADR 的**表格/表单/搜索**新语境**不适用**）、PoC 实证 [exp/tanstack-table-poc/conclusion.md](../../exp/tanstack-table-poc/conclusion.md)、[DESIGN.md §2](../DESIGN.md)；user-rule `battle-tested-over-hand-rolled`

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
- **排序逻辑净删 ~30 行**（`sortModels` 的 key-switch 被 `getSortedRowModel`+accessorFn 取代）+ 列可见性归 `VisibilityState`;**渲染层/列配置平移非净删**（headless 代价）。多列/faceting/grouping 是库能力，**PoC 未验**。
- 派生列（能力矩阵）+ join 列（遥测）用 `accessorFn`——**渲染已验**，排序未在 PoC 断言。
- **视觉自控**：headless 无自带样式 → 与工业风零冲突（**库性质保证；PoC 未做视觉回归断言**）。
- **bundle**：**单库、一次性手测、已还原** +13.7kB gzip;**四库全栈增量未测**。typecheck/build/eslint/test 全绿;`~backend` 对 `client.ts` **仅 type-only import**（运行时擦除，client.ts 本身非纯、import `~/lib/state`，前端永不可 value-import），故 rollup 图纯。

> PoC 只证 **TanStack Table 一个库可行**,不证四库栈是最优——尤其未对比 react-aria（见下）。

## 待评估的强替代：react-aria（对抗审查 2026-07-05 指出的真漏，定稿前必评）

前置 Radix ADR 在**交互原语**语境拒了 react-aria（"Radix 是既定基座、与 shadcn 同源"）。但本 ADR 把范围扩到 **表格/表单/搜索——Radix 不在场的领域**，那些拒绝理由**全部失效**。react-aria（Adobe，`react-aria-components`）作为**单一 vendor**覆盖本栈拼装的多领域：

| 领域 | 四库栈 | react-aria |
|---|---|---|
| 表格 a11y/交互 | 自写（PoC 手写 `ariaSortAttr`/keyboard grid） | `Table`/`useTable` **白送** grid role + 键盘网格导航 |
| 表格**数据逻辑**（排序/过滤/faceting/grouping/分页） | **TanStack Table**（强项） | react-stately 仅基础 sort，**无 faceting/grouping**——**非对手** |
| combobox/搜索 | cmdk | `ComboBox`/`useSearchField` |
| 虚拟列表 | TanStack Virtual | `Virtualizer` |
| 日期选择 | （缺，需再引第五库） | `useDatePicker`/`Calendar` **白送** |

**关键 nuance**：react-aria 与 TanStack Table **部分互补非纯替代**——react-aria 白送表格 **a11y/交互 shell**，但 TanStack 的**数据操作引擎**（faceting/grouping/复杂 sort）react-aria 没有。所以真正的选项其实有三：**(1)** TanStack Table + 手写 a11y（PoC 现状）;**(2)** react-aria Table（a11y 白送）+ 自写数据逻辑或 react-stately;**(3)** react-aria a11y shell + TanStack Table 数据逻辑组合。

**待办（定稿前）**：在扩展语境正面对比 (1)/(2)/(3)——a11y 白送程度、数据逻辑能力、react-aria render-props/data-attr 样式桥与 Terminal Amber 契合度、单 vendor vs 多库维护面、全栈 bundle。**建议再做一个 react-aria Table PoC** 与 TanStack PoC 对照,再据实证在本 ADR 定稿"数据表方案"。在此之前四库栈是**倾向非锁定**。

## 后果

**正面**：各领域领域标准 + 视觉自控（与工业风零冲突）+ 删手写重造（排序/列/校验/搜索）+ a11y/键盘/焦点白送（Radix）+ 表格能力白送（TanStack）。与 `battle-tested-over-hand-rolled` 对齐。

**负面/成本（如实记录）**：
- 多个库，但**全是 headless、tree-shakeable**，只按需引入实际用的（Virtual/rhf/cmdk 不用不装）；bundle 增量逐库 `build:ui-v4` 实测把关。
- 学习曲线（TanStack Table/rhf 各有 API 面）+ 多库版本维护。
- 每库仍需自写 Terminal Amber 渲染层（headless 的代价 = 视觉自控的收益，同一枚硬币）。

## 未采纳的方案（record-not-adopted）

1. **Styled UI Kit（MUI / Ant Design / Mantine / Chakra）** —— 否。它们**技术上都有 theming API**（MUI `createTheme`、Mantine CSS 变量、Ant `ConfigProvider` design token），把 Terminal Amber 做成主题**可行**;拒绝理由不是"套不进",而是本项目视觉是**逐 token 全反默认**的极端定制（rounded:0 / 高密度 / mono / amber，与 Material/企业默认差距极大），覆写面广、持续对抗，**headless 自渲染的成本更低**。这与拒绝 shadcn 成品样式（Radix ADR）同判断。补记：**Mantine 的 `@mantine/hooks` 仅 utility hooks**、不含表格/表单的完整 headless 逻辑，故不构成栈替代。
2. **继续手写数据表 / 表单 / 搜索** —— 否。Models P3/P4 手写排序/列 + a11y 逐个手补已实证「反复重造 + 踩坑」。
3. **AG Grid（专业数据表格）** —— 否。重、自带视觉、商业授权、远超需求。
4. **全套 shadcn/ui CLI（带样式成品组件）** —— 否（同 Radix ADR）：取底座、弃成品样式。

> **注**：react-aria **不在**未采纳之列——它是**待评估的强替代**（见上节），尚未有拒绝理由。

## 实施

**增量、分领域**，各随对应功能落地时贯彻 headless + Terminal Amber：
- **先定数据表方案**（TanStack Table vs react-aria，见上节，建议 react-aria PoC 对照）→ 正式重写 `ModelsTable`（删手写 `sortModels`/`sort` state/部分 `model-columns`，ColumnMenu 驱动 `VisibilityState`）+ 作 Requests 列表/6 维筛选地基。**同一提交删除 PoC** `.poc.tsx` + `.poc.vitest.test.tsx`（否则是"未接路由组件 + 续命测试"死代码，项目 knip 假阴性活体）；此前在 `docs/todo/deferred-backlog.md` 登记 PoC 悬挂 + tripwire。
- **react-hook-form + zod**：随 [Config 结构化表单](../../../docs/plan/2026-07-05-ui-v4-config-form.md) 落地。
- **cmdk**：随全局搜索（TODO.md 退役 gating）落地。
- **TanStack Virtual**：长列表性能触发时引（现非目标）。
- **date-picker**（若 Requests 加时间范围筛选）：待定——Radix 无，届时评估 react-aria `useDatePicker` / react-day-picker（又一处 react-aria 白送而四库栈缺的领域）。

每次落地：门禁全绿（含 `build:ui-v4` 验 bundle **前后对照进提交信息** + `~backend` 纯）→ 细粒度提交 → subagent audit。
