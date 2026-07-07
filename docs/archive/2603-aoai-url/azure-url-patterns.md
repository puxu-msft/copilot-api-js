# Azure OpenAI URL 格式全面调研

## 1. 经典部署格式（Deployment-Based）

### 基本结构

```
https://{resource-name}.openai.azure.com/openai/deployments/{deployment-id}/{operation}?api-version={version}
```

### 完整端点列表

| HTTP Method | 路径 | 说明 |
|-------------|------|------|
| POST | `/openai/deployments/{id}/chat/completions` | Chat Completions |
| POST | `/openai/deployments/{id}/completions` | Legacy Completions |
| POST | `/openai/deployments/{id}/embeddings` | Embeddings |
| POST | `/openai/deployments/{id}/audio/transcriptions` | 音频转文字 |
| POST | `/openai/deployments/{id}/audio/translations` | 音频翻译 |
| POST | `/openai/deployments/{id}/audio/speech` | TTS |
| POST | `/openai/deployments/{id}/images/generations` | 图片生成 |
| POST | `/openai/deployments/{id}/images/edits` | 图片编辑 |

### 关键差异（与标准 OpenAI 对比）

1. **模型名在 URL 路径中**：`{deployment-id}` 是 Azure 部署名（等价于模型名），request body 中的 `model` 字段会被 Azure 忽略
2. **必须有 `api-version`**：query parameter，如 `?api-version=2024-10-21`
3. **路径前缀**：所有端点以 `/openai/deployments/` 开头
4. **认证 header 不同**：用 `api-key: {key}` 而非 `Authorization: Bearer {key}`（虽然 Entra ID 也支持 Bearer）

### 常用 api-version 值

| 版本 | 状态 |
|------|------|
| `2024-10-21` | 当前 GA |
| `2025-04-01-preview` | 最新 Preview |
| `2025-03-01-preview` | Preview（含 Responses API） |

### 客户端使用示例

```python
# Python AzureOpenAI SDK
from openai import AzureOpenAI

client = AzureOpenAI(
    azure_endpoint="https://myresource.openai.azure.com",
    api_key="...",
    api_version="2024-10-21"
)

# SDK 自动构造 URL:
# POST https://myresource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21
response = client.chat.completions.create(
    model="gpt-4o",  # 这里的 model 实际上是 deployment name
    messages=[{"role": "user", "content": "Hello"}]
)
```

```javascript
// JavaScript AzureOpenAI SDK
import { AzureOpenAI } from "openai"

const client = new AzureOpenAI({
  endpoint: "https://myresource.openai.azure.com",
  apiKey: "...",
  apiVersion: "2024-10-21",
  deployment: "gpt-4o"
})

// SDK 自动构造 URL
const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }]
})
```

```bash
# curl
curl -X POST "https://myresource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21" \
  -H "api-key: $AZURE_OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'
```

## 2. v1 API 格式（新一代，2025 年 8 月 GA）

### 基本结构

```
https://{resource-name}.openai.azure.com/openai/v1/{operation}
```

### 完整端点列表

| HTTP Method | 路径 | 说明 |
|-------------|------|------|
| POST | `/openai/v1/chat/completions` | Chat Completions |
| POST | `/openai/v1/embeddings` | Embeddings |
| POST | `/openai/v1/responses` | Responses API |
| POST | `/openai/v1/audio/speech` | TTS |
| POST | `/openai/v1/audio/transcriptions` | 音频转文字 |
| POST | `/openai/v1/audio/translations` | 音频翻译 |
| POST | `/openai/v1/images/generations` | 图片生成 |
| POST | `/openai/v1/images/edits` | 图片编辑 |
| GET | `/openai/v1/models` | 模型列表 |
| GET | `/openai/v1/models/{model}` | 单个模型详情 |
| GET/POST | `/openai/v1/files` | 文件管理 |
| GET/POST | `/openai/v1/evals` | 评估 API |
| POST | `/openai/v1/fine_tuning/jobs` | 微调 |

### 关键差异（与经典格式对比）

1. **模型名在 request body 中**：与标准 OpenAI 一致
2. **无需 `api-version`**：不再是必需参数
3. **可用标准 `OpenAI()` 客户端**：设 `base_url` 即可
4. **支持跨供应商模型**：DeepSeek、Grok 等

### 客户端使用示例

```python
# 标准 OpenAI SDK
from openai import OpenAI

client = OpenAI(
    api_key="...",
    base_url="https://myresource.openai.azure.com/openai/v1/"
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello"}]
)
```

```javascript
// 标准 OpenAI SDK
const client = new OpenAI({
  baseURL: "https://myresource.openai.azure.com/openai/v1/",
  apiKey: "..."
})

const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }]
})
```

## 3. 两种格式的认证差异

| 方式 | 经典格式 | v1 格式 |
|------|----------|---------|
| API Key | `api-key: {key}` header | `api-key: {key}` 或 `Authorization: Bearer {key}` |
| Entra ID | `Authorization: Bearer {token}` | `Authorization: Bearer {token}` |

注意：经典 `AzureOpenAI` SDK 使用 `api-key` header（注意连字符），而标准 `OpenAI` SDK 使用 `Authorization: Bearer` header。

## 4. 额外 Query Parameters

经典格式的常见 query parameters（v1 格式大部分不需要）：

| 参数 | 必需 | 说明 |
|------|------|------|
| `api-version` | 是（经典）/ 否（v1） | API 版本号 |

v1 格式的 optional query parameters：
| 参数 | 说明 |
|------|------|
| `api-version` | 可选，`preview` 表示使用预览功能 |

## 5. 使用场景分析

### 谁会用这些 URL 格式连接 copilot-api-js？

1. **Azure OpenAI SDK 用户**：直接将 `azure_endpoint` 指向 copilot-api-js，期望经典格式可用
2. **标准 OpenAI SDK + Azure base_url**：设 `base_url` 为 `http://localhost:4141/openai/v1/`
3. **LiteLLM 等代理/框架**：配置 Azure provider 时发送经典格式请求
4. **curl / 直接 REST 调用**：按 Azure 文档格式构造 URL
5. **已有 Azure 代码迁移**：将 endpoint 从 Azure 改为 copilot-api-js，代码不改

### 价值评估

- **经典格式兼容**：高价值，大量现有代码和工具链使用此格式
- **v1 格式兼容**：中等价值，已接近标准 OpenAI，只差 `/openai` 前缀
