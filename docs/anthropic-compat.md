# Anthropic API 兼容性

本文档描述 copilot-api 的 Anthropic 兼容端点，以及**我们相对 Anthropic 官方契约的偏差**。客户端（Claude Code、Anthropic SDK 等）把 base URL 指向本服务即可用 GitHub Copilot 提供的模型驱动 Anthropic 生态工具。

> **body 契约以官方为准**：request/response body 的字段级 schema **镜像 [Anthropic 官方 Messages API](https://docs.anthropic.com/en/api) 既有契约**，本文只记我们特有的偏差 / shim / 改写。完整端点目录见 [API.md](API.md)；活的全表面真相 = 运行实例 `GET /openapi.json`（+ `/docs`）。

Anthropic 直连为 **bypass-direct** codec（translate/render = identity）——上游就是协议权威，代理只做兼容 shim。这是**偏差最集中**的 vendor：thinking signature、tool_use、cache_control、refusal、server_tool 都有我们特有的处理。codec 在 `src/lib/codec/anthropic/`。

## 端点

| 路由 | 方法 | 说明 |
|------|------|------|
| `/v1/messages`、`/anthropic/v1/messages` | POST | Messages API。**需要 Anthropic-vendor 模型**（直连 Copilot 原生 Anthropic 上游）；非-Anthropic 模型经出站腿后缀 / 自动 forward-translate 走翻译矩阵 |
| `/v1/messages/count_tokens`、`/anthropic/v1/messages/count_tokens` | POST | Token 计数——默认路由 GHC 上游 count_tokens、本地估算兜底（不进翻译矩阵 / driver） |
| `/anthropic/v1/models` | GET | Anthropic 形状的模型列表（`ModelInfo` + `ModelCapabilities`，过滤 `vendor=Anthropic`） |
| `/anthropic/v1/models/:id` | GET | Anthropic 形状的单个模型详情（仅 Anthropic 厂商；非 Anthropic 或不存在 → 404） |

## 认证与模型 ID

- **入站认证不校验**：`x-api-key` / `Authorization` 传占位符即可（如 `dummy`）；真正认证在上游（GitHub → Copilot token），见 [authentication.md](authentication.md)。
- **模型 ID 是 Copilot 目录 ID**：如 `claude-opus-4.8`、`claude-sonnet-4.6`。短别名（`opus`/`sonnet`/`haiku`）、带日期/连字符版本名（`claude-opus-4-8` → `claude-opus-4.8`）、`model_mappings` 同样适用（`src/lib/models/resolver.ts`）。
- **任意客户端用任意模型**：Anthropic 客户端可用非-Anthropic 模型——无后缀时自动 forward-translate（优先级 `messages > responses > cc`，故 Claude Code 直接写 `gpt-5.6-sol` 即可），或用 `@cc` / `@responses` 后缀显式钉出站腿。详见 [API.md](API.md#调用基础) + [rfc/2026-07-11-anthropic-via-openai-translation.md](rfc/2026-07-11-anthropic-via-openai-translation.md)。

## codec 与改写

- `codec.ts`：per-request 有状态工厂，承 B1–B12 wire 准备。
- `request-rewrite-adapter.ts`：sanitize 链作为 S3 RequestRewrite 注入。
- `response-rewrite-adapters.ts`：5 条 S5 ResponseRewrite——recover-tool-call(100) / thinking-signature-compat(150) / decode(200) / server-tool-filter(300) / refusal-recovery(400)，order 编码硬序契约。
- `strategies.ts`：10 个重试策略组装。

## 兼容协商（反应式学习）

`src/lib/anthropic/feature-negotiation.ts`：per-(endpoint,model) 永久缓存上游学到的特性/beta/effort/deferred-tool 拒绝，配合 config 孪生（`partner_strip_features`、`beta_strip_headers`）首发即剥。另有**端点级（模型无关）**的 `toolFields` 账本：学习上游拒绝的未知 custom-tool 顶层字段（`tools.N.<variant>.<field>: Extra inputs are not permitted`，如新版 CC 挂的 `eager_input_streaming`），config 孪生 `tool_strip_fields`（加）/ `tool_keep_fields`（减，可逆），内置默认剥 `eager_input_streaming` 使首发零 400。学习记录有 TTL 生命周期，可经 `/api/negotiation` 管理（见 [API.md](API.md)）。

## 我们相对官方的偏差（深文档）

| 偏差 | 说明 | 深文档 |
|------|------|--------|
| **thinking signature 隔离** | GHC 对相邻 thinking 块 / 空明文 thinking / 被修改的 signature 会 400「cannot be modified」或中毒；L1/L2/L3 三层隔离防护 | [spec/2026-07-07-thinking-signature-quarantine.md](spec/2026-07-07-thinking-signature-quarantine.md) |
| **tool_use 降级恢复** | 上游偶把 tool_use 降级成 `<invoke>` 文本；recover-tool-call 改写还原 | [tool-use.md](tool-use.md) |
| **server_tool 过滤** | server_tool_use 块在 GHC 会 400，S5 过滤 | [tool-use.md](tool-use.md) |
| **refusal 抑制** | contentless refusal（`stop_reason: refusal`）默认抑制成正常完成轮 | [refusal-recovery.md](refusal-recovery.md) |
| **sanitize 链** | 请求侧 cache_control 剥离、字段规整等 | [sanitize-pipeline.md](sanitize-pipeline.md) |

功能矩阵（配置）：thinking signature 自包含（块级保护）、adaptive thinking 强制、model_capabilities 名单（支持 glob/`!` 剔除，语义见 DESIGN.md）、cache_control 模式、L2 protect_streaming、refusal 恢复——逐项见 DESIGN.md「活的架构现状」「改写词汇」与 `anthropic.*` 运行时选项表。

## 客户端配置

### Claude Code

交互式：`npx -y @hsupu/copilot-api setup-claude-code`。或手动改 `~/.claude/settings.json`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "opus[1m]",
    "ANTHROPIC_SMALL_FAST_MODEL": "haiku"
  }
}
```

### curl

```bash
curl -s http://localhost:4141/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: dummy' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-sonnet-4.6","max_tokens":64,"messages":[{"role":"user","content":"hello"}]}' | jq
```

## 关联文档

- 完整端点目录：[API.md](API.md)
- 其他 vendor 偏差：[openai-compat.md](openai-compat.md)、[gemini-compat.md](gemini-compat.md)
- thinking / tool_use / refusal / sanitize：[spec/2026-07-07-thinking-signature-quarantine.md](spec/2026-07-07-thinking-signature-quarantine.md)、[tool-use.md](tool-use.md)、[refusal-recovery.md](refusal-recovery.md)、[sanitize-pipeline.md](sanitize-pipeline.md)
- 请求管线 / 流式：[request-pipeline.md](request-pipeline.md)、[streaming.md](streaming.md)
- 架构现状（改写词汇、通用翻译矩阵）：[DESIGN.md](DESIGN.md)「活的架构现状」
