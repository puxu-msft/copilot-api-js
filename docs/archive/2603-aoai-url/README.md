# Azure OpenAI URL 路径兼容

## 状态：已实施

## 目标

让 copilot-api-js 能作为 Azure OpenAI API 的 drop-in 替代，支持 Azure OpenAI 客户端（如 `AzureOpenAI` SDK、REST 调用）直接连接。

## 已实现

### 经典部署格式

| 路由 | 说明 |
|------|------|
| `POST /openai/deployments/:deployment/chat/completions` | deployment → model（URL 路径为权威来源） |
| `POST /openai/deployments/:deployment/embeddings` | 同上 |
| `POST /openai/deployments/:deployment/responses` | 同上 |

### v1 格式

| 路由 | 说明 |
|------|------|
| `/openai/v1/chat/completions` | 与 `/v1/chat/completions` 共用 handler |
| `/openai/v1/models`、`/openai/v1/models/:model` | OpenAI 标准格式 |
| `/openai/v1/embeddings` | 与 `/v1/embeddings` 共用 handler |
| `/openai/v1/responses` | 与 `/v1/responses` 共用 handler |

### Models 端点拆分

| 路由 | 格式 |
|------|------|
| `/models`、`/v1/models`、`/openai/v1/models` | OpenAI 标准格式（`id`, `object`, `created`, `owned_by`） |
| `/api/models` | 内部格式（完整 Copilot 模型数据） |

## 文档

- [azure-url-patterns.md](./azure-url-patterns.md) — Azure OpenAI URL 格式调研
- [implementation.md](./implementation.md) — 实现方案设计
- [implementation-report.md](./implementation-report.md) — 实施报告（含 Codex 代码评审修复）
