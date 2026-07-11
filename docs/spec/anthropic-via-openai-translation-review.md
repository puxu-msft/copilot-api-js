# Review 报告：anthropic-via-openai-translation spec（第一轮对抗审查）

审查对象：[anthropic-via-openai-translation.md](anthropic-via-openai-translation.md)（状态原为「设计已批准，待 RFC 对抗 review + 分 phase 计划」）
审查方式：两个独立 subagent 并行对抗审查（翻译保真维度 + 路由/破坏性维度），裁判轴＝长远正确 + 完整（非 ROI/YAGNI）。
承重断言核实：主会话已亲自读引用的 `file:line` 独立核实所有 FAIL，标注 ✅=已核实属实。
结论：**NOT ready-to-plan**，需修订后进入第二轮 review。

---

## FAIL（实现前必修，5 条）

### F1 ✅ 翻译路径缺 handler，复用 `pumpAnthropicStreamingV4` 会全线崩坏（最严重）

spec §5.2 声称「handler 不需要动、镜像 Gemini」，但 Anthropic 端点 handler 硬编码假设上游是 Anthropic 形状：
- [handler-v4.ts:1075](../../src/routes/messages/handler-v4.ts#L1075) `accumulateAnthropicStreamEvent(parsed, acc)` 把 RAW 上游帧当 Anthropic 事件解析。翻译路径 RAW 上游是 **CC**（`choices[0].delta`）→ type 不匹配 → acc 永不填充；`sseEvents` 把 CC 帧误标 `keepalive`。
- [handler-v4.ts:1291](../../src/routes/messages/handler-v4.ts#L1291) 截断 + L2 缓冲重试提交门 = `acc.sawMessageStop`。CC 上游**永不发 message_stop** → 恒判截断 → 缓冲路径重试到 cap 失败、live 路径恒 FAIL。功能性全毁。
- [handler-v4.ts:626](../../src/routes/messages/handler-v4.ts#L626) 重试栈写死 `ReturnType<typeof createAnthropicCodec>`，喂 CC-delegating codec 类型不兼容 + 语义错误。

**关键**：真相是 Gemini 有**自己的 handler**（`gemini/handler-v4.ts`），spec 却没规约翻译路径用哪个 handler、§12 phase 也没排。**修复**：新增「翻译路径 handler」章节 + 一个 phase，镜像 `gemini/handler-v4.ts`（CC 累积器、基于 `getStreamMeta` 的截断检测、不挂 Anthropic strategies）。

### F2 ✅ 截断检测信号错位
§7.3 说 getMeta 暴露「CC finish_reason 是否置位」方向对，但 handler 完整性门读 Anthropic 累积器的 `sawMessageStop`（[handler-v4.ts:1291](../../src/routes/messages/handler-v4.ts#L1291)），而 codec 的 accumulator 是 CC 的；且 `flushResponse` 无条件合成 message_stop → 出站流永远带 message_stop，它在翻译路径根本不可能当截断信号。检测须改读 CC finish_reason，依赖 F1 新 handler。

### FAIL-1 ✅ 后缀剥离位置自相矛盾 + modifier 后缀击穿「结尾匹配」
§3.2 同时给两套互斥剥离位置（递归每环剥离 vs 最终 value 尾部剥离）。[resolver.ts:183-192](../../src/lib/models/resolver.ts#L183) modifier 重挂：`opus[1m]` + `opus:"claude-opus-4.8@cc"` → `withSuffix = resolvedBase + suffix` = `claude-opus-4.8@cc-1m`，`@cc` 埋进中间、尾部匹配失败 → 整串当未知模型 reject。**修复**：route 随 `ModelTarget` 在 `resolveOverrideTarget` 递归回传、modifier reattach 前 base 已 stripped。删「最终 resolve value / 结尾匹配」表述。

### FAIL-2 ✅ web_search 前置拦截与新路由层次序未定义
[handler-v4.ts:225-238](../../src/routes/messages/handler-v4.ts#L225) web_search 拦截是 driver 之前的无条件前置步，其 `supportsDirectAnthropicApi(resolvedName)` 不看 routeOverride：
- `opus:"claude-opus-4.8@cc"` + web_search → 判 direct=true → 走 direct 双跳，**@cc 被静默丢弃**。
- `claude-opus-4.8:"gpt-5.5"` + web_search → 判 direct=false → **throw 400**，而 §8 说翻译路径应剥离 server tools 继续。

§4 决策树完全没提 web_search 前置步。**修复**：§4 纳入 web_search 前置步——先算 route，仅 route==direct-passthrough 才进 web_search 双跳；否则剥离 server tools 走翻译。

### FAIL-3 ✅ §4.1「route==cc 委托 cc codec」无法严格 reject `gpt-5.5@cc`
[openai-cc/codec.ts:354-363](../../src/lib/codec/openai-cc/codec.ts#L354) `decideOpenAiCcRoute`：无 cc → `isResponsesSupported` → translate→RESPONSES（不 reject）。`gpt-5.5@cc` 委托 cc codec 会回退 responses，而 §2.2 要求 reject 400。cc-strict-reject 结构上只能落 route 层。**修复**：cc-strict-reject 归 route 层单点 gate，删 §4.1「防御性、不依赖 route 层」措辞（二选一：或 codec 对 route=="cc" 自实现严格 reject）。

---

## WARN（plan 阶段须定夺）

- **W1 ✅ content_block index 分配器欠规约**：CC tool_call `index`（0 基、独立）→ Anthropic 单调递增单一 index 空间的映射没定义（有前导 text 块时 tool#0 须落 index 1）。Gemini 无此负担（一帧一 call），是**无先例的全新工作**，off-by-one 源。plan 须定义 block-index 分配器 + golden。
- **W2 ✅ 流式状态机漏 thinking 块 + 只处理 text-then-tools 一种交错**：§7.1 非流式映射 reasoning→thinking，§7.2 流式完全不提 thinking；且 Anthropic 要求 thinking 块排最前。即便 OQ1 暂缓 reasoning 内容，开块逻辑须从一开始 reasoning-aware 否则错序。§7.1/§7.2 不一致须消解。
- **W3 ✅ message_start 初始 usage 无来源**：CC 首帧不带 usage（流末才给），Anthropic `message_start.usage.input_tokens` 是 Claude Code 会读的真字段 → 只能发 0/占位靠 message_delta 补正。须显式声明。
- **W4 ✅ routeOverride 腿校验 helper 未指定**：`isEndpointSupported(undefined,x)=true`（[endpoint.ts:47](../../src/lib/models/endpoint.ts#L47) legacy 默认放行）vs 严格 `.includes` 对 legacy 模型分叉。须明确选定 + 定义 legacy 语义。
- **W5 ✅ 复合翻译四跳保真损失未点明**：responses 腿模型实际链 Anthropic→CC→Responses→CC→Anthropic，多两个有损边界。tool_call id/reasoning 要活过四跳。须给 `@responses` 单独 oracle 门。
- **W6 ✅ §9 history 字段术语陈旧 + 缺 format/effectiveSource 标签**：字段已迁 `clientRequest`/`clientResponse`/`model{}`/`attempts[].{effectiveSource,upstreamRequest,upstreamResponse}`（merge `5db1aff6`），§9 仍用旧名 `inboundRequest/effective/wire/inboundResponse`。且须补 format 标签区分 cc 腿 vs via-responses 腿，否则 History/TUI 无法区分翻译路径 vs direct。
- **W-reject-obs ✅ route 层 reject 可观测性**：现状 unsupported reject 走 codec+driver 有 ctx/history；若新 route 层在 driver 前裸 throw HTTPError 则 ctx-less、无 history = 可观测性回归。reject 兜底应经 codec/ctx，不裸 throw。
- **W-toolid ✅ tool_use.id 往返（OQ3）须 plan 前定且双向对称**：若单向改写 `call_`↔`toolu_`，逆映射必须写进 §6 请求翻译，不能只在 §7 响应侧。

## NIT
- N1 event-line 契约 golden 应扫所有合成点（error/message_start/message_delta/message_stop），不止 content_block 帧。
- N2 count_tokens 客户端直发 `@cc` 后缀边角（现网无 `@` id，低风险）。
- N3 `content_filter→end_turn` 丢信息，考虑更诚实映射或记 feature 标记。
- N7/N8 「结尾匹配」误吞 + 不存在模型 routeOverride，实测风险极低（40 个 id 无 `@`），注明前提即可。

## 已独立核实为真、无需改（记录以免误删）
- §1.2 supported_endpoints 数据属实（`refs/AVAILABLE_MODELS.json`：`claude-opus-4.8:["/v1/messages","/chat/completions"]`）。
- §4 腿存在性校验有真实基建（`endpoint.ts` `isEndpointSupported`/`getModelEndpoints`）。
- §4.1/§5.1 委托 `cc.decideRoute` 成立（`decideOpenAiCcRoute` cc→via-responses→reject）。
- §4 无后缀 auto「cc 优先」复用成立。
- §10 count_tokens 薄封装剥后缀 + 丢 route 正确。
- `resolveModelName` 退化薄封装、13 处调用方无副作用依赖 → 零改动成立（**在 FAIL-1 修好的前提下**）。

---

## 处置建议（闭环顺序）
1. 修订 spec §3.2（route 穿递归、reattach 前 strip）、§4（并入 web_search 前置步 + reject 经 codec/ctx）、§4.1（cc-strict-reject 归属）。
2. 新增「翻译路径 handler」章节（镜像 gemini/handler-v4.ts）+ 并入 phase 划分（消解 F1/F2）。
3. 写实 §7.2 流式状态机（block-index 分配器 W1、thinking-first 顺序 W2、message_start usage W3）。
4. §9 用当前 history 字段名重写 + 补 format 标签（W6）。
5. 定夺 W4 腿校验 helper、W-toolid tool_use.id 往返方向。
6. 升格为 RFC（补 commit-level cutover + commit invariants），进入第二轮对抗 review。

## 用户决策记录（2026-07-11）

- **OQ1/OQ3 探针**：已授权 + 已实测，结论见 [exp/anthropic-via-openai-translation/PROBE-FINDINGS.md](../../exp/anthropic-via-openai-translation/PROBE-FINDINGS.md)。要点：cc 腿(claude) tool id = `toolu_*`（原样透传自洽）；responses 腿(gpt) = `call_*` + 加密 item id；非流式无 reasoning 内容（支持 best-effort 默认）；**新发现 cc 腿把 text/tool 拆两 choices**，状态机须处理多 choices。
- **W4 腿校验语义**：定为 **isEndpointSupported（放行到上游 reject）**——沿用全库惯用 helper，legacy 模型 `@cc` 放行到上游、对现网 40 个明确模型无差异。
- **FAIL-3 修复形态 → 已被更根本的架构决策取代（`record-not-adopted`）**：
  - 用户第一轮选「codec 自实现严格 reject」。
  - 随后用户提出「codec 应是纯 format codec、不应知道 upstream」并**撤回**该选择。
  - 最终决策：**彻底全局拆 `decideRoute` 到独立 router 层**（codec 纯化）——见 ADR [2026-07-11-route-decision-separated-from-format-codec.md](../decisions/2026-07-11-route-decision-separated-from-format-codec.md)。
  - 影响：FAIL-3 被**自动消解**（`gpt-5.5@cc` 严格 reject 天然归 router 层，codec 不再检查 upstream 腿）。这也把特性升级为「**架构重构（decideRoute 拆分，Phase 0 前置）+ 翻译特性**」两层工程。原 spec 的 §4.1「codec decideRoute 委托/覆盖」措辞须整体重写为「router 决策 + codec 纯翻译」。

---

## 第二轮对抗 review（针对 RFC，2026-07-11）

审查对象：[RFC](../rfc/2026-07-11-anthropic-via-openai-translation.md)。两个 agent 分别复审翻译/流式维度 + 路由/Phase0 维度，验证 RFC 是否消解第一轮问题 + 审新增 Phase 0。所有 FAIL 主会话已亲自读 file:line 核实（✅）。结论：**NOT ready-to-plan**，3 个新 FAIL。

### 已消解确认（两轮共识）
F1（handler 分离方向对）、F2（截断读 getStreamMeta.finishReason）、FAIL-1（后缀穿递归剥离锚点正确）、FAIL-3（cc-strict 归 router）、W4（isEndpointSupported 放行）、W6（history 新字段名）、W1/W2/W3/N1（已纳入 §8）。**正向发现**：5 个 decideRoute 均对 codec 闭包状态纯（ADR 前提成立）、driver 内 decideRoute 调用点 :144/:202 覆盖完整。

### 新 FAIL（RFC 须修）

**FAIL-心跳 ✅（翻译维度）**：翻译路径「镜像 gemini」遗漏整套 Anthropic keepalive 心跳。gemini handler [无心跳](../../src/routes/gemini/handler-v4.ts#L271)，但 Anthropic handler 有 `makeAnchoredSseSink`/`resolveBufferedAndHeartbeat`/`streamCommitAfterSec` 延迟提交窗口 + 合成 prelude（[handler-v4.ts:446-463](../../src/routes/messages/handler-v4.ts#L446)）——为 Claude Code 的 **300s no-real-content 断连**而生（skill `claude-code-connection`：`event: ping` 不算 chunk、须发空 content-delta）。本 RFC 核心用例是 reasoning 模型（pre-content 静默最长），镜像 gemini 会把 direct 路径修掉的长 thinking 断连事故重新引入。

**FAIL-codec键 ✅（路由维度）**：`ClientFormat`（[envelope.ts:18](../../src/lib/pipeline/envelope.ts#L18)）无 `"openai-anthropic"` 成员，RFC §4.2 `decision.codec: ClientFormat` 装不下决策（direct/translate 塌成同一 `"anthropic"`）；`DriverDeps.codec` 单数（[driver.ts:60](../../src/lib/pipeline/driver.ts#L60)），无 codec 注册表、控制反转无落地机制。

**FAIL-翻译在parse ✅（路由维度）**：spec §5.1 把 Anthropic→CC 翻译放 codec 的 `parse`，而 driver 先 parse（[driver.ts:141](../../src/lib/pipeline/driver.ts#L141)）后 route（:144），两种单 parse-codec 选择都破（direct 或 translate 二选一必坏）。

### 收敛洞察（决定 RFC 重写方向）
三个 FAIL 共同根因＝**把翻译路径建模成「gemini 镜像」是错的**。正确模型：**翻译路径 = Anthropic 入站语义（parse Anthropic ctx + handler Anthropic 心跳）+ CC 出站 wire（translateOut/render 翻译）的缝合**。现状 openai-cc codec 已是「一个 codec 按 `targetEndpoint` 参数化 passthrough/translate」的正确模式——`decision.codec` 控制反转不必要（FAIL-codec键 自消解）：codec 按 clientFormat 选（现状不变）、翻译由 `targetEndpoint` 参数化（driver [:152](../../src/lib/pipeline/driver.ts#L152) 已有机制）、翻译从 parse 归位到 translateOut（FAIL-翻译在parse 消解）、handler 挂 Anthropic 心跳而非镜像 gemini（FAIL-心跳 消解）。

### 新 WARN（plan 前收口）
- **WARN-B ✅（翻译）**：多 choices 分裂——RFC §8 要求处理多 choices，却又说抄 `gemini/convert-stream.ts`（`choices[0]`-only [:114](../../src/lib/codec/openai-cc/stream-accumulator.ts)）。须点明这是偏离 gemini 的新写。
- **WARN-C ✅（翻译）**：`getStreamMeta`/`flushResponse` 不可委托 cc codec（cc codec 无此方法），由 openai-anthropic 自建 translator 供给（对齐 gemini codec [:189](../../src/lib/codec/openai-gemini/codec.ts#L189)）。RFC §4.1 措辞须明确「翻译类方法委托 cc / 流终态由本 codec translator 自供」。
- **WARN-D ✅（翻译）**：OQ3 responses 腿往返论证不准确——加密 item id 从未到客户端、无「带回」；真正论证是「CC↔Responses 往返本就只依赖 call_id、与 direct via-responses 同构、丢加密 id 无害」。§9 措辞须改（`verifying-authoritative-claims`）。
- **W-a ✅（路由）**：router 是注入依赖 `deps.router` 还是模块自由函数，RFC §4.2 vs §13 自相矛盾。router 无状态只读 modelIndex → 自由函数更自然、零构造点改动。二选一统一。
- **W-b ✅（路由）**：`routeOverride` 从 route 穿到 driver-S2 的数据通路缺失——envelope/preResolved 无 `routeOverride` 字段，须新增线程化。
- **W-c ✅（路由）**：FAIL-1 剥离点只覆盖 `resolveOverrideTarget` 递归，漏「客户端直发 `@cc`」（无 override 时走 `resolveModelNameCore` 不经递归，spec §2.1 声称支持却会 reject）。须裁决：§2.1 改口 or 剥离点覆盖顶层。
- **W-d ✅（路由）**：web_search 前置步 reject 是 pre-ctx 裸 throw（[handler-v4.ts:234](../../src/routes/messages/handler-v4.ts#L234)），与 §10 W-reject-obs「reject 经 ctx」冲突，须先建 ctx。

### NIT
NIT-E（§13 补 `@responses` 四跳 oracle 门）、N-2（RFC §3/§4 顺带点名 router 的 import 面：supportsDirectAnthropicApi + isEndpointSupported + Google force-list）。

### 处置
按「收敛洞察」重写 RFC §4（去 decision.codec、targetEndpoint 参数化）、§5（翻译归位 translateOut、parse 纯解析）、§7（handler 挂 Anthropic 心跳、缝合模型非 gemini 镜像）+ 修 7 WARN，再进第三轮。**此方向推翻 spec §5「镜像 gemini 新建独立 codec」**——须用户确认。

---

## 第三轮对抗 review（针对 RFC v3 全矩阵，2026-07-11）

审查对象：[RFC v3](../rfc/2026-07-11-anthropic-via-openai-translation.md)（全矩阵重写）。两 agent 复审。所有 FAIL 主会话已亲自读 file:line 核实（✅）。结论：**NOT ready-to-plan**，全矩阵泛化暴露反向格子/二维贯穿新缺口。

### 上轮全消解确认（两 agent 共识）
第二轮 3 FAIL（心跳/codec键/翻译在parse）+ 7 WARN **全部真消解**。缝合模型（入站定心跳、出站定 wire、CC hub、targetEndpoint 参数化、router 自由函数）方向正确、机制可落地。

### 新 FAIL（v3 全矩阵引入，须修）
**FAIL-R ✅（路由，最重）**：Anthropic 改写链 + 策略栈按 `clientFormat` 门控（[request-rewrite-adapter.ts:60](../../src/lib/codec/anthropic/request-rewrite-adapter.ts#L60) `appliesTo=clientFormat==="anthropic"`；[response-rewrite-adapters.ts:96](../../src/lib/codec/anthropic/response-rewrite-adapters.ts#L96) `ANTHROPIC` 用于 5 处 appliesTo）。anthropic-direct 与 anthropic-translate 两腿 `clientFormat` 恒 `"anthropic"`、物理无法区分 → 翻译腿的 Anthropic 请求 sanitize/响应改写/auto-truncate 会误 fire 在 CC 形 body/帧上。§11「不适用」四字盖不住：须把 6 个 Anthropic 改写 appliesTo 收窄 `&& targetEndpoint===MESSAGES` + CC 改写册扩到「anthropic 入站 + 非 messages 腿」。反向对称面：cc/responses/gemini→messages 上游是 Anthropic wire，但 `ANTHROPIC(env)=false`（入站非 anthropic）→ Anthropic 域改写不 fire，须分析反向腿是否需要。**根因＝改写/策略/委托子 codec 三处基建现状按 clientFormat 单轴，全矩阵要求 (clientFormat × targetEndpoint) 二维。**

**FAIL-Google ✅（路由）**：§4.3 无后缀默认腿 passthrough 漏 responses 的 Google force-CC-fallback（[openai-responses/codec.ts:382](../../src/lib/codec/openai-responses/codec.ts#L382) `useFallback=!isResponsesSupported||forceFallback(Google)`）。Google 模型即便含 /responses 也强制回退 CC（Copilot /responses 对 Gemini 返 5xx）。§4.3 会判 passthrough /responses（坏腿）→ 破坏默认腿零回归。router 决策树须在「默认腿可用」判定前先吃 Google force-fallback。

**FAIL-A ✅（翻译）**：§8「一对双向 translator」是单向文档冒充双向——正文 5 技术点全是 CC→Anthropic 一向，反向 `anthropic-to-cc-stream`（Anthropic SSE→CC）零设计。反向有独立硬问题（Anthropic content_block 增量协议→CC choices 逆折叠比正向难、thinking 块 CC 无概念 [openai-cc/codec.ts:624](../../src/lib/codec/openai-cc/codec.ts#L624) `hasThinking:false`、usage/stop/toolu_ 全未映射）。全矩阵完整性 FAIL。

### 新 WARN
- **WARN-B ✅（翻译，硬约束）**：反向 reasoning→thinking 若合成 Anthropic thinking 块撞 GHC signature 硬 400（skill `ghc-anthropic-upstream`：signature 自包含加密、原样不改，伪造必 400/毒化）。§11/OQ5 笼统 best-effort 掩盖了硬约束。**红线**：反向请求侧绝不合成 Anthropic thinking content block（丢弃 reasoning 或仅传 reasoning_effort）。
- **WARN-C ✅（翻译）**：翻译分支 prelude 合成 message_start（[handler-v4.ts:883](../../src/routes/messages/handler-v4.ts#L883)）× translator W3 首帧 message_start × `makeReconcilingSink` drop 真实 message_start（[:997](../../src/routes/messages/handler-v4.ts#L997)）三方交互——现状 reconcile 是 anthropic-identity 假设（真 message_start 来自上游），翻译分支真 message_start 来自 translator，§7「缝合接缝」一句未设计。Phase 4 byte-critical。
- **WARN-D ✅（翻译）**：反向格子上游 Anthropic 腿复用 transport 通用保活（[http-transport.ts:57](../../src/lib/transport/http-transport.ts#L57) 4 格式共用），但不享 anthropic 入站的 L2 buffered-retry 截断保护（CC-shaped、不覆盖 Anthropic-wire 截断）——不对称须文档化。
- **W-prepareWire ✅（路由）**：翻译腿 prepareWire 委托未规约。anthropic codec 须内部持 cc 子 codec（像 gemini codec [:127](../../src/lib/codec/openai-gemini/codec.ts#L127)）委托 `cc.prepareWire` 产 CC wire；反向格子须委托 Anthropic prepareWire。承重结构非细节。
- **W-gemini双委托 ✅（路由）**：gemini codec 每方法委托单一 cc 子 codec（[:157-207](../../src/lib/codec/openai-gemini/codec.ts#L157)），反向第 10 格 gemini→messages（gemini→CC→Anthropic）够不到 anthropic 腿 → 断链。须双委托或 anthropic 腿上提 hub 共享层。§12 Phase 5 把 gemini→messages 与其它并列「独立可并行」低估了双委托结构。
- **W-priority ✅（路由）**：§4.3 无后缀优先级串「同族>cc>responses>messages」未证明 reduce 回现状确定序（cc 入站 CC 优先、responses 入站 responses 优先+force fallback）。须给每入站显式映射对照现状。

### NIT
N-@messages-strip（剥离规则枚举 3 值）、N-acc-sig（createResponseAccumulator 加 env 参审构造点）、N-gemini-messages-oracle（最长链单独 oracle）、NIT-E（thinking signature 翻译路径天然规避，值得点明消疑虑）。

### 核心症结（第三轮总结）
缝合模型「入站定交互/出站定 wire」二维轴，**未贯穿到 driver 现状三处 clientFormat 单轴基建**（改写门控 / 策略栈 / 委托子 codec）。正向（anthropic→cc/responses）两轮后成熟；**反向格子（OpenAI/gemini→messages）持续暴露独立硬问题**（反向流式零设计、reasoning→thinking 红线、gemini 双委托、force-fallback、二维门控）。全矩阵架构对路（两 agent 共识、不缩范围），但落地接缝须补「§X 缝合落地契约（二维门控 + force-fallback + 委托结构）」+ 补反向流式设计，再进第四轮。
