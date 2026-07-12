# Spec：修复 CC→Responses 流式 usage 捕获（GHC usage 升级 fallout）

状态：**已实施并合并**（2026-07-12，隔离分支 `fix/cc-responses-streaming-usage`）· 归属：`docs/spec/` · 类型：bugfix。

关联：由 [2026-07-12-ghc-usage-details.md](2026-07-12-ghc-usage-details.md) 特性的**运行期验证**发现（本项目 `empirical-verification`）· `docs/DESIGN.md`「活的架构现状」openai-cc codec / via-responses 桥。

## 1. 背景与实证（Why）

GHC 升级了 usage 数据（见 ghc-usage-details spec）。运行期验证 fix-forward 时，对**经 CC→Responses 桥路由的模型**（gpt-5.x 等，`outboundEndpoint: /responses`）发流式 chat/completions，实测暴露**两个 live bug**（直连 CC + Gemini 腿不受影响）：

**探针矩阵**（实测 4141 History API）：

| 路径 | include_usage | 结果 |
|---|---|---|
| CC 直连（claude /chat） | 无/有 | ✅ usage 正确 |
| **CC→Responses 桥（gpt-5.x）** | 有 | ✗ **400**：`Invalid value: 'usage'` |
| **CC→Responses 桥（gpt-5.x）** | 无 | ✗ history usage **0/0** |

### Bug 1：`include:["usage"]` 被 GHC 拒（400）

`cc-to-responses.ts` 把 chat 的 `stream_options.include_usage` 翻译成 Responses 请求的 `include: ["usage"]`。**GHC usage 升级后 `"usage"` 不再是合法 `include` 值**（Responses API 报 `Invalid value: 'usage'. Supported values are: 'file_search_call.results', ...`），且 usage 现在**默认返回**在 `response.completed.usage`。→ 任何带 `include_usage` 的流式 chat（经 Responses 路由的模型）**直接 400 挂掉**。

### Bug 2：CC→Responses 流式 usage 丢成 0/0

`responses-to-cc-stream.ts` 的 `response.completed` 处理**把 usage chunk 门控在客户端的 `include_usage`** 上（`if (state.includeUsage && ...)`）。而 history/telemetry 记账累积的是**翻译后的 CC chunks**（chat handler `onRenderedFrame` → `accumulateOpenAIStreamEvent`），所以客户端没设 include_usage 时 → 翻译器不发 usage chunk → accumulator 收不到 → history 存 `input_tokens:0, output_tokens:0`。

**决定性对照**：直连 CC 路径（claude /chat，无 include_usage）**本就无条件**给客户端发 usage chunk（实测客户端流含 `"usage":{...}`）。所以「只在 include_usage 时发」的契约**直连路径早已不遵守**，只有 via-responses 桥在门控——这是不一致的历史包袱。

## 2. 修复（What）

根因一个（via-responses 桥把「客户端呈现」与「history 捕获」耦合、且发了被拒的 include），修复两处 + 清死码：

1. **移除 `include:["usage"]`**（`cc-to-responses.ts`）：GHC 拒绝且多余（usage 默认返回）。
2. **总是发 usage chunk**（`responses-to-cc-stream.ts`）：`response.completed` 携 usage 即发，不再门控 `includeUsage`——与直连 CC 一致，且让 history/telemetry 无条件捕获（richest-data-flow）。
3. **删死管线**：`StreamTranslatorState.includeUsage` 字段、`createStreamTranslator` 的 opts、codec 的 `includeUsageOf`（门控移除后全部无用、且命名误导）。

**非目标**：不动 `responses-to-cc-request.ts` 的 `buildStreamOptions`（那是反向 /v1/responses→CC 上游路径的 `stream_options.include_usage`，对 CC 上游合法）。不动 GHC 新 `copilot_usage` 帧的解析（`response.completed.usage` 已含 `input_tokens_details.cache_write_tokens` 等新字段，我们读对了位置——见 ghc-usage-details spec；`copilot_usage` 是冗余 sidecar，无需额外解析）。

## 3. 取舍（方案 X vs Y）

- **方案 X（采纳）**：via-responses 总是发 usage，与直连 CC 一致。简单、修 history、richest-data-flow。客户端即使没要也收到 usage chunk——但**直连 CC 已如此**，故一致非新增偏差。
- **方案 Y（未采纳）**：保留客户端门控、另走侧信道给 history 捕获 usage。更复杂、与直连 CC 不一致、且严格 OpenAI 合规的船早随直连 CC 开走了。

## 4. 测试

- 单元回归 `responses-to-cc-stream.unit.test.ts`：`response.completed` 带 usage → **总是**发 usage chunk（无需 include_usage）+ 携 `cache_write_tokens`。
- golden `chat-completions-v4.http.test.ts` via-responses 流式：客户端 SSE 现含 usage chunk（byte-lock 更新）。
- `cc-to-responses.unit.test.ts`：断言**不**再发 `include` 字段。

## 5. 运行期复验（待用户重启）

发一个经 Responses 路由的流式 chat（gpt-5.x，带/不带 include_usage），确认：① 不再 400；② history entry usage 非 0（`input_tokens`/`output_tokens` 匹配上游）。
