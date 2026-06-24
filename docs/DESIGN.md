# 设计文档

编码风格、注释规范与编码/架构约定见 [coding-conventions.md](./coding-conventions.md)。

## 架构

### 运行时兼容（Bun-first / Node-compatible）

项目同时支持 Bun 与 Node 两个运行时，但**优先级不对称**：

- **Bun 是一等公民**——默认/推荐运行时。所有开发与运行命令（`dev` / `start` / `test:*`）都走 `bun`，`bun test` 是唯一被 CI 实测的后端套件。
- **Node 仅是有意维护的兼容目标**——分流路径靠运行时逻辑保证，但实测覆盖弱于 Bun（Node 专属分支在 `bun test` 下走不到，例如 driver.ts 的 `nodeFactory()`）。

所有运行时差异都收敛到单一判别点 `typeof globalThis.Bun !== "undefined"`，分流出独立实现：

| 子系统 | Bun 路径 | Node 路径 | 文件 |
|--------|----------|-----------|------|
| HTTP 服务器 | `Bun.serve()` | `@hono/node-server` | `lib/serve.ts` |
| WebSocket | `hono/bun` | `@hono/node-ws` | `lib/ws/adapter.ts` |
| SQLite | `bun:sqlite` | `node:sqlite`（Node ≥22.5） | `lib/history/sqlite/driver.ts` |
| 上游 fetch / keepalive | **https → `node:http2`**（h2 session 池 + Response 适配器 + createConnection `setKeepAlive`）；http → `undici/index.js`（子路径绕 Bun shim） | https → `node:http2`；http → `undici/index.js`（Node 本就真 undici） | `transport/http2-client.ts` / `transport/upstream-fetch.ts` / `lib/proxy.ts`，见 [bun-runtime-timeout.md](bun-runtime-timeout.md) |
| 代理 | undici dispatcher（ProxyAgent / EnvProxyDispatcher，经 upstream-fetch 显式传） | 同左 + `setGlobalDispatcher` | `lib/proxy.ts` |

#### 依赖选型原则：bun-first

所选外部库本身**必须能在 Bun 下原生工作**——判据是"Bun 热路径上的库 Bun 原生可跑"，而非"禁止任何 node-only 依赖"：

- **拒绝 node-gyp 原生绑定（`binding.gyp`）**——Bun 兼容性最大的雷区。标杆实例：driver.ts 刻意不用 `better-sqlite3`（Bun 1.3 加载时直接拒绝 "not yet supported in Bun"），改用两端各自的内建 SQLite，避免用户在安装时被迫二选一。
- **node-only 库可作兼容路径，但不得进 Bun 热路径**——`@hono/node-server`、`@hono/node-ws` 只在 Node 分支被动态 `import()`。**上游 https 热路径走内建 `node:http2`**（`transport/http2-client.ts`）：Bun 的 undici HTTP 解析层对 GHC h2 端点的 chunked HTTP/1.1 响应永久挂（裸 `node:tls` 收齐字节、Node 同码 0.4s、curl 0.4s——是 undici-on-Bun 的解析 bug），而所有 https 上游皆 h2-native，故改走 node:http2（h2 + `createConnection` 上 `setKeepAlive`，`ss` 实证 idle socket 带 keepalive timer）。**`undici` 经 `undici/index.js` 子路径仅留给明文 `http://`**（本地 SearXNG）——纯 JS、无 node-gyp；走子路径是因为 Bun 把裸 `undici` 替换为内建 shim 会静默丢弃 dispatcher。pin undici 7（8 的 index.js 在 Bun 崩）。详见 [bun-runtime-timeout.md](bun-runtime-timeout.md) 与 [rfc/upstream-http2-transport.md](rfc/upstream-http2-transport.md)。
- **审计手段（实测，非推断）**：`find node_modules -name binding.gyp` 应为空（零 node-gyp 依赖）；`find node_modules -name "*.node"` 命中的 `@rollup` / `@rolldown` / `@oxc-*` 都是**构建工具**预编译产物，只在构建期用、不进运行时 dist，不算违反。

### 入口点

- `src/main.ts` - CLI 入口（citty），子命令：`start`、`login`（别名 `auth`）、`logout`、`debug`、`list-claude-code`、`setup-claude-code`
- `src/start.ts` - 服务器启动：认证、模型缓存，启动 Hono 服务器（经 `lib/serve.ts`：Bun → `Bun.serve()`，Node → `@hono/node-server`）
- `src/server.ts` - Hono 应用配置，注册所有路由

### 请求流程

v4 管线：路由按前缀选 **codec**（每格式一个）+ 构建 per-request **driver**，由 driver 编排七阶段（S1–S7）。详见 [v4 设计文档](v4/01-architecture.md) 与 [03-spec/](v4/03-spec/)。

1. 请求进入 `src/routes/` 中的 Hono 路由（`route.ts` 薄包装：try/catch + forwardError，直调 v4 handler）。
2. handler 按接入格式选 codec（`lib/codec/`：`anthropic` / `openai-cc` / `openai-responses` / `openai-gemini`）+ 构建 driver（`createPipelineDriver`，consume codec + transport + retry strategies + rewrite registry），调 `driver.runRequest` / `driver.runResponse`。
3. driver 编排**七阶段**（`lib/pipeline/driver.ts`，详见 [03-spec/envelope-driver.md](v4/03-spec/envelope-driver.md)）：
   - **S1 parse** — `codec.parse(raw)` → `RequestEnvelope`（model 解析、body 提取、建 RequestContext）
   - **S2 route/translate** — `codec.decideRoute`（透传/翻译/拒绝，统一 4 格式判断）+ `codec.translateOut`（透传=identity）
   - **S3 rewrite-in** — `runRewriteIn`：请求改写链（registry 按 format+config+order 装配）。Anthropic 由 codec 经 `deps.requestRewrites` 供 per-request `RequestRewrite`（`codec/anthropic/request-rewrite-adapter.ts`：sanitize 链 + pipelineInfo/messageMapping/thinking 记录，**Stage A A0** 从 `codec.parse` 迁入；闭包 over 路由产的 `preprocessInfo`，故走 codec-provided 而非 module-global `BUILTIN_REQUEST_REWRITES`）
   - **S4 exchange** — `runExchange`：错误驱动重试循环（`codec.prepareWire` → `transport.send` → 失败时首个匹配 strategy 改写 env 重试；429 由 adaptive rate-limiter 在 transport 内消化）
   - **S5 rewrite-out** — 响应改写链（逐帧 `transform`：emit/suppress/buffer + 流末 `flushChain`，已进 `try/finally` 故异常路径也 drain registry buffer）。Anthropic 的 5 个 `ResponseRewrite` 定义在 `src/lib/codec/anthropic/response-rewrite-adapters.ts`（`ANTHROPIC_RESPONSE_REWRITES`），由 handler 作 `deps.responseRewrites` 传入 driver（module-global `BUILTIN_RESPONSE_REWRITES` 仍空）：recover-tool-call=100 / thinking-signature-compat=150 / tool-input-decode=200 / server-tool-filter=300 / recover-refusal=400，**Stage A A1** 从 handler pump 原子迁入，复用既有 factory 不重写算法核；order 编码硬序契约 recover<filter<refusal
   - **S6 render** — `codec.renderResponse` 翻回客户端协议（透传=identity）
   - **S7 forward** — handler 写回客户端（streamSSE / JSON / WS frame）
4. driver 在阶段边界采样原始数据 → observability bus → sinks（History/Ws/Console/Telemetry/File）：S1 入站、S4 per-attempt 双轨（effective/wire + queueWaitMs）+ **上游原始 sseEvents**（循环顶逐帧，所有格式统一）+ **S5 前经 `runResponse` 的 `onUpstreamFrame` hook 把 raw 帧交回 handler 做 accumulate（→ `outboundResponse` 保上游原貌，Option A，Anthropic）/ repetition / progress / 诊断**；**客户端 forwarded（Stage B 起）由 driver-owned `ClientSink` 在写出点采样（`makeSseSink`/`makeWsSink` 的 `onForwarded`），全 5 格式经 `runResponseSink` 统一**（详见下文「活的架构现状」流式写出行 + [03-spec/envelope-driver.md §4](v4/03-spec/envelope-driver.md)）。
5. Anthropic 直连为 **bypass-direct**（`translateOut`/`renderResponse`=identity）；其 S5 响应改写链（recover/thinking/decode/filter/refusal）由 driver 逐帧应用后写进 sink（**A1 起非逐字透传** + **Stage B 起 driver owns-the-sink**——driver 跑改写 + 写客户端，handler 只供 `onUpstreamFrame` accumulate + 映射终态，不再二次 filter / 不再 handler 写出）。非 Anthropic vendor 模型在 S2 拒绝 400（无降级）。
6. **Azure**：`injectDeploymentModel` 从 URL path 注入 `azureModelOverride`，复用 CC/Responses 的 v4 handler（不新增 codec）。
7. **例外**（不进 driver）：web_search 双跳（Anthropic opt-in，正交控制流，走 legacy direct-completion `handleDirectAnthropicCompletion`，P2.6-D1 暂缓）；`count_tokens`（Anthropic/Gemini，本地 tokenizer，无管线）；embeddings（无 history/重试需求）。
8. 请求完成 / 失败时一次性写入 SQLite，否则仅更新内存 in-flight 映射并推送 WebSocket。

### 活的架构现状（v4 迁移态）

v4 driver（七阶段编排）正逐步取代各格式巨型 handler。下表定位"当前活的是哪条路径"——读具体模块前先在此对齐，别把旧路径当主路径。状态：`[done]` 已迁 driver / `[wip]` 仍 handler-side / `[bypass]` 设计上不进 driver / `[退役中]`。

| 子系统 / 路径 | 状态 | 当前活的架构 | 在哪看 |
|---|---|---|---|
| 请求改写（S3） | `[done]` A0 | Anthropic sanitize 链经 codec-provided 闭包注入 driver S3（codec 方法 `getRequestRewrites()`） | `src/lib/codec/anthropic/request-rewrite-adapter.ts` |
| 流式响应改写（S5） | `[done]` A1 | recover/thinking/decode/filter/**refusal** 五条 ResponseRewrite（refusal-recovery=400 最后跑：thinking-only refusal→追加合成 text + stop_reason→end_turn，见 [refusal-recovery.md](refusal-recovery.md)）——**载体是 handler import 的 `ANTHROPIC_RESPONSE_REWRITES` 数组并作 `responseRewrites:` 传入 driver；module-global `BUILTIN_RESPONSE_REWRITES` 仍是空数组**（别去 registry 找改写）。**反直觉契约**：所有合成（非透传）SSE 帧必经 `anthropic/sse-frame.ts` 的 `anthropicSseFrame`（`event:`=帧 `type`）——纯 `data:` 帧解码成 `event=null` 会被 Anthropic SDK（Claude Code）按 event 名分发时静默丢弃（连 SSE `"message"` 默认都不应用），golden `assertEventLineInvariant` 守卫钉死，见 memory `reference-anthropic-sdk-drops-eventless-sse-frames` | `src/lib/codec/anthropic/response-rewrite-adapters.ts` |
| 非流式响应改写（S5 whole） | `[done]` A.B | recover/decode/filter 各声明 `transformWhole`，经 driver `runResponseWhole` 按**与流式同一升序 order 链**应用（name-restore 随 filter@300 bundle）；`renderNonStreamingV4` 只剩 verbose marker（不进 registry，design §3.1）+ 调 `driver.runResponseWhole`。统一后非流式 decode 改为先于 restore（wire-name 匹配，与流式一致）——仅 `sanitizeToolNames`+被清洗的 decode-target 这一极窄角与旧序有别。**注**：web_search 双跳 `[bypass]`（`web-search-direct.ts` 的 `handleDirectAnthropicNonStreamingResponse`）仍用旧序 filter→recover→restore→decode，待其迁 driver 时收敛 | `src/lib/codec/anthropic/response-rewrite-adapters.ts`、`src/lib/pipeline/driver.ts` |
| Responses + 上游 WS（S5 逐帧） | `[done]` A.C | `fixStreamEventIds`（stateful 跨帧 id 修正，direct-only）经 driver S5 registry 应用——HTTP + WS **共享同一条 rewrite**（`RESPONSES_RESPONSE_REWRITES`），不再各自内联 idTracker。tool-name restore 须作用于 render 后的 Responses 帧（fallback 的 renderResponse 是 CC→Responses 翻译，故不能进 pre-render 的 S5），**Stage B 起经 handler 供 driver 的 `onRenderedFrame`（HTTP）/ `restoreAccumulateCount`（WS）钩子**作用于 render 后帧，两传输共享 helper `restoreResponsesStreamFrameToolNames`。整流翻译（CC→Responses，codec.renderResponse）+ 写出层（HTTP `makeSseSink` / WS `makeWsSink`）**已切 owns-sink（Stage B 完成，见下行）** | `src/lib/codec/openai-responses/response-rewrites.ts`、`src/routes/responses/ws.ts` |
| 流式写出 + forwarded 采样 + 终态（全 5 格式 owns-sink） | `[done]` Stage B 完成 | **全 5 格式（Anthropic/CC/Responses-HTTP/Responses-WS/Gemini）流式 pump 已切 owns-sink**：driver `runResponseSink(upstream, env, sink)` drain S5 链写进 `makeSseSink`/`makeWsSink`，返回格式无关 `ResponseOutcome`（`complete{headers}`/`stream-error{raw error}`/`settled-abort`，**不载 accumulator**——handler 自持 acc 经 `onUpstreamFrame`（Anthropic，raw 上游帧）/ `onRenderedFrame`（CC + Responses，render-后帧）喂、终态读 streamError/usage）。**Anthropic ③ pre-response 延迟-commit（C3b，`streamKeepaliveGraceSec`>0）**：`stream:true` 请求在进 pump 之前先 race `runRequest` vs grace timer——grace 内上游回头走现状路径（`runUpstreamSettledPath`，零发散）；grace 耗尽上游仍静默 → COMMIT 提前开 200 SSE + 立即 ping（`sink.write`），POST-COMMIT 上游错误经 `post-commit-error.ts` 降级成富 SSE error 帧（signal-state 判别 client/reaper/timeout，绝不用 error.name）；commit 后接同一 sink 进 pump。详见 [rfc/pre-response-abort-handling.md](rfc/pre-response-abort-handling.md) §4。**forwarded 采样在 sink 内**（`onForwarded`→`forwardedSseEvents`）：`write` 采、`writeSynthetic`（H3 合成 error 帧）**不采**、内部 heartbeat timer 注 ping 并采——H2-sampled/H3-unsampled 非对称（B0-c 锁）。sink 持 heartbeat 自重排 timer，`runResponseSink` `finally` 必调 `sink.close?.()`（4 退出路径无泄漏；WS sink 无 close 故 no-op）；sink 与 transport 的 `guardSseIterable` idle 是**分离两-racer**（heartbeat SOFT、upstream-idle HARD）。**CC/Responses 特有**：`onRenderedFrame`（post-S6-render/pre-write transform，`onUpstreamFrame` forwarded 侧对偶，返回 `ClientFrame|undefined`——undefined=skip 整帧，Responses 用于跳 empty/unparseable）承载 render-后 accumulate（上游名进 complete 数据）+ forwarded-only tool-name restore；CC 无 H2、无 heartbeat，marker 经 `sink.write` 作首帧、尾 `[DONE]` handler 总合成单帧（driver 丢弃所有上游 `[DONE]`，passthrough+via-responses 统一一个）；Responses 无 `[DONE]`（以 `response.completed` 收尾）/无 H2/无 heartbeat，fallback（CC→Responses）的 `codec.flushResponse` closing 生命周期在 complete 后 handler-side drain（评估后保留 handler-side——"移进 driver S6 flush / finalize"经 3 轮对抗 review 判过度设计 + WS 不适配，见 [rfc/response-pipeline/finalize-stream-redesign.md](rfc/response-pipeline/finalize-stream-redesign.md)），session 注册 fallback eager/direct 用 `acc.responseId`，`fixStreamEventIds` 已是 S5 rewrite。**Responses-WS 特有**：`RunResponseOpts.stopAfterFrame` 谓词承载终态早停（写完 TERMINAL_EVENTS 帧后 break drain loop、settle complete，防上游尾帧/stall 挂 idle-timeout；fallback 终态来自 flushResponse 不在 loop 故不触发），错误走 `sendErrorAndClose`+1011（非 sink）、clean 完成 `ws.close(1000)` 除非 keep-open、WS 计数 loop+closing-drain 两处、连接级机制（caps/idle/in-flight/`wsClientAborts`）未动；`frameType` fallback `frame.event ?? (data?"message":"keepalive")` 镜像 driver 上游轨派生。**Gemini 特有（B5，最硬）**：CC→Gemini 整流翻译状态机从 handler whole-stream generator 迁进 codec——`createGeminiStreamTranslator`（`renderFrame`/`flush`/`getMeta`），codec `renderResponse` 逐帧出 Gemini 帧、`flushResponse` 流末（剩余 tool drain + 终态 finishReason/usage 帧）、`getStreamMeta` 终态 meta 出 driver 外（handler complete/error 读它 settle）；handler **不用 onRenderedFrame**（翻译在 codec）；sink 加 `forwardedType: () => "generateContent"` 覆盖（Gemini 帧无 event/type）；H3 走 Gemini data-only 帧 + `writeSynthetic`。**全 5 格式已切 owns-sink**——generator `runResponse` 是 `runResponseSink` 的共享引擎（runResponseSink `for await` 包它）+ dry-run inspector 消费，**非待删**；旧 `startForwardedSseHeartbeat`/`forwardClientFrame`（streaming-pump.ts）web_search bypass 仍用，**别删** | `src/lib/pipeline/client-sink.ts`、`src/lib/pipeline/driver.ts`（`runResponseSink`、`onRenderedFrame`、`stopAfterFrame`）、`src/routes/messages/handler-v4.ts`（`pumpAnthropicStreamingV4`）、`src/routes/chat-completions/handler-v4.ts`（`pumpStreamingV4`）、`src/routes/responses/handler-v4.ts`（`pumpStreamingV4`）、`src/routes/responses/ws.ts`（`handleResponseCreateV4`）、`src/routes/gemini/handler-v4.ts`（`pumpGeminiStreamingV4`）、`src/lib/codec/openai-gemini/codec.ts`（`renderResponse`/`flushResponse`/`getStreamMeta`）、`src/lib/gemini/convert-stream.ts`（`createGeminiStreamTranslator`） |
| HTTP header 捕获（4 腿 + trailers） | `[done]` Phase 0-5 + OQ5 | **四腿全活**（richest-data-flow 完整阶段模型）：①`inboundRequest`（各 codec.parse `setInboundRequestHeaders`）②`outboundRequest`（driver S4 从 `wire.headers`，per-attempt）③`outboundResponse`（driver S4 成功读 `upstream.headers` / 失败读 `apiError.responseHeaders`，**成败两路** per-attempt；`classifyHTTPError` 全分支透传 responseHeaders）④`inboundResponse`（handler 写出点：流式 `streamSSE` 回调开头读 `c.res.headers`、非流式读 `c.json` 返回 Response 的 headers）⑤`outboundResponseTrailers`（h2 响应 trailing HEADERS，`http2-client` `req.once("trailers")`→`onTrailers` 回调→`setOutboundResponseTrailers`，best-effort capture-when-present；明文 http 无）。**存原始未脱敏**（operator 决策；`sanitizeHeadersForHistory` 仅 betaProbe 留用）。driver 拥有出站捕获、**无 handler-bag**（transport 仅 transport-local capture 喂 `UpstreamStream.headers`；web_search 旁路保留自己的 bag）。顶层镜像最终 attempt + `attempts[].{wireRequest.headers, responseHeaders}` per-attempt（**注**：加 leg 字段须同步 history sink `onTerminal` 的**显式字段投影**，否则 stage round-trip 丢字段）；in-flight 经 setter publish `field:"httpHeaders"` + sink `onContextUpdated` 分支可见（不进轻量 `snapshot()`） | `src/lib/pipeline/driver.ts`、`src/lib/context/request.ts`（`setHttpHeaders`/`setInbound*Headers`/`setAttemptResponseHeaders`/`setOutboundResponseTrailers`/`legFromWire`）、`src/lib/transport/http2-client.ts`（trailers）、`src/lib/observability/sinks/history.ts`（投影 + onContextUpdated）、各 `routes/*/handler-v4.ts`（④ 写出点）、[rfc/history-http-header-capture.md](rfc/history-http-header-capture.md) |
| 流式截断检测（全 4 流式格式） | `[done]` | 上游发完部分响应后**干净 EOF 但缺协议终止符**（GHC mid-stream 截断）曾被误判成功 complete（打 `[OK]`、history 记成功，客户端却报 "Stream ended without receiving any events"）。现各格式 handler 在 `outcome==="complete"` 分支读自家 accumulator/meta 判完整性——Anthropic `acc.sawMessageStop`、CC `acc.finishReason!==""`、Responses `acc.status!==""`（viaFallback drain 后判）、Gemini `getStreamMeta().finishReason!==UNSPECIFIED`（flush 前判，跳过误导终止帧）——缺终止符则改判 `ctx.fail`（`[FAIL]`+明确原因+history 记失败、`fail()` 经新增 content 通道保留残缺投影）+ 经 `sink.writeSynthetic` 给客户端合成格式专属 error 帧（非 forwarded 采样，镜像各格式 H3）。**非流式**截断已正确处理（解析失败→`bad_request`→FAIL / socket 错→重试）；**暂缓**：live 路径流式 post-content 截断无法透明重试（帧已转发、与 S4 重试环架构隔离）——但 **L2 缓冲重试**（`protect_streaming_generation`，见下「流式上游 RST 缓冲重试」行）开启时缓冲整响应到 commit 前，故 pre-commit 截断/RST 可透明重试；web_search 旁路（legacy 路径不经 driver）、非流式语义残缺 JSON 仍暂缓。设计见 [rfc/upstream-stream-truncation-detection.md](rfc/upstream-stream-truncation-detection.md) | `src/lib/anthropic/stream-accumulator.ts`（`sawMessageStop`）、`src/lib/context/{types,request}.ts`（`PartialResponseInfo.content`）、各 `routes/*/handler-v4.ts` 的 complete 分支 |
| 流式上游 RST 缓冲重试（L2，仅 Anthropic 流式） | `[done]` opt-in（默认关） | 上游 GHC 在活跃流中途发 `RST_STREAM(NGHTTP2_CANCEL)` 砍断大 Write/Edit 生成（请求级中止）。`anthropic.protect_streaming_generation`（`on`/`tool_use_only`，默认 `false`）开启时，handler 选 driver 的 `runResponseBufferedSink` 而非 `runResponseSink`：缓冲整响应、`message_stop`（或 H2 上游 error 帧，经 `sawUpstreamError` 区分）后才 commit flush，transport-close/truncation 则丢弃 buffer 回 S4 重取新流（上限 `protect_streaming_max_retries`，all-or-nothing 绝不转发半截）。缓冲期**强制** heartbeat（`protect_streaming_heartbeat` 兜底）防客户端 idle 断。每尝试全量重置 handler 侧累积态（acc/checkRepetition/local sseEvents/streamState）；失败尝试上游帧逐尝试留痕（D1，`attempts[].sseEvents`，仅失败尝试落 per-attempt 行、成功尝试帧在顶层不重复）。默认 `false` → 走 live，逐字节同 L2 前（`streaming-l2-baseline.http.test.ts` 锁）。**Phase 3/4 已落地**：buffer cap（`protect_streaming_buffer_cap_bytes` 16MiB，超限 retreat 退回 live 写穿防 OOM、不重试）、escalation（`protect_streaming_escalate_context`，重试 FORCE 渐进激进 `clear_tool_uses` 压上下文，opt-in 默认关）、命中率遥测（`protect-streaming-stats` 计数器 + `/api/status.protect_streaming` + ctx feature tag）。设计见 [rfc/streaming-upstream-rst-buffered-retry.md](rfc/streaming-upstream-rst-buffered-retry.md) | `src/lib/pipeline/driver.ts`（`runResponseBufferedSink`、`sawUpstreamError`/`bufferCapBytes`/`escalate`/`onBufferedResolve`）、`src/routes/messages/handler-v4.ts`（`pumpAnthropicStreamingV4` 选路）、`src/lib/anthropic/{request-preparation,features}.ts`（escalation 注入）、`src/lib/anthropic/protect-streaming-stats.ts`（遥测）、`src/lib/history/sqlite/serialize.ts`（per-attempt sse_events 行） |
| 旁路（设计如此，不进 driver） | `[bypass]` | web_search 双跳（走 legacy `executeRequestPipeline`）、count_tokens（本地 tokenizer，不沾 pipeline）、embeddings | `src/lib/anthropic/web-search/` |
| 旧重试管道 | `[退役中]` | `src/lib/request/`（`executeRequestPipeline` + strategies）；strategies 经 `legacy-strategy-adapter` 被 driver 复用，pipeline 本体**仅 web_search 双跳消费** | `src/lib/request/pipeline.ts` |

完整迁移设计与 phase 进度见 `docs/v4/` 与 `docs/rfc/response-pipeline/`。

#### 改写词汇（命名约定，钉死映射避免混用）

"改写 payload" 的相关词有精确分工，**不可互换**（重组依据见 `docs/rfc/anthropic-rewrite-reorg.md`）：

| 词 | 精确含义 | 阶段 | 载体 |
|---|---|---|---|
| **Rewrite**（`RequestRewrite`/`ResponseRewrite`） | driver registry 装配、env 级、声明式 `order` | S3 / S5 | `pipeline/rewrite-registry.ts` 接口 |
| **PayloadRewrite**（`AnthropicPayloadRewrite`） | 格式原生（pre-env）改写模块，**被 S3 适配器包装 _或_ 被 bypass 直接调用** | S3 之下 / bypass | `anthropic/payload-rewrites.ts`（被 `codec/anthropic/request-rewrite-adapter.ts` 包装；web_search 旁路独立复用） |
| **PrepareStep** | per-attempt wire 整形 + 副作用（beta probe），**非 rewrite** | S4-pre | `anthropic/request-preparation.ts`（B1–B12） |
| **Strategy**（`RetryStrategy`） | 错误驱动反应式 re-rewrite + 重试 | S4 重试环 | `request/strategies/*`（实现）+ `codec/*/strategies.ts`（组装） |
| **sanitize** | 一条**具体** PayloadRewrite（消息清洗），**不再作伞形动词** | — | `anthropic/sanitize/`（`index.ts` barrel + 子步） |

module-global `BUILTIN_REQUEST_REWRITES`/`BUILTIN_RESPONSE_REWRITES` **故意为空**（见 `rewrite-registry.ts` 注释）——各格式改写经 `deps` 注入，**别去 registry 找改写**。

### 核心模块

`src/lib/` 按格式域 + 横切关注组织。下面是**目录级关系图**：每节点给「职责 · 跨目录数据流/consumed-by · provenance/反直觉契约」，**不列叶子文件**——叶子清单交 `git ls-files src/lib` / codemap 派生（手列叶子=高 churn 必漂成死条目）。大域（anthropic/history/openai）下沉到子目录级。维护约定见末尾「图维度规则」。

**v4 管线骨架（格式无关）**

| 目录 | 职责 · 关系 · 契约 |
|---|---|
| `src/lib/pipeline/` | driver 七阶段编排（S1–S7 + 错误驱动重试 + 阶段边界采样 + `onUpstreamFrame` hook 把 raw 上游帧交回 handler 做 accumulate/采样）。**registry 已激活（Stage A 完成）**：S3 跑请求改写、S5 跑响应逐帧改写（`passThrough`+`flushChain`）、`runResponseWhole` 跑非流式 `transformWhole`。**owns-the-sink 写出（Stage B 完成）**：`runResponseSink` 持注入的 `ClientSink`（`client-sink.ts` 的 `makeSseSink`/`makeWsSink`）自己写客户端 + 在 sink 内采 forwarded，全 5 格式经它统一（`runResponse` generator 是其共享引擎，仍被 dry-run 消费故不删）；钩子 `onRenderedFrame`（render-后 transform）/ `stopAfterFrame`（终态早停）。**反直觉契约**：`rewrite-registry.ts` 的 module-global `BUILTIN_REQUEST_REWRITES`/`BUILTIN_RESPONSE_REWRITES` **故意留空数组**——各格式改写经 codec/handler 传入的 `deps`（Anthropic 请求/响应集、Responses fixIds），registry 本体只供装配器（`assembleRequest/ResponseRewrites` 按 `appliesTo`+`order` 装配）+ `RESPONSE_REWRITE_ORDER` 硬序常量（recover 100 < thinking 150 < decode 200 < filter 300）。`legacy-strategy-adapter` 把旧 RetryStrategy 适配成 driver env-based 重试。改写适配器在 `lib/codec/*-rewrites.ts`（**非** registry 文件）。 |
| `src/lib/codec/` | 每格式 `FormatCodec`（parse/decideRoute/translateOut/renderResponse/prepareWire/sampleRequest）。**openai-cc 是翻译中枢**（CC↔Responses 经 `src/lib/openai/translate/`）；**openai-gemini 工厂内委托内部 openai-cc codec** 处理 CC payload；anthropic 为 bypass-direct（translate/render=identity），`getRequestRewrites()` 供 driver S3，响应改写则由 handler import `anthropic/response-rewrites.ts` 的 `ANTHROPIC_RESPONSE_REWRITES` 传入 S5。`*-strategies` 各格式组装重试策略。 |
| `src/lib/transport/` | 格式无关上游收发。`upstream-fetch.ts` 唯一上游 fetch 入口（显式传 undici dispatcher + keepalive）。**反直觉契约**：Bun 下 GHC https 热路径走内建 `node:http2`（`http2-client.ts`）而非 undici（undici-on-Bun 对 h2 chunked 响应永久挂，见 `docs/bun-runtime-timeout.md`）；明文 http 才走 undici 子路径。**崩溃安全契约**：`http2Fetch` 返回的 promise 挂防御性 no-op rejection observer（`withRejectionObserver`）——pre-response abort 在 promise 已被遗弃（无 awaiter，如 await 链经他路先 settle）时 `reject` 否则会冒泡到 `main.ts` 的 `unhandledRejection`→`exit(1)` 把一条取消放大成整服务器崩溃；observer 标记已观察但不消费（真实 awaiter 仍独立收到 reject）。详见 [rfc/pre-response-abort-handling.md](rfc/pre-response-abort-handling.md) 缺陷⑤。 |

**格式适配域**

| 目录 | 职责 · 关系 · 契约 |
|---|---|
| `src/lib/anthropic/` | Anthropic 格式全栈（最大域）。子域：`src/lib/anthropic/sanitize/`（消息清洗管道，payload-level 请求改写 `payload-rewrites.ts` 被 codec S3 wrapper + web_search 旁路共享）、`src/lib/anthropic/recover-tool-call/`（tool-call 文本降级透明恢复，CANDIDATE/COMMIT + 非流式 helper，被 A1 响应改写包装）、`src/lib/anthropic/web-search/`（双跳旁路 orchestrator + backends）、thinking 处理（signature 自包含→块级保护）。`request-preparation.ts` 是 B1–B12 wire 准备；`pipeline.ts` 现仅 web_search 双跳复用 `executeRequestPipeline`。 |
| `src/lib/openai/` | OpenAI 全栈（CC + Responses + embeddings + 上游 WS）。`src/lib/openai/translate/` 是 CC↔Responses 翻译核（被 openai-cc/gemini codec 消费）；`upstream-ws*` 是上游 WebSocket 传输（半开熔断 + 回退）；`stream-error.ts` 把流式生命周期错误映射为 OpenAI SSE `error.type`（CC/Responses 共享）。 |
| `src/lib/gemini/` | Gemini 薄翻译层（request/response/stream convert + schema normalize + tool-call pairing），被 `codec/openai-gemini` 消费、翻成内部 CC 后复用 CC 全链。 |
| `src/lib/auto-truncate/` | 响应式 auto-truncate 引擎（token 限制学习 + 预检查），被 anthropic/openai 各自适配层消费。 |

**状态 / 观测 / 存储**

| 目录 | 职责 · 关系 · 契约 |
|---|---|
| `src/lib/observability/` | 请求生命周期 + 系统日志 event-bus + sinks（见 `docs/rfc/observability-rewrite.md`）。`bus` 同步 fan-out scoped publisher；`sinks/`（console/file/history/telemetry/ws）订阅消费；`projections/` 渲染日志行（**provenance**：取代已删的 `lib/tui/`）。**反直觉契约**：`republish.ts` 是**唯一 consola hijack 点**（每条日志→`system.log` 事件投 bus，重入守卫断 disk-full→日志风暴的环）。 |
| `src/lib/history/` | 请求/响应持久化（SQLite）。子域：`src/lib/history/sqlite/`（head/stage 拆表 + zstd L3 + magic-bytes 新旧判别 + request_group 合并帧 dedup + reaper 分桶淘汰 + 启动 VACUUM + WAL checkpoint + trigram FTS5 子串搜索 + 启动 ANALYZE/reaper `PRAGMA optimize` 统计）。**反直觉契约**：`persist-guard.ts` 的 `runHistoryWrite` 取代旧盲 `try/catch→warn`（分类 transient/permanent + ERROR 日志 + per-stage:class 计数）；finalize 无损（写成功才 removeInFlight，失败保留 in-flight 待 reaper 重试）；**`entries_v2.pinned` 是 debug-pin 标志（`setEntryPinned` 经 `POST /history/api/entries/:id/pin|unpin` 切换）——pinned 行与 active 行同属 reaper「桶外」豁免（reaper SUCCESS/FAILURE_WHERE 各带 `AND pinned=0`，故既不被淘汰、也不计入 success/failure 保留名额），且故意不进 INSERT/UPSERT 列表（首插取 DEFAULT 0、后续 eager 状态 upsert 不重置它）**；**`entries_fts` 是 external-content trigram FTS5（`MATCH` 做 ≥3 字符子串搜索、<3 走 LIKE 回退），靠 entries_v2 的 AFTER INSERT/UPDATE/DELETE 触发器同步——故 reclaim 计数改用 SELECT COUNT 而非 `.run().changes`（触发器写入会被 bun:sqlite 计入 changes）**。`store.ts` barrel 同时是前端 `~backend/*` 公开 type API。 |
| `src/lib/context/` | `RequestContext` 状态机 + 活跃请求 manager + stale reaper + activity-summary，被 driver/handler/observability 跨域消费（in-flight 跟踪）。 |
| `src/lib/config/` | config.yaml 类型/加载/热重载/校验。`compat` 迁移废弃配置键；`paths` 解析 `APP_DIR`（尊重 `XDG_DATA_HOME`）派生 DB/日志路径。热重载语义见下文。 |
| `src/lib/models/` | Model 解析（别名→规范名→overrides→family 回退）+ Copilot models API + capabilities + 后台 refresh + tokenizer。详见 `docs/model-resolution.md`。 |
| `src/lib/token/` | Copilot/GitHub token 生命周期 + `providers/`（cli/device-auth/env/file 多源）。详见 `docs/authentication.md`。 |
| `src/lib/ws/` | 共享 WebSocket adapter（Node/Bun 分流）+ topic-aware broadcast 总线（history/status/shutdown 统一推送）。 |
| `src/lib/request/` | **旧** v4-pre 重试管道（`executeRequestPipeline` 策略模式）；现仅 web_search 双跳消费本体，`strategies/`（重试策略集）经 `pipeline/legacy-strategy-adapter` 被 v4 driver 复用。见上「活的架构现状」。 |
| `src/lib/error/`、`src/lib/system-prompt/` | 单文件已升为子目录。`error/`：HTTPError + classify/forward/parsing（Retry-After 解析）。**反直觉契约**：`forward.ts` 的 `forwardError` 不把 abort 落 500 catch-all——`isAbortError` 命中后按 `c.req.raw.signal.aborted` 分流：客户端断开→499、上游响应头超时→504（判别**不靠 error.name**，因 `http2-client` 合成的 AbortError 抹掉了 `AbortSignal.timeout` 的 TimeoutError 身份）；pre-response 客户端断开在 `messages/handler-v4.ts` 的 catch 里记 `aborted` 终态（非 `failed`）。详见 [rfc/pre-response-abort-handling.md](rfc/pre-response-abort-handling.md)（③ pre-response 保活待 Q2 实测）。`system-prompt/`：override 应用（config 规则）+ `<system-reminder>` 标签解析。 |

**顶层裸文件（仅点名有跨文件关系者）**

| 文件 | 职责 · consumed-by |
|---|---|
| `src/lib/serve.ts` | Bun/Node HTTP 服务器分流**入口**（`globalThis.Bun` 判别 → `Bun.serve()` / `@hono/node-server`），被 `src/start.ts` 消费。 |
| `src/lib/tool-name-mapper.ts` | tool name 清洗/还原映射，**跨域共享**：codec + anthropic/openai 两条 sanitize 链 + context + routes。 |
| `src/lib/abort-bridge.ts` | client abort → 上游 AbortSignal 桥接，被全部 v4 handler + web-search-handler 消费。 |
| `src/lib/adaptive-rate-limiter.ts` | 3 模式自适应速率限制（Normal/Rate-limited/Recovering），stateful singleton，在 transport 内消化 429。 |
| `src/lib/stream.ts`、`src/lib/shutdown.ts`、`src/lib/state.ts` | 通用流工具（raceIteratorNext/combineAbortSignals）/ 优雅关闭（drain + abort）/ 全局运行时状态。详见 `docs/shutdown.md`。 |
| `src/lib/request-telemetry.ts` | **持久运营遥测的 dimension/measure registry 框架**（per-process `dimSinceStart` + 5min×7d 持久 `dimBuckets`，独立 JSON 文件、不随 SQLite GC 蒸发）。**反直觉契约**：维度提取下沉到 sink 层（`observability/telemetry-dimensions.ts`，entry/ctx in-scope），本文件只收 key-bag（type-light，只 import `UsageData`）；counters 是**开放 bag**（measure=数据非 schema），持久 envelope V3 泛型迭代所有维度（加维度/measure 零版本 bump，未知维度 forward-compat round-trip）；`dimSinceStart` 加载后保持空（进程生命周期）。被 `observability/sinks/telemetry.ts` 写入、`routes/status` (model 摘要) + `routes/stats`（`/api/stats` 泛型 breakdown）+ `metrics-exposition`（`/metrics`）+ 前端 dashboard 消费。capped 维度（model/client/tool，key 取自 client 可控输入）基数有界（≥200 并入 `"other"`，per-store 解析、抗重启），成本 per-token-type（`tokens × ctx.multiplier`）。**分布直方图**（`HISTOGRAMS` registry：duration_ms/queue_wait_ms/input_tokens/output_tokens）per-(dim,key) 存进开放 bag 的 `__histograms` sibling（零版本 bump、旧 V3 文件无损升级），breakdown 投影 p50/p90/p95/p99，`/metrics` 出标准 Prometheus histogram。设计见 [rfc/operational-stats-and-lineage-removal.md](rfc/operational-stats-and-lineage-removal.md) + [rfc/telemetry-histograms.md](rfc/telemetry-histograms.md)。 |

> 纯工具裸文件（`utils.ts`/`atomic-fs.ts`/`fetch-utils.ts`/`copilot-api.ts`/`proxy.ts`/`process-identity.ts`/`codex-config.ts`/`repetition-detector.ts`/`upstream-diagnostics.ts`）不入图——文件名自明、无跨文件关系。

**图维度规则（维护约定，DESIGN.md 自约束）**：每节点 ≤2 行；三问命中 ≥1 才入图——① provenance/演进（怎么来的、取代了什么）② consumed-by/契约（谁跨域消费、对调用方的不变量）③ 反直觉决策（与朴素预期相反、不读注释会踩坑）。纯复述文件名 / barrel re-export / 纯工具函数**不入图**；叶子文件清单交 `git ls-files src/lib` / codemap 派生，**绝不在此手列**（手列叶子是高 churn + 低密度 + 必然漂移成死条目，由 `tests/infra/design-doc-tree.unit.test.ts` L1 守卫挡死条目复发）；**字段级配置指针归 [运行时选项](#运行时选项) 配置表，不在模块图复述**。粒度：≤~12 文件单职责→目录级；>20 文件或多子职责→子目录级（anthropic/history/openai）。

### 路由

#### OpenAI 兼容端点

所有 OpenAI 端点同时注册在无前缀、`/v1` 前缀和 `/openai/v1` 前缀下。

| 路由 | 说明 |
|------|------|
| `/chat/completions`、`/v1/chat/completions`、`/openai/v1/chat/completions` | OpenAI Chat Completions API |
| `/models`、`/v1/models`、`/openai/v1/models` | 模型列表（OpenAI 兼容格式：基线字段 `id`/`object`/`created`/`owned_by` 不变，附加 `display_name`/`context_window`/`max_input_tokens`/`max_output_tokens`/`vision`/`tool_calls`/`parallel_tool_calls`/`reasoning_effort`/`family`/`vendor` 信息字段） |
| `/models/:model`、`/v1/models/:model`、`/openai/v1/models/:model` | 单个模型详情（同上扩展字段） |
| `/embeddings`、`/v1/embeddings`、`/openai/v1/embeddings` | OpenAI Embeddings API |
| `/responses`、`/v1/responses`、`/openai/v1/responses` | OpenAI Responses API（HTTP POST + WebSocket GET） |

#### Azure OpenAI 兼容端点

经典部署格式——模型名在 URL 路径中，`api-version` query parameter 被忽略。

| 路由 | 说明 |
|------|------|
| `/openai/deployments/:deployment/chat/completions` | Azure 经典格式 Chat Completions（deployment → model） |
| `/openai/deployments/:deployment/embeddings` | Azure 经典格式 Embeddings |
| `/openai/deployments/:deployment/responses` | Azure 经典格式 Responses |

#### Anthropic 兼容端点

| 路由 | 说明 |
|------|------|
| `/v1/messages`、`/anthropic/v1/messages` | Anthropic Messages API |
| `/v1/messages/count_tokens`、`/anthropic/v1/messages/count_tokens` | Anthropic Token 计数 |
| `/anthropic/v1/models` | Anthropic 形状的模型列表（`ModelInfo` + `ModelCapabilities`，过滤 `vendor=Anthropic`） |
| `/anthropic/v1/models/:id` | Anthropic 形状的单个模型详情（仅 Anthropic 厂商；非 Anthropic 或不存在 → 404） |

#### Google Gemini 兼容端点

| 路由 | 说明 |
|------|------|
| `/v1beta/models/:model:generateContent` | Gemini 非流式生成（翻译为内部 OpenAI 格式后走通用管线） |
| `/v1beta/models/:model:streamGenerateContent` | Gemini 流式生成（SSE） |
| `/v1beta/models/:model:countTokens` | Gemini Token 计数（基于 `gpt-tokenizer` 估算） |

#### 管理 API

| 路由 | 说明 |
|------|------|
| `/api/models` | 模型列表（内部格式：完整 Copilot 模型数据） |
| `/api/models/:model` | 单个模型详情（内部格式） |
| `/api/status` | 服务器状态（含 `requestTelemetry` 的 **model 维度摘要**——运营 stats 的其余维度故意不塞此 health-poll，见 `/api/stats`） |
| `/api/stats` | 运营 stats：`?dimension=<model\|endpoint\|client\|agentKind\|tool\|…>&window=<sinceStart\|7d>&limit=<N>` 返回任意注册维度的泛型 breakdown（server-side top-N + `"other"`）。持久 telemetry registry（`lib/request-telemetry.ts`）的唯一泛型读出口。设计见 [rfc/operational-stats-and-lineage-removal.md](rfc/operational-stats-and-lineage-removal.md) |
| `/api/tokens` | Token 信息 |
| `/api/config` | 配置信息 |
| `/api/config/yaml` | config.yaml 编辑 |
| `/api/logs` | 请求日志 |
| `/api/event_logging` | Anthropic 事件日志（静默消费） |
| `/api/debug/dry-run-truncate` | 离线 dry-run：复用真实 tokenize+truncate 函数（短路发 GHC），并排返回三套 token 口径（gpt-tokenizer / char÷4 / 上游报告值）+ pre-check + 截断结果。输入为内联 payload 或已存 history entry（`entryId`） |
| `/api/debug/dry-run-pipeline` | 离线 pipeline dry-run（**全格式 anthropic/openai-cc/openai-responses/openai-gemini，请求侧 + 响应侧**）：把合成/回放的请求或上游响应喂进真实 v4 driver，短路 GHC，按 `stopAfter` 输出选定阶段中间态。**请求侧**（`stopAfter` ∈ parse/translate/rewrite-in/prepare-wire）每格式真实 codec + `inspectRequest`（capturing manager 隔离 `codec.parse` 的 `manager.create`；Gemini 镜像 route 的 Gemini→CC 翻译预步）。**响应侧**（rewrite-out/render）真实 S5 改写链（Anthropic 5 / Responses 1 fixIds / CC+Gemini 空→`rewritesAvailable:false`）+ per-rewrite frameActions 采样；`stopAfter=rewrite-out` 经 driver `skipRender` 输出 pre-render S5 帧。输入 `entryId`（从 `endpoint` 推导 format；`sseEvents[].raw` 流式 / `outboundResponse` 重建非流式）或 inline 合成。手工 env + 无 publisher 捕获 ctx → 零 history/WS 污染；`fidelity.caveats` 逐格式诚实标注 driver 输出≠客户端实收（Gemini render 出 CC 非 Gemini / Responses 缺 post-render restore / Anthropic 缺 heartbeat / prepare-wire 仅首个 attempt）。设计见 [rfc/pipeline-dry-run-inspector.md](rfc/pipeline-dry-run-inspector.md) |

#### 基础设施

| 路由 | 说明 |
|------|------|
| `/health` | 健康检查（容器编排用） |
| `/metrics` | **Prometheus 文本 exposition**（v0.0.4）——telemetry registry 的通用投影 `copilot_api_*_total{dimension,key}` counters + **标准 Prometheus histogram**（`copilot_api_<duration_ms\|queue_wait_ms\|input_tokens\|output_tokens>_bucket{le}`/`_sum`/`_count`，scraper 用 `histogram_quantile()` 自算分位）（与 `/api/stats` 同源、`sinceStart` 累积窗口；常开、零依赖、不引 OTel SDK）。`src/lib/metrics-exposition.ts` + `src/routes/metrics/route.ts`，设计见 [rfc/operational-stats-and-lineage-removal.md](rfc/operational-stats-and-lineage-removal.md) §6 + [rfc/telemetry-histograms.md](rfc/telemetry-histograms.md) |
| `/openapi.json` | **全 API 表面**的 OpenAPI 3.1 文档。两档保真度：管理 API（`/api/*`）经各 router `.openapi()` 的**精确 zod schema**；其余（OpenAI/Anthropic/Gemini/Azure compat、History REST、dry-run-pipeline、event_logging、health）经 `openAPIRegistry.registerPath()` 的**简单 open-object schema**（纯文档、不绑 handler、不校验，故 plain-Hono 路由原封不动照常工作）。根 app 改 `OpenAPIHono<BlankEnv>`；装配见 `src/routes/openapi.ts`（doc31+Scalar+管理 router 聚合）与 `src/routes/openapi-compat.ts`（compat/history/诊断的 registerPath）。vendor compat body 字段级细节查各厂商自有 spec |
| `/docs` | Scalar 交互式 API 文档页（消费 `/openapi.json`，与 Vue 前端 `/ui` 分离） |
| `/history/api/*` | History REST API（含 `POST /history/api/entries/:id/pin`、`.../unpin` 切换 debug-pin——pinned 条目豁免 reaper 淘汰+计数，返回更新后的完整 entry） |
| `/ws` | History WebSocket |
| `/ui/*` | History UI v3 静态文件 |

### 前端子项目

```
ui/
├── package.json       # 前端自有依赖与脚本（private bun workspace 成员）
├── src/types/         # 类型定义（re-export 自 ~backend/lib/history/store）
└── tests/             # 前端测试（bun test）
```

路径别名：后端 `~/*` → `src/*`，前端 `@/*` → `ui/src/*`，前端引用后端 `~backend/*` → `../src/*`。
前端类型统一从后端 re-export，不重复定义。
前端依赖与脚本由 **`ui/package.json` 自有**（bun workspace 成员，根 `package.json` 声明 `workspaces:["ui"]`、单一根 `bun.lock` hoist）：FE 运行时 + `vite`/`vitest`/`vue-tsc` 等构建测试 devDeps 都在 ui 下，ui 拥有自己的 `build`/`dev`/`typecheck`/`test` 脚本（cwd=ui，配置经 `import.meta.dirname` 自寻）。根脚本经 `bun run --filter copilot-api-ui <script>` 委派（`build:ui`/`dev:ui`/`typecheck:ui`/`test:ui` 入口名不变）。仓库级 dev 工具（`typescript`/`eslint` 及 FE eslint 插件/`tsdown`/`playwright`/`lint-staged`）仍在根——lint 是全树单一关注点。`~backend` 跨引用不变（vite alias 解析后端纯函数源码，无需 workspace 依赖声明）。

### 测试组织（按域 + 隔离后缀两维度）

后端测试按**两个正交维度**组织：

1. **功能域目录**（镜像 `src/lib/` 结构，按"被测模块"归属）：
   ```
   tests/
   ├── anthropic/  openai/  responses/  gemini/  models/  history/
   ├── config/  pipeline/  streaming/  shutdown/  context/  infra/
   ├── e2e/         # 真实网络/需 token（getE2EMode 门控，不进 offline 全集）
   ├── e2e-ui/      # Playwright（浏览器）
   ├── helpers/     # 共享测试基建（mock-fetch、state-fixture、test-bootstrap、factories、sse〔含 frameTypesInOrder/dataFramesOfType 解析〕、anthropic-frames〔composable SSE 帧 atoms〕、fake-clock〔确定性时钟〕、history-fixtures、ws-mock…）
   └── fixtures/    # 磁盘样本 payload
   ```
   归属规则：看被测行为所属的 `~/lib/<域>/` 路径，机械可判；新增 src 模块时测试自动有归属。`history/sqlite/` 镜像 src 子目录。

2. **隔离级别后缀**（控制"按速度跑"）：
   - `*.unit.test.ts` — 纯函数，无运行时
   - `*.it.test.ts` — 起 state/history runtime（useIsolatedRuntime/bootstrapTestRuntime/initHistory/setStateForTests）
   - `*.http.test.ts` — 起 Hono app 或 server（createFullTestApp/Bun.serve）

   于是域靠**目录**索引、速度靠**后缀**索引（`bun run test:unit` 只跑快测试）。

**脚本**（`bun run`，非 `npm run`——项目用 bun）：`test:backend` = `bun test .unit.test .it.test .http.test`，三后缀 OR 覆盖全部 offline、天然排除 e2e、新增域零枚举漂移。`test:unit`/`test:it`/`test:http` 按后缀跑；`test:e2e`/`test:e2e-ui`/`test:ui` 单列。

**隔离纪律**：bun 单进程跑全套件，全局单例（state、history、upstream-WS manager、`mock.module`）会跨文件泄漏。因此：测试用 DI/fetch-mock 而非 `mock.module`（仅 `tui-format` 的 picocolors 是已证良性的例外）；带 fs I/O 的测试（如 setup-claude-code）用注入的临时目录，绝不碰真实 `$HOME`。

**默认隔离 fixture（`useIsolatedRuntime`，2026-06 加）**：新增 `.it`/`.http` 测试**默认调 `tests/helpers/isolated-fixture.ts` 的 `useIsolatedRuntime()`**——一处入口给出全隔离：bootstrap runtime（history 走 `:memory:`）+ per-test state 快照/还原（吸收 `autoRestoreState`）+ afterEach 串行 reset 全部 module-global 单例（`RESETTERS` 表）+ upstream network guard（未 mock 的上游调用即 reject；`network:"passthrough"` opt-out）。**不要**同文件再叠加 `autoRestoreState()`（两个 restore 的快照时机不同会按注册顺序互相覆盖污染基线）。`useIsolatedRuntime` 已**完全取代并删除** `autoTestRuntime`（旧的 bootstrap+state 还原组合），凡需 runtime 的 `.it`/`.http` 测试都已迁过来；但 `autoRestoreState`/`autoRestoreFetch` 作为**独立 primitive 保留**，继续服务不需要全 runtime 的轻量纯-unit 测试（强行迁到 fixture 反而起多余 runtime，违 YAGNI）。**新增 module-global 单例时**：提供 `reset*ForTests` 导出并登记进 `RESETTERS` 表——L1 守卫 `tests/infra/resetters-complete.unit.test.ts` 枚举 src 全部 `*ForTest(s|ing)` 导出、断言每个 ∈ 表 ∪ 豁免清单，忘登记即 fail（无导出的游离 module-global 如曾经的 `rawModels` 守卫抓不到，故**必须**给它 reset 导出）。fs 隔离**不归 fixture**，归下面的 preload 地板（分层：地板管 fs 根，fixture 管进程内状态）。

**持久化路径地板防线**（2026-06 加）：`bunfig.toml` 的 `[test].preload`（`tests/helpers/sandbox-paths.ts`）在任何 src 模块算 `PATHS` 前把 `XDG_DATA_HOME` **与 `CODEX_HOME`** 重定向到 `mkdtemp` 临时目录，兜住**所有 APP_DIR 派生持久化**（negotiation/`history.db`/logs/learned-limits/telemetry）**及 `~/.codex/config.toml`**（codex 派生自 `CODEX_HOME` 非 `XDG_DATA_HOME`，只重定向 XDG 会留盲区）——`[test].preload` 只作用于 `bun test`、不影响 `bun run start`/生产。双守卫：`tests/infra/sandbox-paths.unit.test.ts`（静态断言 `PATHS.*` 落沙箱）+ `tests/infra/real-state-guard.it.test.ts`（动态行使 writer、断言写出文件落沙箱不落真实 home——mtime-diff 守卫会被常驻 live server 污染成假阳，故用 writer 落点反证）。逐测试 `PATHS.X = mkdtemp()` 或 `set*PathForTests` seam 注入仍是首选（更强隔离），preload 是兜底地板而非替代。**背景与全面重写设计**见 [rfc/test-env-isolation.md](rfc/test-env-isolation.md)（§11 为权威落地态）。

## 运行时选项

所有运行时状态集中在 `lib/state.ts`，通过 CLI 参数或 config.yaml 设置。

### 配置加载层级

`loadConfig()` 在每次调用时产生**生效配置 = bundled defaults 深合并 user overrides**（user 优先）：

1. **Bundled 默认** — 包根目录的 [`config.yaml`](../config.yaml)（`PATHS.BUNDLED_CONFIG_YAML`），随 npm 包发布；项目推荐的默认配置。
2. **用户覆盖** — `$XDG_DATA_HOME/copilot-api/config.yaml`（默认 `~/.local/share/copilot-api/config.yaml`，对应 `PATHS.CONFIG_YAML`），稀疏覆盖文件；缺省键自动回退到 bundled。

合并规则：
- 顶层嵌套 section（`anthropic` / `history` / `shutdown` / `openai_responses` / `rate_limiter` / `web_search` / `auto_truncate` / `timeouts`）— 按字段合并
- 自由形式 map（`model_overrides`、`anthropic.effort_overrides` 等）— 按 key 合并
- 数组与标量 — user 整体替换

代码里残留的硬编码（`CONFIG_MANAGED_DEFAULTS` / `DEFAULT_MODEL_OVERRIDES`）仅作为 bundled config 无法读取时的安全兜底。

### Hot-reload 语义（统一约定）

`config.yaml` 的字段在 `applyConfigToState()` 中按合并后的 effective config 应用，并保留 retain-on-absence 兜底：

- **用户键存在** → 替换运行时值
- **用户键缺省 + bundled 有该键** → 使用 bundled 值（深合并已注入）
- **用户键缺省 + bundled 也无该键** → 保留上次运行时值（兜底，避免空 bundled fixture 下意外清空）
- **集合显式为空**（如 `disabled_models: []`、`model_overrides: {}`）→ 清空
- **回到内置默认** → 删除用户文件中的对应键即可；下次 reload 自动从 bundled 取值。`PUT /api/config/yaml` 仍调用 `resetConfigManagedState()` + 重新 apply 全表以保证幂等

不参与 hot-reload 的字段（修改需重启）：
- `proxy` — `initProxy()` 在 `start.ts` 启动期执行一次
- `ghc_api_base_url` — 在 `start.ts` 启动期读取一次；mid-flight 切换上游会让进行中的请求路由错位
- `rate_limiter.*` — `AdaptiveRateLimiter` 是 stateful singleton，启动期构造

完整字段覆盖由 [tests/config/config-hot-reload.it.test.ts](../tests/config/config-hot-reload.it.test.ts) 的表驱动测试 + 完整性守卫验证；新增字段未登记到测试矩阵或豁免清单会立刻 fail。

| 选项 | 来源 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `autoTruncate` | `--auto-truncate` / `--no-auto-truncate` / config `auto_truncate.enabled` | boolean | `false` | 响应式 auto-truncate：限制错误时用截断 payload 重试。CLI flag 显式传入时覆盖 `enabled`；支持热重载（off→on 时懒加载 learned limits）。strategy 用与 truncate 内部同源的 gpt-tokenizer 计数，并把上游报告的 limit 按 `current/gptCount` 比例换算到 gpt 口径再截断（消除口径错配，详见 [request-pipeline.md](request-pipeline.md)） |
| `autoTruncateTargetFactor` | config `auto_truncate.target_factor` | number | `0.9` | 截断目标 = 上游报告 limit × factor。范围 (0, 1]，越小越激进（删更多）/越安全，越大越省 token 但更贴近 limit。0 非法 |
| `autoTruncateMaxRetries` | config `auto_truncate.max_retries` | number | `5` | 单请求最大响应式截断重试次数。0 = 仅一次尝试、不重试 |
| `autoTruncateCompressThreshold` | config `auto_truncate.compress_threshold` | number | `10000` | tool_result 内容压缩的字符长度阈值（非 token）。0 = 全部压缩 |
| `compressToolResultsBeforeTruncate` | config `auto_truncate.compress_tool_results` | boolean | `true` | 截断消息前先压缩旧的 tool_result 内容 |
| `sanitizeToolNames` | config `sanitize_tool_names` | boolean | `false` | 按目标模型约束清洗非法/超长/冲突 tool name 发往上游，响应里还原客户端原始名（跨 Anthropic + Chat Completions + Responses 三条路径，顶层标量） |
| `stripServerTools` | config `anthropic.tool_strip_server` | boolean | `false` | 全局无条件剥离请求中的服务端工具（web_search 等）。注：实际剥离集合是**三源并集**——本全局开关 ∪ 反应式学习的 negotiation 账本（`server-tool-rejection-retry` 策略捕获上游 400「web search tool is not supported」后写入 per-(endpoint,model)）∪ 单次重试 hint（`PrepareHints.excludeServerToolTypes`）。即使本开关为 `false`，被上游拒绝过的 server tool 仍会对后续同模型请求 pre-emptively 剥离。详见 [v4/03-spec/server-tool-rejection-retry.md](v4/03-spec/server-tool-rejection-retry.md) |
| `stripPartnerFeatures` | config `anthropic.partner_strip_features` | `Record<string, string[]>` | `{}` | per-model 声明上游 org policy 禁用的 **partner-model 特性名**（目前仅 `structured_outputs` → 剥 `output_config.format`）。是反应式 negotiation `partnerFeatures` 账本的 **config 孪生**：prepare 步 `strip-structured-outputs` 取「config ∪ 账本」并集（与 `beta_strip_headers` ∪ beta 账本同构）。键 `"*"` 应用到所有模型。声明后**首发即剥**，免一次 400 学习往返 + 降级 warn（`structured-outputs-rejection-retry` 策略仍反应式学习未声明的）。结构对齐 `beta_strip_headers`；将来 Vertex 再禁别的 partner feature，扩展只需加 feature→剥离动作映射。详见 [v4/03-spec/retry-transport.md](v4/03-spec/retry-transport.md) |
| `recoverToolCallText` | config `anthropic.tool_recover_call_text` | boolean | `false` | 透明恢复上游 tool-call 文本降级（`call<invoke>…` 纯文本无 tool_use block）：检测后重建为标准 tool_use block 转发给客户端。流式（CANDIDATE/COMMIT 两阶段）+ 非流式双路径；仅作用于 forwarded 流（history 保留上游降级原貌）。按 stop_reason 分两档检测（A=tool_use 协议矛盾强信号 / B=end_turn 弱信号需残留+终结门控）+ whitespace-tolerant 位置不变量防 content 含 `</parameter>` 字面量腰斩。详见 [tool-call-text-recovery.md](rfc/tool-call-text-recovery.md)。注：合成 tool_use 经下游 serverToolFilter 还原 name |
| `recoverRefusalText` | config `anthropic.refusal_recover_text` | boolean | `false` | 拦截上游 **thinking-only refusal**（`stop_reason:"refusal"` 仅有 thinking 块、无 text/tool_use——opus-4.8 思考后拒绝）：**追加**一个合成 text 块（说明被拒、建议换表述/拆步/换模型）+ 把 `stop_reason:"refusal"→"end_turn"`（清 `stop_details`），否则客户端拿到空/坏轮、工作流卡死。门控=refusal 且无真内容（thinking-only/空）；refusal 带真内容或非 refusal 一律透传。**不剥** thinking 块（有效签名自包含、原样回放被上游接受，非「双空块」毒；流式剥离需缓冲整段 thinking=活 UX 回归）。第 5 条 ResponseRewrite（`order 400`，跑最后），流式在 message_delta 边界注入合成帧（无缓冲、零延迟）+ 非流式 `transformWhole` 整体改写；仅作用于 forwarded 流（history 的 `sseEvents` 保留上游原始 refusal）。详见 [refusal-recovery.md](refusal-recovery.md) |
| `streamKeepalivePingSec` | config `anthropic.stream_keepalive_ping_sec` | number | `45` | 客户端方向 SSE 合成 keepalive `event: ping` cadence 秒数（0=禁用）。**默认 45（旧 `stream_fake_sse_heartbeat`/120 已重命名+降值，compat 自动迁移）**——Claude Code 请求超时是 idle 型 ≈60s（exp/q2-oracle Q2 实测，非旧稿 258s），cadence 必须 <60s 才有效，120s 防不住断线。>0 时距上次真实转发帧 ≥N 秒注入一帧 ping，覆盖 **mid-stream 间隙**（opus-4.8 adaptive thinking 在 `content_block_start` 后停滞）**+ ③ pre-response-grace commit 后保活**（commit 路径 0 时 floor 30s）。**不重置上游 idle-timeout**——上游真死仍按 `timeouts.stream_idle` 失败。心跳只记入 `forwardedSseEvents`(客户端实收侧),不污染原始 `sseEvents`。所有写入串行化避免字节交错 |
| `streamKeepaliveGraceSec` | config `anthropic.stream_keepalive_grace_sec` | number | `40` | **③ pre-response 延迟-commit grace 窗口秒数**（0=禁用 ③，完全 bypass race=现状）。`stream:true` 请求 race `runRequest` vs grace timer：grace 内上游回头→现状路径（真 HTTP 状态、零发散）；grace 耗尽上游仍静默（opus pre-response 长思考）→ COMMIT（开 200 SSE + 立即 ping + `streamKeepalivePingSec` cadence 保活），POST-COMMIT 上游错误降级成富 SSE error 帧（保 `error.type`/`retry_after`，Q2 裁决可接受残余）。**必须 <60s**（CC idle 阈值,实测）。per-request 读、热重载（`setAnthropicBehavior`）。详见 [rfc/pre-response-abort-handling.md](rfc/pre-response-abort-handling.md) §4 + [exp/q2-oracle/REPORT.md](../exp/q2-oracle/REPORT.md) |
| `protectStreamingGeneration` | config `anthropic.protect_streaming_generation` | `false \| "on" \| "tool_use_only"` | `false` | **L2 事务化缓冲重试**(仅 Anthropic 流式):opus-4.8 在超大上下文生成大 Write/Edit 时,上游 GHC 在活跃流中途发 `RST_STREAM(NGHTTP2_CANCEL)` 砍断(请求级中止,非 idle/keepalive/固定墙)。官方客户端(GHC 扩展、Claude Code SDK)都不保护 mid-stream RST;代理靠 `abort-bridge` 能确定性区分"客户端取消 vs 上游 RST",处独有保护位。`on`=缓冲整响应、`message_stop`(或 H2 上游 error 帧)后才 commit flush 给客户端,transport-close/truncation 则丢弃 buffer 回 S4 重取新流重来,上限 `protect_streaming_max_retries`,all-or-nothing(绝不转发半截生成);`tool_use_only`=仅请求带 tools(大 Write/Edit 场景)才缓冲、纯文本对话仍 live;`false`=live 流式(默认,逐字节同 L2 前)。handler 经 `runResponseBufferedSink`(`driver.ts`),H2 终止 error 帧由 `sawUpstreamError` 与 RST-truncation 区分(commit 而非重试,保留原始 error 语义)。失败尝试上游帧逐尝试留痕(D1,见 history `attempts[].sseEvents`)。**暂缓**(RFC §11 Phase 3/4):buffer 上限 `protect_streaming_buffer_cap_bytes`(超限退回 live、防病态超大响应 OOM)、escalation(重试收紧 context_management)、重试命中率遥测。设计见 [rfc/streaming-upstream-rst-buffered-retry.md](rfc/streaming-upstream-rst-buffered-retry.md) |
| `protectStreamingMaxRetries` | config `anthropic.protect_streaming_max_retries` | number | `3` | L2 缓冲路径的 transport-close/truncation 重试上限。**loop/成本闸,非超时闸**——客户端由强制 heartbeat 无限保活缓冲期(Claude Code 258s 已实证是 idle 超时),N 的唯一作用是给"对 GHC 必然超预算"的请求一个有限放弃点。`0`=不重试(退回现状 live)。调大只增偶发 RST 的命中机会,对必然超预算请求只多烧时间 |
| `protectStreamingHeartbeat` | config `anthropic.protect_streaming_heartbeat` | number | `15` | L2 缓冲路径的**强制** heartbeat 间隔秒数。buffered 路径在 `message_stop` 前不发任何真实帧,客户端会 idle 断,故无条件构造心跳:`streamKeepalivePingSec>0` 时取其值、否则用本值兜底。**注**:本值设 0 且 `streamKeepalivePingSec` 也 0 时,buffered 缓冲期无保活心跳、客户端会早断(配置自伤,applyConfigToState 会 warn-once)。**留在 protect_streaming_* 族（L2 buffered 专用，未并入 stream_keepalive_* keepalive 族）** |
| `protectStreamingBufferCapBytes` | config `anthropic.protect_streaming_buffer_cap_bytes` | number | `16777216` | L2 缓冲路径内存守卫:累计渲染帧字节超此值时 ABANDON 缓冲、flush 已缓冲前缀 + 后续帧 live 写穿(retreat)。该响应失去 L2 保护(live RST 仍失败)且不重试(帧已转发)。`0`=无限。防病态超大单次生成 OOM(buffer 每尝试重置,峰值=单次生成体积非 N× 累加) |
| `protectStreamingEscalateContext` | config `anthropic.protect_streaming_escalate_context` | boolean | `false` | L2 重试时 FORCE 渐进激进的原生 `clear_tool_uses` context_management(trigger 每轮减半至 4096 floor、keep tool_uses 每轮 -1 至 1),压缩上下文让生成更快、更可能在下次 RST 窗口前完成(针对"对 GHC 必然超预算"类请求,RFC §8)。独立于 `context_editing` 配置(retry-only 应急压缩);尊重 `modelSupportsContextEditing`(不支持则安全降级 no-op、不 400)+ 补 `context-management-2025-06-27` beta header;不 override 客户端自带 context_management。默认关(opt-in,建议遥测证实裸重试命中率低后再开) |
| `contextEditingModels` / `toolSearchModels` / `interleavedThinkingModels` / `adaptiveThinkingModels` | config `anthropic.model_capabilities.{context_editing,tool_search,interleaved_thinking,adaptive_thinking}` | `string[]` | 镜像 GHC 的出厂名单 | **模型能力名单(配置驱动)**。各一组模型名"族前缀"(归一化:小写、dot→dash);模型具该能力当且仅当其归一化 id **=== 某前缀 或 startsWith(前缀+"-")**——故 `claude-opus-4` 匹配 bare `claude-opus-4` 与整个 `claude-opus-4-x` 族,但**不**匹配无关的 `claude-opus-40`(尾 dash 边界)。`features.ts` 的 `modelSupportsContextEditing`/`modelSupportsToolSearch`/`modelSupportsInterleavedThinking` + `modelHasAdaptiveThinking` 的名单兜底全从此读,**新 Claude 版本上线只需改配置、不改代码**(此前 opus-4.8 被漏两次的根因即硬编码逐版本名单)。出厂默认镜像官方 GHC `chatModelCapabilities.ts`/`anthropic.ts` 的判定。前缀可写 dot 或 dash 形态。retain-on-absence;空列表 `[]` 禁用该能力。**metadata-first(对齐 upstream `chatEndpoint.ts`)**:`context_editing`/`tool_search`/`adaptive_thinking` 先读模型 `/models` 的 `capabilities.supports.{context_editing,tool_search,adaptive_thinking}`(GHC 声明则用其布尔值、`false` 也尊重),metadata 缺失才回退本名单——Copilot `/models` 当前只暴露 `adaptive_thinking`,故另两个今日恒走名单,但 GHC 一旦声明即自动认、无需改码。`interleaved_thinking` 为名字-only(upstream 无对应 metadata 键) |
| `thinkingBlockMessagePolicy` | config `anthropic.thinking_block_message_policy` | `"preserve" \| "stripped"` | `"preserve"` | 含 thinking blocks 的 assistant 消息处理策略。Anthropic thinking signature **自包含**(加密 thinking 内容本身,与上下文/位置无关——已通过 opus-4.8 实测验证),故保护是**块级**而非消息级。`preserve`=保留 thinking 块逐字不变 + 不重排连续 thinking,但允许周围一切清理(删孤儿 tool、降级 server tool、编辑/删非 thinking 块);`stripped`=主动从旧消息删 thinking 块。旧值 `immutable`/`fixed-index` 由 [compat.ts](../src/lib/config/compat.ts) 自动迁移到 `preserve` |
| `thinkingBlockSanitizeCheck` | config `anthropic.thinking_block_sanitize` | `false \| "empty_thinking" \| "empty_any"` | `"empty_thinking"` | 发送上游前剥离损坏的 thinking block。有效性由 **signature** 判定（合法加密 thinking 文本为空但有有效 signature，永远保留）。`empty_thinking`=仅移除双空块（thinking 文本与 signature 都空）；`empty_any`=移除任何 signature 为空的 thinking block |
| `coerceAdaptiveThinking` | config `anthropic.thinking_coerce_adaptive` | `false \| "basic" \| "best_effort"` | `"basic"` | 旧版 thinking 适配：仅支持 adaptive 的模型（opus 4.6/4.7/4.8）收到旧版 `thinking.type="enabled"` 时强制转为 `"adaptive"`，解决上游 400。`basic`=转为纯 adaptive 丢 budget_tokens（对齐 GHC）；`best_effort`=并把 budget_tokens 启发式换算为 `output_config.effort`（仅客户端未显式发 effort 时）；`false`=透传不改写。双层防御：prepare 预检（元数据+模型名兜底）+ 反应式 `legacy-thinking-retry` strategy（捕获 400 自愈） |
| `thinkingSignatureCompat` | config `anthropic.thinking_signature_compat` | `false \| "signature_delta" \| "redacted_thinking"` | `"signature_delta"` | 客户端兼容 shim：部分 Copilot 上游的非标准 thinking 帧——`content_block_start{type:"thinking", thinking:"", signature:S}` 紧跟 `content_block_stop`、**无 signature_delta**。上游才是协议权威；标准客户端（Claude Code/SDK）只从 `signature_delta` 取 signature、忽略 start 上的 signature 字段，故会丢签名并回传 `{thinking:"", signature:""}` 双空块被上游拒。本配置**仅作用于客户端转发流**对该帧重整形（history 的 `sseEvents` 保留上游原始帧，shim 体现在 `inboundResponse.sseEvents`）。`signature_delta`=拆成空 thinking start + 合成标准 signature_delta（默认，贴合协议）；`redacted_thinking`=改写为 `redacted_thinking{data:S}`（与客户端回传形态殊途同归）；`false`=透传。仅流式路径（非流式 JSON 里 signature 字段客户端直接可读，无需 shim） |
| `systemMessagesSanitize` | config `anthropic.system_messages_sanitize` | `false \| "drop_invalid" \| "merge" \| "as_user" \| "as_assistant"` | `false` | 处理 `messages` 数组里混入的 `role:"system"` 消息——Anthropic Messages API 不接受（system 须为顶层参数），否则上游回 `Unexpected role "system"` 400。这类 inline system 来自 OpenAI 习惯客户端或 Claude Code 中途注入的 system 级上下文（hook 输出/规则/提醒）。`as_user`=改 role 为 user 保留对话位置（**推荐**，对带位置语义的注入最忠实）；`merge`=提取文本追加到顶层 system 并删消息（破坏时序、巨大化、显著降低 prompt cache 命中）；`drop_invalid`=直接删除（丢失上下文）；`as_assistant`=改 role 为 assistant（**实验性、不推荐**——把注入上下文伪装成模型输出，且可能并入 tool 调用 turn）；`false`=透传（默认，存在时会 400）。在 `sanitizeAnthropicMessages` 内于 `removeAnthropicSystemReminders` 之后执行；转换模式复用相邻同 role 合并（保护带签名 thinking）+ `ensureAnthropicStartsWithUser` 保证 messages[0] 合法；提取文本为空一律 drop，不产生空 content。`count_tokens` 与 web_search 双跳路径同样应用 |
| `rewriteHistoryServerTools` | config `anthropic.tool_rewrite_history_server` | `false \| "downgrade"` | `false` | 改写消息历史里残留的 native server-tool block（`server_tool_use{*}` + 配对 `*_tool_result`）。web_search 双跳故意把合成的 `server_tool_use{web_search}` + `web_search_tool_result` 发给客户端（让搜索结果可见），客户端下一轮原样回传；但双跳会把 tools 里的 `web_search` 降级为普通 function tool，于是上游看到孤立的 server_tool_use 报 400（`references web_search but not defined as a server tool`）。`downgrade`=把这对降级为普通 `tool_use` + `tool_result`——因 `tool_result` 必须位于 user 消息（协议约束，对齐 `buildSecondHopMessages`），改写会**拆分 assistant turn**：`tool_use`（及 text/thinking）留在 assistant，`tool_result` 移到紧随的新 user 消息；`false`=透传（默认，残留 server_tool_use 时会 400）。按 block **type** 匹配（非 name），统一覆盖 web_search/web_fetch/code_execution 等所有 server tool。在 `sanitizeAnthropicMessages` 内于 `processToolBlocks` **之前**执行（让 tool 引用校验看到已降级形态）；含签名 thinking 的 `immutable` 消息整条早退不改写。**推荐与 `web_search.enabled` 同时开启**。仅作用于 wire payload——history `inboundRequest` 保留客户端原始形态 |
| `fetchTimeout` | config `timeouts.response_header` | number | `300` | 请求超时：请求开始到收到 HTTP 响应头的秒数（0 = 无超时） |
| `streamIdleTimeout` | config `timeouts.stream_idle` | number | `300` | 流空闲超时：连续 SSE 事件间最大等待秒数（0 = 无超时） |
| `upstreamKeepaliveDelay` | config `timeouts.upstream_keepalive` | number | `15` | 上游 TCP keepalive 首探针延迟秒数（0 = 用 undici 内置默认 60s）。设到上游连接路径的空闲回收窗口（NAT/防火墙/LB,常见 ~30s）以下,让内核在上游静默期周期性发 TCP 探针,持续重置中间设备的空闲计时器,避免连接在 opus 长 thinking 沉默期（`content_block_start` 后停滞几十秒~数百秒）被回收为 `terminated (cause: other side closed)`。undici 默认 60s 太长:~30s 回收时首探针尚未发出。经 `setTimeoutConfig` 应用并触发 undici dispatcher 重建（与 `fetchTimeout`/`streamIdleTimeout` 同机制,支持热重载）。**Bun 与 Node 均生效**——所有上游请求统一经 `upstreamFetch`（`transport/upstream-fetch.ts`）走 undici 并显式传 `getUpstreamDispatcher()` 的 dispatcher,故 Bun 全局 fetch 不消费 `setGlobalDispatcher` 的旧限制已不适用。**关键**:import 走 `undici/index.js` 子路径而非裸 `undici`——Bun 把裸 `undici` 替换为内建 shim,其 fetch 静默丢弃 dispatcher(keepalive 不生效);子路径绕过 shim 加载真 undici,Bun 下经 `ss` 实测确认 socket 带 `timer:(keepalive,...)`。pin **undici 7**:undici 8 的 index.js 顶层 eager 构造 CacheStorage,在 Bun 1.3.14 加载即崩。SOCKS 代理路径在自定义连接器内对隧道 socket 调 `setKeepAlive` 单独覆盖 |
| `modelRefreshInterval` | config `model_refresh_interval` | number | `600` | 模型列表后台刷新周期秒数（0 = 禁用） |
| `dedupToolCalls` | config `anthropic.tool_dedup_calls` | `false \| "input" \| "result"` | `false` | 去重重复的 tool_use/tool_result 对 |
| `toolSearchEnabled` | config `anthropic.tool_search` | boolean | `true` | 是否注入 Copilot `tool_search` 工具 |
| `cacheControlMode` | config `anthropic.cache_control` | `"disabled" \| "passthrough" \| "sanitize" \| "proxied"` | `"proxied"` | Cache control 处理模式：disabled=剥离、passthrough=透传、sanitize=清洗非标准字段、proxied=代理注入 |
| `nonDeferredTools` | config `anthropic.tool_non_deferred` | `string[]` | `[]` | 额外的不延迟工具名称列表 |
| `stripReadToolResultTags` | config `anthropic.tool_strip_read_result_tags` | boolean | `false` | 剥离 Read 结果中的 system-reminder 标签 |
| `decodeToolInputFields` | config `anthropic.tool_decode_input_fields` | `Record<string, string[]>` | `{ AskUserQuestion: ["questions"] }` | 响应侧将指定 tool_use 的指定顶层 input 字段从 stringified JSON decode 回结构化形式（仅改转发给客户端的流/响应，history 保持原始）。key 为工具名，逐字匹配不归一化；replace 语义 |
| `decodeAllToolInputFields` | config `anthropic.tool_decode_all_input_fields` | boolean | `false` | 对所有 tool_use 的所有顶层 string 字段尝试 decode（忽略上表）。`server_tool_use` 永不受影响 |
| `backfillQuestionFromHeader` | config `anthropic.tool_backfill_question` | boolean | `true` | 响应侧把 `AskUserQuestion` 工具调用里「有 `header` 但**缺** `question` 键」的 `questions[]` item 回填 `question = header`（Claude Code 客户端拒收缺 `question` 的 item，报「必须有 question」）。仅在 `question` 键缺失且 `header` 为非空字符串时触发；present-but-empty 不动。流式 + 非流式均生效，在 `decodeToolInputFields` 之后运行（先把 stringified `questions` 还原成数组再回填）。history 保留 upstream 原始形态 |
| `rewriteSystemReminders` | config `anthropic.system_rewrite_reminders` | `boolean \| Array<{from, to, method?}>` | `false` | 重写消息中的 system-reminder 标签 |
| `contextEditingMode` | config `anthropic.context_editing` | `'off' \| 'clear-thinking' \| 'clear-tooluse' \| 'clear-both'` | `'off'` | 服务端上下文编辑模式 |
| `contextEditingTrigger` | config `anthropic.context_editing_trigger` | number | `100000` | `clear_tool_uses` 的触发 token 阈值 |
| `contextEditingKeepTools` | config `anthropic.context_editing_keep_tools` | number | `3` | 清理后保留的最近 tool_use 对数量 |
| `contextEditingKeepThinking` | config `anthropic.context_editing_keep_thinking` | number | `1` | 清理后保留的最近 thinking turn 数量 |
| `historySuccessLimit` | config `history.success_limit` | number | `50` | SQLite 中保留的成功（非 failed）历史条目上限（0 = 无限制）。reaper 按状态分桶独立淘汰,失败请求刷屏不会挤掉成功历史 |
| `historyFailureLimit` | config `history.failure_limit` | number | `200` | SQLite 中保留的失败历史条目上限(0 = 无限制)。默认大于 success_limit——失败记录诊断价值更高。旧 `history.limit` 仍被接受为兼容键,缺省时 success/failure 回退到它 |
| `historyReaperInterval` | config `history.reaper_interval` | number | `600` | SQLite reaper 定期清理秒数（0 = 禁用），两桶共用 |
| `historyDbPath` | config `history.db_path` | string | `""` | 覆盖默认 SQLite 数据库路径（空字符串表示使用 `PATHS.HISTORY_DB`） |
| `webSearchEnabled` | config `web_search.enabled` | boolean | `false` | 启用 web_search 双跳实现（仅 Anthropic 路径）：拦截含 native web_search server tool 的请求，执行真实搜索后由主模型二次生成。**注意**：合成的 `server_tool_use{web_search}` 会回流到客户端历史，下一轮回传时若未配 `anthropic.tool_rewrite_history_server: "downgrade"` 会触发上游 400，建议同时开启 |
| `webSearchBackend` | config `web_search.backend` | string | `""` | 搜索后端：`""`=禁用、`searxng`=本地 SearXNG（`http://localhost:8080`）、其它非空=Copilot Responses 搜索模型 id（如 `gpt-5.5`） |
| `modelOverrides` | config `model_overrides` | `Record<string, string>` | opus→claude-opus-4.6 等 | Model 名称映射 |
| `shutdownGracefulWait` | config `shutdown.graceful_wait` | number | `60` | Phase 2 超时秒数：等待活跃请求自然完成 |
| `shutdownAbortWait` | config `shutdown.abort_wait` | number | `120` | Phase 3 超时秒数：发送 abort signal 后等待处理完成 |
| `staleRequestMaxAge` | config `timeouts.stale_request_max_age` | number | `600` | 活跃请求最大存活秒数（0 = 禁用）。**注**：reaper 当前只调 `ctx.fail()` 记终态，**不取消在飞上游 fetch**（force-fail 是装饰性的，请求实际滞留到 `response_header` 超时才真了结）——已知资源泄漏，正确「装牙齿」修法待 [rfc/pre-response-abort-handling.md](rfc/pre-response-abort-handling.md) 缺陷④ 实现 |
| `normalizeResponsesCallIds` | config `openai_responses.normalize_call_ids` | boolean | `true` | 将 Responses API input 中的 `call_` 前缀 ID 转换为 `fc_` 前缀 |
| `upstreamWebSocket` | config `openai_responses.upstream_ws` | boolean | `false` | 启用上游 WebSocket 传输（Responses API，仅模型支持时）。半开熔断 + 连续失败回退由 manager 处理；运行时状态在 `/api/status.upstream_ws` 暴露 |
| `fixResponsesStreamIds` | config `openai_responses.fix_stream_ids` | boolean | `true` | 修复 Copilot Responses 上游在 `response.output_item.added` 与 `.done` 之间 item ID 不一致的问题（`@ai-sdk/openai` 校验 ID 连续性需要） |
| `stripImageGenerationTool` | config `openai_responses.strip_image_generation_tool` | boolean | `false` | 从入站 Responses 请求中剥离 `image_generation` 内置工具（Copilot 上游拒收并整请求 400；Codex CLI 会自动注入）。剥离前 history 已 snapshot，因此 `inboundRequest.tools` 仍保留客户端原始数组 |
| `clientWebsocketKeepOpen` | config `openai_responses.client_ws_keep_open` | boolean | `false` | 客户端侧 Responses WS 在 `response.completed` 后保持连接以接受后续 `response.create`。false（默认）为 HTTP-like 一次性语义（code 1000 关闭） |
| `maxWsFrameBytes` | config `openai_responses.max_ws_frame_bytes` | number | `0` | 客户端侧 Responses WS 入站帧字节上限（默认 `0` = 无限制——代理不自我设限客户端输入，堆压力交部署边界/反代约束；设正值可 opt-in 硬上限） |
| `maxClientWsConnections` | config `openai_responses.max_client_ws_connections` | number | `256` | 客户端侧 Responses WS 并发连接上限（0 = 无限制）。约束 `client_ws_keep_open=true` 下的 fd 使用 |
| `maxUpstreamWsConnections` | config `openai_responses.max_upstream_ws_connections` | number | `32` | 上游 WS 连接池软上限（0 = 无限制）。达到上限且有 idle 时驱逐最旧 idle；全忙时记 warn 并分配 overflow |
| `ghcApiBaseUrl` | `--ghc-api-base-url` / config `ghc_api_base_url` | string | `""` | 显式覆盖上游 GHC API base URL；非空时优先于 `accountType` 派生的 URL。**修改需重启** |

## 模块文档

各子系统的详细设计文档：

| 文档 | 说明 |
|------|------|
| [authentication.md](authentication.md) | Copilot 认证、账户类型、Token 管理 |
| [sanitize-pipeline.md](sanitize-pipeline.md) | 消息清洗管道（2 阶段）、Tool blocks 处理 |
| [request-pipeline.md](request-pipeline.md) | 请求重试管道、错误分类、速率限制 |
| [model-resolution.md](model-resolution.md) | Model 解析、别名、Override 系统 |
| [tool-use.md](tool-use.md) | Tool Use 机制、server tools、tool_search |
| [anthropic-compat.md](anthropic-compat.md) | Anthropic API 兼容性、功能矩阵 |
| [gemini-compat.md](gemini-compat.md) | Gemini API 兼容性、客户端配置、限制 |
| [history.md](history.md) | History 系统、存储、WebSocket、Memory Pressure |
| [streaming.md](streaming.md) | 流式处理、WebSocket Transport、重复性检测 |
| [shutdown.md](shutdown.md) | 优雅关闭、请求生命周期、Stale Reaper |
| [bun-runtime-timeout.md](bun-runtime-timeout.md) | Bun 原生 fetch 内建 300s 超时陷阱、`timeout: false` 修复 |

## UI 设计原则

### Console UI（日志）

- **使用固定宽度 ASCII 前缀**对齐日志，不用 emoji/图标（如 `[....]`、`[<-->]`、`[ OK ]`、`[FAIL]`、`[RETRY-n]`）
- **日志格式**：`[PREFIX] HH:MM:SS METHOD /path ...` — 状态前缀在前，时间戳在后
- **只显示相关信息**：非模型请求（如 `/health`）不应显示模型名、token 数或 "unknown"
- **流式指示器**：长时间运行的请求显示 `streaming...` 状态，使用 `[<-->]` 前缀
- **诚实展示 retry**：每次被 retry strategy 接受的请求失败都打印一行 `[RETRY-n]`（n=1-based 失败次数），由 `executeRequestPipeline` 在 budget gate 通过后统一发射。格式示例：`[RETRY-1] 12:34:56 429 POST /v1/messages claude-opus-4.8 (3x) 1.2s ↑15KB: rate_limited (retryable: network-retry, wait 1.0s)`。前缀黄色、状态码红色、`(retryable: ...)` dim；之后仍照常打印最终 `[ OK ]` / `[FAIL]` 行。包含 token-refresh、learning probe（额外 `, learning` 后缀）、deferred-tool、unsupported-beta 等所有重试策略；无策略接受的错误直接进入 `[FAIL]`，不出 `[RETRY-n]`

### History Web UI

- **显示实际请求内容**：如果最后一条消息是 `tool_result`，显示 `[tool_result: id]` 而非向前查找用户文本
- **文本优先于 tool_use**：对于同时包含 text 和 tool_use 的 assistant 消息，优先显示文本内容；仅在没有文本时显示 `[tool_use: ToolName]`
- **过滤系统标签**：从预览文本中移除 `<system-reminder>`、`<ide_opened_file>` 等系统标签

### 通用原则

- **减少噪音**：不显示冗余或不可用的信息
- **一致格式**：控制台输出使用固定宽度列对齐
- **信息丰富的预览**：历史预览应反映请求的实际性质
- **信息丰富的日志**：所有日志消息应包含足够的上下文（模块标签、模型名、具体值）以便采取行动
