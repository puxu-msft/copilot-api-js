---
name: api-endpoints
description: 当需要查阅/调用 copilot-api-js 暴露的任意 HTTP 端点时使用——OpenAI(chat/models/embeddings/responses)、Anthropic(messages/count_tokens)、Gemini(generateContent)、Azure deployments、管理 API(/api/*)、History REST、/metrics、/health、WebSocket。包含前缀变体、按 vendor 分组、以及如何用 /openapi.json 获取活的真相。
---

# API Endpoints 总览

## 权威真相源（优先用，别凭记忆）

- **活的全表面**：运行中实例的 `GET /openapi.json`（OpenAPI 3.1，覆盖全部端点）+ `/docs`（Scalar 交互页）。
- **挂载源码**：`src/routes/index.ts`（vendor/管理路由挂载点）+ `src/server.ts`（`/health`、`/`）+ `src/routes/openapi.ts`（`/openapi.json`、`/docs`）。
- **逐项说明**：`docs/DESIGN.md`「路由」节（含字段级备注）。

端点漂移时以上述为准；本表只作快速定位。

## OpenAI 兼容（三前缀：无 / `/v1` / `/openai/v1`）

| 路径 | 用途 |
|---|---|
| `/chat/completions` | Chat Completions |
| `/models`、`/models/:model` | 模型列表/详情 |
| `/embeddings` | Embeddings |
| `/responses` | Responses API（HTTP POST + WS GET） |

## Anthropic

`/v1/messages`、`/anthropic/v1/messages`（含子路由 `/count_tokens`）、`/anthropic/v1/models[/:id]`

## Gemini

`/v1beta/models/:model:generateContent`、`:streamGenerateContent`、`:countTokens`

## Azure 经典

`/openai/deployments/:deployment/{chat/completions,embeddings,responses}`（model 在 URL，`api-version` 忽略）

## 管理 / 基础设施

| 路径 | 用途 |
|---|---|
| `/api/{status,stats,tokens,config,logs,models,debug,event_logging}` | 管理 API（精确 zod schema） |
| `/api/stats?dimension=&window=&limit=` | 泛型维度 breakdown |
| `/history/api/*`、`/ws` | History REST + WebSocket（含 search、pin/unpin） |
| `/metrics` | Prometheus exposition |
| `/health`、`/`、`/docs`、`/ui/*`、`/ui-v4/*` | 健康检查/根/文档/前端 |

### History REST 子端点

`GET /history/api/{entries,entries/:id,sessions,export,stats}`、`GET .../search?source=&q=`、`.../search/contains?hash=`、`POST .../entries/:id/{pin,unpin}`、`DELETE .../entries`、`.../sessions/:id`。调试见 skill `history-sqlite-schema`。

## 调用

默认 base `http://localhost:4141`。本地探针经 History API 取真实 entry，详见 memory `empirical-probe-via-history-api`。
