# RFC：通用入站×出站翻译矩阵（CC hub + 二维门控缝合）

日期：2026-07-11（v4，二维门控 + 反向补齐）
状态：草稿（待第四轮对抗 review → 零 FAIL/WARN → plan）
需求源：[spec](../spec/anthropic-via-openai-translation.md) ｜前置 ADR：[decideRoute 拆分](../decisions/2026-07-11-route-decision-separated-from-format-codec.md) + [全矩阵](../decisions/2026-07-11-universal-codec-translation-matrix.md)
review：[三轮记录](../spec/anthropic-via-openai-translation-review.md) ｜探针：[PROBE-FINDINGS](../../exp/anthropic-via-openai-translation/PROBE-FINDINGS.md)

## 0. 演化脉络
v1 gemini 镜像（3 FAIL 证伪）→ v2 缝合模型 → v3 全矩阵（反向格子暴露新 FAIL）→ **v4：二维门控轴贯穿 + 反向流式补齐 + hub 共享翻译层**（消解第三轮 FAIL-R/FAIL-Google/FAIL-A + 6 WARN）。

## 1. 事实基础（实测）
入站 4：anthropic/openai-cc/openai-responses/gemini。出站 3：`/v1/messages`(8)/`/chat/completions`(13)/`/responses`+ws(9)。openai-cc 是 hub，OpenAI 家族 6 格已通，anthropic 行孤岛。目标：补全 5 ❌，经 CC hub。

## 2. 目标/非目标
目标：① FormatCodec 纯化（decideRoute→router）；② 全 4×3 互通经 hub；③ reject 最终兜底。非目标：翻译路径 web_search 双跳；count_tokens 走上游。（删 spec §10「反向 YAGNI」。）

## 3. 架构：hub-and-spoke + 二维门控轴（v4 核心）

### 3.1 两个正交轴（消解 FAIL-R 的统一洞察）
每次请求由**两个正交轴**定型，不是单一 clientFormat：

| 轴 | 决定 | 门控的处理 |
|---|---|---|
| **clientFormat（入站）** | 面向客户端 | parse、**render 给客户端的帧**、**handler 心跳/anchor/sink**、客户端侧 formatError |
| **targetEndpoint（出站腿）** | 面向上游 wire | **请求改写链**、**策略栈/auto-truncate**、**prepareWire**、**上游帧 accumulate**、**上游截断保护** |

**关键**：现状把改写/策略按 `clientFormat` 门控（[request-rewrite-adapter.ts:60](../../src/lib/codec/anthropic/request-rewrite-adapter.ts#L60) `appliesTo=clientFormat==="anthropic"`）是**错配**——这些处理的是**上游 wire**，本应按 `targetEndpoint`。v4 改为按 targetEndpoint 门控，一举统一正反向：

| 腿 | clientFormat | targetEndpoint | 上游改写册（按 targetEndpoint）| render/心跳（按 clientFormat）|
|---|---|---|---|---|
| anthropic direct | anthropic | /v1/messages | **Anthropic 册** | Anthropic |
| anthropic→cc（正向翻译）| anthropic | /chat/completions | **CC 册**（不 fire Anthropic）| Anthropic |
| cc→messages（反向翻译）| openai-cc | /v1/messages | **Anthropic 册**（处理 Anthropic wire）| CC |
| cc direct | openai-cc | /chat/completions | CC 册 | CC |

这解释了 FAIL-R 正反向：正向翻译腿不该 fire Anthropic 上游改写（body 是 CC）；反向翻译腿**该** fire Anthropic 上游改写（wire 是 Anthropic）。**改写 appliesTo 轴：`clientFormat` → `targetEndpoint`。**

### 3.2 数据流
```
S1 parse (按 clientFormat)  → env{clientFormat, model, routeOverride, body(入站形)}
S2 router.decideRoute (自由函数，唯一读能力) → 设 env.targetEndpoint
S2 translateOut (按 targetEndpoint 经 hub 翻译到出站腿形)
S3 请求改写 (按 targetEndpoint 门控册)
S4 prepareWire (按 targetEndpoint，经 hub 共享层)
S5 响应改写 (按 targetEndpoint 门控册，作用上游帧)
S6 renderResponse (按 clientFormat：上游形→CC→入站形)
   handler 心跳/sink (按 clientFormat)
```

## 4. 接口契约

### 4.1 纯化 FormatCodec（去 decideRoute，方法按二维参数化）
```ts
interface FormatCodec {
  format: ClientFormat
  parse(raw): RequestEnvelope
  translateOut(env): RequestEnvelope        // 按 targetEndpoint 经 hub
  prepareWire(env): PreparedRequest          // 按 targetEndpoint 经 hub 共享层
  renderResponse(frame, env): ClientFrame[]  // 按 clientFormat（上游→CC→入站）
  createResponseAccumulator(env): ResponseAccumulator  // 按 targetEndpoint（上游腿形）
  formatError(err, env): ClientFrame
  getStreamMeta?(): StreamMeta               // 翻译：本方向 translator 自供
  flushResponse?(): ClientFrame[]
  sampleRequest?(wire, env): RequestSample
}
```
`ClientFormat` 不加成员，driver 按 clientFormat 单注入 codec，无 CodecKey/注册表（消解 FAIL-codec键）。

### 4.2 hub 共享翻译层（消解 W-prepareWire + W-gemini双委托）
**不让每个 codec 各自持子 codec**。抽 hub 共享层 `src/lib/pipeline/hub-translate.ts`：给定 `(sourceFormat, targetEndpoint, env)`，产出目标腿 wire + 反向 render。任意 codec 的 translateOut/prepareWire/renderResponse 委托 hub：
- anthropic codec → hub（targetEndpoint=cc/responses：Anthropic↔CC；=messages：identity）。
- gemini codec → hub（现状经 cc；+ messages 腿经 hub 的 CC↔Anthropic，**不需 gemini 自持 anthropic 子委托** → 消解 W-gemini双委托）。
- hub 内部持 CC↔Anthropic + CC↔Responses 翻译 primitive（现状 openai/translate/* + 新增 anthropic↔cc）。

### 4.3 router（自由函数，含 Google force-fallback）
```ts
decideRoute({clientFormat, modelName, routeOverride, model}): RouteDecision
```
决策树（force-fallback 移到 targetEndpoint 解析后统一拦截，FAIL-Google-2）：
```
1. 解析候选 targetEndpoint:
   routeOverride 显式(@cc/@responses/@messages)?
    ├─ 有 → isEndpointSupported(model,指定腿)? 是→指定腿 / 否→reject400(FAIL-3 gate)
    └─ 无 → 入站默认腿在 supported_endpoints? 是→默认腿
              / 否→按【每入站显式序】(W-priority)首个可达腿 / 无腿→reject400
2. 出站后处理(纯 targetEndpoint 轴,统一拦截,FAIL-Google-2):
   targetEndpoint==/responses 且 shouldForceChatCompletionsFallback(model)?
    → targetEndpoint=/chat/completions  ← 覆盖显式 @responses(Google /responses 坏腿是运营现实)
   [任何入站/后缀/auto 命中 Google /responses 坏腿都在此拦,不再 keyed on 入站默认腿]
3. kind = (targetEndpoint==入站默认腿 ? passthrough : translate)
```
- **FAIL-Google-2**：force-fallback 是纯出站属性（[fallback.ts:13-24](../../src/routes/responses/fallback.ts#L13)），在 targetEndpoint 解析**之后**统一拦截、与入站无关——符合 §3.1「出站按 targetEndpoint」。**覆盖显式 `@responses`**（坏腿运营现实），语义表记例外「force-vendor 优先于显式后缀」（N-force-override）。reduce 回现状：responses 入站默认 /responses、Google force→CC，与 [openai-responses/codec.ts:382](../../src/lib/codec/openai-responses/codec.ts#L382) 等价。
**每入站无后缀翻译序（W-priority，reduce 回现状）**：
- openai-cc：cc(passthrough) > responses(via) [= decideOpenAiCcRoute:355]
- openai-responses：responses(passthrough, 非Google) > cc(via/force) [= decideOpenAiResponsesRoute:381]
- gemini：cc(经hub) > responses(经hub) [现状委托 cc]
- anthropic：messages(passthrough) > cc > responses [新增]
router import：`supportsDirectAnthropicApi`+`isEndpointSupported`/`isResponsesSupported`+`shouldForceChatCompletionsFallback`([fallback.ts](../../src/routes/responses/fallback.ts))。

## 5. 配置解析（FAIL-1/W-b/W-c/N-@messages）
`resolveModelTarget(model):{name,routeOverride}`：入口先剥顶层后缀（覆盖客户端直发 W-c）+ `resolveOverrideTarget` 递归内每环剥（FAIL-1，modifier base 已 stripped）。后缀枚举 **3 值 `{cc,responses,messages}`**（大小写不敏感，N-@messages）。`resolveModelName=resolveModelTarget(_).name` 薄封装。`RequestEnvelope`/`preResolved` 加 `routeOverride?`（W-b 数据通路）。

## 6. web_search 前置步（FAIL-2/W-d）
前置步先 router.decideRoute，仅 `kind==="passthrough"` 进双跳；reject 先建 ctx 经 driver（不裸 throw）。

## 7. 缝合落地契约（v4 新节，消解 FAIL-R/FAIL-P/WARN-C）

### 7.1 改写/策略二维门控 + registry 全格式装配（FAIL-R + FAIL-P）

**门控轴（FAIL-R，四轮独立确认正确）**：6 个 Anthropic 改写全是**上游 Anthropic wire 处理**（reviewer 逐个核实：recover-tool-call/thinking-signature/tool-input-decode/server-tool-filter/recover-refusal 均在 driver `renderResponse` 前作用于上游原始帧；请求 sanitize 产上游 wire），无一客户端侧。故 appliesTo 轴 `clientFormat==="anthropic"` → **`targetEndpoint==="/v1/messages"`**。anthropic-direct 零回归（两条件恒同真）。CC 改写册 appliesTo 扩到 `targetEndpoint∈{cc,responses}`。

**registry 全格式装配（FAIL-P，门控轴必要不充分）**：现状改写 registry 是 **per-route 单格式注入**（`BUILTIN_*_REWRITES=[]` 空 [rewrite-registry.ts:144/187](../../src/lib/pipeline/rewrite-registry.ts#L144)；messages route 注 `ANTHROPIC_RESPONSE_REWRITES`、responses 注 `RESPONSES_RESPONSE_REWRITES`(fixStreamIds)、cc/gemini 不注）。**翻 appliesTo 轴对不在册里的改写无作用**——反向 cc→messages 走 cc route driver、册里没 Anthropic 改写；正向 anthropic→responses 走 messages driver、册里没 fixStreamIds。**修复**：改写/策略移到 **driver 按 targetEndpoint 装配的共享全格式 registry**（driver S3/S5 从 `{targetEndpoint→改写册}` 全格式表 assemble，不再 per-route 单格式注入）。这是独立于 §4.2 hub-codec 的第二套机制（rewrites/strategies 走 driver S3/S5 + deps.strategies，不经 codec 方法）。
- **策略供料（W-strategies-builder + W-truncate-baseline）**：`buildAnthropicStrategies` 需 `getResanitize()`/`getTruncateBaseline()`（格式专属）。翻译腿的 truncate 基线取 **translateOut 后的目标腿 env.body**（非 parse 捕获的入站基线，W-truncate-baseline 跨轴项）；反向腿走非-messages route 时 Anthropic strategy 的 resanitize/betaProbe 供料由**共享 registry 按 targetEndpoint 提供格式专属 builder**（W-strategies-builder），不依赖 route 自有 codec。
- **sampleRequest 轴（N-sampleRequest）**：按 targetEndpoint——翻译腿采 CC wire。
- **NIT-E**：thinking signature 硬约束在矩阵天然规避（翻译路径 thinking 翻译掉或上游无 thinking 输入，除 §9 红线）。文档点明。

### 7.2 心跳/reconcile 三方（WARN-C，NIT-H 订正）
anthropic 入站（含翻译腿）出站给客户端是 Anthropic SSE，**恒挂 `makeAnchoredSseSink`+Anthropic keepalive+delayed-commit+prelude**（[:446-463](../../src/routes/messages/handler-v4.ts#L446)，Claude Code 300s 断连）。翻译分支的 message_start 三方交互：
- prelude 合成 message_start（delayed-commit 期，[:883](../../src/routes/messages/handler-v4.ts#L883)）。
- translator W3 首帧 message_start（上游 CC 首帧到达，input_tokens:0 占位）。
- `makeReconcilingSink`（[:997](../../src/routes/messages/handler-v4.ts#L997)）drop **translator 产出**的 message_start（非上游帧——翻译分支上游无 Anthropic message_start）。reconcile 识别源改为 translator 输出。**Phase 4 byte-critical，golden 锁双 message_start 不出现。**
- 其它入站（cc/responses/gemini）→ messages 出站：客户端非 Claude Code，心跳用各自现状机制（cc/responses 无心跳）。

### 7.3 上游截断保护归属（WARN-D）
反向格子上游 Anthropic 腿复用 transport 通用保活（[http-transport.ts:57](../../src/lib/transport/http-transport.ts#L57) 4 格式共用 idle 保护）。**不对称文档化**：反向格子不享 anthropic 入站的 L2 buffered-retry 截断重试（CC-shaped）——反向上游 Anthropic 截断经 `getStreamMeta().finishReason` 未置位 → ctx.fail 无自动重试（可接受，L2 default off；需对齐是独立工作，记 OQ）。

## 8. 流式状态机（双向真设计，FAIL-A + WARN-B/C）

### 8.1 正向 CC→Anthropic（anthropic 入站翻译腿响应）
`cc-to-anthropic-stream.ts`：getStreamMeta/flushResponse **本 translator 自供**（不委托 cc，WARN-C）。多 choices 折叠（探针实测 cc 腿 text/tool 拆 choices[0]+[1]，**偏离** choices[0]-only）。W1 block-index 分配器（CC tool_calls[].index→Anthropic 单调 index，前导 text 则 tool#0 落 1）。W2 thinking-first（reasoning-aware 开块）。W3 message_start usage 占位。N1 event-line 全合成点经 `anthropicSseFrame`。
- **cc 腿 = 单跳**（上游 CC→cc-to-anthropic）；**responses 腿 = 二跳**（上游 Responses→responses-to-cc 现有→cc-to-anthropic），getStreamMeta 信号链在 responses 出站腿是「Responses翻译→CC帧→累积」（WARN-F 区分）。

### 8.2 反向 Anthropic→CC（FAIL-A，v4 骨架 + 完整帧集下沉 plan）
`anthropic-to-cc-stream.ts`（反向格子响应：上游 Anthropic SSE→CC，供 cc/responses/gemini render）。骨架：
- **block→choice 逆折叠**：Anthropic content_block（text/tool_use 带 index、增量协议）→ CC `choices[0].delta`。text delta→`delta.content`；tool_use（`content_block_start` id/name + `input_json_delta`）→`delta.tool_calls[{index,id,function}]`（index 按 block 序）；**`content_block_stop`→无 CC 对应，靠 `finish_reason:"tool_calls"` 收尾**（状态机核心转换）。
- **thinking/redacted_thinking 块 → 丢弃**（CC `hasThinking:false` [openai-cc/codec.ts:624](../../src/lib/codec/openai-cc/codec.ts#L624)）。**绝不反向合成**（§9 红线）。
- **message_delta → finish**：`stop_reason`→`finish_reason`；`usage`→CC usage chunk。**id**：`toolu_*`→CC `tool_calls[].id` 透传。
- **ping → swallow**；**error 帧 → CC error frame 映射**（OQ4 反向侧）。getStreamMeta 供 finish_reason 给反向 handler 截断检测。
- **完整帧集处理表下沉 plan（FAIL-A' 收口）**：反向 translator 是 byte-critical，plan Phase 5 任务须给**逐帧类型 → CC 映射/丢弃/swallow 的穷尽表**，锚定真实帧集 [stream-accumulator.ts:156-186](../../src/lib/anthropic/stream-accumulator.ts#L156)（顶层 message_start/content_block_start/delta/stop/message_delta/message_stop/ping/error）+ [:248-278](../../src/lib/anthropic/stream-accumulator.ts#L248)（block start 5 类：text/thinking/redacted_thinking/tool_use/**server_tool_use**）+ [:311-334](../../src/lib/anthropic/stream-accumulator.ts#L311)（delta 4 类：text/input_json/thinking/signature）。其中 **server_tool_use block（CC 无对应，剥离/降级）** + **content_block_stop→CC finish 状态转换**是主干、非边角。此表属 plan factory 锚点层（large-refactor §5：RFC 定契约、plan 穷举锚点），Phase 5 golden 逐帧验证。
- **Responses 入站→messages**：hub 二跳（Anthropic→CC→Responses render），复用 [responses codec 的 CCToResponses translator](../../src/lib/codec/openai-responses/codec.ts#L121)；**串联点在 hub 内部**（Anthropic→CC translator 出 CC 帧 → 喂 CC→Responses translator），非 responses codec renderResponse 内联（WARN-F 接线点）。

## 9. 翻译映射 + OQ3 + 反向红线（WARN-B/E）
- 请求两向：`anthropic-to-cc-request.ts`（正向）+ `cc-to-anthropic-request.ts`（反向）。继承 spec §6 + 多 choices。
- **OQ3**：cc 腿 claude=`toolu_*` 透传；responses 腿=`call_*`+加密 item id（丢弃无损，往返靠 call_id 与现有 via-responses 同构）。
- **WARN-E 反向硬约束审计清单（下沉 plan Phase 5，非只锁 thinking）**：反向请求侧合成 Anthropic wire 须逐项裁决——① **thinking 块**（已锁红线：绝不合成，signature 400/毒化）；② **tool_use.id 格式**（CC `call_*`→Anthropic `tool_use.id`，GHC 腿是否接受非 `toolu_*` 前缀须探针验证，skill `ghc-anthropic-upstream`）；③ **cache_control**（CC 客户端不带、反向不注入）；④ **server tools**（剥离）。清单逐项 oracle。
- **WARN-B 红线（OQ5，写死）**：**反向请求侧（cc/responses/gemini→messages）绝不合成 Anthropic thinking content block**——无有效 signature 必撞 GHC "cannot be modified" 400/毒化（skill `ghc-anthropic-upstream`）。客户端 reasoning 只经 `reasoning_effort` 参数传递或丢弃，不进 thinking 块。
- **OQ1**：非流式已测 best-effort；流式 reasoning 留 Phase 4 golden 实测。

## 10. History/可观测性（W6/W-reject-obs）
新字段 `clientRequest`/`model{}`(含 routeOverride+实际腿)/`attempts[].{effectiveSource,upstreamRequest,upstreamResponse}`/`clientResponse` + format 标签（区分翻译腿）。reject 经 ctx。

## 11. 降级矩阵（对称 + 反向红线）
正向 thinking→reasoning_effort/丢弃、cache_control/server tools 剥离、count_tokens 本地估算、content_filter→end_turn 标记。**反向（→messages）**：OpenAI 独有语义（responses 加密 reasoning）→**丢弃**（红线：不合成 thinking 块）；CC/gemini→Anthropic 的 tool/text 正常。

## 12. Cutover（commit invariants：每 commit 终态绿+全套件+现状矩阵逐字不变）
- **Phase 0**：FormatCodec 纯化（decideRoute→router，含 Google force-fallback 织入）。P0.1 建 router+搬 anthropic+golden 锁；P0.2 逐搬 cc/responses/gemini；P0.3 删接口方法+inspectRequest。**正向前提已核实**：5 decideRoute 对 codec 闭包纯。
- **Phase 1**：resolveModelTarget（FAIL-1+W-c 双层+3值）+ routeOverride 通路（W-b）+ router 全矩阵决策（force-fallback FAIL-Google + W-priority 每入站序 + web_search FAIL-2/W-d + cc-strict FAIL-3）+ **改写/策略二维门控切换（FAIL-R：appliesTo clientFormat→targetEndpoint）**+ reject 经 ctx。**invariant**：现状各格式默认腿零变（golden，含 Google force-fallback）。
- **Phase 2**：hub 共享翻译层（§4.2）+ Anthropic↔CC 请求翻译两向 + anthropic codec translateOut/prepareWire 委托 hub。
- **Phase 3**：非流式响应两向（CC→Anthropic + Anthropic→CC，含 §9 红线）。
- **Phase 4**：流式两向 translator（§8.1+§8.2）+ anthropic 入站 handler 缝合（§7.2 心跳/reconcile 三方）。最难 byte-critical，golden+独立 SDK oracle+流式 reasoning 实测。
- **Phase 5**：反向格子接线（cc/responses/gemini→messages：各 handler render 经 hub Anthropic→CC + 心跳保持入站格式 + §7.3 上游保护归属）。
- **Phase 6**：doc-sync（DESIGN.md 矩阵表+router+二维门控+配置语法）。
- DAG：Phase 0 前置阻塞全部；1(含二维门控)→2→3→4 串行 byte-critical；Phase 5 反向格子**除 gemini→messages（经 hub 无额外双委托，W-gemini 已消解）外**格式独立可并行；Phase 6 收尾。

## 13. 测试
Phase 0 golden：改前锁 4 端点 decideRoute 全场景（含 Google force-fallback）→router 逐字节等价。router 单测：全矩阵决策树（4入站×默认/翻译/reject + 3后缀 + FAIL-3严格 + W4 legacy + Google force）。改写门控单测：二维（clientFormat×targetEndpoint）每腿 fire 正确册。翻译两向单测：block↔choice 折叠/逆折叠 + 多 choices + 反向 thinking 丢弃红线。流式 golden 两向 + 独立 Anthropic SDK oracle + @responses 四跳 + gemini→messages 最长链 oracle（N-gemini-messages-oracle）。截断：翻译流缺 finish→ctx.fail。隔离 DI/fetch-mock。

## 14. OQ
OQ1（流式 reasoning，Phase4）｜OQ2（reasoning_effort 档，Phase2）｜OQ3（已裁决）｜OQ4（错误透传两路）｜OQ5（反向降级=丢弃 thinking 红线已定，余细节 Phase5）｜**OQ6（反向 L2 截断重试对齐，独立工作，WARN-D）**。

## 15. 范围外
翻译路径 web_search 双跳；count_tokens 走上游。

## 16. Review 对照（四轮）
一轮 F1/F2/FAIL-1/2/3/W1-6→§7/§8/§5/§4/§10｜二轮 FAIL-心跳/codec键/翻译在parse→§7.2/§3/§4｜WARN-B/C/D/W-a/b/c/d→§8/§5/§3/§6｜三轮 FAIL-R→§3.1+§7.1 二维门控｜FAIL-Google→§4.3 force-fallback｜FAIL-A→§8.2 反向流式｜WARN-B→§9 红线｜WARN-C→§7.2 reconcile 三方｜WARN-D→§7.3｜W-prepareWire+W-gemini→§4.2 hub 共享层｜W-priority→§4.3 每入站序｜N-@messages/N-acc-sig/N-gemini-oracle/NIT-E→§5/§4.1/§13/§7.1
**四轮**（架构层四轮共识稳固，剩余落地完整性）：FAIL-P（registry per-route 单格式）→§7.1 全格式装配｜FAIL-Google-2（force-fallback 钉入站轴）→§4.3 移 targetEndpoint 解析后统一拦截｜W-truncate-baseline/W-strategies-builder→§7.1 供料按 targetEndpoint｜W-gemini-hub-composition→§4.2+§8.2 hub 内串两段有状态 translator｜W-mapper-format→§13 反向 tool-name oracle｜N-sampleRequest→§7.1｜**FAIL-A'（反向帧集 server_tool_use/content_block_stop/error/ping）+WARN-E（反向硬约束清单）+WARN-F（二跳接线点）→ 骨架在 §8.2/§9，逐帧穷举表 + 硬约束逐项 oracle 明确下沉 plan factory 锚点层**（large-refactor §5：RFC 定契约、plan 穷举锚点）。
