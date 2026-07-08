# Phase 2 — 筛选 UI

**依赖**：Phase 1（消费 `useRequestFilters`）。**消费方**：Phase 3（列菜单挂此处）、Phase 4。

**Goal:** `useDebouncedCallback` + `RequestsFilterBar`（防抖 input + shared FilterSelect + react-day-picker 时间范围）+ `RequestFilterChips` + 挂进 `RequestsListPage`。列菜单在 Phase 3 列模型就位后接入（本阶段留占位/后接）。

---

### Task 2.1: `useDebouncedCallback`

**Files:**
- Create: [ui-v4/src/hooks/useDebouncedCallback.ts](../../src/hooks/useDebouncedCallback.ts)
- Test: `ui-v4/tests/useDebouncedCallback.vitest.test.tsx`

**Interfaces:**
- Produces: `useDebouncedCallback<A extends unknown[]>(fn: (...a: A) => void, delayMs: number): (...a: A) => void`（卸载清 timer）。

- [ ] **Step 1: 失败测试**（fake timers）

```tsx
import { renderHook } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback"

afterEach(() => vi.useRealTimers())

describe("useDebouncedCallback", () => {
  test("coalesces rapid calls, fires once after delay with last args", () => {
    vi.useFakeTimers()
    const spy = vi.fn()
    const { result } = renderHook(() => useDebouncedCallback(spy, 300))
    result.current("a"); result.current("b"); result.current("c")
    expect(spy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith("c")
  })
})
```

- [ ] **Step 2: 确认失败** — `bunx vitest run tests/useDebouncedCallback.vitest.test.tsx` → FAIL。

- [ ] **Step 3: 实现**

```ts
import { useCallback, useEffect, useRef } from "react"

export function useDebouncedCallback<A extends Array<unknown>>(fn: (...a: A) => void, delayMs: number): (...a: A) => void {
  const fnRef = useRef(fn)
  fnRef.current = fn
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current) }, [])
  return useCallback(
    (...a: A) => {
      if (timer.current !== undefined) clearTimeout(timer.current)
      timer.current = setTimeout(() => fnRef.current(...a), delayMs)
    },
    [delayMs],
  )
}
```

- [ ] **Step 4: 确认通过** → PASS。
- [ ] **Step 5: 提交** — `git commit -- ui-v4/src/hooks/useDebouncedCallback.ts ui-v4/tests/useDebouncedCallback.vitest.test.tsx`（msg `feat(ui-v4): useDebouncedCallback`）。

---

### Task 2.2: 装依赖 + `DateRangePopover`（react-day-picker）

**Files:**
- Modify: `ui-v4/package.json`（`react-day-picker`）
- Create: [ui-v4/src/components/requests/DateRangePopover.tsx](../../src/components/requests/DateRangePopover.tsx)
- Test: `ui-v4/tests/DateRangePopover.vitest.test.tsx`

**Interfaces:**
- Produces: `DateRangePopover({ from, to, onChange }: { from: number | null; to: number | null; onChange: (from: number | null, to: number | null) => void })` —— Radix `Popover` 触发 react-day-picker range；**日界**：`from` → 选中首日 `00:00:00.000`（`setHours(0,0,0,0)`）、`to` → 末日 `23:59:59.999`（`setHours(23,59,59,999)`）。

- [ ] **Step 1: 装依赖** — Run: `cd ui-v4 && bun add react-day-picker`。确认 `package.json` + 根 `bun.lock` 更新。

- [ ] **Step 2: 失败测试** — 渲染、打开 popover、选一天 → `onChange` 收到 `[dayStart, dayEnd]`（断言 `to - from` ≈ 86399999）。react-day-picker 在 jsdom 可渲染；点击具体日 cell（用 `screen.getByRole("gridcell", ...)` 或 `getByText`）。

- [ ] **Step 3: 实现** — Radix `Popover.Root/Trigger/Portal/Content` + `<DayPicker mode="range" selected={{ from, to }} onSelect={...}>`。`onSelect` range → `onChange(startOfDay(range.from).getTime(), endOfDay(range.to ?? range.from).getTime())`。import `react-day-picker/dist/style.css` 或自写 Terminal Amber 样式（headless class override）。

```ts
function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
function endOfDay(d: Date): Date { const x = new Date(d); x.setHours(23, 59, 59, 999); return x }
```

- [ ] **Step 4: 确认通过** → PASS。
- [ ] **Step 5: 门禁 + 提交** — typecheck + eslint；`git commit -- ui-v4/package.json ui-v4/src/components/requests/DateRangePopover.tsx ui-v4/tests/DateRangePopover.vitest.test.tsx`（若根 `bun.lock` 变，一并显式 add）。msg `feat(ui-v4): DateRangePopover (react-day-picker range, day-boundary)`。

---

### Task 2.3: `RequestsFilterBar`

**Files:**
- Create: [ui-v4/src/components/requests/RequestsFilterBar.tsx](../../src/components/requests/RequestsFilterBar.tsx)
- Test: `ui-v4/tests/RequestsFilterBar.vitest.test.tsx`

**Interfaces:**
- Consumes: `RequestFilters`（Task 1.1）；`FilterSelect`（Task 1.4）；`useDebouncedCallback`（2.1）；`DateRangePopover`（2.2）；`TERMINAL_STATES`（1.1）。
- Produces: `RequestsFilterBar({ filters, setFilter, columnMenuSlot }: { filters: RequestFilters; setFilter: <K extends keyof RequestFilters>(k: K, v: RequestFilters[K]) => void; columnMenuSlot?: React.ReactNode })`。

**要点**：
- search / model 文本 input：**本地态** `useState`（即时反馈）+ `useDebouncedCallback((v) => setFilter("search", v), 300)`；`useEffect` 当 `filters.search` 外部清空（chip/clearAll）时回填本地态。
- pid：number input，防抖，空→null、NaN→null。
- endpoint：`FilterSelect`，options = 4 端点（`anthropic-messages`/`openai-chat-completions`/`openai-responses`/`gemini-generate-content`）。
- state：`FilterSelect`，options = **`TERMINAL_STATES`**（只列终态——红线 3；列表 terminalOnly，非终态会被全滤）。
- 时间：`<DateRangePopover from={filters.from} to={filters.to} onChange={(f,t)=>{ setFilter("from",f); setFilter("to",t) }} />`。
- `columnMenuSlot`：Phase 3 传入列可见性菜单（本阶段调用方先传 `null`）。
- 样式镜像 [ModelsFilterBar.tsx:113-114](../../src/components/models/ModelsFilterBar.tsx) 的容器 class。

- [ ] **Step 1: 失败测试** — 改 model input（fake timers 推 300ms）→ `setFilter("model","opus")`；选 endpoint → `setFilter("endpoint", …)`；state select 只含终态（断言无 `streaming`）；外部把 `filters.model` 置空 → 本地 input 清空。
- [ ] **Step 2: 确认失败** → FAIL。
- [ ] **Step 3: 实现**（按上述要点）。
- [ ] **Step 4: 确认通过** → PASS。
- [ ] **Step 5: 门禁 + 提交** — msg `feat(ui-v4): RequestsFilterBar (6 dims + date range + terminal-only state)`。

---

### Task 2.4: `RequestFilterChips`

**Files:**
- Create: [ui-v4/src/components/requests/RequestFilterChips.tsx](../../src/components/requests/RequestFilterChips.tsx)
- Test: `ui-v4/tests/RequestFilterChips.vitest.test.tsx`

**Interfaces:**
- Consumes: `RequestFilters`/`activeChips`（1.1）。
- Produces: `RequestFilterChips({ filters, clearFilter, clearAll }: { filters: RequestFilters; clearFilter: (k: keyof RequestFilters) => void; clearAll: () => void })` —— 无激活维度返回 `null`。

- [ ] **Step 1: 失败测试** — 给 `{ model:"opus", pid:7 }`：渲染 2 chip + "Clear all"；点 model chip × → `clearFilter("model")`；点 Clear all → `clearAll`；`EMPTY_FILTERS` → 渲染 `null`（`container.firstChild` 为 null）。
- [ ] **Step 2: 确认失败** → FAIL。
- [ ] **Step 3: 实现** — map `activeChips(filters)` → 每 chip 一个可关闭 pill（× 调 `clearFilter(chip.key)`）；末尾 "Clear all" 按钮。注意 time chip 的 key 可能是 `from` 或 `to`，`clearFilter` 需**同时清 from+to**：给 time chip 特判 → `clearFilter("from"); clearFilter("to")`（或加一个 `clearTimeRange` 分支）。样式镜像老 `ui/` filter-chips。
- [ ] **Step 4: 确认通过** → PASS。
- [ ] **Step 5: 提交** — msg `feat(ui-v4): RequestFilterChips (closable + clear all)`。

---

### Task 2.5: 挂进 `RequestsListPage`

**Files:**
- Modify: [ui-v4/src/components/requests/RequestsListPage.tsx](../../src/components/requests/RequestsListPage.tsx)
- Modify: [ui-v4/src/components/requests/HistoryList.tsx](../../src/components/requests/HistoryList.tsx)（接收 `filters` prop，传给 `useHistoryInfinite`）
- Test: `ui-v4/tests/RequestsListPage.vitest.test.tsx`（或扩展现有）

**Interfaces:**
- `RequestsListPage` 调 `useRequestFilters()`，渲染 `<RequestsFilterBar filters setFilter columnMenuSlot={null} />` + `<RequestFilterChips filters clearFilter clearAll />` + `<LiveLane/>` + `<HistoryList filters={filters} />`。
- `HistoryList` 新增 `filters: RequestFilters` prop，`useHistoryInfinite(filters)`。

- [ ] **Step 1: 失败测试** — 渲染 Page（含 MemoryRouter + QueryClient），改一维筛选 → 断言触发新的 entries 请求（mock `api.get`，断言 URL 含 `endpoint=…`）。
- [ ] **Step 2: 确认失败** → FAIL。
- [ ] **Step 3: 实现** — 接线（`HistoryList` 现无 `filters` 参数，`useHistoryInfinite()` 改 `useHistoryInfinite(filters)`）。
- [ ] **Step 4: 确认通过** → PASS。
- [ ] **Step 5: 门禁 + 提交** — typecheck + eslint + 相关 vitest；msg `feat(ui-v4): wire filter bar + chips into RequestsListPage`。

---

**Phase 2 完成判据**：七维筛选可用（改任一维 → URL 变 → 列表 refetch）；state 只列终态；时间范围日界正确；chips 可单清/全清。全绿。
