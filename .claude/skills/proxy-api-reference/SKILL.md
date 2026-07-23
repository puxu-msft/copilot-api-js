---
name: proxy-api-reference
description: 当需要查阅/调用 copilot-api-js（本代理）**对客户端暴露**的任意 HTTP 端点时使用——OpenAI(chat/models/embeddings/responses)、Anthropic(messages/count_tokens)、Gemini(generateContent)、Azure deployments、管理 API(/api/*)、History REST、/metrics、/health、WebSocket。包含前缀变体、按 vendor 分组、以及如何用 /openapi.json 获取活的真相。区别于 ghc-api-reference（我们**消费的上游** GHC/Copilot API）。
---

# Proxy API 端点参考（copilot-api-js 对外暴露的入站面）

> **方向**：本 skill 是**入站 / 我们暴露给客户端**的 HTTP 端点。**上游 / 我们消费的 GHC/Copilot API**（模型目录、能力、beta header、wire 格式）见姊妹 skill `ghc-api-reference`。

## 权威真相源（优先用，别凭记忆）

- **活的全表面**：运行中实例的 `GET /openapi.json`（OpenAPI 3.1，覆盖全部端点）+ `/docs`（Scalar 交互页）。
- **挂载源码**：`src/routes/index.ts`（vendor/管理路由挂载点）+ `src/server.ts`（`/health`、`/`）+ `src/routes/openapi.ts`（`/openapi.json`、`/docs`）。
- **逐项说明（端点 SSOT）**：[docs/API.md](../../../docs/API.md)——全端点目录 + 字段级备注 + cross-ref。路由/codec 分派的架构现状见 `docs/DESIGN.md`「活的架构现状」。

端点漂移时以上述为准；本表只作快速定位。**主服务器 API-only**（2026-07-22 起）：不再服务/代理/构建任何前端 UI（`ui/`、`ui-v4/` 均由运维独立托管 + 反代，见 README「Hosting the Web UI」）。

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
| `/health`、`/health/readiness`、`/health/liveness`、`/`、`/docs` | 健康检查（readiness，`/health`≡`/health/readiness`）/liveness 探针/根/文档 |

### History REST 子端点

`GET /history/api/{entries,entries/:id,sessions,export,stats}`、`GET .../search?source=&q=`、`.../search/contains?hash=`、`POST .../entries/:id/{pin,unpin}`、`DELETE .../entries`、`.../sessions/:id`。调试见 skill `history-sqlite-schema`。

**详情 `entries/:id` 的 `attempts[].timing`**：始终含 `source`，并在该 physical dispatch 有采样时带出绝对 epoch（ms）四刻 `upstreamHeadersAt` / `upstreamMessageStartAt` / `upstreamFirstTokenAt` / `upstreamLastTokenAt`——`upstreamHeadersAt − startedAt` 即上游响应头到达延迟（零推断，用于诊断 GHC deferred-header 长思考 vs 挂起，见 spec `2026-07-23-upstream-silence-commit-timing.md`）。list 摘要端点不含 `attempts`（须取详情）。

## 调用

默认 base `http://localhost:4141`。本地探针经 History API 取真实 entry，详见 memory `empirical-probe-via-history-api`。
