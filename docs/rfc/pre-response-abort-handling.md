# RFC: pre-response abort 处理 + opus 长思考保活

**Status:** **①②⑤ 已实现并提交**(① `ee4dd34` forwardError 分类 abort / ② `d4bced4` pre-response client-abort 记 aborted / ⑤ `c824df4` 孤儿 promise 崩溃防御);**④(reaper 装牙齿)+ C3b-pre1(mapHttpErrorToEnvelope 抽取)+ C3b-pre2(sink emitPingOnAttach)现在即实现就绪、不卡任何 Q——按 round-C 共识依序实现 pre1 → ④ → pre2**(④ 最高优先=真实泄漏);**③(C3b 延迟-commit)设计就绪但实现阻塞于 Q2 实测 + 并发 L2 字段冻结**(round-C 发现 L2 演化引入 2 新 CRITICAL,见下方 Changelog + §4.2.1)。
**Date:** 2026-06-22
**Owner:** 排查会话(待实现会话接手)

### Changelog

**Review round C(2026-06-22,3 个并行多视角 subagent 全 RFC 审查:④⑤ / ③ 全新 / 跨切面实现就绪度)—— 达成实现共识 + 抓到活文档演化引入的 ③ 新 CRITICAL:**
- **[共识:现在可实现]** ④(reaper 牙齿)+ C3b-pre1 + C3b-pre2 三项均**不卡 Q2**、各自独立有用,依序 pre1 → ④ → pre2。④ 最高优先(真实资源泄漏)。
- **[④,HIGH 已补]** §5 commit 表原**缺 ④ 行**(下新增 C4)+ "全 5 格式 settled-abort 站点"实为 **6 个**(Responses HTTP [responses/handler-v4.ts] + WS [responses/ws.ts:332 独立 `sendErrorAndClose`+1011] 两站点);④ 中间 commit 必须编码 **provenance-before-signal 不变量**:第三 provenance(`StreamReaperCancelError`)落地**之前**绝不把 reaper signal 接进 guard,否则中间 commit"reaper-cancel 误判 client-abort→静默断流"(缺陷④反向重演)。
- **[⑤,确认完整]** `withRejectionObserver`([http2-client.ts:239](../../src/lib/transport/http2-client.ts#L239))包裹整个 promise,覆盖**整类** pre-response 孤儿 reject(abort/connect/RST/GOAWAY-before-response 全在同一 promise),不 swallow 真 awaiter,放宽全局 handler 的否决成立。
- **[③,2 新 CRITICAL,L2 演化引入,记入待 ③ 实现期修]** **(C1)** §4.2.1"复用同一 sink 接 pump"破裂:`pumpAnthropicStreamingV4`([handler-v4.ts:616](../../src/routes/messages/handler-v4.ts#L616))**自建 sink**、签名只收 `stream`([:514](../../src/routes/messages/handler-v4.ts#L514)) → ③ 须重构 pump **接收注入的 sink**,否则双 makeSseSink 共享同一 stream → 字节交错。**(C2)** COMMIT 分支 `await p` 把 decideRoute reject 当 throw——但 `runRequest` 对 reject 走 `return {ok:false}`([driver.ts:146](../../src/lib/pipeline/driver.ts#L146),resolve 非 throw),COMMIT 须**显式判 `result.ok===false`** 再走富错误帧。
- **[③×④,HIGH]** ④ abort 在飞 fetch,而 ③ POST-COMMIT `await p` 正是那个 fetch → reaper-cancel 既非 client-gone 又非真 timeout,COMMIT catch 须作**第四类显式分支**(与 reaper 自身 `ctx.fail()` 用 `settled` guard 去重)。
- **[doc-sync]** ①②⑤ 已实现但 §3.1/§3.2 仍是伪码(为**设计意图**,实现见 forward.ts:449 / handler-v4.ts:332)、§4.2 表把②写"待 Q7"——**Q7 已被实现回答为 (a) Anthropic-only**(非待决议);request.ts 行号漂移(abort 实 :476、recordFeature :614)实现期校准。
- **[keepalive 命名,解耦]** §4.2.3.1 重整面对**已发布的 L2 活字段族**(`protect_streaming_*`),范围比暗示大(schema/config/validation/compat),应**与 ③ 同期、L2 字段冻结后**单独做,**不阻塞 ④/pre1/pre2**。
- **[Q2 tradeoff]** grace 取大把"发散频率"换成"单次严重度",非纯增益,Q2 须实测这条尾巴的客户端体验。


**第二起 incident 增补(2026-06-22)—— 911s stale-reaper force-fail + 未捕获 AbortError 崩服务器。** 新增缺陷④(reaper `ctx.fail()` 不取消在飞上游、装饰性 force-fail → 资源泄漏到 1200s,暂缓待本 RFC 实现期一并修,正确修法需独立 `StreamReaperCancelError` provenance 而非折进 guard `clientSignal`)与缺陷⑤(孤儿无-awaiter 上游 fetch 的 abort 拒绝经 main.ts unhandledRejection → exit(1) 崩整服务器,**已修复**:http2-client 防御性 rejection observer,实测 Bun+Node)。经两个对抗 subagent 并行复现确认:awaited 上游链永远被既有 catch 接住(0 unhandled),崩溃需真正遗弃的 promise;reaper-teeth 折进 guard `clientSignal` 会误判 reaper-cancel 为客户端断开(静默断流 + 错记 aborted)——故④ 暂缓走正确设计。详见 §2 缺陷④⑤。

**Review round B(2026-06-22,对抗复审)—— 判定 ③ 收敛,无新设计层 CRITICAL。** 仅三处伪码/文档保真订正(已修):
- **[round-A 重写遗留]** §4.2.1 COMMIT 分支误用 `env.ctx`(COMMIT 时 p 未 resolve、env 不存在)→ 改 `codec.getContext()?.recordFeature`(parse 已建 ctx)。
- **[内部矛盾]** §4.2.1 首 ping 用 `writeSynthetic`(刻意不采样 forwarded 轨)与 §4.2.6"ping 入 forwarded 轨作诊断信号"冲突 → 改为给 sink 加 `emitPingOnAttach`(采样写),列为 C3b sink 子步。
- **[低估重构]** §4.2.5"复用 forwardError type 映射"实为前置重构:forwardError 分派耦合在 `c.json` 内联,须先抽 `mapHttpErrorToEnvelope` 纯函数 → 列为 C3b 前置子步。
- **[MEDIUM]** `stalledMs`→`stalledAtLeastMs`(COMMIT 时只知下界)+ resolve 后补真实 totalStalledMs;新 feature key 须登记 `FeatureKind`;onAbort 注册先于首 ping(L1)。
- **[确认无洞]** Q2 unhandledRejection 论断成立(`p.then(ok,err)` 入 race 永久挂 reject reaction,回调 `await p` 是第二 reaction,无 unhandled 窗口);非流式 100% bypass race;首 ping 必要性成立。

**Review round A(2026-06-22,3 个并行多视角 subagent:协议/兼容、生命周期/并发、配置/状态机)—— ③ 大改,3 CRITICAL 已纳入设计:**
- **[CRITICAL 协议]** POST-COMMIT 的 SSE error 帧丢失 HTTP 状态码 + `error.type` + `retry-after`,双 oracle 实证 Anthropic SDK 对流内 error 走 `.status===undefined` 裸 APIError + 零自动重试;且现有 `anthropicStreamErrorType` 只产 3 值会把 401/400/429 拍平成 `api_error`。**新增 §4.2.5**:POST-COMMIT 必须复用 forwardError 的 type 映射(保 error.type/retry_after),残余(SDK 无自动重试)入 Q2。
- **[CRITICAL 配置/生命周期]** heartbeat 首 ping 等满一个 interval([client-sink.ts:188](../../src/lib/pipeline/client-sink.ts#L188) 实证),grace+120s 首 ping 延迟可能超客户端超时 → ③ 救不了。**§4.2.1 升为硬约束**:commit 时**立即**补一帧 ping。
- **[CRITICAL 生命周期]** §4.2.1 旧伪码(runRequest 在回调内)与 §4.2.2 实现注(promise 外置)自相矛盾,照旧伪码会**双发上游**。**§4.2.1 重写为两段式**:promise 外置、race 在外、streamSSE 只在 commit 调、回调内只 await 同一 promise。
- **[HIGH]** graceTimer 必须 `setTimeout`+`clearTimeout`(非不可取消的 `AbortSignal.timeout`);`grace=0` 必须完全 bypass race(否则 `setTimeout(0)` 先 fire → 变最激进,与"禁用"相反);约束链补 `grace < streamIdleTimeout`;race tie → upstream 优先;grace 默认值依赖**实测**客户端超时(SDK 默认 600s time-to-headers,Claude Code 阈值未从源码 pin)。
- **[MEDIUM]** commit 点 `recordFeature("pre_stream_grace_commit")` 可观测(否则与正常流不可辨);config 归属 `anthropic.*`(避开 `timeouts.*` 的 dispatcher 重建);config-hot-reload 测试矩阵是硬门(§8);staleReaper 与 commit 后 settle 的幂等需实现期测试。
- **[正向确认]** §4.1"真实 Anthropic 校验回 4xx"+ "ping-before-message_start 安全" 双 oracle 证实(§4.2.7),两个假想命门解除;heartbeat 实际 120s(非旧稿误写 240)已全文订正。

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

## 2. 真实缺陷(按 architecture-health-first「问题是否真实存在」分流)

> 缺陷①②③ 是 2026-06-22 首轮排查(292s pre-response stall,经 forwardError 出 `[ERR] 500`)。缺陷④⑤ 是 2026-06-22 第二起 incident(911s stale-reaper force-fail + **未捕获 AbortError 崩服务器**)新增——⑤ 已修复落地、④ 暂缓待本 RFC 实现期一并做。

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

`stream_fake_sse_heartbeat`(本配置当前 120s,bundled 默认 0)的心跳 sink 在 [handler-v4.ts:568](../../src/routes/messages/handler-v4.ts#L568) `makeSseSink` 里建立,而该点在 `pumpAnthropicStreamingV4` 内、即**上游响应头到达之后**才执行。pre-response 静默期根本没有 SSE 通道可注入 ping,所以心跳对本场景**完全失效**。

①② 只是把已发生的故障「记录得正确」(降噪 + 正确终态/状态码),**③ 才是真正让 opus 长思考不再被客户端超时断线**的修复。

代价(architectural tradeoff):对 `stream:true` 请求若提前回 200 SSE 并在等上游期间打 ping,则**一旦提交 200,上游万一回非 200 错误就只能以 SSE error 帧下发**,而不能再用 HTTP 错误状态码。详见 §4。

①② 已落地(commit ee4dd34,见 [error.unit.test.ts:740](../../tests/infra/error.unit.test.ts#L740) + [pre-response-abort.http.test.ts](../../tests/anthropic/pre-response-abort.http.test.ts));③ 待实现;④⑤ 见下。

### 缺陷④:stale reaper 空有其名 —— `ctx.fail()` 不取消在飞上游(资源泄漏,暂缓)

第二起 incident 的日志:

```
[WARN] 16:11:59 [context] Force-failing stale request req_1782143808581_141 (endpoint: anthropic-messages, model: claude-opus-4-8, stream: true, state: executing, age: 911s, max: 900s)
[FAIL] 16:11:59 POST /v1/messages claude-opus-4.8 911.3s ↑628.3KB ↓5.1KB: Request exceeded maximum age of 900s (stale context reaper)
```

reaper 的 `runReaperOnce`([manager.ts:185](../../src/lib/context/manager.ts#L185))在 `ctx.durationMs > maxAge` 时只调 `ctx.fail(...)`——而 `RequestContext.fail()`([request.ts:428](../../src/lib/context/request.ts#L428))**仅记录终态 + 写 history + 移出 active map**,不取消在飞的上游 HTTP/2 fetch、不中止 handler 协程。`RequestContext` 根本没有 AbortController。于是「force-fail」是**装饰性的**:上游 h2 流、handler 协程、客户端 socket 一直活到 `response_header` 超时(本配置 1200s)才真正了结——比声明死亡晚 ~289s 的资源泄漏,且 `[FAIL]` 日志是个谎言(请求并未真的结束)。`state: executing` + `↓5.1KB` = L2 buffered retry(`protect_streaming_generation: tool_use_only`)第一次尝试转发了 5.1KB 后截断、第二次尝试 pre-response 卡住。

**暂缓理由 + 正确修法(待本 RFC 实现期一并做)**:给 reaper「装牙齿」不能简单把一个新 signal 折进现有 stream guard 的 `clientSignal`——`guardSseIterable`([stream.ts:290-291](../../src/lib/stream.ts#L290))只有 shutdown / client 两个 provenance 桶,一个 reaper-cancel 折进 `clientSignal` 会被**误判成客户端断开** → `StreamClientAbortError` → handler 走 `settled-abort` → 对**仍连着的**客户端静默断流(零字节、无 error 帧)+ 错记 `aborted` 终态(正与缺陷② `abort()` 注释要防的 metric 污染反向重演)。正确修法需引入**独立的 `StreamReaperCancelError` / 第三 provenance**(映射为 `stream-error` → 给仍连着的客户端发合成 error 帧、记 `failed`),并把 `RequestContext` 的生命周期 AbortController 作**新命名参数**喂给 guard(而非折进 `clientSignal`),且要覆盖全 5 格式 handler 的 settled-abort 站点。这是与 ③ 同源的「pre-response/in-flight 生命周期」改动,故并入本 RFC 实现期(C 系列之后),而非独立小修。资源泄漏有界(1200s `response_header` 封顶)、先存的,可暂缓。**实测确认**:reaper-teeth 折在**已 await 的**上游 fetch 上不会引入缺陷⑤ 的崩溃(awaited abort 永远被既有 catch 接住,见 exp/stale-abort-unhandled/repro-fullstack.ts:0 unhandled)。

### 缺陷⑤:孤儿(无 awaiter)上游 fetch 的 abort 拒绝崩溃整服务器 —— 已修复

第二起 incident 的崩溃栈:

```
AbortError: The operation was aborted.
    at abortError (src/lib/transport/http2-client.ts:100)
    at onPreResponseAbort (src/lib/transport/http2-client.ts:138)
    at abort (unknown)
```

`http2Fetch` 的 `onPreResponseAbort`([http2-client.ts:148](../../src/lib/transport/http2-client.ts#L148))在 abort 时 `reject(abortError())`。当这个 fetch promise 在 abort 触发时**已被遗弃(无 live awaiter)**——它的 await 链经另一路径(如 reaper force-fail 后 handler 已 settle、或某并发/detached 路径)先行了结——这个 reject 变成 process 级 `unhandledRejection`,而 [main.ts:29](../../src/main.ts#L29) 的 `process.on("unhandledRejection")` 随即 `process.exit(1)`,把**一条良性的「某在飞操作被取消」放大成杀掉所有并发请求的整进程崩溃**。

**实测确认机制**(exp/stale-abort-unhandled/,真实本地 node:http2 server):http2Fetch 的 abort 拒绝在**被 await 时正常捕获**、在**promise 被遗弃时变 unhandled**(栈与生产逐帧一致);最小化的 reject-in-abort-listener 不泄漏 → 确属遗弃 promise 特有,非 Bun 通病。**遗弃 promise 的确切来源未能纯静态定位**(主 handler/driver/retry 路径全 await=安全,经多轮 subagent 全栈复现仍 0 unhandled;后台 fire-and-forget fetch 都有 `.catch`)——最可能是 adaptive rate-limiter 的 detached `void this.processQueue()`([adaptive-rate-limiter.ts:421](../../src/lib/adaptive-rate-limiter.ts#L421))或并发请求共享 h2 session 的边角。

**修复(已落地)**:在 `http2Fetch` 返回的 promise 上挂一个**防御性 no-op rejection observer**(`withRejectionObserver`,[http2-client.ts](../../src/lib/transport/http2-client.ts)):`p.catch(()=>{})` 把孤儿 reject 在全局层标记为已观察,**但不消费它**(返回原 `p`,真实 await/.then 消费者仍独立收到 reject)。这消除了**整类**「孤儿上游 fetch 的 abort/RST 拒绝崩服务器」缺陷,**不依赖**定位每个遗弃源(belt-and-suspenders)。实测 Bun+Node 双端验证(exp/stale-abort-unhandled/fix-technique.ts);回归测试 [http2-client.it.test.ts](../../tests/transport/http2-client.it.test.ts)「abandoned (no-awaiter) promise aborted pre-response does NOT emit a process unhandledRejection」+「observer does not swallow the rejection from a real awaiter」。

**为何不放宽全局 handler**:另一条看似更简单的路是让 [main.ts:29](../../src/main.ts#L29) 的 `unhandledRejection` 处理器对 AbortError「warn 但不 exit」。**否决**:`isAbortError`([classify.ts:265](../../src/lib/error/classify.ts#L265))过宽(匹配 `TimeoutError`、任何含 "abort" 子串的 message、cause 链),用在最后防线的全局崩溃 guard 上会把**真正该崩/该告警的未知 reject**(含 "abort" 字样的逻辑 bug、该 alert 的孤儿 `AbortSignal.timeout` 失败)静默降级、让进程在未知状态续跑。根因修复在产生点(http2-client 的 observer),全局 handler 保持严格。

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

#### 4.2.1 正确的两段式生命周期(round-A:伪码与实现注曾自相矛盾,已修)

**关键结构(round-A lifecycle C-1 修正)**:`runRequestPromise` 必须在 `streamSSE` **之外**创建,`Promise.race` 在外,`streamSSE` 只在 **commit 时**才调(回 200 即 commit)。回调内只 `await 同一个 promise`、**绝不重新调 `driver.runRequest`**(否则双发上游)。`grace=0` 时**完全 bypass race**,走当前行为(round-A config M-2:否则 `setTimeout(0)` 必先 fire → 变成最激进的"立即开流",与"禁用"语义相反)。

```text
const clientAbort = new AbortController()
const detachClientAbort = bridgeClientAbort(c, clientAbort)
const p = driver.runRequest({...})        // 一发即跑(含内部重试环),promise 外置

// grace=0 或非 stream → 完全 bypass:现状路径(await p,throw 经 §3.2 catch + forwardError)
if (state.preStreamGraceSec <= 0 || !clientRaw.stream) { /* 现状 §3.2 结构 */ }

// stream + grace>0:race。graceTimer 用 setTimeout(可 clearTimeout),禁用 AbortSignal.timeout(不可取消,round-A H-2)
let graceTimer
const graceFired = new Promise(res => { graceTimer = setTimeout(() => res("grace"), graceMs); graceTimer.unref?.() })
const first = await Promise.race([p.then(() => "upstream", () => "upstream"), graceFired])
clearTimeout(graceTimer)                   // 必清,防泄漏(round-A H-2 / L-2)

if (first === "upstream") {
  // tie 时让 upstream 优先(round-A H-2):p 已 settled → 走现状路径
  //   ok+stream → streamSSE 接 pump;throw → §3.2 catch + forwardError(零发散)
} else {
  // === COMMIT ===  graceTimer 先 fire,上游仍静默 → 提前开 200
  // ctx 来自 codec.getContext()(parse 已建),非 env —— COMMIT 时 p 未 resolve、env 还不存在(round-B H1)
  codec.getContext()?.recordFeature("pre_stream_grace_commit", { graceSec, stalledAtLeastMs: graceMs })  // 可观测(round-A M-3 / round-B M1)
  return streamSSE(c, async (stream) => {
    const sink = makeSseSink(stream, { heartbeat: { intervalSec, pingFrame, clientAbortSignal: clientAbort.signal } })
    stream.onAbort(() => clientAbort.abort())  // 先注册再写首 ping(round-B L1:最小化 commit 瞬间断开窗口)
    await sink.emitPingOnAttach(pingFrame)   // ★立即首 ping,且**必须采样 forwarded 轨**(round-B H2:不能用 writeSynthetic,它不采样;见 §4.2.3/§4.2.6)
    try {
      const result = await p               // 继续 await 同一 promise(不重发);REJECT 路径见下
      // 成功 → 真实总 stall 时长已知 → recordFeature("pre_stream_grace_resolved",{totalStalledMs})(round-B M1);接 pumpAnthropicStreamingV4(同一 sink)
    } catch (error) {                      // p 的所有失败都是 throw(round-A H-1:非 resolve 分支)
      // ctx 可能 undefined(client-abort 早于 parse)→ codec.getContext() 守卫(round-3)
      //   client-gone(clientAbort.signal.aborted)→ ctx?.abort() + 不写字节(已 200,无 499)
      //   HTTPError / decideRoute reject / timeout → ctx?.fail() + sink.writeSynthetic(富错误帧,§4.2.5)
    } finally {
      sink.close(); detachClientAbort()
    }
  })
}
```

硬约束:
- **promise 外置 + 回调内只 await**(round-A lifecycle C-1):否则照旧伪码会双发上游。`Promise.race` 已给 `p` 挂 reaction,故 graceTimer 赢后 `p` 后续 reject 不会 unhandledRejection(回调 `await p` 的 try/catch 接住)。
- **commit 立即首 ping,且必须采样 forwarded 轨**(round-A CRITICAL + round-B H2):`makeSseSink` 的 heartbeat 首 tick 排在**整个 interval 之后**([client-sink.ts:188](../../src/lib/pipeline/client-sink.ts#L188) `setTimeout(tick, intervalMs)` + [:176](../../src/lib/pipeline/client-sink.ts#L176) `elapsed>=intervalMs` 才发)。若不在 commit 时显式补一帧 ping,客户端要再等一个 interval(本配置 120s)才见首字节 → grace+120s 可能已超客户端超时,**③ 救不了它本要救的请求**。故 commit 后**必须**同步发一帧 ping —— 但**不能用 `writeSynthetic`**(它刻意不采样 forwarded 轨,[client-sink.ts:158](../../src/lib/pipeline/client-sink.ts#L158)),否则 §4.2.6 的"grace 期 ping 入 forwarded 轨作诊断信号"缺首帧。**需给 sink 加 `emitPingOnAttach(frame)`**:`sampleForwarded(frame) + writeSse(frame) + lastRealMs=now`(与 heartbeat tick 的 [:180-182](../../src/lib/pipeline/client-sink.ts#L180) 同款采样)。这是 ③ 的一处 **sink 改动项**(C3b 子步)。
- **graceTimer 用 `setTimeout`+`clearTimeout`**(round-A H-2):`AbortSignal.timeout` 不可取消会泄漏;`clearTimeout` 在 race 决出后立即调。
- **POST-COMMIT 终态全部经 promise REJECT**(round-A H-1):runRequest 的失败(HTTPError/decideRoute/timeout/abort)都是 throw,回调 `try/catch` 必须接住每条并映射(富错误帧 §4.2.5 / ctx.abort)。pump 在 `await p` **resolve 之后**才启动(commit 到 pump 之间只有 ping 在 sink 上)。
- **回调内必须 settle ctx 的每条退出路径**:`observabilityMiddleware` 对 SSE 响应不 finalize。
- **client-abort 在 POST-COMMIT 无 499**(round-2 C-1):已 200,client-gone 只能 `ctx.abort()` + 停写 + 关流。
- **single-sink**(Q5):同一 sink 从 commit ping 用到 pump;`sink.close()` 在 `finally` 兜 heartbeat timer。

#### 4.2.2 延迟-commit(grace window)—— 把发散面缩到趋近零

纯"立即开流"对所有 `stream:true` 的 pre-generation 错误都发散(§4.1);**延迟-commit** 把"提前 200"推到 grace 耗尽之后,只对**真正长 stall**的请求 commit:

| 场景(stream:true) | grace 内上游是否回头 | 行为 | 是否发散 |
|---|---|---|---|
| 正常生成(2–5s 回头) | 是 | 现状:接 pump | 否 |
| 上游快速错误(400/401/429,亚秒~数秒) | 是 | 现状:forwardError 出 HTTP 4xx | **否**(与真实 Anthropic 一致,§4.1 已双 oracle 证实) |
| opus pre-response 长思考(本 incident) | 否 | grace 后开 200 + 立即 ping,最终接 pump | 仅此场景"提前 200" |
| 长 stall 后才报错(罕见) | 否 | 已 commit → 富 SSE error 帧(§4.2.5) | 仅此极少数发散(且 §4.2.5 仍保 error.type) |

关键洞察:**上游错误几乎都是亚秒~数秒级的快速决策**(校验/限流/鉴权,不需"思考"),远在 grace 内回头 → 仍出正确 HTTP 状态码。撑过 grace 的只有"上游在思考、终将产内容"的 stall(它不 pre-response 报错)。**grace 越大,落入 POST-COMMIT 发散的错误越少**(round-A 协议 CA-1)——这与"commit 立即 ping"(§4.2.1)协同:解耦首 ping 后,grace 可安全取大(commit 尽量晚)以最小化发散。

#### 4.2.3 配置面(延迟时间可配置)

新增运行时选项 `preStreamGraceSec`:

| 选项 | 来源 | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `preStreamGraceSec` | config `anthropic.pre_stream_grace` | number | **待 Q2 实测客户端超时后定(见下)** | `stream:true` 请求提前开 200 SSE 流前等待上游响应头的 grace 秒数。`0` = 禁用 ③(完全 bypass race,退化为当前行为;`<=0` 短路 gate 见 §4.2.1)。grace 内上游回头零发散出正确 HTTP 状态码;耗尽才 commit 开流 + 立即 ping。 |

- **归属 `anthropic.*` 而非 `timeouts.*`**(round-A config M-1):虽语义是超时,但 ① ③ 仅 Anthropic(放 `timeouts.*` 会误导成全格式),② 经 `setAnthropicBehavior`(纯 state patch)应用,而 `timeouts.*` 走 `setTimeoutConfig` 会**触发 undici dispatcher 重建**——grace 是 per-request timer,绝不该挂到 transport 重建。RFC 显式说明此归属理由。
- **热重载**:per-request 读 `state.preStreamGraceSec` 构 timer,与 `anthropicFakeSseHeartbeat` 同构,纯 state 热重载(下一请求生效),不在"需重启"清单。**无 CLI flag**(跟随现有 timeout 字段惯例)。
- **登记 config-hot-reload 测试矩阵**(round-A config M-5,**硬验证门**):新增字段必须登记 `tests/config/config-hot-reload.it.test.ts` 表驱动矩阵或豁免清单,否则完整性守卫直接 fail。C3b commit 必含此项。

**默认值(round-A 协议 H-2 / config M-3:依赖实测,不可拍脑袋)**:约束链 `grace < 客户端超时` 且 `grace < fetchTimeout(response_header 900s)` 且 `grace < streamIdleTimeout(stream_idle 900s)`(round-A H-3 补:三个 900s 都须大于 grace,否则它们先 fire,③ 不生效)。**但"客户端超时"是单方声称、未从源码 pin**(round-A H-2:Anthropic SDK 默认 600s 是 time-to-headers 超时;Claude Code CLI 封装层的总/idle 超时未在 refs 找到)。故:
- 默认值**必须作为 Q2 oracle 实测的一部分**反推(实测 Claude Code 在 N 秒纯静默 vs N 秒带 ping 的断开行为,定超时类型与阈值)。
- 修了"commit 立即 ping"(§4.2.1)后,首 ping 延迟消除 → **倾向取大 grace**(尽量晚 commit,最小化 §4.2.5 发散面),但留足 margin。实测前**保守默认偏小(如 30–60s)**:margin 充足、几乎不漏救,代价(中等 stall 走 early-200)被 §4.2.5 的富错误帧缓解。
- **`anthropicFakeSseHeartbeat` 本配置当前 120s**(非旧稿误写的 240;[config.yaml:197](../../config.yaml#L197),bundled 默认 0)——commit 后**后续** ping 仍按它的 interval;**首个** ping 由 §4.2.1 在 commit 时立即补,二者解耦。

##### 4.2.3.1 keepalive 命名分类重整(用户指示:做最长远方案,③ 实现期一并)

用户 2026-06-22 指示:不做"把 `fake` 单独改掉"的 piecemeal rename,而是**一次性建立一套连贯的 keepalive 命名分类**。背景:心跳概念已变拥挤,实测有**三个**交叉的 knob/概念——
- `anthropic.stream_fake_sse_heartbeat`(`anthropicFakeSseHeartbeat`)—— mid-stream 客户端保活 ping 间隔。"**fake**" 不精确:注入的是**真正的 Anthropic 协议 `event: ping` 帧**,只是代理本地**合成(synthetic origin)**而非上游转发——"fake" 把"合成来源"误说成"不是真的"(注释其实已用准确词 "Synthetic SSE keepalive")。准确轴=**synthetic / keepalive**。
- `protectStreamingHeartbeat`(并发 L2 会话新增的 `protect_streaming_*`,[handler-v4.ts](../../src/routes/messages/handler-v4.ts) `forcedHeartbeatSec` fallback)—— buffered/protected-generation 路径的强制心跳。
- ③ 的 `pre_stream_grace`(grace)+ commit 后 ping cadence(复用上面的 interval)。

**最长远方案**(③ 实现期连同 `pre_stream_grace` 一起定):把这三者整理成一族连贯命名(如 `stream_keepalive_ping_sec` / 统一前缀 + grace 与 ping cadence 语义分清),经 [compat.ts](../../src/lib/config/compat.ts) 的 legacy→current 迁移层(声明式 migration builder + graceful warn,user-set 新键优先,**零破坏用户配置**)落地。**不现在单独改**——避免与并发 L2 刚加的 `protect_streaming_heartbeat` 各改各的、以及二次改名。**注**:① ② 是无条件正确性修复,**无、也不该有配置开关**(abort→499/504/aborted 严格优于旧 500/Unexpected/failed);整个 pre-response 功能的唯一 knob 是 ③ 的 `pre_stream_grace`。

#### 4.2.4 commit-point 状态机(精确生命周期)

`stream:true`(且 `grace>0`)请求经两态,**commit 点**(发首字节)是不可逆边界:

```text
[PRE-COMMIT]  未发任何字节;HTTP 状态码仍可由 forwardError 决定
  │  p = runRequest(...)(外置);await Promise.race([p, graceTimer])
  ├─ p 先 settle(grace 内上游回头;tie 时 upstream 优先,round-A H-2)
  │     ├─ ok → streamSSE 接 pump(此时才 commit,正常流)
  │     └─ throw(HTTPError / decideRoute / abort)→ 仍 PRE-COMMIT →
  │           forwardError 出正确 HTTP 状态码(504/4xx/499)或 §3.2 ctx.abort【零发散】
  └─ graceTimer 先 fire → **COMMIT**:recordFeature → streamSSE 开 200 → 立即 ping →
        回调内 await 同一 p →
        [POST-COMMIT]  已 200,状态码锁死;p 的一切结局经 resolve/REJECT(round-A H-1):
          ├─ p resolve(ok)→ 接 pump(同一 sink)
          ├─ p throw HTTPError/decideRoute/timeout → sink.writeSynthetic(富错误帧 §4.2.5) + ctx.fail
          └─ p throw client-abort → ctx.abort() + 停写 + 关流(无 499)
```

不变量:
- **grace<=0 / 非 stream → 完全 bypass race**(round-A M-2),状态机退化为当前 §3.2 结构(grace=0 = 禁用,**非**"立即开流")。
- **commit 单向**:一旦写首字节(立即 ping),不回退 PRE-COMMIT。
- **tie(同 tick)→ upstream 优先**(round-A H-2):避免边缘上无谓 commit 扩大发散。
- **PRE-COMMIT 终态走现状出口**(forwardError/§3.2),与 ①② 复用,零新发散。
- **POST-COMMIT 终态全经 promise reject、自包含于回调**(中间件不 finalize SSE);pump 在 `await p` resolve 后才起。
- **graceTimer `setTimeout`+`clearTimeout`**(round-A H-2),race 决出即清。
- **staleReaper 幂等**(round-A lifecycle M-2):COMMIT 后 `await p` 期间,若 staleReaper(900s)先 settle ctx,回调随后 `ctx.fail/abort` 须被 `settled` guard 兜住——实现期补幂等断言测试(新窗口,round-3 未覆盖)。

#### 4.2.5 POST-COMMIT 错误保真(round-A 协议 CRITICAL CA-1)

**这是 ③ 最被低估的发散**:POST-COMMIT 把上游错误降级成 SSE error 帧,会丢失 HTTP 状态码 + 结构化 `error.type` + `retry-after`。两 oracle 实测(Anthropic SDK `core/streaming.js:99` 对流内 error 直接 `new APIError(...)` 绕过 `generate()` → `.status===undefined`、非 `RateLimitError`/`BadRequestError` 子类、自动重试 `shouldRetry` 永不触发;GHC `messagesApi.ts` 流内 error 走泛型 `copilotErrors` 无状态码语义)证明:**200+SSE-error 与 HTTP-4xx 对 SDK 不等价**——一个对 429 退避重试的客户端在 ③ 下会收到 `.status===undefined`、无 retry-after 的裸 error,**静默放弃重试**。

更糟:现有合成器 [anthropicStreamErrorType](../../src/routes/messages/streaming-pump.ts#L33) **只产 3 值**(`timeout_error`/`overloaded_error`/`api_error`),会把上游 401/400/429 **全拍平成 `api_error`**,连 `error.type` 字面量都丢。而非流式 [forwardError](../../src/lib/error/forward.ts#L88) 精心保了 429→`rate_limit_error`+`retry_after`、413/422→`invalid_request_error`(注释明写"SDKs branch on error.type — must emit canonical literals")。

设计要求(硬约束,非可选):
- POST-COMMIT 合成 error 帧**必须复用 forwardError 的 type 映射**(保 `rate_limit_error`/`invalid_request_error`/`authentication_error` 字面量 + 把 `retry_after` 带进 payload),**不得**走 3 值的 `anthropicStreamErrorType`。
- **前置重构(round-B H3,C3b 子步)**:forwardError 的 status→type 分派**全程内联耦合在 `c.json(...)` 里**([forward.ts:347-436](../../src/lib/error/forward.ts#L347) 每个 status 分支 `helpers.X()` 紧跟 `return c.json`),从未抽成"返回结构化对象"的纯函数。POST-COMMIT 要的是 `{type, message, retry_after}` 塞进 SSE 帧(非写 HTTP 响应)。故须**前置抽取** `mapHttpErrorToEnvelope(error, format): { body, status }` 纯函数,让 forwardError 与 POST-COMMIT 共享(否则 POST-COMMIT 重复实现 status→type 判别 = DRY 违反 + [[feedback-fix-all-comparison-sites]] 复发风险)。好消息:Anthropic helper 输出形状([forward.ts:89](../../src/lib/error/forward.ts#L89) `{type:"error", error:{type:"rate_limit_error", message}}`)**恰等于** Anthropic SSE error 事件 data,抽取后对 Anthropic 直接可用。**§4.2.5"复用"实为一次前置重构 commit,C3b 计划须显式拆出。**
- 即便如此,SDK 的 `.status===undefined` + 自动重试缺失**协议层无法弥补**(SSE-error 相对 HTTP-error 的不可消除残余)——这是**为何 grace 取大、最小化落入 POST-COMMIT 的错误数**(§4.2.2)的根本原因,也是 **Q2 必须 oracle 实测**的核心(专测"200 流首个语义事件即 error 帧"对 429/401/400 的客户端分支)。
- **§4.5 golden 的"error 帧内容等价"是伪命题**——若沿用 `anthropicStreamErrorType` 则不等价;golden 须锁"富错误帧保 error.type/retry_after"。

#### 4.2.6 可观测(round-A config M-3/M-4,richest-data-flow)

- **commit 标记**:COMMIT 点 `codec.getContext()?.recordFeature("pre_stream_grace_commit", { graceSec, stalledAtLeastMs: graceMs })`([request.ts:613](../../src/lib/context/request.ts#L613) 现成挂载点;注意 COMMIT 时 ctx 来自 `codec.getContext()` 而非未就绪的 env,round-B H1),否则 grace-committed 后成功的请求与正常流式 history 形状**完全相同**,运维无法识别 ③ 触发率(调 grace 默认值的关键数据)。`stalledAtLeastMs`(非 `stalledMs`)因 COMMIT 时真实总 stall 未知、graceMs 只是下界(round-B M1);p 最终 resolve 后可补记 `pre_stream_grace_resolved{ totalStalledMs }` 供 grace 调参的真实分布。新 feature key **须登记进 `FeatureKind` 联合**(request.ts,否则 typecheck fail,round-B M2)。
- **ping 非对称**:pre-response 期注入的 ping 仅入 forwarded 轨(`inboundResponse.sseEvents`),上游 `sseEvents` 在 grace 期**保持空**([client-sink.ts:180](../../src/lib/pipeline/client-sink.ts#L180) sampleForwarded;DESIGN 原则3)——这正是诊断 ③ 触发的二级信号(客户端收到 ping 但上游零帧),与 commit 标记互补。

#### 4.2.7 正向确认(round-A 双 oracle,消除两个假想命门)

- **§4.1"真实 Anthropic 校验阶段回 HTTP 4xx"准确**:Anthropic SDK `client.js:511 if(!response.ok)` 先于流解析抛类型化 status error;GHC `chatMLFetcher.ts:1271` 注释"analogous to checking HTTP status before streaming body"。故延迟-commit 的"grace 内零发散"成立。
- **ping-before-message_start 安全**(原列为命门,解除):Anthropic SDK `core/streaming.js:96 if(sse.event==='ping') continue` 在迭代器层跳过、不进 ordering 校验;GHC switch 无 ping case 落 no-op。leading ping 对两个已验证客户端协议合法。

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
| **C3b-pre1: forwardError 分派核抽取** | 把 [forward.ts](../../src/lib/error/forward.ts) 的 status→{type,message,retry_after} 分派从 `c.json` 内联抽成纯函数 `mapHttpErrorToEnvelope(error, format)`,forwardError 改调它。纯重构、行为不变(现有 forwardError 测试绿即不变量),为 C3b 的富错误帧(§4.2.5)共享。round-B H3。 |
| **C3b-pre2: sink `emitPingOnAttach`** | 给 `makeSseSink` 加 `emitPingOnAttach(frame)`(采样 + write + 推进 lastRealMs),供 commit 立即首 ping(§4.2.1/§4.2.6)。独立小改,现有 sink 测试绿。round-B H2。 |
| **C3b: ③ 方案 A 延迟-commit** | 依赖 C1/C2 + C3b-pre1/pre2。`stream:true` + `grace>0` 走两段式(promise 外置 race,§4.2.1);grace 内回头零发散(现状出口)、grace 耗尽 commit 开流 + 立即采样 ping;**所有 POST-COMMIT 失败**(上游错误 + decideRoute reject)降级**富** SSE error 帧(§4.2.5 保 error.type/retry_after);client-abort 走 `ctx.abort()` 无 499;**终态全部在 streamSSE 回调内自包含**(中间件不 finalize SSE)、`sink.close()`+`clearTimeout` 在 finally;commit 点 recordFeature。`grace<=0`/非流式完全 bypass(=禁用)。golden(C3a)锁正常流逐帧等价 + 富错误帧保 type/retry_after。非流式路径零改动。config-hot-reload 矩阵 + DESIGN 同步(§8)。 |
| **(可选)C0: ⓪ http2-client 保留 abort reason** | 若评审采纳(§1.4):http2-client abort 路径 `reject(signal.reason ?? abortError())`,使 history `attempt.error` 保留 TimeoutError 文案。独立无害(其它消费端仍只看 `isAbortError`,name 从 "AbortError" 变 "TimeoutError" 不影响分类)。可作 C1 前置或独立 commit;504/499 判别**不依赖**它。 |
| **C4: ④ reaper 装牙齿(StreamReaperCancelError 第三 provenance)** | **依赖 C1/C2(已落地),独立于 C3b、不卡 Q2,可立即落。** 不变量:reaper force-fail 时**真正 abort 在飞上游 h2 fetch** + 中止 handler 协程(`RequestContext` 持生命周期 AbortController,reaper 调它而非仅 `ctx.fail()`);仍连着的客户端收**合成 error 帧**(非静默断流)、记 `failed`(非误记 `aborted`);`guardSseIterable` 加**第三 provenance** `reaperSignal`→`StreamReaperCancelError`→`classifyStreamError` 新 kind `reaper-cancel`→`stream-error`;**全 6 个** settled-abort 站点覆盖(anthropic / chat-completions / responses-HTTP / **responses-WS([ws.ts:332](../../src/routes/responses/ws.ts#L332) 独立 `sendErrorAndClose`+1011)** / gemini);`settled` guard 兜 reaper-自-fail 与 guard-path 的双 settle 幂等。**provenance-before-signal ordering 不变量(round-C HIGH)**:第三 provenance + classifyStreamError 新 kind + 6 站点映射必须**先于**把 reaper signal 接进 guard/transport 落地——否则中间 commit 出现"reaper-cancel 误判 client-abort→静默断流+错记 aborted"(缺陷④反向重演)。建议拆 C4a(RequestContext AbortController + stream.ts 第三 provenance + 6 站点映射,**此时尚未把 signal 接 guard**,纯加通路)→ C4b(reaper 调 abort + send.ts 折 reaper signal 进 fetch,此时 provenance 已就位)。系统不半坏:C4 前是装饰性 force-fail(泄漏到 1200s `response_header` 封顶);C4 后真回收。**pre-response reaper(已知可接受)**:reaper 在 streamSSE 前触发时 fetch reject 经 ① 出 504 + reaper-failed 终态(reaper-cancel 在 pre-response 混进 timeout 桶,对客户端无害)。补 repro:reaper 真调 `ctx.abort()`→fetch signal→0 unhandled(round-C MEDIUM:现有 repro 只间接覆盖)。 |

每个 commit 单独可发布、系统不半坏:C1 独立有用(降噪;过渡态 state/status 不一致是已知、非 bug);C2 依赖 C1 的超时出口但不依赖 C3;C3 依赖 C1/C2 的 abort 语义。⓪ 完全独立。

---

## 6. Open Questions(评审需拍板)

1. **Q1 客户端断开的状态码** —— 499(nginx,client closed)vs 408(标准 Request Timeout)vs 干脆不返回 body(连接已断,Hono 需要一个 Response 对象)。倾向 499(语义最准),但需实测 `ContentfulStatusCode` 类型 + Hono 对已断连接写 499 的行为。
2. **Q2 ③ 的 oracle 验证(make-or-break,经 round-A 加强)** —— ③ 把 POST-COMMIT 上游错误从 HTTP 4xx 改为 200+SSE error 帧。**双 oracle 已证不等价**(§4.2.5):Anthropic SDK 对流内 error 走 `.status===undefined` 的裸 `APIError`、绕过类型化子类与自动重试。故必须用**真实 Claude Code / Anthropic SDK** 实测:(a)"200 流首个语义事件即 error 帧"对 429/401/400 的客户端分支行为(是否静默放弃重试);(b)**Claude Code 的真实请求超时类型与阈值**(idle 型每帧重置 vs total 型)——这直接定 §4.2.3 的 grace 默认值,当前 ~258–292s 是单方声称未从源码 pin。延迟-commit(§4.2.2)+ 富错误帧(§4.2.5)已把发散面缩到"长 stall 后才报错"的极少数,但残余须实测裁决。
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

## 8. 验证命令 + doc-sync(实现期)

```bash
bun run typecheck
bun run test:backend        # 含 forwardError 单测(每格式 abort)+ handler it 测 + http transport 回归
# ③ 的 oracle 验证(Q2)需真实客户端,不进自动化套件
```

**C3b 硬验证门 + doc-sync(round-A config M-5)**:
- **config-hot-reload 测试矩阵**:新增 `anthropic.pre_stream_grace` 必须登记 [tests/config/config-hot-reload.it.test.ts](../../tests/config/config-hot-reload.it.test.ts) 表驱动矩阵(或豁免清单),否则完整性守卫直接 fail —— 这是 C3b 能否进 commit 的硬门。
- **DESIGN.md 同步**(completion-includes-doc-sync):① 运行时选项表新增 `preStreamGraceSec` 行;② Hot-reload 语义表登记(grace 参与热重载、不进"需重启"清单);③ 活的架构现状表"流式写出"行补注 pre-response grace-commit 分支。
