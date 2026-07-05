# Phase 2 — 详情抽屉 + 全字段 + 后端暴露

> 总纲见 [README.md](README.md)。依赖 Phase 1 的 `buildModelTelemetryIndex`/`parseRequestTelemetry`。Global Constraints 隐含适用。
> 交付：点表格行 → 右侧抽屉（6 tab）看全字段 + 遥测；抽屉**替换**行内 JSON 展开；后端 `/api/models` 暴露 `request_headers`。

## 文件结构

- Modify `src/routes/models/internal.ts`（后端：删 `stripInternalFields` 对 `request_headers` 的剥离）。
- Create `ui/src/composables/useModelDetail.ts`（选中 id + 抽屉开关 + 遥测 index；导出 `UseModelDetailReturn`）。
- Create `ui/src/components/models/detail/DetailSection.vue`、`DetailKeyValueList.vue`（共享 presentational 原语）。
- Create `ui/src/components/models/detail/tabs/{OverviewTab,CapabilitiesTab,LimitsVisionTab,BillingPolicyTab,TelemetryTab,RawJsonTab}.vue`。
- Create `ui/src/components/models/ModelDetailDrawer.vue`（`v-navigation-drawer` + `v-tabs`/`v-window`）。
- Modify `ui/src/pages/vuetify/VModelsPage.vue`（接抽屉 + 传 telemetry index）、`ui/src/components/models/ModelsTable.vue`（删行内展开、行点击 emit `select`）。
- Modify `ui/vitest/helpers/mount.ts`（补 stub）。
- Tests：`ui/tests/use-model-detail.test.ts`、`ui/vitest/model-detail-drawer.test.ts`、后端 `tests/models/internal-route.http.test.ts`（或既有对应文件）。

---

### Task 1: 后端 — `/api/models` 暴露 `request_headers`

按 ADR `internal-tool-security-posture`（spec §13）移除剥离。

**Files:**
- Modify: `src/routes/models/internal.ts:14-18`（删 `stripInternalFields`）、`:29`（OpenAPI schema 注释去掉 "request_headers is stripped"）、`:77`/`:103`（改为直接返回 model）
- Test: `tests/models/` 下新增或扩展（断言 `request_headers` 出现在 `/api/models` 响应）

- [ ] **Step 1: 先 grep 消费者**

Run: `grep -rn "stripInternalFields" src/ tests/`
把命中的每处纳入本 task（若仅 `internal.ts` 自用，直接删；若有测试断言它剥离，改为断言透传）。

- [ ] **Step 2: 写失败测试**

在 `tests/models/`（镜像既有测试组织；若已有 `internal-route.http.test.ts` 则扩展，否则新建）加：

```ts
import { describe, expect, test } from "bun:test"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { createFullTestApp } from "../helpers/test-bootstrap" // 按既有 helper 命名对齐
import { setModels } from "~/lib/state"

describe("GET /api/models exposes request_headers", () => {
  useIsolatedRuntime()

  test("request_headers passes through (not stripped)", async () => {
    setModels({
      object: "list",
      data: [{ id: "m1", name: "m1", vendor: "V", object: "model", preview: false, model_picker_enabled: true, is_chat_default: false, is_chat_fallback: false, version: "1", request_headers: { "x-foo": "bar" } } as never],
    })
    const app = createFullTestApp()
    const res = await app.request("/api/models")
    const body = (await res.json()) as { data: Array<Record<string, unknown>> }
    expect(body.data[0].request_headers).toEqual({ "x-foo": "bar" })
  })
})
```

> **注**：以既有 `tests/models/` 里 http 测试的 helper 用法为准（`createFullTestApp`/`setModels` 具体名对齐现有文件；先读一个同目录 `.http.test.ts` 抄接线）。

- [ ] **Step 3: 跑确认失败**

Run: `bun run test:backend 2>&1 | grep -i request_headers`
Expected: FAIL（当前被 `stripInternalFields` 剥离 → `undefined`）。

- [ ] **Step 4: 删剥离**

`internal.ts`：删除 `stripInternalFields` 函数；list handler 改 `data: state.models?.data ?? []`；single handler 改 `return c.json(model, 200)`；把 schema 注释 "`request_headers` is stripped" 删掉。

- [ ] **Step 5: 跑测试 + typecheck（后端）**

Run: `bun run test:backend 2>&1 | grep -iE "request_headers|models" | tail && bun run typecheck 2>&1 | tail -3`
Expected: PASS；0 type error。

- [ ] **Step 6: 提交**

```bash
git add -- src/routes/models/internal.ts tests/models/internal-route.http.test.ts
git commit -F - <<'MSG'
feat(models): expose request_headers on /api/models

Remove stripInternalFields — copilot-api is an internal personal tool
(ADR internal-tool-security-posture), so stripping model request_headers
for a non-existent external consumer is superfluous. The ops UI's Raw
JSON tab now sees the full model object (richest-data-flow).
MSG
```

---

### Task 2: `useModelDetail` 页面作用域 composable

选中 `model.id` + 抽屉开关 + 遥测 index（从 snapshot 构建）。选中态是 **id 字符串**，不复制 model。

**Files:**
- Create: `ui/src/composables/useModelDetail.ts`
- Test: `ui/tests/use-model-detail.test.ts`

**Interfaces:**
- Consumes: `Model`（`~backend`）、`buildModelTelemetryIndex`/`JoinedModelTelemetry`（Phase 1）、`RequestTelemetrySnapshot`（Phase 1）。
- Produces:
  ```ts
  export interface UseModelDetailReturn {
    selectedId: Ref<string | null>
    isOpen: ComputedRef<boolean>
    telemetryIndex: ComputedRef<ModelTelemetryIndex>
    open: (id: string) => void
    close: () => void
    telemetryFor: (id: string) => JoinedModelTelemetry | null
  }
  export function useModelDetail(models: Ref<Array<Model>>, snapshot: Ref<RequestTelemetrySnapshot | null>): UseModelDetailReturn
  ```
  `isOpen` = `selectedId !== null`；`telemetryFor(id)` = `telemetryIndex.byId.get(normalizeModelId(id)) ?? null`。

- [ ] **Step 1: 写失败测试**

```ts
import type { Model } from "~backend/lib/models/client"

import { describe, expect, test } from "bun:test"
import { ref } from "vue"

import { useModelDetail } from "@/composables/useModelDetail"
import type { RequestTelemetrySnapshot } from "@/composables/telemetry-parse"

const m = (id: string): Model => ({ id, name: id, vendor: "Anthropic", object: "model", preview: false, model_picker_enabled: true, is_chat_default: false, is_chat_fallback: false, version: "1" } as Model)
const snap = (last7d: Array<{ model: string; requestCount: number }>): RequestTelemetrySnapshot => ({
  acceptedSinceStart: 0, bucketSizeMinutes: 5, windowDays: 7, totalLast7d: 0, buckets: [], modelsSinceStart: [],
  modelsLast7d: last7d.map((r) => ({ model: r.model, requestCount: r.requestCount, successCount: 0, failureCount: 0, totalDurationMs: 0, averageDurationMs: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 }, buckets: [] })),
})

describe("useModelDetail", () => {
  test("open/close toggles selectedId + isOpen; stores id not object", () => {
    const d = useModelDetail(ref([m("claude-opus-4.8")]), ref(null))
    expect(d.isOpen.value).toBe(false)
    d.open("claude-opus-4.8")
    expect(d.selectedId.value).toBe("claude-opus-4.8")
    expect(d.isOpen.value).toBe(true)
    d.close()
    expect(d.selectedId.value).toBeNull()
    expect(d.isOpen.value).toBe(false)
  })

  test("telemetryFor joins by normalized id", () => {
    const d = useModelDetail(ref([m("claude-opus-4.8")]), ref(snap([{ model: "claude-opus-4.8", requestCount: 5 }])))
    expect(d.telemetryFor("claude-opus-4.8")?.last7d?.requestCount).toBe(5)
    expect(d.telemetryFor("nonexistent")).toBeNull()
  })

  test("telemetryIndex recomputes when snapshot changes", () => {
    const s = ref<RequestTelemetrySnapshot | null>(null)
    const d = useModelDetail(ref([m("claude-opus-4.8")]), s)
    expect(d.telemetryFor("claude-opus-4.8")).toBeNull()
    s.value = snap([{ model: "claude-opus-4.8", requestCount: 9 }])
    expect(d.telemetryFor("claude-opus-4.8")?.last7d?.requestCount).toBe(9)
  })
})
```

- [ ] **Step 2: 跑确认失败** — `bun run test:ui:bun 2>&1 | grep use-model-detail` → FAIL。

- [ ] **Step 3: 写 `useModelDetail.ts`**

```ts
import type { Model } from "~backend/lib/models/client"

import { computed, ref, type ComputedRef, type Ref } from "vue"
import { normalizeModelId } from "~backend/lib/models/resolver"

import { buildModelTelemetryIndex, type JoinedModelTelemetry, type ModelTelemetryIndex } from "./model-telemetry-join"
import type { RequestTelemetrySnapshot } from "./telemetry-parse"

export interface UseModelDetailReturn {
  selectedId: Ref<string | null>
  isOpen: ComputedRef<boolean>
  telemetryIndex: ComputedRef<ModelTelemetryIndex>
  open: (id: string) => void
  close: () => void
  telemetryFor: (id: string) => JoinedModelTelemetry | null
}

export function useModelDetail(models: Ref<Array<Model>>, snapshot: Ref<RequestTelemetrySnapshot | null>): UseModelDetailReturn {
  const selectedId = ref<string | null>(null)
  const isOpen = computed(() => selectedId.value !== null)
  const telemetryIndex = computed(() => buildModelTelemetryIndex(snapshot.value, models.value))

  function open(id: string): void {
    selectedId.value = id
  }
  function close(): void {
    selectedId.value = null
  }
  function telemetryFor(id: string): JoinedModelTelemetry | null {
    return telemetryIndex.value.byId.get(normalizeModelId(id)) ?? null
  }

  return { selectedId, isOpen, telemetryIndex, open, close, telemetryFor }
}
```

- [ ] **Step 4: 跑测试 + typecheck** — `bun run test:ui:bun 2>&1 | grep -A2 use-model-detail && bun run typecheck:ui 2>&1 | tail -2` → PASS / 0 error。

- [ ] **Step 5: 提交**

```bash
git add -- ui/src/composables/useModelDetail.ts ui/tests/use-model-detail.test.ts
git commit -m "feat(ui): useModelDetail (selection + drawer state + telemetry join)"
```

---

### Task 3: 共享 presentational 原语 `DetailSection` + `DetailKeyValueList`

统一 key-value 行 + section 标题渲染；tab 子组件只喂数据。

**Files:**
- Create: `ui/src/components/models/detail/DetailSection.vue`、`DetailKeyValueList.vue`
- Test: `ui/vitest/detail-primitives.test.ts`

**Interfaces:**
- `DetailSection` props: `defineProps<{ title: string }>()` + 默认 slot（内容）。渲染一个带 uppercase 小标题的区块（样式对齐 `ModelsFilterBar` 的 `.panel-title`/secondary 色）。
- `DetailKeyValueList` props: `defineProps<{ rows: Array<[string, string | null]> }>()`。每行 `label`（secondary 色）+ `value`（缺失/null → `—`，`tabular-nums`）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test } from "vitest"

import { mountWithVuetifyStubs } from "./helpers/mount"
import DetailKeyValueList from "@/components/models/detail/DetailKeyValueList.vue"

describe("DetailKeyValueList", () => {
  test("renders label/value rows and shows — for null", () => {
    const w = mountWithVuetifyStubs(DetailKeyValueList, { props: { rows: [["Vendor", "Anthropic"], ["Family", null]] } })
    expect(w.text()).toContain("Vendor")
    expect(w.text()).toContain("Anthropic")
    expect(w.text()).toContain("Family")
    expect(w.text()).toContain("—")
  })
})
```

- [ ] **Step 2: 跑确认失败** — `bun run test:ui:vitest 2>&1 | grep detail-primitives` → FAIL。

- [ ] **Step 3: 写两个组件**

`DetailKeyValueList.vue`：

```vue
<script setup lang="ts">
defineProps<{ rows: Array<[string, string | null]> }>()
</script>

<template>
  <div class="kv-list">
    <div v-for="[label, value] in rows" :key="label" class="kv-row">
      <span class="kv-label">{{ label }}</span>
      <span class="kv-value font-mono">{{ value ?? "—" }}</span>
    </div>
  </div>
</template>

<style scoped>
.kv-list { display: flex; flex-direction: column; gap: 6px; }
.kv-row { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; }
.kv-label { font-size: 0.74rem; letter-spacing: 0.04em; text-transform: uppercase; color: rgb(var(--v-theme-secondary)); }
.kv-value { font-size: 0.83rem; font-variant-numeric: tabular-nums; text-align: right; word-break: break-word; }
</style>
```

`DetailSection.vue`：

```vue
<script setup lang="ts">
defineProps<{ title: string }>()
</script>

<template>
  <section class="detail-section">
    <div class="section-title">{{ title }}</div>
    <slot />
  </section>
</template>

<style scoped>
.detail-section { display: flex; flex-direction: column; gap: 8px; padding: 12px 0; border-bottom: 1px solid rgb(var(--v-theme-surface-variant)); }
.section-title { font-size: 0.72rem; letter-spacing: 0.06em; text-transform: uppercase; color: rgb(var(--v-theme-secondary)); font-weight: 700; }
</style>
```

- [ ] **Step 4: 跑测试确认通过** — `bun run test:ui:vitest 2>&1 | grep -A2 detail-primitives` → PASS。

- [ ] **Step 5: 提交** — `git add -- ui/src/components/models/detail/DetailSection.vue ui/src/components/models/detail/DetailKeyValueList.vue ui/vitest/detail-primitives.test.ts && git commit -m "feat(ui): DetailSection + DetailKeyValueList primitives"`

---

### Task 4: 6 个 tab 子组件

每个 tab 收 `defineProps<{ model: Model; caps: DerivedCapabilities }>()`（Telemetry 额外 `telemetry: JoinedModelTelemetry | null`）。用 Task 3 原语。

**Files:**
- Create: `ui/src/components/models/detail/tabs/OverviewTab.vue`、`CapabilitiesTab.vue`、`LimitsVisionTab.vue`、`BillingPolicyTab.vue`、`TelemetryTab.vue`、`RawJsonTab.vue`
- Test: `ui/vitest/model-detail-tabs.test.ts`

**字段映射（spec §3；缺失 `?.` → `—` / null）：**
- **OverviewTab** — rows：`["Vendor", model.vendor]`、`["Version", model.version ?? null]`、`["Family", model.capabilities?.family ?? null]`、`["Tokenizer", model.capabilities?.tokenizer ?? null]`、`["Type", model.capabilities?.type ?? null]`、`["Object", model.capabilities?.object ?? null]`、`["Category", model.model_picker_category ?? null]`、`["Picker enabled", String(model.model_picker_enabled)]`、`["Chat default", String(model.is_chat_default)]`、`["Chat fallback", String(model.is_chat_fallback)]`、`["Preview", String(model.preview)]`。**Endpoints 折进本 tab 底部**：`getEffectiveEndpoints(model)` 逐个 chip，推断项（`!model.supported_endpoints`）加 `(inferred)` 后缀。
- **CapabilitiesTab** — 上半：派生矩阵（`caps.vision/toolCalls/parallelToolCalls/structuredOutputs/streaming/thinking` 的 ✓/·，thinking 附 budget/adaptive）。下半 **完整 raw supports map**：`Object.entries(model.capabilities?.supports ?? {})` 逐条 `key → JSON 化 value`（bool/number/array 都显示原值；array `join("/")`）。**这是 richest-data-flow 关键：不裁剪到派生子集**。
- **LimitsVisionTab** — Limits rows：`Context window`/`Max prompt`/`Max output`/`Non-stream output`/`Max inputs`（`fmtNum` 或原值）。**Vision 条件区块**：`v-if="model.capabilities?.limits?.vision"` 才渲染 `Max images`/`Max image size`/`Media types`。
- **BillingPolicyTab** — Billing rows：`["Multiplier", model.billing?.multiplier != null ? String(model.billing.multiplier) : null]`、`["Premium", model.billing?.is_premium != null ? String(model.billing.is_premium) : null]`；`restricted_to` 用 plan chips（`v-for`）。Policy rows：`["State", model.policy?.state ?? null]`、`["Terms", model.policy?.terms ?? null]`。
- **TelemetryTab** — 若 `telemetry?.last7d` 存在：rows `Requests`/`Success`/`Failure`/`Avg duration`（`formatDuration`）+ token 分解**全 6 项**（input/output/total/cacheRead/cacheCreation/reasoning）。另可并列 `sinceStart`。无 telemetry → "No traffic recorded"。加诚实说明句（spec §4.2：failure 计数按上游规范名聚合，纯别名失败见"未关联遥测"）。
- **RawJsonTab** — `<JsonViewerSurface :data="model" :show-toolbar="false" fill-height />`。

- [ ] **Step 1: 写失败测试**（覆盖关键行为：缺失 `—`、Vision 空态、完整 supports、telemetry 无流量）

```ts
import { describe, expect, test } from "vitest"

import { mountWithVuetifyStubs } from "./helpers/mount"
import CapabilitiesTab from "@/components/models/detail/tabs/CapabilitiesTab.vue"
import LimitsVisionTab from "@/components/models/detail/tabs/LimitsVisionTab.vue"
import TelemetryTab from "@/components/models/detail/tabs/TelemetryTab.vue"
import { deriveCapabilities } from "~backend/lib/models/capabilities"

const model = (over = {}) => ({ id: "m", name: "m", vendor: "Anthropic", object: "model", preview: false, model_picker_enabled: true, is_chat_default: false, is_chat_fallback: false, version: "1", capabilities: { type: "chat", supports: { vision: true, custom_flag: 42, reasoning_effort: ["low", "high"] }, limits: {} }, ...over })

describe("detail tabs", () => {
  test("CapabilitiesTab shows the FULL raw supports map, not just derived", () => {
    const m = model()
    const w = mountWithVuetifyStubs(CapabilitiesTab, { props: { model: m, caps: deriveCapabilities(m as never) } })
    expect(w.text()).toContain("custom_flag")   // raw non-derived key surfaced
    expect(w.text()).toContain("42")
    expect(w.text()).toContain("reasoning_effort")
  })

  test("LimitsVisionTab hides Vision block when no vision limits", () => {
    const m = model({ capabilities: { limits: {} } })
    const w = mountWithVuetifyStubs(LimitsVisionTab, { props: { model: m, caps: deriveCapabilities(m as never) } })
    expect(w.text()).not.toContain("Max images")
  })

  test("LimitsVisionTab shows Vision block when vision limits present", () => {
    const m = model({ capabilities: { limits: { vision: { max_prompt_images: 5, max_prompt_image_size: 1000 } } } })
    const w = mountWithVuetifyStubs(LimitsVisionTab, { props: { model: m, caps: deriveCapabilities(m as never) } })
    expect(w.text()).toContain("Max images")
    expect(w.text()).toContain("5")
  })

  test("TelemetryTab shows no-traffic message when telemetry null", () => {
    const m = model()
    const w = mountWithVuetifyStubs(TelemetryTab, { props: { model: m, caps: deriveCapabilities(m as never), telemetry: null } })
    expect(w.text()).toMatch(/no traffic/i)
  })
})
```

- [ ] **Step 2: 跑确认失败** — `bun run test:ui:vitest 2>&1 | grep model-detail-tabs` → FAIL。

- [ ] **Step 3: 写 6 个 tab 组件**（按上面字段映射；用 `DetailSection`/`DetailKeyValueList`/`getEffectiveEndpoints`/`fmtNum`/`formatDuration`/`JsonViewerSurface`）。**代表实现** `CapabilitiesTab.vue` 的 raw supports 部分：

```vue
<script setup lang="ts">
import type { DerivedCapabilities } from "~backend/lib/models/capabilities"
import type { Model } from "~backend/lib/models/client"
import { computed } from "vue"
import DetailSection from "../DetailSection.vue"

const props = defineProps<{ model: Model; caps: DerivedCapabilities }>()

const derivedRows = computed<Array<[string, boolean]>>(() => [
  ["Vision", props.caps.vision], ["Tool calls", props.caps.toolCalls], ["Parallel tools", props.caps.parallelToolCalls],
  ["Structured outputs", props.caps.structuredOutputs], ["Streaming", props.caps.streaming], ["Thinking", props.caps.thinking],
])
const supportsRows = computed<Array<[string, string]>>(() =>
  Object.entries(props.model.capabilities?.supports ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.join("/") : String(v)]),
)
</script>

<template>
  <div>
    <DetailSection title="Capabilities">
      <div v-for="[label, on] in derivedRows" :key="label" class="cap-row">
        <span class="cap-mark" :class="on ? 'yes' : 'no'">{{ on ? "✓" : "·" }}</span>{{ label }}
      </div>
    </DetailSection>
    <DetailSection title="Supports (raw)">
      <div v-for="[k, v] in supportsRows" :key="k" class="kv-row"><span class="kv-label">{{ k }}</span><span class="font-mono">{{ v }}</span></div>
    </DetailSection>
  </div>
</template>
```

其余 tab 类似结构（用 `DetailKeyValueList` + `DetailSection`）。

- [ ] **Step 4: 跑测试** — `bun run test:ui:vitest 2>&1 | grep -A3 model-detail-tabs` → PASS。
- [ ] **Step 5: typecheck** — `bun run typecheck:ui 2>&1 | tail -2` → 0 error。
- [ ] **Step 6: 提交** — `git add -- ui/src/components/models/detail/tabs/ ui/vitest/model-detail-tabs.test.ts && git commit -m "feat(ui): 6 model-detail tabs (full fields + raw supports + telemetry)"`

---

### Task 5: `ModelDetailDrawer` 外壳 + vitest stub

`v-navigation-drawer`（`location="right"` `temporary`）+ `v-tabs`/`v-window` 组织 6 tab。

**Files:**
- Create: `ui/src/components/models/ModelDetailDrawer.vue`
- Modify: `ui/vitest/helpers/mount.ts`（`vuetifyComponentStubs` 补 `VNavigationDrawer`/`VTabs`/`VTab`/`VWindow`/`VWindowItem`/`VTable`）
- Test: `ui/vitest/model-detail-drawer.test.ts`

**Interfaces:**
- props: `defineProps<{ modelValue: boolean; model: Model | null; caps: DerivedCapabilities | null; telemetry: JoinedModelTelemetry | null }>()`
- emits: `defineEmits<{ "update:modelValue": [boolean] }>()`；本地 `computed` 桥接 `modelValue`（v-model 约定）。
- `model` 为 null 时不渲染 tab 内容（抽屉关时无选中）。

- [ ] **Step 1: 补 stub**（`mount.ts` 的 `vuetifyComponentStubs`）——参照现有 `VSelectStub` 写法，加透传 slot 的简单 stub：

```ts
const passthrough = (name: string) => defineComponent({ name, setup: (_, { slots }) => () => h("div", { class: name }, slots.default?.()) })
// 加入 vuetifyComponentStubs:
VNavigationDrawer: passthrough("VNavigationDrawer"),
VTabs: passthrough("VTabs"),
VTab: passthrough("VTab"),
VWindow: passthrough("VWindow"),
VWindowItem: passthrough("VWindowItem"),
VTable: passthrough("VTable"),
```

（`defineComponent`/`h` 从 vue import；若 mount.ts 已有等价 helper 则复用。）

- [ ] **Step 2: 写失败测试**

```ts
import { describe, expect, test } from "vitest"

import { mountWithVuetifyStubs } from "./helpers/mount"
import ModelDetailDrawer from "@/components/models/ModelDetailDrawer.vue"
import { deriveCapabilities } from "~backend/lib/models/capabilities"

const model = { id: "claude-opus-4.8", name: "Opus", vendor: "Anthropic", object: "model", preview: false, model_picker_enabled: true, is_chat_default: false, is_chat_fallback: false, version: "1", capabilities: { type: "chat", supports: {}, limits: {} } }

describe("ModelDetailDrawer", () => {
  test("renders selected model id + tab labels when open", () => {
    const w = mountWithVuetifyStubs(ModelDetailDrawer, { props: { modelValue: true, model, caps: deriveCapabilities(model as never), telemetry: null } })
    expect(w.text()).toContain("claude-opus-4.8")
    expect(w.text()).toContain("Overview")
    expect(w.text()).toContain("Capabilities")
    expect(w.text()).toContain("Telemetry")
  })

  test("renders nothing meaningful when model is null", () => {
    const w = mountWithVuetifyStubs(ModelDetailDrawer, { props: { modelValue: false, model: null, caps: null, telemetry: null } })
    expect(w.text()).not.toContain("Overview")
  })
})
```

- [ ] **Step 3: 跑确认失败** — `bun run test:ui:vitest 2>&1 | grep model-detail-drawer` → FAIL。

- [ ] **Step 4: 写 `ModelDetailDrawer.vue`**（v-model 桥接 + 头部 model.id + v-tabs/v-window 装 6 tab；`v-if="model"` 守卫）：

```vue
<script setup lang="ts">
import type { DerivedCapabilities } from "~backend/lib/models/capabilities"
import type { Model } from "~backend/lib/models/client"
import type { JoinedModelTelemetry } from "@/composables/model-telemetry-join"
import { computed, ref } from "vue"
import OverviewTab from "./detail/tabs/OverviewTab.vue"
import CapabilitiesTab from "./detail/tabs/CapabilitiesTab.vue"
import LimitsVisionTab from "./detail/tabs/LimitsVisionTab.vue"
import BillingPolicyTab from "./detail/tabs/BillingPolicyTab.vue"
import TelemetryTab from "./detail/tabs/TelemetryTab.vue"
import RawJsonTab from "./detail/tabs/RawJsonTab.vue"

const props = defineProps<{ modelValue: boolean; model: Model | null; caps: DerivedCapabilities | null; telemetry: JoinedModelTelemetry | null }>()
const emit = defineEmits<{ "update:modelValue": [boolean] }>()
const open = computed({ get: () => props.modelValue, set: (v) => emit("update:modelValue", v) })
const tab = ref("overview")
</script>

<template>
  <v-navigation-drawer v-model="open" location="right" temporary width="440" class="model-detail-drawer">
    <template v-if="model && caps">
      <div class="drawer-head">
        <div class="drawer-title font-mono">{{ model.id }}</div>
        <v-btn icon variant="text" aria-label="Close" @click="open = false"><v-icon icon="mdi-close" /></v-btn>
      </div>
      <v-tabs v-model="tab" density="compact">
        <v-tab value="overview">Overview</v-tab>
        <v-tab value="capabilities">Capabilities</v-tab>
        <v-tab value="limits">Limits</v-tab>
        <v-tab value="billing">Billing</v-tab>
        <v-tab value="telemetry">Telemetry</v-tab>
        <v-tab value="raw">Raw JSON</v-tab>
      </v-tabs>
      <v-window v-model="tab" class="drawer-body">
        <v-window-item value="overview"><OverviewTab :model="model" :caps="caps" /></v-window-item>
        <v-window-item value="capabilities"><CapabilitiesTab :model="model" :caps="caps" /></v-window-item>
        <v-window-item value="limits"><LimitsVisionTab :model="model" :caps="caps" /></v-window-item>
        <v-window-item value="billing"><BillingPolicyTab :model="model" :caps="caps" /></v-window-item>
        <v-window-item value="telemetry"><TelemetryTab :model="model" :caps="caps" :telemetry="telemetry" /></v-window-item>
        <v-window-item value="raw"><RawJsonTab :model="model" /></v-window-item>
      </v-window>
    </template>
  </v-navigation-drawer>
</template>
```

- [ ] **Step 5: 跑测试 + typecheck** → PASS / 0 error。
- [ ] **Step 6: 提交** — `git add -- ui/src/components/models/ModelDetailDrawer.vue ui/vitest/helpers/mount.ts ui/vitest/model-detail-drawer.test.ts && git commit -m "feat(ui): ModelDetailDrawer shell + vitest stubs for drawer/tabs/table"`

---

### Task 6: 接线 VModelsPage + ModelsTable 行点击开抽屉（替换行内展开）

**Files:**
- Modify: `ui/src/pages/vuetify/VModelsPage.vue`（`onMounted` fetchStatus → snapshot ref；`useModelDetail(models, snapshot)`；渲染 `ModelDetailDrawer`；给 `ModelsTable` 传 `@select`）
- Modify: `ui/src/components/models/ModelsTable.vue`（**删** `expanded`/行内展开 `JsonViewerSurface`；行点击 `emit("select", m.id)`；行高亮 selected）
- Test: `ui/vitest/models-table.test.ts`（改：断言点击行 emit `select`，不再断言行内展开）

- [ ] **Step 1: 改 `ModelsTable` 测试**（先改测试反映新契约）——把"点击行展开 JSON"改为"点击行 emit `select` 携带 model.id"：

```ts
test("clicking a row emits select with model id", async () => {
  const w = mountWithVuetifyStubs(ModelsTable, { props: { models: [/* one model */], caps, vendorColor, fmtNum } })
  await w.find("tbody tr.model-row").trigger("click")
  expect(w.emitted("select")?.[0]).toEqual(["<that model id>"])
})
```

- [ ] **Step 2: 跑确认失败** — `bun run test:ui:vitest 2>&1 | grep models-table` → FAIL。

- [ ] **Step 3: 改 `ModelsTable.vue`**——删 `expanded`/`toggleExpand`/展开 `<tr v-if>` 块与 `model-expand-row` 样式；`defineEmits<{ select: [string] }>()`；行 `@click="$emit('select', m.id)"`；加 `:class="{ selected: m.id === selectedId }"` + 新 prop `selectedId?: string | null`。移除 `import JsonViewerSurface`（若仅此处用）。

- [ ] **Step 4: 改 `VModelsPage.vue`**——`onMounted` 里（或复用 catalog 的挂载）`api.fetchStatus()` → `parseRequestTelemetry` → `snapshot` ref；`const detail = useModelDetail(models, snapshot)`；`<ModelsTable ... :selected-id="detail.selectedId.value" @select="detail.open" />`；页尾加 `<ModelDetailDrawer v-model="drawerOpen" :model="selectedModel" :caps="selectedCaps" :telemetry="selectedTelemetry" />`，其中 `drawerOpen` 桥接 `detail.isOpen`/`detail.close`（`computed({ get: () => detail.isOpen.value, set: (v) => { if (!v) detail.close() } })`），`selectedModel = computed(() => models.value.find((m) => m.id === detail.selectedId.value) ?? null)`，`selectedCaps = computed(() => selectedModel.value ? caps(selectedModel.value) : null)`，`selectedTelemetry = computed(() => detail.selectedId.value ? detail.telemetryFor(detail.selectedId.value) : null)`。

- [ ] **Step 5: 跑全部 UI 测试 + typecheck**

Run: `bun run test:ui:vitest 2>&1 | tail -5 && bun run typecheck:ui 2>&1 | tail -2`
Expected: models-table 新契约 PASS，drawer/tabs PASS，0 type error。

- [ ] **Step 6: 提交** — `git add -- ui/src/pages/vuetify/VModelsPage.vue ui/src/components/models/ModelsTable.vue ui/vitest/models-table.test.ts && git commit -m "feat(ui): row click opens detail drawer (replaces in-row JSON expand)"`

---

## Phase 2 收尾

- `bun run typecheck:ui` + `bun run typecheck`（后端）+ `bun run test:ui:vitest` + `bun run test:ui:bun` + 后端 `bun run test:backend`（models 子集）全绿。
- 派 subagent audit（裁判轴：全字段是否真无遗漏〔对照 spec §3〕、Capabilities 是否展示**完整 raw supports**、Vision 条件区块、抽屉是否真替换行内展开〔无双重交互〕、选中态是否存 id 非对象、后端 request_headers 是否真透传；**非** ROI/最小化）。
- 交付给 Phase 3：抽屉可用，`useModelDetail` 提供 `telemetryIndex.unmatched` 供 Phase 3 的"未关联遥测"小节。
