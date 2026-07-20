# VSCode Copilot Chat 参考项目分析

对比 GHC (VSCode Copilot Chat) 与本项目 (copilot-api-js) 的 Copilot API 实现，
识别值得采纳的功能、尚未对齐的差距，以及设计立场上的主动取舍。

## 基线

- **上游仓库**: `microsoft/vscode-copilot-chat`
- **本轮基线**: `9e668cb12` (2026-04-07) — `refs/vscode-copilot-chat` HEAD
- **上一轮基线**: `b3e2aa33` (2026-03-28)
- **增量提交数**: 147 commits（多数为 Copilot CLI / VS Code 会话层，API 层变更约 15 条）
- 增量检查命令：`cd refs/vscode-copilot-chat && git diff b3e2aa33..HEAD -- src/platform/endpoint src/platform/networking`

## 目录

| 文档 | 说明 |
|------|------|
| [request-headers.md](request-headers.md) | HTTP 请求头构建：core header + anthropic-beta 合并策略 |
| [model-capabilities.md](model-capabilities.md) | 模型能力检测、fetchedValue 机制、路由决策、刷新策略 |
| [messages-api.md](messages-api.md) | Anthropic Messages API：cache_control、tool 排序、summarization 工具清理 |
| [responses-api.md](responses-api.md) | OpenAI Responses API：context management、reasoning effort guard、stateful marker |
| [network-resilience.md](network-resilience.md) | 网络弹性：重试、WebSocket transport（per-conversation）、middleware |
| [thinking-system.md](thinking-system.md) | Thinking 系统：adaptive、budget 校验、reasoning effort、context editing |
| [token-counting.md](token-counting.md) | Token 计数：o200k vs Claude tokenizer mismatch(~2x)、无本地 Claude tokenizer / 无 GHC count_tokens 端点、calibration 架构为何正确、从成功请求学习的改进方向 |
| [实施状况.md](实施状况.md) | 本轮对齐进度与差距清单 |

## 设计立场

**本项目是透明代理，不是 GHC 的"强改写适配层"。**

GHC 主动构建并改写请求体（thinking config、context management、cache_control breakpoints、trailing assistant guard、prompt_cache_key）。本项目原则上透传客户端值，只在三类情况下主动干预：

1. **缓存效率**（如 tool ordering、cache_control 注入）
2. **上游兼容性**（如 COPILOT_REJECTED_FIELDS、tool_search 注入、thinking budget 裁剪）
3. **会话级聚合**（如 X-Interaction-Id）

这些干预点都对应"客户端透传 → 上游拒绝"的真实失败场景，不是出于改写偏好。

## 本轮新增关注点（相对 2603 基线）

| # | 上游变更 | 本项目对齐 | 文档 |
|---|---------|-----------|------|
| 1 | `supportsReasoningEffort` 空列表 guard（#5010） | ⚠️ 待对齐 | [responses-api.md](responses-api.md) / [thinking-system.md](thinking-system.md) |
| 2 | `anthropic-beta` SDK/endpoint header 合并（#4945） | ⚠️ 待评估 | [request-headers.md](request-headers.md) |
| 3 | Orphan CacheBreakpoint 占位块移除（#4839） | ✅ 不适用 | [messages-api.md](messages-api.md) |
| 4 | Per-conversation WebSocket 复用（#4827） | ⚠️ 语义差异 | [network-resilience.md](network-resilience.md) |
| 5 | `fetchedValue` 中间件抽象（#4943） | 🔲 仅参考 | [model-capabilities.md](model-capabilities.md) |
| 6 | `forceExtendedThinking` 实验移除（#4966） | ✅ 不适用 | [thinking-system.md](thinking-system.md) |
| 7 | Summarization 下 `tool_search` 清理（#4993） | 🔲 不适用 | [messages-api.md](messages-api.md) |
| 8 | Summarization 下 `tool_choice` 空 tools guard（#4988） | 🔲 不适用 | [messages-api.md](messages-api.md) |
| 9 | Deferred tool 计入 budget（#4992） | 🔲 不适用 | [messages-api.md](messages-api.md) |
| 10 | Anthropic 优化提示词成为 4.6 默认（#4941） | 🔲 不适用 | — |

对齐状态图例：
- ✅ 已实现或天然不受影响
- ⚠️ 需修复或评估
- 🔲 仅 GHC 内部逻辑，代理无需复刻

## 审阅历史

| 文档 | 说明 |
|------|------|
| [review-260330-1.md](review-260330-1.md) | 2603 基线审阅：发现 6 条文档现状描述过时 |
| [review-260330-1-reply.md](review-260330-1-reply.md) | 审阅回应（确认 5/6 成立，推动了文档重写）|
| [codex-260330-1.md](codex-260330-1.md) | Codex 独立扫描（GHC 调用链梳理）|
| [codex-260330-1-reply.md](codex-260330-1-reply.md) | 扫描回应（确认 + 新增 tool 排序 gap）|

> 审阅文档保留为历史档案，反映 2603 → 2604 演进过程。具体技术细节以本轮 6 篇专题为准。
