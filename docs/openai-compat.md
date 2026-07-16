# OpenAI API 兼容性

本文档描述 copilot-api 的 OpenAI 兼容端点，以及**我们相对 OpenAI 官方契约的偏差**。客户端（Codex CLI、OpenAI SDK、LangChain 等）把 base URL 指向本服务即可用 GitHub Copilot 提供的模型驱动 OpenAI 生态工具。

> **body 契约以官方为准**：request/response body 的字段级 schema **镜像 [OpenAI 官方 API](https://platform.openai.com/docs/api-reference) 既有契约**，本文只记我们特有的偏差 / shim / 桥接。完整端点目录见 [API.md](API.md)；活的全表面真相 = 运行实例 `GET /openapi.json`（+ `/docs`）。

OpenAI 是本项目的**内部规范格式**——Chat Completions 就是各格式翻译汇聚的 hub（Gemini codec、Anthropic 前向腿都委托到这里），故 OpenAI 侧的偏差最少、最贴近直连。

## 端点

所有 OpenAI 端点同时注册在**无前缀**、`/v1` 前缀和 `/openai/v1` 前缀下（`src/routes/index.ts`）。

| 路由 | 方法 | 说明 |
|------|------|------|
| `/chat/completions` | POST | Chat Completions（内部规范格式，直连度最高） |
| `/responses` | POST（+ WebSocket GET） | Responses API（Codex 一等公民，见下「Responses API」节） |
| `/embeddings` | POST | Embeddings |
| `/models`、`/models/:model` | GET | 模型列表 / 详情（OpenAI 兼容 + 扩展字段，见下） |

### Azure OpenAI 经典部署格式

`/openai/deployments/:deployment/{chat/completions,embeddings,responses}`（`src/routes/azure-openai/`）——deployment 名在 URL 路径中当作 model，`api-version` query parameter **被忽略**。deployment 经内部 `azureModelOverride` 通道覆盖 payload 的 `model` 字段后走同一管线。

## 认证与模型 ID

- **入站认证不校验**：`Authorization` / `api-key` 传占位符即可（如 `dummy`）；真正认证在上游（GitHub → Copilot token），见 [authentication.md](authentication.md)。
- **模型 ID 是 Copilot 目录 ID**（非 OpenAI 官方 ID）：如 `gpt-4o`、`gpt-5.5`、`claude-sonnet-4.6`、`gemini-2.5-pro`。短别名（`opus`/`sonnet`/`haiku`）、带日期/连字符版本名、`model_mappings` 同样适用（`src/lib/models/resolver.ts`）。
- **未知 `gpt-*` 回退**：不在模型目录里的 `gpt-*` 名也能透传上游（`env.model` 解析容忍目录外模型，codec P2.2-D5）。

## 模型列表扩展字段

`/models` 在 OpenAI 基线字段（`id`/`object`/`created`/`owned_by`）之上**附加**信息字段（`src/lib/models/capabilities.ts`）：`display_name`、`context_window`、`max_input_tokens`、`max_output_tokens`、`vision`、`tool_calls`、`parallel_tool_calls`、`reasoning_effort`（可选 effort 数组）、`family`、`vendor`。基线字段填充：`created: 0`、`owned_by: <vendor>`。`?detail=true` 与默认响应等价。

（管理视图 `/api/models` 返回**全量未过滤**内部目录——含 config-disabled 模型，与 vendor 端点正交，见 [API.md](API.md)。）

## Chat Completions

内部规范格式，偏差最小。我们特有的处理：

- **system-prompt 处理**：`processOpenAIMessages`（`src/lib/system-prompt.ts`）按 config 注入 / 规整 system 消息。
- **工具名 sanitize + 还原**：上游 GHC 会改写不合法的 tool-call 名；请求侧 sanitize、响应侧按 `ToolNameMapper` 把上游名**还原**回客户端原始名（`src/lib/openai/tool-name-sanitize.ts`，流式逐帧 `restoreChatCompletionsChunkToolNames`）。
- **工具字段剥离**：新版客户端挂在每个 tool 上的 `eager_input_streaming`（GHC 拒）内置默认首发即剥；未知 custom-tool 顶层字段经端点级反应式学习账本（`tool_strip_fields`/`tool_keep_fields`）学习剥除。详见 [anthropic-compat.md](anthropic-compat.md)「兼容协商」（账本模型无关、跨端点共享）。

## Responses API

Codex CLI 的一等公民路径，也是偏差最集中处。每请求由 codec（`src/lib/codec/openai-responses/codec.ts`）三向决策：**直连 `/responses` 上游** / **回退 `/chat/completions`** / **拒绝**。

- **强制回退厂商**：Copilot 的 `/responses` 上游对部分 Google SKU 返 5xx，故 `FORCE_CC_VENDORS`（当前 `Google`）即便模型声称支持 `/responses` 也强制走 CC 回退（`src/routes/responses/fallback.ts`，上游修好后更新此表）。
- **服务端会话状态重建**：Codex 用 `previous_response_id` 链式串联多轮、依赖代理维护服务端会话。回退到无状态 CC 上游时，代理从 history 手动**重放前序对话**（turn-increment 抽取：取每条历史 entry 尾部的非-assistant 消息串 + 其响应，自动 dedupe 全历史模式）（`src/routes/responses/conversation-rebuild.ts`）。
- **稳定 ID**：回退路径合成稳定的 `resp_` / `item_` ID；直连路径经 `fixStreamEventIds` 规整流事件 ID。
- **WebSocket 变体**：`/responses` 同路径支持 `GET` + `Upgrade: websocket`，见 [ws-openai-responses.md](ws-openai-responses.md)。
- **Codex tier-1 健壮性**（详见 [DESIGN.md](DESIGN.md)「活的架构现状」Codex/Responses 行）：
  - **下游保活**：SSE + WS 都注入 `response.ping`（合法 JSON + 未知 type，Codex 每 SSE 事件重置其 300s idle 钟），间隔 `streamKeepalivePingSec`（默认 20s）；帧打 `synthetic:"keepalive"` 标记入 forwarded 轨。
  - **opt-in buffered 重试**：`responsesBufferedRetry` **默认 OFF**（Codex 默认不做 mid-stream auto-retry）；on 时缓冲整响应、终态 upstream error 帧 commit+fail 不 retry。
  - **上游 WS 关闭码**：全 lifecycle 经 `closeUpstreamWs` 用 `1000`（WHATWG normal，避免 Node/undici 对 1001 抛 `invalid code`）。
  - **idle 上限**：`streamIdleTimeout`（默认 300s）是上游帧静默硬上限，可 per-model 覆盖（`streamIdleTimeoutOverrides`，如 `gpt-5.5:600`）；下游保活**不**重置它。

## Embeddings

`src/lib/openai/embeddings.ts`。偏差：

- **input 归一化**：裸 string input 会被规整成单元素数组（部分上游 provider 拒裸 string）。
- 始终非流式，折入 shutdown signal（Phase 3 abort 可中断）。
- 支持 `encoding_format`（`float`/`base64`）、`dimensions`。
- Embeddings 不建 `RequestContext`、不进 V2 History sink；History V3 旁路 lifecycle 会生成完整 canonical `ModelOperation` terminal record（terminal 同时进入 bounded registry 与独立 V3 store，可经 V3 read API 查询）。

## 跨 vendor 出站腿后缀（通用翻译矩阵）

任意 OpenAI 客户端可用**任意 GHC 模型**——模型名加后缀 `@cc` / `@responses` / `@messages`（大小写不敏感）显式钉出站腿。例如 OpenAI 客户端发 `claude-opus-4.8@messages` 经 Anthropic `/v1/messages` 上游。后缀经 `resolveModelTarget` 剥离，路由在 `pipeline/router.ts`，翻译经 `pipeline/hub-translate.ts`。详见 [API.md](API.md#调用基础) + [rfc/2026-07-11-anthropic-via-openai-translation.md](rfc/2026-07-11-anthropic-via-openai-translation.md)。

## 客户端配置

### curl

```bash
# Chat Completions（非流式）
curl -s http://localhost:4141/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hello"}]}' | jq

# Responses
curl -s http://localhost:4141/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.5","input":"hello"}' | jq

# Embeddings
curl -s http://localhost:4141/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"text-embedding-3-small","input":"hello world"}' | jq
```

### Codex CLI

```toml
# ~/.codex/config.toml（honors $CODEX_HOME）
model_provider = "ghc"

[model_providers.ghc]
name = "ghc"
base_url = "http://localhost:4141/v1"
wire_api = "responses"
preferred_auth_method = "apikey"
```

或让代理写入托管块：`npx copilot-api setup-codex`。

### OpenAI SDK

```ts
import OpenAI from "openai"

const client = new OpenAI({
  apiKey: "dummy", // 不校验
  baseURL: "http://localhost:4141/v1",
})

const res = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
})
console.log(res.choices[0]?.message.content)
```

## 关联文档

- 完整端点目录：[API.md](API.md)
- 其他 vendor 偏差：[anthropic-compat.md](anthropic-compat.md)、[gemini-compat.md](gemini-compat.md)
- Responses WebSocket：[ws-openai-responses.md](ws-openai-responses.md)
- 请求管线 / 流式 / 工具调用：[request-pipeline.md](request-pipeline.md)、[streaming.md](streaming.md)、[tool-use.md](tool-use.md)
- 架构现状（Codex/Responses tier-1、通用翻译矩阵）：[DESIGN.md](DESIGN.md)「活的架构现状」
