# Tool Use 机制

## Anthropic API 的两类工具

### 用户定义工具（User-defined tools）

- 客户端在请求的 `tools` 数组中定义（带 `input_schema`）
- Assistant 生成 `tool_use` 块调用工具
- User 返回 `tool_result` 块提供结果
- `tool_use` 在 assistant 消息中，`tool_result` 在 user 消息中

### 服务端工具（Server-side tools）

- Anthropic 后端内置（如 `web_search`、`code_execution`）
- 请求中以 `type: "web_search_20250305"` 形式发送（无 `input_schema`）
- Assistant 生成 `server_tool_use` 块
- 后端执行并在**同一条 assistant 消息**中返回结果（如 `web_search_tool_result`）
- 客户端不参与执行过程

已知的 server tool type 前缀（来源：`@anthropic-ai/sdk`）：
- `web_search_` — 网页搜索
- `web_fetch_` — URL 内容获取
- `code_execution_` — 代码沙箱执行
- `text_editor_` — 文本编辑器
- `computer_` — 计算机控制（Computer Use）
- `bash_` — Bash 命令执行

## Tool Use/Result 配对要求

**核心原则：Anthropic API 要求 `tool_use` 和 `tool_result` 必须配对存在。**

- 每个 `tool_use` 块必须有对应的 `tool_result` 块（通过 `id` 和 `tool_use_id` 匹配）
- 孤立的 `tool_use`（没有 `tool_result`）会导致 HTTP 400 错误
- 孤立的 `tool_result`（没有 `tool_use`）同样会导致错误

## tool_search 机制（Copilot 特有）

`tool_search`（`tool_search_tool_regex`）是 GHC/Copilot 特有的**工具发现**机制，不是标准 Anthropic API：

- 当工具列表太长时，把不常用的工具标记为 `defer_loading: true`
- 模型通过 `tool_search_tool_regex` 搜索并"加载"需要的工具
- 响应中返回 `server_tool_use`（name: `tool_search_tool_regex`）+ `tool_search_tool_result`
- 结果包含 `tool_references`：发现的工具名列表

### tool_search vs web_search 对比

| | `tool_search` | `web_search` |
|---|---|---|
| **本质** | Copilot 特有的工具发现机制 | 标准 Anthropic 网页搜索功能 |
| **目的** | 让模型按需搜索并"加载"deferred tools | 让模型获取最新网络信息 |
| **结果消费者** | **客户端** — 需解析 tool_references | **模型自身** — 搜索结果在同一消息内被消费 |

相关代码：`src/lib/anthropic/message-tools.ts`（`processToolPipeline`）

## Server Tool 处理（stripServerTools）

`stripServerTools`（`src/lib/anthropic/message-tools.ts`）控制 server tools 的处理方式：

- **`false`（默认）** — server tools 原样透传，响应中的 `server_tool_use`/`*_tool_result` 也原样转发
- **`true`** — server tools 从请求中移除（上游不支持时使用），响应 filter 作为安全网激活

配置项：`anthropic.strip_server_tools`

## 会话续接与工具集变化

在 Claude Code 等客户端中，会话续接时可能出现工具集变化。**Anthropic API 不要求历史 `tool_use` 引用的工具必须在当前 `tools` 数组中。** 只要配对完整，API 就接受历史记录。

相关代码：`src/lib/anthropic/sanitize.ts`（`processToolBlocks`）
