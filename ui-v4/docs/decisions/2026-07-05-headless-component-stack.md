# ADR: ui-v4 采用 headless 组件栈,不采 styled UI kit

- **状态**：**Accepted**（栈方向 + 数据表方案已据双 PoC 实证定稿：数据表选 **TanStack Table**，react-aria 评估后不采纳——见 §「已评估：react-aria」）
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
| 虚拟滚动 | ~~**TanStack Virtual**~~ → **react-virtuoso** | **本行被 [2026-07-06-requests-list-libraries.md](2026-07-06-requests-list-libraries.md) supersede**：长 History 列表的 tail-infinite-locate 三合一改用 react-virtuoso（高阶行为白送）。TanStack Virtual 仅在别处「只读等高无 tail/locate」表触发时再评估。 |
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

## 已评估：react-aria（双 PoC 同口径对照后不采纳）

对抗审查（2026-07-05）正确指出：本 ADR 把范围扩到 Radix 不覆盖的表格/表单/搜索，故前置 ADR 对 react-aria 的拒绝（交互原语语境）不适用，须重评。已做**第二个 PoC**（react-aria Table 重写同一 Models 表格）与 TanStack PoC **同口径对照**——[exp/tanstack-table-poc/react-aria-comparison.md](../../exp/tanstack-table-poc/react-aria-comparison.md)。

**实测对照**（同数据/同断言/同 bundle 测法）：

| | TanStack Table | react-aria |
|---|---|---|
| 安装 / bundle(gzip) | 2 包 / **+13.7kB** | 11 包 / **+55.3kB（4×）** |
| a11y（grid/键盘/aria-sort/行激活） | 手写 | **白送** |
| 排序算法/faceting/grouping/列可见 | **白送** | 手写/无 |
| 单 vendor（combobox/datepicker/virtual） | 无 | **白送** |

**二者恰好互补**（react-aria=a11y 之王、TanStack=数据逻辑之王）。**定夺：数据表选 TanStack Table**，react-aria **不采纳**——理由（据本项目语境，换语境会反转）：
1. 数据表核心价值是**数据操作**（排序/过滤/6 维筛选 faceting）= TanStack 领域;
2. bundle 轻 **4×**（实测，已核实非整包-import 虚高）;
3. a11y 手写模式 P3/P4 已建（**判断**可复用、PoC 未实测）——须承认 react-aria 白送的 **grid role + 方向键网格导航 TanStack 侧确实缺失**，对只读表**有净收益但有限，不抵 4× bundle**;
4. react-aria 的**单-vendor 优势前提已被拆散**——其卖点是"一 vendor 统一 table+combobox+datepicker+virtual"，而本项目 combobox=cmdk、原语=Radix 已拆散该前提;它与 Radix **能共存**（可只做 table），但那样**单-vendor 差异化归零**，退化为纯 table 正面比 → TanStack 轻 4× + 数据逻辑白送胜出;
5. 组合方案（react-aria shell + TanStack 数据）= 两库+复杂度，a11y 收益对只读表不值。

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

> **注**：react-aria 已在 §「已评估：react-aria」经**双 PoC 同口径对照**评估、不采纳（bundle 4× + 单-vendor 优势在已选 Radix 前提下不成立），非未评估。

## 实施

**增量、分领域**，各随对应功能落地时贯彻 headless + Terminal Amber：
- **数据表 = TanStack Table**（双 PoC 对照已定，见上节）→ 正式重写 `ModelsTable`（删手写 `sortModels`/`sort` state/部分 `model-columns`，ColumnMenu 驱动 `VisibilityState`）+ 作 Requests 列表/6 维筛选地基。**同一提交删两个 PoC**（`ModelsTableTanstack.poc.tsx` + `ModelsTableAria.poc.tsx` + 各测试）+ **卸 `react-aria-components`**（PoC 专用，落地不用）；PoC 悬挂期 tripwire（`tests/poc-tripwire.bun.test.ts`）守其未接生产。
  > **✅ 已落地（2026-07-07）**：`ModelsTable` 正式重写为 TanStack（`useReactTable` + `getSortedRowModel` + 受控 `sorting`/`columnVisibility`）；新增共享列定义 `src/components/models/model-table-columns.tsx`（单一 accessor 源，供表格 ColumnDef + CSV 排序两个消费者，保证 CSV 序 = 表格序）；`sortModels`/`ModelSortKey`/`sort` state 已删；两个 PoC + 各测试 + `poc-tripwire.bun.test.ts` + `tests/setup.ts` 的 `CSS.escape` stub 已删；`react-aria-components` 已卸载。bundle 实测 +13.9kB gzip（TanStack Table 接线，符合 PoC 预估 +13.7kB）。
- **react-hook-form + zod**：随 [Config 结构化表单](../plans/2026-07-05-ui-v4-config-form.md) 落地。
- **cmdk**：随全局搜索（TODO.md 退役 gating）落地。
- **TanStack Virtual**：长列表性能触发时引（现非目标）。
- **date-picker**（若 Requests 加时间范围筛选）：~~待定~~ **已定 react-day-picker**（见 [2026-07-06-requests-list-libraries.md](2026-07-06-requests-list-libraries.md) 决策二）。

每次落地：门禁全绿（含 `build:ui-v4` 验 bundle **前后对照进提交信息** + `~backend` 纯）→ 细粒度提交 → subagent audit。
