# 模型详情模态抽屉 + 禁用模型可见性 — 实施计划

> **实施状态（2026-07-08）：全部完成并落地。** 分支 `feat/models-drawer-disabled-visibility`，commits `91055d0a..698111db`（A1 / A2 / A3+A4 合并 / A5 / A6 / B1 / B2 + final-review fix）。subagent-driven 执行：每任务 per-task review 全 Approved、整分支 final review「Ready to merge」、`build:ui-v4` rollup PASS。已知 4 typecheck + 2 vitest 预存失败属并发 LiveDock 会话（非本分支，已 base checkout 实测确认）。

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实施。步骤用 checkbox（`- [ ]`）追踪。

**Goal:** 让 ui-v4 模型详情用 Radix Dialog 模态抽屉（不挤占列表宽度），并让 config-disabled 模型在列表可见、三态 status 标记 + 可筛选。

**Architecture:** 后端内部 `/api/models` 改返**全量**目录 + envelope `disabled[]`（config-disabled 的实际 id），只改内部端点、不碰 `state.modelIndex`/`state.models`/vendor 端点（红线 R1）。前端用单一 `statusFor` 闭包（`modelStatus` primitive）喂 table/filter/csv 三消费者；status 列三态 chip，**行 muting 只施 config-disabled**。抽屉从 co-planar split 改 Radix `Dialog` 模态浮层。

**Tech Stack:** Hono + `@hono/zod-openapi`（后端）；React 19 + TanStack Table + Radix UI + react-router hash（ui-v4）；bun test（后端 + ui-v4 纯逻辑）、vitest + @testing-library/react（ui-v4 组件）。

**规格来源:** [docs/spec/2026-07-08-models-drawer-and-disabled-visibility.md](../spec/2026-07-08-models-drawer-and-disabled-visibility.md)（含 2 轮对抗审查 changelog）。

## Global Constraints

- **红线 R1**：只改内部 `/api/models`（`src/routes/models/internal.ts` + `src/lib/state.ts` 新增导出）；**绝不改** `state.modelIndex`、`state.models` 的过滤、任何 vendor 端点（OpenAI/Anthropic `/models`、`/status`、setup）。`rebuildModelIndex` 继续从过滤集构建。
- **合成标记不污染上游形状**：`disabled` 只在 envelope 顶层，不加进 Model 对象。
- **SSOT 类型**：`InternalModelsResponse` 在后端 `src/lib/models/client.ts` 一处定义，前端经 `~backend/lib/models/client` re-export（`~backend/*` → `../src/*`），**前端不再内联响应类型**。
- **归一化判据**：`disabled[]` 用 `normalizeForMatching` 双侧归一化，与 `applyDisabledFilter`（[state.ts:996-1003](../../src/lib/state.ts#L996-L1003)）**同一判据**，回吐实际命中目录的 `m.id`。
- **行 muting 只 config-disabled**：picker-disabled（占目录 51%）只给 chip、不 muting；muting 用**前景色 token**，不用 `tr` opacity（否则洗淡 selected 琥珀底）。
- **命令**：后端测试 `bun test <path>`；ui-v4 纯逻辑 `cd ui-v4 && bun test <path>`；ui-v4 组件 `cd ui-v4 && bunx vitest run <path>`；typecheck `bun run typecheck` + `cd ui-v4 && bun run typecheck`；**UI 交付必跑 `bun run build:ui-v4`（rollup，非仅 vitest——`~backend` 模块须纯）**；单文件 lint `bunx eslint <path>`（无缓存）。
- **提交**：显式 pathspec（`git add -- <精确路径>` / `git commit -- <精确路径>`），conventional commits，无模型署名。
- **no-auto-server**：不跑 dev/start，不 kill 实例。

---

## 文件结构

**Phase A — 禁用模型可见性**

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/lib/models/client.ts` | 新增 `InternalModelsResponse` 类型（SSOT） | Modify |
| `src/lib/state.ts` | 新增 `getConfigDisabledIds()`（复用 applyDisabledFilter 判据） | Modify |
| `src/routes/models/internal.ts` | `/api/models` 返全量 + disabled；schema 加字段；`/{id}` 全量解析 | Modify |
| `tests/models/internal-route.http.test.ts` | 后端路由测试（全量 + disabled + 回归） | Modify |
| `ui-v4/src/lib/model-status.ts` | `modelStatus` 三态 primitive | Create |
| `ui-v4/tests/model-status.bun.test.ts` | primitive 单测 | Create |
| `ui-v4/src/hooks/useModels.ts` | 消费 `InternalModelsResponse` | Modify |
| `ui-v4/src/lib/model-columns.ts` | `status` 列 key | Modify |
| `ui-v4/src/components/models/model-table-columns.tsx` | `ModelRow.status`、`augmentRows(statusFor)`、status 列 | Modify |
| `ui-v4/src/components/models/ModelsTable.tsx` | `statusFor` prop、行 muting | Modify |
| `ui-v4/src/lib/model-filters.ts` | 两个 include 标志 + `filterModels(statusFor)` | Modify |
| `ui-v4/src/components/models/ModelsFilterBar.tsx` | 两个 status 筛选控件 | Modify |
| `ui-v4/src/lib/models-csv.ts` | `status` 列 | Modify |
| `ui-v4/src/components/models/ModelsPage.tsx` | `configDisabledSet`/`statusFor` 接线到三消费者 | Modify |
| 各对应 `.bun.test.ts` / `.vitest.test.tsx` | 测试跟随 | Modify |

**Phase B — 模态抽屉**

| 文件 | 职责 | 动作 |
|---|---|---|
| `ui-v4/src/components/models/ModelDetail.tsx` | co-planar split → Radix Dialog 模态 + Dialog.Title + 60vw | Modify |
| `ui-v4/src/components/models/ModelsPage.tsx` | 布局简化（表格全宽、抽屉 portal） | Modify |
| `ui-v4/tests/ModelDetail.vitest.test.tsx` | Escape 派发 window→document、focus 断言改 | Modify |

Phase A、B 各自独立可交付、可测试；A 是数据流、B 是 UI 结构，互不依赖，可并行或顺序做。

---

# Phase A — 禁用模型可见性

## Task A1: 后端 `/api/models` 返全量 + `disabled[]`

**Files:**
- Modify: `src/lib/models/client.ts`（`InternalModelsResponse`）
- Modify: `src/lib/state.ts`（`getConfigDisabledIds`）
- Modify: `src/routes/models/internal.ts`（handler + schema）
- Test: `tests/models/internal-route.http.test.ts`

**Interfaces:**
- Produces: `InternalModelsResponse { object: string; data: Array<Model>; disabled: Array<string> }`（`~backend/lib/models/client`）；`getConfigDisabledIds(): string[]`（`~/lib/state`）。

- [ ] **Step 1: 写失败测试**（追加到 `tests/models/internal-route.http.test.ts` 的 describe 内）

```ts
import { setModels, setDisabledModels } from "~/lib/state"

// ... 在现有 describe 内追加：

test("returns FULL catalog including config-disabled models + disabled[] envelope", async () => {
  setModels({ object: "list", data: [mockModel("keep"), mockModel("gpt-4o-2024-11-20")] })
  setDisabledModels(["gpt-4o-2024-11-20"])
  const app = createFullTestApp()
  const res = await app.request("/api/models")
  const body = (await res.json()) as { data: Array<{ id: string }>; disabled: Array<string> }
  // 全量：禁用模型仍在 data 里（不再被 applyDisabledFilter 滤除）。
  expect(body.data.map((m) => m.id).sort()).toEqual(["gpt-4o-2024-11-20", "keep"])
  expect(body.disabled).toEqual(["gpt-4o-2024-11-20"])
})

test("disabled[] matches via normalized id (dot/hyphen/case irrelevant)", async () => {
  setModels({ object: "list", data: [mockModel("claude-opus-4.8")] })
  setDisabledModels(["claude-opus-4-8"]) // config 写 hyphen，上游是 dot
  const app = createFullTestApp()
  const res = await app.request("/api/models")
  const body = (await res.json()) as { disabled: Array<string> }
  // 回吐实际命中目录的 id（dot 版），非 config 原字符串。
  expect(body.disabled).toEqual(["claude-opus-4.8"])
})

test("disabled[] is empty when nothing disabled", async () => {
  setModels({ object: "list", data: [mockModel("a"), mockModel("b")] })
  const app = createFullTestApp()
  const res = await app.request("/api/models")
  const body = (await res.json()) as { disabled: Array<string> }
  expect(body.disabled).toEqual([])
})

test("single-model route resolves a config-disabled model (200, not 404)", async () => {
  setModels({ object: "list", data: [mockModel("disabled-one")] })
  setDisabledModels(["disabled-one"])
  const app = createFullTestApp()
  const res = await app.request("/api/models/disabled-one")
  expect(res.status).toBe(200)
  const body = (await res.json()) as { id: string }
  expect(body.id).toBe("disabled-one")
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/models/internal-route.http.test.ts`
Expected: FAIL —`body.disabled` undefined / 全量测试里禁用模型被滤掉 / `/api/models/disabled-one` 返 404。

- [ ] **Step 3: 加 `InternalModelsResponse` 类型**（`src/lib/models/client.ts`，紧邻 `ModelsResponse`，[client.ts:65-68](../../src/lib/models/client.ts#L65-L68) 之后）

```ts
/**
 * Internal `/api/models` envelope: the FULL (unfiltered) upstream catalog plus
 * `disabled` — the ids this project's `config.disabled_models` removed from the
 * usable set. Distinct from the upstream {@link ModelsResponse}: `disabled` is a
 * synthetic annotation (not an upstream field), kept at the envelope top level so
 * the per-model shape stays verbatim (richest-data-flow ADR).
 */
export interface InternalModelsResponse {
  object: string
  data: Array<Model>
  disabled: Array<string>
}
```

- [ ] **Step 4: 加 `getConfigDisabledIds()`**（`src/lib/state.ts`，紧邻 `applyDisabledFilter` / `getRawModels`，[state.ts:1013-1015](../../src/lib/state.ts#L1013-L1015) 附近）

```ts
/**
 * The upstream ids that `config.disabled_models` currently removes from the usable
 * set — computed from the cached raw catalog with the SAME normalized match as
 * {@link applyDisabledFilter} (so config `claude-opus-4-8` reports the actual
 * catalog id `claude-opus-4.8`). Empty when nothing disabled / no catalog yet.
 * Consumed by the internal `/api/models` route to annotate the full catalog.
 */
export function getConfigDisabledIds(): string[] {
  const raw = rawModels
  if (!raw) return []
  const disabled = mutableState.disabledModels
  if (disabled.length === 0) return []
  const disabledSet = new Set(disabled.map((id) => normalizeForMatching(id)))
  return raw.data.filter((m) => disabledSet.has(normalizeForMatching(m.id))).map((m) => m.id)
}
```

> `normalizeForMatching` 已在 state.ts 导入（applyDisabledFilter 用）；`rawModels`/`mutableState` 是模块作用域，`getConfigDisabledIds` 与它们同文件可直接读。

- [ ] **Step 5: 改 `/api/models` handler + schema + `/{id}`**（`src/routes/models/internal.ts`）

改 import（[internal.ts:8](../../src/routes/models/internal.ts#L8)）：
```ts
import { getConfigDisabledIds, getRawModels, state } from "~/lib/state"
```

改 `ModelListSchema`（[internal.ts:24-29](../../src/routes/models/internal.ts#L24-L29)）加 `disabled`：
```ts
const ModelListSchema = z
  .object({
    object: z.string(),
    data: z.array(ModelSchema),
    disabled: z.array(z.string()),
  })
  .openapi("CopilotModelList")
```

改列表 handler（[internal.ts:65-74](../../src/routes/models/internal.ts#L65-L74)）返全量 + disabled：
```ts
internalModelsRoutes.openapi(listModelsRoute, async (c) => {
  await ensureModels()
  const raw = getRawModels()
  return c.json(
    {
      object: raw?.object ?? "list",
      data: raw?.data ?? [],
      disabled: getConfigDisabledIds(),
    },
    200,
  )
})
```

改单模型 handler（[internal.ts:76-97](../../src/routes/models/internal.ts#L76-L97)）对全量解析（保留 modelIndex 的 alias 解析、再回退全量 find）：
```ts
internalModelsRoutes.openapi(getModelRoute, async (c) => {
  await ensureModels()
  const modelId = c.req.param("model")
  // Enabled models keep modelIndex's alias resolution; config-disabled models are
  // absent from the (filtered) index → fall back to an exact match on the full catalog.
  const model = state.modelIndex.get(modelId) ?? getRawModels()?.data.find((m) => m.id === modelId)
  if (!model) {
    return c.json(
      { error: { message: `The model '${modelId}' does not exist`, type: "invalid_request_error", param: "model", code: "model_not_found" } },
      404,
    )
  }
  return c.json(model, 200)
})
```

- [ ] **Step 6: 运行确认通过 + 回归**

Run: `bun test tests/models/internal-route.http.test.ts`
Expected: PASS（新 4 条 + 原 3 条全绿——原测试无 disabledModels，raw==filtered，`body.data[0]` 不变）。

Run（回归 vendor 端点不受影响）: `bun test tests/models/`
Expected: PASS。

- [ ] **Step 7: typecheck + lint + commit**

Run: `bun run typecheck`
Run: `bunx eslint src/lib/models/client.ts src/lib/state.ts src/routes/models/internal.ts`
Expected: 均无错。

```bash
git add -- src/lib/models/client.ts src/lib/state.ts src/routes/models/internal.ts tests/models/internal-route.http.test.ts
git commit -m "feat(models): /api/models 返全量目录 + disabled[] envelope

内部端点暴露 config-disabled 模型给 UI（红线：不碰 modelIndex/vendor 端点）。
新增 InternalModelsResponse 类型 + getConfigDisabledIds()（复用 applyDisabledFilter 归一化判据）。"
```

---

## Task A2: 前端 `modelStatus` 三态 primitive

**Files:**
- Create: `ui-v4/src/lib/model-status.ts`
- Test: `ui-v4/tests/model-status.bun.test.ts`

**Interfaces:**
- Produces: `type ModelStatus = "enabled" | "config-disabled" | "picker-disabled"`；`modelStatus(model: Model, configDisabled: ReadonlySet<string>): ModelStatus`。

- [ ] **Step 1: 写失败测试**（`ui-v4/tests/model-status.bun.test.ts`）

```ts
import { describe, expect, test } from "bun:test"

import type { Model } from "~backend/lib/models/client"

import { modelStatus } from "@/lib/model-status"

const m = (id: string, pickerEnabled = true): Model =>
  ({ id, model_picker_enabled: pickerEnabled } as unknown as Model)

describe("modelStatus", () => {
  test("config-disabled wins (highest priority) even if picker-enabled", () => {
    expect(modelStatus(m("x", true), new Set(["x"]))).toBe("config-disabled")
  })
  test("config-disabled wins over picker-disabled", () => {
    expect(modelStatus(m("x", false), new Set(["x"]))).toBe("config-disabled")
  })
  test("picker-disabled when not config-disabled and model_picker_enabled===false", () => {
    expect(modelStatus(m("x", false), new Set())).toBe("picker-disabled")
  })
  test("enabled otherwise", () => {
    expect(modelStatus(m("x", true), new Set())).toBe("enabled")
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd ui-v4 && bun test tests/model-status.bun.test.ts`
Expected: FAIL — `Cannot find module '@/lib/model-status'`。

- [ ] **Step 3: 实现 primitive**（`ui-v4/src/lib/model-status.ts`）

```ts
import type { Model } from "~backend/lib/models/client"

/** Tri-state model availability from the UI's POV. */
export type ModelStatus = "enabled" | "config-disabled" | "picker-disabled"

/**
 * Classify a model. `config-disabled` (this project's `config.disabled_models`,
 * carried in the `/api/models` envelope `disabled[]`) takes priority over the
 * upstream `model_picker_enabled: false` (`picker-disabled`) — a model that is
 * both shows the more relevant config-disabled state. Priority only decides which
 * label a dual-state model shows; it never hides a row.
 */
export function modelStatus(model: Model, configDisabled: ReadonlySet<string>): ModelStatus {
  if (configDisabled.has(model.id)) return "config-disabled"
  if (model.model_picker_enabled === false) return "picker-disabled"
  return "enabled"
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd ui-v4 && bun test tests/model-status.bun.test.ts`
Expected: PASS（4 条）。

- [ ] **Step 5: commit**

```bash
git add -- ui-v4/src/lib/model-status.ts ui-v4/tests/model-status.bun.test.ts
git commit -m "feat(ui-v4): modelStatus 三态 primitive（config/picker-disabled/enabled）"
```

---

## Task A3: `useModels` 消费新 envelope + ModelsPage 接线

**Files:**
- Modify: `ui-v4/src/hooks/useModels.ts`
- Modify: `ui-v4/src/components/models/ModelsPage.tsx`（`configDisabledSet` + `statusFor`）

**Interfaces:**
- Consumes: `InternalModelsResponse`（A1）、`modelStatus`（A2）。
- Produces: ModelsPage 内 `statusFor: (m: Model) => ModelStatus`（稳定身份），供 A4/A5/A6 接线。

- [ ] **Step 1: 改 `useModels`**（`ui-v4/src/hooks/useModels.ts`，整文件替换）

```ts
import type { InternalModelsResponse } from "~backend/lib/models/client"

import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"

/** GET /api/models — full Copilot catalog (unfiltered) + `disabled[]` (config-disabled ids). */
export function useModels() {
  return useQuery({
    queryKey: ["models"],
    queryFn: () => api.get<InternalModelsResponse>("/api/models"),
  })
}
```

- [ ] **Step 2: ModelsPage 加 `configDisabledSet` + `statusFor`**（`ui-v4/src/components/models/ModelsPage.tsx`）

在 `models` useMemo（[ModelsPage.tsx:73](../../ui-v4/src/components/models/ModelsPage.tsx#L73)）之后加：
```tsx
// Config-disabled ids from the envelope; useMemo so the Set identity is stable
// (feeds statusFor → columns/filter/csv; an unstable Set rebuilds the row model).
const configDisabledSet = useMemo(() => new Set(data?.disabled ?? []), [data])
const statusFor = useMemo(() => (m: (typeof models)[number]) => modelStatus(m, configDisabledSet), [configDisabledSet])
```

加 import（顶部）：
```tsx
import { modelStatus } from "@/lib/model-status"
```

- [ ] **Step 3: typecheck**

Run: `cd ui-v4 && bun run typecheck`
Expected: 无错（`statusFor` 暂未被消费，A4/A5/A6 接入；若 tsc 报未使用，A4 紧接消费——本步允许暂时未用，下一步即用；如 lint 阻塞，先接 A4 再一并提交）。

> 注：为避免 no-unused 中间态，A3 与 A4 可合并提交（见 A4 Step 6）。本任务不单独 commit，随 A4 一起。

---

## Task A4: status 列 + config-disabled 行 muting

**Files:**
- Modify: `ui-v4/src/lib/model-columns.ts`（`status` key）
- Modify: `ui-v4/src/components/models/model-table-columns.tsx`（`ModelRow.status`、`augmentRows`、status 列）
- Modify: `ui-v4/src/components/models/ModelsTable.tsx`（`statusFor` prop、行 muting）
- Modify: `ui-v4/src/components/models/ModelsPage.tsx`（传 `statusFor` 给 ModelsTable）
- Test: `ui-v4/tests/model-table-columns.bun.test.ts`、`ui-v4/tests/model-columns.bun.test.ts`、`ui-v4/tests/ModelsTable.vitest.test.tsx`

**Interfaces:**
- Consumes: `statusFor`（A3）、`ModelStatus`（A2）。
- Produces: `ModelRow.status`；`augmentRows(models, telemetryFor, statusFor)`；`ModelsTable` 新 prop `statusFor`。

- [ ] **Step 1: 写失败测试**（`ui-v4/tests/model-table-columns.bun.test.ts` 追加）

```ts
import { modelStatus } from "@/lib/model-status"

test("augmentRows carries status via statusFor", () => {
  const models = [{ id: "a", model_picker_enabled: true }, { id: "b", model_picker_enabled: false }] as unknown as Array<Model>
  const statusFor = (m: Model) => modelStatus(m, new Set(["a"]))
  const rows = augmentRows(models, () => null, statusFor)
  expect(rows.map((r) => r.status)).toEqual(["config-disabled", "picker-disabled"])
})
```

（`augmentRows`、`Model` 已在该测试文件导入；若无则加 `import type { Model } from "~backend/lib/models/client"`。）

- [ ] **Step 2: 运行确认失败**

Run: `cd ui-v4 && bun test tests/model-table-columns.bun.test.ts`
Expected: FAIL — `augmentRows` 只收 2 参 / `r.status` undefined。

- [ ] **Step 3: `ModelColumnKey` 加 `status`**（`ui-v4/src/lib/model-columns.ts`）

`ModelColumnKey` 联合（[model-columns.ts:2-14](../../ui-v4/src/lib/model-columns.ts#L2-L14)）加 `| "status"`；`MODEL_COLUMNS`（[:16-29](../../ui-v4/src/lib/model-columns.ts#L16-L29)）在 `vendor` 前插入：
```ts
export const MODEL_COLUMNS: ReadonlyArray<{ key: ModelColumnKey; label: string }> = [
  { key: "status", label: "Status" },
  { key: "vendor", label: "Vendor" },
  // ... 其余不变
]
```
（`DEFAULT_COLUMN_VISIBILITY` 由 `MODEL_COLUMNS` 派生、`status` 自动默认可见——`requests7d` 仍是唯一默认隐藏项。）

- [ ] **Step 4: `ModelRow.status` + `augmentRows` + status 列**（`ui-v4/src/components/models/model-table-columns.tsx`）

`ModelRow`（[:38-44](../../ui-v4/src/components/models/model-table-columns.tsx#L38-L44)）加字段：
```ts
import type { ModelStatus } from "@/lib/model-status"
// ...
export interface ModelRow {
  model: Model
  caps: DerivedCapabilities
  req: number
  /** UI status (config/picker-disabled/enabled), pre-resolved once per row. */
  status: ModelStatus
}
```

`augmentRows`（[:47-53](../../ui-v4/src/components/models/model-table-columns.tsx#L47-L53)）加参：
```ts
export function augmentRows(
  models: Array<Model>,
  telemetryFor: (id: string) => JoinedModelTelemetry | null,
  statusFor: (model: Model) => ModelStatus,
): Array<ModelRow> {
  return models.map((model) => ({
    model,
    caps: deriveCapabilities(model),
    req: telemetryFor(model.id)?.last7d?.requestCount ?? 0,
    status: statusFor(model),
  }))
}
```

在 `buildModelColumns` 返回数组里、`id` 列之后插入 status 列（[:207](../../ui-v4/src/components/models/model-table-columns.tsx#L207) 之后）：
```tsx
col.accessor((r) => r.status, {
  id: "status",
  header: "Status",
  enableSorting: false,
  meta: { thClass: `${HEAD}`, tdClass: "px-2 py-1" },
  cell: (c) => {
    const st = c.getValue<ModelStatus>()
    if (st === "enabled") return <span className="text-[10px] text-[var(--color-muted)]">on</span>
    const label = st === "config-disabled" ? "config-off" : "picker-off"
    const color = st === "config-disabled" ? "var(--color-fail)" : "var(--color-muted)"
    return (
      <span
        className="border px-1.5 py-0.5 text-[10px]"
        style={{ color, borderColor: color }}
      >
        {label}
      </span>
    )
  },
}),
```

- [ ] **Step 5: `ModelsTable` 加 `statusFor` prop + 行 muting**（`ui-v4/src/components/models/ModelsTable.tsx`）

props（[:28-39](../../ui-v4/src/components/models/ModelsTable.tsx#L28-L39)）加 `statusFor: (model: Model) => ModelStatus`；`augmentRows` 调用（[:53](../../ui-v4/src/components/models/ModelsTable.tsx#L53)）传入；`data` useMemo 依赖加 `statusFor`：
```tsx
const data = useMemo(() => augmentRows(models, telemetryFor, statusFor), [models, telemetryFor, statusFor])
```
行 className（[:103-107](../../ui-v4/src/components/models/ModelsTable.tsx#L103-L107)）加 config-disabled 前景 muting（不用 opacity）：
```tsx
const selected = row.original.model.id === selectedId
const muted = row.original.status === "config-disabled"
return (
  <tr
    key={row.id}
    className={`border-b border-[#1e1e24] ${onSelect ? "cursor-pointer hover:bg-[#1a1a20]" : ""} ${muted ? "text-[var(--color-muted)]" : ""} ${selected ? "border-l-2 border-l-[var(--color-primary)] bg-[#3a2f1a]" : ""}`}
    aria-current={selected ? "true" : undefined}
    onClick={onSelect ? () => onSelect(row.original.model.id) : undefined}
  >
```
加 import：`import type { ModelStatus } from "@/lib/model-status"`（+ `Model` 已导入）。

- [ ] **Step 6: ModelsPage 传 `statusFor` 给 ModelsTable**（`ui-v4/src/components/models/ModelsPage.tsx`）

`<ModelsTable ... />`（[:206-215](../../ui-v4/src/components/models/ModelsPage.tsx#L206-L215)）加 prop：
```tsx
              : <ModelsTable
                  models={visible}
                  columnVisibility={columns}
                  telemetryFor={telemetryFor}
                  statusFor={statusFor}
                  maxRequests7d={maxRequests7d}
                  sorting={sorting}
                  onSortingChange={setSorting}
                  selectedId={selectedId}
                  onSelect={select}
                />
```

- [ ] **Step 7: 补 exportCsv 的 augmentRows 调用（防 typecheck 红）**（`ui-v4/src/components/models/ModelsPage.tsx`）

`exportCsv`（[:136-140](../../ui-v4/src/components/models/ModelsPage.tsx#L136-L140)）的 `augmentRows` 现在需要第三参——A6 会正式加 CSV 列，这里先传 `statusFor` 让类型通过：
```tsx
const sortedModels = sortModelRows(augmentRows(visible, telemetryFor, statusFor), sorting).map((r) => r.model)
```

- [ ] **Step 8: 更新 ModelsTable 组件测试**（`ui-v4/tests/ModelsTable.vitest.test.tsx`）

该测试渲染 `<ModelsTable>`，现在必须传 `statusFor`。找到每个 `render(<ModelsTable ... />)`，加 `statusFor={() => "enabled"}`（或按用例意图）。新增一条 muting 断言：

```tsx
it("mutes config-disabled rows and shows a config-off chip", () => {
  render(
    <ModelsTable
      models={[{ id: "d", name: "D", vendor: "V", model_picker_enabled: true } as unknown as Model]}
      columnVisibility={{}}
      telemetryFor={() => null}
      statusFor={() => "config-disabled"}
      maxRequests7d={1}
      sorting={[]}
      onSortingChange={() => {}}
    />,
  )
  expect(screen.getByText("config-off")).toBeInTheDocument()
  // 行前景 muting class 存在（不是 opacity）。
  const row = screen.getByText("d").closest("tr")!
  expect(row.className).toContain("text-[var(--color-muted)]")
})
```

- [ ] **Step 9: 运行全部相关测试**

Run: `cd ui-v4 && bun test tests/model-table-columns.bun.test.ts tests/model-columns.bun.test.ts`
Run: `cd ui-v4 && bunx vitest run tests/ModelsTable.vitest.test.tsx`
Expected: 全 PASS。

- [ ] **Step 10: typecheck + lint + commit**

Run: `cd ui-v4 && bun run typecheck`
Run: `bunx eslint ui-v4/src/lib/model-columns.ts ui-v4/src/lib/model-status.ts ui-v4/src/hooks/useModels.ts ui-v4/src/components/models/model-table-columns.tsx ui-v4/src/components/models/ModelsTable.tsx ui-v4/src/components/models/ModelsPage.tsx`
Expected: 无错。

```bash
git add -- ui-v4/src/hooks/useModels.ts ui-v4/src/lib/model-columns.ts ui-v4/src/components/models/model-table-columns.tsx ui-v4/src/components/models/ModelsTable.tsx ui-v4/src/components/models/ModelsPage.tsx ui-v4/tests/model-table-columns.bun.test.ts ui-v4/tests/ModelsTable.vitest.test.tsx
git commit -m "feat(ui-v4): status 列三态 + config-disabled 行 muting

useModels 消费 InternalModelsResponse；statusFor 闭包喂 augmentRows；
config-disabled 行前景 muting（非 opacity，不洗淡 selected 底），picker-disabled 仅 chip。"
```

---

## Task A5: 筛选（默认包含两种禁用）

**Files:**
- Modify: `ui-v4/src/lib/model-filters.ts`
- Modify: `ui-v4/src/components/models/ModelsFilterBar.tsx`
- Modify: `ui-v4/src/components/models/ModelsPage.tsx`（`filterModels` 调用传 `statusFor`）
- Test: `ui-v4/tests/model-filters.bun.test.ts`、`ui-v4/tests/ModelsFilterBar.vitest.test.tsx`

**Interfaces:**
- Consumes: `statusFor`（A3）、`ModelStatus`（A2）。
- Produces: `ModelFilters.includeConfigDisabled/includePickerDisabled`；`filterModels(models, filters, hasTelemetry, statusFor)`。

- [ ] **Step 1: 写失败测试**（`ui-v4/tests/model-filters.bun.test.ts` 追加）

```ts
import { modelStatus } from "@/lib/model-status"

const statusFor = (set: Set<string>) => (m: Model) => modelStatus(m, set)

test("includes both disabled kinds by default", () => {
  const models = [
    { id: "on", name: "on", model_picker_enabled: true },
    { id: "cfg", name: "cfg", model_picker_enabled: true },
    { id: "pk", name: "pk", model_picker_enabled: false },
  ] as unknown as Array<Model>
  const out = filterModels(models, EMPTY_FILTERS, () => false, statusFor(new Set(["cfg"])))
  expect(out.map((m) => m.id).sort()).toEqual(["cfg", "on", "pk"])
})

test("hides config-disabled when includeConfigDisabled=false", () => {
  const models = [
    { id: "on", name: "on", model_picker_enabled: true },
    { id: "cfg", name: "cfg", model_picker_enabled: true },
  ] as unknown as Array<Model>
  const out = filterModels(models, { ...EMPTY_FILTERS, includeConfigDisabled: false }, () => false, statusFor(new Set(["cfg"])))
  expect(out.map((m) => m.id)).toEqual(["on"])
})

test("hides picker-disabled when includePickerDisabled=false", () => {
  const models = [
    { id: "on", name: "on", model_picker_enabled: true },
    { id: "pk", name: "pk", model_picker_enabled: false },
  ] as unknown as Array<Model>
  const out = filterModels(models, { ...EMPTY_FILTERS, includePickerDisabled: false }, () => false, statusFor(new Set()))
  expect(out.map((m) => m.id)).toEqual(["on"])
})

test("countActiveFilters counts each excluded kind", () => {
  expect(countActiveFilters({ ...EMPTY_FILTERS, includeConfigDisabled: false }, [0, 0])).toBe(1)
  expect(countActiveFilters({ ...EMPTY_FILTERS, includeConfigDisabled: false, includePickerDisabled: false }, [0, 0])).toBe(2)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd ui-v4 && bun test tests/model-filters.bun.test.ts`
Expected: FAIL — `filterModels` 4 参签名不符 / `EMPTY_FILTERS` 无新字段。

- [ ] **Step 3: 改 `model-filters.ts`**

`ModelFilters`（[:6-19](../../ui-v4/src/lib/model-filters.ts#L6-L19)）加：
```ts
  /** Include config-disabled (config.disabled_models) rows. Default true. */
  includeConfigDisabled: boolean
  /** Include picker-disabled (model_picker_enabled:false) rows. Default true. */
  includePickerDisabled: boolean
```
`EMPTY_FILTERS`（[:21-32](../../ui-v4/src/lib/model-filters.ts#L21-L32)）加 `includeConfigDisabled: true, includePickerDisabled: true`。

`filterModels`（[:94-112](../../ui-v4/src/lib/model-filters.ts#L94-L112)）加第四参 + status 排除（加 import `import type { ModelStatus } from "@/lib/model-status"`）：
```ts
export function filterModels(
  models: Array<Model>,
  filters: ModelFilters,
  hasTelemetry: (id: string) => boolean,
  statusFor: (model: Model) => ModelStatus,
): Array<Model> {
  const query = filters.search.trim().toLowerCase()
  return models.filter((m) => {
    const status = statusFor(m)
    if (status === "config-disabled" && !filters.includeConfigDisabled) return false
    if (status === "picker-disabled" && !filters.includePickerDisabled) return false
    if (query && !m.id.toLowerCase().includes(query) && !m.name.toLowerCase().includes(query)) return false
    // ... 其余判据不变
  })
}
```
`countActiveFilters`（[:78-91](../../ui-v4/src/lib/model-filters.ts#L78-L91)）加：
```ts
  if (!f.includeConfigDisabled) n++
  if (!f.includePickerDisabled) n++
```

- [ ] **Step 4: ModelsPage `filterModels` 调用传 `statusFor`**（`ui-v4/src/components/models/ModelsPage.tsx`）

`visible` useMemo（[:126](../../ui-v4/src/components/models/ModelsPage.tsx#L126)）：
```tsx
const visible = useMemo(() => filterModels(models, filters, hasTelemetry, statusFor), [models, filters, hasTelemetry, statusFor])
```

- [ ] **Step 5: ModelsFilterBar 加两个 status 开关**（`ui-v4/src/components/models/ModelsFilterBar.tsx`）

在 caps 组（[:139-151](../../ui-v4/src/components/models/ModelsFilterBar.tsx#L139-L151)）之后加一个 status 组（toggle 语义：active 边框 = 包含）：
```tsx
      <div className="flex items-center gap-1">
        <span className="text-[11px] uppercase text-[var(--color-muted)]">status:</span>
        <button
          type="button"
          onClick={() => onChange({ includeConfigDisabled: !filters.includeConfigDisabled })}
          className={`border px-1.5 py-0.5 text-[11px] ${filters.includeConfigDisabled ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-[var(--color-border)] text-[#999]"}`}
        >
          config-off
        </button>
        <button
          type="button"
          onClick={() => onChange({ includePickerDisabled: !filters.includePickerDisabled })}
          className={`border px-1.5 py-0.5 text-[11px] ${filters.includePickerDisabled ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-[var(--color-border)] text-[#999]"}`}
        >
          picker-off
        </button>
      </div>
```

- [ ] **Step 6: 更新 ModelsFilterBar 组件测试**（`ui-v4/tests/ModelsFilterBar.vitest.test.tsx`）

若该测试构造完整 `filters` 对象（非用 `EMPTY_FILTERS`），补两个新字段避免 typecheck 红。新增一条：
```tsx
it("toggles includeConfigDisabled", async () => {
  const onChange = vi.fn()
  render(<ModelsFilterBar filters={EMPTY_FILTERS} onChange={onChange} options={{ vendors: [], types: [], endpoints: [], restrictedTo: [], policyStates: [] }} billingBounds={[0, 0]} />)
  await userEvent.setup().click(screen.getByRole("button", { name: "config-off" }))
  expect(onChange).toHaveBeenCalledWith({ includeConfigDisabled: false })
})
```
（`EMPTY_FILTERS`、`userEvent`、`vi` 按现有 import；若无则补。）

- [ ] **Step 7: 运行 + typecheck + lint + commit**

Run: `cd ui-v4 && bun test tests/model-filters.bun.test.ts`
Run: `cd ui-v4 && bunx vitest run tests/ModelsFilterBar.vitest.test.tsx tests/ModelsPage.vitest.test.tsx`
Run: `cd ui-v4 && bun run typecheck`
Run: `bunx eslint ui-v4/src/lib/model-filters.ts ui-v4/src/components/models/ModelsFilterBar.tsx ui-v4/src/components/models/ModelsPage.tsx`
Expected: 全绿。

```bash
git add -- ui-v4/src/lib/model-filters.ts ui-v4/src/components/models/ModelsFilterBar.tsx ui-v4/src/components/models/ModelsPage.tsx ui-v4/tests/model-filters.bun.test.ts ui-v4/tests/ModelsFilterBar.vitest.test.tsx
git commit -m "feat(ui-v4): status 筛选开关（config-off/picker-off，默认包含）"
```

---

## Task A6: CSV status 列

**Files:**
- Modify: `ui-v4/src/lib/models-csv.ts`
- Modify: `ui-v4/src/components/models/ModelsPage.tsx`（`modelsToCsv` 调用传 `statusFor`）
- Test: `ui-v4/tests/models-csv.bun.test.ts`

**Interfaces:**
- Consumes: `statusFor`（A3）。
- Produces: `modelsToCsv(models, telemetryFor, statusFor)`，HEADERS 含 `status`。

- [ ] **Step 1: 写失败测试**（`ui-v4/tests/models-csv.bun.test.ts` 追加）

```ts
import { modelStatus } from "@/lib/model-status"

test("CSV includes a status column", () => {
  const models = [
    { id: "on", name: "on", vendor: "V", model_picker_enabled: true },
    { id: "cfg", name: "cfg", vendor: "V", model_picker_enabled: true },
  ] as unknown as Array<Model>
  const csv = modelsToCsv(models, () => null, (m) => modelStatus(m, new Set(["cfg"])))
  const [header, ...rows] = csv.split("\n")
  expect(header.split(",")).toContain("status")
  const statusIdx = header.split(",").indexOf("status")
  expect(rows[0].split(",")[statusIdx]).toBe("enabled")
  expect(rows[1].split(",")[statusIdx]).toBe("config-disabled")
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd ui-v4 && bun test tests/models-csv.bun.test.ts`
Expected: FAIL — `modelsToCsv` 只收 2 参 / 无 status 列。

- [ ] **Step 3: 改 `models-csv.ts`**

`HEADERS`（[:7-25](../../ui-v4/src/lib/models-csv.ts#L7-L25)）末尾加 `"status"`。`modelsToCsv`（[:36-62](../../ui-v4/src/lib/models-csv.ts#L36-L62)）加参 + cell：
```ts
import type { ModelStatus } from "@/lib/model-status"
// ...
export function modelsToCsv(
  models: Array<Model>,
  telemetryFor: (id: string) => JoinedModelTelemetry | null,
  statusFor: (model: Model) => ModelStatus,
): string {
  const rows = models.map((model) => {
    const c = deriveCapabilities(model)
    const t = telemetryFor(model.id)?.last7d ?? null
    const cells = [
      // ... 现有 17 个 cell 不变 ...
      s(t?.failureCount),
      statusFor(model),
    ]
    return cells.map((cell) => esc(cell)).join(",")
  })
  return [HEADERS.join(","), ...rows].join("\n")
}
```

- [ ] **Step 4: ModelsPage `exportCsv` 传 `statusFor`**（`ui-v4/src/components/models/ModelsPage.tsx`）

`exportCsv`（[:138](../../ui-v4/src/components/models/ModelsPage.tsx#L138)）：
```tsx
const csv = modelsToCsv(sortedModels, telemetryFor, statusFor)
```

- [ ] **Step 5: 运行 + typecheck + lint + commit**

Run: `cd ui-v4 && bun test tests/models-csv.bun.test.ts`
Run: `cd ui-v4 && bun run typecheck`
Run: `bunx eslint ui-v4/src/lib/models-csv.ts ui-v4/src/components/models/ModelsPage.tsx`
Expected: 全绿。

```bash
git add -- ui-v4/src/lib/models-csv.ts ui-v4/src/components/models/ModelsPage.tsx ui-v4/tests/models-csv.bun.test.ts
git commit -m "feat(ui-v4): CSV 导出 status 列"
```

- [ ] **Step 6: Phase A 收尾——全套件 + build:ui-v4（rollup 真实构建）**

Run: `bun test tests/models/`（后端回归）
Run: `cd ui-v4 && bun test .bun.test && bunx vitest run`（ui-v4 全测试）
Run: `bun run build:ui-v4`（**rollup 构建——验 `~backend` 模块纯，vitest 假绿在此暴露**）
Expected: 全绿、构建成功。

---

# Phase B — 模态抽屉

## Task B1: ModelDetail → Radix Dialog 模态

**Files:**
- Modify: `ui-v4/src/components/models/ModelDetail.tsx`
- Test: `ui-v4/tests/ModelDetail.vitest.test.tsx`

**Interfaces:**
- Consumes: `Model`、`JoinedModelTelemetry`、`onClose`（props 签名不变）。
- Produces: 无新导出——内部结构从 flex 兄弟面板改为 `Dialog` 浮层。

- [ ] **Step 1: 先改测试（Escape 派发目标 window→document + focus 断言）**（`ui-v4/tests/ModelDetail.vitest.test.tsx`）

`"closes on Escape"`（[:245-256](../../ui-v4/tests/ModelDetail.vitest.test.tsx#L245-L256)）：`fireEvent.keyDown(globalThis.window, ...)` → `document`：
```tsx
it("closes on Escape", () => {
  const onClose = vi.fn()
  render(<ModelDetail model={VISION_MODEL} telemetry={null} onClose={onClose} />)
  fireEvent.keyDown(document, { key: "Escape" })
  expect(onClose).toHaveBeenCalledTimes(1)
})
```
`"does NOT close on Escape while a text control is focused"`（[:258-276](../../ui-v4/tests/ModelDetail.vitest.test.tsx#L258-L276)）：input 放进抽屉内 + 派发 document：
```tsx
it("does NOT close on Escape while a text control is focused (isTyping guard)", () => {
  const onClose = vi.fn()
  render(<ModelDetail model={VISION_MODEL} telemetry={null} onClose={onClose} />)
  // 抽屉内放一个 input 并聚焦（模态下焦点被 trap 在抽屉内，外部 input 不可聚焦）。
  const region = screen.getByRole("dialog")
  const input = document.createElement("input")
  region.append(input)
  input.focus()
  fireEvent.keyDown(document, { key: "Escape" })
  expect(onClose).not.toHaveBeenCalled()
  input.remove()
  // 焦点移出文本控件后 Escape 关闭。
  ;(screen.getByRole("dialog") as HTMLElement).focus()
  fireEvent.keyDown(document, { key: "Escape" })
  expect(onClose).toHaveBeenCalledTimes(1)
})
```
`"moves focus into the panel on open"`（[:278-287](../../ui-v4/tests/ModelDetail.vitest.test.tsx#L278-L287)）：Radix Dialog 用 `role="dialog"`，焦点落抽屉内：
```tsx
it("moves focus into the panel on open", () => {
  render(<ModelDetail model={VISION_MODEL} telemetry={null} onClose={() => {}} />)
  const dialog = screen.getByRole("dialog")
  expect(dialog.contains(document.activeElement) || document.activeElement === dialog).toBe(true)
})
```

> 其余用例（tab 内容、resize separator、键盘导航）保持不变——经 Radix Portal 仍被 `screen` 命中。

- [ ] **Step 2: 运行确认失败**（红——旧组件仍挂 window 监听、无 `role="dialog"`）

Run: `cd ui-v4 && bunx vitest run tests/ModelDetail.vitest.test.tsx`
Expected: FAIL —`role="dialog"` 找不到 / Escape 到 document 不触发旧的 window 监听。

- [ ] **Step 3: 重写 ModelDetail 用 Radix Dialog**（`ui-v4/src/components/models/ModelDetail.tsx`，整文件替换）

```tsx
import type { Model } from "~backend/lib/models/client"

import { deriveCapabilities } from "~backend/lib/models/capabilities"
import { Dialog, Tabs } from "radix-ui"
import { useMemo, useState } from "react"

import type { JoinedModelTelemetry } from "@/lib/model-telemetry"

import { BillingPolicyTab } from "@/components/models/detail-tabs/BillingPolicyTab"
import { CapabilitiesTab } from "@/components/models/detail-tabs/CapabilitiesTab"
import { LimitsVisionTab } from "@/components/models/detail-tabs/LimitsVisionTab"
import { OverviewTab } from "@/components/models/detail-tabs/OverviewTab"
import { RawJsonTab } from "@/components/models/detail-tabs/RawJsonTab"
import { TelemetryTab } from "@/components/models/detail-tabs/TelemetryTab"
import { MODEL_DETAIL_TABS, ModelDetailSubRail, type ModelDetailTab } from "@/components/models/ModelDetailSubRail"
import { useResizableWidth } from "@/hooks/useResizableWidth"

/** localStorage key for the model-detail drawer width (distinct from the TOC sidebar's). */
const MODELS_DETAIL_WIDTH_KEY = "ui-v4-models-detail-width"

/** Shared class for each tab's content pane. */
const CONTENT_CLASS = "min-h-0 flex-1 overflow-auto p-3 outline-none"

/** True when focus is in a text-entry control — so a stray Escape there doesn't close the drawer. */
function isTyping(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable
}

interface ModelDetailProps {
  model: Model
  telemetry: JoinedModelTelemetry | null
  onClose: () => void
}

/**
 * Right-docked, user-resizable **modal drawer** for one model (Radix `Dialog`).
 *
 * Selection is URL-borne (`?model=<id>`, owned by ModelsPage) — this is a pure
 * view over the resolved model. Radix provides focus-trap, scroll-lock,
 * focus-restore-on-close, `aria-modal`, portal, and the dimming overlay
 * (click-to-close). Escape closes unless typing (`onEscapeKeyDown` + isTyping
 * guard, so an in-drawer text control keeps its Escape). Six vertical tabs
 * surface every field. The drag handle sits on the drawer's LEFT edge
 * (right-docked → invert); default width is 60vw, resizable 320–90vw.
 */
export function ModelDetail({ model, telemetry, onClose }: ModelDetailProps) {
  const [tab, setTab] = useState<ModelDetailTab>(MODEL_DETAIL_TABS[0])
  const { width, min, max, dragging, dragEdgeX, handleProps } = useResizableWidth(MODELS_DETAIL_WIDTH_KEY, {
    min: 320,
    max: Math.round(window.innerWidth * 0.9),
    default: Math.round(window.innerWidth * 0.6),
    invert: true,
  })
  const caps = useMemo(() => deriveCapabilities(model), [model])

  return (
    <Dialog.Root
      open
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/50"
        />
        <Dialog.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            if (isTyping()) e.preventDefault()
          }}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed inset-y-0 right-0 z-50 flex outline-none"
          style={{ width }}
        >
          <div
            {...handleProps}
            role="separator"
            aria-label="Resize model detail"
            aria-orientation="vertical"
            aria-valuenow={Math.round(width)}
            aria-valuemin={min}
            aria-valuemax={max}
            title="Drag to resize"
            className="w-[5px] shrink-0 cursor-col-resize touch-none select-none bg-transparent transition-colors hover:bg-[var(--color-primary)]/40"
          />
          <aside className="mono flex min-w-0 flex-1 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] outline-none">
            <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
              <Dialog.Title className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-primary)]">{model.id}</Dialog.Title>
              <Dialog.Close
                aria-label="Close model detail"
                className="px-1 text-[16px] leading-none text-[var(--color-muted)] hover:text-[var(--color-text)]"
              >
                ×
              </Dialog.Close>
            </div>
            <Tabs.Root
              value={tab}
              onValueChange={(v) => setTab(v as ModelDetailTab)}
              orientation="vertical"
              className="flex min-h-0 flex-1"
            >
              <ModelDetailSubRail />
              <Tabs.Content value="Overview" className={CONTENT_CLASS}>
                <OverviewTab model={model} />
              </Tabs.Content>
              <Tabs.Content value="Capabilities" className={CONTENT_CLASS}>
                <CapabilitiesTab model={model} caps={caps} />
              </Tabs.Content>
              <Tabs.Content value="Limits + Vision" className={CONTENT_CLASS}>
                <LimitsVisionTab model={model} />
              </Tabs.Content>
              <Tabs.Content value="Billing + Policy" className={CONTENT_CLASS}>
                <BillingPolicyTab model={model} />
              </Tabs.Content>
              <Tabs.Content value="Telemetry" className={CONTENT_CLASS}>
                <TelemetryTab telemetry={telemetry} />
              </Tabs.Content>
              <Tabs.Content value="Raw JSON" className={CONTENT_CLASS}>
                <RawJsonTab model={model} />
              </Tabs.Content>
            </Tabs.Root>
          </aside>
          {dragging && dragEdgeX !== undefined ?
            <div
              aria-hidden="true"
              className="pointer-events-none fixed inset-y-0 left-0 z-[60] w-[2px] bg-[var(--color-primary)]"
              style={{ transform: `translateX(${dragEdgeX}px)` }}
            />
          : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
```

> 变化点：删除 `useEffect`/`useRef`/`panelRef`/`onCloseRef` 手搓 focus+Escape（Radix 接管）；`aside` 去掉 `role="region"`/`tabIndex`（Dialog.Content 已是 `role="dialog"` + focus 目标）；宽度 60vw；`Dialog.Title` 用 model.id。

- [ ] **Step 4: 运行确认通过**

Run: `cd ui-v4 && bunx vitest run tests/ModelDetail.vitest.test.tsx`
Expected: PASS（Escape 三条 + focus + tabs + resize 全绿）。

- [ ] **Step 5: typecheck + lint + commit**

Run: `cd ui-v4 && bun run typecheck`
Run: `bunx eslint ui-v4/src/components/models/ModelDetail.tsx`
Expected: 无错。

```bash
git add -- ui-v4/src/components/models/ModelDetail.tsx ui-v4/tests/ModelDetail.vitest.test.tsx
git commit -m "feat(ui-v4): 模型详情改 Radix Dialog 模态抽屉（60vw 可拖拽，Radix 接管 focus/Esc/遮罩）"
```

---

## Task B2: ModelsPage 布局简化（表格全宽、抽屉 portal）

**Files:**
- Modify: `ui-v4/src/components/models/ModelsPage.tsx`
- Test: `ui-v4/tests/ModelsPage.vitest.test.tsx`

**Interfaces:**
- Consumes: `ModelDetail`（B1，模态浮层，自带 portal）。

- [ ] **Step 1: 写/改测试——选中时列表容器不再被压窄**（`ui-v4/tests/ModelsPage.vitest.test.tsx` 追加/调整）

```tsx
it("renders the model detail as a modal dialog (not a co-planar sibling squeezing the list)", async () => {
  // 渲染 ModelsPage、选中一个模型（点 id 按钮）后，详情以 role=dialog 出现，
  // 且列表 table 仍在文档中（未被卸载/未被 split）。
  // （按现有 ModelsPage 测试的 render + query pattern；选中后：）
  expect(await screen.findByRole("dialog")).toBeInTheDocument()
  expect(screen.getByRole("table")).toBeInTheDocument()
})
```
（依现有 `ModelsPage.vitest.test.tsx` 的 provider/render 脚手架接入——若该文件已有"select model"用例，就地加 `findByRole("dialog")` 断言即可。）

- [ ] **Step 2: 运行确认失败**

Run: `cd ui-v4 && bunx vitest run tests/ModelsPage.vitest.test.tsx`
Expected: FAIL — 详情当前是 co-planar `<aside>`（B1 已改成 dialog 则这里可能已 pass；若 B1 已合并，本步聚焦布局 `flex` 简化的视觉不变性，见 Step 3）。

- [ ] **Step 3: 简化布局**（`ui-v4/src/components/models/ModelsPage.tsx`，[:194-227](../../ui-v4/src/components/models/ModelsPage.tsx#L194-L227)）

把「表格 flex-1 + ModelDetail 兄弟」的 `flex` 行改为：表格容器恒全宽，ModelDetail 作为浮层（Dialog 自带 portal，放哪层都行，语义上并列于表格容器之后）：
```tsx
          <div className="min-h-0 flex-1 overflow-auto">
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
            : <ModelsTable
                models={visible}
                columnVisibility={columns}
                telemetryFor={telemetryFor}
                statusFor={statusFor}
                maxRequests7d={maxRequests7d}
                sorting={sorting}
                onSortingChange={setSorting}
                selectedId={selectedId}
                onSelect={select}
              />
            }
            <UnmatchedTelemetry rows={index.unmatched} />
          </div>
          {selectedModel ?
            <ModelDetail
              key={selectedModel.id}
              model={selectedModel}
              telemetry={telemetryFor(selectedModel.id)}
              onClose={clearSelection}
            />
          : null}
```
即：**删掉**包住二者的 `<div className="flex min-h-0 flex-1">` 外层（[:194](../../ui-v4/src/components/models/ModelsPage.tsx#L194) 和其闭合 [:227](../../ui-v4/src/components/models/ModelsPage.tsx#L227)），让表格容器直接是 `raw ? ... : <>...</>` 分支下的全宽块；ModelDetail 因是 Dialog portal 不占布局流。

- [ ] **Step 4: 运行确认通过**

Run: `cd ui-v4 && bunx vitest run tests/ModelsPage.vitest.test.tsx`
Expected: PASS。

- [ ] **Step 5: typecheck + lint + commit**

Run: `cd ui-v4 && bun run typecheck`
Run: `bunx eslint ui-v4/src/components/models/ModelsPage.tsx`
Expected: 无错。

```bash
git add -- ui-v4/src/components/models/ModelsPage.tsx ui-v4/tests/ModelsPage.vitest.test.tsx
git commit -m "feat(ui-v4): ModelsPage 布局简化——表格恒全宽，详情抽屉浮层不再压窄列表"
```

- [ ] **Step 6: Phase B 收尾——全 ui-v4 测试 + build:ui-v4**

Run: `cd ui-v4 && bun test .bun.test && bunx vitest run`
Run: `bun run build:ui-v4`
Expected: 全绿、构建成功。

---

## 收尾（全部任务后）

- [ ] **全仓 typecheck + lint + 全测试**

Run: `bun run typecheck`
Run: `bun run lint:all`
Run: `bun test tests/models/`（后端）
Run: `cd ui-v4 && bun test .bun.test && bunx vitest run`（ui-v4）
Run: `bun run build:ui-v4`
Expected: 全绿。

- [ ] **subagent 交付审计**（session-closeout 步①）：派 subagent 对照本 plan + spec 独立核验实现（红线未破、三态正确、Escape 测试真驱动 document、build:ui-v4 绿），显式裁判轴 = 长远正确 + 完整。
- [ ] **doc-sync**（步②）：`docs/DESIGN.md`「活的架构现状」若列了 `/api/models` 语义/Models 页，更新为「返全量 + disabled[]」「详情模态抽屉」；spec 头部 Status 改「已落地」+ commit。
- [ ] **归档 plan**（步③）：本 plan 头部加实施状态注解。
- [ ] **§8 开放问题最终确认**（若实施中有偏离，回填 spec）。

---

## §8 开放问题在本 plan 的默认取值（实施时若用户另有指示则改）

- **status 列可排序**：默认**不可排序**（本 plan 未接 ACCESSORS）。若要可排序，另起小任务补 `SortableColumnId` + `ACCESSORS`（喂 table + CSV 两路排序）。
- **筛选控件形态**：两个 toggle 按钮（config-off / picker-off），active=包含。
- **状态栏「N disabled」提示**：本 plan 不加（YAGNI，可后续）。
- **config-disabled chip 用色**：复用 `--color-fail`（红/警示）；picker-off 用 `--color-muted`。
