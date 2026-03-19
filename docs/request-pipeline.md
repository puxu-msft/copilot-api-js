# 请求重试管道

## 概述

`executeRequestPipeline()`（`src/lib/request/pipeline.ts`）使用策略模式处理请求失败，根据错误类型选择合适的重试策略。

## 重试策略

| 策略 | 触发条件 | 行为 |
|------|----------|------|
| `NetworkRetryStrategy` | 网络错误（ECONNRESET / ETIMEDOUT / socket 关闭等） | 延迟 1 秒后重试一次，不修改 payload |
| `TokenRefreshStrategy` | 401/403 | 刷新 Copilot token 后重试 |
| `AutoTruncateStrategy` | token 超限错误 | 截断 payload 后重试 |
| `DeferredToolRetryStrategy` | tool 相关错误 | 调整 tool 配置后重试 |

## 错误分类

`classifyError()`（`src/lib/error.ts`）将原始错误分类为结构化的 `ApiError`，供 pipeline 策略决策：

| ApiErrorType | HTTP 状态码 | 说明 |
|-------------|------------|------|
| `rate_limited` | 429 | 速率限制 |
| `payload_too_large` | 413 | 请求体过大 |
| `token_limit` | 400（body 含 token 超限模式） | Token 超限 |
| `content_filtered` | 422 | Responsible AI Service 内容过滤 |
| `quota_exceeded` | 402 | 使用配额耗尽 |
| `auth_expired` | 401/403 | Token 过期 |
| `network_error` | 0（无 HTTP 响应） | 连接失败、DNS 超时、socket 关闭等 |
| `server_error` | 5xx（非 503 上游限速） | 服务器错误 |
| `upstream_rate_limited` | 503（body 含 rate limit 模式） | 上游 provider 被限速 |
| `bad_request` | 400（非 token 超限） | 通用错误 |

## Retry-After 解析

`classifyError` 从两个来源提取 `retryAfter` 值（body 优先）：

1. **Response body**：`retry_after` / `error.retry_after` 字段
2. **Response header**：`Retry-After`（支持秒数和 HTTP-date 两种 RFC 7231 格式）

## 自适应速率限制器

`AdaptiveRateLimiter`（`src/lib/adaptive-rate-limiter.ts`）在 3 种模式间切换：

- **Normal** — 正常放行请求
- **Rate-limited** — 收到 429 后进入，按配置间隔限流
- **Recovering** — 限流期满后逐步恢复，连续成功达标后回到 Normal

相关代码：`src/lib/request/pipeline.ts`、`src/lib/error.ts`、`src/lib/adaptive-rate-limiter.ts`
