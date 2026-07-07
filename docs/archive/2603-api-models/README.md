# /models API 忠实度修复

## 问题概述

`/models` 端点不忠实地透传上游 Copilot API 的模型数据，而是对数据进行了裁剪、重命名和臆造，违反了 CLAUDE.md 原则3（"数据以最丰富的形式流动，使用决策交给末端"）。

## 当前数据流

```
上游 Copilot API (GET /models)
  → client.ts: cacheModels() 存入 state.models（原样保存，无问题）
    → route.ts: formatModel() / formatModelDetail() 转换后暴露（问题所在）
      → 前端 UI useModelsCatalog.ts / legacy ModelsPage.vue 消费变形后的数据
        → Vuetify ModelCard.vue / legacy 模板 渲染
```

`cacheModels()` 阶段是正确的——它原封不动地保存了上游数据。**问题出在 route.ts 的格式化层和前端对变形字段的依赖**。

## 上游数据结构

基于 `refs/AVAILABLE_MODELS.json`（41 个模型，实际抓取于 2026-03-31）观测到的公开字段集：

| 字段 | 出现率 | 类型 | 示例 |
|------|--------|------|------|
| `id` | 41/41 | string | `"claude-opus-4.6"` |
| `name` | 41/41 | string | `"Claude Opus 4.6"` |
| `object` | 41/41 | string | `"model"` |
| `vendor` | 41/41 | string | `"Anthropic"` / `"OpenAI"` / `"Azure OpenAI"` / `"Google"` |
| `version` | 41/41 | string | `"claude-opus-4.6"` |
| `preview` | 41/41 | boolean | `false` |
| `model_picker_enabled` | 41/41 | boolean | `true` |
| `is_chat_default` | 41/41 | boolean | `false` |
| `is_chat_fallback` | 41/41 | boolean | `false` |
| `capabilities` | 41/41 | object | `{ family, limits, supports, tokenizer, type, ... }` |
| `billing` | 41/41 | object | `{ is_premium, multiplier, restricted_to }` |
| `model_picker_category` | 24/41 | string | `"powerful"` / `"versatile"` |
| `supported_endpoints` | 18/41 | string[] | `["/v1/messages", "/chat/completions"]` |
| `policy` | 22/41 | object | `{ state: "enabled", terms: "..." }` |

外层响应结构：`{ object: "list", data: [...] }`

另外，根据当前请求准备代码（`copilot-api.ts:70-75`、`anthropic/request-preparation.ts`、`openai/request-preparation.ts`），`Model` 还允许携带运行时上游附加的 `request_headers` 字段。该字段用于后续上游请求时附加模型特定的 HTTP header，属于内部敏感元数据，不来自上述快照，应在 route 层剥离（详见 [request_headers 的处理](#request_headers-的处理)）。

---

## 问题详解

### 问题 1: 字段丢失

#### 默认模式 (GET /models)

`formatModel()`（`route.ts:13-24`）只输出 7 个字段，丢弃了 7+ 个上游字段：

```typescript
function formatModel(model: Model) {
  return {
    id: model.id,
    object: "model",              // 硬编码（上游也是 "model"，无实质差异）
    type: "model",                // 臆造（上游无此字段）
    created: 0,                   // 臆造（上游无此字段）
    created_at: EPOCH_ISO,        // 臆造（上游无此字段）
    owned_by: model.vendor,       // 重命名（上游是 vendor）
    display_name: model.name,     // 重命名（上游是 name）
    capabilities: model.capabilities,
  }
}
```

**丢失的字段**：`version`, `preview`, `model_picker_enabled`, `billing`, `model_picker_category`, `supported_endpoints`, `is_chat_default`, `is_chat_fallback`, `policy`

#### Detail 模式 (GET /models?detail=true)

`formatModelDetail()`（`route.ts:26-36`）在 formatModel 基础上补充了部分字段，但仍永远不暴露：

- `is_chat_default` — 41/41 模型都有
- `is_chat_fallback` — 41/41 模型都有
- `policy` — 22/41 模型有，含启用状态和用户条款

（`request_headers` 不暴露是正确的——见 [request_headers 的处理](#request_headers-的处理)）

#### 单模型查询 (GET /models/:model)

使用 `formatModelDetail()`，同样丢失以上字段。

### 问题 2: 臆造字段

以下字段在上游数据中**不存在**，是本项目自行添加的：

| 字段 | 值 | 问题 |
|------|---|------|
| `type` | `"model"` | 上游无此字段。与 `object: "model"` 语义重复。 |
| `created` | `0` | 上游无 created 字段。OpenAI 格式中的 epoch 时间戳，值为 0 意味着 1970-01-01，是虚假信息。 |
| `created_at` | `"1970-01-01T00:00:00.000Z"` | 同上，ISO 格式。 |

### 问题 3: 字段重命名

| 上游字段名 | 暴露字段名 | 问题 |
|-----------|----------|------|
| `vendor` | `owned_by` | 消费者无法用上游文档中的字段名访问数据 |
| `name` | `display_name` | 同上 |

消费者需要知道"本项目的翻译规则"才能正确使用数据。

### 问题 4: 响应外层结构差异

| 方面 | 上游 | 本项目 |
|------|------|--------|
| 外层字段 | `{ object, data }` | `{ object, data, has_more }` |
| `has_more` | 不存在 | 硬编码 `false` |

---

## 影响分析

### 后端

| 文件 | 当前状态 | 需要变更 |
|------|---------|---------|
| `src/routes/models/route.ts` | `formatModel()` / `formatModelDetail()` 裁剪+臆造+重命名 | 删除格式化函数，改为透传 |
| `src/lib/models/client.ts` | `Model` 接口已有 `policy`，但缺少 `is_chat_default`, `is_chat_fallback` | 补全这两个字段 |

### 前端 UI — 已识别影响面

前端有两套 Models 页面共用同一个 API 客户端，都会受到字段名变更的影响：

| 页面 | 路由 | 状态 | 数据消费方式 |
|------|------|------|------------|
| **Vuetify VModelsPage** | `/v/models` | 当前活跃 | 通过 `useModelsCatalog` composable |
| **Legacy ModelsPage** | `/models` | `@deprecated`，标注为 maintenance-only | 直接在组件内消费 API |

#### Vuetify 链路（`/v/models`）

##### `ui/history-v3/src/api/http.ts`

```typescript
// 当前：
async fetchModels(detail = false): Promise<{ data: Array<Record<string, unknown>> }> {
  const qs = detail ? "?detail=true" : ""
  return requestRoot<{ data: Array<Record<string, unknown>> }>("/models" + qs)
}
```

变更：
- 删除 `detail` 参数（透传后始终完整）
- 简化为 `async fetchModels(): Promise<{ data: ... }>`

##### `ui/history-v3/src/composables/useModelsCatalog.ts`

4 处字段名替换：

| 行 | 修改前 | 修改后 |
|----|-------|-------|
| 26 | `api.fetchModels(true)` | `api.fetchModels()` |
| 36 | `m.owned_by as string` | `m.vendor as string` |
| 62 | `m.owned_by === vendorFilter.value` | `m.vendor === vendorFilter.value` |
| 76 | `m.display_name as string` | `m.name as string` |

##### `ui/history-v3/src/components/models/ModelCard.vue`

5 处字段名替换：

| 行 | 修改前 | 修改后 |
|----|-------|-------|
| 38 | `props.model.display_name` | `props.model.name` |
| 39 | `String(props.model.display_name)` | `String(props.model.name)` |
| 45 | `props.model.owned_by` | `props.model.vendor` |
| 48 | `String(props.model.owned_by)` | `String(props.model.vendor)` |
| 50 | `props.vendorColor(String(props.model.owned_by))` | `props.vendorColor(String(props.model.vendor))` |

##### `ui/history-v3/src/components/models/ModelsFilterBar.vue`

1 处 placeholder 文案修正：

| 行 | 修改前 | 修改后 |
|----|-------|-------|
| 38 | `placeholder="Search model id or display name"` | `placeholder="Search model id or name"` |

#### Legacy 链路（`/models`）

##### `ui/history-v3/src/pages/ModelsPage.vue`（标注为 `@deprecated`）

该组件**不使用** `useModelsCatalog` composable，而是直接在组件内调用 API 并引用变形字段。需要同步修改：

| 行 | 修改前 | 修改后 |
|----|-------|-------|
| 42 | `api.fetchModels(true)` | `api.fetchModels()` |
| 55 | `m.owned_by as string` | `m.vendor as string` |
| 78 | `m.owned_by === vendorFilter.value` | `m.vendor === vendorFilter.value` |
| 91 | `m.display_name as string` | `m.name as string` |
| 242 | `model.owned_by` (v-if) | `model.vendor` |
| 243 | `vendorColor(model.owned_by as string)` | `vendorColor(model.vendor as string)` |
| 245 | `{{ model.owned_by }}` | `{{ model.vendor }}` |
| 275 | `model.display_name` (v-if) | `model.name` |
| 279-281 | `model.display_name` (v-if + 显示) | `model.name` |

共 9 处。虽然标注为 deprecated，但路由仍活跃（`router.ts:32-35`），不修改会导致页面失效。

#### 不需要变更的前端文件

| 文件 | 原因 |
|------|------|
| `VModelsPage.vue` | 只做组件编排，不直接访问模型字段 |
| `ModelsGrid.vue` | 只传递 props，不直接访问模型字段 |
| `ModelsRawView.vue` | 透传 rawApiResponse，修复后自动显示正确数据 |
| `ModelsToolbar.vue` | 只显示统计数字，不访问模型字段 |

### 新增数据的利用机会

透传后，前端将获得之前不可见的字段。本次修复的核心目标是数据忠实度，不在 ModelCard 中新增 UI 元素。新字段的 UI 利用作为后续任务：

| 新增字段 | 当前状态 | UI 利用方式（后续） |
|---------|---------|------------------|
| `is_chat_default` | 被 route 丢弃 | ModelCard 可显示 "Default" 标签 |
| `is_chat_fallback` | 被 route 丢弃 | ModelCard 可显示 "Fallback" 标签 |
| `policy` | 被 route 丢弃 | ModelCard 可显示启用状态和条款链接 |
| `billing.restricted_to` | 仅 detail 模式可见 | 默认模式也可获取 |

### 测试 — 已识别影响面

#### `tests/component/models-endpoint.test.ts`（需重写）

当前测试复制了 `formatModel` 逻辑并断言臆造字段（第 24-35 行）。重写为验证透传逻辑：
- 输出模型对象应包含上游所有字段（除 `request_headers`）
- 不应包含 `type`, `created`, `created_at`, `owned_by`, `display_name`
- 字段名应与上游一致

#### `tests/http/basic-routes.test.ts`（需更新多处）

**`ModelsListResponseBody` 接口**（第 19-29 行）——删除 `has_more`, `type`, `owned_by`, `display_name`，改为 `vendor`, `name` 等上游字段名。

**`GET /models` 测试**（第 95-110 行）——删除 `has_more` 和 `type` 断言，`owned_by` → `vendor`，`display_name` → `name`。

**`GET /models?detail=true` 测试**（第 112-135 行）——改为验证 `?detail=true` 返回结果与默认模式等价（参数保留兼容，见下方修复方案）。

**`GET /models/:id` 测试**（第 137-160 行）——删除 `type` 断言。

**空 state 回退测试**（第 177-241 行）——mock 中添加 `is_chat_default`/`is_chat_fallback`，断言中删除 `type`。

#### `tests/e2e-ui/api-endpoints.pw.ts`（需更新）

第 86-101 行的 `GET /models?detail=true` E2E 测试。目前只检查 `data` 数组和 `id` 字段存在性，本身不断言变形字段，但应将 URL 改为 `/models`（或保留 `?detail=true` 验证兼容）。

#### `tests/helpers/factories.ts`（需补全）

`mockModel` 工厂添加 `is_chat_default: false` 和 `is_chat_fallback: false` 默认值。

#### `tests/component/supported-endpoints.test.ts`（需补全）

内部局部 `mockModel`（第 14-25 行）也需要补充这两个字段。

---

## 修复方案

### 核心原则

**透传上游原始数据，不做字段重命名或臆造。**

消费者（前端 UI、外部客户端）应该收到与上游完全一致的数据结构，按需提取自己需要的字段。

### 变更清单

#### 1. `src/lib/models/client.ts` — 类型补全

`Model` 接口当前已有 `policy` 和 `request_headers`，但缺少 `is_chat_default` 和 `is_chat_fallback`。补全：

```typescript
export interface Model {
  // ... 现有字段 ...
  is_chat_default: boolean
  is_chat_fallback: boolean
  // policy 和 request_headers 已存在，无需变更
}
```

#### 2. `src/routes/models/route.ts` — 核心修复

删除 `formatModel()`、`formatModelDetail()`、`EPOCH_ISO` 常量。直接透传 `state.models`，仅剥离内部安全字段。

`?detail=true` 查询参数**保留兼容**，作为 no-op——默认模式已返回完整数据，该参数不改变返回结构。这避免了不必要的 breaking change，现有使用 `?detail=true` 的客户端和测试无需紧急迁移。

```typescript
import type { Model } from "~/lib/models/client"

import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { cacheModels } from "~/lib/models/client"
import { state } from "~/lib/state"

export const modelsRoutes = new Hono()

/** Strip internal fields that should not be exposed to external consumers */
function stripInternalFields(model: Model): Omit<Model, "request_headers"> {
  const { request_headers: _, ...rest } = model
  return rest
}

modelsRoutes.get("/", async (c) => {
  try {
    if (!state.models) await cacheModels()

    // ?detail=true is accepted for backwards compatibility but has no effect —
    // the default response already includes all public fields.
    return c.json({
      object: state.models?.object ?? "list",
      data: state.models?.data.map(stripInternalFields) ?? [],
    })
  } catch (error) {
    return forwardError(c, error)
  }
})

modelsRoutes.get("/:model", async (c) => {
  try {
    if (!state.models) await cacheModels()

    const model = state.modelIndex.get(c.req.param("model"))
    if (!model) {
      return c.json({
        error: {
          message: `The model '${c.req.param("model")}' does not exist`,
          type: "invalid_request_error",
          param: "model",
          code: "model_not_found",
        },
      }, 404)
    }

    return c.json(stripInternalFields(model))
  } catch (error) {
    return forwardError(c, error)
  }
})
```

变更总结：
- 删除 `formatModel()`, `formatModelDetail()`, `EPOCH_ISO`
- `?detail=true` 保留兼容，但作为 no-op（注释说明）
- 外层结构直接使用上游的 `object` 字段，不注入 `has_more`
- 仅剥离 `request_headers`（安全边界），不做任何语义变换

#### 3. 前端 UI 适配

##### `ui/history-v3/src/api/http.ts`

```typescript
// 修改前：
async fetchModels(detail = false): Promise<{ data: Array<Record<string, unknown>> }> {
  const qs = detail ? "?detail=true" : ""
  return requestRoot<{ data: Array<Record<string, unknown>> }>("/models" + qs)
}

// 修改后：
async fetchModels(): Promise<{ data: Array<Record<string, unknown>> }> {
  return requestRoot<{ data: Array<Record<string, unknown>> }>("/models")
}
```

##### `ui/history-v3/src/composables/useModelsCatalog.ts`

4 处字段名替换（已列于上方影响分析）。

##### `ui/history-v3/src/components/models/ModelCard.vue`

5 处字段名替换（已列于上方影响分析）。

##### `ui/history-v3/src/components/models/ModelsFilterBar.vue`

1 处 placeholder 文案修正（已列于上方影响分析）。

##### `ui/history-v3/src/pages/ModelsPage.vue`（legacy）

9 处字段名替换（已列于上方影响分析）。

#### 4. 测试更新

##### `tests/helpers/factories.ts` — mockModel 补全

添加 `is_chat_default: false` 和 `is_chat_fallback: false` 默认值。

##### `tests/component/supported-endpoints.test.ts` — 局部 mockModel 补全

同上，第 14-25 行的局部 mockModel 也添加这两个字段。

##### `tests/component/models-endpoint.test.ts` — 重写

删除整个 `formatModel` 区块（第 24-35 行），重写为验证透传契约。

##### `tests/http/basic-routes.test.ts` — 更新断言

- `ModelsListResponseBody` 接口改为上游字段名
- `GET /models` 断言改为上游字段名，验证无臆造字段
- `GET /models?detail=true` 测试改为验证与默认模式返回等价
- `GET /models/:id` 断言删除 `type`
- 空 state 回退测试中 mock 补全字段，断言删除 `type`

##### `tests/e2e-ui/api-endpoints.pw.ts` — 更新

第 86 行的 `GET /models?detail=true` E2E 测试保留（`?detail=true` 仍有效），验证结构不变。

---

## 不变的部分

| 文件 | 原因 |
|------|------|
| `src/lib/models/client.ts` `cacheModels()` / `getModels()` | 已经正确透传上游数据 |
| `src/lib/state.ts` | 存储/索引逻辑不变（`models`, `modelIndex`, `modelIds`） |
| `src/lib/models/resolver.ts` | 模型解析不依赖暴露格式 |
| `src/lib/models/endpoint.ts` | 端点检查不依赖暴露格式 |
| `src/lib/models/refresh-loop.ts` | 后台刷新逻辑不涉及格式化 |
| `src/lib/models/tokenizer.ts` | 不涉及 |
| `ui/history-v3/src/pages/vuetify/VModelsPage.vue` | 只做组件编排，不直接访问模型字段 |
| `ui/history-v3/src/components/models/ModelsGrid.vue` | 只传递 props，不直接访问模型字段 |
| `ui/history-v3/src/components/models/ModelsRawView.vue` | 透传 rawApiResponse，修复后自动显示正确数据 |
| `ui/history-v3/src/components/models/ModelsToolbar.vue` | 只显示统计数字，不访问模型字段 |

---

## request_headers 的处理

`request_headers` 是 `Model` 接口中的可选字段（`client.ts:69`），**不出现在 `refs/AVAILABLE_MODELS.json` 快照中**——它属于运行时上游可能附加的额外字段。该字段用于后续上游请求时附加模型特定的 HTTP header（见 `copilot-api.ts:70-75`），属于内部敏感元数据，不应暴露给外部消费者。

在 route 层透传时，从每个 model 对象中显式解构剥离：

```typescript
function stripInternalFields(model: Model): Omit<Model, "request_headers"> {
  const { request_headers: _, ...rest } = model
  return rest
}
```

这是合理的数据边界——route 层只剥离安全敏感字段，不做语义变换。

---

## 验证清单

修复后验证：

1. `GET /models` 返回的每个 model 对象的字段集 === 上游字段集 − `request_headers`
2. `GET /models?detail=true` 返回 200，结果与默认模式等价
3. 字段名无重命名（`vendor` 不是 `owned_by`，`name` 不是 `display_name`）
4. 无臆造字段（无 `type`, `created`, `created_at`）
5. 外层结构与上游一致（无 `has_more`）
6. `GET /models/:model` 同样透传
7. `request_headers` 不出现在响应中
8. Vuetify Models 页面正常渲染（Vendor 过滤、搜索、ModelCard 显示名）
9. Legacy Models 页面正常渲染（同上）
10. Raw JSON 视图显示原始上游数据（自动修复，无需改代码）
11. `bun test` 全部通过
12. `npm run typecheck` 通过
13. `npm run typecheck:ui` 通过
