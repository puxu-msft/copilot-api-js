---
name: ghc-anthropic-upstream
description: 当排查 copilot-api-js Anthropic 路径上游异常时使用——thinking signature "cannot be modified" 400、assistant 消息内 thinking 布局三约束（相邻/末块/tool_use 收尾，含 "final block ... cannot be `thinking`" 与误导性的 "prefill" 400）、thinking 块真伪/毒化校准（空明文不等于毒化，须逐块结合 signature）、contentless refusal(stop_reason:refusal，默认被抑制成正常完成轮)、tool_use 降级成 antml 文本、server_tool_use 400、tool_use.id 格式。含经 history sseEvents 诊断与本地探针手法（通用实测见 empirical-verification）。
---

# Anthropic 上游调试

## 探针手法（实证 > 推断）

从常驻 `localhost:4141` 拉真实数据复现（`curl -s :4141/health` 确认在跑，**别自启/kill**）：`GET /history/api/entries?limit=N` 看列表 → `GET /history/api/entries/:id` 取全量（`clientRequest`/`clientResponse`/`attempts[].{upstreamRequest,upstreamResponse}`/per-attempt `sseEvents`；2026-07-07 重构后旧 `inboundRequest`/`outbound*` 腿名已迁 client/upstream），内含真实有效 thinking signature。jq 拼最小请求 `--slurpfile` 防转义、`max_tokens` 调小省 token → `curl -X POST :4141/v1/messages`。**无损取字节**（勿 `tr -d '\n'` 折叠，会误判间隔）。

## 症状 → 根因 → 配置

| 症状 | 根因 | 处理 |
|---|---|---|
| `thinking ... cannot be modified` 400 | **根因（PoC 实证订正）= 折叠后 latest-assistant 消息内两个 thinking 块相邻**（留任意 1 个→200 / 任意 2 相邻→400 / 用非 thinking 块交错分隔全保留→200；非签名对不上、非我方 sanitize，inbound==outbound 逐字节同）；客户端把本应交替的 thinking 累积成相邻块 baked 进历史每轮重败。旧说「个别块签名对不上=毒化」不精确 | **已落地三层修复**（`feat/thinking-quarantine`；spec `docs/spec/2026-07-07-thinking-signature-quarantine.md` + DESIGN 活的架构现状；PoC 复现在 `exp/thinking-signature-quarantine/`）：L1 always-on 块布局矫正（`repairAssistantBlockLayout`）交错分隔相邻 thinking **保全部**（分隔符须非空——空/空白 text 被上游 strip 掉无效；config `assistant_block_layout_strategy`）+ L2 reactive strip-all 重试（`strip_thinking_on_reject`）+ L3 (session,agent)/TTL quarantine（`poisoned_thinking_quarantine`+`ttl_hours`）。旧兜底 strip-all→200 / CC 自剥仍有效 |
| 客户端收到一句「上游模型本轮以拒绝结束」、History 记 `failed` 但客户端没报错 | **contentless refusal 被默认抑制**（`stop_reason:"refusal"` 且无 client-visible text/tool_use；已观测 3 个真实样本：2 个 thinking-only + 1 个**零 content block**）。这是**设计行为**不是 bug——首要目标是不中断客户端对话轮次。真实拒绝原因（`stop_details.category`/`explanation`）在 History 的**上游轨**里，客户端轨看到的是合成轮 | 配置键是 `anthropic.refusal_sse_rewrite`（`end_turn` 抑制=默认 / `refusal` 透传 / `error` 报错）——**旧键 `refusal_recover_text` 已移除**。查 category：`GET /history/api/entries/<id>` → `attempts[].upstreamResponse.stopDetails`（或 raw `sseEvents` 里的 `message_delta`）。详见 docs/refusal-recovery.md |
| `call<invoke>…` 文本无 tool_use | GHC 偶发降级成 antml-strip 文本（`stop_reason` 仍 tool_use/或 end_turn 弱信号），标签间是 `\n` 非零间隔 | `tool_recover_call_text`（非本项目 bug，grep antml 零命中） |
| `The final block in an assistant message cannot be `thinking`` 400 | **我方自造**：L1 矫正（当时叫 de-stack）的 `move_blocks` 为分隔相邻 thinking，把唯一非 thinking 块（tool_use）挪到两 thinking 中间 → `[T,tool,T]` 末块成 thinking。修一条约束制造另一条违规。也可能是客户端原生形态（thinking 阶段被 max_tokens 截断的轮次）| **已修（2026-07-26）**：L1 预留收尾块（优先最后一个 tool_use）+ 触发条件扩为 `相邻 || 末块是thinking`；L2 matcher 并集识别本措辞（`isThinkingLayoutRejection`）。spec `docs/spec/2026-07-26-thinking-terminal-block-layout.md`、探针 `exp/thinking-terminal-block/` |
| `This model does not support assistant message prefill` 400（对话明明以 user 结尾）| 措辞误导：真实原因是**含 tool_use 的 assistant 消息里 tool_use 之后还有别的块**（如 `[T,tool,T,text]`）。同一措辞也覆盖字面情况（对话真的不以 user 结尾）| **已修（2026-07-27）**：L1 `repairAssistantBlockLayout` 的 `move_blocks` 把 C3 作**独立触发条件**主动修复（此前只保证「自己不制造」，客户端回流的非法形态照样透传）+ L2 `classifyLayoutRejection` 认领本措辞，但治愈是**有条件**的：拿**真实** `stripAllThinking` 的前后各跑一次 `hasToolTerminalViolation`，要求「原来有 C3 违规 + 剥完全部消失 + 对话不以 assistant 轮收尾（`endsOnAssistantTurn`）」三条合取才重试，否则 abort 不白烧重试。别按错误文本字面去查"最后一条消息是不是 assistant"。事故取证见 spec §追加事故（`req_1785160010003_3754`：陈旧实例产 `[T,tool,T]`）|
| `references web_search but not server tool` 400 | 历史残留 server_tool_use | `server_tool_rewrite:downgrade` + 开 web_search |
| `Invalid encrypted_content in search_result block` 400 | web_search 双跳合成的 `web_search_tool_result` 结果项 `encrypted_content=""`（`synthesize.ts`，后端产不出真加密内容）回流历史，上游校验真实非空 string（空/null/占位全 400，error-shaped 反而 200） | **always-on 兜底自动降级**（`sanitize/empty-encrypted-search-result.ts`，无需配置）；开 `server_tool_rewrite:downgrade` 更宽清理。exp/encrypted-content-400 |
| 双空块被拒 | shim 把 sig 嵌 start 无 signature_delta（web_search 双跳绕 shim 曾酿此） | `thinking_signature_compat` |
| `tools.N.custom.<field>: Extra inputs are not permitted` 400 | 新版 CC 给每 tool 挂未知字段（首例 `eager_input_streaming`，官方 Anthropic 认、GHC 版本较旧拒）；`.custom.` 是 pydantic 判别标签、wire 上是 tool 顶层扁平键 | **always-on 内置默认预剥** `eager_input_streaming`（`message-tools.ts` `stripToolFields`，首发零 400）+ 反应式 `tool-field-rejection-retry` 学习任意未来未知字段（端点级账本、matchAll 多字段、LEGIT_TOOL_KEYS deny 守卫放行变体误路由）；config `tool_strip_fields`（加）/ `tool_keep_fields`（减可逆）。注：body-field 正则曾会抢先误认领此 tools 路径（已收紧 `(?<![.\w])`）|

## 实测关键事实

- **opus thinking 明文被 GHC 加密剥离**：wire 上正常形态是 `{type:"thinking", thinking:"", signature:"ErIE…"}`——**明文空 + signature 在 = 合法加密思考**（4141 实测：当前观测的带 thinking 真实 opus 请求 40/40 皆此形，`chars=0 sig=True`）。故判「是否真 thinking / 是否毒化」**绝不能只看明文空**——naive「明文空⇒毒化」会把当前观测的正常 opus 请求全部误判为毒。
- **「空明文 thinking 毒化」的 canonical 判据**（对齐 `sanitize/content-blocks.ts` 的 `textEmpty && sigEmpty`）：**逐块**判、块类型**非** `redacted_thinking`（redacted 是合法不透明块、永不算毒）、明文 `trim` 空 **且** signature `trim` 空（whitespace-only 非真 seal，两字段都须 `.trim()`）。**逐块**是承重点——一个签名块只证自身合法、**不赦免**旁边真中毒的块；聚合语义「所有块都坏才算」会让健康块掩盖中毒块。注：此「毒化」是**观测/sanitizer 分类**概念，**不是**上表 `cannot be modified` 400 的根因（那是相邻块，见第 16 行）；它正解释了「旧说个别块签名对不上=毒化」为何不精确。
- **消费方**：TUI 完成行 `think:enc(N)`（灰，加密合法）/ `think:poison(N)`（黄，毒化）token，派生器 entry-view `responseThinkingFromBody`（读**正常完成**请求最终累积的 `finalUpstreamResponse.body`）。附注：usage **无**独立 thinking/reasoning token 计数（`output_tokens` 含 thinking 但不可分离）。
- thinking signature **自包含**（加密 thinking 内容本身、非上下文/位置）：跨对话/非首块/重写后均 200；约束=原样不改 + thinking 块**相对序**不变。**相邻性非约束**（PoC 订正）：把相邻 thinking 用非 thinking 块交错分隔（打破连续）反而 200，正是上游要求的——见 `cannot be modified` 行。
- **assistant 消息内 thinking 布局的三条上游硬约束**（2026-07-26 真上游重放实测，全部可复跑：`exp/thinking-terminal-block/`）：**C1** 最新 assistant 消息内两 thinking 不得相邻；**C2** assistant 消息末块不得是 thinking（**仅对「非首个 assistant 消息」校验，首个豁免**——二分实测钉死，见下条）；**C3** 含 tool_use 的消息必须以 tool_use 收尾。合法形态：`[T,SEP,T,tool]`／`[T,SEP,T,SEP]`（合成 marker **可以**合法收尾）／`[T,tool1,T,tool2]`（tool_use 夹在 thinking 之间合法，C3 只管末块）。**修一条必须同时断言另两条**——本项目就栽在只修 C1 上。
- **C2 的最小复现只要 5 条消息（几 KB，不必重放 90k token 的生产 payload）**：`user / assistant[tool_use] / user[tool_result] / assistant[T,tool,T] / user[tool_result]` → 400。把违规消息挪到**首个** assistant 位置（其余不变）→ 200。二分已逐一证伪的无关变量：对话轮数、历史里有没有别的 thinking、payload 规模、tools、顶层 system、内联 system 消息（**四者全加 136KB 仍 200**）。豁免的原因未知、不猜。
- **上游 400 的 messages 索引不可信、偏移方向不固定**：同一约束在不同 payload 下上游报 27/我方 28（−1）、上游 15/我方 14（**+1**）、5 条消息时报 `messages.5`（**越界**）。说明上游校验前对消息做了我方不可见的重组。**按形状定位违规消息，绝不按索引。**
- tool_use.id 上游不校验格式（`toolu_recovered_0` 也 200），只引用一致性要紧；仍合成 `toolu_`+24base62 防客户端 SDK。
- 上游兼容矩阵/特性协商属 docs（anthropic-compat.md / refusal-recovery.md），本 skill 只管调试。

> Claude Code **客户端**的连接/流式行为（CC 请求超时两层、keepalive 空 content-delta、合成帧 event: 行 + synthetic 标记、SDK 对 200+SSE-error 零重试）是**下游客户端**域，不在本 skill——见 skill `debugging-claude-client-connection`。上游**传输**（fetch/http2/proxy/keepalive）见 skill `debugging-ghc-api-upstream-transport`。
