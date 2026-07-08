# Phase 1 — 筛选基座（纯逻辑 + hook + 接线）

**依赖**：无（可并行 Phase 0）。**消费方**：Phase 2、3、4。

**Goal:** `request-filters.ts`（纯逻辑，含 `matchesGating`）+ `useRequestFilters`（URL ⇄ filters）+ `FilterSelect` 抽到 shared + `useHistoryInfinite` 接 filters 进 queryKey + WS 门控。

**红线**：`matchesGating` 同构后端 `summaryMatchesFilters`，**绝不含 search 维**；WS 门控判定顺序互斥（先原地更新、再新终态）。

---

### Task 1.1: `request-filters.ts` — 纯筛选逻辑模块

**Files:**
- Create: [ui-v4/src/lib/request-filters.ts](../../src/lib/request-filters.ts)
- Test: `ui-v4/src/lib/request-filters.bun.test.ts`

**Interfaces:**
- Consumes: `EntrySummary`（`@/types`）。
- Produces:
  - `interface RequestFilters { search: string; model: string; endpoint: string | null; state: string | null; pid: number | null; sessionId: string | null; from: number | null; to: number | null }`
  - `EMPTY_FILTERS: RequestFilters`
  - `parseFilters(sp: URLSearchParams): RequestFilters`
  - `serializeFilters(f: RequestFilters): URLSearchParams`（空值省略键，**不含** `at`）
  - `toQueryString(f: RequestFilters): string`
  - `activeChips(f: RequestFilters): Array<{ key: ChipKey; label: string }>`（`ChipKey = keyof RequestFilters`）
  - `hasAnyFilter(f: RequestFilters): boolean`
  - `matchesGating(e: EntrySummary, f: RequestFilters): boolean`（**无 search 维**）
  - `TERMINAL_STATES: ReadonlyArray<string>`（供 filter bar 的 state 选项）

- [ ] **Step 1: 写失败测试** — `request-filters.bun.test.ts`

```ts
import { describe, expect, test } from "bun:test"

import type { EntrySummary } from "@/types"

import { activeChips, EMPTY_FILTERS, hasAnyFilter, matchesGating, parseFilters, serializeFilters, toQueryString } from "@/lib/request-filters"

function sum(o: Partial<EntrySummary> = {}): EntrySummary {
  return { id: "x", startedAt: 1000, endpoint: "anthropic-messages", messageCount: 0, previewText: "", ...o } as EntrySummary
}

describe("request-filters", () => {
  test("parse ⇄ serialize round-trip is idempotent", () => {
    const f = { search: "hi", model: "opus", endpoint: "anthropic-messages", state: "completed", pid: 42, sessionId: "s1", from: 1000, to: 2000 }
    const sp = serializeFilters(f)
    expect(parseFilters(sp)).toEqual(f)
    // round-trip through query string too
    expect(parseFilters(new URLSearchParams(toQueryString(f)))).toEqual(f)
  })

  test("empty values omit keys; EMPTY parses back to EMPTY", () => {
    expect(serializeFilters(EMPTY_FILTERS).toString()).toBe("")
    expect(parseFilters(new URLSearchParams(""))).toEqual(EMPTY_FILTERS)
  })

  test("serialize ignores an unrelated `at` param on parse", () => {
    expect(parseFilters(new URLSearchParams("at=abc&model=opus")).model).toBe("opus")
  })

  test("activeChips lists only set dims", () => {
    expect(activeChips(EMPTY_FILTERS)).toEqual([])
    const keys = activeChips({ ...EMPTY_FILTERS, model: "opus", pid: 7 }).map((c) => c.key)
    expect(keys).toEqual(["model", "pid"])
  })

  test("hasAnyFilter", () => {
    expect(hasAnyFilter(EMPTY_FILTERS)).toBe(false)
    expect(hasAnyFilter({ ...EMPTY_FILTERS, search: "x" })).toBe(true)
  })

  describe("matchesGating (mirrors backend summaryMatchesFilters, NO search dim)", () => {
    test("endpoint / state / pid / sessionId", () => {
      const e = sum({ endpoint: "openai-chat-completions", state: "failed", pid: 9, sessionId: "s2" })
      expect(matchesGating(e, { ...EMPTY_FILTERS, endpoint: "openai-chat-completions" })).toBe(true)
      expect(matchesGating(e, { ...EMPTY_FILTERS, endpoint: "anthropic-messages" })).toBe(false)
      expect(matchesGating(e, { ...EMPTY_FILTERS, state: "failed" })).toBe(true)
      expect(matchesGating(e, { ...EMPTY_FILTERS, pid: 9 })).toBe(true)
      expect(matchesGating(e, { ...EMPTY_FILTERS, pid: 8 })).toBe(false)
      expect(matchesGating(e, { ...EMPTY_FILTERS, sessionId: "s2" })).toBe(true)
    })
    test("model matches request or response model (substring, case-insensitive)", () => {
      const e = sum({ requestModel: "claude-OPUS-4-7", responseModel: "claude-opus-4-7" })
      expect(matchesGating(e, { ...EMPTY_FILTERS, model: "opus" })).toBe(true)
      expect(matchesGating(e, { ...EMPTY_FILTERS, model: "gpt" })).toBe(false)
    })
    test("from/to on startedAt", () => {
      const e = sum({ startedAt: 1500 })
      expect(matchesGating(e, { ...EMPTY_FILTERS, from: 1000, to: 2000 })).toBe(true)
      expect(matchesGating(e, { ...EMPTY_FILTERS, from: 1600 })).toBe(false)
      expect(matchesGating(e, { ...EMPTY_FILTERS, to: 1400 })).toBe(false)
    })
    test("search dim is IGNORED (never gates) — preview substring must NOT filter here", () => {
      const e = sum({ previewText: "no needle here" })
      expect(matchesGating(e, { ...EMPTY_FILTERS, search: "needle" })).toBe(true)
      expect(matchesGating(e, { ...EMPTY_FILTERS, search: "zzz" })).toBe(true)
    })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ui-v4 && bun test src/lib/request-filters.bun.test.ts`
Expected: FAIL —— module not found。

- [ ] **Step 3: 实现** — `request-filters.ts`

```ts
import type { EntrySummary } from "@/types"

export interface RequestFilters {
  search: string
  model: string
  endpoint: string | null
  state: string | null
  pid: number | null
  sessionId: string | null
  from: number | null
  to: number | null
}

export type ChipKey = keyof RequestFilters

/** Terminal lifecycle states — the only ones the History list (terminalOnly) shows. */
export const TERMINAL_STATES = ["completed", "failed", "aborted", "interrupted"] as const

export const EMPTY_FILTERS: RequestFilters = {
  search: "",
  model: "",
  endpoint: null,
  state: null,
  pid: null,
  sessionId: null,
  from: null,
  to: null,
}

export function parseFilters(sp: URLSearchParams): RequestFilters {
  const num = (v: string | null): number | null => {
    if (v === null || v.trim() === "") return null
    const n = Number.parseInt(v, 10)
    return Number.isNaN(n) ? null : n
  }
  return {
    search: sp.get("search") ?? "",
    model: sp.get("model") ?? "",
    endpoint: sp.get("endpoint") || null,
    state: sp.get("state") || null,
    pid: num(sp.get("pid")),
    sessionId: sp.get("sessionId") || null,
    from: num(sp.get("from")),
    to: num(sp.get("to")),
  }
}

export function serializeFilters(f: RequestFilters): URLSearchParams {
  const sp = new URLSearchParams()
  if (f.search) sp.set("search", f.search)
  if (f.model) sp.set("model", f.model)
  if (f.endpoint) sp.set("endpoint", f.endpoint)
  if (f.state) sp.set("state", f.state)
  if (f.pid !== null) sp.set("pid", String(f.pid))
  if (f.sessionId) sp.set("sessionId", f.sessionId)
  if (f.from !== null) sp.set("from", String(f.from))
  if (f.to !== null) sp.set("to", String(f.to))
  return sp
}

export function toQueryString(f: RequestFilters): string {
  return serializeFilters(f).toString()
}

export function hasAnyFilter(f: RequestFilters): boolean {
  return f.search !== "" || f.model !== "" || f.endpoint !== null || f.state !== null || f.pid !== null || f.sessionId !== null || f.from !== null || f.to !== null
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function activeChips(f: RequestFilters): Array<{ key: ChipKey; label: string }> {
  const chips: Array<{ key: ChipKey; label: string }> = []
  if (f.search) chips.push({ key: "search", label: `search: ${f.search}` })
  if (f.model) chips.push({ key: "model", label: `model: ${f.model}` })
  if (f.endpoint) chips.push({ key: "endpoint", label: `endpoint: ${f.endpoint}` })
  if (f.state) chips.push({ key: "state", label: `state: ${f.state}` })
  if (f.pid !== null) chips.push({ key: "pid", label: `pid: ${f.pid}` })
  if (f.sessionId) chips.push({ key: "sessionId", label: `session: ${f.sessionId.slice(0, 12)}…` })
  if (f.from !== null || f.to !== null) {
    const lo = f.from !== null ? fmtDate(f.from) : "…"
    const hi = f.to !== null ? fmtDate(f.to) : "…"
    chips.push({ key: f.from !== null ? "from" : "to", label: `time: ${lo} → ${hi}` })
  }
  return chips
}

/**
 * Client-side gating for WS-arriving summaries + `?at=` membership — mirrors the
 * backend `summaryMatchesFilters` (queries.ts): sessionId/endpoint/from/to/model/
 * state/pid. The `search` dimension is DELIBERATELY excluded (backend gates search
 * as full-text for in-flight and preview_text LIKE for persisted; a preview
 * substring here would diverge). search filtering happens only at the SQL layer.
 */
export function matchesGating(e: EntrySummary, f: RequestFilters): boolean {
  if (f.sessionId && e.sessionId !== f.sessionId) return false
  if (f.endpoint && e.endpoint !== f.endpoint) return false
  if (f.from !== null && e.startedAt < f.from) return false
  if (f.to !== null && e.startedAt > f.to) return false
  if (f.model) {
    const needle = f.model.toLowerCase()
    const req = e.requestModel?.toLowerCase() ?? ""
    const res = e.responseModel?.toLowerCase() ?? ""
    if (!req.includes(needle) && !res.includes(needle)) return false
  }
  if (f.state && e.state !== f.state) return false
  if (f.pid !== null && e.pid !== f.pid) return false
  return true
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ui-v4 && bun test src/lib/request-filters.bun.test.ts`
Expected: PASS。

- [ ] **Step 5: 门禁 + 提交**

Run: `cd ui-v4 && bun run typecheck && bunx eslint src/lib/request-filters.ts src/lib/request-filters.bun.test.ts`
```bash
git add -- ui-v4/src/lib/request-filters.ts ui-v4/src/lib/request-filters.bun.test.ts
git commit -F <msgfile> -- ui-v4/src/lib/request-filters.ts ui-v4/src/lib/request-filters.bun.test.ts
# msg: "feat(ui-v4): request-filters pure module (parse/serialize/chips/matchesGating)"
```

---

### Task 1.2: `useRequestFilters` — URL ⇄ RequestFilters 桥（保留 `?at=`）

**Files:**
- Create: [ui-v4/src/hooks/useRequestFilters.ts](../../src/hooks/useRequestFilters.ts)
- Test: `ui-v4/tests/useRequestFilters.vitest.test.tsx`

**Interfaces:**
- Consumes: `useSearchParams`（react-router-dom）；`RequestFilters`/`parseFilters`/`serializeFilters`/`EMPTY_FILTERS`（Task 1.1）。
- Produces: `useRequestFilters(): { filters: RequestFilters; setFilter: <K extends keyof RequestFilters>(k: K, v: RequestFilters[K]) => void; clearFilter: (k: keyof RequestFilters) => void; clearAll: () => void }`。**写回 URL 时保留 `at` 键**。

- [ ] **Step 1: 写失败测试** — `tests/useRequestFilters.vitest.test.tsx`（用 `MemoryRouter` + 一个探针组件读回 filters；点击按钮调 setFilter，断言 URL 变、`at` 保留）

```tsx
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter, useSearchParams } from "react-router-dom"
import { describe, expect, test } from "vitest"

import { useRequestFilters } from "@/hooks/useRequestFilters"

function Probe() {
  const { filters, setFilter, clearFilter, clearAll } = useRequestFilters()
  const [sp] = useSearchParams()
  return (
    <div>
      <span data-testid="model">{filters.model}</span>
      <span data-testid="at">{sp.get("at") ?? ""}</span>
      <button onClick={() => setFilter("model", "opus")}>set</button>
      <button onClick={() => clearFilter("model")}>clear</button>
      <button onClick={() => clearAll()}>clearAll</button>
    </div>
  )
}

describe("useRequestFilters", () => {
  test("setFilter reflects into URL and preserves ?at=", () => {
    render(
      <MemoryRouter initialEntries={["/requests?at=abc"]}>
        <Probe />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByText("set"))
    expect(screen.getByTestId("model").textContent).toBe("opus")
    expect(screen.getByTestId("at").textContent).toBe("abc") // at preserved
    fireEvent.click(screen.getByText("clear"))
    expect(screen.getByTestId("model").textContent).toBe("")
    expect(screen.getByTestId("at").textContent).toBe("abc")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ui-v4 && bunx vitest run tests/useRequestFilters.vitest.test.tsx`
Expected: FAIL —— hook not found。

- [ ] **Step 3: 实现** — `useRequestFilters.ts`

```ts
import { useCallback, useMemo } from "react"
import { useSearchParams } from "react-router-dom"

import type { RequestFilters } from "@/lib/request-filters"

import { EMPTY_FILTERS, parseFilters, serializeFilters } from "@/lib/request-filters"

/** Filter keys owned by this hook — everything else in the URL (notably `at`) is preserved. */
const FILTER_KEYS: ReadonlyArray<keyof RequestFilters> = ["search", "model", "endpoint", "state", "pid", "sessionId", "from", "to"]

export function useRequestFilters() {
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = useMemo(() => parseFilters(searchParams), [searchParams])

  // Write a whole RequestFilters back into the URL, preserving non-filter params (at).
  const write = useCallback(
    (next: RequestFilters) => {
      setSearchParams(
        (prev) => {
          const sp = new URLSearchParams(prev)
          for (const k of FILTER_KEYS) sp.delete(k)
          for (const [k, v] of serializeFilters(next)) sp.set(k, v)
          return sp
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const setFilter = useCallback(
    <K extends keyof RequestFilters>(k: K, v: RequestFilters[K]) => write({ ...filters, [k]: v }),
    [filters, write],
  )
  const clearFilter = useCallback((k: keyof RequestFilters) => write({ ...filters, [k]: EMPTY_FILTERS[k] }), [filters, write])
  const clearAll = useCallback(() => write(EMPTY_FILTERS), [write])

  return { filters, setFilter, clearFilter, clearAll }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ui-v4 && bunx vitest run tests/useRequestFilters.vitest.test.tsx`
Expected: PASS。

- [ ] **Step 5: 门禁 + 提交**

```bash
git add -- ui-v4/src/hooks/useRequestFilters.ts ui-v4/tests/useRequestFilters.vitest.test.tsx
git commit -F <msgfile> -- ui-v4/src/hooks/useRequestFilters.ts ui-v4/tests/useRequestFilters.vitest.test.tsx
# msg: "feat(ui-v4): useRequestFilters — URL-as-SSOT filter bridge (preserves ?at=)"
```

---

### Task 1.3: `useHistoryInfinite` 接 filters + WS 门控（顺序互斥）+ isError

**Files:**
- Modify: [ui-v4/src/hooks/useHistoryInfinite.ts](../../src/hooks/useHistoryInfinite.ts)
- Modify: [ui-v4/src/components/requests/HistoryList.tsx](../../src/components/requests/HistoryList.tsx)（临时把调用改为 `useHistoryInfinite(EMPTY_FILTERS)` 保 typecheck 绿）
- Test: `ui-v4/tests/useHistoryInfinite.vitest.test.tsx`（新建）

**Interfaces:**
- Consumes: `RequestFilters`/`toQueryString`/`matchesGating`（Task 1.1）；`isTerminalSummary`（[activity-row.ts](../../src/lib/activity-row.ts)）。
- Produces: `useHistoryInfinite(filters: RequestFilters)` —— 返回现有字段 + `isError`/`error`/`refetch`；`queryKey = ["history-infinite", toQueryString(filters)]`；`queryFn` 拼接筛选。

- [ ] **Step 1: 写失败测试** — 门控顺序 + 不匹配不入列（用 QueryClient + mock WS callbacks；断言：新终态且 gating 不命中 → 不 invalidate/不 buffer；已在列表内的 updated → setQueryData 原地更新且不进 buffer）。参考现有 `tests/*infinite*` / WS 测试的 harness；核心断言：

```tsx
// pseudo-structure — adapt to existing WS test harness in tests/
test("WS terminal entry NOT matching filters is ignored (no invalidate, no buffer)", () => {
  // render useHistoryInfinite({ ...EMPTY_FILTERS, endpoint: "anthropic-messages" }) with tailOn
  // fire onEntryUpdated(summary{ endpoint: "openai-chat-completions", state: "completed" })
  // expect: dispatch not called with kind "incoming"
})

test("in-list entry_updated updates in place BEFORE terminal gating (no double dispatch)", () => {
  // seed query cache with entry id "e1"; fire onEntryUpdated(summary{ id: "e1", late usage })
  // expect: setQueryData replaced row e1; dispatch NOT called with "incoming"
})
```

> 注：若现有 WS 测试基建不足以驱动，最小化为直接单测抽出的纯函数 `gateIncoming(summary, filters, loadedIds)` → 返回 `"inplace" | "incoming" | "ignore"`，在 hook 内消费。**推荐抽这个纯函数**（更可测、无 React）：放 request-filters.ts 或 hook 同文件 export。

- [ ] **Step 2: 跑测试确认失败** — `bunx vitest run tests/useHistoryInfinite.vitest.test.tsx` → FAIL。

- [ ] **Step 3: 实现** — useHistoryInfinite.ts 关键改动

```ts
// signature
export function useHistoryInfinite(filters: RequestFilters) {
  // ...
  const query = useInfiniteQuery({
    queryKey: ["history-infinite", toQueryString(filters)] as const,
    queryFn: ({ pageParam }) => {
      const base = `/history/api/entries?limit=50&terminalOnly=true`
      const filterQs = toQueryString(filters)
      const page = pageParam ? `&cursor=${pageParam}&direction=older` : ""
      return api.get<SummaryResult>(`${base}${filterQs ? `&${filterQs}` : ""}${page}`)
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: SummaryResult) => last.nextCursor ?? undefined,
  })

  // decide incoming disposition — order matters (in-place BEFORE terminal gate).
  const onEntrySettled = useCallback(
    (s: EntrySummary) => {
      const loaded = queryClient.getQueryData<{ pages: Array<SummaryResult> }>(["history-infinite", toQueryString(filters)])
      const inList = loaded?.pages.some((p) => p.entries.some((e) => e.id === s.id)) ?? false
      if (inList) {
        // 1) already in the list → update in place regardless of tail; do NOT also buffer.
        queryClient.setQueryData<{ pages: Array<SummaryResult> }>(["history-infinite", toQueryString(filters)], (old) =>
          !old ? old : {
            ...old,
            pages: old.pages.map((p) => ({ ...p, entries: p.entries.map((e) => (e.id === s.id ? s : e)) })),
          },
        )
        return
      }
      // 2) new entry entering the list → terminal + gating (NO search dim).
      if (!isTerminalSummary(s)) return
      if (!matchesGating(s, filters)) return
      dispatch({ kind: "incoming", id: s.id })
      if (tailOn) void queryClient.invalidateQueries({ queryKey: ["history-infinite", toQueryString(filters)] })
    },
    [dispatch, tailOn, queryClient, filters],
  )
  // ...
  return { ...query, entries, total, isError: query.isError, error: query.error, refetch: query.refetch }
}
```

（`queryKey` 现在含 filters，Task 内所有 `HISTORY_KEY` 引用改为 `["history-infinite", toQueryString(filters)]`；`bufferedCount` effect 的 invalidate key 同步。import 补 `matchesGating`/`toQueryString`/`RequestFilters`/`EMPTY_FILTERS`。）

**避免半坏中间态**：本 task 把 `useHistoryInfinite` 签名从无参改为 `(filters)`，其现有唯一调用方 [HistoryList.tsx](../../src/components/requests/HistoryList.tsx) 仍是 `useHistoryInfinite()` → 会 typecheck 失败。故本 task **同时**把 HistoryList 的调用改为 `useHistoryInfinite(EMPTY_FILTERS)`（临时占位，Phase 2 Task 2.5 再换成真实 `filters` prop）。这样 Phase 1 结束时 typecheck 保持绿。

- [ ] **Step 4: 跑测试确认通过** — PASS。

- [ ] **Step 5: 门禁 + 提交**

```bash
git add -- ui-v4/src/hooks/useHistoryInfinite.ts ui-v4/src/components/requests/HistoryList.tsx ui-v4/tests/useHistoryInfinite.vitest.test.tsx
git commit -F <msgfile> -- ui-v4/src/hooks/useHistoryInfinite.ts ui-v4/src/components/requests/HistoryList.tsx ui-v4/tests/useHistoryInfinite.vitest.test.tsx
# msg: "feat(ui-v4): useHistoryInfinite consumes filters (queryKey) + gated WS + isError"
```

---

### Task 1.4: 抽取 `FilterSelect` 到 shared（Models + Requests 共用）

**Files:**
- Create: [ui-v4/src/components/shared/FilterSelect.tsx](../../src/components/shared/FilterSelect.tsx)
- Modify: [ui-v4/src/components/models/ModelsFilterBar.tsx](../../src/components/models/ModelsFilterBar.tsx)（删内联 `FilterSelect`，import shared）

**Interfaces:**
- Produces: `FilterSelect({ label, value, onChange, allLabel, options }: { label: string; value: string | null; onChange: (v: string | null) => void; allLabel: string; options: ReadonlyArray<{ value: string; label: string }> })`（逐字移自 ModelsFilterBar，sentinel `__all__`）。

- [ ] **Step 1: 建 shared 组件** — 把 [ModelsFilterBar.tsx:27-92](../../src/components/models/ModelsFilterBar.tsx)（`TRIGGER_CLASS`/`ITEM_CLASS`/`ALL`/`FilterSelect`）原样移入 `shared/FilterSelect.tsx` 并 export。

- [ ] **Step 2: ModelsFilterBar 改用 shared** — 删其内联定义，改 `import { FilterSelect } from "@/components/shared/FilterSelect"`。

- [ ] **Step 3: 回归** — Run: `cd ui-v4 && bun run typecheck && bunx vitest run tests/ModelsFilterBar.vitest.test.tsx`（若存在）；确认 Models 筛选行为不变。

- [ ] **Step 4: 提交**

```bash
git add -- ui-v4/src/components/shared/FilterSelect.tsx ui-v4/src/components/models/ModelsFilterBar.tsx
git commit -F <msgfile> -- ui-v4/src/components/shared/FilterSelect.tsx ui-v4/src/components/models/ModelsFilterBar.tsx
# msg: "refactor(ui-v4): extract shared FilterSelect (Radix Select) from ModelsFilterBar"
```

---

**Phase 1 完成判据**：`request-filters` bun test 全绿（含 search 维不门控的正样本证）；`useRequestFilters` URL 双向 + `?at=` 保留；`useHistoryInfinite` filters 进 queryKey + 门控顺序互斥 + isError；`FilterSelect` 共享。typecheck + eslint 绿。
