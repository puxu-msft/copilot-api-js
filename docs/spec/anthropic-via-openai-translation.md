# Spec：Anthropic endpoint 经路由后缀翻译到 OpenAI 协议腿（openai-anthropic codec）

状态：设计已批准，待 RFC 对抗 review + 分 phase 计划｜触发：用户配置 `model_overrides` 把 Anthropic 入站模型导向 OpenAI 协议腿（`opus: claude-opus-4.8@cc` / `claude-opus-4.8: gpt-5.5`）时当前一律 400 reject｜关联：`docs/DESIGN.md`「活的架构现状」、`src/lib/codec/openai-gemini/codec.ts`（精确镜像先例）、[[feedback-pass-null-clean-not-self-validating]]、[[reference-anthropic-sdk-drops-eventless-sse-frames]]

## 1. 背景与动机

### 1.1 当前行为

客户端打 Anthropic endpoint（`/v1/messages`）时，[codec/anthropic/codec.ts](../../src/lib/codec/anthropic/codec.ts) 的 `decideAnthropicRoute` 调 `supportsDirectAnthropicApi(id)`——[anthropic/features.ts:38](../../src/lib/anthropic/features.ts#L38) 一发现 `model.vendor !== "Anthropic"` 就返回 `{ supported: false }`，decideRoute 据此 `reject 400`。Anthropic codec 设计上是 **bypass-direct**（`translateOut`/`renderResponse` 全是 identity，上游就是 Anthropic Messages API），**没有任何翻译能力**。

于是两类用户配置当前都被拒：

1. `opus: claude-opus-4.8@cc`——希望 Claude 模型改走 OpenAI chat/completions 协议腿（后缀语法当前不存在，`@cc` 会被当成模型名一部分、解析失败）。
2. `claude-opus-4.8: gpt-5.5`——把一个模型映射到非 Anthropic vendor 模型，当前在 decideRoute 直接 400。

### 1.2 关键上游事实（来自 `refs/AVAILABLE_MODELS.json`，权威能力信息）

GHC 上游对模型暴露 `supported_endpoints`。关键发现：**Anthropic vendor 模型本身同时支持两条协议腿**：

```
claude-opus-4.8 : ["/v1/messages", "/chat/completions"]
claude-sonnet-4.6: ["/chat/completions", "/v1/messages"]
claude-haiku-4.5 : ["/chat/completions", "/v1/messages"]
```

OpenAI vendor 模型则各有侧重：

```
gpt-5.5 : ["/responses", "ws:/responses"]                       (无 chat/completions 腿)
gpt-5.4 : ["/responses", "/chat/completions", "ws:/responses"]  (两腿都有)
```

因此「Anthropic→OpenAI 翻译」**不是把 Claude 降级成 GPT**，而是「对同一个模型，改用 OpenAI 协议腿访问上游」——GHC 对 Claude 内置支持 chat/completions 腿，只是默认走 `/v1/messages`（direct bypass）。要切到 OpenAI 腿，需要一个**显式路由指令**或一个**重映射目标**。

### 1.3 目标

让 Anthropic endpoint 在以下两种情况下经协议翻译访问 OpenAI 协议腿，而非 reject：

- **显式后缀**：`model_overrides` value 写 `<name>@cc` 或 `<name>@responses`，强制该模型走指定协议腿（即使是支持 direct 的 Claude）。
- **隐式重映射**：`model_overrides` value 是一个**不能 direct** 的模型（非 Anthropic vendor，或无 `/v1/messages` 腿），自动按其 `supported_endpoints` 选 OpenAI 腿翻译。

`reject 400` 退化为**最终兜底**：仅当「既不能 direct，又找不到任何可翻译的 OpenAI 腿」时返回。

### 1.4 保真度策略（已定：优雅降级、尽力而为）

走 OpenAI 协议腿时，Anthropic 独有语义大多无对应物。处理原则是**优雅降级**：

- 核心保证 `messages` / `tools` / `tool_use` / `tool_result` / `image` 往返正确。
- `thinking` 块：请求侧映射 `reasoning_effort`（若上游模型支持）否则丢弃；响应侧上游 reasoning（若有）→ best-effort `thinking` block。
- `cache_control` 断点、native server tools（web_search 等）：**静默剥离**。
- 不为「全特性等价」付出不现实的努力（上游 OpenAI 腿本就没有这些能力）。

## 2. 配置语法

### 2.1 路由后缀

`model_overrides` 的 **value** 支持可选后缀 `@<route>`，`route ∈ { cc, responses }`：

```yaml
model_overrides:
  opus: "claude-opus-4.8@cc"            # Claude 强制走 chat/completions 腿
  sonnet: "claude-sonnet-4.6@responses" # Claude 强制走 responses 腿
  haiku: "gpt-5.5@responses"            # 非 Anthropic 模型，走 responses 腿
  claude-opus-4.8: "gpt-5.5"            # 无后缀重映射；gpt-5.5 不能 direct → 自动 responses
```

- `@cc` → chat/completions 腿（要求模型 `supported_endpoints` 含 `/chat/completions`，否则 reject）。
- `@responses` → responses 腿（要求含 `/responses`，否则 reject）。
- 无后缀 → 现状语义（能 direct 走 direct；不能 direct 但有 OpenAI 腿则自动翻译；都不行 reject）。

后缀语法亦适用于客户端直接在请求 `model` 字段写 `claude-opus-4.8@cc`——因为解析点统一在 resolver（见 §3），这是统一解析的自然结果，不额外设防。

### 2.2 语义对照

| 配置 | 解析结果 | 路由 |
|---|---|---|
| `opus: claude-opus-4.8@cc` | name=claude-opus-4.8, route=cc | translate → cc 腿（强制） |
| `sonnet: claude-sonnet-4.6@responses` | name=claude-sonnet-4.6, route=responses | translate → responses 腿（强制） |
| `claude-opus-4.8: gpt-5.5` | name=gpt-5.5, route=undefined | 不能 direct → 有 responses 腿 → translate（自动） |
| `opus: gpt-5.4` | name=gpt-5.4, route=undefined | 不能 direct → 有 cc+responses 腿 → translate cc（自动，cc 优先） |
| 客户端发 claude-opus-4.8，无 override | name=claude-opus-4.8, route=undefined | 能 direct → passthrough（现状） |
| `opus: claude-opus-4.8@responses` | name=claude-opus-4.8, route=responses | translate → responses 腿（Claude 强制走 responses） |
| `opus: 不存在模型` | name=不存在, route=undefined | 不能 direct + 无任何腿 → reject 400 |
| `opus: gpt-5.5@cc` | name=gpt-5.5, route=cc | gpt-5.5 无 cc 腿 → reject 400（显式指定不支持的腿） |

## 3. 解析位置（single-source 后缀解析）

### 3.1 约束

`@cc/@responses` 后缀来自 override **value**，而现有 [resolver.ts](../../src/lib/models/resolver.ts) 的 `resolveModelName(model): string`：

- 中途用 `state.modelIds.has(target)` 校验目标可用性——`claude-opus-4.8@cc` 不在 `modelIds`（只有 `claude-opus-4.8`），后缀必须在校验**之前**剥离。
- 返回 `string`，**装不下** route 信号，需要旁路通道。

### 3.2 设计

resolver 新增主解析函数：

```ts
export interface ModelTarget {
  /** Canonical model name (suffix stripped), used for modelIds 校验 + 上游选择 */
  name: string
  /** 显式路由指令（来自 @cc/@responses 后缀），无后缀为 undefined */
  routeOverride?: "cc" | "responses"
}

export function resolveModelTarget(model: string): ModelTarget
```

- 在 override value 进入 `resolveOverrideTarget` 的 `modelIds.has()` 校验**之前**剥离 `@<route>` 后缀，产出 canonical `name` + 旁路 `routeOverride`。
- 后缀剥离对**最终 resolve 出的 value** 生效（无论来自 override 链的哪一环），剥离规则：value 结尾匹配 `@cc` 或 `@responses`（大小写不敏感），其余形态的 `@xxx` 不识别（保留原样，让上游按未知模型 reject——避免误吞合法模型名里的 `@`）。
- `resolveModelName(model): string` 退化为 `resolveModelTarget(model).name` 的薄封装 → **现有所有调用方零改动**。
- 只有 messages route 改调 `resolveModelTarget` 取 `routeOverride`。

### 3.3 为何在 resolver（而非 route/codec）

后缀是 config（model_overrides value）的一部分，解析配置的唯一权威点是 resolver。在此剥离保证：① 任何调用方拿到的 `name` 都是干净 canonical（modelIds 校验、tool-name mapper、capability 名单匹配等全部不被 `@cc` 污染）；② 后缀解析逻辑只有一处，不散落到 route。

## 4. 路由分层（decideRoute 兜底语义）

messages route 在模型解析后，据 `{ name, routeOverride }` 选 codec：

```
resolveModelTarget(clientModel) → { name, routeOverride }

routeOverride 显式 @cc / @responses?
 ├─ 有 → name 的 supported_endpoints 含指定腿?
 │        ├─ 是 → createOpenAiAnthropicCodec(name, routeOverride)   [translate, 强制该腿]
 │        └─ 否 → reject 400   (显式指定了不支持的腿)
 └─ 无 → supportsDirectAnthropicApi(name)?  (Anthropic vendor + /v1/messages)
          ├─ 是 → createAnthropicCodec                              [direct passthrough, 现状零改动]
          └─ 否 → name 存在 且 有 OpenAI 腿(/chat/completions ∪ /responses)?
                   ├─ 是 → createOpenAiAnthropicCodec(name, undefined)  [translate, 自动选腿]
                   └─ 否 → reject 400   (兜底, 唯一最终 reject 出口)
```

- **direct 优先**：无后缀且能 direct 的 Claude 仍走现状 bypass-direct，零行为变更。
- **后缀覆盖 direct**：`claude-opus-4.8@cc` 即使能 direct，也因显式后缀走翻译（用户意图优先）。
- **后缀严格**：`@cc/@responses` 指定的腿模型不支持即 reject，不静默 fallback 另一条腿。
- **无后缀自动**：不能 direct 时按 `supported_endpoints` 自动选腿，**cc 优先**（模型同时有 cc+responses 则走 cc），复用 openai-cc codec 既有「cc passthrough 优先、无 cc 腿才 via-responses→responses」默认优先级。

### 4.1 codec 内对应

`createOpenAiAnthropicCodec(name, route)` 的 `decideRoute`：

- `route === undefined`（无后缀自动）→ 完全委托内部 openai-cc codec 的 `decideRoute`（它按 `supported_endpoints` 自动 cc passthrough 或 via-responses translate）。
- `route === "cc"` → 委托 cc codec（cc passthrough；若内部判定无 cc 腿应已在 §4 route 层被 reject，不会到此）。
- `route === "responses"` → **覆盖** cc codec 默认，强制返回 `{ kind: "translate", to: ENDPOINT.RESPONSES }`（即使模型也有 cc 腿，用户显式要 responses）。

route 层已做 `supported_endpoints` 校验（§4），故 codec 内 decideRoute 不会遇到「指定腿不存在」——但 codec 仍按 route 显式构造，不依赖 route 层校验作为唯一防线（防御性，便于 codec 独立测试）。

## 5. 新 codec：openai-anthropic（方案 A，Gemini 精确镜像）

新目录 **`src/lib/codec/openai-anthropic/`**，命名与 `openai-gemini` 完全对称：前缀 `openai-` = OpenAI 家族上游内核，后缀 = 客户端入站格式。codec 家族读起来一致：

- `anthropic` = direct Anthropic 上游（现状，bypass-direct）
- `openai-cc` / `openai-responses` / `openai-gemini` / **`openai-anthropic`**（新）= OpenAI 内核 + 各客户端格式

### 5.1 结构（逐一对应 `createOpenAiGeminiCodec`）

参照 [openai-gemini/codec.ts:122-210](../../src/lib/codec/openai-gemini/codec.ts#L122)，`createOpenAiAnthropicCodec(modelId, route)` 持：

- 内部委托 `cc: OpenAiCcCodec = createOpenAiCcCodec()`——驱动 CC-payload 的 S2–S6（路由含 via-responses、wire prep、响应 normalize、采样）。调它的方法但**不调它的 parse**（这些方法纯over `env` + 它自己 lazy 的 via-responses 翻译器闭包，可独立工作）。
- per-request `anthropicTranslator = createCcToAnthropicStreamTranslator(...)`——CC 帧 → Anthropic SSE 帧的状态机（§7.2）。
- Anthropic 风格 `requestContext`（endpoint `anthropic-messages`、original 存 Anthropic 原始快照）+ auto-truncate baseline。

| FormatCodec 方法 | openai-anthropic 实现 |
|---|---|
| `parse` | Anthropic→CC 翻译 + Anthropic ctx（**不委托**——ctx 形状/endpoint 与 CC 不同，镜像 Gemini parse 不委托）|
| `decideRoute` | 按 `route` 委托/覆盖 cc（§4.1）|
| `translateOut` | `cc.translateOut(env)` |
| `prepareWire` | `cc.prepareWire(env)` |
| `renderResponse` | `cc.renderResponse(frame, env)` 得 CC 帧 → `anthropicTranslator.renderFrame` 逐帧出 Anthropic SSE |
| `flushResponse` | `anthropicTranslator.flush()`（drain `message_delta`+`message_stop`）|
| `getStreamMeta` | `anthropicTranslator.getMeta()`（终态 stop_reason/usage 出 driver 外）|
| `renderResponseNonStreaming` | `cc.renderResponseNonStreaming(...)` 得 CC 对象 → `convertCcResponseToAnthropic`（§7.1）|
| `createResponseAccumulator` | `cc.createResponseAccumulator()`（上游/normalize 后都是 CC，outbound 轨累积器是 CC 的）|
| `sampleRequest` | `cc.sampleRequest(wire, env)`（effective+wire 都是 CC 形；Anthropic 原貌在 setOriginalRequest）|
| `formatError` | Anthropic SSE error 帧（镜像 `formatAnthropicError`）|

### 5.2 owns-sink 契约

与 Gemini 一致，driver 的 `runResponseSink` owns-sink：driver 写 Anthropic 帧、采 forwarded、终态从 `getStreamMeta` 读。`renderResponse` 出 Anthropic 帧、`flushResponse` drain 流末、`getStreamMeta` 出终态。handler **不需要 onUpstreamFrame/onRenderedFrame**（翻译在 codec 内，镜像 Gemini「handler 不用 onRenderedFrame」）。

## 6. 请求翻译：Anthropic Messages → CC

复用方向类比 [gemini/convert-request.ts](../../src/lib/gemini/convert-request.ts)（Gemini→CC）。新建 Anthropic→CC 请求翻译器（建议位置 `src/lib/codec/openai-anthropic/` 内或 `src/lib/openai/translate/anthropic-to-cc-request.ts`，与 `responses-to-cc-request.ts` 对称，留 plan 定）。

| Anthropic Messages | CC |
|---|---|
| top-level `system`（string 或 block[]）| `messages[0] { role: "system", content }` |
| `messages[].content` text block | text content |
| `tool_use` block `{id,name,input}` | `tool_calls[] { id, type:"function", function:{name, arguments: JSON.stringify(input)} }` |
| `tool_result` block `{tool_use_id, content}` | `{ role:"tool", tool_call_id, content }` |
| `image` block（base64/url）| `content` 内 `{type:"image_url", image_url:{url}}` |
| `tools` | CC `tools[] {type:"function", function:{name, description, parameters}}` |
| `tool_choice` | CC `tool_choice`（`auto`/`any`→`required`/`{type:tool,name}`→`{type:function,function:{name}}`）|
| `thinking {type,budget_tokens}` | `reasoning_effort`（若模型 supports.reasoning_effort，按 budget 启发式映射档位）否则丢弃 |
| `max_tokens` | `max_tokens` / `max_completion_tokens`（按 cc codec 既有 O10 处理）|
| `stop_sequences` | `stop` |
| `cache_control` | **剥离** |
| native server tools（web_search/web_fetch/code_execution）| **剥离** |
| `metadata` | best-effort 透传或剥离 |

assistant turn 内 text+tool_use 混排 → CC `assistant` message 的 `content` + `tool_calls` 并存（CC 允许）。多个连续 tool_result → 多条 `role:tool` message。

## 7. 响应翻译：CC → Anthropic

### 7.1 非流式

CC `choices[0].message` → Anthropic `content[]`：

- `message.content`（string）→ `text` block。
- `message.tool_calls[]` → `tool_use` block（`function.arguments` JSON.parse 回 `input`；parse 失败保留 raw 或走既有 tool-input-repair 思路，留 plan）。
- `message.reasoning`（若有）→ best-effort `thinking` block（signature 省略或合成占位）。
- `finish_reason` → `stop_reason`：`stop`→`end_turn`、`tool_calls`→`tool_use`、`length`→`max_tokens`、`content_filter`→`end_turn`（或合适映射）。
- `usage` → Anthropic `usage {input_tokens, output_tokens}`。
- 顶层包 `{id, type:"message", role:"assistant", model, content, stop_reason, usage}`。

### 7.2 流式状态机（最大工作量）

结构模板抄 [gemini/convert-stream.ts](../../src/lib/gemini/convert-stream.ts) 的 `createGeminiStreamTranslator`（`renderFrame`/`flush`/`getMeta`）。CC SSE（`choices[0].delta`）→ Anthropic SSE 帧序列：

- 首帧：emit `message_start`（含 message 骨架 + 初始 usage）。
- 首个 text delta：emit `content_block_start`(index=0, type=text) + `content_block_delta`(text_delta)；后续 text delta 续 `content_block_delta`。
- 首个 tool_call delta：（若前面有 text 块）emit `content_block_stop` 关 text 块 → `content_block_start`(type=tool_use, id, name) + `input_json_delta`(partial arguments)；后续同 tool_call 续 `input_json_delta`；新 tool_call index 切块。
- 流末（`flush`）：关最后一个开着的块 `content_block_stop` → `message_delta`(stop_reason 映射 + usage) → `message_stop`。
- `getMeta` 暴露终态（stop_reason、usage）供 driver 外的 handler complete 分支读。

**反直觉契约（必守）**：所有合成 Anthropic SSE 帧必经 `anthropic/sse-frame.ts` 的 `anthropicSseFrame`（`event:` 行 = 帧 `type`）——纯 `data:` 帧（`event=null`）会被 Anthropic SDK（Claude Code）按 event 名分发时**静默丢弃**。见 [[reference-anthropic-sdk-drops-eventless-sse-frames]]，golden `assertEventLineInvariant` 守卫钉死。

### 7.3 截断检测一致性

走翻译路径的流式响应同样要参与 §流式截断检测（`docs/spec/upstream-stream-truncation-detection.md`）：translator 的 `getMeta` 须暴露「是否见到协议终止」（CC `finish_reason` 是否置位），handler complete 分支据此判完整性，缺终止符 → `ctx.fail`。

## 8. 降级矩阵（优雅降级、自动）

| Anthropic 特性 | 翻译路径行为 |
|---|---|
| thinking blocks / signature | 请求侧 → reasoning_effort（若支持）或丢弃；响应侧 reasoning → best-effort thinking block |
| native server tools（web_search 等）| 静默剥离；**web_search 双跳旁路不适用**（它仅 Anthropic-only、且 route 的 web_search 拦截在 direct 路径，翻译路径不触发）|
| cache_control 断点 | 静默剥离 |
| count_tokens | **保持本地 tokenizer 估算**（剥离后缀取 canonical name，不发上游、不翻译）|
| 既有 Anthropic 请求改写链（sanitize/recover/decode/filter/refusal）| **不适用**（那些是 direct Anthropic 上游的 wire/响应整形；翻译路径走 CC 链，由 openai-cc codec 的改写体系负责）|

## 9. History / 可观测性归属

- ctx endpoint = `anthropic-messages`（route 归属仍是 Anthropic 入站）。
- `inboundRequest` = 客户端 Anthropic 原始快照（`setOriginalRequest` 存 Anthropic 形）。
- `effective` / `wire` = 翻译后 CC payload（实际发上游的形态）。
- `inboundResponse` = 翻回客户端的 Anthropic SSE。
- 即同一条 history 记录里既看得到客户端的 Anthropic 原貌，也看得到实际发上游的 CC wire——richest-data-flow 完整，无裁剪。

## 10. 边界与 YAGNI

- **范围**：本期只实现 **Anthropic 入站** endpoint（`/v1/messages` + `/v1/messages/count_tokens`）的 `@cc/@responses` 后缀 + 无后缀重映射翻译。
- **不做**（YAGNI）：反向（OpenAI/Gemini 入站 endpoint 经 `@messages` 后缀走 direct Anthropic 腿）。后缀解析机制在 resolver 是通用的，但其他入站 endpoint 的后缀消费不在本期。
- **web_search 双跳**：翻译路径下不支持（server tools 剥离）。
- **count_tokens**：剥离后缀，保持本地 tokenizer 估算不变。

## 11. 测试策略

- **请求翻译单测**：Anthropic→CC 各 block 类型映射（text/tool_use/tool_result/image/system/tool_choice/thinking 降级/server-tool 剥离）。
- **响应翻译**：
  - 非流式 CC→Anthropic（含 tool_calls、finish_reason 映射、usage）。
  - 流式状态机 golden + **独立 Anthropic SDK oracle**（用真实 SDK 解析合成帧、验证可幸存——自洽 golden 抓不到 event-less 帧丢弃，须独立 oracle，见 [[feedback-pass-null-clean-not-self-validating]]、[[reference-anthropic-sdk-drops-eventless-sse-frames]]）。
- **往返**：Anthropic 请求 → CC wire → mock CC 上游响应 → CC → Anthropic 客户端帧，端到端形状正确。
- **路由分层**：`resolveModelTarget` 后缀解析单测（cc/responses/无后缀/`@xxx` 不识别）+ route 四分支（direct / 显式 cc / 显式 responses / 无后缀自动 / reject 各场景，对照 §2.2 表）。
- **降级矩阵**逐项。
- **截断检测**：翻译路径流式缺终止符 → ctx.fail（接入既有截断检测框架）。
- **隔离纪律**：DI/fetch-mock，不碰真实 $HOME；需 runtime 的测试用 `useIsolatedRuntime`。

## 12. 实现 Phase 划分（待 RFC + plan 细化）

按「基础→高级、每层都朝真正能用推进」：

- **Phase 1：解析 + 路由骨架**。`resolveModelTarget` + 后缀解析 + route 选 codec 分层 + reject 兜底语义。此阶段 openai-anthropic codec 可先只支持非流式，验证路由正确。commit invariant：现有 direct 路径零行为变更（golden 锁）。
- **Phase 2：请求翻译 Anthropic→CC** 全 block 类型 + 委托 cc codec 的 wire prep + 上游交互（cc/responses 两腿）。
- **Phase 3：非流式响应翻译 CC→Anthropic**。
- **Phase 4：流式响应翻译状态机**（最难，owns-sink + anthropicSseFrame 契约 + 截断检测接入）。
- **Phase 5：降级矩阵收口 + count_tokens 后缀剥离 + doc-sync**（DESIGN.md「活的架构现状」表加 openai-anthropic 行 + 运行时选项表 + 配置语法文档）。

每 phase 收尾 subagent 对抗 review（裁判轴：长远正确 + 完整，非 ROI/YAGNI）。

## 13. Open Questions

- **OQ1（thinking 响应侧保真）**：GHC 的 cc/responses 腿对 Claude 模型是否回传 reasoning 内容？以什么字段形态？→ Phase 3/4 用探针实测裁决（empirical-verification），决定 reasoning→thinking 映射的具体形态（含是否需要合成 signature）。当前默认 best-effort、不强造。
- **OQ2（reasoning_effort 档位映射）**：Anthropic `thinking.budget_tokens` → CC `reasoning_effort` 离散档位（low/medium/high/...）的启发式换算表，参照既有 `coerceAdaptiveThinking` 的 best_effort 换算逻辑复用。
- **OQ3（tool_use.id 格式）**：CC `tool_call.id`（`call_*`）↔ Anthropic `tool_use.id`（`toolu_*`）是否需要格式归一/还原（避免客户端下一轮回传时上游不认）。→ Phase 2/3 用 oracle 确认。
- **OQ4（错误透传）**：上游 CC 腿返回的 error（4xx/5xx）→ 经 cc codec 的 stream-error 映射 → 还须翻成 Anthropic error 帧/body 形态。复用 §5.1 formatError + 既有 `mapHttpErrorToEnvelope`，Phase 3/4 确认非流式与流式 POST-COMMIT 两路。
