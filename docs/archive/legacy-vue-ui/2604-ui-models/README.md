# Models UI 文案与标签改进

## 前置条件

本文档基于 `docs/2603-api-models/` 的透传修复已完成的前提。透传修复解决了数据忠实度问题（字段重命名、臆造、丢失），本文档聚焦于 UI 层的**文案准确性**：标签、tooltip、placeholder 等用户可见文字是否忠实反映上游数据的含义。

## 问题概述

Models 页面在展示上游字段时，使用了过度缩写或不精确的标签，导致用户无法理解数据的实际含义。例如 `"Context"` 无法表达 `max_context_window_tokens` 的"上下文窗口最大 token 数"语义。

---

## 修改清单

### 一、Token Limits 标签

这些标签出现在 ModelCard 的进度条区域（`getPrimaryLimits`）和 Metadata 区域（`getLimits`），以及 legacy ModelsPage 的卡片中。

#### Vuetify 链路：`useModelsCatalog.ts`

| 函数 | 行 | 上游字段 | 当前标签 | 建议改为 | 理由 |
|------|---|---------|---------|---------|------|
| `getPrimaryLimits` | 134 | `max_context_window_tokens` | `"Context"` | `"Context Window"` | "Context" 含义模糊，加 "Window" 对应上游语义 |
| `getPrimaryLimits` | 140 | `max_prompt_tokens` | `"Prompt"` | `"Max Prompt"` | 单独 "Prompt" 不表达"上限" |
| `getPrimaryLimits` | 146 | `max_output_tokens` | `"Output"` | `"Max Output"` | 同上 |
| `getLimits` | 157 | `max_context_window_tokens` | `"Context"` | `"Context Window"` | 与 primaryLimits 一致 |
| `getLimits` | 158 | `max_prompt_tokens` | `"Prompt"` | `"Max Prompt"` | 一致 |
| `getLimits` | 159 | `max_output_tokens` | `"Output"` | `"Max Output"` | 一致 |
| `getLimits` | 160 | `max_non_streaming_output_tokens` | `"Non-stream"` | `"Non-stream Output"` | 缺少 "Output"，用户不知这是输出限制 |

#### Legacy 链路：`ModelsPage.vue`

| 行 | 上游字段 | 当前标签 | 建议改为 |
|---|---------|---------|---------|
| 127 | `max_context_window_tokens` | `"Context"` | `"Context Window"` |
| 128 | `max_prompt_tokens` | `"Prompt"` | `"Max Prompt"` |
| 129 | `max_output_tokens` | `"Output"` | `"Max Output"` |
| 131 | `max_non_streaming_output_tokens` | `"Non-stream"` | `"Non-stream Output"` |

### 二、ModelCard header chips — Family 和 Category 移入 Metadata

当前 `headerChipEntries` 包含 6 个可选 chip：Vendor、Type、Family、Picker、Tier、Stage。

**Family** 和 **Picker**（即 `model_picker_category`）的信息密度低，不值得在卡片头部占据独立 chip 位置。它们是静态的分类元数据，更适合放在 Metadata 区域以 key-value 形式展示。

**从 headerChipEntries 中移除**：

| 行 | 上游字段 | 当前 | 操作 |
|---|---------|------|------|
| 62-68 | `capabilities.family` | chip label `"Family"` | 移除，移入 metadataEntries |
| 70-76 | `model_picker_category` | chip label `"Picker"` | 移除，移入 metadataEntries |

**添加到 metadataEntries**：

```typescript
const metadataEntries = computed(() =>
  [
    props.model.capabilities?.family ? ["Family", String(props.model.capabilities.family)] : null,
    props.model.model_picker_category ? ["Category", String(props.model.model_picker_category)] : null,
    thinkingBudget.value ? ["Thinking Budget", thinkingBudget.value] : null,
    nonStreamLimit.value ? ["Non-stream Output", nonStreamLimit.value] : null,
    props.model.capabilities?.tokenizer ? ["Tokenizer", String(props.model.capabilities.tokenizer)] : null,
  ].filter((entry): entry is [string, string] => entry !== null),
)
```

变更要点：
- `"Picker"` 标签改为 `"Category"`（"Picker" 是 GitHub 内部 UI 术语，对用户无意义）
- Family 保持原标签 `"Family"`
- 两者从 chip 降级为 metadata key-value 行，信息层级更合理
- header chips 精简为 4 个：Vendor、Type、Tier(Premium)、Stage(Preview)——都是需要视觉突出的状态标识

**保留的 header chips**（标签准确，无需修改）：
- `"Vendor"` — 对应 `vendor`
- `"Type"` — 对应 `capabilities.type`
- `"Tier"` + `"Premium"` — 对应 `billing.is_premium`
- `"Stage"` + `"Preview"` — 对应 `preview`

### 三、ModelCard Metadata 区域 — 其他标签修正

除了上方新增的 Family 和 Category 条目外，现有 metadata 条目的标签也需要修正：

| 行 | 上游字段 | 当前标签 | 建议改为 | 理由 |
|---|---------|---------|---------|------|
| 101 | `min_thinking_budget` ~ `max_thinking_budget` | `"Thinking"` | `"Thinking Budget"` | "Thinking" 太笼统，加 "Budget" 明确是预算范围 |
| 102 | `max_non_streaming_output_tokens` | `"Non-stream"` | `"Non-stream Output"` | 与 getLimits 一致（此处引用 getLimits 的值） |

`"Tokenizer"` 对应 `capabilities.tokenizer`，准确，无需改。

### 四、ModelCard Vision tooltip

| 行 | 上游字段 | 当前标签 | 建议 |
|---|---------|---------|------|
| `getVision` 174 | `max_prompt_images` | `"Max images"` | 保持不变，可读 |
| `getVision` 175 | `max_prompt_image_size` | `"Max size"` | 保持不变，可读 |

### 五、Billing tooltip

| 行 | 当前文案 | 建议改为 | 理由 |
|---|---------|---------|------|
| ModelCard 155 | `"Billing multiplier"` | `"Billing multiplier (×base rate)"` | 加上基准参照，用户不知道乘数相对什么 |

### 六、JSON Dialog 重构 — 精简为纯 JSON 查看器

当前模态框结构冗余，分为三层：

```
v-dialog
  v-card.json-dialog
    div.dialog-header          ← model ID 标题 + 关闭按钮
      div.dialog-title-wrap    ← model ID + displayName
      v-btn close
    div.dialog-chip-row        ← 重复卡片头部的 header chips
      v-chip × N
    div.dialog-body            ← 包裹 JsonViewerSurface
      JsonViewerSurface
        #header slot           ← "JSON Inspect" eyebrow + "Unfiltered model payload" 标题
        VueJsonPretty          ← 实际 JSON 内容
```

问题：
- **dialog-header 与 JsonViewerSurface 的 #header slot 功能重叠**：两处都显示标题信息
- **dialog-chip-row 完全重复卡片头部的 chips**：用户已经在卡片上看到了，弹窗里再看一遍没有价值
- **JsonViewerSurface 的 #header slot 嵌套了 eyebrow + title**：当整个弹窗只剩 JSON 时，eyebrow（"JSON Inspect"）没有意义

**重构后结构**：

```
v-dialog
  v-card.json-dialog
    div.dialog-header          ← model ID + 关闭按钮（保留，作为弹窗标题栏）
    JsonViewerSurface          ← 无 #header slot，直接展示 JSON
      VueJsonPretty
```

**具体变更**（`ModelCard.vue`）：

1. **保留 dialog-header**——只包含 model ID（`jsonTitle`）和关闭按钮。删除 `displayName` subtitle（JSON 查看器不需要人类可读名）：

```html
<div class="dialog-header">
  <div class="dialog-title font-mono">{{ jsonTitle }}</div>
  <v-btn
    icon
    variant="text"
    aria-label="Close"
    @click="isJsonOpen = false"
  >
    <v-icon icon="mdi-close" />
  </v-btn>
</div>
```

2. **删除 dialog-chip-row**——整个 `<div v-if="headerChipEntries.length > 0" class="dialog-chip-row">` 块移除。

3. **JsonViewerSurface 去掉 #header slot**——不再传入 eyebrow/title，直接渲染 JSON。`copy-message` 保留：

```html
<JsonViewerSurface
  :data="model"
  copy-message="Model JSON copied"
  fill-height
  class="dialog-json-panel"
/>
```

4. **dialog-body 层可以去掉**——JsonViewerSurface 直接作为 v-card 的子元素，用 flex: 1 填充剩余空间。或者保留 dialog-body 仅作 padding 容器。

5. **删除无用 CSS**：`.dialog-title-wrap`、`.dialog-subtitle`、`.dialog-chip-row`、`.dialog-json-header`、`.dialog-json-eyebrow`、`.dialog-json-title`。

6. **删除无用计算属性**：`jsonTitle` 可以简化（当前 `String(props.model.id ?? "Model JSON")`，`model.id` 始终存在，fallback 无意义，但保留计算属性本身无害）。`displayName` 在卡片头部仍然使用，不能删除。

**重构后 `isJsonOpen` 相关代码占比**：从 ~60 行模板 + ~70 行 CSS 精简到 ~15 行模板 + ~20 行 CSS。

### 七、Legacy ModelsPage 特有文案

| 行 | 当前文案 | 建议改为 | 理由 |
|---|---------|---------|------|
| 312 | `"Billing"` (limit-label) | `"Billing Multiplier"` | 单独 "Billing" 不表达具体含义，值是 `Nx` 格式 |
| 329 | `"Thinking budget"` (row-label) | 保持不变 | legacy 页已是准确的 "Thinking budget"，无需改 |

---

### 八、Legacy 模型的端点推断

上游有 23/41 个模型没有 `supported_endpoints` 字段（如 `gpt-4o-2024-11-20`、`gemini-2.5-pro`、`text-embedding-3-small` 等）。当前 UI 对这些模型的 Endpoints 区域什么都不显示。

后端 `endpoint.ts` 已有推断逻辑（`getEffectiveEndpoints`）：

```typescript
const LEGACY_ENDPOINTS: Record<string, Array<string>> = {
  chat: ["/chat/completions"],
  completion: ["/chat/completions"],
  embeddings: ["/v1/embeddings"],
}
```

但这个推断**不应在 route 层注入到模型数据中**——route 层的职责是忠实透传上游数据，给上游没有的字段填值等于臆造。端点推断属于**展示层的解读**，应在前端完成。

#### Vuetify 链路

**`useModelsCatalog.ts`** — 新增 `getEffectiveEndpoints` 辅助函数：

```typescript
/** Legacy models without supported_endpoints: infer from capabilities.type */
const LEGACY_ENDPOINTS: Record<string, Array<string>> = {
  chat: ["/chat/completions"],
  completion: ["/chat/completions"],
  embeddings: ["/v1/embeddings"],
}

function getEffectiveEndpoints(model: ModelData): Array<string> {
  const explicit = model.supported_endpoints as Array<string> | undefined
  if (explicit) return explicit
  const type = model.capabilities?.type as string | undefined
  if (type && type in LEGACY_ENDPOINTS) return LEGACY_ENDPOINTS[type]
  return []
}
```

该函数用于 3 处：

| 当前代码 | 位置 | 改动 |
|---------|------|------|
| `(model.supported_endpoints as Array<string> \| undefined) ?? []` | endpointOptions 行 41 | 改为 `getEffectiveEndpoints(model)` |
| `((m.supported_endpoints as Array<string> \| undefined) ?? []).includes(...)` | filteredModels 行 64 | 改为 `getEffectiveEndpoints(m).includes(...)` |

**`ModelCard.vue`** — endpointEntries 计算属性：

```typescript
// 当前：
const endpointEntries = computed(() =>
  (props.model.supported_endpoints as Array<string> | undefined) ?? []
)
```

这里有两个选择：
- **方案 A**：ModelCard 接收一个新 prop `getEffectiveEndpoints`（与其他 getter props 一致）
- **方案 B**：在 ModelCard 内联实现推断逻辑（3 行代码，不值得增加 prop）

建议方案 B——推断逻辑极简，不需要增加 composable 和 props 的耦合：

```typescript
const endpointEntries = computed(() => {
  const explicit = props.model.supported_endpoints as Array<string> | undefined
  if (explicit) return explicit
  const type = props.model.capabilities?.type as string | undefined
  if (type === "chat" || type === "completion") return ["/chat/completions"]
  if (type === "embeddings") return ["/v1/embeddings"]
  return []
})
```

为区分"上游明确声明"与"前端推断"，可考虑对推断的端点 chip 使用不同的视觉样式（如 `variant="text"` 或添加 `(inferred)` 后缀）。本次不强制要求，但记录此选项。

#### Legacy 链路

**`ModelsPage.vue`** — 同样需要改动：

| 行 | 当前 | 改动 |
|---|------|------|
| 62 | `(m.supported_endpoints as ...) ?? []` | 使用相同的推断逻辑 |
| 81 | `((m.supported_endpoints as ...) ?? []).includes(...)` | 同上 |
| 368 | `v-if="(model.supported_endpoints as ...).length"` | 改为推断结果的判断 |
| 372 | `v-for="ep in model.supported_endpoints as ..."` | 改为推断结果 |

Legacy 页面没有 composable，直接在 `<script setup>` 中定义内联函数即可。

## 不改动的部分

| 文案 | 原因 |
|------|------|
| `ModelsToolbar`: `"Models"`, `"Catalog"`, `"Raw JSON"` | 页面级标题和视图切换，语义清晰 |
| `ModelsToolbar`: 统计行 `"visible / total · vendors · endpoints"` | 描述准确 |
| `ModelsFilterBar`: `"Filters"`, `"Vendor"`, `"Endpoint"`, `"Capability"` | 筛选器标签准确 |
| `ModelsFilterBar`: placeholder `"All vendors"`, `"All endpoints"`, `"All features"` | 清晰 |
| Capability chips: `replaceAll("_", " ")` 直译 | 忠实于上游 key 名，可读性可接受 |
| Section titles: `"Capabilities"`, `"Endpoints"`, `"Metadata"` | 准确 |

---

## 未纳入本次的增强

以下是审查中发现的功能增强机会，不属于"文案修正"范畴，记录备忘：

### `reasoning_effort` 未展示

`capabilities.supports.reasoning_effort` 是 `["low", "medium", "high"]` 数组。当前 `getCapabilities` 用 `filter(([, v]) => v === true)` 只提取 boolean 值，数组类型被丢弃。可考虑在 capabilities 区域显示为 chip，值为 `"low / medium / high"`。

### `max_thinking_budget` / `min_thinking_budget` 未展示为 capability chip

这两个字段是数值型 supports 字段（非 boolean），同样被 `getCapabilities` 的 boolean filter 丢弃。当前只在 metadata 区域通过 `getThinkingBudget` 展示。可以考虑在 capabilities 区域也展示一个 "thinking" chip。

### `is_chat_default` / `is_chat_fallback` 可展示

透传修复后前端可获得这两个字段。可在 header chips 中显示 "Default" / "Fallback" 标签。

### `policy` 可展示

透传修复后可获得 `policy.state` 和 `policy.terms`。可在 ModelCard 中显示启用状态和条款链接。

### `billing.restricted_to` 可展示

上游返回适用的 plan 列表（如 `["pro", "pro_plus", "business", "enterprise"]`）。可在 ModelCard 中显示为 plan chips 或 tooltip。

---

## 实施影响

### 需要修改的文件

| 文件 | 修改数 | 内容 |
|------|-------|------|
| `ui/history-v3/src/composables/useModelsCatalog.ts` | 10 处 | getPrimaryLimits 3 label + getLimits 4 label + 新增 getEffectiveEndpoints 函数 + endpointOptions/filteredModels 2 处调用替换 |
| `ui/history-v3/src/components/models/ModelCard.vue` | 重构 | headerChipEntries 移除 Family+Picker, metadataEntries 新增 Family+Category + label 修正, endpointEntries 加端点推断, JSON dialog 精简 |
| `ui/history-v3/src/pages/ModelsPage.vue` | 9 处 | getLimits 4 label + Billing label + 端点推断 4 处 |

### 不需要修改的文件

| 文件 | 原因 |
|------|------|
| `ModelsGrid.vue` | 只传递 props |
| `ModelsFilterBar.vue` | 所有文案准确 |
| `ModelsToolbar.vue` | 所有文案准确 |
| `ModelsRawView.vue` | 无文案 |
| `VModelsPage.vue` | 只做编排 |
| 所有后端文件 | 不涉及 UI 文案 |
| 所有测试文件 | 文案修改不影响功能逻辑 |

### nonStreamLimit 引用联动

`ModelCard.vue:33` 通过 label 字符串查找 Non-stream 条目：

```typescript
const nonStreamLimit = computed(() =>
  limitEntries.value.find(([label]) => label === "Non-stream")?.[1] ?? null
)
```

当 `getLimits` 的 label 从 `"Non-stream"` 改为 `"Non-stream Output"` 后，此处查找条件必须同步更新为 `"Non-stream Output"`。

### 验证

1. `npm run typecheck:ui` 通过
2. Vuetify Models 页面各卡片标签显示正确
3. Legacy Models 页面各卡片标签显示正确
4. ModelCard JSON 按钮点击后弹窗只显示标题栏 + JSON 内容（无 chips、无 eyebrow）
5. JSON 弹窗 Copy JSON 按钮仍可用
6. Billing tooltip 文案更新
7. 无 `supported_endpoints` 的 legacy 模型（如 `gpt-4o-2024-11-20`）显示推断的端点（`/chat/completions`）
8. embeddings 模型（如 `text-embedding-3-small`）显示推断的端点（`/v1/embeddings`）
9. 端点过滤器能正确筛选到 legacy 模型
