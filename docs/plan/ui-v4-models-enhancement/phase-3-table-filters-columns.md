# Phase 3 — 表格遥测列 + 新过滤 + 列配置 + 未关联遥测小节

> **实施状态：已完成**
> **落地**：2026-07 · commits `4d72039`/`657e60e`/`ac8261e`/`45722e4`/`91ad862`/`526729a`（best-effort）
> **现状锚点**：[useModelColumns.ts](../../../ui/src/composables/useModelColumns.ts) · [ModelsColumnMenu.vue](../../../ui/src/components/models/ModelsColumnMenu.vue) · [UnmatchedTelemetrySection.vue](../../../ui/src/components/models/UnmatchedTelemetrySection.vue)
> **备注**：has-telemetry 过滤经注入 `telemetryHasId` 留在单一 filteredModels（无双重过滤）。audit 通过、无缺陷。

> 总纲见 [README.md](README.md)。依赖 Phase 1（join）+ Phase 2（`useModelDetail.telemetryIndex`）。Global Constraints 隐含适用。
> 交付：表格可选 req(7d) 列 + 占比条；新过滤（premium/restricted-to/policy/has-telemetry）；`useModelColumns`（列显隐 + localStorage）+ toolbar 齿轮菜单；页面底部"未关联遥测"小节。

## 文件结构

- Create `ui/src/composables/useModelColumns.ts`（列配置 + `useLocalStorage`；导出 `UseModelColumnsReturn`）。
- Create `ui/src/components/models/UnmatchedTelemetrySection.vue`。
- Create `ui/src/components/models/ModelsColumnMenu.vue`（齿轮菜单，勾选显隐）。
- Modify `ui/src/composables/useModelsCatalog.ts`（新过滤 state + 谓词 + options：premium/restrictedTo/policy/hasTelemetry）。
- Modify `ui/src/components/models/ModelsFilterBar.vue`（新过滤 UI）。
- Modify `ui/src/components/models/ModelsTable.vue`（列显隐 + req(7d) 列 + 占比条；收 `columns` + `telemetryFor`）。
- Modify `ui/src/components/models/ModelsToolbar.vue`（挂齿轮菜单）、`ui/src/pages/vuetify/VModelsPage.vue`（接线 + 传 telemetry + unmatched）。
- Tests：`ui/tests/use-model-columns.test.ts`、`ui/tests/use-models-catalog-filters.test.ts`、`ui/vitest/unmatched-telemetry-section.test.ts`、扩展 `ui/vitest/models-table.test.ts`。

---

### Task 1: `useModelColumns`（列显隐 + 持久化）

**Files:** Create `ui/src/composables/useModelColumns.ts`；Test `ui/tests/use-model-columns.test.ts`

**Interfaces:**
```ts
export type ModelColumnKey = "vendor" | "context" | "output" | "effort" | "vision" | "toolCalls" | "parallelToolCalls" | "structuredOutputs" | "streaming" | "thinking" | "billing" | "requests7d"
export interface UseModelColumnsReturn {
  visible: Ref<Record<ModelColumnKey, boolean>>
  isVisible: (key: ModelColumnKey) => boolean
  toggle: (key: ModelColumnKey) => void
  reset: () => void
  ALL_COLUMNS: ReadonlyArray<{ key: ModelColumnKey; label: string }>
}
export function useModelColumns(): UseModelColumnsReturn
```
- `useLocalStorage("copilot-api-models-columns", DEFAULT_VISIBLE)`（VueUse，**禁止手搓 localStorage**）。默认全显除 `requests7d`（默认隐藏，避免首屏依赖遥测）。`Model`/`Vendor` 列在表格里恒显（不在此 map，或 vendor 可选——按 spec §7 "Model/Vendor 恒显" → `vendor` 也可放进可选但默认显；此处把 `vendor` 纳入可选、`id` 恒显不进 map）。
- **retain-on-absence 合并**：读出的持久值可能缺新列 key（后续版本新增列），`{ ...DEFAULT_VISIBLE, ...persisted }` 合并，保证新列有默认值。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test, beforeEach } from "bun:test"

// 注：useLocalStorage 在无 window 的 bun 环境退化为内存 ref；测试仍可验证 toggle/默认/合并逻辑。
import { useModelColumns } from "@/composables/useModelColumns"

describe("useModelColumns", () => {
  test("defaults: most columns visible, requests7d hidden", () => {
    const c = useModelColumns()
    expect(c.isVisible("context")).toBe(true)
    expect(c.isVisible("requests7d")).toBe(false)
  })
  test("toggle flips visibility", () => {
    const c = useModelColumns()
    c.toggle("context")
    expect(c.isVisible("context")).toBe(false)
    c.toggle("requests7d")
    expect(c.isVisible("requests7d")).toBe(true)
  })
  test("reset restores defaults", () => {
    const c = useModelColumns()
    c.toggle("context")
    c.reset()
    expect(c.isVisible("context")).toBe(true)
  })
})
```

- [ ] **Step 2: 跑确认失败** — `bun run test:ui:bun 2>&1 | grep use-model-columns` → FAIL。

- [ ] **Step 3: 写 `useModelColumns.ts`**

```ts
import { useLocalStorage } from "@vueuse/core"
import { type Ref } from "vue"

export type ModelColumnKey = "vendor" | "context" | "output" | "effort" | "vision" | "toolCalls" | "parallelToolCalls" | "structuredOutputs" | "streaming" | "thinking" | "billing" | "requests7d"

const ALL_COLUMNS: ReadonlyArray<{ key: ModelColumnKey; label: string }> = [
  { key: "vendor", label: "Vendor" }, { key: "context", label: "Context" }, { key: "output", label: "Output" },
  { key: "effort", label: "Effort" }, { key: "vision", label: "Vision" }, { key: "toolCalls", label: "Tools" },
  { key: "parallelToolCalls", label: "Parallel" }, { key: "structuredOutputs", label: "Structured" },
  { key: "streaming", label: "Streaming" }, { key: "thinking", label: "Thinking" }, { key: "billing", label: "Billing ×" },
  { key: "requests7d", label: "Requests (7d)" },
]
const DEFAULT_VISIBLE = Object.fromEntries(ALL_COLUMNS.map((c) => [c.key, c.key !== "requests7d"])) as Record<ModelColumnKey, boolean>

export interface UseModelColumnsReturn {
  visible: Ref<Record<ModelColumnKey, boolean>>
  isVisible: (key: ModelColumnKey) => boolean
  toggle: (key: ModelColumnKey) => void
  reset: () => void
  ALL_COLUMNS: typeof ALL_COLUMNS
}

export function useModelColumns(): UseModelColumnsReturn {
  const stored = useLocalStorage<Record<ModelColumnKey, boolean>>("copilot-api-models-columns", DEFAULT_VISIBLE)
  // retain-on-absence: new column keys get their default when the persisted blob predates them.
  stored.value = { ...DEFAULT_VISIBLE, ...stored.value }
  return {
    visible: stored,
    isVisible: (key) => stored.value[key] ?? DEFAULT_VISIBLE[key],
    toggle: (key) => { stored.value = { ...stored.value, [key]: !stored.value[key] } },
    reset: () => { stored.value = { ...DEFAULT_VISIBLE } },
    ALL_COLUMNS,
  }
}
```

- [ ] **Step 4: 跑测试 + typecheck** → PASS / 0 error。
- [ ] **Step 5: 提交** — `git add -- ui/src/composables/useModelColumns.ts ui/tests/use-model-columns.test.ts && git commit -m "feat(ui): useModelColumns column visibility + localStorage persistence"`

---

### Task 2: 新过滤谓词（premium/restricted-to/policy/has-telemetry）

**Files:** Modify `ui/src/composables/useModelsCatalog.ts`；Test `ui/tests/use-models-catalog-filters.test.ts`

**新增到 `useModelsCatalog` 返回**：`premiumFilter: Ref<boolean | null>`、`restrictedToFilter: Ref<Array<string>>`、`policyStateFilter: Ref<string | null>`、`hasTelemetryFilter: Ref<boolean | null>`；options：`restrictedToOptions`（`billing.restricted_to` 扁平去重）、`policyStateOptions`（`policy.state` 去重）。`hasTelemetry` 需要遥测 index——`filteredModels` 接受一个 `telemetryHasId: (id: string) => boolean` 谓词（由页面从 `useModelDetail.telemetryIndex` 提供），或把 index 传入 catalog。**为保持 catalog 纯净、避免耦合**：`hasTelemetryFilter` 的应用放在**页面层** computed（catalog 出过滤结果后，页面再按遥测过滤），或给 `filteredModels` 一个可选注入的 `hasTelemetry?: (m: Model) => boolean`。选后者：`useModelsCatalog` 暴露 `setTelemetryPredicate(fn)`（可选），默认全 true。

> 决策：给 `useModelsCatalog` 增加一个 `telemetryPredicate: Ref<(m: Model) => boolean>`（默认 `() => true`），页面在拿到 telemetry index 后 `catalog.telemetryPredicate.value = (m) => index.byId.has(normalizeModelId(m.id))`。这样 has-telemetry 过滤留在 catalog 的统一 `filteredModels` 里、无双重过滤。

- [ ] **Step 1: 写失败测试**（premium/restrictedTo/policy 纯谓词 + hasTelemetry 经注入谓词）

```ts
import { describe, expect, test } from "bun:test"
import { useModelsCatalog } from "@/composables/useModelsCatalog"
// 直接 set models.value 需要 catalog 暴露可写 models；测试里用 (catalog as any).models 或新增 test seam。
// 若 catalog 不便注入 models，改测独立抽出的纯谓词函数(推荐：把过滤谓词抽成 exported pure fns 便于 bun 测)。
```

> **实现指引**：把新过滤谓词抽成 `useModelsCatalog.ts` 内 **exported 纯函数**（`matchesPremium(m, v)`、`matchesRestrictedTo(m, sel)`、`matchesPolicyState(m, v)`），bun 直接测纯函数（避免起 composable 的 onMounted fetch）。谓词在 `filteredModels` computed 里调用。

```ts
import { matchesRestrictedTo, matchesPremium, matchesPolicyState } from "@/composables/useModelsCatalog"
const m = (over = {}) => ({ id: "m", billing: {}, ...over } as never)

test("matchesPremium filters by billing.is_premium", () => {
  expect(matchesPremium(m({ billing: { is_premium: true } }), true)).toBe(true)
  expect(matchesPremium(m({ billing: { is_premium: false } }), true)).toBe(false)
  expect(matchesPremium(m(), null)).toBe(true) // null = no filter
})
test("matchesRestrictedTo requires overlap with selected plans", () => {
  expect(matchesRestrictedTo(m({ billing: { restricted_to: ["pro", "business"] } }), ["business"])).toBe(true)
  expect(matchesRestrictedTo(m({ billing: { restricted_to: ["pro"] } }), ["enterprise"])).toBe(false)
  expect(matchesRestrictedTo(m(), [])).toBe(true) // empty selection = no filter
})
test("matchesPolicyState filters by policy.state", () => {
  expect(matchesPolicyState(m({ policy: { state: "enabled", terms: "" } }), "enabled")).toBe(true)
  expect(matchesPolicyState(m(), null)).toBe(true)
})
```

- [ ] **Step 2: 跑确认失败** → FAIL。

- [ ] **Step 3: 实现**——在 `useModelsCatalog.ts` 加 exported 纯谓词 + 新 filter refs + options + `telemetryPredicate` ref，并入 `filteredModels`：

```ts
export function matchesPremium(m: Model, v: boolean | null): boolean {
  return v === null || Boolean(m.billing?.is_premium) === v
}
export function matchesRestrictedTo(m: Model, sel: Array<string>): boolean {
  if (sel.length === 0) return true
  const plans = m.billing?.restricted_to ?? []
  return sel.some((p) => plans.includes(p))
}
export function matchesPolicyState(m: Model, v: string | null): boolean {
  return v === null || m.policy?.state === v
}
// filteredModels 内追加:
//   .filter((m) => matchesPremium(m, premiumFilter.value))
//   .filter((m) => matchesRestrictedTo(m, restrictedToFilter.value))
//   .filter((m) => matchesPolicyState(m, policyStateFilter.value))
//   .filter((m) => telemetryPredicate.value(m))
// options:
//   restrictedToOptions = [...new Set(models.flatMap((m) => m.billing?.restricted_to ?? []))].sort()
//   policyStateOptions = [...new Set(models.map((m) => m.policy?.state).filter(Boolean))].sort()
```

新 refs + options + `telemetryPredicate` 加进 return。`activeFilterCount`（在 VModelsPage）相应 +4 项判断。

- [ ] **Step 4: 跑测试 + typecheck** → PASS / 0 error。
- [ ] **Step 5: 提交** — `git add -- ui/src/composables/useModelsCatalog.ts ui/tests/use-models-catalog-filters.test.ts && git commit -m "feat(ui): premium/restricted-to/policy/has-telemetry model filters"`

---

### Task 3: FilterBar UI + Toolbar 齿轮菜单接新过滤/列配置

**Files:** Modify `ModelsFilterBar.vue`（4 个新控件：premium 三态 select/switch、restricted-to multi-select、policy select、has-telemetry select）、`ModelsToolbar.vue` + Create `ModelsColumnMenu.vue`（`v-menu` + checkbox 列表，勾选 `columns.toggle`，含 Reset）。

- [ ] **Step 1: vitest — 齿轮菜单勾选 toggle 列**

```ts
test("column menu toggles a column", async () => {
  // mount ModelsColumnMenu with a fake columns controller, click a checkbox, assert toggle called
})
```

- [ ] **Step 2-4:** 实现 FilterBar 新控件（v-model 到 catalog 新 refs）+ ColumnMenu（props: `columns: UseModelColumnsReturn`；渲染 `columns.ALL_COLUMNS` 每项 checkbox 绑 `columns.isVisible`/`@change=columns.toggle`）。挂到 Toolbar。跑 vitest + typecheck。
- [ ] **Step 5: 提交** — `git commit -m "feat(ui): filter-bar new filters + toolbar column menu"`

---

### Task 4: ModelsTable 列显隐 + req(7d) 列 + 占比条

**Files:** Modify `ModelsTable.vue`（收 `columns: UseModelColumnsReturn`、`telemetryFor: (id) => JoinedModelTelemetry | null`、`maxRequests7d: number`）；扩展 `ui/vitest/models-table.test.ts`

- 每列 `<th v-if="columns.isVisible('context')">`、`<td v-if=...>` 包裹（`id` 恒显）。
- req(7d) 列：`telemetryFor(m.id)?.last7d?.requestCount ?? 0` + 迷你占比条（宽 = `count / maxRequests7d * 100`%）。`maxRequests7d` 由页面 computed（`Math.max(...index 内 last7d.requestCount, 1)`）。

- [ ] **Step 1: vitest** — 断言隐藏列不渲染 th、req 列显示计数。
- [ ] **Step 2-4:** 实现 + 跑测试 + typecheck。
- [ ] **Step 5: 提交** — `git commit -m "feat(ui): configurable columns + requests(7d) column with share bar"`

---

### Task 5: "未关联遥测"小节

**Files:** Create `UnmatchedTelemetrySection.vue`；Modify `VModelsPage.vue`（在结果列下方渲染，传 `detail.telemetryIndex.value.unmatched`）；Test `ui/vitest/unmatched-telemetry-section.test.ts`

- props: `defineProps<{ rows: Array<UnmatchedTelemetryRow> }>()`。`rows` 空 → 整节不渲染（`v-if="rows.length"`）。每行：`model`（原始 key）+ last7d/sinceStart 的 req/fail。加说明句"有流量但目录无匹配 id（多为纯别名失败请求）"。

- [ ] **Step 1: vitest** — 有 rows 渲染计数、空 rows 不渲染。

```ts
test("renders unmatched rows; hidden when empty", () => {
  const rows = [{ model: "opus", normalizedKey: "opus", last7d: { model: "opus", requestCount: 3, successCount: 0, failureCount: 3, totalDurationMs: 0, averageDurationMs: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 } }, sinceStart: null }]
  expect(mountWithVuetifyStubs(UnmatchedTelemetrySection, { props: { rows } }).text()).toContain("opus")
  expect(mountWithVuetifyStubs(UnmatchedTelemetrySection, { props: { rows: [] } }).text()).not.toContain("Unmatched")
})
```

- [ ] **Step 2-4:** 实现 + 接线 VModelsPage + 跑测试 + typecheck。
- [ ] **Step 5: 提交** — `git commit -m "feat(ui): unmatched-telemetry section (surfaces un-joinable telemetry)"`

---

## Phase 3 收尾

- `bun run typecheck:ui` + `bun run test:ui:bun` + `bun run test:ui:vitest` 全绿。
- 派 subagent audit（裁判轴：hasTelemetry 过滤是否无双重过滤/耦合、列配置 retain-on-absence 是否正确、unmatched 小节是否真呈现 join 不上的遥测、req 列占比条 max 计算；**非** ROI/最小化）。
