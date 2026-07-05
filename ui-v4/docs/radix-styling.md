# Radix Primitives 样式桥约定（ui-v4）

> Radix Primitives 迁移的样式承载约定。决策见 [decisions/2026-07-05-adopt-radix-primitives.md](decisions/2026-07-05-adopt-radix-primitives.md)，迁移计划见 [plans/2026-07-05-radix-migration.md](plans/2026-07-05-radix-migration.md)。

Radix Primitives 是 **headless（零样式）**——只提供行为 + a11y + 键盘 + 焦点管理。视觉全部由我们的 Tailwind class + CSS 变量决定。本文定约定，让迁移后组件与手写版**视觉零差异**。

## 1. 视觉 token（Terminal Amber，保持不变）

Radix 组件上直接给 `className`，用既有 CSS 变量与工业风约定，**不引 shadcn 的圆角/阴影 token**：

| token | 用途 |
|---|---|
| `var(--color-primary)` / `--color-muted` / `--color-border` | amber 主色 / 次要文字 / hairline 边框 |
| `var(--color-surface)` / `--color-bg` | 面板 / 背景 |
| `var(--color-ok)` / `--color-fail` | green / red 信号 |
| `.mono` | IBM Plex Mono 数据字体 |
| 锐角 | 一律 `rounded:0`（不用 `rounded-md`） |

## 2. 状态样式走 `data-state`（而非手写条件 class）

Radix 在组件上暴露 `data-state` / `data-orientation` / `data-highlighted` 等属性，用 Tailwind 的 `data-[...]` variant 表达，替代手写的 `active ? classA : classB`：

| primitive | 属性 | 例 |
|---|---|---|
| `Tabs.Trigger` | `data-state="active"\|"inactive"` | `data-[state=active]:bg-[#3a2f1a] data-[state=active]:text-[var(--color-primary)]` |
| `Dialog` / `DropdownMenu` | `data-state="open"\|"closed"` | 过渡/可见性 |
| `DropdownMenu.CheckboxItem` | `data-state="checked"\|"unchecked"` | 勾选态 |
| `Tabs.List` | `data-orientation="vertical"` | 竖直排布 |
| menu item | `data-highlighted`（键盘/悬停高亮） | `data-[highlighted]:bg-[#3a2f1a]` |

**迁移手法**：把手写组件里 `${active === x ? "…" : "…"}` 的条件 class 拆成静态 class + `data-[state=…]:…` variant，挂到对应 Radix part 上。

## 3. Portal 与 z-index 契约

Radix `Dialog`/`DropdownMenu`/`Select`/`Popover` 默认经 `*.Portal` 渲染到 `document.body` 末尾（脱离父级 `overflow`/`transform`）。现有手写层叠：

| 层 | z-index | 出处 |
|---|---|---|
| Modal overlay/content | `z-50` | [Modal.tsx](../src/components/shared/Modal.tsx) |
| drag-resize 预览线 | `z-50` | [ModelDetail.tsx](../src/components/models/ModelDetail.tsx) / [TocSidebar.tsx](../src/components/detail/toc/TocSidebar.tsx) |
| ColumnMenu 面板 | `z-10` | [ModelsColumnMenu.tsx](../src/components/models/ModelsColumnMenu.tsx) |

**约定**：
- Radix Portal 内容显式给 `z-50`（overlay）/ `z-50`（content），与 Modal 对齐，确保盖住 drag guide。
- Dialog 打开时若内部有 DropdownMenu/Select，其 Portal 也挂 body 末尾、DOM 顺序在后 → 天然层叠在 Dialog 之上，无需额外 z-index，但须实测确认（5173 核对 + jsdom 无法验层叠，靠目视）。
- 不改既有非 Radix 层的 z 值（避免连锁回归）。

## 4. 测试地基（jsdom stub）

Radix 在 jsdom 下依赖 `ResizeObserver` + pointer-capture，已在 [tests/setup.ts](../tests/setup.ts) 全局 stub；正样本验证见 [tests/radix-smoke.vitest.test.tsx](../tests/radix-smoke.vitest.test.tsx)。新迁移组件的测试直接受益，无需各自 stub。
