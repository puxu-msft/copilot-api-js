# ui-v4 Plan 07 — 视觉打磨 + 响应式 + 命令面板/全局搜索 Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development。先读 `ui-v4/docs/HANDOFF.md` + `DESIGN.md §8`。

**Goal:** 把功能完整的 ui-v4 打磨到位：① 响应式退化（desktop-first，窄屏不崩）② 命令面板(⌘K) ③ 全局搜索实装（顶栏 → 后端 trigram FTS5）④ 工业风一致性收尾（CSS-var token 收口、个别 hex 字面量归 token）⑤ 引入 shadcn 基底（Dialog/Popover/Command 等，按需）。

**Architecture（spec §8）：** 响应式断点：**≥1200 三栏全展开 / 768-1200 nav rail 塌图标 + 列表-详情仍并排 / <768 列表-详情不并排（列表全宽，选中→全屏详情 ‹返回），C sub-rail 退横向标签，nav→底部 tab**。命令面板用 **shadcn Command**（Radix + cmdk）：跳页 / 搜请求 / 切模型过滤 / 复制深链 / 切主题。全局搜索：TopBar 输入 → 防抖 → `GET /history/api/entries?search=`（后端 trigram FTS5 子串）→ 下拉结果跳 `/requests/:id`。

**Tech Stack:** 续前 + shadcn/ui 组件（Radix Primitives + cmdk，按需 copy-paste 进仓库；纯 JS）。

## 后端契约
- 全局搜索复用 `GET /history/api/entries?search=<q>`（后端 trigram FTS5，已有）。无后端改动。

## 文件结构
```
ui-v4/src/
├── components/ui/                  # shadcn 基底(Dialog/Popover/Command,copy-paste)
├── components/shell/
│   ├── CommandPalette.tsx          # ⌘K(shadcn Command)
│   ├── GlobalSearch.tsx            # TopBar 全局搜索 + 结果下拉
│   └── (修改)AppShell/NavRail/TopBar # 响应式断点 + nav→底部 tab(窄屏)
├── hooks/
│   ├── useBreakpoint.ts            # 当前断点(matchMedia)
│   ├── useCommandPalette.ts        # ⌘K 开关 + 命令注册
│   └── useGlobalSearch.ts          # 防抖搜索 query
└── stores/ui-store.ts(修改)        # 可加 sidebar/palette open 状态
tests/ 各组件 vitest + useBreakpoint/useGlobalSearch 逻辑
```

## Tasks
- [ ] **Task 1 — shadcn 基底引入**：`bunx shadcn@latest init` + add dialog/popover/command（或手动 copy-paste 进 `components/ui/`）；调 Tailwind theme 对齐工业 token（rounded:0、amber）。验证零 binding.gyp。
- [ ] **Task 2 — useBreakpoint + 响应式骨架**：AppShell/Workbench 按断点切布局。≥1200 现状；768-1200 NavRail 图标化（隐藏文字标签、保 icon + title）；<768 RequestsWorkbench 列表/详情不并排（路由驱动：`/requests`=列表全宽，`/requests/:id`=全屏详情 + ‹返回），DetailSubRail 竖→横标签，NavRail→底部 tab bar。vitest 用 matchMedia mock 验证各档渲染。
- [ ] **Task 3 — CommandPalette(⌘K)**：shadcn Command；命令组：导航(5 页)、最近请求、切主题、复制当前深链。全局 ⌘K 唤起。
- [ ] **Task 4 — GlobalSearch 实装**：TopBar 输入 → `watchDebounced` 300ms → `useGlobalSearch` → `/entries?search=` → 结果下拉（按 EntrySummary 预览）→ 点击 navigate `/requests/:id`。
- [ ] **Task 5 — 工业一致性收尾**：grep `text-[#...]`/`bg-[#...]` 散落 hex，能归 CSS-var token 的归（`--color-muted/border/...`）；统一 hover/focus/active 态；DiagnosticBar 补 terminal reason（client disconnected/process died，从 entry 派生）。
- [ ] **Task 6 — tooling：补 eslint-plugin-react-hooks**（HANDOFF 待办）：给 ui-v4 加 react-hooks 插件 + React eslint 配置，修出现的 exhaustive-deps 警告（useWs 等空依赖标注）。
- [ ] **Task 7 — 验证（含三档断点手动）+ 回填**。

## 验收
- typecheck/test/build 绿；零 binding.gyp（shadcn/cmdk 纯 JS）。
- 手动：三断点不崩、⌘K 命令面板、全局搜索跳转、主题/hover/focus 态一致。

## 暂缓
- 精细移动端打磨（desktop-first，只保证窄屏能用不崩）。
