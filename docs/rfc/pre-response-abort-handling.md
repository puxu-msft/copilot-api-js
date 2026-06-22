# RFC: pre-response abort 处理 + opus 长思考保活

**Status:** 设计稿待评审 — 范围 ①②③ 已与用户对齐(2026-06-22「先只出 RFC/设计稿」);①② 为低风险正确性修复,③ 为有 tradeoff 的架构改进。**已过 3 轮对抗 subagent review,round-3 判定收敛**(见 Changelog):①②(C1/C2)设计层无 CRITICAL、可进实现;③(C3b)待 Q2 oracle 验证 + Q7 范围决议。
**Date:** 2026-06-22
**Owner:** 排查会话(待实现会话接手)

### Changelog

**设计精化(2026-06-22,用户提问驱动)—— ③ 改为延迟-commit(grace window)。** 用户问"如何保证总是进入流式 / 提前 ping 是否正确":
- "流式与否"无需 await 上游即可定 —— `env.stream` 自客户端 payload、`readonly` 全链不可变(§4.2.0,锚 codec.ts:316 / envelope.ts:90),③ 仅 gate 在 `clientRaw.stream === true`,非流式不受影响。
- 纯"立即开流"对所有 pre-generation 错误发散于真实 Anthropic(它校验阶段仍回 HTTP 4xx)。**改进:延迟-commit(§4.2.2)** —— 先 `Promise.race(runRequest, graceTimer)` 等一个 grace 窗口(30–60s),grace 内上游回头(成功**或**快速错误)走现状出正确 HTTP 状态码(零发散),仅 grace 耗尽的真·长 stall 才提前开 200+ping。上游错误几乎都亚秒~数秒,故发散面缩到"长 stall 后才报错"的极少数,**Q2 验证面大幅缩小**。

**Review round 3(2026-06-22,对抗 subagent)—— 收敛,无新设计层 CRITICAL。** 仅两处表述精度补充,已纳入:
- ① 的 499(client-gone)分支在 ② 落地后对 **Anthropic 变死代码**(由 ② 的 `c.body(null,499)` 出),仅对 CC/Responses/Gemini 是活代码;二者互斥无重复 —— 已在 §5 C1 invariant 标注。
- §4.2.1 的 C3b 回调伪码补 `if (ctx)` 守卫:client-abort 早于 `codec.parse` 建 ctx 时 ctx 为 undefined,直接 `ctx.abort()` 会 NPE —— 已补。
- 经代码核验确认**无盲点**的项(无需改稿):abort 路径正确 removeInFlight + 推 `request.aborted`(与 fail 同构);非流式 Anthropic pre-response abort 共用外层 catch、② 自动获益;reaper(staleRequestMaxAge 900s)与 fetchTimeout(900s)并发被 `settled` guard 兜住无双 settle;429 在 transport 内消化、不属 pre-response-silent 场景。

**Review round 2(2026-06-22,对抗 subagent)** —— 抓到 1 CRITICAL + 2 HIGH,已修订:
- **[CRITICAL,已修]** C2 的 `return c.body(null, 499)` 在 C3b(方案 A early-200)下是**死路径** —— streamSSE 已提前 flush 200,pre-response client-abort 无法再返回 499。原 §5 让 C3b "继承 C2 的 499 语义"是 invariant 自相矛盾。**修订:C2 的定义性产物重述为「pre-response client-abort 统一 `ctx.abort()` 终态」**,499 仅是 C2 阶段(streamSSE 仍在 runRequest 之后)的附带 HTTP 表现;C3b 下 499 消失,终态语义(`aborted`)延续,可观测结果是"已 200 但被客户端弃读的 SSE 流"(见 §3.2 + §5 重写)。
- **[HIGH,已纳入]** 缺陷②(`aborted` 终态)的修复**只在 Anthropic handler-v4.ts**;CC/Responses/Gemini 各有自己的 handler catch(仍 `ctx.fail`→`failed`)。故 ①(forwardError 跨格式)让它们 pre-response client-abort 出 499,但 ②(aborted 终态)Anthropic-only → 那些格式永久 `state=failed`+`status=499` 不一致(非过渡态)。**新增 Q7:② 是声明 Anthropic-only 还是扩面全格式**,并在 §4.2 表诚实标注(见 Q7 + §4.2)。
- **[HIGH,已纳入]** client-abort 与 timeout **并发**(客户端恰在超时窗口边缘断开)时判别优先级未明 —— 明确 **client-abort 优先**(记 `aborted`);§3.2 要点里的 `stream.onAbort` 翻转源限定到 C3b 语境(C2 阶段 pre-response 只有 bridgeClientAbort 一源)。
- **[MEDIUM,已纳入]** ⓪(保留 abort reason)不只是文案 polish,还是判别冗余的预留(M-1);timeout abort 的 `aborted` 分类不进重试环、504 首次即出(M-2);§4.2.1 sink 伪码补 `clientAbortSignal`(M-3)。

**Review round 1(2026-06-22,对抗 subagent)** —— 抓到 1 CRITICAL + 3 HIGH,已修订:
- **[CRITICAL,已修]** 原 §3.1/§3.2 用 `error.name === "TimeoutError"` 区分超时 vs 客户端断开 —— **错**。Anthropic/CC/Responses 的 https 上游全走 [http2-client.ts](../../src/lib/transport/http2-client.ts),其 abort 路径([:118](../../src/lib/transport/http2-client.ts#L118)/[:138](../../src/lib/transport/http2-client.ts#L138))**无条件合成 `abortError()`(name="AbortError")并丢弃 `signal.reason`**,故 `AbortSignal.timeout` 的 TimeoutError 身份在传播中丢失,`error.name` 永远是 "AbortError"。**修订:改用 `c.req.raw.signal.aborted` 判别**(客户端断开时为 true、response_header 超时时为 false —— 超时打在 `createFetchSignal()` 而非 raw.signal),不依赖 error.name,且对流式/非流式都成立(见 §3.1 新判别 + §1.4)。
- **[HIGH,已纳入]** 方案 A(③)把 driver 自身的 `decideRoute` 400 拒绝(代理协议拒绝,非上游错误)也降级成 200+SSE error 帧 —— 补入 §4.2。
- **[HIGH,已纳入]** 方案 A early-200 后 `observabilityMiddleware` 见 SSE 即不 finalize,终态责任**全部**转入 streamSSE 回调 —— 升为 §4.2 硬约束 + commit invariant。
- **[HIGH,已修]** §3.3 原称"已有 forwardError abort 用例"措辞误导(那是 `classifyError` 的用例,forwardError describe 块零 abort 用例)—— 已更正,要求每格式补单测。
- **[MEDIUM,已纳入]** C1 单独发布的过渡态(state=failed 但 HTTP=499 短暂不一致)显式标注为已知过渡态(§5)。行号漂移修正(request.ts abort 在 :454 非 :451)。

---

## 1. Context — 触发这份文档的事件

生产日志出现两条**指向同一请求**的记录:

```
[FAIL] 06:31:27 POST /v1/messages claude-opus-4.8 292.4s ↑361.8KB: The operation was aborted.
[ERR ] 06:31:27 Unexpected non-HTTP error in POST /v1/messages: The operation was aborted.
```

`[FAIL]` 是请求管线终态行,`[ERR ] Unexpected non-HTTP error` 来自顶层错误处理器 [forward.ts:438](../../src/lib/error/forward.ts#L438)——后者意味着这个 abort **未被分类**就冒泡到了 catch-all。

### 1.1 实测证据(非读代码推断)

从运行中的 4141 后端 `/history/api/entries/:id` 拉到命中 entry `req_1782109595295_538`(孪生 `req_1782109596443_539` 在 291.2s 同时失败——同一个 Claude Code 进程两个在飞请求一起放弃):

| 字段 | 值 | 含义 |
|---|---|---|
| `state` | `failed` | 记成失败 |
| `durationMs` | 292305 | 对上日志 292.4s |
| `inboundResponse` / `sseEventsLen` | `null` / `0` | **上游从未发回任何响应头/字节** |
| `attempts[0].error` | `"The operation was aborted."`(带句点) | 来自 [http2-client.ts:99](../../src/lib/transport/http2-client.ts#L99) `abortError()` 的精确文案(标准 DOMException 无句点) |
| `attempts[0].transport` | `http` | node:http2 上游热路径 |
| `effectiveMessageCount` | 17 | 大请求(↑361.8KB) |
| 顶层 `.error` / `.failureReason` | `null` / `null` | 失败原因只在 attempt 层,未回填顶层 |

`inboundResponse: null` + `sseEventsLen: 0` 是断案关键:上游连 HTTP 响应头都没发,纯 **pre-response 静默** 292s。

### 1.2 根因链

1. **触发(操作层,非 copilot-api bug)** — opus-4.8 经 GHC 处理一个 17 条消息 / 362KB 的大请求,在发出**第一个 HTTP 响应头之前**就 server-side adaptive thinking 静默 292s。这不是 mid-stream(`content_block_start` 后)停滞,而是 pre-response 完全沉默,连 200 状态行都没回。
2. **客户端放弃** — Claude Code 等不到任何字节,命中自身请求超时(实测 ~292s,两请求同时断证明是单一客户端进程放弃或用户中断)→ Hono 的 `c.req.raw.signal` abort。
3. **桥接放大** — [bridgeClientAbort](../../src/lib/abort-bridge.ts#L39) 把 raw.signal 接到 `clientAbort.abort()` → [send.ts:99](../../src/lib/transport/send.ts#L99) `combineAbortSignals` 折进上游 fetch 的 signal → [http2-client.ts:136](../../src/lib/transport/http2-client.ts#L136) `onPreResponseAbort` `req.close(NGHTTP2_CANCEL)` + `reject(abortError())`。
4. **冒泡到 catch-all** — 此刻还在 `await driver.runRequest`([handler-v4.ts:314](../../src/routes/messages/handler-v4.ts#L314)),**`streamSSE` 尚未启动**。这本身就证明 throw 发生在 pre-response:一旦进入 `pumpAnthropicStreamingV4`,client abort 会走 `settled-abort` 优雅分支(`ctx.abort()`,正常 return,不 throw)。错误经 [handler-v4.ts:323](../../src/routes/messages/handler-v4.ts#L323) 的 catch → `ctx.fail` + rethrow → [route.ts:14](../../src/routes/messages/route.ts#L14) → `forwardError` → catch-all。

### 1.3 pre-response abort 的三个来源

[send.ts:99](../../src/lib/transport/send.ts#L99) 把三个 signal 折进上游 fetch,故 pre-response 阶段的 abort 实际有三种 provenance,**当前全部落进 forwardError 的同一个 catch-all**:

| 来源 | signal | 错误形态(到 forwardError 时) | 判别依据 | 当前结果 | 理想结果 |
|---|---|---|---|---|---|
| 客户端断开 | `clientAbort`(← `c.req.raw.signal`) | `AbortError`(http2-client 合成,name="AbortError") | `c.req.raw.signal.aborted === true` | `[ERR] Unexpected` 500 + `failed` | 良性 debug 日志 + `aborted` 终态(客户端已走,状态码无人读) |
| response_header 超时 | `createFetchSignal()` = `AbortSignal.timeout(fetchTimeout)` ([fetch-utils.ts:17](../../src/lib/fetch-utils.ts#L17),本配置 900s) | `AbortError`(http2-client 合成,**TimeoutError 身份已丢**,见 §1.4) | `c.req.raw.signal.aborted === false`(超时打 createFetchSignal,非 raw.signal) | `[ERR] Unexpected` 500 + `failed` | `504 Gateway Timeout` + warn 日志 + `failed` |
| 优雅关闭(仅非流) | `getShutdownSignal()` | `AbortError` | `getShutdownSignal().aborted`(send.ts 已先于 forwardError 拦截) | 已被 `rewriteShutdownAbort` 改写为 retryable `529`([send.ts:119](../../src/lib/transport/send.ts#L119)) | 维持 529(已正确;流式 pre-response 不折 shutdown 是已知边缘,§6 Open Q4) |

**关键:三种来源到 forwardError 时 `error.name` 全是 "AbortError"**(http2-client 合成,§1.4),**不能用 error.name 区分**。可靠判别是 `c.req.raw.signal.aborted`(客户端断开↔超时)+ `getShutdownSignal().aborted`(shutdown,且已被 send.ts 提前拦为 529)。

### 1.4 为什么不能靠 `error.name` 区分超时(round-1 review 的 CRITICAL)

[send.ts:99](../../src/lib/transport/send.ts#L99) 的 `combineAbortSignals` 对 2+ signal 用 `AbortSignal.any`([stream.ts:92](../../src/lib/stream.ts#L92)),合并 signal 的 `.reason` **会**透传触发源的 reason —— `AbortSignal.timeout` 的 reason 是 `TimeoutError` DOMException,clientAbort 默认 reason 是 `AbortError`。**但** [http2-client.ts](../../src/lib/transport/http2-client.ts) 的 abort 路径([:118](../../src/lib/transport/http2-client.ts#L118) 早退 + [:138](../../src/lib/transport/http2-client.ts#L138) `onPreResponseAbort`)**无条件 `reject(abortError())`**(自合成 `new Error("The operation was aborted.")`,name 硬设 "AbortError"),**完全不读 `signal.reason`**。所有 https 上游(GHC/Anthropic/CC/Responses)都走 http2-client,故到达 forwardError/handler 的超时错误其 name 已被抹成 "AbortError",TimeoutError 身份丢失。

这是一个独立的 **lossy 数据缺陷**(违反 richest-data-flow:abort 的 provenance 被丢)。两条修复路线:
- **选定方案(不碰 http2-client):用 `c.req.raw.signal.aborted` 判别。** 客户端断开 → raw.signal aborted=true;response_header 超时 → 超时打在 `createFetchSignal()`,raw.signal 仍 false(客户端还连着、只是在等)。此判别对流式(combined=any[timeout, client])与非流式(combined=any[timeout, shutdown, client],shutdown 已被 send.ts:119 提前拦为 529)都成立:到 forwardError 时非 client、非 shutdown 的 abort **只可能**是 timeout。不依赖 error.name 或 reason 透传两层,最 robust。
- **可选 ⓪(richest-data-flow polish,本 RFC 不强制):** 让 http2-client abort 路径 `reject(signal.reason instanceof Error ? signal.reason : abortError())`,保留 TimeoutError/客户端 reason。好处是 history 的 `attempt.error` 文案更准(`"...aborted due to timeout"` vs 客户端断开),诊断更清晰。但 504/499 的**判别**不依赖它(用 raw.signal.aborted 已够),故列为可选。若评审要更干净的 provenance,纳入 ⓪ 作前置 commit。

---

---

## 2. 三个真实缺陷(按 architecture-health-first「问题是否真实存在」分流)

### 缺陷①:`forwardError` 不分类 abort —— 直接造成第二条日志

[forward.ts:347-441](../../src/lib/error/forward.ts#L347) 只特判 `HTTPError`,其余一律落 [forward.ts:438](../../src/lib/error/forward.ts#L438) 的 catch-all:`consola.error("Unexpected non-HTTP error ...")` + `c.json(defaultError(..., 500), 500)`。

问题:
- **语义错** — "Unexpected non-HTTP error" 的措辞暗示这是个 bug,但 abort/timeout 是预期内的运维状况(客户端取消、上游太慢)。`consola.error` 的 ERR severity 也错配。
- **状态码错** — 把客户端取消 / 网关超时统一标成 **HTTP 500 server_error**,等于告诉(或其历史里告诉)客户端"服务器内部 bug"。response_header 超时该是 504,客户端取消该是 499(或干脆不在意——连接已断)。
- **已有现成工具未用** — [classifyError](../../src/lib/error/classify.ts#L49) 把 abort 判成 `type: "aborted"`、[isAbortError](../../src/lib/error/classify.ts#L265) 识别 `AbortError`/`TimeoutError`/cause 链。forwardError 完全没消费它们。

### 缺陷②:pre-response 客户端断开记成 `failed` 而非 `aborted` —— 状态不一致

[request.ts:451](../../src/lib/context/request.ts#L451) 的 `abort(model, partial)` 是**专为客户端断开设计的独立 `aborted` 终态**(代码注释明写 "Bug 2":既不夸大成功也不把截断响应伪装成正常完成,error 固定 `"client disconnected"`,`transition("aborted")`)。

但 pre-response 的 catch([handler-v4.ts:332](../../src/routes/messages/handler-v4.ts#L332))对 AbortError 也无脑调 `ctx.fail(resolvedName, error)`,于是:

- mid-stream 客户端断开 → `ctx.abort()` → `aborted`(正确,见 [handler-v4.ts:595](../../src/routes/messages/handler-v4.ts#L595))
- pre-response 客户端断开 → `ctx.fail()` → `failed`(本 incident)

**同一种事件(客户端断开)两种终态**,污染失败率统计、把"用户中断的长思考"算进"服务端失败"。这是设计意图(`abort()` 在 [request.ts:454](../../src/lib/context/request.ts#L454),aborted 终态)在 pre-response 路径上的遗漏。

> 注:response_header 超时(`TimeoutError`)与客户端断开不同 —— 它是**上游确实太慢**,记 `failed`(或专门的 timeout 终态)是合理的;只有"客户端主动断开/取消"才该是 `aborted`。修 ② 必须区分这两者(见 §3.2)。

### 缺陷③:pre-response 静默无客户端保活 —— 唯一能「防止」故障的修复(有 tradeoff)

`stream_fake_sse_heartbeat`(本配置 240s)的心跳 sink 在 [handler-v4.ts:568](../../src/routes/messages/handler-v4.ts#L568) `makeSseSink` 里建立,而该点在 `pumpAnthropicStreamingV4` 内、即**上游响应头到达之后**才执行。pre-response 静默期根本没有 SSE 通道可注入 ping,所以 240s 心跳对本场景**完全失效**。

①② 只是把已发生的故障「记录得正确」(降噪 + 正确终态/状态码),**③ 才是真正让 opus 长思考不再被客户端超时断线**的修复。

代价(architectural tradeoff):对 `stream:true` 请求若提前回 200 SSE 并在等上游期间打 ping,则**一旦提交 200,上游万一回非 200 错误就只能以 SSE error 帧下发**,而不能再用 HTTP 错误状态码。详见 §4。

---

## 3. 设计:① 与 ②(低风险正确性)

### 3.1 ① forwardError 分类 abort

在 [forward.ts:436-441](../../src/lib/error/forward.ts#L436)(HTTPError 分支之后、catch-all 之前)插入 abort/timeout 分类。判别 provenance 用错误 `name` + 当前请求 signal:

```text
// 伪码,落地时对齐项目风格(无分号、三元行首)
if (error instanceof Error && isAbortError(error)) {
  // 判别靠 raw.signal,不靠 error.name(§1.4:http2-client 抹掉了 TimeoutError 身份)。
  // 客户端断开 → raw.signal.aborted=true;response_header 超时 → raw.signal 仍 false。
  const clientGone = c.req.raw.signal?.aborted === true

  if (clientGone) {
    // 客户端已断开:写回的 body 无人读;日志降为 debug,状态用 499(client closed request)
    consola.debug(`Client disconnected (pre-response) in ${c.req.method} ${c.req.path}`)
    return c.json(helpers.defaultError("Client closed request", false, 499), 499)
  }

  // 非客户端、非 shutdown(shutdown 已在 send.ts:119 被改写成 529,到不了这里)→ 只可能是
  // response_header 超时(上游在窗口内没回头)→ 504
  consola.warn(`Upstream response-header timeout in ${c.req.method} ${c.req.path} (${state.fetchTimeout}s)`)
  return c.json(helpers.defaultError("Upstream timed out before sending response headers", true, 504), 504)
}
```

要点:
- **复用 `isAbortError`** —— 不重造判别(覆盖 `AbortError`/`TimeoutError`/cause 链 + 项目内 message 关键字)。它仍用于"这是不是一个 abort";**但 504/499 的细分不用 error.name**(§1.4),改用 `c.req.raw.signal.aborted`。
- **504 vs 499 区分**靠 `c.req.raw.signal.aborted`:客户端断开它为 true;超时它为 false(超时源是 createFetchSignal,客户端仍连着)。shutdown 在 send.ts 已被拦为 529,不会以 abort 形态到达此处。
- **499** 是 nginx 约定的非标准码(client closed request);若顾虑非标,可用 408。落地时按 Open Q1 定。`ContentfulStatusCode` 类型是否接受 499 需实测(可能要 `as ContentfulStatusCode`)。
- **这是防御纵深层** —— 即便 ② 在 handler 把多数 abort 提前消化为 `ctx.abort()` + 良性 Response,forwardError 作为 catch-all 仍绝不该把残余 abort 标成 "Unexpected 500"(对全部 4 格式 anthropic/openai/gemini 一致生效,因为 forwardError 是共享出口)。

> **跨格式注意**:forwardError 服务 anthropic/openai/gemini 三种 wire format,且被 messages/chat-completions/responses/gemini 各 route 的 catch 调用。① 的分类对全部格式生效——这是优点(统一降噪),但需确认 504/499 的 envelope 经各 `helpers.defaultError` 产出的形状对各家 SDK 无害(openai 的 `code` 字段、gemini 的 gRPC status 映射 `geminiStatusFromHttp(504)=DEADLINE_EXCEEDED` / `499=CANCELLED` 已存在,见 [forward.ts:235](../../src/lib/error/forward.ts#L235))。

### 3.2 ② pre-response 客户端断开记 `aborted`

在 [handler-v4.ts:323-336](../../src/routes/messages/handler-v4.ts#L323) 的 catch 里,对**客户端断开型** abort 改调 `ctx.abort()` 而非 `ctx.fail()`,并镜像 mid-stream 的 `settled-abort` 处理(优雅 return 一个最小 Response,而非 rethrow 到 forwardError):

```text
} catch (error) {
  const ctx = codec.getContext()
  if (ctx) {
    c.set("requestContext", ctx)
    ctx.setHttpHeaders(headersCapture)
    // 客户端主动断开 → aborted 终态(对齐 mid-stream pump 的 settled-abort)。判别靠
    // clientAbort.signal.aborted(本 handler 自持的 controller),不靠 error.name(§1.4)。
    // response_header 超时打的是 createFetchSignal,clientAbort 不被翻转 → 走 ctx.fail。
    if (error instanceof Error && isAbortError(error) && clientAbort.signal.aborted) {
      ctx.abort(resolvedName)
      detachClientAbort()
      // 客户端已走,Response 无人读;但仍需返回一个合法 Response 给 Hono(不 rethrow → 不进 forwardError)
      return c.body(null, 499)
    }
    ctx.fail(resolvedName, error)   // 超时 / 真失败 → failed(经 forwardError 出 504/原状态)
  }
  detachClientAbort()
  throw error
}
```

要点:
- **判别 client-gone**:`clientAbort.signal.aborted`(本 handler 自持的 controller)。**不用 error.name**(§1.4 已抹掉 TimeoutError)。response_header 超时打在 `createFetchSignal()`,不翻转 clientAbort,故落 `ctx.fail` 分支。
- **client-abort 优先于 timeout**(round-2 H-1):客户端恰在超时窗口边缘断开时,`clientAbort.signal.aborted` 与超时可能并发为真 —— **优先记 `aborted`**(客户端确实走了,语义上是取消而非"上游太慢")。判别顺序即编码此优先级(先判 clientAbort)。
- **`499` 是 C2 阶段的附带 HTTP 表现,不是 C2 的定义性产物**(round-2 C-1):C2(③未上)时 streamSSE 仍在 runRequest 之后,故 client-abort 在 catch 里能 `return c.body(null, 499)`。**C3b(方案 A)把 streamSSE 提前后,响应已 200 flush,499 物理上回不了** —— 届时 client-abort 的可观测结果是 `ctx.abort()` 终态 + 一条被客户端弃读的 200 SSE 流(无 499)。**C2 的真正不变量是「pre-response client-abort 统一 `ctx.abort()` 终态(`state=aborted`)」**,HTTP 表现随阶段变(C2:499 / C3b:已 200 弃读流)。
- **clientAbort 的翻转源**:C2 阶段 pre-response **只有** bridgeClientAbort([abort-bridge.ts:48](../../src/lib/abort-bridge.ts#L48))一源(stream.onAbort 此时尚未注册),判别可靠;`stream.onAbort`([handler-v4.ts:367](../../src/routes/messages/handler-v4.ts#L367))只在 C3b 提前到 pre-response 期,届时它代表的也是客户端断流,同属 client-gone,不污染判别。
- **response_header 超时仍走 `ctx.fail` + rethrow** → forwardError 出 504(§3.1)。语义对:超时是上游真慢,不是客户端取消。timeout 的 `aborted` 分类**不进重试环**([classify.ts:54-59](../../src/lib/error/classify.ts#L54) 注释:abort 表示调用方不再要结果,绕过 network 重试),故 504 首次即出,无多 attempt(round-2 M-2;实现期在 strategies 确认 `aborted` 未被任何策略接受)。
- **`ctx.abort()` 的 partial** —— pre-response 无 usage/stop_reason(上游零响应),传空即可,`abort()`([request.ts:454](../../src/lib/context/request.ts#L454))默认 `usage: {0,0}`。
- **缺陷② 的修复范围(round-2 H-2,需 Q7 决议)**:本 §3.2 的 `ctx.abort()` 改动写在 **Anthropic** [handler-v4.ts](../../src/routes/messages/handler-v4.ts) 的外层 catch(:323-336,流式/非流式共用)。CC/Responses/Gemini 各有**自己的** handler catch,**不会自动获得**此处理 —— 它们的 pre-response client-abort 经 ①(forwardError)出 499(状态对),但 ctx 终态仍 `ctx.fail`→`failed`(② 未覆盖)。即:**①跨全格式生效、②仅 Anthropic**,于是 CC/Responses/Gemini 永久 `state=failed`+`status=499` 不一致(非过渡态)。Q7 决议:声明 ② 为 Anthropic-only(诚实标注该不一致),还是把 `ctx.abort()` 处理推广到全部格式 handler。
- **与缺陷②"顶层 error null"的关系**:`ctx.abort()` 设 `_response.error = "client disconnected"` 并 `transition("aborted")`,顶层 state 变 `aborted`,history 不再计入 failed。顶层 `.error` 投影是否回填是 history projection 的次要问题(数据未丢,attempt 层有),不在本 RFC 强行扩面——若评审认为该一并修,记入 Open Q3。

### 3.3 ①② 的验证(golden + 单测)

- **forwardError 单测**:当前 `tests/infra/error.unit.test.ts` 的 forwardError describe 块**没有任何 abort 用例**(已有的 abort 用例属于 `classifyError`,不是 forwardError —— round-1 review 更正)。需**每格式各加**:`forwardError(c, abortErr, fmt)` 在 `c.req.raw.signal.aborted=true`(mock)→ 期望 499 + debug 日志;`aborted=false` → 期望 504 + warn 日志;两者都不出 "Unexpected" ERR。fmt 遍历 anthropic/openai/gemini(envelope 形状各异,见 §3.1 跨格式注意)。
- **handler 路径**:pre-response client-abort → `ctx` 终态 `aborted`、不 throw、返回 499;pre-response timeout → `failed` + 经 forwardError 504。用注入的 transport mock(reject http2-client 风格的 AbortError,配合 mock `clientAbort.signal.aborted` / `raw.signal.aborted`),**不起真实服务器**(`*.it.test.ts`)。
- **回归 tripwire**:既有 `tests/transport/http-transport.it.test.ts` 的 "AbortError re-throws original" 用例保持绿(传输层行为不变,只改 handler/forwardError 的消费)。

---

## 4. 设计:③ pre-response 保活(架构改进,有 tradeoff)

### 4.1 目标与约束

让 `stream:true` 的 Anthropic 请求在等待上游响应头期间,对客户端**已经是一条活的 SSE 流**并周期性打 ping,使 opus server-side 长思考(pre-response 静默数十秒~数百秒)不触发客户端超时断开。

硬约束:
- **Anthropic SSE 协议**允许在 `message_start` 前/任意位置插 `event: ping`(客户端契约上须忽略)。但我们一旦对客户端发出 200 + 任意字节,就**无法再改 HTTP 状态码**。
- **与真实 Anthropic 的发散点**:真实 Anthropic 对 `stream:true` 请求,**校验/拒绝阶段的错误仍回 HTTP 4xx**(它只在确定要生成时才打开 200 SSE 流);只有**流已开始之后**的错误才走 SSE error 事件。故"一收到请求就立即开 200"会让"上游响应头到达前的错误窗口"偏离真实上游 —— 这是 §4.2.2 的延迟-commit(grace window)要消除的发散,也是 Q2 oracle 验证的核心。
- 当前 driver 的形状是 `await runRequest`(拿到上游响应/状态)→ 才决定 stream/non-stream、才 `streamSSE`。③ 要打破这个顺序:对已知 `stream:true` 的请求,**在上游 grace 窗口耗尽后**乐观提前 streamSSE。

### 4.2 方案 A(推荐,采**延迟-commit 变体** §4.2.2):grace 窗口内正常 await,超时才乐观开流 + ping

对 `stream:true` 请求(`clientRaw.stream === true`,同步可判,见 §4.2.0):

1. **先正常 `await driver.runRequest(...)`,但只等一个有界 grace 时长**(`preStreamGraceSec`,默认远小于客户端超时、远大于正常上游延迟,如 30–60s)。grace 内上游回头(成功或错误)→ 走**现状路径**:拿真实上游状态 → 成功接 pump / 错误经 forwardError 出正确 HTTP 状态码。**零发散**(§4.2.2)。
2. **grace 耗尽上游仍静默** → 此刻才 `streamSSE(c, ...)`(回 200 + SSE headers),挂 `makeSseSink` heartbeat(`anthropicFakeSseHeartbeat` 间隔打 `event: ping`),并在回调内**继续** `await` 同一个 runRequest(不重发,见 §4.2.2 实现注)。
3. runRequest 成功 → 接 `pumpAnthropicStreamingV4`(同一 sink 接管,**避免双 heartbeat**,Open Q5)。
4. runRequest 抛 **HTTPError**(上游 4xx/5xx)或 **decideRoute reject**(代理协议拒绝)→ **若已 commit 开流**(grace 已过)→ 合成 Anthropic `event: error` 帧(`{type:"error", error:{type, message}}`)+ `ctx.fail` + 关流(pump 的 H3 路径 [handler-v4.ts:601](../../src/routes/messages/handler-v4.ts#L601) 已这么做);**若尚未 commit**(grace 内)→ 仍经 forwardError 出 HTTP 状态码(零发散)。
5. runRequest 抛 **AbortError/TimeoutError**(pre-response 客户端断开/超时)→ `ctx.abort()`/`ctx.fail` + 停 heartbeat;客户端断开时不再写字节(`settled-abort` 语义)。

#### 4.2.0 为什么"流式与否"同步可判(不需先 await 上游)

`env.stream` 在 S1 parse 时从客户端 payload 取(`stream: anthropicPayload.stream ?? false`,[codec.ts:316](../../src/lib/codec/anthropic/codec.ts#L316))且 envelope 上 `readonly stream: boolean`([envelope.ts:90](../../src/lib/pipeline/envelope.ts#L90))—— **一次设定、全链不可变**。sanitize/preprocess/parse 都不改它。故 `clientRaw.stream` 是 `env.stream` 的忠实预判,开流决策 100% 在 await 上游之前可定。特殊路径(warmup [:135](../../src/routes/messages/handler-v4.ts#L135) / count_tokens 独立 route / web_search 双跳 [:174](../../src/routes/messages/handler-v4.ts#L174))已在 `runMessagesDriver` 之前剥离,进 driver 的请求 `stream` 标志忠实。`stream:false` 不进 ③(仍 `c.json` + 真状态码)。

#### Tradeoff 与影响面

| 维度 | 影响 |
|---|---|
| **状态码** | `stream:true` 的 pre-pump 失败(上游 4xx/5xx + 代理 `decideRoute` 400)**仅在已 commit 开流后**(grace 耗尽,§4.2.2)才降级成 SSE error 帧;**grace 内的失败仍出正确 HTTP 状态码**(与真实 Anthropic 一致,零发散)。非流式(`stream:false`)路径**完全不受影响**。延迟-commit 把发散收窄到"长 stall 后才报错"的极少数 —— 但该残余仍需 oracle 验证(Open Q2)。 |
| **finalize 责任(硬约束,H2)** | early-200 后响应即 `text/event-stream`,`observabilityMiddleware` 见 SSE **直接 return、不 finalize**("stream consumer owns it")。故**终态责任全部转入 streamSSE 回调**:当前 [handler-v4.ts:323-336](../../src/routes/messages/handler-v4.ts#L323) 的 settle catch 在 streamSSE **之外**,方案 A 必须把它整段挪进回调内并补齐 abort/fail/HTTPError(→SSE error 帧)三分支 + `sink.close()`。中间件安全网在 SSE 下本就失效,回调必须**自包含全部终态**,否则留 dangling entry。详见 §4.2.1。 |
| **history `httpStatus`** | 流式上游错误的 history 记录从"有上游 4xx 状态"变为"200 客户端流 + error 帧";`inboundResponse`/attempt 仍保留上游真实状态(richest-data-flow:后端存储完整)。`state` 仍应为 `failed`(经回调内 `ctx.fail`)—— 需确认 ctx.fail 在已开流(已 200)下 state/httpStatus 记录语义不被 early-200 破坏。 |
| **非 Anthropic 格式** | 本 RFC ③ 仅做 Anthropic `/v1/messages`(bypass-direct,handler 自持 streamSSE)。CC/Responses 的 driver-owned sink(Stage B)已是另一套写出路径,pre-response 保活若要推广需单独评估,**不在 ③ 范围**(YAGNI:先解 opus 长思考这个实测痛点)。**①(forwardError)跨全格式生效**(CC/Responses/Gemini 的 pre-response abort 也同构 `await runRequest` 在 streamSSE 前、throw 到 `forwardError(c, error, fmt)`,出 504/499),需每格式补单测(§3.3)。**但 ②(aborted 终态)Anthropic-only**(round-2 H-2):CC/Responses/Gemini 的 client-abort 经 ① 出 499、终态仍 `failed`,永久不一致 —— 见 Q7 决议。 |
| **early-200 的副作用** | 一旦回 200,若 runRequest 在**重试**(driver 错误驱动重试环,如 truncate/beta 重试)中多次 attempt,客户端已在等流——重试期间 ping 维持即可,语义不变(客户端本就只看最终流)。需确认 pre-response heartbeat 跨多 attempt 不被提前 stop;且重试最终失败时仍走 SSE error 帧(非 HTTP 状态)。 |

#### 4.2.1 finalize 必须自包含(round-1 review H2,实现期最易漏的结构点)

方案 A 把 `streamSSE` 提到 `runRequest` 之前后,生命周期重排为:

```text
return streamSSE(c, async (stream) => {
  // sink 在 runRequest 前 attach 起 ping;传 clientAbortSignal 让客户端断开后 heartbeat 不再向死流写 ping(M-3)
  const sink = makeSseSink(stream, { heartbeat: { intervalSec: state.anthropicFakeSseHeartbeat, pingFrame: {...}, clientAbortSignal: clientAbort.signal } })
  stream.onAbort(() => clientAbort.abort())
  try {
    const result = await driver.runRequest({...})           // 原本在 streamSSE 之前
    // decideRoute reject / HTTPError → 在此 catch,合成 SSE error 帧(H1)
    // 成功 → 停 pre-response ping、接 pumpAnthropicStreamingV4(同一 sink,Q5)
  } catch (error) {
    // 终态在此自包含(中间件不再兜底)。ctx 可能 undefined(client-abort 早于 codec.parse
    // 建 ctx 时)→ 保留 `if (ctx)` 守卫(round-3:否则 NPE);ctx 缺失时仅关流、不 settle。
    //   client-gone(clientAbort.signal.aborted)→ ctx?.abort() + 不写字节(已 200,无 499)
    //   HTTPError / decideRoute reject → ctx?.fail() + sink.writeSynthetic(error 帧)
    //   timeout / 其它 → ctx?.fail() + sink.writeSynthetic(error 帧)
  } finally {
    sink.close()         // L1:sink 在 runRequest 前 attach,抛错没进 pump 也必须显式关 timer
    detachClientAbort()
  }
})
```

硬约束:
- **回调内必须 settle ctx 的每条退出路径**(success/abort/HTTPError/timeout),因为 `observabilityMiddleware` 对 SSE 响应不 finalize(middleware 见 `text/event-stream` 即 return)。
- **client-abort 在 C3b 下无 499**(round-2 C-1):已 200 flush,client-gone 只能 `ctx.abort()` + 停止写字节 + 关流;状态码层不可达。这与 C2 阶段的 499-return 是同一终态语义(`aborted`)的不同 HTTP 表现。
- **`sink.close()` 必须在 `finally`** —— sink 在 runRequest 之前 attach 起了 heartbeat timer,若 runRequest 抛错没进 pump,pump 的 finally `close()` 不会执行,timer 会泄漏(虽 `unref` 但应显式关,round-1 L1)。
- **single-sink 跨 pre/post-response**(Q5):同一 `makeSseSink` 实例从 pre-response ping 一路用到 pump,避免双 heartbeat 交接窗口;已核 [client-sink.ts](../../src/lib/pipeline/client-sink.ts) 的 sink 只依赖 `SSEStreamingApi`、不依赖 upstream 就绪,可提前 attach,写入经单 Promise chain 串行化(无字节交错)。heartbeat tick 用 `clientAbortSignal` 抑制对死流的 ping([client-sink.ts:174](../../src/lib/pipeline/client-sink.ts#L174)),故伪码必须传 `clientAbortSignal: clientAbort.signal`(M-3)。

#### 4.2.2 延迟-commit(grace window)—— 把发散面缩到趋近零(设计精化,用户提问驱动)

纯"立即开流"对所有 `stream:true` 的 pre-generation 错误都发散(§4.1 硬约束);**延迟-commit** 把"提前 200"推迟到上游 grace 窗口耗尽之后,只对**真正长 stall**的请求 commit:

| 场景(stream:true) | grace 内上游是否回头 | 行为 | 是否发散 |
|---|---|---|---|
| 正常生成(2–5s 回头) | 是 | 现状:接 pump | 否 |
| 上游快速错误(400/401/429,亚秒~数秒) | 是 | 现状:forwardError 出 HTTP 4xx | **否**(与真实 Anthropic 一致) |
| opus pre-response 长思考(本 incident) | 否 | grace 后开 200 + ping,最终接 pump | 仅此场景"提前 200" |
| 长 stall 后才报错(罕见) | 否 | 已 commit → SSE error 帧 | 仅此极少数发散 |

关键洞察:**上游错误几乎都是亚秒~数秒级的快速决策**(校验/限流/鉴权,不需要"思考"),远在 grace(30–60s)之内回头 → 仍出正确 HTTP 状态码。真正撑过 grace 的只有"上游在思考、终将产出内容"的 stall(它不会 pre-response 报错)。于是 **Q2 的 oracle 验证面从"所有流式错误"缩到"长 stall 之后才发生的极少数错误"**,风险大幅下降。

代价:病态 stall 的客户端多等 grace 那几十秒才收到首个 ping —— 但仍在客户端超时内,且远优于当前直接断线失败。

实现注(不重发上游):grace 不是"等 grace 再发请求",而是**一发即 await**,用 `Promise.race([runRequestPromise, graceTimer])` 观察哪个先到。runRequest 先到 → 现状路径;graceTimer 先到 → 开流,然后回调内**继续 await 同一个 `runRequestPromise`**(同一上游请求、同一 attempt,不重发)。`preStreamGraceSec` 进 config(`anthropic.pre_stream_grace` 或复用 `anthropicFakeSseHeartbeat` 语义),`0` = 退化为纯"立即开流"方案 A。

### 4.3 方案 B(备选,不推荐):仅延长不开流

不提前开流,而是想办法让客户端别超时(如依赖 TCP keepalive / 调大客户端超时)。否决理由:客户端超时不可控(Claude Code 内置),TCP keepalive 不阻止应用层请求超时;治标不治本。

### 4.4 方案 C(备选):缩短 response_header 超时 + 主动失败重试

把 `response_header` 超时调到客户端超时以下,主动 504 让客户端重试。否决理由:opus 长思考是**正常行为**,主动 504 把正常请求判死,且重试只会再次长思考;反模式。

**结论:③ 采方案 A**(若评审通过)。

### 4.5 ③ 的 golden 防护(methodology-golden-fixture-pre-capture)

③ 改动流式生命周期,必须先在**改动前旧代码**上锁 golden:

- 录制现有 `stream:true` 正常完成的 forwarded SSE 序列(归一化易变字段:id/timing),证明方案 A 接 pump 后逐帧等价。
- 录制上游 400(流式)的现有行为(当前会经 forwardError 出 HTTP 400),记录为"方案 A 后该变为 200 + error 帧"——这是**有意的行为变化**,golden 用于确认变化范围精确(只动状态码层,error 帧内容等价)。

---

## 5. Commit invariants(methodology-commit-invariants — 每个 commit 终态自洽,绝不半坏)

| commit | 终态不变量 |
|---|---|
| **C1: ① forwardError 分类 abort** | forwardError 对 abort 出 504(超时)/499(客户端断开,靠 `raw.signal.aborted` 判别)+ 良性日志;catch-all 仅剩**真正未知**的非 HTTP 错误。全格式 route 的 catch 经此出口行为一致。单测绿。系统完整可用(纯出口降噪,不碰请求流)。**已知过渡态(round-1 M2)**:C1 单独存在、② 未上时,pre-response 客户端断开仍经 handler `ctx.fail`→`failed`,但 HTTP 已是 499 —— `state=failed` + `status=499` 短暂不一致。这**不是半坏**(系统能跑、数据没丢、status 已正确),是 C2 待修正的已知过渡;telemetry 的 failed 计数在 C2 落地后才与 status 对齐。**① 的 499(client-gone)分支的活/死(round-3 澄清)**:② 落地后 Anthropic 的 client-abort 由 ② 的 `c.body(null,499)` 出(handler 返回非 throw,不进 forwardError),故 ① 的 client-gone 分支对 **Anthropic 变死代码**、仅对 CC/Responses/Gemini(② 未覆盖,仍 throw 进 forwardError)是活代码;Anthropic 经 ① 只走 timeout→504 分支。二者互斥,无重复出 499。 |
| **C2: ② pre-response client-abort 记 aborted** | **定义性不变量:pre-response client-abort 统一为 `ctx.abort()` 终态(`state=aborted`)**(round-2 C-1:这才是 C2 的核心,499 只是附带表现)。handler catch 区分 client-gone(`clientAbort.signal.aborted`,优先于 timeout → `ctx.abort()`)vs timeout/真失败(→`ctx.fail`+rethrow→C1 的 504/原码)。**HTTP 表现随阶段**:C2 阶段(streamSSE 仍在 runRequest 后)client-gone 在 catch 里 `return c.body(null, 499)`;C3b 后该 499 消失(已 200)。mid-stream 与 pre-response 的客户端断开终态统一为 `aborted`。**范围(Q7)**:本 commit 仅改 **Anthropic** handler;CC/Responses/Gemini 的 aborted 终态待 Q7 决议(否则它们经 ① 出 499 但终态仍 `failed`)。`*.it.test.ts` 绿。 |
| **C3a: ③ golden 预捕获** | 在 C1+C2 之上、改流程之前,golden 录制现有流式正常 + 流式上游错误(当前出 HTTP 4xx)行为。纯测试新增,不改 src。 |
| **C3b: ③ 方案 A 乐观开流** | `stream:true` pre-response 即开流打 ping(单 sink,§4.2.1);runRequest 成功接 pump、**所有 pre-pump 失败**(上游错误 + decideRoute reject,H1)降级 SSE error 帧;**client-abort 走 C2 的 `ctx.abort()` 终态语义,但无 499**(round-2 C-1:已 200);**终态全部在 streamSSE 回调内自包含**(H2,中间件不再兜底)、`sink.close()` 在 finally。golden(C3a)证明正常流逐帧等价、错误流变化范围精确(只动状态码层,error 帧内容等价)。非流式路径零改动。 |
| **(可选)C0: ⓪ http2-client 保留 abort reason** | 若评审采纳(§1.4):http2-client abort 路径 `reject(signal.reason ?? abortError())`,使 history `attempt.error` 保留 TimeoutError 文案。独立无害(其它消费端仍只看 `isAbortError`,name 从 "AbortError" 变 "TimeoutError" 不影响分类)。可作 C1 前置或独立 commit;504/499 判别**不依赖**它。 |

每个 commit 单独可发布、系统不半坏:C1 独立有用(降噪;过渡态 state/status 不一致是已知、非 bug);C2 依赖 C1 的超时出口但不依赖 C3;C3 依赖 C1/C2 的 abort 语义。⓪ 完全独立。

---

## 6. Open Questions(评审需拍板)

1. **Q1 客户端断开的状态码** —— 499(nginx,client closed)vs 408(标准 Request Timeout)vs 干脆不返回 body(连接已断,Hono 需要一个 Response 对象)。倾向 499(语义最准),但需实测 `ContentfulStatusCode` 类型 + Hono 对已断连接写 499 的行为。
2. **Q2 ③ 的 oracle 验证** —— 方案 A 把流式上游错误从 HTTP 4xx 改为 200+SSE error 帧。需用**真实 Claude Code / Anthropic SDK**(独立 oracle,non self-consistent)确认其对 `event: error` 帧的处理与对 HTTP 4xx 等价(self-consistent-needs-independent-oracle)。**延迟-commit(§4.2.2)已把验证面从"所有流式错误"缩到"长 stall 之后才发生的极少数错误"** —— 但该残余仍是 ③ 是否安全的 make-or-break,须实测。
3. **Q3 顶层 `.error` 投影** —— history 顶层 `.error`/`.failureReason` 为 null(数据在 attempt 层未丢)。是否在本 RFC 一并修顶层回填(richest-data-flow),还是单列。倾向单列(本 incident 不依赖它)。
4. **Q4 流式 pre-response 期的 shutdown** —— [send.ts:99](../../src/lib/transport/send.ts#L99) 流式不折 `getShutdownSignal()`(注释:stream guard 在 handler 拥有 shutdown)。但 pre-response(streamSSE 前)还没进 guard,故流式请求在 pre-response 期遇优雅关闭不会被 shutdown 中断(靠 graceful_wait 300s 兜)。是否值得在 pre-response 折 shutdown?边缘,倾向不动(记录即可)。
5. **Q5 ③ 双 heartbeat 交接** —— **round-1 已基本解**:pre-response heartbeat 与 pump 内 heartbeat 复用**同一 `makeSseSink` 实例**(sink 只依赖 `SSEStreamingApi`、不依赖 upstream 就绪,可在 runRequest 前 attach,timer 自重排,写入单 Promise chain 串行化无字节交错 —— 已核 [client-sink.ts](../../src/lib/pipeline/client-sink.ts))。剩余:实现期确认 sink 在 runRequest 抛错(未进 pump)时由回调 finally 的 `sink.close()` 停 timer(§4.2.1,round-1 L1)。
6. **Q6 ③ 范围是否含 CC/Responses** —— 本 RFC ③ 只做 Anthropic。CC/Responses 是否有同类 pre-response 长思考痛点?无实测证据则 YAGNI 不做(记录待触发)。
7. **Q7 缺陷②(aborted 终态)的格式范围**(round-2 H-2) —— ② 的 `ctx.abort()` 改动在 Anthropic handler。CC/Responses/Gemini 各有独立 handler catch,不自动获得;它们经 ①(forwardError)出 499 但终态仍 `ctx.fail`→`failed`,形成永久 `state=failed`+`status=499` 不一致。两选:(a) 声明 ② 为 **Anthropic-only**,在 §4.2 + 文档诚实标注其余格式的不一致(YAGNI,本 incident 是 Anthropic);(b) 把 client-abort→`ctx.abort()` 处理**推广到全部格式 handler**(一致性更好,但扩面)。倾向 (a) + 文档标注,除非评审要求全格式一致。

---

## 7. 不做什么(YAGNI 边界)

- 不改上游传输层(http2-client / send.ts 的 abort 合成与 signal 折叠**功能正确**)。例外:**可选 ⓪**(§1.4)—— http2-client abort 路径丢弃 `signal.reason` 是个独立的 lossy 缺陷,若评审要更干净的 abort provenance(history `attempt.error` 文案),可加一行 `reject(signal.reason ?? abortError())`;504/499 判别用 `raw.signal.aborted` 已够、不依赖它,故默认不强制。**但 ⓪ 也是判别冗余的预留**(round-2 M-1):504/499 现压在单一 `raw.signal.aborted` bool 上,若未来观测到 raw.signal 在非客户端断开场景被运行时翻转导致 504 误判 499,⓪ 保留的 TimeoutError 身份可作第二判据升级判别。
- 不引入"客户端断开就立刻 cancel 上游"以外的新生命周期(已有 bridgeClientAbort + NGHTTP2_CANCEL)。
- ③ 不推广到非 Anthropic 格式(无实测痛点)。注:① 对 CC/Responses 的 forwardError abort 仍生效(正确扩面),但 ③ 的乐观开流不做。
- 不为"将来也许"的 timeout 终态新增独立 state(`failed` + 504 已够;若评审要 timeout 专属终态再议)。

---

## 8. 验证命令(实现期)

```bash
bun run typecheck
bun run test:backend        # 含 forwardError 单测 + handler it 测 + http transport 回归
# ③ 的 oracle 验证(Q2)需真实客户端,不进自动化套件
```
