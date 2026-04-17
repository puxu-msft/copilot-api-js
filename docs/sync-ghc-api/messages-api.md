# Anthropic Messages API

## GHC 的 Messages API 实现

GHC 的 `messagesApi.ts` 是**强改写型适配层**，不是透传。它主动构建 tool 列表、thinking 配置、context management、cache_control 等。

## 1. cache_control 自动注入 + tool 排序 — 已实现 ✅

### GHC 做法

GHC 在 `addToolsAndSystemCacheControl()` 中自动注入 `cache_control` breakpoint：

- Anthropic 允许最多 **4 个** `cache_control` breakpoint（缓存层级：tools → system → messages）
- 先统计 messages 中已有的 breakpoint 数量
- 在剩余 slot 内优先标记**最后一个非 deferred tool**
- 再标记**最后一个 system block**
- 跳过 `defer_loading: true` 的 tool（不能有 cache_control）

为了最大化缓存命中率，GHC 还**排序 tools 数组**：
1. `tool_search_tool_regex`（最前）
2. 所有 non-deferred tools
3. 所有 deferred tools

这样 non-deferred 部分是稳定前缀，deferred 部分的变化不破坏缓存。

### 本项目现状

- `request-preparation.ts:129-216` — `addToolsAndSystemCacheControl()` 实现 ✅
  - 递归统计现有 breakpoint 数量（`countExistingCacheBreakpoints`）
  - 优先标记最后一个 non-deferred tool → 再标记最后一个 system block
  - 尊重已有 `cache_control`，不重复添加
  - 不可变更新（返回新数组）
- `message-tools.ts:155-220` — tool 排序 ✅
  - 分别收集 `nonDeferred` 和 `deferred`
  - 最终拼接顺序：`tool_search → nonDeferred → deferred`
- 调用时机：`prepareAnthropicRequest()` 中 `buildWirePayload`（已含 `stripServerTools`）之后

## 2. Tool Search — 已实现 ✅

### GHC 做法

支持两种 tool search 模式：

- **Server-side**: 注入 `tool_search_tool_regex`（`type: tool_search_tool_regex_20251119`）
- **Client-side custom**: 自定义 `tool_search`，结果转 `tool_reference` block

支持的模型前缀：`claude-sonnet-4.5`、`claude-sonnet-4.6`、`claude-opus-4.5`、`claude-opus-4.6`

### 本项目现状

- Server-side tool search 注入 ✅（`message-tools.ts:157-163`）
- defer_loading 标记 ✅（`message-tools.ts:166-187`）
- tool 排序（non-deferred 在前）✅（`message-tools.ts:155-220`）
- 历史 tool name 收集（避免已用工具被 defer）✅（`message-tools.ts:153`）
- `beta` header `advanced-tool-use-2025-11-20` ✅（`features.ts:135`）
- 模型覆盖范围包含 Sonnet 4.5/4.6 ✅（`features.ts:76-77`）

## 3. Tool Result Content Type 过滤 — 已实现 ✅

### GHC 做法

tool_result 内容块只允许 `text`、`image`、`document` 类型，空文本被丢弃。

### 本项目现状

`sanitize/tool-blocks.ts:163-167` 的 user-side block 过滤保留 `text`、`image`、`document` ✅

## 4. Trailing Assistant Message Guard — 已透传

### GHC 做法

Messages API 要求对话以 user message 结尾。GHC 检测到尾随 assistant 消息时自动追加 `{ role: 'user', content: 'Please continue.' }`。

### 本项目现状

作为代理透传客户端消息。客户端（如 Claude Code）自行确保消息结构合法。`sanitize.ts` 管道处理的是 orphaned tool blocks，不涉及尾随 assistant 修复。

**评估**: 如果客户端总是发送合法结构，此项不是 gap。如果要增强健壮性，可以在 sanitize 管道末尾添加检测。P2。

## 5. Image / PDF 处理 — 已透传 ✅

本项目作为代理透传，客户端已按 Anthropic 格式构建图片和 PDF block。不需要做格式转换。

## 6. Thinking Round-trip — 已透传 ✅

客户端（如 Claude Code）自己管理 thinking/redacted_thinking block 的回传。代理透传即可。
