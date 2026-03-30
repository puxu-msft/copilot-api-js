# sync-ghc-api 审阅回应 260330-1

## 总体评价

审阅质量高。6 条 Finding 中有 5 条经代码验证成立，核心论点——"文档多处现状描述已过时，不能直接当实施清单"——完全正确。

接受审阅结论：应基于当前代码状态做一次文档收敛。

## 逐条回应

### Finding 1 — 请求头 ✅ 接受

`X-GitHub-Api-Version`、`X-Request-Id`、`OpenAI-Intent` 已在 `copilot-api.ts:54-56` 实现。原文档确实把已完成项写成缺失。

**补充**: 审阅提到的 `X-Interaction-Id` 会话级追踪头也确实存在（`copilot-api.ts:26-28`），这是本项目独有的，应在修订中说明。

**剩余 gap**: 仅 `X-Interaction-Type` 和 `X-Agent-Task-Id`，是否需要补齐待独立评估。

### Finding 2 — supported_endpoints ✅ 接受

`models/endpoint.ts` 已实现 `getEffectiveEndpoints()` / `isEndpointSupported()` / `isResponsesSupported()`，`chat-completions/handler.ts` 基于此在 Chat Completions 和 Responses 间路由。这不是"辅助参考"而是核心架构。

### Finding 3 — tool search / deferral ✅ 接受，并确认补充发现

`message-tools.ts` 已实现 `tool_search_tool_regex` 注入和 `defer_loading` 标记。原文档的"未实现"判断过时。

审阅的**补充发现有价值**: `modelSupportsToolSearch()` 确实只覆盖 Opus 4.5/4.6，GHC 额外支持 Sonnet 4.5/4.6。这是真实的剩余 gap。

审阅关于 tool result 过滤的补充也经代码验证：`sanitize/tool-blocks.ts:163-167` 的 user-side block 过滤确实只保留 `text` 和 `image`，不保留 `document`。当 Anthropic 文档支持 PDF document block 时，这会导致有效内容被丢弃。

### Finding 4 — thinking / context editing ✅ 部分接受

审阅正确指出：
- `modelSupportsContextEditing()` 已覆盖 Sonnet 4.6（通过 `claude-sonnet-4` 前缀匹配）
- README 将已完成项列为 P0 不当

**一点保留**: 依赖前缀匹配的副作用来覆盖 Sonnet 4.6 不够稳健。如果未来出现 `claude-sonnet-40` 这样的模型，当前匹配逻辑会错误覆盖。GHC 显式列出每个模型前缀更安全。**建议**：在代码注释中明确列出 Sonnet 4.6，并在修订文档中标注为"已覆盖但应改为显式列出"。

关于 adaptive thinking 的设计立场冲突，同意审阅判断：README 的 P0 表述（"应尽快采纳"）与 thinking-system.md 的建议（"尊重客户端配置"）矛盾。修订时应统一为后者。

### Finding 5 — Responses WS / previous_response_id ✅ 接受

`src/routes/responses/ws.ts` 已实现客户端↔代理的 WebSocket transport。`previous_response_id` 在类型中定义且透传。原文档的"未实现"描述不准确。

### Finding 6 — 参考基线 ⚠️ 部分不同意

审阅说"当前工作区不存在这个 checkout"，但经验证 `refs/vscode-copilot-chat/.git` 目录存在，commit `b3e2aa33` 可通过 `git log`/`git diff` 在本地复核。

**实际情况**: 参考仓库在 `refs/vscode-copilot-chat/` 下完整可用，文档中记录的 commit hash 有操作价值。不过审阅的建议——"把关键引用片段连同文件路径固化到文档中"——仍然有参考意义，可以提高文档的自包含性。

## 仍然有效的 Gap 清单（审阅验证后）

基于审阅和本次代码验证，更新后的真实 gap：

| # | Gap | 优先级 | 说明 |
|---|-----|--------|------|
| 1 | cache_control 自动注入 | P0 | 未见自动注入链路，只有类型声明 |
| 2 | tool result document block 保留 | P0 | sanitize 过滤器缺少 `document` 类型 |
| 3 | modelSupportsToolSearch 扩展到 Sonnet | P1 | 当前仅 Opus 4.5/4.6 |
| 4 | thinking budget min/max 校验 | P1 | 只做 `< max_tokens` 裁剪 |
| 5 | output_config 可用性测试 | P1 | 当前被 COPILOT_REJECTED_FIELDS 剥离 |
| 6 | 模型列表定期刷新 | P1 | 启动时单次 cacheModels() |
| 7 | X-Interaction-Type / X-Agent-Task-Id | P2 | 需独立评估是否有收益 |
| 8 | modelSupportsContextEditing 显式列出 | P2 | 当前依赖前缀匹配副作用 |

## 下一步建议

同意审阅提出的修订方式：按"GHC 做法 → 当前真实状态 → 剩余差距"三段式重写文档，明确区分"已实现 / 已透传 / 未实现"三类能力。

但建议**不急于重写整组文档**。更务实的方式是：
1. 用本回应 + 审阅文档取代原 README.md 的优先级总览
2. 直接基于上表的 Gap 清单推进实施
3. 实施完成后再收敛文档（此时文档与代码同步更新）
