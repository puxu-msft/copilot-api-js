# Requests 列完全可配置 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Requests 列表列升级为完全可配置——重策展默认集/顺序 + 新 cache 命中列 + 拖拽调列宽(resize) + dnd-kit 拖表头改列序(reorder)，三态版本化持久化 + 一键 Reset。

**Architecture:** 保留 headless TanStack Table + react-virtuoso 引擎。列宽从 Tailwind 类迁到 TanStack `columnSizing`（仅固定列 emit inline width，弹性列 preview/response 保自适应）；`columnOrder` + dnd-kit 官方 recipe 拖拽；三态（visibility/sizing/order）经版本化统一键 `column-state:v1` 持久化。session gutter 特判沿用（锁首、不 resize/reorder）。

**Tech Stack:** React 18 + TS + @tanstack/react-table v8（columnSizing/columnOrder/columnVisibility 核心）+ @dnd-kit/{core,sortable,modifiers} + react-virtuoso + Tailwind；bun test（纯逻辑）+ vitest/jsdom。

**权威 spec：** [ui-v4/docs/spec/2026-07-11-ui-v4-requests-column-config.md](../spec/2026-07-11-ui-v4-requests-column-config.md)（取舍/审查纪要看 spec，本计划只讲怎么做）。

## Global Constraints（每 Task 隐含含此节）

- **后端零改动**，只碰 `ui-v4/src/**` + `ui-v4/package.json`。
- **HIGH-1 弹性列判据**：`column.getSize()` 永不返 undefined（无 size 回退 150）。**仅当列 `enableResizing !== false` 才 emit inline `style={{width: header.getSize()}}`**；preview/response（`enableResizing:false`、无 size）**绝不设 inline width**（table-fixed 自动均分剩余）。
- **HIGH-2 resize×dnd 事件**：resize 手柄须 `onMouseDown/onTouchStart=getResizeHandler()` **且** `onPointerDown={e=>e.stopPropagation()}`（dnd useSortable 走 pointerdown，只 stop mousedown 挡不住）；dnd `PointerSensor` 设 `activationConstraint:{distance:4}`。
- **session gutter**：沿用 session-color 特判（th/td 硬编码 `p-0` + `w-[10px]`），`enableResizing:false`，**排除出 columnSizing/getSize**（不设 size、不 emit inline width），恒锁列序首位、不入 dnd SortableContext、不入 Columns 菜单。
- **MEDIUM-3 版本化持久化**：新键 `ui-v4:requests:column-state:v1` 存 `{visibility,sizing,order}`；旧键 `ui-v4:requests:columns` 弃用（新键不存在→从新默认 seed，存量显隐定制一次性重置，符合项目「无向后兼容负担」）。
- **cache 命中率**：`cache_read / (input + cache_read + cache_creation)`（分母含 creation，对齐 laneSummary）；读**原始 usage 数字**非 `tokenCacheRead`（后者返格式化串）。
- **AgentLane/RequestRow 不改**：保持自有硬编码宽、不加 cache 列（记 defer）；退役 COLUMN_WIDTHS 时清理其陈旧「import 本表对齐」死注释。
- **门禁**：每 Task `bunx tsc --noEmit`（仅 4 基线 responsePreviewText 错）+ 无缓存 `bunx eslint <改动文件>` + 对应 bun/vitest 绿 + 全量 `bunx vitest run` 无回归；显式 pathspec commit、conventional、无模型署名。
- **已知基线**（非本特性，勿修勿计失败）：request-pages ×2 vitest 预存失败（Live lane getByText）+ 4 tsc responsePreviewText。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `ui-v4/src/lib/activity-row.ts` | 加 `cacheHitCell` 纯派生 | 改 |
| `ui-v4/src/lib/request-columns.ts` | 加 cache 列 + 各列 size/min/max + 新 DEFAULT_COLUMN_VISIBILITY/ORDER/SIZING + merge 函数 + 退役 COLUMN_WIDTHS + 清死注释 | 改 |
| `ui-v4/src/lib/request-columns.bun.test.ts` | 更新列序/visibility 断言、删 COLUMN_WIDTHS 断言、加 order/sizing merge 测试 | 改 |
| `ui-v4/src/hooks/useColumnState.ts` | 版本化统一列状态 hook（visibility+sizing+order 持久化） | 新建 |
| `ui-v4/tests/useColumnState.vitest.test.tsx` | hook 加载/持久化/seed/Reset | 新建 |
| `ui-v4/src/components/requests/HistoryList.tsx` | useReactTable 三态 + inline width（固定列）+ resize 手柄 + dnd useSortable th | 改 |
| `ui-v4/tests/HistoryList.vitest.test.tsx` | inline width / 手柄存在 / cache 列 / order 变更 | 改 |
| `ui-v4/src/components/requests/RequestsListPage.tsx` | 用 useColumnState + DndContext 包裹 | 改 |
| `ui-v4/src/components/requests/RequestsColumnMenu.tsx` | 菜单随 columnOrder 序、Reset 复位三态 | 改 |
| `ui-v4/tests/activity-row...` / bun | cacheHitCell | 改/新 |
| `ui-v4/package.json` | 加 @dnd-kit/{core,sortable,modifiers} | 改 |

---

## Task 1: 策展 + cache 列 + 列宽迁移到 size + 版本化列状态

建立列状态新架构：cache 列、新默认显隐/序/宽、退役 COLUMN_WIDTHS、版本化持久化。**本 Task 后默认视图即改变、列宽由 size 驱动**，但 resize/reorder 交互在 Task 2/3。

**Files:**
- Modify: `ui-v4/src/lib/activity-row.ts`（+ `cacheHitCell`）+ 其 bun 测试
- Modify: `ui-v4/src/lib/request-columns.ts` + `ui-v4/src/lib/request-columns.bun.test.ts`
- Create: `ui-v4/src/hooks/useColumnState.ts` + `ui-v4/tests/useColumnState.vitest.test.tsx`
- Modify: `ui-v4/src/components/requests/HistoryList.tsx`（inline width 迁移 + 三态接入，无手柄/dnd）+ `RequestsListPage.tsx`（用 useColumnState）+ `RequestsColumnMenu.tsx`（菜单随序）
- Modify: `ui-v4/tests/HistoryList.vitest.test.tsx`

**Interfaces produced:**
- `cacheHitCell(e: EntrySummary): { text: string; title: string; signal: Signal }`
- `DEFAULT_COLUMN_VISIBILITY`（endpoint/multiplier/tokens/attempts=false，余含 cache=true）
- `DEFAULT_COLUMN_ORDER: string[]`、`DEFAULT_COLUMN_SIZING: Record<string,number>`
- `mergeColumnOrder(persisted, /*default*/): string[]`、`mergeColumnSizing(persisted): Record<string,number>`
- `COLUMN_STATE_KEY = "ui-v4:requests:column-state:v1"`
- `useColumnState(): { visibility, sizing, order, setVisibility, setSizing, setOrder, toggleColumn, reset }`

- [ ] **Step 1: cacheHitCell 失败测试**（追加到 activity-row 的 bun 测试文件；先确认其存在，如 `tests/activity-row.bun.test.ts`，无则建）

```ts
import { cacheHitCell } from "@/lib/activity-row"

describe("cacheHitCell", () => {
  const u = (input: number, read: number, creation = 0) =>
    ({ id: "x", startedAt: 0, endpoint: "anthropic-messages", state: "completed",
       usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: read, cache_creation_input_tokens: creation } }) as unknown as import("@/types").EntrySummary
  test("命中率 = read/(input+read+creation)", () => {
    // 15 read /(5 input + 15 read + 0) = 75%
    expect(cacheHitCell(u(5, 15)).text).toBe("75%")
    // 分母含 creation: 10/(10+10+20)=25%
    expect(cacheHitCell(u(10, 10, 20)).text).toBe("25%")
  })
  test("无 usage → 空", () => {
    expect(cacheHitCell({ id: "x", startedAt: 0, endpoint: "anthropic-messages" } as unknown as import("@/types").EntrySummary).text).toBe("")
  })
  test("大 input 无 cache → warn", () => {
    expect(cacheHitCell(u(25_000, 0)).signal).toBe("warn")
  })
})
```

- [ ] **Step 2: 跑挂** `cd ui-v4 && bun test tests/activity-row.bun.test.ts` → FAIL（cacheHitCell 不存在）。

- [ ] **Step 3: 实现 cacheHitCell**（activity-row.ts，复用现有 `Signal` 类型 + `rowAnomaly`）

```ts
/** cache 命中率单元格:read/(input+read+creation) 百分比 + hover 原始数 + 信号(大 input 无 cache→warn)。 */
export function cacheHitCell(entry: EntrySummary): { text: string; title: string; signal: Signal } {
  const u = entry.usage
  if (!u) return { text: "", title: "", signal: "muted" }
  const read = u.cache_read_input_tokens ?? 0
  const total = (u.input_tokens ?? 0) + read + (u.cache_creation_input_tokens ?? 0)
  if (total === 0) return { text: "", title: "", signal: "muted" }
  const pct = Math.round((read / total) * 100)
  const warn = rowAnomaly(entry).cacheMiss
  return { text: `${pct}%`, title: `↺${read} / ${total}`, signal: warn ? "warn" : read > 0 ? "ok" : "muted" }
}
```

- [ ] **Step 4: 跑绿** `bun test tests/activity-row.bun.test.ts` → PASS。

- [ ] **Step 5: request-columns.ts —— cache 列 + size + 新默认 + merge + 退役 COLUMN_WIDTHS**

① `REQUEST_COLUMNS`：在 model 后插入 cache 列（display）；各**固定列**加 `size`（数值，取自旧 COLUMN_WIDTHS px 值）+ `minSize:40` + 合理 `maxSize`；preview/response 加 `enableResizing:false`（不设 size）；session 加 `enableResizing:false`（不设 size，宽度靠 HistoryList 特判）。
```ts
// cache 列(model 之后)
{
  id: "cache",
  header: "Cache",
  accessorFn: (e) => cacheHitCell(e).text,
  cell: ({ row }) => { const c = cacheHitCell(row.original); return span(`${ELLIPSIS} text-right`, c.text, { color: SIGNAL_COLOR[c.signal], title: c.title }) },
  size: 64, minSize: 44, maxSize: 120,
},
// 各固定列示例:status size:92,minSize:60; time size:68; dur size:64; model size:180,maxSize:360; multiplier size:34,minSize:28,maxSize:48; endpoint size:120; bytes size:118; tokens size:130; attempts size:40,minSize:32
// preview / response:{ ...列定义, enableResizing: false }  // 不设 size → 自适应
// session:{ id:"session", header:"", cell:()=>null, enableResizing:false }  // 宽度靠 HistoryList 特判 p-0 w-[10px]
```
② `DEFAULT_COLUMN_VISIBILITY`：改为四列 false：
```ts
const DEFAULT_HIDDEN = new Set(["endpoint", "multiplier", "tokens", "attempts"])
export const DEFAULT_COLUMN_VISIBILITY: VisibilityState = Object.fromEntries(REQUEST_COLUMN_IDS.map((id) => [id, !DEFAULT_HIDDEN.has(id)]))
```
③ 新常量：
```ts
export const DEFAULT_COLUMN_ORDER: ReadonlyArray<string> = ["session","status","time","dur","model","cache","bytes","preview","response","endpoint","multiplier","tokens","attempts"]
export const DEFAULT_COLUMN_SIZING: Record<string, number> = Object.fromEntries(REQUEST_COLUMNS.filter((c) => c.enableResizing !== false && typeof c.size === "number").map((c) => [c.id as string, c.size as number]))
export const COLUMN_STATE_KEY = "ui-v4:requests:column-state:v1"
```
④ merge 纯函数：
```ts
/** 持久序为基 + 新列按默认序补位 + 删列忽略 + session 恒首。 */
export function mergeColumnOrder(persisted: ReadonlyArray<string> | null | undefined): Array<string> {
  const known = new Set(REQUEST_COLUMN_IDS)
  const base = (persisted ?? []).filter((id) => known.has(id))
  for (const id of DEFAULT_COLUMN_ORDER) if (!base.includes(id)) base.push(id) // 新列补位
  return ["session", ...base.filter((id) => id !== "session")] // session 锁首
}
/** 持久值覆盖 + 未知列丢弃 + 新列取默认 size。 */
export function mergeColumnSizing(persisted: Record<string, number> | null | undefined): Record<string, number> {
  const merged = { ...DEFAULT_COLUMN_SIZING }
  if (persisted && typeof persisted === "object") for (const id of Object.keys(DEFAULT_COLUMN_SIZING)) if (typeof persisted[id] === "number") merged[id] = persisted[id]
  return merged
}
```
⑤ **退役 `COLUMN_WIDTHS` —— 连带清理清单（MEDIUM-B，缺一即 TS2305）**：
  - 删常量 `COLUMN_WIDTHS`（request-columns.ts:123 附近）。
  - 删 **12 处** `meta: { width: COLUMN_WIDTHS.xxx }`（列条目 status/time/dur/model/multiplier/endpoint/bytes/tokens/attempts/preview/response + session；行 148/158/165/179/186/197/204/216/231/241/254/264）——这些列改用 `size`（固定列）或无（弹性/session）。
  - 删 **ColumnMeta augmentation** `declare module "@tanstack/react-table" { interface ColumnMeta { width?: string } }`（request-columns.ts:45-52）。
  - 删测试 import（request-columns.bun.test.ts:23 的 `COLUMN_WIDTHS`）——见 Step 6。
  - HistoryList 两处 `columnDef.meta?.width` 读取（:573/613）改 inline width 判据——见 Step 9。
  - 清理陈旧死注释：request-columns.ts:5/122 + RequestRow.tsx:22-23 的「Live 泳道 import 本表对齐」（假话，RequestRow 硬编码宽），改为「列宽 = ColumnDef.size；Live 泳道 RequestRow 自持硬编码宽」。

- [ ] **Step 6: request-columns.bun.test.ts 更新断言（行号已核实）**
- **`:23`** 删 `COLUMN_WIDTHS` import（退役后失效）；
- **`:43-56`** 列序 `toEqual([...])` 加 `"cache"`（在 `"model"` 后）；
- **`:107-110`** DEFAULT_COLUMN_VISIBILITY all-true → 改为「endpoint/multiplier/tokens/attempts=false，余=true」；
- **删 `:112-117`** COLUMN_WIDTHS 每列非空断言；
- 加 `mergeColumnOrder`（null→默认序 session 首、删列忽略、新列补位）+ `mergeColumnSizing`（null→默认、覆盖、未知丢）测试。

- [ ] **Step 7: 跑挂→实现→跑绿** `bun test src/lib/request-columns.bun.test.ts`（先挂于列序/新断言，实现后绿）。

- [ ] **Step 8: useColumnState hook + 测试**（版本化统一键；容错 try/catch；seed 默认）

```ts
// ui-v4/src/hooks/useColumnState.ts
import { useCallback, useEffect, useState } from "react"
import type { ColumnSizingState, VisibilityState } from "@tanstack/react-table"
import { COLUMN_STATE_KEY, DEFAULT_COLUMN_ORDER, DEFAULT_COLUMN_SIZING, DEFAULT_COLUMN_VISIBILITY, mergeColumnOrder, mergeColumnSizing, mergeColumnVisibility } from "@/lib/request-columns"

interface Persisted { visibility?: Partial<VisibilityState>; sizing?: Record<string, number>; order?: Array<string> }
function load(): { visibility: VisibilityState; sizing: ColumnSizingState; order: Array<string> } {
  let p: Persisted | null = null
  try { p = JSON.parse(localStorage.getItem(COLUMN_STATE_KEY) ?? "null") as Persisted | null } catch { p = null }
  return { visibility: mergeColumnVisibility(p?.visibility ?? null), sizing: mergeColumnSizing(p?.sizing ?? null), order: mergeColumnOrder(p?.order ?? null) }
}
export function useColumnState() {
  const [state, setState] = useState(load)
  useEffect(() => {
    try { localStorage.setItem(COLUMN_STATE_KEY, JSON.stringify({ visibility: state.visibility, sizing: state.sizing, order: state.order })) }
    catch (err) { console.warn("[useColumnState] 持久化失败:", err) }
  }, [state])
  const setVisibility = useCallback((u: VisibilityState | ((v: VisibilityState) => VisibilityState)) => setState((s) => ({ ...s, visibility: typeof u === "function" ? u(s.visibility) : u })), [])
  const setSizing = useCallback((u: ColumnSizingState | ((v: ColumnSizingState) => ColumnSizingState)) => setState((s) => ({ ...s, sizing: typeof u === "function" ? u(s.sizing) : u })), [])
  const setOrder = useCallback((u: Array<string> | ((v: Array<string>) => Array<string>)) => setState((s) => ({ ...s, order: mergeColumnOrder(typeof u === "function" ? u(s.order) : u) })), [])
  const toggleColumn = useCallback((id: string) => setState((s) => ({ ...s, visibility: { ...s.visibility, [id]: !(s.visibility[id] ?? true) } })), [])
  const reset = useCallback(() => { setState({ visibility: { ...DEFAULT_COLUMN_VISIBILITY }, sizing: { ...DEFAULT_COLUMN_SIZING }, order: [...DEFAULT_COLUMN_ORDER] }); try { localStorage.removeItem(COLUMN_STATE_KEY) } catch { /* ignore */ } }, [])
  return { ...state, setVisibility, setSizing, setOrder, toggleColumn, reset }
}
```
测试（vitest，jsdom localStorage）：seed 默认（无持久化→四列 false + session 首序 + 默认 size）；写读往返；未知键回退；reset 清键回默认；toggleColumn 翻转。

- [ ] **Step 9: HistoryList 接三态 + inline width（固定列）+ session 特判保留**（**无手柄、无 dnd**，那是 Task 2/3）

- `useReactTable` 加 `state: { columnVisibility, columnSizing, columnOrder }` + `onColumnSizingChange`/`onColumnOrderChange`（受控，来自 props）+ `defaultColumn: { minSize: 40 }`。
- 现有 th/td 的 `meta?.width` Tailwind 类改：**固定列** emit `style={{ width: header.getSize() }}`（判据 `header.column.columnDef.enableResizing !== false && header.column.id !== "session"`）；弹性列/session 不设 inline width；session 保留特判 `p-0 w-[10px]`（th）与 itemContent 首列专属 td（不变）。
- props 扩展：`columnSizing?`/`columnOrder?`/`onColumnSizingChange?`/`onColumnOrderChange?`——**全部 optional**（LOW-E，镜像现有 `columnVisibility?` 受控模式）：10 处现有测试用 `<HistoryList filters={EMPTY_FILTERS}/>` 不传这些 props，required 会全 typecheck 破。传 `undefined` 给 useReactTable 的 `state.columnSizing/columnOrder` 即走 TanStack 内部默认（列定义序 + 默认 size），无需额外 fallback state。

- [ ] **Step 10: RequestsListPage 用 useColumnState**（替换现有 loadColumnVisibility + 独立 columnVisibility state）

```tsx
const cs = useColumnState()
// ...RequestsColumnMenu columns={cs.visibility} onToggle={cs.toggleColumn} onReset={cs.reset}
// ...HistoryList columnVisibility={cs.visibility} onColumnVisibilityChange={cs.setVisibility}
//     columnSizing={cs.sizing} onColumnSizingChange={cs.setSizing}
//     columnOrder={cs.order} onColumnOrderChange={cs.setOrder}
```
（Task 1 先把三态通到 table，menu 仍只 toggle 显隐；DndContext 在 Task 3 包裹。）

- [ ] **Step 11: RequestsColumnMenu 随序 + Reset 复位三态**：菜单项迭代改用传入的 `order`（过滤掉 session）而非 REQUEST_COLUMNS 定义序；`onReset` 已接 `cs.reset`（复位三态）。

- [ ] **Step 12: HistoryList vitest 更新**：默认隐藏四列不渲染表头；cache 列表头/单元格渲染 %；固定列 th 有 inline width style、弹性列/session 无。

- [ ] **Step 13: 门禁 + 提交**
```bash
cd ui-v4 && bunx tsc --noEmit && bunx eslint <改动文件> && bun test tests/activity-row.bun.test.ts src/lib/request-columns.bun.test.ts && bunx vitest run
git -C /home/xp/src/copilot-api-js commit -- <精确路径列表> -m "feat(ui-v4): column curation + cache column + size-driven widths + versioned column-state"
```

---

## Task 2: 列宽 resize 交互

**Files:** Modify `HistoryList.tsx`（resize 手柄 + columnResizeMode）+ `tests/HistoryList.vitest.test.tsx`

**Consumes:** Task 1 的固定列 size + inline width + `onColumnSizingChange`。

- [ ] **Step 1: 失败测试**（HistoryList vitest）：固定列 th 有 resize 手柄元素（如 `[data-resize-handle]`）、弹性列/session 无；手柄 `onPointerDown` 存在（查属性）；模拟拖拽或直接 setState 验 width 变。（拖拽像素靠人工核验，测手柄存在 + onColumnSizingChange 被调。）

- [ ] **Step 2: 跑挂。**

- [ ] **Step 3: 实现**：`useReactTable` 加 `enableColumnResizing: true` + `columnResizeMode: "onChange"`。`fixedHeaderContent` 的**固定列** th 内加手柄：
```tsx
{header.column.getCanResize() && (
  <span
    data-resize-handle
    onMouseDown={header.getResizeHandler()}
    onTouchStart={header.getResizeHandler()}
    onPointerDown={(e) => e.stopPropagation()} // HIGH-2:挡 dnd pointerdown
    className="absolute inset-y-0 right-0 w-1 cursor-col-resize select-none hover:bg-[var(--color-primary)]"
  />
)}
```
（th 须 `relative` 以定位手柄；`getCanResize()` 对 enableResizing:false 列返 false，天然排除弹性列/session。）

- [ ] **Step 4: 跑绿 + 全量无回归 + typecheck/eslint + 提交**
`git commit -- ... -m "feat(ui-v4): draggable column resize (TanStack columnSizing + handle)"`

---

## Task 3: 列序 reorder 交互（dnd-kit）

**Files:** `package.json`（加依赖）+ `HistoryList.tsx`（useSortable th）+ `RequestsListPage.tsx`（DndContext）+ `tests/HistoryList.vitest.test.tsx`

**Consumes:** Task 1 的 `columnOrder` + `onColumnOrderChange`。

- [ ] **Step 1: 加依赖**
```bash
cd ui-v4 && bun add @dnd-kit/core@^6.3.1 @dnd-kit/sortable@^10.0.0 @dnd-kit/modifiers@^9.0.0
```
（核验 bun.lock 钉版；若最新有更高稳定版按 `bun add` 结果为准。）

- [ ] **Step 2: 失败测试**：reorder 端到端拖拽 jsdom 难模拟——用 `onColumnOrderChange` state 直接断言（setOrder 换序 → th 顺序变、session 恒首）；非 session th 有 dnd draggable 属性、session th 无。

- [ ] **Step 3: 跑挂。**

- [ ] **Step 4: 实现**
① `RequestsListPage` 包 `DndContext`：
```tsx
import { DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core"
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers"
import { arrayMove } from "@dnd-kit/sortable"
const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } })) // HIGH-2
// <DndContext sensors={sensors} modifiers={[restrictToHorizontalAxis]}
//   onDragEnd={({active,over}) => { if(over && active.id!==over.id) cs.setOrder((o)=>{ const ids=o.filter(i=>i!=="session"); const from=ids.indexOf(String(active.id)); const to=ids.indexOf(String(over.id)); return ["session", ...arrayMove(ids, from, to)] }) }}>
//   ...<HistoryList/>
// </DndContext>
```
② `HistoryList` 表头：非 session th 包 `useSortable`（`SortableContext` items = 非 session 的 columnOrder，`horizontalListSortingStrategy`）；session th 不入 SortableContext、不可拖。th 主体 `{...attributes} {...listeners}` 拖拽；resize 手柄已 stopPropagation pointerdown（Task 2）分区。

- [ ] **Step 5: 跑绿 + 全量无回归 + typecheck/eslint + 提交**
`git commit -- ... -m "feat(ui-v4): drag-to-reorder columns (dnd-kit + columnOrder), session locked first"`

---

## Task 4: 收尾

- [ ] **Step 1: 全量门禁** `bunx tsc --noEmit`（仅 4 基线）+ `bunx vitest run`（除 2 预存）+ `bun test` + `bun run build:ui-v4` exit 0。
- [ ] **Step 2: 人工视觉核验（no-auto-server：用户起服）**：默认视图四列已隐 + cache 列显 %；拖列宽实时改、min/max 生效、preview/response 仍充满；拖表头改序、session 锁首、拖右边界只 resize 不误 reorder；刷新保留三态；Reset 复位；存量用户旧配置一次性重置到新默认。
- [ ] **Step 3: subagent 合并态审查**（裁判轴：长远正确+完整+与 spec 一致）：三态联动、inline-width 判据、dnd×resize 分区、版本化 seed、菜单随序。
- [ ] **Step 4: doc-sync**：DESIGN §4 更新列体系（可配置 + cache 列 + 默认集）；spec 状态改已实施。
- [ ] **Step 5: 提交** doc-sync。

---

## Self-Review

**Spec 覆盖**：§2 策展/cache→Task1；§3 resize→Task1(size/inline-width)+Task2(手柄)；§4 reorder→Task3；§5 版本化持久化→Task1(useColumnState);§6 文件/退役 COLUMN_WIDTHS/死注释/AgentLane defer→Task1；§7 测试→各 Task；§10 审查 9 项→Global Constraints。无遗漏。

**Placeholder**：无 TBD；关键代码完整；机械部分（各列 size 值、th relative 定位）给了判据与示例。实现者须先读 activity-row 的 bun 测试文件名（可能 `activity-row.bun.test.ts`，无则建）+ HistoryList 现有 th/td 渲染确认迁移点。

**类型一致**：`cacheHitCell` 返回 `{text,title,signal}` 贯穿；`mergeColumnOrder/Sizing` 与 useColumnState 一致；session 恒首在 mergeColumnOrder + dnd onDragEnd 两处都强制。

## 计划审查纪要（一轮对抗 subagent，全数纳入）

亲读 TanStack v8.21.3 类型 + dnd-kit 安装态 + 测试真实路径 + usage 字段 + COLUMN_WIDTHS 全仓引用。**API/接线 items 1-10 全部确认正确**（TanStack resize/order API、inline-width 判据、cacheHitCell 字段、DEFAULT_COLUMN_SIZING 派生、updater 兼容、dnd-kit import 来源、session 序逻辑、受控模式、Task1 中间态可编译）。修订：

| 发现 | 级别 | 处置 |
|---|---|---|
| A activity-row bun 测试真实在 `tests/`（唯一例外），plan 全写 `src/lib/` | HIGH | **纳入**：全改 `tests/activity-row.bun.test.ts` |
| B 退役 COLUMN_WIDTHS 留 12 处 meta:{width}+augmentation+测试 import 变 TS2305 | MED | **纳入**：Step 5⑤ 枚举全部连带清理 |
| C Step 6 行号错位 | MED | **纳入**：改 `:23`/`:43-56`/`:107-110`/`:112-117` |
| D session 是否 size:10 spec/plan 矛盾 | LOW | **纳入**：统一为不设 size（spec §6 已改） |
| E 新 sizing/order props 须 optional（10 测试不传） | LOW | **纳入**：Step 9 明写全 optional |
| F reset removeItem 被 effect 回写覆盖（无害冗余） | LOW | 保留（默认值等价，belt-and-suspenders） |
