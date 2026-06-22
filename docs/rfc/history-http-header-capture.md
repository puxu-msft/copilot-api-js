# RFC：History HTTP Header 捕获的理想形状重构

状态：草案 v5（Round 1-4 对抗 review 已抓真问题并收敛；可进入实现）。作者：基于多轮对抗 subagent 调研 + 主线实证核验。

> **v5 修订（Round 4 review）**：X2（实质）——`apiError.responseHeaders` 当前只在 422/402/429/503 分支填充（`classify.ts:106/118/130/152`），400/401/403/413/500/502 等**丢弃**，而 bag 当前无条件捕所有非-ok 响应头；故 Phase 2 须**先扩 `classifyHTTPError` 让所有 HTTP-错误分支透传 `responseHeaders`**（纯 passthrough，源 `HTTPError.responseHeaders` 恒带、`http-error.ts:24`），否则删 bag 后常见失败（400/500/502）丢响应头、违反 invariant-3；§6 golden 失败用例须用**非-{422,402,429,503} 状态（如 502）**才真正守住该 invariant。X1（小）——Phase 1 测试迁移补 `tests/anthropic/anthropic-client.it.test.ts:97`、`tests/responses/openai-responses-client.it.test.ts:117`（legacy client，断言 `Authorization==="***"`，Phase 1 改原始后失败）。
>
> **v4 修订（Round 3 review）**：Q1——§3.1/§3.2 对 codec sampleRequest header 行（`:451/:466/:471`）的互斥指令收敛为"**保留该行、改产原始头**（不删行），driver 写顶层 `outboundRequest` 从 `wire.headers`"（删行会破 non-optional `WireRequest.headers`）；Q2——`UpstreamStream.headers` 由**两个 transport**（http-transport `:93/:105`、responses-transport `:126/:129`）构造、非 `send.ts`（后者返回 `Promise<unknown>` 业务体），脱 bag 须改 `sendUpstreamHttp` 返回签名暴露 `response.headers` 供 transport 构造；Q3——测试迁移清单补 `tests/transport/http-transport.it.test.ts`、`tests/infra/fetch-utils.it.test.ts`；Q4——"失败 outboundResponse 非空"不变量**收窄**为"上游返回 HTTP 错误状态码（带响应头）的失败"，网络/abort 失败在 capture 前 throw（`send.ts:127`）、无响应头、**正确为空**；§3.1 补 `attempt_failed` 推送链不泄漏核验。
>
> **v3 修订（Round 2 review，两 reviewer 独立同抓）**：C1——出站响应头**已有**干净数据源 `UpstreamStream.headers`（成功）+ `apiError.responseHeaders`（失败），v2 "driver 持 bag、靠抛错前 mutate" 是保护该删的冗余侧信道，重写 §3.2 为"删 bag、driver 两分支读现成返回值/异常字段"（更简单）；per-attempt headers（旧 3a/3b）**砍**——UI 零消费、投机性表面；死腿删除是 **4 处**类型声明（补 `context/types.ts:289`）；§3.5 publish 形状精确化为 `request.context_updated`+field；§3.1 不建脱敏开关（概念退路非实建）；Phase 2 须登记迁移既有 `setHttpHeaders` 测试；捕获归属层经核验与 observability-bus 架构自洽。
>
> **v2 修订（Round 1）**：F1 失败 attempt 响应头来源；F2 删幽灵 error-artifact 契约；Phase 序 + 失败路径 golden；§3.4 零 serialize；`WireRequest.headers` 非可选；行号漂移。

## 1. 背景与误判纠正

起点是一个被实证推翻的前提。最初怀疑"History 根本不存 HTTP headers"，并据此一度判断"httpHeaders 从不落 sqlite、完成写库即丢"——**这是错的**。

实测裁决（运行中 4141 后端，已完成 entry `req_1782120532100_1512`）：`httpHeaders` 三条腿（`inboundRequest`/`outboundRequest`/`outboundResponse`）**已完整持久化并还原**，入站 21 个头俱在。机制是 `httpHeaders` 留在 head-meta blob（`sqlite/serialize.ts` 的 `extractHeadMetaPayload` 既不在 `META_KEYS` 也不在 `STAGE_TOP_KEYS`，故随 `blob_gz` 落盘），`deserializeEntry` 还原。最初看到的"空 httpHeaders"是因为拉的是 in-flight streaming entry——不是持久化丢失，而是 in-flight 不可见（§2.7）。

所以本 RFC 不是"修一个不存在的持久化漏洞"，而是把一个**半成型、散落、含死表面、含冗余侧信道**的 header 捕获子系统重塑为长远正确的形状。核心判断：

> **按层分治——对偶然重复收敛、对本质差异保留、删冗余侧信道、用现成的干净数据源。** 天真版的"driver 一处统一捕获 + 散点删脱敏 + 持 bag"是错的，会丢可观测性、制造错误抽象、泄漏 token、保护该删的旧侧信道。

operator 已定两个决策：(a) **存未脱敏的真实 header 值**；(b) 走**全量理想形状**（顶层三腿，非 per-attempt）。两个直接诉求：存真实值（→ Phase 1）+ in-flight 能看到（→ Phase 5）；其余为 operator 授权的理想形状架构清理（Phase 2/4）。

## 2. 根因（逐处对照代码确认）

### 2.1 入站捕获：4 格式逐字节相同（偶然重复）

各 codec.parse 调同一行 `ctx.setInboundRequestHeaders(captureInboundHeaders(raw.headers))`，输入同为 `RawHttpRequest.headers`，零格式分支：anthropic `codec.ts:293` / openai-cc `:298` / openai-responses `:327` / openai-gemini `:265`。`captureInboundHeaders`（`fetch-utils.ts:8`）内部调 `sanitizeHeadersForHistory`（脱敏）。唯一"第 5 处"是 web_search 旁路 `createWebSearchContext`（`handler-v4.ts:236`，"the codec is bypassed here"，与主路径互斥）——非主路径双捕。

### 2.2 出站响应头：已有干净数据源，bag 是冗余侧信道

**关键（Round 2 C1）**：上游响应头**已经**以两条干净通道 per-attempt 流到 driver，与 mutable bag 正交：

- **成功路**：`UpstreamStream.headers: Headers`（`pipeline/types.ts`，注释自承"carries the upstream HTTP response headers for capture (Retry-After, quota)"）。`transport.send` 返回它（`http-transport.ts:90`、`responses-transport.ts:123`），driver `runResponseSink` 打成 `ResponseOutcome.complete{headers}`（`driver.ts:468`）。每次 `send()`=S4 循环里每 attempt。
- **失败路**：`HTTPError.responseHeaders`（`http-error.ts:9/18`，`fromResponse` 从 `response.headers` 填）→ `classifyError` 塞进 `apiError.responseHeaders`（`classify.ts:106/118/130/152`）→ driver catch 的 `apiError`（`driver.ts:271`）已持有。

而 handler-side `HeadersCapture` bag 的 `capture.response`（`fetch-utils.ts:28`，未脱敏）是 `UpstreamStream.headers` 引入**之前**的旧侧信道——现在 `http-transport.ts:90` 甚至是**从 bag 读** response 再装进 `UpstreamStream.headers`（`new Headers(deps.headersCapture?.response ?? {})`，同一份数据两个出口）。bag 是冗余，且**跨 attempt 被覆盖**（每 attempt `captureHttpHeaders` 重新赋值，前面 attempt 的响应头已丢——故 bag 连 per-attempt 都做不到）。

### 2.3 出站请求头：双写，handler bag 那条纯冗余

driver S4 一次 `codec.prepareWire(current)` 产 `wire`（`driver.ts:253`），`wire.headers` 同时喂 codec sampleRequest（`:258` → `sanitizeHeadersForHistory(Object.fromEntries(wire.headers.entries()))`，anthropic `codec:451`/cc:466/responses:471 → per-attempt `wireRequest.headers`）与 transport.send（`:265` → bag `capture.request`，`fetch-utils.ts:27` 脱敏）。两源同 `wire.headers` 派生、字节相同。finalize（`request.ts:567`）用最终 attempt 的 `wireRequest.headers` 覆盖顶层，无损。出站请求头**driver 手里就有 `wire.headers`**，根本不需要 bag。

### 2.4 handler-side bag：本属 driver 的关注点泄漏

`HeadersCapture`（`context/types.ts:130`）是穿透 transport 的 mutable bag（构造期 dep，`http-transport.ts:49`）。每个 handler 被迫 driver 外 `new` 一个、穿过 transport deps、driver 返回后 `setHttpHeaders` 两次。`grep \.setHttpHeaders(` 命中 **13 处**，分布 6 文件：messages(`:340,:375`)、cc(`:167,:188`)、responses(`:139,:156`)、gemini(`:135,:150`)、ws(`:249,:262,:271`)、web-search-direct(`:182,:186`)。`grep headersCapture src/lib/pipeline/driver.ts` 零命中——driver 拥有 transport 与 S4 per-attempt 循环，却把出站 header 生命周期泄漏给每个 handler。

### 2.5 `httpHeaders.inboundResponse`：死表面（无数据源）

类型字段 `httpHeaders.inboundResponse?: Record<string,string>`（注释 "reserved for future use"），**4 处**类型声明：`history/types.ts:268`、`context/types.ts:195`（HistoryEntryData 形状）、`context/types.ts:289`（RequestContext readonly getter 形状）、`context/request.ts:142`。零 producer（`setHttpHeaders` `request.ts:279-287` 只写 outbound 两腿）、零 UI 消费（UI 只渲三腿）、物理无数据源（客户端响应头由 Hono `streamSSE`/`c.json` 在 sink 之外生成；`ClientFrame`=`SseFrame` `stream.ts:166-171` 只有 event/data/id/retry）。实测 live entry 该腿恒缺。

> **同名陷阱**：`HistoryEntry.inboundResponse`（`types.ts:251`，`ForwardedResponse` body 腿）**是活的**（`setForwardedResponse`；serialize `STAGE.inboundResponse` `serialize.ts:60/229` 指它；UI `useDetailStages.ts:66` 渲它）。删 `httpHeaders.inboundResponse` header 子腿**绝不能**碰这个同名 STAGE/活腿。

### 2.6 脱敏是共享函数，但 History 之外只有一个无泄漏消费者

`sanitizeHeadersForHistory`（`fetch-utils.ts:32`，`SENSITIVE_HEADER_NAMES` `:5` = authorization/proxy-authorization/x-api-key/api-key/cookie/set-cookie → `***`）8 调用点：History 入站（`fetch-utils:9`）、History 出站请求（`fetch-utils:27` + codec `:451/:466/:471` + legacy client `:48/:63/:101`）、**betaProbe.recordOutbound**（`codec:391`，唯一非 History）。

**Round 1 纠正**：JSDoc 写 "history/error artifacts"，但 `grep` 证实**无 error-artifact 路径消费此函数**——幽灵契约。betaProbe `recordOutbound` 实证**只读 `headers["anthropic-beta"]`**（`pipeline.ts:88-90`，永不敏感）——传未脱敏头零泄漏。故"删共享 sanitize 会泄漏"威胁模型一半虚构、一半无风险。`outboundResponse` leg（`capture.response`/`UpstreamStream.headers`）**当前已未脱敏**——存原始对它已是 no-op。

### 2.7 in-flight 不可见

header setter（`request.ts:279`/`289`）**不 publish**（对比 `setPipelineInfo:265`、`setAttemptWireRequest:316` 都 publish）；`snapshot()`（`request.ts:163-181`）**不含 httpHeaders**；`httpHeaders` 只在 finalize（`request.ts:571`）组装。history sink `onContextUpdated`（`history.ts:178-221`）**无 httpHeaders 分支**（其他 field 名一律忽略），唯一写 httpHeaders 的是 `onTerminal`（`history.ts:267`，终态）。故流式期 live 视图看不到 header——最初看到"空 headers"的根因。

## 3. 设计：理想形状

一句话：**捕获产出原始数据 → driver 用现成的 `UpstreamStream.headers`/`apiError.responseHeaders`/`wire.headers` 在 S4 写 ctx（两腿、成败两路）→ 删 handler bag 与冗余双写 → 脱敏退路概念上落 sink 单点（当前不建开关）→ 删死腿 → in-flight 经 bus 可见 → 保留 per-format/per-transport 真实差异。** per-attempt headers 砍（无消费者）。

捕获归属层经核验**正确**：driver mutate `ctx.httpHeaders`（经 setter → ctx 注入的 publisher 发 `request.context_updated` → HistorySink）正是 `eslint.config.js:149-156` 显式批准的路径（"Mutate the injected RequestContext or accept a ScopedPublisher via DI"），与 `setAttemptWireRequest`（已 publish）同构，不绕 observability bus。

### 3.1 捕获产出原始头 + sink 落原始（不建开关）

`ctx.httpHeaders` 各腿存**原始未脱敏** Headers（richest-data-flow）。把 History 捕获路径的 `sanitizeHeadersForHistory` 调用（`fetch-utils.ts:9`/`27`、codec sampleRequest `:451/:466/:471`、legacy client `:48/:63/:101`）改为产出原始头。sink（`observability/sinks/history.ts`）**直接落原始，不加任何开关**（operator 明确不脱敏；加开关=YAGNI）。

`sanitizeHeadersForHistory` 函数本体**保留**——仅因 betaProbe（`codec:391`，只读 anthropic-beta、零泄漏）仍用，不为它拆函数。脱敏退路是**概念演进点**（未来若需，在 sink 单点加，一句注释指明）——非现在建表面。删除 v1 的幽灵 error-artifact 不变量。

> 非 History 泄漏链核验（Round 3）：原始 `wireRequest.headers` 经 `setAttemptWireRequest` 进 attempts[]，会经 `request.attempt_failed` publish 完整 wireRequest（`request.ts:652`）——但 WS sink（`ws.ts:106-118`）+ console sink（`console.ts:254-286`）**均不取 `wireRequest.headers`**，history sink 不消费 attempt_failed 的 wireRequest，`legFromWire` 落盘前剥 headers。故拆 legacy client sanitize（产原始）不泄漏到任何非 History 通道。

### 3.2 出站捕获由 driver 用现成数据源写 ctx（删 bag）

driver 在 S4 exchange 循环（已 per-attempt）按腿用**已存在的干净来源**写 ctx，**无 mutable bag**：

- **出站请求头**：driver 读 `wire.headers`（`driver.ts:253` 已在手，原始，对成败两路恒可得）。
- **上游响应头**：成功分支读 `upstream.headers`（`UpstreamStream.headers`，§2.2）；catch 分支读 `apiError.responseHeaders`（§2.2）。二者皆现成返回值/异常字段，天然 per-`send()`=per-attempt。**前置（X2）**：`classifyHTTPError`（`classify.ts`）当前只在 422/402/429/503 分支填 `responseHeaders`，须先扩为**所有 HTTP-错误分支透传**（纯 passthrough，源 `HTTPError.responseHeaders` 恒带、`http-error.ts:24`），否则删 bag 后 400/500/502 等失败丢响应头。

driver 把两腿写顶层 ctx（镜像最终 attempt，与现 finalize 语义一致）。随之**删除**：handler-side `HeadersCapture` bag（每 handler `const headersCapture={}`）、13 处 `setHttpHeaders`、transport 的 `headersCapture` 构造 dep、`captureHttpHeaders`（`fetch-utils.ts:26`）、finalize 双写迁移（`request.ts:567`）。**改**：`sendUpstreamHttp`（`send.ts`，当前返回 `Promise<unknown>` 业务体）返回签名扩为同时暴露 `response.headers`，两个 transport（`http-transport.ts:93/105`、`responses-transport.ts:126/129）`改为从该 `response.headers` 直接 `new Headers(...)` 构造 `UpstreamStream.headers`（脱离 bag、transport-内部）。

**保留**（Q1 收敛）：codec sampleRequest 的 header 行（`:451/:466/:471`）**不删**，仅去 sanitize 包裹改产**原始**头（`WireRequest.headers` 非可选，删行会破构造）。其产物 `wireRequest.headers` 仍随 attempts[] 在内存、serialize 时被 `legFromWire` 丢弃（per-attempt 砍、§3.3），不进 History；顶层 `outboundRequest` 由 driver 从 `wire.headers` 写（单一来源）。

单一来源：出站两腿各唯一顶层填充点（driver S4：请求腿 `wire.headers`、响应腿 `upstream.headers`/`apiError.responseHeaders`），无 handler bag、无双写、无冗余侧信道。

### 3.3 per-attempt headers：砍（无消费者，投机性表面）

§2.3 指出 per-attempt 出站请求头被 `legFromWire`（`request.ts:85-94`）丢弃、per-attempt 上游响应头无存储槽。**但 UI 零消费 per-attempt headers**（`AttemptDiff.vue` 只读 `attempt.wireRequest.messages`、`AttemptsTimeline.vue` 只读 `effectiveMessageCount`；`grep wireRequest.headers ui/` 零命中）。补活它=复活一条无末端的死数据流，与 §2.3 批判的死数据流同构，违反 YAGNI。operator 要的是**顶层**三腿，顶层已镜像最终 attempt——per-attempt headers 缺失非真实问题（无泄漏/无数据丢失/无可观测盲点）。

**决定：砍。** 文档化暂缓（根因：legFromWire 不输出 headers + attempts[].response 无 header 槽；采集侧由 §3.2 的 `UpstreamStream.headers`/`apiError.responseHeaders` 天然 per-attempt 提供、几乎免费，缺的只是输出类型槽 + serialize；为何暂缓：UI 零消费；若做需改 `legFromWire` 返回类型 + `attempts[].wireRequest`/`response` 类型 + UI AttemptDiff 渲染）。等真有 retry 诊断需求再做。

### 3.4 删死腿 `httpHeaders.inboundResponse`（纯类型层，4 处）

删 **4 处**类型声明：`history/types.ts:268`、`context/types.ts:195`、`context/types.ts:289`、`context/request.ts:142`。**零 serialize 改动**（httpHeaders 随 head blob、不进 entry_stages，`grep httpHeaders serialize.ts` 零命中）。**严禁**碰 serialize 同名 `STAGE.inboundResponse`（ForwardedResponse 活腿，§2.5 同名陷阱）。UI/测试无 `httpHeaders.inboundResponse` 残留引用（实测）。`httpHeaders` 收敛为 3 腿。

### 3.5 in-flight 可见（独立 feature，经 bus）

不进轻量 `snapshot()`（保其精简、避免每帧带几十个 header 放大 WS 推送）。两处改动：

1. header setter（`request.ts:279/289`）发 `publisher?.publish({ kind: "request.context_updated", ctx: snapshotWithSummary(ctx), field: "httpHeaders", contextRef: ctx })`（与既有 originalRequest/pipelineInfo/attempts 分支同形态，`events.ts` 的 `field: string` 自由字符串、无需改类型）。
2. history sink `onContextUpdated`（`history.ts:178-221`）新增 `field==="httpHeaders"` 分支，调 `updateEntry(ctx.id, { httpHeaders: ctx.httpHeaders })`（读 live ctx ref、不经 snapshot；`updateEntry` allowlist `entries.ts:101` 已含 httpHeaders、`updateInFlight` 无脑 merge，merge 层已就绪）。

独立 phase 评审、可单独回退。

### 3.6 保留的 per-format / per-transport 真实差异（不收敛）

- **anthropic-beta 语义消费**（`codec.ts:325` 读 + `request-preparation.ts:208` 注入）：唯一 format-specific 头业务逻辑，与捕获正交，留 codec。
- **WS 入站头 no-op**：握手头是 connection-scope（一连接多 `response.create` 复用），强塞 per-message ctx = 错误抽象 + YAGNI（当前有意 `new Headers()`，`ws.ts:240`）。统一捕获对 WS 自然 no-op。
- **web_search 旁路**：走 legacy pipeline、不进 driver（DESIGN `[bypass]`），保留自己的入站捕获点。

### 3.7 入站捕获收敛（最低优先，暂缓）

4 格式逐字节相同的入站捕获可上移进 driver S1（driver 持 `raw`、`RawHttpRequest.headers` 注入点 `handler-v4.ts:326`，物理成立）。但收益最低、会撞 reject 路径 ctx 生命周期既有矛盾（OQ5）——speculative tidiness，非真实问题。**暂缓**，不与核心捆绑。

## 4. Phase 拆分与 commit invariants

**总不变量（贯穿所有中间 commit）**：4 格式 × 3 活腿（inboundRequest/outboundRequest/outboundResponse）捕获**不得任一格任一腿回退为空**——**含上游返回 HTTP 错误状态码（带响应头）的纯失败请求的 outboundResponse 腿**（F1 盲点）。**注（Q4）**：网络/abort 层失败（连接失败/客户端断开）在 `captureHttpHeaders` 前 throw（`send.ts:127`）、无上游 HTTP 响应、`apiError.responseHeaders` 为空——这类失败的 outboundResponse **本就应空**，不在"不回退"约束内。golden 覆盖**完成 + HTTP-错误-状态失败**两类。

- **Phase 0（golden 预捕获）**：改动前旧代码上，4 格式各跑**一条完成 + 一条 HTTP-错误-状态失败**，golden 锁三腿结构 + 非敏感头键集（敏感头此刻 `***`，Phase 1 改原始时显式更新 golden）。Invariant：golden 在旧代码上先跑通。归 `tests/history/*.it.test.ts`（起 history runtime）。
- **Phase 1（sink 存原始）**：拆 History 捕获路径 sanitize（`fetch-utils:9/27`、codec sampleRequest `:451/:466/:471` 去 sanitize 保留行、legacy client `:48/:63/:101`）；三腿存原始；betaProbe sanitize 不动；sink 不加开关。**测试更新（X1）**：`tests/anthropic/anthropic-client.it.test.ts:97`、`tests/responses/openai-responses-client.it.test.ts:117`（legacy client，断言 `Authorization==="***"`）+ `history-store.it.test.ts`/`history-api.it.test.ts`/`request-context.unit.test.ts` 中任何断言脱敏值（`***`）的改为真实值。Invariant：三腿在、敏感头从 `***` 变真实（golden 有意更新）、betaProbe 不受影响。
- **Phase 2（出站捕获下沉 driver、删 bag）**：**前置步（X2）**：扩 `classifyHTTPError`（`classify.ts`）让所有 HTTP-错误分支透传 `responseHeaders`（纯 passthrough，源恒带）。driver S4 从 `wire.headers`/`upstream.headers`/`apiError.responseHeaders` 写两腿（成败两路）；`sendUpstreamHttp` 返回签名扩暴露 `response.headers`、两个 transport 改从它构造 `UpstreamStream.headers`（脱 bag）。**过渡态**：先接 driver 新路径、与旧 bag 并存，golden 比对**完成 + HTTP-错误-状态失败（非-{422,402,429,503} 状态如 502）**两类逐格式一致（响应腿本就同源、请求腿须 Phase 1 已拆净 sanitize 才一致——故**锁 Phase 1 先于 Phase 2 全 4 格式 + 失败路径**），**再**删 bag + 13 setHttpHeaders + transport headersCapture dep + captureHttpHeaders + finalize 迁移。**须同步迁移既有测试**（Q3 全清单）：`request-context.unit.test.ts:537`（`httpHeaders.outboundRequest` 断言、测 finalize:567 迁移）+ `:621/627`（`setHttpHeaders` 直调）、`tests/transport/http-transport.it.test.ts:80/84/86`（`HeadersCapture` + `upstream.headers` 断言，C1 链直接守卫）、`tests/infra/fetch-utils.it.test.ts:55-62`（`captureHttpHeaders` describe 块，函数被删→删/改）。Invariant：每中间 commit 三腿（含 HTTP-错误失败 outboundResponse）非空且与 golden 一致；既有测试同 commit 改绿。
- **Phase 4（删死腿）**：删 4 处类型声明、零 serialize、不碰同名 STAGE。Invariant：UI 三腿渲染不变。
- **Phase 5（in-flight 可见，独立）**：setter publish + sink onContextUpdated 新增 httpHeaders 分支。Invariant：终态 entry 不变；in-flight 新增 httpHeaders 可见；WS 推送体积回归不爆。
- **Phase 6（入站捕获收敛，暂缓/可选收尾）**：上移 4 处入站捕获进 driver S1。Invariant：4 格式入站腿不变；reject 路径行为显式决定。

> 砍：旧 Phase 3a/3b（per-attempt headers）——无消费者（§3.3）。

## 5. Open questions（实现前需实证/定夺）

1. **in-flight 可见（Phase 5）是否 operator 真要？** RFC 只引 operator 的 (a) 存真实值 (b) 全量理想形状。"全量理想形状"是否覆盖 in-flight 可见有解释空间——但它正是最初痛点（看不到 live header）的直接解。倾向做，但 WS 推送放大需回归守。
2. **Phase 6 入站上移与 reject 路径**：reject 请求保留入站头捕获，是否让 reject 也产生 history entry（当前 reject 不建 entry）？须确认 reject 路径 ctx 生命周期。
3. **Phase 2 双写比对的 golden 归一化**：driver 从 `wire.headers` 与 `UpstreamStream.headers` 的 `Object.fromEntries`/`new Headers` 顺序/大小写是否需归一化才能字节比对？

## 6. 测试策略

- **逐格式 golden（核心，`tests/history/*.it.test.ts`）**：4 格式各**一条完成 + 一条 HTTP-错误-状态失败（用非-{422,402,429,503} 状态如 502，X2）**，断言 `httpHeaders` 三腿结构 + 键集；Phase 1 后断言敏感头真实值（非 `***`）。**HTTP-错误失败请求专守 outboundResponse 腿不回退**（F1 盲点）；**另测网络/abort 失败 outboundResponse 正确为空**（Q4，防伪不变量误伤）。
- **driver 捕获机制（`tests/pipeline/`）**：断言 driver S4 从 `upstream.headers`（成功）/`apiError.responseHeaders`（失败）写 ctx 两腿；删 bag 后 transport 无 headersCapture dep。
- **死腿删除（Phase 4）**：断言 `httpHeaders` 无 `inboundResponse` 键；UI 类型不再引用；serialize 同名 STAGE 未被误删（ForwardedResponse 腿仍活）。
- **既有测试迁移（Phase 2，Q3 全清单）**：`request-context.unit.test.ts:537/621/627`、`tests/transport/http-transport.it.test.ts:80/84/86`、`tests/infra/fetch-utils.it.test.ts:55-62` 改写为新填充路径断言 / 删除被删函数块（§4 登记）。
- **in-flight（Phase 5）**：streaming 期 in-flight entry 含 httpHeaders；WS 推送体积不超阈值。
- **WS no-op**：WS 请求 `httpHeaders.inboundRequest` 为空。
- **安全回归**：History 落盘产出原始头；betaProbe 只取 anthropic-beta 不异常。
- 隔离纪律：DI/fetch-mock、注入临时 history runtime（`bunfig.toml` preload sandbox + 逐测试注入），不碰真实 `history.db`。

## 7. 不变量（编码进实现，防回归）

1. History 落盘 header 三腿存**原始未脱敏**值；sink 不加脱敏开关；betaProbe 路径保留其自有 sanitize（取头无泄漏）。无 error-artifact 消费者（无 v1 幽灵契约）。
2. 出站两腿各**唯一**填充点（driver S4：请求腿 `wire.headers`、响应腿 `upstream.headers`/`apiError.responseHeaders`，**成败两路、现成数据源**）；无 handler bag、无双写、无冗余侧信道。
3. **HTTP-错误-状态失败** attempt 的 `outboundResponse` 头必须捕获——经扩 `classifyHTTPError` 全分支透传 `responseHeaders`（X2，源 `HTTPError.responseHeaders` 恒带），该类失败路径不回退为空。**网络/abort 失败**（capture 前 throw、无上游响应）outboundResponse 正确为空，不在此约束（Q4）。
4. `httpHeaders` 恒 **3 腿**；删 `inboundResponse` header 腿=4 处类型声明、零 serialize、不碰同名 ForwardedResponse STAGE。
5. WS 入站头恒空；anthropic-beta 语义消费留 codec、不进捕获 seam；per-attempt headers 不补（无消费者）。
6. 每中间 commit：4 格式 × 3 活腿（含纯失败 outboundResponse）不回退为空（golden 守）；既有 `setHttpHeaders` 测试同 commit 改绿。
7. in-flight 可见不进 `snapshot()`；走 sink `onContextUpdated` 新增分支 + setter `request.context_updated` publish。
