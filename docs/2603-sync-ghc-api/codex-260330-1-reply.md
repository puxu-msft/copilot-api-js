# Codex 独立扫描回应 260330-1

## 总体评价

这份扫描质量很高，最大价值在于从**调用链视角**重新梳理了 GHC 的实现，补充了之前分析文档和审阅中缺失的机制层信息。扫描结论经代码验证基本成立。

## 基线说明

扫描使用的参考仓库路径 `refs/github-copilot-chat`（commit `6ad6a35`）与原分析的 `refs/vscode-copilot-chat`（commit `b3e2aa33`）是同一远程仓库（`microsoft/vscode-copilot-chat`）的两个本地 checkout，Codex 的版本更新（3/30 vs 3/28）。两者共存，不冲突。

## 逐节确认

### Section 1-2（模型元数据、请求头、网络重试）✅

这些结论在之前的审阅中已验证。扫描补充了一个有用的细节：

- GHC 对 Messages 路径有 **双条件门控**：`UseAnthropicMessagesApi` 实验开关 + `supported_endpoints` 声明。不是所有声明支持 `/v1/messages` 的模型都会走 Messages 路径。

这对本项目有参考意义：本项目作为代理，所有 Anthropic vendor 请求都直接走 Messages API，不需要实验开关。但了解 GHC 的门控逻辑有助于理解为什么某些行为在 GHC 侧可能被延迟启用。

### Section 3（Anthropic Messages 路径）✅ 有新发现

3.1-3.2：已在之前分析中覆盖。

**3.3 Tool 排序优化** — **新发现，有实施价值**

GHC 把 tools 分为 non-deferred 和 deferred 两组，non-deferred 排在前。这样 `cache_control` breakpoint 放在最后一个 non-deferred tool 上时，缓存覆盖了 `tool_search_tool + 所有 non-deferred tools`，而 deferred tools 的变化不会破坏缓存。

验证本项目：`message-tools.ts:155-180` 中 tools 按**遍历顺序**直接 push，non-deferred 和 deferred 混排。如果后续实现 cache_control 自动注入，这个排序差距会直接影响缓存效果。

**建议**：将此纳入 cache_control 自动注入的实施方案中，作为前置步骤。

3.4-3.5：已在之前分析中覆盖。

**3.6 cache_control 注入策略** — 扫描的描述更精确

扫描明确指出了 4 breakpoint 上限和分配优先级（tool 优先于 system），这比我之前的分析更清晰。已纳入 gap list。

3.7-3.8：已在之前分析和审阅中覆盖。关于 `document` block 保留的缺口在审阅回应中已确认。

### Section 4（Responses 路径）✅

4.1-4.3：已覆盖。

**4.4 `include` 字段主动注入** — 值得关注

GHC 默认主动加 `include: ['reasoning.encrypted_content']`。这意味着即使客户端没有请求，GHC 也会获取加密的推理内容用于后续 round-trip。

验证本项目：作为代理透传客户端请求，如果客户端不设 `include`，则不会有此字段。

**评估**：本项目定位是透传代理，不自己管理对话状态。如果客户端（如 Claude Code）自己传 `include`，则已覆盖。如果不传，代理不应自作主张添加。**不作为 gap**。

### Section 5（WebSocket 路径）✅

5.1-5.3：扫描的描述准确。

**5.4 WS→HTTP 降级** — 有参考价值但不紧急

本项目的 `responses/ws.ts` 实现的是**客户端→代理**的 WebSocket，代理→上游仍走 HTTP。降级机制在上游链路不适用。但如果未来做代理→上游 WebSocket，这个 fallback 设计值得参考。

### Section 6（总结性结论）✅

六条结论中最有新增价值的是：

> "GHC 的'头、body、流'三层是联动设计的：beta header / request body capability / stream semantic event 缺一层都不算真正支持某项能力。"

这个抽象概括非常精准。本项目在 Anthropic 路径上已经实现了这种三层联动（beta headers + context_management body + 流事件透传），但在文档中从未显式表述过。

## 对已验证 Gap List 的增量更新

基于这份扫描，`review-260330-1-reply.md` 的 gap list 需要补充一项：

| # | Gap | 优先级 | 说明 |
|---|-----|--------|------|
| **新增** | Tool 排序：non-deferred 在前 | P0 | cache_control 注入的前置条件 |

这一项应与 cache_control 自动注入合并为一个实施单元。

## 扫描的使用建议

同意 Section 6 最后的建议 — 这份扫描最适合作为**调用链参考**和**机制层参考**，补充到现有文档体系中。不需要替代现有文档，而是作为独立的 GHC 架构速查手册。

## 更新后的完整 Gap List

合并原审阅回应 + 本次扫描后：

| # | Gap | 优先级 | 说明 |
|---|-----|--------|------|
| 1 | cache_control 自动注入 + tool 排序 | P0 | non-deferred/deferred 分组排序 → 注入 breakpoint |
| 2 | tool result document block 保留 | P0 | sanitize 过滤器缺少 `document` 类型 |
| 3 | modelSupportsToolSearch 扩展到 Sonnet | P1 | 当前仅 Opus 4.5/4.6，GHC 含 Sonnet 4.5/4.6 |
| 4 | thinking budget min/max 校验 | P1 | 只做 `< max_tokens` 裁剪 |
| 5 | output_config 可用性测试 | P1 | 当前被 COPILOT_REJECTED_FIELDS 剥离 |
| 6 | 模型列表定期刷新 | P1 | 启动时单次 cacheModels() |
| 7 | X-Interaction-Type / X-Agent-Task-Id | P2 | 需独立评估收益 |
| 8 | modelSupportsContextEditing 显式列出 | P2 | 当前依赖前缀匹配副作用 |
