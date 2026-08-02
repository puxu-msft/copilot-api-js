# 网络韧性重试加固（block-level 三腿闭合 + 预算分族 + 总时长预算）

- 状态：**草案 · 待评审**（2026-08-02）
- 触发：用户诉求「网络波动带来的伤害太大了，需要增强重试机制，增加重试次数默认 9 次，总超时时间到 3600s」，并给出三种情形的期望行为。
- 范围（用户裁决）：**Anthropic `/v1/messages` + OpenAI Responses（HTTP + WS）**。Chat Completions / Gemini 出范围，另记 backlog。
- 关联：ADR [2026-07-11-block-level-buffered-retry](../decisions/2026-07-11-block-level-buffered-retry.md)、ADR [2026-07-22-continuation-retry-sequential-anchor](../decisions/2026-07-22-continuation-retry-sequential-anchor.md)、spec [2026-07-11-block-level-buffered-retry](2026-07-11-block-level-buffered-retry.md)、spec [2026-07-22-continuation-retry-and-sequential-anchor](2026-07-22-continuation-retry-and-sequential-anchor.md)。

## 1. 用户期望的三种情形

1. **尚未 commit block 时** —— 无缝重试（客户端无感）。
2. **已 commit block + 已提交前缀含 tool_use** —— 静默结束本轮，等待客户端回馈（客户端拿工具去执行、自己接续对话）。
3. **已 commit block 但无 tool_use** —— 补合成 user 轮（如 "continue"）续写，缝进同一条客户端流。

外加两个预算诉求：重试次数默认 **9** 次、总超时 **3600s**。

## 2. 现状（本节每条都是可核验断言，评审须逐条取证）

- **C1** 三条腿全部挂在缓冲路径 `runResponseBufferedSink` 上；Anthropic 的开关 `protect_streaming_generation` 内置默认 `false`（`packages/foundation/src/state-defaults.ts:124`），用户 `config.yaml:771` 也是 `false` → [messages/handler-v4.ts:1367](../../src/routes/messages/handler-v4.ts#L1367) 走 live 分支 → **情形 1/2/3 对 Claude Code 一条都不生效**，今天流中途被掐即给客户端发 `event: error`。
- **C2** 情形 2 今天的实现与 ADR 不符：[driver.ts:1544](../../src/lib/pipeline/driver.ts#L1544) 落 `partial-degrade` → [messages/handler-v4.ts:1388-1416](../../src/routes/messages/handler-v4.ts#L1388-L1416) 合成 Anthropic `error` 帧写给客户端；而 ADR D3 明写「不续写，**正常终止**」。
- **C3** 续写腿只有 Anthropic 接线（`committedBlocksLedger` + `extractAnthropicCommittedBlocks` + `continuation` 三件套，[messages/handler-v4.ts:1328-1340](../../src/routes/messages/handler-v4.ts#L1328-L1340)）；Responses 侧无任何一件 → 驱动的续写分支对 Responses 恒为 inert。
- **C4** Responses-HTTP 已是块级提交（`candidate-response-session.ts:140` 传 `isResponsesCommitBoundary`）；Responses-WS **故意** terminal-only（[ws.ts:372-385](../../src/routes/responses/ws.ts#L372-L385) 的 P4 Task 1 评审结论）。
- **C5** 预算现状：`buffered_retry.max_retries` 内置默认 3（`state-defaults.ts:125`）、用户 config 亦为 3；`retry.max_reactive_retries` 内置默认 5（`state-defaults.ts:186`），单一标量通吃全部反应式策略族。
- **C6** 仓库中**不存在**任何 per-request 总时长预算；只有 per-attempt 的 `responseHeaderTimeout: 300` / `streamIdleTimeout: 300`（`state-defaults.ts:246-247`）。
- **C7** 候选/派发预算会饿死高 `max_retries`：`generationMaxTotalCandidates: 5` / `generationMaxTotalDispatches: 16`（`state-defaults.ts`），[driver.ts:1518-1527](../../src/lib/pipeline/driver.ts#L1518-L1527) 的注释明写候选预算耗尽时续写 dispatch 失败 → best-effort 降级 `continuation-exhausted`。
- **C8** 反应式策略 registry 已有 `configKey` 分组（`schema.ts` 的 `RETRY_STRATEGY_CONFIG_KEYS` 枚举 + `retry.strategies.<configKey>.enabled`），可据此按族分档，无需新建注册机制。
- **C9** continuation builder 是 vendor-keyed registry（`src/lib/pipeline/continuation-request-builder.ts`，Anthropic 在 `messages/handler-v4.ts:217` 模块加载时注册），Responses 可平行插入。
- **C10** 客户端保活边界：CC 侧 60s byte-idle（任意字节/ping 重置）+ 300s event-idle（须非-ping 事件重置），当前由 `streamKeepalivePingSec: 20` + `streamKeepaliveEscalateSec: 200`（升级为空 content delta）覆盖 —— 见 skill `debugging-claude-client-connection`。
- **C11** 情形 2/3 的判别谓词是 `hasCompleteInteractiveToolUse`，实现为 `committed.some((b) => b.type === "tool_use")`（`src/lib/pipeline/committed-blocks-ledger.ts:40-42`）。ADR D3 要求 `server_tool_use` 等上游自执行块**不算**可交互 tool_use —— **本 spec 未核实 extractor 是否会把 server_tool_use 归一成 `type: "tool_use"`**，若会归一则该谓词误判，情形 2 会吞掉本该续写的场景。
- **C12** 出范围端点：Chat Completions 默认缓冲开但 terminal-only（`chatCompletionsBufferedRetry: true`，无 `commitBoundaries`）；Gemini 纯 live（`gemini/handler-v4.ts:438,638` 只调 `runResponseSink`）。

## 3. 公理与判据（评审须按此裁判，勿套 ROI/YAGNI）

- **A1 block-level 是本项目交付形状公理**（用户 2026-08-02 裁决）：绝不提供逐 token 流式体验；response-level 仅作实验选项；与之冲突的设计/代码/文档**摧毁而非并存**。评审不得以「保住流式体验」为由否决块级方案。
- **A2 无向后兼容负担**（CLAUDE.md）：破坏性改动是长远正确形状时强制迁移旧→新，允许短期报错，不留双轨。
- **A3 长远正确 + 完整优先于最小可交付**：不得以 ROI / 影响面 / YAGNI 为由把正确的重写降级为「可选/以后」；确要暂缓须完整文档化进 `docs/todo/`。
- **A4 richest-data-flow**：注入真实流的合成帧必打可辨识标记；后端存储完整。

## 4. 设计

### 4.0 公理落地：摧毁 live 退路（范围内端点）

| 位置 | 现状 | 改为 |
|---|---|---|
| `anthropic.protect_streaming_generation` | `false`(默认,live) / `"on"` / `"tool_use_only"` | `anthropic.delivery: "block"`(默认) / `"response"`(实验)；`false` 与 `tool_use_only` 删除，config 兼容层 warn-once 强制迁移 |
| [messages/handler-v4.ts:1367](../../src/routes/messages/handler-v4.ts#L1367) live 分支 + `liveReconcilingSink` | 默认路径 | 删除 |
| `openai_responses.buffered_retry: false`（退回 live） | 可选 | 删除；[responses/handler-v4.ts:395](../../src/routes/responses/handler-v4.ts#L395) live 分支删除 |
| Responses-WS `commitBoundaries` 缺省（terminal-only） | 故意为之 | 升为块级 |

**推翻 WS terminal-only 的理由**：P4 Task 1 的论证是「块级提交会关掉重试窗口（`committedAny`），提交后掉线只能降级半截生成」。该论证的前提是**提交之后没有任何恢复腿**。本 spec 补齐情形 2/3 之后前提消失，故推翻。

### 4.1 情形 1 —— 未提交任何块 → 透明重试

机制已存在（`!committedAny && !retreated` 门）。Anthropic 打开块级后自动生效；Responses-HTTP 已有；WS 升块级不影响本腿。**零新机制**。

### 4.2 情形 2 —— 已提交完整可交互 tool_use → 静默终止（新实现）

替换 §2 C2 的 error 帧，合成干净终止符：

- Anthropic：`message_delta{stop_reason:"tool_use", stop_sequence:null, usage:<已累计>}` + `message_stop`
- Responses：`response.completed`（`output` 含已提交的 function_call item）

新增终态 `tool-boundary-terminated`（**不复用** `partial-degrade`，两者可观测上必须可分）。History entry 记为正常完成，合成帧打 synthetic marker（A4）。

**block-level 公理在此付费**：已提交前缀恒为完整块序列 ⇒ 不存在「半截块要闭合」的分支 ⇒ 合成终止符恒合法。

### 4.3 情形 3 —— 已提交、无完整 tool_use → 续写重试

Anthropic 已 landed，不动。**Responses 新增**：注册 continuation builder（C9 的 registry）+ `extractResponsesCommittedBlocks` + 三个格式钩子（`response.created` 去重、`output_item.added` 的 index remap、块起始判别）。驱动的 `for(;;)` 续写分支格式无关，不动。

### 4.4 预算按族分三档

| 族 | 现状 | 改为 |
|---|---|---|
| 流中断类（透明重试 + 续写，共享一个预算） | `buffered_retry.max_retries: 3` | **9** |
| 网络类（network-retry / server-error-retry / token-refresh） | 与协商类共用 `max_reactive_retries: 5` | **9** |
| 协商类（400-class：tool-field / cache-control / unsupported-beta / thinking 等） | 同上 5 | **5**（不变） |

实现：按 C8 的 `configKey` 给策略打族标签，把单一标量 `retry.max_reactive_retries` 拆成按族解析（旧键经 compat 层迁移）。

**必须联动**（否则 9 次预算被 C7 静默饿死）：`generationMaxTotalCandidates` 5 → 12、`generationMaxTotalDispatches` 16 → 32。

### 4.5 总时长预算 3600s

新配置 `retry.total_budget_sec: 3600`。

- **时钟**：请求进入代理起算的 wall clock。（取证注意：History 的 `offsetMs` 是 commit-relative，非同一时基。）
- **检查点**：**开新腿之前**（透明重试 / 续写 / 反应式重试各自 dispatch 前）。**不打断进行中的腿** —— 掐断正在流的腿是纯亏损。
- **超预算行为**：不再开新腿 → 落 §4.2 / §4.3 的优雅终止；若零提交（无内容可保）则照常返回错误。
- **per-attempt 超时不变**：`responseHeaderTimeout: 300` / `streamIdleTimeout: 300`。

**承重因果链（前提条件，勿藏）**：3600s 只在保活撑得住时才有意义。C10 的两层客户端边界一旦失效，总预算调多大都白搭 —— 长时间续写/重试期间必须持续产生 ping 与非-ping 事件。

### 4.6 观测

新终态与计数进 telemetry + History：重试次数 / 续写次数 / 终止原因 / 总耗时。`/api/status.protect_streaming.by_vendor` 的 counters bag 是开放 `Record`，加维度零版本 bump（见 skill `telemetry-architecture`）。

## 5. 自行拍板的点（用户可否决）

1. 超总预算且**零提交内容**时返回错误，而非继续等待。
2. 情形 2 不向客户端插入任何文字提示（用户要求「静默」）。
3. Chat Completions / Gemini 出本次范围，但块级化写进 `docs/todo/deferred-backlog.md`，不静默砍。

## 6. 已知未决 / 敞口

- **O1** C11 的 `server_tool_use` 归一问题未核实 —— 若 extractor 归一成 `tool_use`，情形 2 会误吞本该续写的场景。
- **O2** Responses 的「可交互 tool_use」等价物（`function_call` item）判别谓词尚未定义。
- **O3** WS 升块级后，`response.output_item.done` 作为提交边界与 WS 帧序的交互未验证。
- **O4** 总预算的检查点需要一个跨腿的统一时钟源；当前请求上下文是否已有可用起点未核实。
