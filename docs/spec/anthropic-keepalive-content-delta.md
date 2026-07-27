# Spec: CC 流式 300s no-content 断连修复 —— content_delta keepalive + 可观测性标记

**Status:** **全部已落地**(Phase 0-5 + review)。commit:`4d7028c`(实测 harness)/ `3014b42`(sink block-状态机)/ `b561f0d`(config + handler provider)/ `e343763`(共享模块 + web_search)/ `4eddab7`+`c46b603`(doc-sync)/ `da98cf4`(synthetic 标记)/ `9025dbd`(UI)/ `6076232`(验证测试)/ `54716d8`+`8be4a2f`(docs)。
**Date:** 2026-07-04
**Owner:** 排查会话
**实测报告:** [../../exp/cc-idle-280s/REPORT.md](../../exp/cc-idle-280s/REPORT.md)(权威根因数据)

---

## 0. TL;DR / 快速上手

Claude Code 在长 opus **pre-content thinking 静默** ~280-300s 时断连(`API Error: Stream idle timeout - no chunks received`),**代理原有的 `event: ping` 心跳压不住**。根因:CC 2.1.201 的 watchdog 有**两层**,第二层「300s 内必须收到真实 content chunk」只认 `content_block_delta`、不认 ping。修复:keepalive 从 ping 改为**匹配当前 open block 的空 content_delta**(`stream_keepalive_mode: content_delta`,默认)——空 delta 拼接进真实流无害(SDK oracle 实证),但被 CC 认作 chunk、重置 300s 计时。因空 delta 与真实内容帧字节无法区分,所有 keepalive(含 ping)在 forwarded 轨打 `SseEventRecord.synthetic:"keepalive"` 标记,防止上游沉默被伪装成正常 streaming。

**核心锚点**:配置 `src/lib/config/schema.ts`(`stream_keepalive_mode`)· 帧构造 `src/lib/anthropic/keepalive-frame.ts`(`makeAnthropicKeepaliveFrame`)· block-状态机 `src/lib/pipeline/client-sink.ts`(`makeSseSink` 的 `openBlock` + `tick`)· 活路径 `src/routes/messages/handler-v4.ts`(:429/:492 sink 构造 + `pumpAnthropicStreamingV4`)· 标记字段 `src/lib/history/types.ts`(`SseEventRecord.synthetic`)。

---

## 1. 问题

opus 在超大上下文里回答前会长时间 pre-content thinking(`message_start` → `content_block_start{thinking}` → 之后静默几百秒才出内容)。这段静默里代理每 20s 发 `event: ping` 保活,但 CC 仍在 ~280s 断连,报 `Stream idle timeout - no chunks received`。用户观测:ping 一直在发(forwarded 轨有 13 个),CC 却说「一个 chunk 都没收到」。

## 2. 根因(实测,非推断)

> **2026-07-27 补充：经代理 G2 回归已闭合。** first-party 路径的空 `text_delta` 仍有效；经代理路径失败不是 CC 改了规则，也不是代理 `streamIdleTimeout` 开火，而是 shipped config 开启的 `recoverToolCallText` marker lookahead 把上游空 `text_delta` 静默吞掉，客户端实际只收到 20s `event: ping`。`Response stalled mid-stream` 是 CC 300s watchdog 在已有部分输出时合成的错误文案。修复让空 `text_delta` 直接透传；`curl -N` 与真 CC 2.1.220 两次 315s 验收均通过。裁决记录见 [../todo/2026-07-22-client-proxy-keepalive-300s.md](../todo/2026-07-22-client-proxy-keepalive-300s.md)。

**方法**:真实 `claude` CLI 2.1.201 作独立 oracle + 受控 mock 上游(`exp/cc-idle-280s/`:`mock.ts` 按 `idle:TYPE:N:M` 发帧、`run-arm.sh` 用 `--settings` 盖 baseURL、`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` 触发生产 watchdog)。四臂对照 + prod-faithful 复测。

**裁决:CC 2.1.201 的流式 watchdog 有两层**:
1. **byte-idle ~60s**:任意字节到达即重置。代理的 ping@20s 压住了这一层(所以能撑到 ~300s 而非 60s)。
2. **no-real-content ~300s**:**只有真实 `content_block_delta` 重置**;`event: ping` 与 SSE comment **都不算 chunk**。报错 `no chunks received` 字面精确——指没收到真实内容 chunk。opus 长 pre-content thinking 静默撞第二层。

**覆盖矩阵实测**(全 GO,first-party 与 prod-faithful 一致):

| keepalive 帧 | CC 结果 |
|---|---|
| `event: ping` | ❌ 300s 断 |
| SSE comment `: keepalive` | ❌ 300s 断 |
| 空 `thinking_delta`(`thinking:""`) | ✅ 存活完整收尾 |
| 空 `text_delta`(`text:""`) | ✅ |
| 空 `input_json_delta`(`partial_json:""`) | ✅ |

与 2026-06-22 的 q2-oracle 报告「ping 有效」不矛盾:那次真实内容 tail 都在 <300s 出现、重置了第二层,从未测过 >227s 纯 ping。

## 3. 方案

### 3.1 content_delta keepalive
keepalive 从 ping 改为**匹配当前 open block 类型的空 content delta**:thinking→`thinking_delta{thinking:""}`、text→`text_delta{text:""}`、tool_use/server_tool_use→`input_json_delta{partial_json:""}`;无 open block / redacted_thinking / 未知 → fallback `ping`。帧构造 `src/lib/anthropic/keepalive-frame.ts` 的 `makeAnthropicKeepaliveFrame(openBlock)`。

**为什么空 delta 无害**(SDK oracle 实证,`exp/tool-keepalive-safety/`):Anthropic SDK(CC 同款累积)的 tool input 是 `input = jsonBuf ? partialParse(jsonBuf) : {}`——空字符串拼接不改变累积结果。真实 `@anthropic-ai/sdk` 消费「空 keepalive delta 插进真实 tool_use / thinking 流」→ 累积的 input/thinking/signature 全对(7 场景 ALL PASS)。这是**实测非推理**。

### 3.2 block-状态机(在 sink 内,forwarded-side)
keepalive 要知道「当前 open block 的 index+type」才能发对应空 delta。这个状态机放 `makeSseSink`(`client-sink.ts`)内:`write(frame)` 里解析 `content_block_start`→记 `openBlock={index,type}`、`content_block_stop`→清;`tick`(heartbeat)据 `openBlock` 选帧。**关键**:只观察**实际转发给客户端的帧**(driver 调 `sink.write`),故在 live 和 buffered 模式都天然正确(buffered pre-commit 没转发任何 content 帧 → openBlock 空 → fallback ping)。sink 保持 format-agnostic:状态机读通用 JSON 字段,Anthropic 帧构造由注入的 `pingFrame` provider 负责。

### 3.3 config: `stream_keepalive_mode`
`anthropic.stream_keepalive_mode`(`"ping" | "content_delta"`,默认 `content_delta`)。全链:schema(`schema.ts`)→ state(`state.ts` `streamKeepaliveMode`)→ apply(`config.ts`)→ bundled `config.yaml` + hot-reload 矩阵。handler 在 sink 构造点(`handler-v4.ts:429` settled-within-window / `:492` cold-start)传 `resolveAnthropicKeepalive(state.streamKeepaliveMode)` 作 `pingFrame`。cadence 仍由 `stream_keepalive_ping_sec`(默认 20)定。

## 4. 可观测性:为什么 synthetic 标记(richest-data-flow 的对称面)

空 `content_block_delta` keepalive 与真实内容帧**字节无法区分**(不像 ping 一眼可辨)。若不标记,一条「上游其实沉默、只有心跳」的请求,其 forwarded 轨(`inboundResponse.sseEvents`)看起来是一串 content_block_delta 在正常流动,运维无法看出「这些全是代理合成的心跳、上游根本没通信」——**把异常状态伪装成正常 streaming**,违背 richest-data-flow(History 忠实反映真实通信)。

**修复**:`SseEventRecord` 加 `synthetic?: "keepalive"`,所有 keepalive 注入点打标。三原则:
1. **上游轨 `sseEvents`/`outboundResponse` 绝不含 keepalive**——始终忠实(上游沉默=那段轨没有帧,可核对)。
2. **合成物只进 forwarded 轨、且打 synthetic 标记**。
3. **下游据标记区分显示**:UI `SseEventsSection.vue` badge 显示 `N events · M keepalive`、心跳行 dim+标签(一眼看出上游只发了 K 个真实帧)。

其他可观测性不变量(已核实):console 进展 `bytesIn/eventsIn` 只算上游帧(`recordUpstreamFrame`,不含 keepalive);上游真死亡由 `guardSseIterable`(`streamIdleTimeout` 独立 HARD racer,默认 300s)检测,heartbeat(SOFT racer)不重置它、不掩盖。

## 5. 活的架构 / 代码锚点

正常 opus 流式请求走:`routes/messages/route.ts:12` → `handleMessagesV4` → runRequest 快速 settle(message_start 立即到)→ **settled-within-window 分支** `handler-v4.ts:429` streamSSE + `makeSseSink(pingFrame: resolveAnthropicKeepalive(...))` → `pumpAnthropicStreamingV4` → `driver.runResponseSink`(用 sink,**非** dry-run `runResponse`)。mid-stream thinking 静默在 pump 消费流时发生,sink heartbeat timer 在此 tick 注入 content_delta。cold-start commit(`:492`,pre-response 静默超窗口)是另一分支,同样构造 sink。

| 关注点 | 文件 |
|---|---|
| 帧构造 + 覆盖矩阵 + `resolveAnthropicKeepalive` | `src/lib/anthropic/keepalive-frame.ts`(sink + web_search legacy heartbeat 共用) |
| sink block-状态机 + heartbeat tick + `writeKeepalive` + synthetic 采样 | `src/lib/pipeline/client-sink.ts` |
| config 全链 | `src/lib/config/schema.ts` · `src/lib/state.ts` · `src/lib/config/config.ts` · `config.yaml` |
| 活路径 sink 构造 + cold-start first ping + `resolveBufferedAndHeartbeat` | `src/routes/messages/handler-v4.ts` |
| web_search bypass heartbeat(block-aware + upfront ping 打标) | `src/routes/messages/streaming-pump.ts`(`startForwardedSseHeartbeat`) · `web-search-handler.ts` · `web-search-direct.ts` |
| 标记字段 | `src/lib/history/types.ts`(`SseEventRecord.synthetic`) |
| UI 区分显示 | `ui/src/components/detail/SseEventsSection.vue` |

## 6. 已知边界 / 暂缓(未来 AI 勿重复踩)

三处「无 forwarded open block → fallback ping → 若 >300s 仍断」的同源边界,均**已文档化未修**:
1. **pre-first-block 静默**:`message_start` 后、首个 `content_block_start` 前(或 pre-response cold-start),openBlock 空 → ping。实际罕见(opus pre-response 实测 ≤~13s、content_block_start 通常 <1s)。**（部分仍存**：纯 pre-message_start 窗口即完全无任何 forwarded 帧时仍 fallback ping；但一旦进入 buffered 缓冲期，见第 3 条已由 empty_text 锚点兜住。**）**
2. **web_search search-合成阻塞期**:`web-search-handler.ts` 的 `completeWebSearch()` 是阻塞调用,期间零 content block forward,openBlock 空 → ping。修法(占位 block + 真实 events index remap)有破坏合成输出风险,web_search 又是 opt-in,故暂缓。
3. **L2 buffered pre-commit**(`protect_streaming_generation`):buffered 模式 commit 前不转发任何帧,openBlock 恒空 → 心跳 fallback ping。见 `resolveBufferedAndHeartbeat` 注释。**（已由 [2026-07-08-buffered-keepalive-empty-text-anchor.md](2026-07-08-buffered-keepalive-empty-text-anchor.md) 兑现**：新增 `stream_keepalive_mode: empty_text`（现默认），buffered pre-commit 无 open block 时懒注入合成空 text 锚点块保活，空 text_delta 重置 CC 300s no-content 墙、真实块 commit 时 index+1 remap。**）**

## 7. 验证方法(复现 / 回归)

- **根因 / 覆盖矩阵**:`exp/cc-idle-280s/`(真实 `claude` CLI + mock,四臂 + prod-faithful)。改 keepalive 行为后跑它复测 CC 断连阈值。
- **客户端安全**(空 delta 不破坏 tool/thinking 累积):`exp/tool-keepalive-safety/`(真实 `@anthropic-ai/sdk` 消费 mock,`probe.ts` 的 `finalMessage()` 断言累积)。
- **活路径 e2e**:`tests/anthropic/keepalive-e2e.http.test.ts`(真实 handler/pump/driver + FakeClock + test 持 ReadableStream controller,证明 mid-stream 静默注入 content_delta 非 ping)。
- **组件行为**:`tests/anthropic/keepalive-active-path.unit.test.ts`(真实 sink+provider 各 block 类型)、`tests/anthropic/keepalive-frame.unit.test.ts`(覆盖矩阵)、`tests/pipeline/client-sink.unit.test.ts`(openBlock 状态机 + synthetic 标记)。
- 通用实测手法见 skill `empirical-verification`(客户端 SDK oracle / 活路径证明 / 分层验证)、`anthropic-debug`(CC watchdog 两层);测试时序技法见 `test-isolation`(FakeClock + controller)。

## 8. 设计演进脉络(为什么是现在这样)

方便未来 AI 理解决策路径:①最初以为 ping 够(q2-oracle 曾证 ping 保活)→ ②实测发现 CC 2.1.201 有第二层 300s no-content、ping 不算 chunk → ③改 content_delta,并逐维度被推着验证(tool 安全 SDK oracle / 活路径 e2e / 传输层 curl-N flush)→ ④发现**可观测性盲区**:空 delta 伪装成真实内容、掩盖上游沉默 → ⑤加 synthetic 标记。教训沉淀:memory `feedback-synthetic-data-must-be-distinguishable-from-real`(合成数据必须可辨识,richest-data-flow 对称面)+ `feedback-multidim-completeness-audit-before-claiming-done`(声称完备前过多维度自审:活路径/传输/可观测/副作用)。

## 相关

- 运行时选项详表:[../DESIGN.md](../DESIGN.md) 的 `streamKeepaliveMode` 行 + 「活的架构现状」流式写出行。
- CC 超时 oracle:memory `reference-claude-code-timeout-and-sse-error-oracle`(两层 watchdog 实测)。
- 前序 keepalive 机制(延迟-commit / cadence / heartbeat 命名):[pre-response-abort-handling.md](pre-response-abort-handling.md)。
