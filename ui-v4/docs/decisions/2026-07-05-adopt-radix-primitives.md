# ADR: ui-v4 采用 Radix Primitives 迁移手写交互原语

- **状态**：Accepted（决策已定，实施由 [plans/2026-07-05-radix-migration.md](../plans/2026-07-05-radix-migration.md) 增量驱动）
- **日期**：2026-07-05
- **相关**：[DESIGN.md](../DESIGN.md) §2 技术栈（原选 shadcn/ui）、§8 视觉方向（Terminal Amber）；user-level rule `60-feat-dev-workflow` `battle-tested-over-hand-rolled`、`against-yagni-on-feature`；CLAUDE.md `long-term-wins` / `architecture-health-first`；P3/P4 a11y 实战证据（Models 详情面板）

## 背景

[DESIGN.md](../DESIGN.md) §2 的技术栈表**明确选定** UI 组件层为 **shadcn/ui（Radix Primitives headless + Tailwind，组件 copy-paste 进仓库）**。但截至本 ADR，实现**完全偏离了这一规格**：

- `ui-v4/package.json` **零 `@radix-ui/*`、零 `radix-ui`、零 shadcn**——UI 组件库整个没装。无 `components/ui/`（shadcn 生成物惯例位置）。
- 所有交互 / a11y 原语**全部手写**：
  - **Overlay/Dialog** → [components/shared/Modal.tsx](../../src/components/shared/Modal.tsx)：`createPortal` + `role="dialog"` + 手写 Esc + focus-restore，但**焦点陷阱（focus-trap）与 scroll-lock 明确 "intentionally left out"**（注释自承）。消费者 [BlockJsonModal.tsx](../../src/components/detail/BlockJsonModal.tsx)。
  - **Tabs** → [components/models/ModelDetailSubRail.tsx](../../src/components/models/ModelDetailSubRail.tsx)（`role="tablist"`/`"tab"`，P4 才手补 roving tabindex + 方向键 + tab↔panel 关联）；[components/detail/DetailSubRail.tsx](../../src/components/detail/DetailSubRail.tsx)（plain buttons，连 tab 语义都没有）。
  - **Menu/Disclosure** → [components/models/ModelsColumnMenu.tsx](../../src/components/models/ModelsColumnMenu.tsx)：`<details>/<summary>` 伪菜单——点击外部不关闭、无 `menu`/`menuitemcheckbox` 语义、无键盘 menu 导航。
  - **Select** → [components/models/ModelsFilterBar.tsx](../../src/components/models/ModelsFilterBar.tsx)：多个原生 `<select>`（原生 a11y 尚可，但视觉与工业风不统一、不可深度定制）。
  - **Splitter（resize）** → [hooks/useResizableWidth.ts](../../src/hooks/useResizableWidth.ts) + `role="separator"`（[TocSidebar](../../src/components/detail/toc/TocSidebar.tsx) / [ModelDetail](../../src/components/models/ModelDetail.tsx)）：指针拖拽手写，**无键盘可操作性**（违背 WAI-ARIA Window Splitter APG）。
  - **Tree（两棵手写折叠树）** → [components/tools/JsonTreeView.tsx](../../src/components/tools/JsonTreeView.tsx)（JSON 折叠树，`▾/▸`）+ [components/detail/toc/DetailTocTree.tsx](../../src/components/detail/toc/DetailTocTree.tsx)（TOC 折叠树，`+/−` + `collapsed` Set，**折叠 toggle 只有 `aria-label="expand/collapse"`、缺 `aria-expanded`**）。

### 为何这是债，而非深思熟虑的"不用组件库"

手写不是一个被记录、被论证的决策——它是规格落地时的**静默偏离**。其代价在 P3/P4 的 Models 详情面板上直接兑现：

1. **反复重造 + 反复踩 a11y 坑。** 手写 WAI-ARIA Tabs 需自行实现 roving tabindex + 方向键 + Home/End + tab↔panel 关联；P4 手补时首版还误让竖直 tablist 劫持 Left/Right（H-1），经 a11y-architect audit 挑出后才修正（`ModelDetailSubRail.tsx:36` 现已不劫持）。**手补易漏、需 audit 兜底；Radix `Tabs` 白送这一切、且久经生产考验、竖直 orientation 天然不处理 Left/Right。**
2. **关键 a11y 能力缺失。** Modal 无 focus-trap / scroll-lock（Radix `Dialog` 白送）；resize 手柄键盘不可操作（APG Splitter 要求）；ColumnMenu 点外不关、无 menu 语义（Radix `DropdownMenu` 白送）。
3. **每个新交互都从零手补 a11y。** 这与 user-level 规则 `battle-tested-over-hand-rolled` 直接冲突——这些原语**边界清晰、可独立装载、有活跃维护、行为一致**，正是该用成熟包而非手搓的典型场景。

### 视觉不是手搓的理由

一个常见的事后合理化是"Terminal Amber 工业风太特殊，组件库套不进"。**这不成立**：

- Radix Primitives 是 **headless（零样式）**——只提供行为 + a11y + 键盘 + 焦点管理，视觉完全由使用者的 Tailwind class 决定。
- 现有手写组件本就是"手写行为 + Terminal Amber Tailwind class"。迁移 = **把手写的 role/键盘/focus 逻辑换成 Radix primitive，保留同一批 Tailwind class**。视觉零变化。
- 规格作者选 shadcn/ui 正是看中这一点（Radix + 自有 Tailwind 样式）。

## 定夺

**ui-v4 采用 Radix Primitives 作为交互原语基座，增量迁移全部手写原语；保留 Terminal Amber Tailwind 视觉体系不变。**

具体形态（对规格 §2 "shadcn/ui" 的精化）：

- **依赖**：装 **`radix-ui` 统一包（当前最新 `1.6.1`，单包 import 全部 primitives，peer React 16.8–19，ESM+CJS+types）**，而非分散的 `@radix-ui/react-*` 包，也**不引整套 shadcn/ui CLI 成品组件**（理由见"未采纳方案"）。
- **样式桥**：以 Radix 的 `data-state`/`data-orientation` 等属性 + 现有 CSS 变量（`--color-primary/muted/border/surface/ok/fail`）+ `.mono` + `rounded:0` 承载视觉，不引入 shadcn 的默认圆角/阴影 token。
- **迁移映射**：
  | 手写原语 | Radix 目标 | 白送能力 |
  |---|---|---|
  | `Modal` | `Dialog` | focus-trap + scroll-lock + Esc + `aria-modal` + portal |
  | `ModelDetailSubRail` / `DetailSubRail` | `Tabs` | roving tabindex + 方向键 + orientation + tab↔panel 关联 |
  | `ModelsColumnMenu`（`<details>`） | `DropdownMenu` + `CheckboxItem` | 点外关闭 + 键盘 menu 导航 + `menuitemcheckbox` 语义 |
  | `ModelsFilterBar` 原生 `<select>` | `Select`（**可选**，末期） | 视觉统一 + 键盘/类型提前定位（原生 a11y 本已 OK，故低优先） |
  | `useResizableWidth` splitter | **保留**（Radix 无 splitter） | 但按 APG **补键盘可操作**（箭头调宽 + `aria-valuenow`；需扩 hook 命令式出口，见 plan P3） |
  | `JsonTreeView` + `DetailTocTree` | **保留整树**（Radix 无 tree primitive） | 但两树的**折叠 disclosure 子行为**可选用 Radix `Collapsible` 补 `aria-expanded`（当前缺失，记为已知 a11y 债，见后果） |
- **增量、行为等价、视觉不变**：逐个原语替换，现有 vitest 组件测试 + golden 行为快照作等价 oracle；每次替换 a11y **只增不减**。详细分阶段见 plan。

## 后果

**正面**：a11y 债系统性清偿（focus-trap / 键盘 menu / tabs APG 一次到位）；停止逐个手补 a11y；行为向久经考验的 primitive 收敛；与规格 §2 重新对齐。

**负面 / 成本（如实记录，不用于降级决策）**：

- **依赖增加**：`radix-ui` 单包。Radix 支持树摇（tree-shaking），只有实际 import 的 primitive 进 bundle；bundle 增量在每 phase 用 `build:ui-v4` 实测把关。
- **迁移风险**：替换交互原语可能引入回归。缓解：增量（一次一原语）+ 现有测试为 oracle + golden 行为预捕获 + 每 phase 全量 typecheck/build/test/eslint 门禁。
- **样式桥一次性成本**：需把手写组件的条件 class 迁到 Radix `data-state` 驱动。可控且一次性。
- **`useResizableWidth` / `JsonTreeView` / `DetailTocTree` 无对等 primitive**：整体保留手写，不强迁（against-yagni 的反面——不为"全都用库"而硬造需求）。但两处 a11y 债显式留档、按对称原则补齐：splitter 补键盘可操作性（APG）；两棵树的折叠 toggle 缺 `aria-expanded`（`DetailTocTree` 现用 `aria-label="expand/collapse"` 代偿），可选用 Radix `Collapsible` 补正确 disclosure 语义。属"部分可迁"，非"无对等 → 全不动"。

## 未采纳的方案（record-not-adopted）

1. **继续手搓** —— 否。反复重造 + 反复踩 a11y 坑（P3/P4 实证），违背 `battle-tested-over-hand-rolled`；a11y 正确性无法靠逐次手补收敛。
2. **引整套 shadcn/ui CLI（带样式的成品组件）** —— 否。shadcn 成品组件自带一套默认视觉（圆角 `rounded-md`、阴影、间距 token），与 Terminal Amber 工业风（`rounded:0` / 高密度 / amber / mono）冲突，落地需**大量覆写**，反而比"Radix 裸 primitive + 自有 class"更重。取 shadcn 的底座（Radix）、弃其成品样式。规格 §2 的 "shadcn/ui" 措辞据此精化为 "Radix Primitives"。
3. **react-aria / Headless UI / Ariakit** —— 否。Radix 是规格既定基座、生态最广、与 shadcn 同源（未来若要 copy 某个 shadcn 组件可直接对接）；无理由横向换栈。
4. **一次性大爆炸重写全部原语** —— 否。增量迁移风险可控、可逐 phase 门禁验证、不阻塞其它前端工作；大爆炸重写违背 commit-invariants（中间态绝不半坏）。
