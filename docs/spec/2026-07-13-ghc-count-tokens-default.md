# Spec：GHC 上游 `/v1/messages/count_tokens` 作为默认渠道

- 状态：草案（待 subagent 评审）
- 日期：2026-07-13
- 归属路线图：`docs/DESIGN.md` 活的架构现状（Anthropic 路径 / count_tokens 行）
- 实测依据：`exp/ghc-count-tokens-probe/CONCLUSIONS.md`

## 1. 目标与动机（What / Why）

让本代理暴露的 Anthropic `/v1/messages/count_tokens` 端点，**默认把 token 计数转发给 GHC 上游的 `/v1/messages/count_tokens`**，而不是当前的「Claude 模型 + 独立 `ANTHROPIC_API_KEY` → 直连 `api.anthropic.com`，否则本地估算」。

动机（实测支撑）：

1. **无需独立 key**：GHC count_tokens 用现成的 copilot token（`copilot-integration-id: vscode-chat` 那套 header）即可，不再依赖 `ANTHROPIC_API_KEY`。
2. **对本代理更准**：真实补全请求也经 GHC `/v1/messages`。GHC count 反映「经 GHC 这条腿会消耗多少」，比 canonical `api.anthropic.com` 的 count 更贴近真实消耗。
3. **跨厂商可用**：GHC count_tokens 支持目录内的 Claude / Gemini / 部分 GPT 模型（非仅 Claude）。

## 2. 实测事实（冻结的裁决依据）

- 端点存在：`POST https://api.githubcopilot.com/v1/messages/count_tokens` → `{"input_tokens": N}`，HTTP 200。
- **支持边界 = 该账号 live `/models` 目录**（3 轮确定性）：目录内模型 200；目录外模型（gpt-5 / o3 / grok / gemini-2.0 / claude-3.5）返回 HTTP 400 `model_not_supported`。判据信号即 `state.modelIndex`。**注意**：这是「不在目录 ⟹ 400」的单向蕴含，**不**等价于「在目录 ⟹ 不 400」——目录内的非-`/v1/messages` 模型（如 embedding，`modelIndex` 不按 endpoint 过滤）仍会 400。故 §5 的门用 `isEndpointSupported(..., MESSAGES)` 收紧，非仅 `modelIndex.has`。
- **完全容忍真实 wire**：`stream:true` / `max_tokens` / `thinking` / `context_management` / `tool_choice` / feature beta header（`interleaved-thinking` / `context-management` 等）全部 200 —— **无需裁字段**。
- body 宽松：inline `role:"system"`、top-level `system` 数组、`tools`、`cache_control` 全接受（不像 canonical Anthropic 会拒 `role:"system"`）。
- 模型名点号（`claude-opus-4.6`）与横杠（`claude-opus-4-6`）都接受。

## 3. 范围（In / Out）

**In**：

- 仅本代理的 Anthropic `/v1/messages/count_tokens` 端点（`src/routes/messages/count-tokens.ts`）。
- 架构缝：把 Anthropic「上游 HTTP 调用」从 wire 准备中分离出独立传输原语，供补全路径与 count_tokens 共用。
- 退役 `api.anthropic.com` 直连计数路径（`countTokensViaAnthropic`）。

**Out（本轮不做，记入 backlog）**：

- **Gemini `countTokens`**：Gemini 客户端请求是 Gemini 格式、经 `convertGeminiRequestToOpenAI` 翻译到 CC、走 `/chat/completions`|`/responses`，**不经 Anthropic `/v1/messages`**。借用 Anthropic 形状的 GHC count 需额外 Gemini→Anthropic 翻译。用户裁决：Gemini 不走 Anthropic 格式就不借此接口，维持本地估算。
- OpenAI 系无标准计数端点，无涉及。

## 4. 架构：分离「管线（wire 准备）」与「上游调用（传输）」

### 4.0 活路径与遗留路径的现状（澄清）

活的补全路径是 **v4 codec+driver**：`src/lib/codec/anthropic/codec.ts` 的 `prepareWire`（L531）调 `prepareAnthropicRequest` 产出 wire，传输交 `createUpstreamHttpTransport`（`send.ts`，其 `endpointPath` 已是参数）。v4 **本就已经分离** wire 准备与上游调用。`codec.ts:526` 注释自证：「Idempotent（RFC §3）：`prepareAnthropicRequest` deep-clones and does not write [negotiation]」——独立佐证 §4.1 的无副作用断言。

`src/lib/anthropic/client.ts` 的 `createAnthropicMessages` 是**遗留直连路径**（仍被 web_search 双跳 orchestrator 与 `pipeline.ts` 的 buildAnthropicAdapter 使用），其内部把 wire 准备与上游传输耦在一起。本轮抽取的传输原语在**遗留 client 与 count_tokens 之间**共享（不触碰 v4 driver）。

### 4.1 现状耦合（遗留 `createAnthropicMessages`）

1. **wire 准备**（已是独立纯函数）：`prepareAnthropicRequest(payload, opts)` → `{ wire, headers }`。对 negotiation cache **只读**（写仅在 `learnEffortsFromError`，只被 `effort-learning-retry.ts` 调用，非 prepare 链路），入参 payload 经 `buildWirePayload` 的 `structuredClone`（DEEP_CLONE_FIELDS）保护不被 mutate，故复用无副作用。**已由评审核实成立。**
2. **上游传输**：`upstreamFetch(${copilotBaseUrl}/v1/messages, { body, headers, signal })`，含 shutdown-abort → 529 包装（client.ts:129-152）。

### 4.2 抽取传输原语

新增一个薄传输函数（拟置于 `src/lib/anthropic/client.ts` 或新 `src/lib/anthropic/upstream-post.ts`）：

```ts
postAnthropicUpstream(args: {
  path: string            // "/v1/messages" | "/v1/messages/count_tokens"
  wire: Record<string, unknown>
  headers: Record<string, string>
  model: string
  signal?: AbortSignal
}): Promise<Response>
```

职责：`upstreamFetch(${copilotBaseUrl(state)}${path}, {...})` + 现有 shutdown-abort→529（`HTTPError(529, overloaded_error)`）包装。**只做传输**，不解析 body、不判断 `response.ok`（交调用方）。

- `createAnthropicMessages`（遗留直连 + web_search + pipeline-adapter）：改为 `prepareAnthropicRequest` → `postAnthropicUpstream({ path: "/v1/messages", ... })` → 现有 `response.ok`/流式/非流式处理。**行为逐字节不变**（golden 对照，`tests/anthropic/anthropic-client.it.test.ts` 已覆盖 happy/stream/400/529-shutdown，见 §7）。留在调用方的职责（`headersCapture`、`opts.onPrepared`、`!response.ok`+`diagnostics`、`combineAbortSignals`、流/非流解析）**不**并入原语。
- count_tokens：`prepareAnthropicRequest` → `postAnthropicUpstream({ path: "/v1/messages/count_tokens", ... })` → 解析 `{ input_tokens }`。

## 5. count_tokens 新流程（`handleCountTokens`）

按序（早退优先）：

1. 解析 payload；`resolveModelName` 归一模型名。
2. `selectedModel = state.modelIndex.get(model)`。
3. **auto-truncate 膨胀检查（保留、上移到最前）**：`state.autoTruncate && selectedModel && hasKnownLimits(id)` 且 `checkNeedsCompactionAnthropic(...).needed` → 返回膨胀值 `floor(contextWindow * 0.95)`（触发客户端 compaction）。此步不依赖精确 count，命中即早退，省一次注定要膨胀的上游往返。
   - **行为变化注记（非纯「保留」）**：旧码对「Claude + `ANTHROPIC_API_KEY` + 超限」请求先返回精确 Anthropic count（`count-tokens.ts:113`），永远到不了被遮蔽的膨胀检查（L125）。上移后此类请求现在也返回膨胀值触发 compaction——这是更正确的行为（compaction 应与计数渠道无关），且该 key 路径本轮退役，实际影响很小。
4. **模型缺失早退**：`selectedModel` 不存在 → `return { input_tokens: 1 }`（对齐现 handler `count-tokens.ts:118` 的守卫位置，**必须先于** step 6 的本地兜底——`countTotalInputTokens(payload, model)` 要求 `model: Model` 非 undefined，否则抛错被顶层 catch 吞成 error 日志）。
5. **GHC 计数（新默认）**：仅当 `selectedModel && isEndpointSupported(selectedModel, ENDPOINT.MESSAGES)`（复用 `src/lib/models/endpoint.ts:44` 现成原语——排除目录内但非 `/v1/messages` 的模型如 embedding，否则会被 POST 到 count_tokens 上游、几乎必然 GHC 400 + 每次 warn）：
   - `clientAnthropicBeta = c.req.raw.headers.get("anthropic-beta") ?? undefined`；`clientRequestHeaders = Object.fromEntries(c.req.raw.headers.entries())`（**与补全路径 `codec.ts:491-492` 逐字对齐**，别用具名单头取法，否则 passthrough 头集发散、破坏「count wire 与补全同源」）。
   - `{ wire, headers } = prepareAnthropicRequest(payload, { resolvedModel: selectedModel, clientAnthropicBeta, clientRequestHeaders })`。
   - `res = postAnthropicUpstream({ path: "/v1/messages/count_tokens", wire, headers, model, signal: createResponseHeaderTimeoutSignal(model) })`。
   - `res.ok` → `return { input_tokens: (await res.json()).input_tokens }`，log `[count_tokens] N tokens (GHC upstream)`。
   - 非 200 / 抛错 → `consola.warn` 后 **fall through 本地**（never-throw，退化不阻塞）。
6. **本地兜底**：`countTotalInputTokens(payload, selectedModel)`（现有 tiktoken 估算，也用于目录外 / 非-messages 模型；此处 `selectedModel` 必非空，由 step 4 早退保证）。
7. 顶层 `catch` → `{ input_tokens: 1 }`（现状）。

**observability 立场（精化）**：count_tokens 仍**不建 RequestContext、不进 history / telemetry / calibration / WS**（污染立场不变——`SYNTHETIC_PATHS` 豁免照旧）。但终态**渲染为请求样式行**而非 `[INFO]` syslog 行：经 display-only 事件 `system.request_line`（携与真实 `request.completed` 同款 `LogLineParts`）只到显示 sink（TerminalUi stdout + FileSink），永不触达 history/telemetry。发布走 `setRequestLinePublisher` DI（同 `setShutdownPublisher` 模式）。样式：`[ OK ] HH:MM:SS 200 POST /v1/messages/count_tokens <model> <dur>ms ↑N ↓0 (<channel>)`，channel ∈ {GHC upstream, local est …, inflated …, unknown model}。

**shutdown 期间**：step 5 的 `signal` 不折入 `getShutdownSignal()`（与现 `count-tokens.ts:68` 一致）——shutdown 时 count 调用跑到 timeout 后走本地兜底，对 out-of-observability 的 best-effort count 可接受。

## 6. 退役 `api.anthropic.com` 直连 + config 处理

- 删除 `countTokensViaAnthropic`、`getAnthropicApiKey`（count-tokens.ts 内）及其对 `state.anthropicApiKey` / `ANTHROPIC_API_KEY` 的读取。
- 连带删除 canonical 端点专属的激进 system sanitize（`sanitizeInlineSystemMessages` / `stripSystemAttribution` 在本文件的用途）——GHC 宽松且我们改送真实 wire。
- **config 键 `anthropic.api_key` → `state.anthropicApiKey`**：评审已核实**除 count_tokens 外无其它运行时消费者**（其余均为 schema / config-映射 / state-默认+快照 / 敏感键脱敏）。按项目 config-philosophy（配置留兼容、警告并继续，**不**享代码的「无向后兼容负担」）：
  - 保留 config 解析与 state 字段，**不硬删**（避免既有 config.yaml 加载报未知键）。
  - 加载时若检测到 `anthropic.api_key` 非空，`consola.warn` 一条弃用提示：「`anthropic.api_key` 不再用于 count_tokens（已改走 GHC 上游），可移除」。
  - **同时覆盖环境变量**：旧码 `getAnthropicApiKey` 也读 `process.env.ANTHROPIC_API_KEY`（Anthropic 标准变量、极常见）。这些用户会静默从「精确 Anthropic count」切到「GHC count」——启动期若检测到 `process.env.ANTHROPIC_API_KEY` 且 config 未设，也 `warn` 一条同类提示，并在 CHANGELOG 注明此静默行为变化。
  - 保持 `SENSITIVE_CONFIG_KEYS` 脱敏不变。
  - （若评审认为该键确无其它任何潜在消费者、可彻底移除，作为 backlog 项单独提，不在本轮 fail-fast 删除。）

## 7. 测试与验收（TDD）

**单元 / 集成**（后端，遵循 test-isolation）：

1. **传输原语抽取等价**：`createAnthropicMessages` 改用 `postAnthropicUpstream` 后，对同一 payload 产生的上游请求 URL / method / headers / body 与改动前逐字节一致（golden fixture 预捕获旧行为 → 改后对照）。含 shutdown-abort→529 分支保持。
2. **GHC 计数 happy path**：mock 上游 `/v1/messages/count_tokens` 返回 `{input_tokens:123}` → 端点返回 `{input_tokens:123}`；断言上游收到的 body = `prepareAnthropicRequest` 的 wire（features/cache_control 在场）。
3. **目录内非-messages 模型不打上游**：`model` 在 `modelIndex` 但 `isEndpointSupported(..., MESSAGES)===false`（如 embedding）→ 不发上游请求（mock 断言 0 调用）→ 走本地估算。
4. **目录外模型不打上游**：`model` 不在 `modelIndex` → 不发上游请求（mock 断言 0 调用）→ 走本地估算（经 step 4 早退返回或 selectedModel 存在时的本地兜底）。
5. **上游非 200 兜底**：mock 返回 400 → warn + 本地估算返回（不抛）。
6. **上游抛错兜底**：mock reject → 本地估算返回。
7. **auto-truncate 膨胀早退**：超限 payload + `autoTruncate` on → 返回膨胀值，且不打上游。
8. **模型缺失早退**：`selectedModel` 缺失 → `{input_tokens:1}`，不触达 `countTotalInputTokens`（避免 undefined model 抛错）。
9. **退役直连**：设 `ANTHROPIC_API_KEY` 也不再触达 `api.anthropic.com`（网络 guard 断言无该域请求）。
10. **stream:true wire 不误入流式**：payload 携 `stream:true` → count 路径仍解析 JSON body 返回 `input_tokens`（不进 `events()` 流式分支；GHC count_tokens 对 stream:true 返回 JSON 非 SSE）。
11. **config 弃用警告**：加载含 `anthropic.api_key`（或仅 `process.env.ANTHROPIC_API_KEY`）的配置 → 触发一次 warn，加载不失败。

**独立 oracle**：GHC wire 正确性以 mock 上游收到的 body 为准（独立于实现）；退役以 network guard 为独立 oracle。

**手动实测（用户可选）**：真实 4141 之外端口起测试实例，对 claude / 目录外模型跑 count_tokens，对照日志渠道标记。

## 8. 不做的事 / 风险

- 不改 observability 立场（count_tokens 仍在观测之外）。
- 不引入渠道优先级可配（YAGNI；用户已定 GHC 为唯一默认 + 本地兜底）。
- 风险：GHC count 与 canonical Anthropic count 数值可能不同——这是**期望行为**（对本代理更准），非缺陷。
- 风险：`modelIndex` 未就绪（token/模型未初始化）时 `selectedModel` 缺失 → 自然落本地兜底，安全。
