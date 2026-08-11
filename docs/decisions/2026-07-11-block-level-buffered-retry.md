# ADR: block 级缓冲重试 —— 按提交边界延迟提交、四端点非对称粒度、默认开门控在实证

- **状态**：Accepted（机制已落地 + 全分支评审通过；默认翻转与 P1 接线待用户实证门）
- **日期**：2026-07-11
- **相关**：spec [2026-07-11-block-level-buffered-retry](../spec/2026-07-11-block-level-buffered-retry.md)、plan [2026-07-11-block-level-buffered-retry/](../plan/2026-07-11-block-level-buffered-retry/)（README 冻结契约）、ADR [richest-data-flow](2026-07-05-richest-data-flow.md)（合成 keepalive 帧标记）、ADR [unconditional-keepalive-timeout-safety](2026-07-09-unconditional-keepalive-timeout-safety.md)（缓冲期保活地基）、DESIGN.md「活的架构现状」block 级缓冲重试行、CLAUDE.md `empirical-verification` / `long-term-wins`

## 背景

上游 GHC 会在活跃流中途发 `RST_STREAM(NGHTTP2_CANCEL)` 砍断大生成（req_484：单个大 tool_use 在 mid-block 被截断、无 `message_stop`），客户端收到半截响应报错。既有防线是 L2「整响应缓冲重试」（`protect_streaming_generation`，Anthropic 专属）：缓冲整个响应到 `message_stop` 才提交，掉线则丢弃整个 buffer、回 S4 重取新流。这是 all-or-nothing——**要么完整、要么重试**，绝不转发半截。

整响应缓冲有两个结构性局限：**①** 缓冲期客户端收不到任何真实内容（只有心跳），首 token 延迟等于整个生成时长——对长生成体验差；**②** 只在 Anthropic 落地，Responses（Codex 一等公民）/ CC / WS 都裸奔。同时，随着 tier-1 硬化把 Responses 抬到 Anthropic 同级，"每个流式端点都该有恢复防线"成为路线图上的明确形状。

自然的推广方向是：不再等到整响应结束才提交，而是**在中途的语义边界（如一个 output item 完成）就提交已完成的部分**——既能让客户端早收到内容，又对边界后的截断保留一定重试能力。但这引入一个不可回避的权衡与一个新的终局状态，需要显式定夺。

## 定夺

### 决策 1：把「整响应缓冲」推广为「按提交边界延迟提交」，共享格式无关原语

`driver.runResponseBufferedSink` 成为格式无关的共享原语，接受 `commitBoundaries?` 谓词决定「何时把已缓冲的帧提交给客户端」。整响应缓冲成为它的**退化态**（`commitBoundaries` 省略 = 只在终态提交一次 = 逐字节等价于旧的 whole-response 形状）。不再保留独立的「whole-response-only」配置模式——它就是「无中途边界谓词」的那个点。

### 决策 2：四端点**刻意非对称**的提交粒度，按各自 wire 能力裁定

提交粒度不是全局旋钮，而是**由每个端点的协议是否有可提交的中途语义边界决定**：

| 端点 | 粒度 | 依据 | partial-degrade |
|---|---|---|---|
| Anthropic messages | **块级** | `content_block_stop` 是天然中途边界 | 可达（接线后） |
| Responses HTTP | **块级** | `output_item.done` 是天然中途边界 | 可达 |
| Chat Completions | **terminal-only** | CC 无中途块边界（delta 增量、终止靠末 chunk 的 `finish_reason`） | 常规不触及* |
| Responses WS | **terminal-only** | 无中途块需求；且 close-code 时序与整响应恢复更契合 | 结构不可达 |

*CC 传了 `ccCommitBoundaries`（只认 in-band error 帧），error 帧即终态、其后无帧，故常规流程不产 partial-degrade——是「实际不触及」而非 WS 那样省略 commitBoundaries 的「结构不可达」。

这个非对称是**正确性要求**，不是妥协：给 terminal-only 端点强套块级谓词会把「非终止边界」（如 `output_item.done`）误当提交点，一旦提交就关闭重试窗口，使「临近结尾掉线」降级为不可重试的半代——本特性的执行期确实踩过这个坑（P4 WS 误用了 HTTP 的块级谓词，经独立评审逮到并修正为省略 commitBoundaries）。反向，给块级端点用 terminal-only 则白白放弃早交付能力。**粒度必须匹配协议，不能一刀切。**

### 决策 3：接受「覆盖面 vs 体验」权衡，`partial-degrade` 作为诚实的一等终局

块级相比整响应，**多了早交付、少了多块全重试**：一旦某个块已提交给客户端就无法收回（can't un-send），故该块之后的截断**不能透明重试**——只能保留已提交块 + 报错终止。这个新终局状态命名为 `partial-degrade`（区别于 `success`/`exhausted`/`retreated`），并作为一等 outcome 落遥测（`getProtectStreamingStats().<vendor>.partialDegrade`）。

我们**接受**这个权衡而非回避它：对有中途边界的端点，早交付的体验收益 + 「首块前截断仍可透明重试」覆盖了绝大多数 req_484 形态（单大生成在第一个 item 完成前被砍）；而块提交后才截断是更罕见的尾部损坏，此时保留已交付内容 + 诚实报错，优于假装完整或整体重试导致重复内容。terminal-only 端点（CC/WS）没有这个权衡——它们只在终态提交，partial-degrade 结构上不可达，等价于整响应全重试。

**不采纳的替代**：「块级端点也做整响应缓冲以保全全重试能力」——被否，因为它放弃早交付、把长生成的首 token 延迟拖到整代结束，违背「覆盖面 + 体验都要」的路线图（against-yagni-on-feature）；`partial-degrade` 的存在正是为了不必在「全重试」与「早交付」之间二选一。

### 决策 4：目标是**默认开**，但每次默认翻转门控在**实证**，而非降级为永久 opt-in

本特性的目标形态是四端点默认开（让所有流式端点都有恢复防线）。但「默认开」的前提是缓冲期保活能真正撑住客户端 idle 死线——这**不能靠文档推断**（`empirical-verification`）。故每个默认翻转门控在一次**用户执行的实证 oracle**：

- Responses / CC：`response.ping` / empty-delta chunk 能否让真实消费者存活 >300s（keepalive M-2 oracle，`exp/{responses,cc}-keepalive-idle-oracle`，armPing vs armSilent 对照）。
- Anthropic：真实 Claude Code 客户端能否接受「两块并存 + 空 text_delta 重置 300s 死线」（PoC stage-2，`exp/block-level-anchor-coexist`）。

门控使「默认开」**安全**，因此这**不是**把正确改进降级为「可选/等以后」（那会违背 `long-term-wins`）——机制完整落地、路线图不留双轨；门未过则对应端点默认保持 `false`（不牺牲安全换默认开，spec §4.5 三级 fallback 精神）。

### 决策 5：本轮显式排除 Gemini 与 web_search

- **Gemini**：其 codec 的终止生命周期由 `flushResponse` 在 driver 循环外合成，块级 commit 循环内不可见——与 Responses via-CC-fallback 同根因（结构不兼容）。本轮排除，登记 backlog（折叠在 backlog:359 via-CC-fallback 条的「同根因」提及 + spec §7.4）；理想解是把 `flushResponse` 产出重构进 driver 循环，与 fallback 一并解。
- **web_search**：走 legacy `executeRequestPipeline` 双跳、不经 driver。是重要功能、需支持，但其管线陈旧、值得下决心重写——拉出为**未来独立 spec / 下一个大任务**，不塞进本轮。

这两项排除是 `no-silently-cut-but-defer` 的显式记录，不是静默砍。

## 影响

- **正面**：四端点统一恢复防线（对抗 GHC mid-stream RST）；块级端点获早交付 + 首块前透明重试；遥测按 vendor 可分（`responses`/`responses_ws`/`chat_completions`）；配置经共享 `buffered_retry.*` + per-vendor 覆盖统一（旧 `protectStreaming*` 标量键经 compat 迁移）。
- **代价 / 约束**：`partial-degrade` 是块级端点的固有终局（已作诚实 outcome 记账，非缺陷）；缓冲期强制 heartbeat，注入的 keepalive 帧必打 `synthetic:"keepalive"` 标记入 forwarded 轨、绝不入上游原始轨（richest-data-flow ADR）；默认开受实证门约束、非自动。
- **可观测性**：CC-live 路径因 `streamKeepalivePingSec` 默认 20 也会心跳（追平 Anthropic/Responses live 行为，一致性改进）——已同步 DESIGN.md tier-1 行 ③ + backlog:322，可 operator override。

## 2026-08-06 后续裁决：delivery 公理取代可退 live 的旧门控

用户在 2026-08-02 确认：真实内容绝不逐 token／delta 交付，所有生产路径至少执行 block-level buffering and delivery；无可靠中间块边界的协议采用更强的 response-level terminal-only buffering。2026-08-06 的 [mandatory block delivery 与 HTTP/2 终止观测规格](../spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md) 进一步冻结了完整形状。

该后续裁决明确取代本文以下旧权衡，但保留上文作为历史决策记录：

- 决策 4 的“默认开受实证门控、门未过可保持 `false`”不再适用于 delivery。Delivery 永久开启且不可配置；实证门只影响 keepalive carrier 或恢复策略是否可用，不能恢复 live forwarding。
- `protect_streaming_generation:false`／`buffered_retry.enabled:false` 只能兼容迁移为 `max_retries:0`，不得关闭 buffering。
- `buffer_cap_bytes` 不得触发 `retreat` 到 live write-through；该旋钮从活配置与 schema 移除，旧配置只兼容读取并告警。
- `partial-degrade` 不得包含当前未闭合 unit。已提交的完整 unit 可以保留；终止时必须丢弃当前半块，再交付协议合法 error／terminal。
- 原 `commitBoundaries` boolean 与独立 hedge boundary classifier 不再足以表达完整 unit、response terminal、protocol error 与半块丢弃。目标架构改为唯一 `DeliveryGrammar` + `BlockDeliveryOwner`。
- 原决策 5 对 Gemini 的范围排除不再成立；所有 production pumps 都必须迁入 mandatory owner。Web search 若仍走独立管线，也必须满足同一 delivery 公理，不能因入口不同获得逐帧豁免。

Retry 与 delivery 从此正交：`max_retries:0` 只关闭透明重试，仍保持完整块交付。Continuation 保留，但每条腿同样只提交完整 unit。

## 备注

- 承重实现教训（供未来重实现避坑）已沉入记忆 / skill：绿测可掩盖 plan 级 spec 违反（谓词误用需 per-task 独立评审逮）、plaintext mock 让 Bun-undici 上游假性 abort（keepalive oracle 须 node:http2）、`applyConfigToState` 每请求覆写测试 state（须 `setBufferedRetryOverride`）。
- 当前代码落地状态仍以 DESIGN.md「活的架构现状」为准；后续裁决在实现前属于已确认目标契约，不得据此把未实施行为写成当前事实。
