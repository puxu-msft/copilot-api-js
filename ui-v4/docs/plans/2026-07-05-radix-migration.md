# ui-v4 Radix Primitives 增量迁移 — 实施计划

> **实施状态：进行中**（P0 地基 + P1 Dialog/Tabs 落地 2026-07-05；P2 Menu / P3 splitter+Select 待续）
> **落地**：P0 `b56e7a4`/`cc48e9f`/`cafb4fe`/`3446962`（依赖+jsdom stub+样式桥+golden）· P1 `f135365`（Modal→Dialog）/`88bc9e6`（user-event dev dep）/`b053674`（ModelDetail Tabs）/`a812c65`（DetailPanel Tabs）
> **备注**：装 `radix-ui@1.6.1` + `@testing-library/user-event@14.6.1`（Radix 交互需真实 pointer/focus 序列，jsdom fireEvent.click 不触发；已成迁移测试标准手法）。Modal 迁移证明 build:ui-v4 能打包 radix-ui。Tabs 迁移删净手写 roving/方向键/aria 接线（净减 ~46+ 行 a11y 手写代码）。
> **日期**：2026-07-05
> **决策依据**：[decisions/2026-07-05-adopt-radix-primitives.md](../decisions/2026-07-05-adopt-radix-primitives.md)（WHY / 取舍 / 未采纳方案）
> **kick-off**：[2026-07-05-radix-migration-kickoff.md](2026-07-05-radix-migration-kickoff.md)
> **目标前端**：`ui-v4/`（React 19 + Tailwind 4，跑在 5173）

## 0. 目标与不变量

把 ui-v4 手写的交互 / a11y 原语增量迁移到 **`radix-ui` 统一包**（headless），**保留 Terminal Amber 视觉零变化**、**行为等价、a11y 只增不减**。

**全程 commit invariants（每个 commit 终态成立，中间态绝不半坏）**：

1. **视觉不变**：迁移后组件渲染的视觉与迁移前一致（同一批 CSS 变量 / `.mono` / `rounded:0` class，经 Radix `data-state` 驱动）。
2. **行为等价**：现有 vitest 组件测试（`tests/*.vitest.test.tsx`）作等价 oracle，迁移后**全绿不改断言**（除非断言本身编码了被 Radix 修正的 a11y 缺陷，如"tab 无 roving"——此类须显式升级断言并在 commit 记明）。
3. **a11y 只增不减**：每次替换后 role/aria/键盘可达性 ≥ 迁移前。
4. **每 phase 门禁全绿**：`typecheck:ui-v4` + `build:ui-v4`（真 rollup，验 bundle 增量 + 无越界）+ `test:ui-v4`（bun + vitest）+ `bunx eslint ui-v4/src`（**无缓存**，0 error）。
5. **不自启 dev server**；需实测让用户开 5173 目视核对视觉/交互对等。

## 1. 手写原语 → Radix 映射（范围锚点）

| # | 手写原语 | 文件 | Radix 目标 | Phase |
|---|---|---|---|---|
| 1 | `Modal`（overlay/dialog，无 focus-trap/scroll-lock） | [shared/Modal.tsx](../../src/components/shared/Modal.tsx) | `Dialog` | P1 |
| 2 | `ModelDetailSubRail`（tablist + 手写 roving/箭头） | [models/ModelDetailSubRail.tsx](../../src/components/models/ModelDetailSubRail.tsx) | `Tabs` | P1 |
| 3 | `DetailSubRail`（plain buttons，无 tab 语义） | [detail/DetailSubRail.tsx](../../src/components/detail/DetailSubRail.tsx) | `Tabs` | P1 |
| 4 | `ModelsColumnMenu`（`<details>` 伪菜单） | [models/ModelsColumnMenu.tsx](../../src/components/models/ModelsColumnMenu.tsx) | `DropdownMenu` + `CheckboxItem` | P2 |
| 5 | `ModelsFilterBar` 原生 `<select>` ×N | [models/ModelsFilterBar.tsx](../../src/components/models/ModelsFilterBar.tsx) | `Select`（可选） | P3 |
| 6 | `useResizableWidth` splitter（无键盘） | [hooks/useResizableWidth.ts](../../src/hooks/useResizableWidth.ts) | **保留** + APG 键盘补齐（需扩 hook 出口） | P3 |
| — | `JsonTreeView`（JSON 折叠树） | [tools/JsonTreeView.tsx](../../src/components/tools/JsonTreeView.tsx) | **保留整树**（无 tree primitive） | — |
| — | `DetailTocTree`（TOC 折叠树，缺 `aria-expanded`） | [detail/toc/DetailTocTree.tsx](../../src/components/detail/toc/DetailTocTree.tsx) | **保留整树**；折叠可选补 `Collapsible` | P3（可选） |

> `useResizableWidth` / 两棵树无 Radix 对等件，**整树不强迁**（against-yagni 反向：不为"全用库"硬造需求）。两处 a11y 债对称补齐：splitter 补键盘可操作（箭头调宽 + `aria-valuenow/min/max`，**需扩 `useResizableWidth` 命令式出口**——现仅导出 `clampWidth` + `handleProps.onPointerDown`，无 `setWidth`/`nudge`）；两树折叠 toggle 缺 `aria-expanded`（`DetailTocTree` 现用 `aria-label` 代偿），可选用 `Collapsible` 补 disclosure 语义。

## 2. Phase 0 — 依赖 + 样式桥基座 + golden 预捕获（地基，无行为迁移）

**交付物**：
- `ui-v4/package.json` 增 `radix-ui`（装当前最新稳定，勿凭记忆锁旧版；`bun add radix-ui` 后核对锁定版本）。
- **jsdom stub 扩充（关键地基，不补则 P1 一开工撞墙）**：Radix `Dialog`（focus-scope）/`DropdownMenu`/`Select`（`react-popper`）在 jsdom 下依赖 `ResizeObserver`、`Element.prototype.hasPointerCapture`/`setPointerCapture`/`releasePointerCapture`、`getBoundingClientRect`/`DOMRect`、`scrollTo`——现有 [tests/setup.ts](../../tests/setup.ts) **只 stub 了 `scrollIntoView`**。P0 须补齐这批 stub，并加一个 **Radix `Dialog` smoke test 证明 stub 生效**（正样本证 stub 触达目标，空≠可用）。
- **样式桥约定**：确立 Radix primitive 上承载 Terminal Amber 的模式——`className` 直接给 Radix 组件 + `data-[state=...]` variant 表达 open/active/checked。写一页 `ui-v4/docs/radix-styling.md` 记约定（CSS 变量清单 + `data-state` 用法 + **Portal 容器 & z-index 契约**：现有 Modal `z-50` / ColumnMenu `z-10` / drag-guide `z-50`，Radix Portal 默认挂 body 末尾，需明确层叠 + Dialog 打开时 Menu portal 的层级），供后续 phase 复用。
- **golden 行为预捕获（补齐 oracle 缺口）**：实测覆盖有洞——**`ModelsColumnMenu` / `ModelsFilterBar` / `DetailSubRail` 无独立测试**（仅经 `ModelsPage`/`DetailPanel` 间接覆盖；Modal / ModelDetailSubRail 已有独立测试）。P0 须为这三者 + 迁移目标先补齐行为快照测试，锁住迁移前可观测行为（打开/关闭/切 tab/勾选列/Esc/点外/select 改值），作为 P1+ 的等价 oracle。**改动前锁旧行为**（large-refactor golden-fixture 手法）。

**门禁**：装包后 `build:ui-v4` 绿（确认 radix-ui 能被 rollup 正确打包、无 SSR/CJS 坑）；Radix `Dialog` smoke test 绿（证 jsdom stub 生效）；三个补齐的独立 golden 测试全绿。

## 3. Phase 1 — 试点：Dialog + Tabs（高频、高 a11y 收益）

**3.1 `Modal` → Radix `Dialog`**
- 用 `Dialog.Root/Portal/Overlay/Content/Title/Close` 重写 [Modal.tsx](../../src/components/shared/Modal.tsx) 内部，**保持对外 props 契约不变**（`title?` / `onClose` / `children`）——消费者 [BlockJsonModal](../../src/components/detail/BlockJsonModal.tsx) 零改动。
- 白送：focus-trap、scroll-lock、`aria-modal`、Esc、点 overlay 关闭、focus-restore。移除手写的 keydown/focus 逻辑。
- 视觉：`Overlay` 承 `bg-black/60`、`Content` 承既有 border/surface/max-w class。
- 测试：现有 Modal / BlockJsonModal 测试全绿；**升级断言**新增 focus-trap 正向验证（Tab 循环不逃逸）。

**3.2 `ModelDetailSubRail` + `DetailSubRail` → Radix `Tabs`**
- 用 `Tabs.Root/List/Trigger/Content`（`orientation="vertical"`）替换手写 tablist。**删除手写 roving tabindex + 方向键 handler**（Radix 白送，且自动修正 P4 audit 的 H-1：竖直 orientation 下 Radix 只处理 Up/Down）。
- `ModelDetail` 的 tab↔panel 由 Radix `value` 关联管理，删手写 `aria-labelledby`/`tabId` 接线（Radix 自动生成关联 id）。
- 保留 `SEGMENTS as const` tab 定义与 Terminal Amber `data-[state=active]` 样式。
- 测试：现有 ModelDetail tab 切换 / 箭头导航测试**改为验证 Radix 行为**（roving + 方向键 + Left/Right 不劫持仍成立，但由 Radix 保证）。

**门禁**：全量四门禁绿；用户开 5173 核对 Modal + 两处 tab 视觉/交互对等。

## 4. Phase 2 — `ModelsColumnMenu` → Radix `DropdownMenu`

- `<details>/<summary>` → `DropdownMenu.Root/Trigger/Content` + 列项用 `DropdownMenu.CheckboxItem`（`menuitemcheckbox` 语义）。
- 白送：点外关闭、Esc、键盘 menu 导航（上下箭头 + 字母定位）、focus 管理。
- 保留 Terminal Amber 触发按钮 + 面板 class。Reset 项用普通 `Item`。
- 测试：现有 ColumnMenu 交互测试（勾选显隐列）全绿 + 新增点外关闭 / 键盘导航正向验证。

**门禁**：四门禁绿；5173 核对。

## 5. Phase 3 — Select（可选）+ splitter 键盘补齐

**5.1 `useResizableWidth` splitter 键盘可操作（APG Window Splitter）**
- **先扩 `useResizableWidth` 命令式出口**：现仅导出 `clampWidth` + `handleProps.onPointerDown`，无提交入口。加一个 `nudge(delta)`（或返回 `setWidth` + 复用内部 `persistWidth`）供键盘调宽调用。
- 给 [TocSidebar](../../src/components/detail/toc/TocSidebar.tsx) / [ModelDetail](../../src/components/models/ModelDetail.tsx) 的 `role="separator"` 手柄补 `tabIndex=0` + 箭头键调宽（调 `nudge`）+ `aria-valuenow/valuemin/valuemax`。保留手写（Radix 无 splitter）。
- 测试：新增键盘调宽 + aria-value 断言。

**5.2 `ModelsFilterBar` 原生 `<select>` → Radix `Select`（低优先，视需求）**
- 原生 `<select>` a11y 本已合格，此步纯为视觉统一（Terminal Amber 下拉面板）。**若视觉统一收益不足以抵迁移成本，可留原生**——实施期评估，不强迁（决策记入 plan 状态）。

**门禁**：四门禁绿；5173 核对。

## 6. 分阶段小结

| Phase | 范围 | 阻塞后续? |
|---|---|---|
| P0 | 装 radix-ui + jsdom stub 扩充 + 样式桥 doc + golden 补齐（含 ColumnMenu/FilterBar/DetailSubRail 独立测试） | 是（地基） |
| P1 | Dialog（Modal）+ Tabs（两 SubRail） | 否（试点，验证模式） |
| P2 | DropdownMenu（ColumnMenu） | 否 |
| P3 | splitter 键盘 + Select（可选） | 否 |

每 phase 一或多个细粒度 commit（conventional，显式 pathspec）；phase 末派 subagent audit（裁判轴：行为等价 + a11y 只增不减 + 视觉不变 + 长远正确）。

## 7. 非目标 / 边界

- **不改视觉设计语言**（Terminal Amber 不变；本轮只换行为底座）。
- **不引 shadcn 成品样式组件**（ADR 未采纳方案 2）。
- **不强迁无对等 primitive 的原语**（JsonTreeView 保留；Select 可选）。
- **不改后端 / 不改数据流**（纯前端原语层）。
- 迁移不与其它前端特性工作互斥——增量、可穿插。

## 8. 落地后收尾

- 回填 [DESIGN.md](../DESIGN.md) §2（"shadcn/ui" → "Radix Primitives（radix-ui 统一包）"精化 + 指向本 ADR）、§8（a11y 段注明由 Radix 承载）。
- 更新本 plan 状态注解为"已完成"（或记录 Select 留原生的决策）。
- 提炼教训（手写原语 vs Radix 的 a11y 收益实证）入记忆 / skill。
