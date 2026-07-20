# ui-v4 模型列表页对齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 ui-v4 模型列表页相对 Vue `ui/` 的 8 项回退，使其达到并超越 Vue 版，为下线 `/ui` 列表页扫清障碍。

**Architecture:** 纯前端改动，集中在 ui-v4 模型列表相关文件。过滤逻辑加两维（endpoint/billingRange）走既有 `filterModels`；列渲染改 `model-table-columns.tsx`；错误/空/头部改 `ModelsPage.tsx`；筛选控件改 `ModelsFilterBar.tsx`。数据源复用后端 SSOT（`getEffectiveEndpoints`、`DerivedCapabilities`），不移植 Vue 重复 util。

**Tech Stack:** React 19 + TypeScript、TanStack Table、`radix-ui`（Select/Slider）、TanStack Query、vitest + @testing-library/react（组件）、bun test（纯函数）。

**Spec:** [docs/spec/2026-07-08-ui-v4-models-list-parity.md](../spec/2026-07-08-ui-v4-models-list-parity.md)（含附录 A 验收 oracle）。

## Global Constraints

- 语言/风格：面向开发者文字用中文，技术标识符/代码保持英文；不硬折行。→ 项目 CLAUDE.md。
- 数据源 SSOT：endpoint 用后端 `getEffectiveEndpoints`（`src/lib/models/endpoint.ts`），能力用 `deriveCapabilities`/`DerivedCapabilities`（`src/lib/models/capabilities.ts`）——**禁止**在 ui-v4 新建重复实现。
- `~backend/*` re-export 纯度：`ui-v4/src` 组件/lib 不得 import `~/lib/state`；交付必须跑 `bun run build:ui-v4`（typecheck + vitest 会假绿，rollup 才暴露）。
- Billing 缺失-multiplier 语义：`typeof m.billing?.multiplier !== "number"` 时**当作 0**（对齐 Vue）。
- 无新第三方依赖：Slider 用已装的 `radix-ui`（v1.6.1）导出的 `Slider`。
- 测试隔离/前端坑：遵循 skill `test-isolation`、`debugging-frontend-tests`；否定断言先证正向。
- Lint：改动文件收尾 `bunx eslint <path>`（无缓存，`lint` targeted 带缓存不可信）。
- 提交：conventional commits、显式 pathspec、无模型署名。→ 项目 CLAUDE.md。
- 纯函数测试放 `ui-v4/tests/*.bun.test.ts`；组件测试放 `ui-v4/tests/*.vitest.test.tsx`。

---

## File Structure

- `ui-v4/src/lib/model-filters.ts` — 加 `endpoint`/`billingRange` 两维、对应谓词、`modelBillingBounds`、`countActiveFilters`。
- `ui-v4/src/lib/vendor-color.ts`（新建）— `vendorColor(vendor)` 映射。
- `ui-v4/src/lib/model-thinking.ts`（新建）— `thinkingLabel(caps)` 派生 `≤N`/`adaptive`/`""`。
- `ui-v4/src/components/models/ModelsFilterBar.tsx` — endpoint select、billing slider、active-count chip + clear-all。
- `ui-v4/src/components/models/ModelsPage.tsx` — options 加 endpoints、错误分支、空态区分、头部计数、传 bounds。
- `ui-v4/src/components/models/model-table-columns.tsx` — thinking 单元格特判、vendor 彩色 chip。
- `ui-v4/src/components/shared/RangeSlider.tsx`（新建）— Radix Slider 包装（Terminal Amber）。
- 测试：`ui-v4/tests/model-filters.bun.test.ts`（扩展）、`ui-v4/tests/vendor-color.bun.test.ts`、`ui-v4/tests/model-thinking.bun.test.ts`、`ui-v4/tests/ModelsFilterBar.vitest.test.tsx`（扩展）、`ui-v4/tests/ModelsPage.vitest.test.tsx`（扩展）、`ui-v4/tests/ModelsTable.vitest.test.tsx`（扩展）。

---

## Task 1: Endpoint 筛选

**Files:**
- Modify: `ui-v4/src/lib/model-filters.ts`
- Modify: `ui-v4/src/components/models/ModelsPage.tsx`
- Modify: `ui-v4/src/components/models/ModelsFilterBar.tsx`
- Test: `ui-v4/tests/model-filters.bun.test.ts`

**Interfaces:**
- Consumes: `getEffectiveEndpoints(model)` from `~backend/lib/models/endpoint`（返回 `Array<string> | undefined`）。
- Produces: `ModelFilters.endpoint: string | null`；`matchesEndpoint(model, value)`；`FilterOptions.endpoints: Array<string>`。

- [ ] **Step 1: 写失败测试**（`ui-v4/tests/model-filters.bun.test.ts`，在既有文件追加）

```ts
import { matchesEndpoint } from "@/lib/model-filters"

const modelWith = (over: Partial<Model>): Model => ({ id: "m", name: "m", vendor: "v", ...over }) as Model

test("matchesEndpoint: null = any", () => {
  expect(matchesEndpoint(modelWith({ supported_endpoints: ["/responses"] }), null)).toBe(true)
})
test("matchesEndpoint: explicit supported_endpoints", () => {
  expect(matchesEndpoint(modelWith({ supported_endpoints: ["/responses"] }), "/responses")).toBe(true)
  expect(matchesEndpoint(modelWith({ supported_endpoints: ["/responses"] }), "/chat/completions")).toBe(false)
})
test("matchesEndpoint: inferred from capabilities.type when supported_endpoints absent", () => {
  expect(matchesEndpoint(modelWith({ capabilities: { type: "chat" } as Model["capabilities"] }), "/chat/completions")).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ui-v4 && bunx vitest run tests/model-filters.bun.test.ts` （或仓库根 `bun test ui-v4/tests/model-filters.bun.test.ts`，按现有该文件运行方式）
Expected: FAIL —「matchesEndpoint is not exported」。

- [ ] **Step 3: 实现**（`ui-v4/src/lib/model-filters.ts`）

顶部加 import：
```ts
import { getEffectiveEndpoints } from "~backend/lib/models/endpoint"
```
`ModelFilters` 接口加字段（放 `type` 后）：
```ts
  endpoint: string | null
```
`EMPTY_FILTERS` 加：
```ts
  endpoint: null,
```
加谓词（放 `matchesPolicyState` 附近）：
```ts
export function matchesEndpoint(model: Model, value: string | null): boolean {
  if (value === null) return true
  return getEffectiveEndpoints(model)?.includes(value) ?? false
}
```
`filterModels` 内加一行（`matchesPolicyState` 判断后）：
```ts
    if (!matchesEndpoint(m, filters.endpoint)) return false
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS。

- [ ] **Step 5: 接线 options + 控件**

`ModelsPage.tsx` 顶部 import：
```ts
import { getEffectiveEndpoints } from "~backend/lib/models/endpoint"
```
`options` useMemo 内加：
```ts
      endpoints: [...new Set(models.flatMap((m) => getEffectiveEndpoints(m) ?? []))].sort(),
```
`ModelsFilterBar.tsx` 的 `FilterOptions` 加 `endpoints: Array<string>`；在 Type 的 `FilterSelect` 后加：
```tsx
      <FilterSelect
        label="Endpoint"
        value={filters.endpoint}
        onChange={(v) => onChange({ endpoint: v })}
        allLabel="all endpoints"
        options={options.endpoints.map((e) => ({ value: e, label: e }))}
      />
```

- [ ] **Step 6: typecheck + lint**

Run: `bun run typecheck && bunx eslint ui-v4/src/lib/model-filters.ts ui-v4/src/components/models/ModelsPage.tsx ui-v4/src/components/models/ModelsFilterBar.tsx`
Expected: 无错误。

- [ ] **Step 7: 提交**

```bash
git add -- ui-v4/src/lib/model-filters.ts ui-v4/src/components/models/ModelsPage.tsx ui-v4/src/components/models/ModelsFilterBar.tsx ui-v4/tests/model-filters.bun.test.ts
git commit -m "feat(ui-v4): add endpoint filter to models list (reuse backend getEffectiveEndpoints)"
```

---

## Task 2: Billing-rate 范围滑块筛选

**Files:**
- Modify: `ui-v4/src/lib/model-filters.ts`
- Create: `ui-v4/src/components/shared/RangeSlider.tsx`
- Modify: `ui-v4/src/components/models/ModelsPage.tsx`
- Modify: `ui-v4/src/components/models/ModelsFilterBar.tsx`
- Test: `ui-v4/tests/model-filters.bun.test.ts`

**Interfaces:**
- Produces: `ModelFilters.billingRange: [number, number] | null`；`matchesBilling(model, range)`；`modelBillingBounds(models): [number, number]`；`<RangeSlider min max value onChange />`。
- Consumes（Task 5）：`billingRange` + `modelBillingBounds` 供 `countActiveFilters` 判「窄于边界」。

- [ ] **Step 1: 写失败测试**（追加到 `model-filters.bun.test.ts`）

```ts
import { matchesBilling, modelBillingBounds } from "@/lib/model-filters"

test("matchesBilling: null = any", () => {
  expect(matchesBilling(modelWith({ billing: { multiplier: 5 } as Model["billing"] }), null)).toBe(true)
})
test("matchesBilling: within range inclusive", () => {
  const m = modelWith({ billing: { multiplier: 3 } as Model["billing"] })
  expect(matchesBilling(m, [1, 5])).toBe(true)
  expect(matchesBilling(m, [4, 5])).toBe(false)
})
test("matchesBilling: missing multiplier treated as 0 (aligns Vue) → excluded when min>0", () => {
  const m = modelWith({})
  expect(matchesBilling(m, [0, 5])).toBe(true)
  expect(matchesBilling(m, [1, 5])).toBe(false)
})
test("modelBillingBounds: [min,max] over multipliers, missing=0", () => {
  expect(
    modelBillingBounds([
      modelWith({ billing: { multiplier: 2 } as Model["billing"] }),
      modelWith({ billing: { multiplier: 8 } as Model["billing"] }),
      modelWith({}),
    ]),
  ).toEqual([0, 8])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test ui-v4/tests/model-filters.bun.test.ts`。Expected: FAIL（未导出）。

- [ ] **Step 3: 实现**（`model-filters.ts`）

`ModelFilters` 加 `billingRange: [number, number] | null`；`EMPTY_FILTERS` 加 `billingRange: null,`。加：
```ts
/** Vue 语义：无 multiplier 视为 0（下界抬离 0 会排除这些模型）。 */
function billingMultiplier(model: Model): number {
  return typeof model.billing?.multiplier === "number" ? model.billing.multiplier : 0
}

export function matchesBilling(model: Model, range: [number, number] | null): boolean {
  if (range === null) return true
  const v = billingMultiplier(model)
  return v >= range[0] && v <= range[1]
}

/** 目录内 multiplier 的 [min, max]（缺失当 0）。空目录返回 [0, 0]。 */
export function modelBillingBounds(models: Array<Model>): [number, number] {
  if (models.length === 0) return [0, 0]
  let min = Infinity
  let max = -Infinity
  for (const m of models) {
    const v = billingMultiplier(m)
    if (v < min) min = v
    if (v > max) max = v
  }
  return [min, max]
}
```
`filterModels` 加一行：`if (!matchesBilling(m, filters.billingRange)) return false`。

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS。

- [ ] **Step 5: RangeSlider 组件**（`ui-v4/src/components/shared/RangeSlider.tsx`）

```tsx
import { Slider } from "radix-ui"

/** Terminal Amber 双滑块范围选择器（Radix Slider）。value=null 表示满量程。 */
export function RangeSlider({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string
  min: number
  max: number
  value: [number, number] | null
  onChange: (v: [number, number] | null) => void
}) {
  const current: [number, number] = value ?? [min, max]
  const step = max - min > 20 ? 0.5 : 0.1
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] uppercase text-[var(--color-muted)]">{label}:</span>
      <span className="text-[11px] text-[var(--color-text)]">
        {current[0]}–{current[1]}
      </span>
      <Slider.Root
        className="relative flex h-4 w-32 touch-none items-center"
        min={min}
        max={max}
        step={step}
        value={current}
        aria-label={label}
        onValueChange={([a, b]) => onChange(a <= min && b >= max ? null : [a, b])}
      >
        <Slider.Track className="relative h-[3px] grow bg-[var(--color-border)]">
          <Slider.Range className="absolute h-full bg-[var(--color-primary)]" />
        </Slider.Track>
        <Slider.Thumb className="block h-3 w-3 border border-[var(--color-primary)] bg-[var(--color-surface)]" />
        <Slider.Thumb className="block h-3 w-3 border border-[var(--color-primary)] bg-[var(--color-surface)]" />
      </Slider.Root>
    </div>
  )
}
```

- [ ] **Step 6: 接线**

`ModelsPage.tsx`：加 `import { ..., modelBillingBounds } from "@/lib/model-filters"`；`const billingBounds = useMemo(() => modelBillingBounds(models), [models])`；传给 `<ModelsFilterBar billingBounds={billingBounds} … />`。
`ModelsFilterBar.tsx`：props 加 `billingBounds: [number, number]`；import RangeSlider；在 caps 前加：
```tsx
      {options /* placeholder */ && billingBounds[1] > billingBounds[0] ?
        <RangeSlider
          label="$×"
          min={billingBounds[0]}
          max={billingBounds[1]}
          value={filters.billingRange}
          onChange={(v) => onChange({ billingRange: v })}
        />
      : null}
```
（`billingBounds[1] > billingBounds[0]` 守卫避免退化滑块。）

- [ ] **Step 7: typecheck + lint + build**

Run: `bun run typecheck && bunx eslint ui-v4/src/lib/model-filters.ts ui-v4/src/components/shared/RangeSlider.tsx ui-v4/src/components/models/ModelsFilterBar.tsx ui-v4/src/components/models/ModelsPage.tsx && bun run build:ui-v4`
Expected: 全绿。

- [ ] **Step 8: 提交**

```bash
git add -- ui-v4/src/lib/model-filters.ts ui-v4/src/components/shared/RangeSlider.tsx ui-v4/src/components/models/ModelsFilterBar.tsx ui-v4/src/components/models/ModelsPage.tsx ui-v4/tests/model-filters.bun.test.ts
git commit -m "feat(ui-v4): add billing-rate range slider filter (missing multiplier = 0, aligns Vue)"
```

---

## Task 3: 错误态渲染

**Files:**
- Modify: `ui-v4/src/components/models/ModelsPage.tsx`
- Test: `ui-v4/tests/ModelsPage.vitest.test.tsx`

**Interfaces:**
- Consumes: `useModels()` 返回的 `useQuery` 结果含 `isError`/`error`（`ui-v4/src/hooks/useModels.ts` 已是 `useQuery`）。

- [ ] **Step 1: 写失败测试**（`ModelsPage.vitest.test.tsx`，追加；参照文件顶部现有 render/mock 方式，mock `useModels` 返回错误态）

```tsx
test("renders error state distinct from empty when query fails", () => {
  mockUseModels.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error("boom") })
  renderModelsPage()
  expect(screen.getByText(/failed to load models/i)).toBeInTheDocument()
  expect(screen.queryByText(/no models match/i)).not.toBeInTheDocument()
})
```
（若现有测试未 mock `useModels`，本步同时补上 `vi.mock("@/hooks/useModels", …)` 脚手架；参照同目录 `ModelsTable.vitest.test.tsx` 的 mock 写法。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ui-v4 && bunx vitest run tests/ModelsPage.vitest.test.tsx`。Expected: FAIL（无 error 文案）。

- [ ] **Step 3: 实现**（`ModelsPage.tsx`）

解构改为：
```ts
  const { data, isLoading, isError, error } = useModels()
```
在 `if (isLoading) …` 后加：
```tsx
  if (isError)
    return (
      <div className="mono flex flex-col gap-1 p-4 text-[var(--color-fail)]">
        <div>⚠ failed to load models</div>
        <div className="text-[12px] text-[var(--color-muted)]">{error instanceof Error ? error.message : String(error)}</div>
      </div>
    )
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS。

- [ ] **Step 5: lint + 提交**

```bash
bunx eslint ui-v4/src/components/models/ModelsPage.tsx
git add -- ui-v4/src/components/models/ModelsPage.tsx ui-v4/tests/ModelsPage.vitest.test.tsx
git commit -m "feat(ui-v4): render models load error state distinct from empty result"
```

---

## Task 4: Thinking 预算/adaptive 列提示

**Files:**
- Create: `ui-v4/src/lib/model-thinking.ts`
- Modify: `ui-v4/src/components/models/model-table-columns.tsx`
- Test: `ui-v4/tests/model-thinking.bun.test.ts`, `ui-v4/tests/ModelsTable.vitest.test.tsx`

**Interfaces:**
- Consumes: `DerivedCapabilities`（`thinking`/`adaptiveThinking`/`maxThinkingBudget`）。
- Produces: `thinkingLabel(caps): { text: string; title: string }`。

- [ ] **Step 1: 写失败测试**（`model-thinking.bun.test.ts`）

```ts
import { thinkingLabel } from "@/lib/model-thinking"
import type { DerivedCapabilities } from "~backend/lib/models/capabilities"

const caps = (o: Partial<DerivedCapabilities>): DerivedCapabilities =>
  ({ thinking: false, adaptiveThinking: false, maxThinkingBudget: 0, ...o }) as DerivedCapabilities

test("no thinking → empty", () => {
  expect(thinkingLabel(caps({}))).toEqual({ text: "·", title: "no thinking" })
})
test("adaptive → adaptive", () => {
  expect(thinkingLabel(caps({ thinking: true, adaptiveThinking: true }))).toEqual({ text: "adaptive", title: "adaptive thinking" })
})
test("fixed budget → ≤N", () => {
  expect(thinkingLabel(caps({ thinking: true, maxThinkingBudget: 8192 }))).toEqual({ text: "≤8192", title: "max thinking budget 8192" })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test ui-v4/tests/model-thinking.bun.test.ts`。Expected: FAIL。

- [ ] **Step 3: 实现**（`model-thinking.ts`）

```ts
import type { DerivedCapabilities } from "~backend/lib/models/capabilities"

/** 列单元格用的 thinking 摘要：adaptive 优先，其次固定预算 ≤N，否则无。 */
export function thinkingLabel(caps: DerivedCapabilities): { text: string; title: string } {
  if (caps.adaptiveThinking) return { text: "adaptive", title: "adaptive thinking" }
  if (caps.maxThinkingBudget > 0) return { text: `≤${caps.maxThinkingBudget}`, title: `max thinking budget ${caps.maxThinkingBudget}` }
  if (caps.thinking) return { text: "✓", title: "thinking" }
  return { text: "·", title: "no thinking" }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS。

- [ ] **Step 5: thinking 列特判出通用循环**（`model-table-columns.tsx`）

从 `CAP_COLS` 删除 `{ key: "thinking", … }` 行（末行）。import `thinkingLabel`。在 `CAP_COLS.map(...)` 之后、`billing` 之前插入独立 thinking 列（保持列顺序不变——原 thinking 在 caps 末位）：
```tsx
    col.accessor((r) => r.caps.thinking, {
      id: "thinking",
      header: "Think",
      enableSorting: false,
      meta: { thClass: `${HEAD} text-center`, tdClass: "px-2 py-1 text-center text-[11px]" },
      cell: (c) => {
        const { text, title } = thinkingLabel(c.row.original.caps)
        const on = text !== "·"
        return (
          <span
            title={title}
            className={on ? "text-[var(--color-ok)]" : "text-[#3a3a42]"}
          >
            {text}
          </span>
        )
      },
    }),
```
> 注意：`thinking` 的 `id`/`ModelColumnKey` 不变，列显隐菜单/持久化键不受影响。

- [ ] **Step 6: 组件测试**（`ModelsTable.vitest.test.tsx` 追加）

```tsx
test("thinking cell shows adaptive / ≤N / · ", () => {
  // 渲染含三种 thinking 形态的模型，断言单元格文本
  // adaptive 模型 → "adaptive"；固定预算 → "≤8192"；无 → "·"
})
```
（按该测试文件既有的建模/渲染工具补全断言。）

- [ ] **Step 7: typecheck + lint + 提交**

```bash
bun run typecheck && bunx eslint ui-v4/src/lib/model-thinking.ts ui-v4/src/components/models/model-table-columns.tsx
git add -- ui-v4/src/lib/model-thinking.ts ui-v4/src/components/models/model-table-columns.tsx ui-v4/tests/model-thinking.bun.test.ts ui-v4/tests/ModelsTable.vitest.test.tsx
git commit -m "feat(ui-v4): show thinking budget/adaptive in models table cell"
```

---

## Task 5: active-filter 计数 + clear all

**Files:**
- Modify: `ui-v4/src/lib/model-filters.ts`
- Modify: `ui-v4/src/components/models/ModelsFilterBar.tsx`
- Test: `ui-v4/tests/model-filters.bun.test.ts`, `ui-v4/tests/ModelsFilterBar.vitest.test.tsx`

**Interfaces:**
- Produces: `countActiveFilters(filters, bounds): number`。billingRange 用「窄于边界」判据。

- [ ] **Step 1: 写失败测试**（追加 `model-filters.bun.test.ts`）

```ts
import { countActiveFilters, EMPTY_FILTERS } from "@/lib/model-filters"

test("countActiveFilters: empty = 0", () => {
  expect(countActiveFilters(EMPTY_FILTERS, [0, 10])).toBe(0)
})
test("countActiveFilters: scalar + array dims", () => {
  expect(countActiveFilters({ ...EMPTY_FILTERS, search: "gpt", vendor: "openai", capabilities: ["vision"] }, [0, 10])).toBe(3)
})
test("countActiveFilters: billingRange active only when narrower than bounds", () => {
  expect(countActiveFilters({ ...EMPTY_FILTERS, billingRange: [0, 10] }, [0, 10])).toBe(0)
  expect(countActiveFilters({ ...EMPTY_FILTERS, billingRange: [2, 10] }, [0, 10])).toBe(1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test ui-v4/tests/model-filters.bun.test.ts`。Expected: FAIL。

- [ ] **Step 3: 实现**（`model-filters.ts`）

```ts
/** 激活筛选维度数。billingRange 用「窄于边界」判据（对齐 Vue），避免满量程恒 active。 */
export function countActiveFilters(f: ModelFilters, bounds: [number, number]): number {
  let n = 0
  if (f.search.trim() !== "") n++
  if (f.vendor !== null) n++
  if (f.type !== null) n++
  if (f.endpoint !== null) n++
  if (f.policyState !== null) n++
  if (f.premium !== null) n++
  if (f.hasTelemetry !== null) n++
  if (f.capabilities.length > 0) n++
  if (f.restrictedTo.length > 0) n++
  if (f.billingRange !== null && (f.billingRange[0] > bounds[0] || f.billingRange[1] < bounds[1])) n++
  return n
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS。

- [ ] **Step 5: chip + clear-all**（`ModelsFilterBar.tsx`）

import `countActiveFilters` + `EMPTY_FILTERS`；props 已有 `billingBounds`。在 filter bar 末尾（caps 之后）加：
```tsx
      {(() => {
        const active = countActiveFilters(filters, billingBounds)
        if (active === 0) return null
        return (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] text-[var(--color-primary)]">{active} active</span>
            <button
              type="button"
              className="border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
              onClick={() => onChange(EMPTY_FILTERS)}
            >
              clear all
            </button>
          </div>
        )
      })()}
```
> `onChange` 现签名是 `(patch: Partial<ModelFilters>) => void`；传入完整 `EMPTY_FILTERS` 会整体覆盖所有维度（patch 合并语义下等价 reset），符合预期。

- [ ] **Step 6: 组件测试**（`ModelsFilterBar.vitest.test.tsx` 追加）：断言选中某筛选后出现「N active」，点 clear all 后 `onChange` 收到 `EMPTY_FILTERS`。

- [ ] **Step 7: lint + 提交**

```bash
bunx eslint ui-v4/src/lib/model-filters.ts ui-v4/src/components/models/ModelsFilterBar.tsx
git add -- ui-v4/src/lib/model-filters.ts ui-v4/src/components/models/ModelsFilterBar.tsx ui-v4/tests/model-filters.bun.test.ts ui-v4/tests/ModelsFilterBar.vitest.test.tsx
git commit -m "feat(ui-v4): show active-filter count + clear all (billingRange active when narrowed)"
```

---

## Task 6: 空态引导文案

**Files:**
- Modify: `ui-v4/src/components/models/ModelsPage.tsx`
- Test: `ui-v4/tests/ModelsPage.vitest.test.tsx`

- [ ] **Step 1: 写失败测试**：目录非空但筛选后为空 → 显引导文案；目录本身为空 → 显「no models」。

```tsx
test("filtered-empty shows guidance to relax filters", () => {
  // data 有模型，但设一个匹配不到的 search
  renderModelsPage(/* models present, filter excludes all */)
  expect(screen.getByText(/relax your search or clear a filter/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: 跑测试确认失败**。Run: `cd ui-v4 && bunx vitest run tests/ModelsPage.vitest.test.tsx`。Expected: FAIL。

- [ ] **Step 3: 实现**（`ModelsPage.tsx`）空分支改为区分：

```tsx
              {visible.length === 0 ?
                <div className="p-4 text-[#888]">
                  {models.length === 0 ?
                    "No models in the catalog."
                  : <>
                      No models match the current filters.
                      <div className="mt-1 text-[12px] text-[var(--color-muted)]">Try relaxing your search or clearing a filter.</div>
                    </>
                  }
                </div>
              : <ModelsTable … />}
```

- [ ] **Step 4: 跑测试确认通过**。Run: 同 Step 2。Expected: PASS。

- [ ] **Step 5: lint + 提交**

```bash
bunx eslint ui-v4/src/components/models/ModelsPage.tsx
git add -- ui-v4/src/components/models/ModelsPage.tsx ui-v4/tests/ModelsPage.vitest.test.tsx
git commit -m "feat(ui-v4): distinguish empty catalog vs filtered-empty with guidance"
```

---

## Task 7: Vendor 颜色 chip

**Files:**
- Create: `ui-v4/src/lib/vendor-color.ts`
- Modify: `ui-v4/src/components/models/model-table-columns.tsx`
- Test: `ui-v4/tests/vendor-color.bun.test.ts`

**Interfaces:**
- Produces: `vendorColor(vendor): string`（返回 hex 颜色，喂 chip 的 `borderColor`/`color`）。

- [ ] **Step 1: 写失败测试**（`vendor-color.bun.test.ts`）

```ts
import { vendorColor } from "@/lib/vendor-color"

test("vendorColor: known vendors", () => {
  expect(vendorColor("Anthropic")).toBe("#b48ead")
  expect(vendorColor("OpenAI")).toBe("#5aa2d0")
  expect(vendorColor("Azure")).toBe("#5aa2d0")
  expect(vendorColor("Google")).toBe("#8fbf7f")
})
test("vendorColor: unknown → pink, empty → muted", () => {
  expect(vendorColor("xAI")).toBe("#d08fb4")
  expect(vendorColor(undefined)).toBe("var(--color-muted)")
})
```

- [ ] **Step 2: 跑测试确认失败**。Run: `bun test ui-v4/tests/vendor-color.bun.test.ts`。Expected: FAIL。

- [ ] **Step 3: 实现**（`vendor-color.ts`，语义对齐 Vue `vendorColor`，映射到 Terminal Amber 兼容色）

```ts
/**
 * Vendor → chip 颜色（语义对齐 Vue useModelsCatalog.vendorColor：
 * anthropic=purple / openai·azure=blue / google=green / other=pink / none=muted）。
 * Vue 用 Vuetify 色名，这里落地为 Terminal Amber 兼容的 hex。
 */
export function vendorColor(vendor: string | undefined): string {
  if (!vendor) return "var(--color-muted)"
  const v = vendor.toLowerCase()
  if (v.includes("anthropic")) return "#b48ead"
  if (v.includes("openai") || v.includes("azure")) return "#5aa2d0"
  if (v.includes("google")) return "#8fbf7f"
  return "#d08fb4"
}
```

- [ ] **Step 4: 跑测试确认通过**。Run: 同 Step 2。Expected: PASS。

- [ ] **Step 5: vendor 单元格 chip**（`model-table-columns.tsx`）import `vendorColor`；把 vendor cell（现 `cell: (c) => c.row.original.model.vendor`）改为：
```tsx
      cell: (c) => {
        const v = c.row.original.model.vendor
        const color = vendorColor(v)
        return (
          <span
            className="border px-1.5 py-0.5 text-[11px]"
            style={{ color, borderColor: color }}
          >
            {v || "—"}
          </span>
        )
      },
```

- [ ] **Step 6: lint + 提交**

```bash
bunx eslint ui-v4/src/lib/vendor-color.ts ui-v4/src/components/models/model-table-columns.tsx
git add -- ui-v4/src/lib/vendor-color.ts ui-v4/src/components/models/model-table-columns.tsx ui-v4/tests/vendor-color.bun.test.ts
git commit -m "feat(ui-v4): color-coded vendor chip in models table"
```

---

## Task 8: 头部 vendors/endpoints 计数

**Files:**
- Modify: `ui-v4/src/components/models/ModelsPage.tsx`
- Test: `ui-v4/tests/ModelsPage.vitest.test.tsx`

- [ ] **Step 1: 写失败测试**：头部含 vendors + endpoints 计数。

```tsx
test("header shows vendors and endpoints counts", () => {
  renderModelsPage(/* models across 2 vendors, endpoints */)
  expect(screen.getByText(/vendors/i)).toBeInTheDocument()
  expect(screen.getByText(/endpoints/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: 跑测试确认失败**。Run: `cd ui-v4 && bunx vitest run tests/ModelsPage.vitest.test.tsx`。Expected: FAIL。

- [ ] **Step 3: 实现**（`ModelsPage.tsx`）头部计数区（现 `Models · {visible.length}/{models.length}`）改为：
```tsx
        <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">
          Models · {visible.length}/{models.length} · {options.vendors.length} vendors · {options.endpoints.length} endpoints
        </div>
```
（`options.endpoints` 由 Task 1 引入。）

- [ ] **Step 4: 跑测试确认通过**。Run: 同 Step 2。Expected: PASS。

- [ ] **Step 5: 全量校验 + 提交**

```bash
bun run typecheck && bun run build:ui-v4 && bunx eslint ui-v4/src/components/models/ModelsPage.tsx
git add -- ui-v4/src/components/models/ModelsPage.tsx ui-v4/tests/ModelsPage.vitest.test.tsx
git commit -m "feat(ui-v4): show vendors/endpoints counts in models header"
```

---

## 收尾（全部 8 项后）

- [ ] 跑全量前端测试：`cd ui-v4 && bunx vitest run` + 根 `bun test ui-v4/tests/*.bun.test.ts`（或既有脚本）。
- [ ] `bun run build:ui-v4` 绿（rollup 暴露 `~backend` 纯度问题）。
- [ ] 对照 spec 附录 A 逐项复核 8 缺口消解。
- [ ] subagent code-review（显式裁判轴：长远正确 + 完整，对照 Vue file:line 与后端 SSOT）。
- [ ] doc-sync：更新 `docs/DESIGN.md` 若涉及活架构；spec 状态改为 landed。
- [ ] 若 endpoint/billing 让 ui-v4 列表页达到 10 维过滤 parity，在 spec/DESIGN 记「模型列表页已达到并超越 Vue，可下线 `/ui` 列表页」。
