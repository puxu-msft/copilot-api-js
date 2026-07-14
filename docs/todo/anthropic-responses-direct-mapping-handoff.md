# 交接:anthropic ↔ responses 直接映射(绕开 CC 中转)

> 状态:**方向已由用户决定推进,但由并发同伴会话接手实现**(2026-07-14)。本文件只保存两轮异构对抗审查挖出的硬发现,供接手者避坑。设计对话本身未落 RFC,不视为定稿 spec。

## 背景一句话

Anthropic 客户端请求 Responses-native 模型(如 gpt-5.6-sol)时,请求经 **Anthropic→CC→Responses 两跳**(`hub-translate.ts` `translateRequestVia`→`toCcBody`→`translateAnthropicToChatCompletions`,再 codec `prepareWire` CC→Responses)。CC 是三格式里表达力最弱的,当**非-CC↔非-CC 对**的中转时必然裁掉两端本可表达的能力(web_search strip、thinking 折成 `reasoning_effort` 标量)。用户判定这是 richest-data-flow 违背,决定给 (anthropic↔responses) 做直接 translator。

## 两轮异构对抗审查(GPT 底座 + Claude 底座,独立收敛)的硬裁决

**方向不作废、无 BLOCKER,但「无损双向往返」这个卖点被证伪,须降级为诚实边界:**

1. **[MAJOR] reasoning「无损往返」做不到,只能单向明文展示。** 实测证据 `exp/*/PROBE-FINDINGS.md`:GHC Responses 腿**非流式 reasoning summary 恒 null**、流式只给**明文** summary delta,**从不回传可续接的 signed reasoning item**。回传方向(Anthropic thinking → Responses `encrypted_content`)撞 `exp/encrypted-content-400` 探针死墙:`encrypted_content` 上游签名**不可伪造**,空/占位/null 全 400。**但** direct 相比 CC 中转在 reasoning 上只会更好(CC 那跳整个丢,direct 至少能把明文 summary 展示给客户端)。收益真实、非无损 → 定性为「Responses 明文 reasoning summary **单向展示**(合成 sentinel signature),回传侧丢弃/降为 `reasoning_effort`」。§9 反向红线约束的是**请求侧注入 Anthropic 上游**,不约束 A 响应侧呈现给客户端。

2. **[MAJOR] web_search 请求侧可透传,结果回显撞已退役双跳同一堵墙。** 请求侧可行且有实测(`exp/web-search-double-hop-live` 证 gpt-5.5 经 Responses `web_search_preview` 真返结果)。**但**响应侧要把 Responses 搜索结果合成回 Anthropic `web_search_tool_result` 又需 `encrypted_content` → 多轮回显撞 400 = **2026-07-13 刚退役的 web_search 双跳死因**(见 ADR `decisions/2026-07-13-server-tool-positioning-and-web-search-retirement.md`)。做全闭环 = 复活刚埋掉的坑。**动机重定性**:CC 腿 strip web_search 是**正确行为**(CC 确实不支持 server tool)非 bug;真实诉求是「responses 腿别 strip」,请求侧正当,结果回显做不到无损。**名称鸿沟**:Anthropic `web_search_20250305`(前缀 type + Anthropic schema)≠ Responses `web_search`/`web_search_preview`(不同参数),映射非零工作。

## RFC 前必须前置的两个 P0 探针(两 reviewer 一致 gate)

烧真实 GHC 额度、起**非 4141 端口**测试服务器(绝不杀 4141 主服务器)、独立 history.db:

- **(a)** Responses reasoning 流式到底能否拿到可回传的 signed item(还是只有明文 summary)。现有探针大概率已答「只有明文」,接手者先复核 `PROBE-FINDINGS.md` Probe 2 再决定是否补测。
- **(b)** Anthropic web_search → Responses 结果回显的 encrypted_content 闭环,客户端多轮回传是否 400(大概率是,则须坦承「单轮搜索可用、结果不可无损回显 / 降级为普通 text 块」)。

## 架构表述纠正 + 需新 ADR

- **不是「废除 CC hub」,而是 canonical bridge 按 cell 选**:CC 对涉及 `/chat/completions` 的腿仍是正确 canonical;只对 `(anthropic,/responses)` 和 `(openai-responses,/v1/messages)` 两个 cell 改直接。这是 CC-hub ADR(`decisions/2026-07-11-universal-codec-translation-matrix.md`)「加一格式=加一对↔CC」泛化决策的**第一个 N² 点对点特例**,须**新 ADR** 记录偏离边界(定性为针对性优化、非普适方向,否则滑向 N²)。
- **cell 契约要显式类型化**:现 Responses outbound leg 以 `clientFormat === "openai-responses"` 判 direct,其余一律当 CC-shaped 调 `prepareViaResponsesWire`([openai-responses-cell.ts](../../src/lib/codec/openai-responses/openai-responses-cell.ts))。direct 产真 `ResponsesPayload` 会被当 CC payload 处理 → 须给 cell 引入 `wireCanonical: "responses" | "cc"` 之类显式契约,在 `resolveCellAssembly` 穷尽 Record 里显式建 direct cell,别做成 dispatch 里的隐式 if。

## 最大实现成本项(接手者须显式权衡)

A/B 响应流式是最高危 byte-critical 腿。当前 A 响应二跳**复用两个已 Phase 4 golden 的成熟 primitive**(`createStreamTranslator` Responses→CC + `createCcToAnthropicStreamTranslator` CC→Anthropic,`hub-translate.ts`)。direct 要写**全新** Responses↔Anthropic 流式两腿、**作废**这两个已验证件,getStreamMeta 终态信号链要重接,并重建 Phase4/5 级 golden + 独立 SDK/accumulator oracle。收益(明文 reasoning 保真 + web_search 请求侧透传)是否值得作废两个已 golden translator,RFC 必须显式列成本/收益对照表。复用而非重造:A 响应侧合成 reasoning 应复用 `src/lib/anthropic/synthetic-reasoning.ts` 的 synthetic-envelope primitive,别重造 sentinel/签名格式。

## gemini 两条同类债务(推迟,不制造第二个特例)

`gemini↔anthropic`、`gemini↔responses` 同属 non-CC↔non-CC 经 CC 中转有损,且 gemini 在 codec **parse 阶段**就被归一成 CC(本身可能是 gemini 侧损失点)。推迟合理(无技术耦合,directness 按 `(clientFormat,targetEndpoint)` cell 选即可独立落地),但记明:gemini↔responses 是否也需 direct,取决于 anthropic↔responses direct 的收益验证。

## 我这次会话的遗留(非 dead code,勿误清)

commit 9c1fc312 给 `[Anthropic→CC]` 三处 drop warning 加了 `requestId=<ctx.id>` tag。这条**不是 dead code**:anthropic→cc 翻译对真正 chat-completions-only 模型仍是活路径。仅「responses 腿借用 CC 翻译」这个**调用点**([openai-responses-cell.ts](../../src/lib/codec/openai-responses/openai-responses-cell.ts) 传 `reqId: env.ctx.id` 处)会随 direct 映射落地而改变/移除,文件本身不死。
