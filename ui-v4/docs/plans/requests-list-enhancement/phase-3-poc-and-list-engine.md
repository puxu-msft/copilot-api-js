# Phase 3 — 列表引擎（PoC gate + TanStack Table + react-virtuoso）

**依赖**：Phase 2。**消费方**：Phase 4。

**Goal:** 先 PoC gate 证三库组合可行，再 `request-columns.ts`（列模型 + 列可见性）+ `TableVirtuoso` 重写 `HistoryList` 渲染 + `scrollToIndex` 定位（含 at×筛选归属判定）+ 列菜单接入 filter bar。

**红线**：`build:ui-v4` 必跑（rollup 验 `~backend` 纯 + bundle 前后对照入提交信息）；at×筛选归属判定用 `matchesGating`（无 search 维）。

---

### Task 3.0: PoC gate — 三库组合最小可行（poc-first）

**Files:**
- Create: `exp/requests-virtuoso-poc/`（PoC 代码 + `CONCLUSION.md`）

**目标**：进全量重写前，实测 `TableVirtuoso` + `@tanstack/react-table`（`flexRender`）+ jsdom vitest 三者跑通。**不合并进 src**，仅取证。

- [ ] **Step 1: 装依赖** — `cd ui-v4 && bun add react-virtuoso`（`@tanstack/react-table` 已装，确认在 `dependencies`）。
- [ ] **Step 2: 最小 PoC 组件** — `exp/requests-virtuoso-poc/PocTable.tsx`：TanStack `useReactTable({ data, columns, getCoreRowModel })` + `<TableVirtuoso data={rows} components={{...}} fixedHeaderContent itemContent={(i,row)=>flexRender(...)} />`，一个 `virtuosoRef` 暴露 `scrollToIndex`。
- [ ] **Step 3: jsdom 测试探针** — `exp/requests-virtuoso-poc/poc.vitest.test.tsx`：
  - **stub `ResizeObserver`**（jsdom 无）+ 元素尺寸（Virtuoso 靠 `offsetHeight`，jsdom 恒 0 → 渲染 0 行）。stub 方式：`Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get: () => 800 })` + `global.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} }`。或用 Virtuoso 文档的测试建议（`initialItemCount` + 尺寸 mock）。
  - 断言：渲染出 ≥1 行、`scrollToIndex(10)` 不抛、sticky header 存在。
- [ ] **Step 4: 跑通** — `cd ui-v4 && bunx vitest run ../exp/requests-virtuoso-poc/poc.vitest.test.tsx` → PASS。记录**确切的尺寸/ResizeObserver stub 方案**到 `CONCLUSION.md`（Phase 3 正式测试复用）。react-day-picker range→epoch + 日界如 Phase 2 已验则引用之。
- [ ] **Step 5: 提交 PoC** — `git add -- exp/requests-virtuoso-poc/ ui-v4/package.json`（+ 根 `bun.lock`）；msg `test(ui-v4): PoC — TableVirtuoso + TanStack Table + jsdom stub (list-engine gate)`。

> **Gate**：PoC 不绿则**停**，回 spec/ADR 复议虚拟化方案，勿硬推全量重写。

---

### Task 3.1: `request-columns.ts` — TanStack 列模型 + 列可见性

**Files:**
- Create: [ui-v4/src/lib/request-columns.ts](../../src/lib/request-columns.ts)
- Test: `ui-v4/src/lib/request-columns.bun.test.ts`

**Interfaces:**
- Consumes: `EntrySummary`（`@/types`）；activity-row 域函数（`requestState`/`modelName`/`endpointLabel`/`tokenIn`/`tokenOut`/`tokenCacheRead`/`failureSummary`/`truncPreview`，[activity-row.ts](../../src/lib/activity-row.ts)）。
- Produces:
  - `REQUEST_COLUMNS: ColumnDef<EntrySummary>[]`（id/status/time/dur/model/multiplier/endpoint/bytes/tokens/attempts/preview；`accessorFn` 复用 activity-row）。
  - `COLUMN_WIDTHS: Record<string, string>`（单一真值源，Live 泳道 import 对齐——红线 M4）。
  - `DEFAULT_COLUMN_VISIBILITY: VisibilityState`（全显）。
  - `mergeColumnVisibility(persisted: Partial<VisibilityState> | null): VisibilityState`（对账未知列/新列取默认——M1；镜像 [model-columns.ts](../../src/lib/model-columns.ts) 的 `mergeColumnVisibility`）。
  - `COLUMN_STORAGE_KEY = "ui-v4:requests:columns"`。

- [ ] **Step 1: 失败测试** — accessorFn 取值（如 model 列对某 summary 返回 `modelName(e)`）、`DEFAULT_COLUMN_VISIBILITY` 全 true、`mergeColumnVisibility(null)` = 默认、`mergeColumnVisibility({ bytes: false })` 只改 bytes 其余默认、未知 key 忽略。
- [ ] **Step 2: 确认失败** → FAIL。
- [ ] **Step 3: 实现** — 列定义把 [RequestRow.tsx HistoryRow](../../src/components/requests/RequestRow.tsx) 的每个 `<span>` 转成一列（`id`/`header`/`accessorFn`/`cell` 渲染 + `meta.width` 取 `COLUMN_WIDTHS`）。信号色/tooltip/anomaly 逻辑平移进 `cell`。`mergeColumnVisibility` 逐字镜像 model-columns。
- [ ] **Step 4: 确认通过** → PASS。
- [ ] **Step 5: 门禁 + 提交** — bun test + typecheck + eslint；msg `feat(ui-v4): request-columns (TanStack ColumnDef + visibility + width SSOT)`。

---

### Task 3.2: `HistoryList` 用 `TableVirtuoso` 重写渲染

**Files:**
- Modify: [ui-v4/src/components/requests/HistoryList.tsx](../../src/components/requests/HistoryList.tsx)
- Test: `ui-v4/tests/HistoryList.vitest.test.tsx`（新建/扩展；复用 PoC 的 jsdom stub）

**Interfaces:**
- Consumes: `REQUEST_COLUMNS`/`COLUMN_WIDTHS`/列可见性（3.1）；`useHistoryInfinite`（1.3）；`useReactTable`/`flexRender`（@tanstack/react-table）；`TableVirtuoso`/`VirtuosoHandle`（react-virtuoso）。
- Produces：内部虚拟渲染 + 保留 tail/缓冲横幅/`goLive`/选中导航；列可见性 state（localStorage 持久化，`mergeColumnVisibility` 读回）。

**要点**：
- `useReactTable({ data: entries, columns: REQUEST_COLUMNS, state: { columnVisibility }, onColumnVisibilityChange, getCoreRowModel })`。
- `<TableVirtuoso data={table.getRowModel().rows} components={{ Table, TableHead, TableRow }} fixedHeaderContent={()=>headerGroups flexRender} itemContent={(index,row)=>row.getVisibleCells().map(cell=>flexRender(cell.column.columnDef.cell, cell.getContext()))} endReached={()=>{ if (hasNextPage) void fetchNextPage() }} />`。
- 行点击 → `selectRow(row.original.id)`（保留现有 dispatch locate + navigate）。选中/flash 通过 `itemContent` 读 `selectedId`/`flashId`。
- **tail 仍 invalidate 整页**（不改，§10.2）；缓冲横幅/header/resume/flush 逻辑保留。
- 移除旧 `onScroll` 阈值翻页（`endReached` 取代）；但 **scroll-up 暂停 tail** 仍需要：用 Virtuoso 的 `atTopStateChange`/`isScrolling` 或 `rangeChanged` 判断离顶 → `dispatch({kind:"scroll-up"})`。

- [ ] **Step 1: 失败测试** — 复用 PoC stub；给 3 条 entries：断言渲染出 3 行、隐藏一列（columnVisibility）该列 header/cell 不出现、点行触发 navigate、`endReached` 调 `fetchNextPage`（mock）。
- [ ] **Step 2: 确认失败** → FAIL。
- [ ] **Step 3: 实现**（按要点；`findRow`/`onScroll` 旧逻辑 Task 3.3 再处理定位，本 task 先渲染 + endReached + 选中 + 列可见性）。
- [ ] **Step 4: 确认通过** → PASS。
- [ ] **Step 5: 门禁 + 提交** — typecheck + eslint + **`bun run --filter copilot-api-ui-v4 build`**（bundle 前后对照记入 msg）；msg `feat(ui-v4): HistoryList on TableVirtuoso + TanStack Table (bundle +Xkb)`。

---

### Task 3.3: `?at=` 定位改 `scrollToIndex` + at×筛选归属判定

**Files:**
- Modify: [ui-v4/src/components/requests/HistoryList.tsx](../../src/components/requests/HistoryList.tsx)
- Test: `ui-v4/tests/HistoryList.vitest.test.tsx`（追加）

**Interfaces:**
- Consumes: `matchesGating`（1.1）；`api.get`（拿单条 summary）；`VirtuosoHandle.scrollToIndex`。

**归属规则（§10.1）**：
1. `?at=` 落地，若已加载集含该 id → `virtuosoRef.scrollToIndex({ index, align: "center" })` + flash（`toc-flash` 类 FLASH_MS）。
2. 否则 `GET /history/api/entries/:id` 拿 summary → `matchesGating(summary, filters)`（无 search 维；从宽——不属则提示，不盲翻页）。
3. 不属 → 行内提示「该条目不在当前筛选内 · [清除筛选并定位]」（点击 `clearAll()`，保留 `?at=`）。属而未在已加载集 → `fetchNextPage` load-until-found（保留 `LOCATE_PAGE_CAP` cap）。

- [x] **Step 1: 失败测试** —
  - at 在已加载集 → `scrollToIndex` 被调（fake TableVirtuoso 经 useImperativeHandle 暴露 spy）+ flash 类加上。
  - at 不在集 + `matchesGating` 返回 false（mock `api.get` 返回不匹配 endpoint 的 HistoryEntry）→ 渲染「不在当前筛选内」提示，**不**调 fetchNextPage。
  - at 不在集 + 匹配 → 调 fetchNextPage（cap 内）。追加 loop（翻页揭示目标→scroll）+ CAP（永不出现→恰 LOCATE_PAGE_CAP 次）覆盖。
- [x] **Step 2: 确认失败** → FAIL（4 新用例红）。
- [x] **Step 3: 实现** — index+scrollToIndex + at×筛选归属判定分支（membership 按 (at, gating-sig) 记忆 + 代次守卫防陈旧 filters 竞态；`.catch` 记 console.error 再从宽回退）。`locateRef` 语义保留（done/pages/at）；新增 `onClearFilters` prop，RequestsListPage 传 `clearAll`。
- [x] **Step 4: 确认通过** → PASS（16/16，确定性 4 连跑；全量 279 绿；typecheck/eslint/build 绿）。
- [x] **Step 5: 门禁 + 提交** — commit `cda8bf25` msg `feat(ui-v4): at-locate via scrollToIndex + filter-membership guard`。两轮 ecc:react-reviewer 复审通过。

---

### Task 3.4: 列可见性菜单接入 filter bar + Live 泳道列宽对齐

**Files:**
- Modify: [ui-v4/src/components/requests/RequestsListPage.tsx](../../src/components/requests/RequestsListPage.tsx)（列可见性 state 提到 Page 或用共享 store，传 `columnMenuSlot` 给 filter bar + `columnVisibility` 给 HistoryList）
- Create: [ui-v4/src/components/requests/RequestsColumnMenu.tsx](../../src/components/requests/RequestsColumnMenu.tsx)（镜像 [ModelsColumnMenu.tsx](../../src/components/models/ModelsColumnMenu.tsx)，驱动 `VisibilityState`）
- Modify: [ui-v4/src/components/requests/RequestRow.tsx](../../src/components/requests/RequestRow.tsx)（Live 行 import `COLUMN_WIDTHS` 对齐）

**Interfaces:**
- 列可见性 state（`useState` + localStorage `COLUMN_STORAGE_KEY`，`mergeColumnVisibility` 读回）提到 `RequestsListPage`，`columnMenuSlot={<RequestsColumnMenu .../>}` 传给 filter bar，`columnVisibility`+`onColumnVisibilityChange` 传给 `HistoryList`。

- [ ] **Step 1: 失败测试** — 菜单切一列 → HistoryList 该列消失 + localStorage 写入；刷新（重挂）→ 持久化恢复；Live 行列宽 = `COLUMN_WIDTHS`（快照/样式断言）。
- [ ] **Step 2: 确认失败** → FAIL。
- [ ] **Step 3: 实现** — `RequestsColumnMenu` 复用 DropdownMenu 范式；Page 持有 columnVisibility；Live 行改用 `COLUMN_WIDTHS` 常量。
- [ ] **Step 4: 确认通过** → PASS。
- [ ] **Step 5: 门禁 + 提交** — typecheck + eslint + build；msg `feat(ui-v4): column visibility menu + Live-lane width alignment`。

---

**Phase 3 完成判据**：PoC 绿并留 stub 方案；HistoryList 虚拟渲染 + endReached 加载旧页 + 列可见性 + scrollToIndex 定位（含 at×筛选归属）+ Live 列宽对齐；`build:ui-v4` 绿（bundle 增量入提交信息，`~backend` 纯）。
