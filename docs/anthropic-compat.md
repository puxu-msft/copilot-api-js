# Anthropic API 兼容性

## 概述

Anthropic `/v1/messages` 端点直连 Copilot 的原生 Anthropic API。仅支持 Anthropic vendor 的模型。

## 功能支持矩阵

| 功能 | 支持程度 | 说明 |
|------|----------|------|
| Prompt Caching | 部分支持 | 只读；`cache_read_input_tokens` 来自 Copilot 的 `cached_tokens`。无法设置 `cache_control` 标记可缓存内容。 |
| Batch Processing | 不支持 | Copilot API 不支持批处理。 |
| Extended Thinking | 部分支持 | `thinking` 参数会转发给 Copilot API；后端是否生成 thinking 块取决于 Copilot。 |
| Server-side Tools | 部分支持 | 支持所有服务端工具类型（如 `web_search`、`tool_search`）。默认透传，可通过 config `anthropic.strip_server_tools: true` 从请求中剥离。sanitizer 通过 duck-typing（`isServerToolResultBlock`）泛化处理所有 `server_tool_use`/`*_tool_result` 对。 |

## 模型名翻译

系统将客户端发送的模型名翻译为匹配的 Copilot 模型：

- **短别名**：`opus` → 最佳可用 opus，`sonnet` → 最佳可用 sonnet，`haiku` → 最佳可用 haiku
- **连字符版本**：`claude-opus-4-6` → `claude-opus-4.6`，`claude-sonnet-4-6` → `claude-sonnet-4.6`
- **带日期后缀版本**：`claude-sonnet-4-6-20250514` → `claude-sonnet-4.6`，`claude-opus-4-20250514` → 最佳可用 opus
- **修饰符后缀**：`claude-opus-4-6-fast` → `claude-opus-4.6-fast`，`opus[1m]` → `claude-opus-4.6-1m`
- **直接名称**：`claude-sonnet-4`、`gpt-4` 等直接透传
- **Model Overrides**：用户可通过 config.yaml 的 `model_overrides` 配置任意映射，支持链式解析和 family 级别重定向

详见 [Model 解析](model-resolution.md)

相关代码：`src/lib/anthropic/client.ts`、`src/lib/anthropic/features.ts`
