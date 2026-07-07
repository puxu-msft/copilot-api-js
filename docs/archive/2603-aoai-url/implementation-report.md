# Azure OpenAI URL 兼容 — 实施报告

## 实施概述

已实现 Azure OpenAI API 的 URL 路径兼容，支持两种格式：

1. **经典部署格式**：`/openai/deployments/{deployment}/chat/completions?api-version=...`
2. **v1 格式**：`/openai/v1/chat/completions`

采用设计文档推荐的**方案 A：路由层直接注册**。

## 变更文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/routes/azure-openai/route.ts` | 新建 | 经典部署格式路由，从 URL 路径提取 model 注入 body |
| `src/routes/index.ts` | 修改 | 注册 Azure 经典 + v1 路由 |
| `src/routes/chat-completions/handler.ts` | 修改 | 支持 `injectedPayload` context 变量（1 行） |
| `src/routes/embeddings/route.ts` | 修改 | 提取 `handleEmbeddings` 函数 + 支持 `injectedPayload` |
| `src/routes/responses/handler.ts` | 修改 | 支持 `injectedPayload` context 变量（1 行） |
| `tests/http/azure-openai-compat.test.ts` | 新建 | 7 个测试用例 |

## 新增路由

### 经典部署格式

| 路由 | Handler |
|------|---------|
| `POST /openai/deployments/:deployment/chat/completions` | → handleChatCompletion |
| `POST /openai/deployments/:deployment/embeddings` | → handleEmbeddings |
| `POST /openai/deployments/:deployment/responses` | → handleResponses |

### v1 格式（纯路由映射）

| 路由 | Handler |
|------|---------|
| `POST /openai/v1/chat/completions` | chatCompletionRoutes |
| `GET /openai/v1/models` | modelsRoutes |
| `GET /openai/v1/models/:model` | modelsRoutes |
| `POST /openai/v1/embeddings` | embeddingsRoutes |
| `POST /openai/v1/responses` | responsesRoutes |

## 核心实现机制

### model 注入

Azure 经典格式将模型名放在 URL 路径（`{deployment}`）中，request body 的 `model` 字段被忽略（URL 路径为权威来源）。

实现方式：`injectedPayload` Hono context 变量模式。

```
Azure route handler:
  1. 解析 body
  2. 始终用 URL 路径 :deployment 覆盖 body.model（Azure 契约）
  3. c.set("injectedPayload", body)
  4. 调用原有 handler

原有 handler:
  const payload = c.get("injectedPayload") ?? await c.req.json()
```

这避免了 `c.req.json()` 双重调用问题（Hono body 只能读一次），同时保持对现有代码的最小侵入。

### api-version 忽略

Azure 客户端发送 `?api-version=2024-10-21` 等 query parameter。Hono 自动忽略未使用的 query parameters，无需特殊处理。

### 认证透传

copilot-api-js 不验证客户端认证，Azure `api-key` header 和 `Authorization: Bearer` 都可以通过。

## 测试结果

```
bun test tests/http/azure-openai-compat.test.ts
  9 pass, 0 fail

bun test tests/http/
  76 pass, 0 fail （含所有现有 HTTP 测试回归验证）

bun run typecheck
  0 new errors
```

### 测试覆盖

| 测试 | 验证点 |
|------|--------|
| deployment format: model injection | URL 路径 → body model（无 body model 时） |
| deployment format: path overrides body | URL 路径始终覆盖 body model（Azure 契约） |
| deployment format: api-version | query parameter 不影响路由 |
| deployment format: unsupported model | 模型不支持 /chat/completions 时返回 400 |
| deployment format: embeddings | 经典格式 embeddings 路由 + model 注入 |
| v1 chat completions | /openai/v1/ 前缀正确路由 |
| v1 models list | GET /openai/v1/models 返回模型列表 |
| v1 models detail | GET /openai/v1/models/:model 返回单个模型 |
| v1 embeddings | POST /openai/v1/embeddings 正确路由 |

## Codex 代码评审修复

Codex (GPT-5.4) 对实现进行了 review，发现以下问题并已修复：

| 级别 | 问题 | 修复 |
|------|------|------|
| **High** | 经典格式中 body.model 优先于 URL 路径，违反 Azure 契约（deployment-id 为权威来源） | `injectDeploymentModel` 改为始终用 deployment 覆盖 body.model |
| **Medium** | embeddings/responses 的经典和 v1 路由未测试 | 新增 embeddings 经典格式和 v1 格式测试 |
| **Low** | 文档 `GET/POST /openai/v1/models` 不准确（Azure 只有 GET） | 修正为 `GET /openai/v1/models` + `GET /openai/v1/models/{model}` |
| **Medium** | `/openai/v1/models` schema 与 Azure 不一致 | ~~预存问题~~ → 已修复：拆分为 OpenAI 格式（`/models`）和内部格式（`/api/models`） |

### Models 端点拆分

原有 `/models` 返回 Copilot 内部完整格式，与 OpenAI 标准不兼容。现拆分为两个端点：

| 路由 | 格式 | 返回字段 |
|------|------|----------|
| `/models`、`/v1/models`、`/openai/v1/models` | OpenAI 标准 | `id`, `object`, `created`, `owned_by` |
| `/api/models` | 内部 | 完整 Copilot 模型数据（`vendor`, `name`, `capabilities`, `billing` 等） |

Web UI 的 `fetchModels()` 已从 `/models` 改为 `/api/models`。

## 未实施项

| 项目 | 原因 |
|------|------|
| Legacy `/openai/deployments/{model}/completions` | 旧式 completions 端点使用率极低，本项目也无此端点 |
| WebSocket `/openai/v1/responses` | 需要独立的 WS 路由注册，可在需要时添加 |

## 使用示例

### Azure OpenAI SDK（Python）

```python
from openai import AzureOpenAI

client = AzureOpenAI(
    azure_endpoint="http://localhost:4141",
    api_key="dummy",
    api_version="2024-10-21"
)

response = client.chat.completions.create(
    model="claude-sonnet-4.6",  # deployment name = model name
    messages=[{"role": "user", "content": "Hello"}]
)
```

### Azure OpenAI SDK（JavaScript）

```javascript
import { AzureOpenAI } from "openai"

const client = new AzureOpenAI({
  endpoint: "http://localhost:4141",
  apiKey: "dummy",
  apiVersion: "2024-10-21",
  deployment: "claude-sonnet-4.6"
})

const response = await client.chat.completions.create({
  model: "claude-sonnet-4.6",
  messages: [{ role: "user", content: "Hello" }]
})
```

### 标准 OpenAI SDK + Azure v1 base_url

```python
from openai import OpenAI

client = OpenAI(
    api_key="dummy",
    base_url="http://localhost:4141/openai/v1/"
)

response = client.chat.completions.create(
    model="claude-sonnet-4.6",
    messages=[{"role": "user", "content": "Hello"}]
)
```
