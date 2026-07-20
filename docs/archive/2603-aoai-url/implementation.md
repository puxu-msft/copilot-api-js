# Azure OpenAI URL 兼容 — 实现方案

## 需要支持的 URL 格式

### 经典格式（高优先级）

| Azure URL | 映射目标 | 模型来源 |
|-----------|----------|----------|
| `POST /openai/deployments/{model}/chat/completions?api-version=...` | chatCompletionRoutes | URL 路径 `{model}` |
| `POST /openai/deployments/{model}/embeddings?api-version=...` | embeddingsRoutes | URL 路径 `{model}` |
| `POST /openai/deployments/{model}/responses?api-version=...` | responsesRoutes | URL 路径 `{model}` |
| `POST /openai/deployments/{model}/completions?api-version=...` | ~~chatCompletionRoutes (降级)~~ 未实施（legacy completions 端点使用率极低） | URL 路径 `{model}` |

### v1 格式（中优先级）

| Azure URL | 映射目标 | 模型来源 |
|-----------|----------|----------|
| `POST /openai/v1/chat/completions` | chatCompletionRoutes | request body |
| `POST /openai/v1/embeddings` | embeddingsRoutes | request body |
| `POST /openai/v1/responses` | responsesRoutes | request body |
| `GET /openai/v1/models` | modelsRoutes | N/A |
| `GET /openai/v1/models/:model` | modelsRoutes | URL 路径 |

## 实现方案

### 方案 A：路由层直接注册（推荐）

在 `src/routes/index.ts` 的 `registerHttpRoutes()` 中增加 Azure 格式路由。

#### 经典格式路由

核心挑战：**模型名在 URL 路径中，需要注入到 request body**。

```typescript
// src/routes/azure-openai/route.ts

import { Hono } from "hono"

/**
 * Azure OpenAI 经典格式兼容路由。
 * 从 URL 路径提取 deployment-id（即模型名），注入到 request body 的 model 字段。
 */
export const azureDeploymentRoutes = new Hono()

/**
 * 中间件：从 :deployment 路径参数提取模型名，注入到请求 body。
 * Azure 客户端通常不在 body 中发送 model 字段（或发送的是 deployment name）。
 */
async function injectModelFromPath(c: Context, next: Next) {
  const deployment = c.req.param("deployment")
  if (!deployment) {
    return c.json({ error: { message: "deployment-id is required", type: "invalid_request_error" } }, 400)
  }

  // 克隆 request，将 deployment 作为 model 注入 body
  const body = await c.req.json()
  if (!body.model) {
    body.model = deployment
  }

  // 将修改后的 body 存到 context 中供 handler 使用
  c.set("parsedBody", body)
  await next()
}
```

#### 注册方式

```typescript
// src/routes/index.ts — registerHttpRoutes() 中增加：

// Azure OpenAI 经典格式（deployment-based）
app.post("/openai/deployments/:deployment/chat/completions", /* handler */)
app.post("/openai/deployments/:deployment/embeddings", /* handler */)

// Azure OpenAI v1 格式（与标准 OpenAI 相同，多一层 /openai 前缀）
app.route("/openai/v1/chat/completions", chatCompletionRoutes)
app.route("/openai/v1/models", modelsRoutes)
app.route("/openai/v1/embeddings", embeddingsRoutes)
app.route("/openai/v1/responses", responsesRoutes)
```

### 方案 B：通用重写中间件

在 Hono 最前端添加一个中间件，将 Azure URL 重写为标准 URL。

```typescript
// 中间件思路
server.use(async (c, next) => {
  const path = c.req.path

  // 经典格式: /openai/deployments/{model}/chat/completions → /chat/completions
  const deploymentMatch = path.match(/^\/openai\/deployments\/([^/]+)\/(.+)$/)
  if (deploymentMatch) {
    const [, deployment, rest] = deploymentMatch
    // 重写路径
    // 注入 model 到 body
    ...
  }

  // v1 格式: /openai/v1/chat/completions → /v1/chat/completions
  if (path.startsWith("/openai/v1/")) {
    // 重写路径去掉 /openai 前缀
    ...
  }

  await next()
})
```

**缺点**：Hono 不原生支持请求路径重写（`c.req.path` 是只读的），需要手动 dispatch。

### 方案对比

| 维度 | 方案 A：直接路由 | 方案 B：重写中间件 |
|------|-----------------|-------------------|
| 实现复杂度 | 低 | 中 |
| 代码侵入性 | 仅 routes/index.ts + 新路由文件 | server.ts 中间件 |
| Hono 适配性 | 完美（Hono 原生路由） | 需 hack（路径重写不原生） |
| 可维护性 | 高（路由注册清晰） | 中（regex 匹配不直观） |
| 性能 | 等同于现有路由 | 每个请求多一次 regex |
| body 注入 | 在新 handler 中显式处理 | 在中间件中修改 |

**推荐方案 A**，理由：
1. Hono 路由系统天然支持 `:deployment` 路径参数提取
2. 不需要 hack 请求重写
3. 新增的路由清晰可见
4. 经典格式需要特殊的 body 注入逻辑，放在独立 handler 中更清晰

## 详细设计

### 文件结构

```
src/routes/
├── azure-openai/
│   └── route.ts          # Azure 经典格式路由（deployment-based）
├── index.ts              # 增加 Azure 路由注册
└── ...
```

### 经典格式核心逻辑

```typescript
// src/routes/azure-openai/route.ts

import { Hono } from "hono"
import type { Context } from "hono"
import { forwardError } from "~/lib/error"
import { handleChatCompletion } from "~/routes/chat-completions/handler"

export const azureDeploymentRoutes = new Hono()

/**
 * Azure deployment-based chat completions.
 * 从 URL 路径提取 deployment name 作为 model。
 *
 * Azure 客户端发送: POST /openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21
 * 我们需要: 将 "gpt-4o" 注入到 request body 的 model 字段
 */
azureDeploymentRoutes.post("/:deployment/chat/completions", async (c) => {
  try {
    const deployment = c.req.param("deployment")

    // 重写请求：确保 body 中有 model 字段
    // 注意：Azure SDK 可能在 body 中发送 model（等于 deployment name），也可能不发送
    const originalBody = await c.req.json()
    if (!originalBody.model) {
      originalBody.model = deployment
    }

    // 将注入 model 后的 body 传递给现有 handler
    // 需要修改 handleChatCompletion 使其可接受预解析的 body，
    // 或者通过 Hono context 传递
    c.set("azureDeployment", deployment)
    c.set("injectedBody", originalBody)

    return await handleChatCompletion(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

azureDeploymentRoutes.post("/:deployment/embeddings", async (c) => {
  try {
    const deployment = c.req.param("deployment")
    const body = await c.req.json()
    if (!body.model) {
      body.model = deployment
    }
    c.set("injectedBody", body)

    // 复用 embeddings handler
    return await handleEmbeddings(c)
  } catch (error) {
    return forwardError(c, error)
  }
})
```

### Handler 适配

现有 handler 通过 `c.req.json()` 获取 body。对于 Azure 路由，body 需要预处理（注入 model）。

两种适配方式：

#### ~~方式 1：Handler 检查 context 变量（最小侵入）~~ → 实际采用：`injectedPayload` context 变量

> **实施说明**：最终采用方式 1 的变体，使用 `injectedPayload`（而非 `injectedBody`）作为 context key，
> 与 Hono 的 typed context 模式保持一致。每个 handler 改动 1 行。

```typescript
// 修改 handleChatCompletion:
export async function handleChatCompletion(c: Context) {
  const originalPayload =
    (c.get("injectedPayload") as ChatCompletionsPayload | undefined)
    ?? (await c.req.json<ChatCompletionsPayload>())
  // ... 其余逻辑不变
}
```

**优点**：现有 handler 改动最小（一行）
~~**缺点**：隐式依赖 context 变量~~
**注**：`c.get("tuiLogId")` 已使用相同模式，团队已熟悉。

#### ~~方式 2：包装函数（显式）~~ — 未采用

```typescript
// Azure 路由中：
azureDeploymentRoutes.post("/:deployment/chat/completions", async (c) => {
  const deployment = c.req.param("deployment")
  const body = await c.req.json()
  body.model = body.model || deployment

  // 创建新的 Request 对象注入修改后的 body
  const newReq = new Request(c.req.url, {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: JSON.stringify(body),
  })

  // 替换 context 中的 request
  // Hono 中可以用 c.req.raw = newReq 但这不是公开 API
  ...
})
```

~~**推荐方式 1**，因为改动最小且模式在其他路由中已有先例（如 `c.get("tuiLogId")`）。~~ ✅ 已采用

### 路由注册

```typescript
// src/routes/index.ts

import { azureDeploymentRoutes } from "./azure-openai/route"

export function registerHttpRoutes(app: Hono) {
  // ... 现有路由 ...

  // Azure OpenAI 经典格式（deployment-based）
  app.route("/openai/deployments", azureDeploymentRoutes)

  // Azure OpenAI v1 格式（标准 OpenAI + /openai 前缀）
  app.route("/openai/v1/chat/completions", chatCompletionRoutes)
  app.route("/openai/v1/models", modelsRoutes)
  app.route("/openai/v1/embeddings", embeddingsRoutes)
  app.route("/openai/v1/responses", responsesRoutes)
}
```

### Query Parameter 处理

Azure 客户端发送 `?api-version=2024-10-21`。我们的策略：

- **忽略 `api-version`**：我们不是真正的 Azure OpenAI，直接忽略这个参数
- Hono 自动忽略未使用的 query parameters，无需特殊处理

### 认证 Header 处理

Azure 客户端可能用 `api-key` header。我们的策略：

- **当前**：copilot-api-js 不验证客户端认证，直接接受所有请求
- **未来**：如果需要客户端认证，可增加中间件同时接受 `Authorization: Bearer` 和 `api-key`

## 测试策略

### 单元测试

1. 经典格式路由匹配 + 模型注入
2. body 中有 model 时不覆盖 vs 无 model 时从路径注入
3. api-version query parameter 被忽略
4. 各端点（chat/completions、embeddings）都能正确路由

### HTTP 集成测试

```typescript
// tests/http/azure-openai-compat.test.ts

describe("Azure OpenAI URL compatibility", () => {
  test("deployment-based chat completions", async () => {
    const res = await fetch(
      `${baseUrl}/openai/deployments/claude-sonnet-4.6/chat/completions?api-version=2024-10-21`,
      {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hi" }],
          // 注意：没有 model 字段
        }),
      }
    )
    // 验证模型被正确从路径注入
  })

  test("v1 chat completions", async () => {
    const res = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        messages: [{ role: "user", content: "Hi" }],
      }),
    })
  })
})
```

## 实现清单

- [x] 创建 `src/routes/azure-openai/route.ts` — 经典格式路由 + model 注入
- [x] 修改 `src/routes/index.ts` — 注册 Azure 路由
- [x] 修改 `handleChatCompletion` — 支持 `injectedPayload` context 变量
- [x] 修改 `handleEmbeddings` — 同上（提取为独立 handler 函数）
- [x] 修改 `handleResponses` — 同上
- [x] 增加 `/openai/v1/*` 路由注册（纯路由映射，无特殊逻辑）
- [x] 测试：`tests/http/azure-openai-compat.test.ts`
- [ ] 文档：更新 DESIGN.md 路由表

## 风险与注意事项

1. **body 双重解析**：Azure 路由先解析 body 注入 model，handler 再次解析。需要通过 context 传递避免双重解析。
2. **Hono body 只能读一次**：`c.req.json()` 只能调用一次。Azure 路由先调用后必须通过 context 传递，handler 不能再调用。
3. **deployment name vs model name**：Azure 的 deployment name 可能与模型名不同（如 `my-gpt4` → `gpt-4o`）。~~我们直接用 deployment name 作为 model name~~  URL 路径中的 deployment-id 始终覆盖 body model（符合 Azure 契约），通过现有的 model override 机制处理别名。
4. **Streaming**：Azure SDK 的 streaming 使用标准 SSE，与我们已有的 streaming 实现兼容。
5. **WebSocket upgrade**：Azure v1 格式的 `/openai/v1/responses` 也需要支持 WebSocket（如果 Responses API WS 路由已注册）。
