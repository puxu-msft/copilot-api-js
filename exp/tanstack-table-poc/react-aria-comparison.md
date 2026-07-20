# PoC 对照：TanStack Table vs react-aria（数据表方案）

> 日期：2026-07-05 · 为 [headless 组件栈 ADR](../../ui-v4/docs/decisions/2026-07-05-headless-component-stack.md) 定稿"数据表方案"提供**同口径实证**。
> 两个 PoC 各重写同一 Models 表格（排序 + 列可见 + 派生/join 列 + Terminal Amber），同数据、同断言口径、同 bundle 测法：
> - TanStack：[ModelsTableTanstack.poc.tsx](../../ui-v4/src/components/models/ModelsTableTanstack.poc.tsx) + [测试](../../ui-v4/tests/ModelsTableTanstack.poc.vitest.test.tsx)（3/3）
> - react-aria：[ModelsTableAria.poc.tsx](../../ui-v4/src/components/models/ModelsTableAria.poc.tsx) + [测试](../../ui-v4/tests/ModelsTableAria.poc.vitest.test.tsx)（3/3）

## 同口径实测对照

| 维度 | TanStack Table (v8) | react-aria (react-aria-components) |
|---|---|---|
| 安装包数 | **2** | **11**（拉 @react-aria/@react-stately/@internationalized） |
| **bundle delta（gzip，实测临时接线）** | **+13.7kB**（224.5→238.2） | **+55.3kB**（224.5→279.8）——**~4×** |
| **a11y**（grid role / 键盘网格导航 / aria-sort / 行 Enter 激活） | **手写**（PoC 写了 `ariaSortAttr`/`sortArrow` + id `<button>`） | **白送**（`Table`=完整 grid、`aria-sort`、`onRowAction` Enter 激活） |
| **排序数据逻辑**（comparator/算法） | **白送**（`getSortedRowModel` + accessorFn） | **手写**（PoC 写了 ~8 行 comparator） |
| 排序智能默认 | **数值 desc-first 白送** | 无（默认 asc-first，要自定制） |
| **列可见性** | **白送**（`VisibilityState`） | **手写**（自 filter 列表，PoC 证实无内建） |
| faceting / grouping / 分页 | **白送**（本 PoC 未用，零成本可开） | 非其领域（无） |
| **单 vendor 覆盖** combobox/datepicker/virtual | 无（需 cmdk + TanStack Virtual + 第三方 datepicker） | **白送**（同一 vendor 全含） |
| jsdom 测试 stub | 无需额外（Radix 的 stub 已够） | **需 `CSS.escape` stub**（已加 setup.ts） |
| 视觉自控（Terminal Amber） | ✅ headless | ✅ headless（render props / data-attr） |

> **bundle 测法与公平性**（终审补）：两侧**同法**——各临时接进 ModelsPage 跑真 rollup build 量 index chunk gzip delta，**均为一次性手测快照、非门禁**（落地时每库须留可复现前后对照）。react-aria 侧用**命名 import**（`{ Table, Column, Row, Cell, ... }`，非整包）；`react-aria-components` 有 `sideEffects:["*.css"]` + ESM `module` 入口 → Vite 生产 tree-shaking 生效，未引用组件（Button/ComboBox/DatePicker…）不进 bundle。故 55.3kB **不是"整包 import 虚高"**，而是 `Table` 深依赖（react-stately collection/selection + react-aria interaction/keyboard + @internationalized collator）的真实下限——子路径 import 至多省个位数 kB，**动不了 4× 数量级**。

## 权衡本质（两者恰好互补）

- **TanStack Table = 数据逻辑之王**：排序算法/过滤/faceting/grouping/列可见性全白送、轻（+13.7kB）；但 a11y 要自写。
- **react-aria = a11y 之王 + 单 vendor**：grid/键盘/aria/行激活全白送、且单包覆盖 combobox/datepicker/virtual；但重 4×（+55.3kB）、数据逻辑要自写、jsdom 测试更重。

## 结论：数据表选 **TanStack Table**（据本项目语境）

1. **数据表的核心价值是数据操作**（排序/过滤，尤其未来 Requests **6 维筛选的 faceting**）——正是 TanStack 领域；react-aria 这块要自写。
2. **bundle 轻 4×**——react-aria +55kB gzip 为一个表格，对内部工具偏重。
3. **a11y 自写模式已建（判断非实测）**：P3/P4 已手写过 ModelsTable 的 `<th>` scope/排序 button/aria-sort，**判断**可低成本复用（PoC 未实测复用性）；须**如实承认**：react-aria 白送的 **grid role + 方向键网格导航 TanStack 侧确实缺失**，其对只读表 a11y **有净收益但有限**——不足以抵 4× bundle（成本/收益判断，非"零价值"）。
4. **react-aria 的"单 vendor"优势前提已被拆散**：其卖点是"一个 vendor 统一 table+combobox+datepicker+virtual"。本项目 combobox=cmdk、交互原语=Radix（已全迁）**已拆散该前提**;react-aria 与 Radix 技术上**能共存**（可只用它做 table），但那样它**唯一的差异化（单 vendor）归零**，退化为纯 table 正面比——那一比 TanStack **轻 4× + 数据逻辑白送**胜出。
5. **组合方案**（react-aria a11y shell + TanStack 数据）= 两库 + 复杂度，a11y 收益对只读表**不值**——排除。

> 换个语境结论会反转：若本项目**尚未选交互原语层**、或数据表需要**重度网格键盘编辑/行选择**、或想**单 vendor 统一** combobox/datepicker/virtual/table，则 react-aria 更优。本项目三条都不成立，故选 TanStack Table。

## 落地
数据表方案 = **TanStack Table**。正式重写 `ModelsTable` 时删两个 PoC（`ModelsTableTanstack.poc.tsx` / `ModelsTableAria.poc.tsx` + 各自测试）+ 卸 `react-aria-components` 依赖（PoC 专用，落地不用）。tripwire 守两个 PoC 未接生产。
