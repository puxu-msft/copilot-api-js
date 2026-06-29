> **✅ 已落地并归档** — 见同目录 [README.md](README.md)。本 RFC 顶部原状态行陈旧（写草案/待实现），其机制已完整实现于 `src/`，活的现状以 docs/DESIGN.md「活的架构现状」为准。

# RFC: stale reaper 取消在飞请求（缺陷④ — reaper teeth）

**Status:** 设计稿待实现 — 设计已收敛（基于 pre-response-abort RFC 第二起 incident + 两轮对抗 subagent 复审）。Phase 1（pre-response 半，小而完整、无 P1）可立即实现；Phase 2（mid-stream 半，需新 provenance + 5 格式 handler 改动）依赖 Phase 1。
**Date:** 2026-06-22
**Owner:** 排查会话（待实现会话接手）
**关联:** [pre-response-abort-handling.md](../../spec/pre-response-abort-handling.md) 缺陷④（本文是其展开）；缺陷⑤（孤儿 fetch abort 崩服务器）已修（commit `c824df4`），与本文正交。

---

## 1. Context — 触发本文的事件

第二起生产 incident（2026-06-22）：

```
[WARN] 16:11:59 [context] Force-failing stale request req_1782143808581_141 (endpoint: anthropic-messages, model: claude-opus-4-8, stream: true, state: executing, age: 911s, max: 900s)
[FAIL] 16:11:59 POST /v1/messages claude-opus-4.8 911.3s ↑628.3KB ↓5.1KB: Request exceeded maximum age of 900s (stale context reaper)
```

`state: executing` + `↓5.1KB` = L2 buffered retry（`protect_streaming_generation: tool_use_only`）第一次尝试转发了 5.1KB 后截断、第二次尝试在 pre-response（等响应头）卡住，被 stale reaper 在 911s force-fail。

### 1.1 根因（已核验，非推断）

reaper 的 `runReaperOnce`（[manager.ts:185-203](../../src/lib/context/manager.ts#L185)）在 `ctx.durationMs > maxAgeMs` 时**只调 `ctx.fail(...)`**（[manager.ts:200](../../src/lib/context/manager.ts#L200)）。而 `RequestContext.fail()`（[request.ts:428](../../src/lib/context/request.ts#L428)）只做三件事：设终态字段、`transition("failed")` 推 history/bus、`onSettled?(id)` 把 ctx 移出 active map。**它没有任何取消能力**——`RequestContext` 根本不持有 AbortController，不碰在飞的上游 HTTP/2 fetch，不中止 handler 协程。

后果（按 architecture-health-first「问题是否真实存在」分流，两者都命中"必须修"）：

1. **资源泄漏（有界但真实）** — force-fail 后，上游 h2 stream + handler 协程 + 其对象图（driver/codec/betaProbe/628KB 请求体）+ 共享 h2 session 上的 flow-control 窗口**继续存活到 `response_header` 超时**（本配置 1200s）才真了结。比声明死亡晚 ~300s × 并发量。reaper 的 `maxAge`（900s）本意是"超过此龄即放弃"，但实际只是改了 history 记录、没放弃任何资源。
2. **可观测撒谎（更严重）** — `[FAIL] ... 911.3s ... Request exceeded maximum age` 这行**宣称请求在 911s 结束了，但请求还在跑**。运维看到 FAIL 会以为资源已释放、客户端已收到终态——都不成立。这正是本项目反复打击的可观测诚实破口（参 [[methodology-stream-eof-not-completeness]]、[[methodology-record-disappearance-forensics-and-silent-destructive-ops]]：终态行不能撒谎）。

### 1.2 为什么"大修"不是合格的暂缓理由

`architecture-health-first` 明文把**资源泄漏**和**可观测盲点**列为"必须修，不归类为等触发再说"，且"成本不是决策因素"。故"修法较大"对 ④ 不构成暂缓理由。**真正的拆分依据**是：④ 的修复天然分裂成严重性与复杂度截然不同的两半（§3 / §4），而非"做不做"。

---

## 2. 关键洞察：stream guard 何时激活，决定修复难度

reaper 砍一个请求时，该请求处于两种状态之一，**修复路径完全不同**：

| 请求状态 | 含义 | guard 是否在跑 | 修复难度 |
|---|---|---|---|
| `executing`（pre-response） | 还在 `driver.runRequest` 等上游响应头（**911s incident 的实际形态**） | **否**——`guardSseIterable` 尚未迭代第一帧 | **小**（Phase 1） |
| `streaming`（mid-stream） | 已收到响应头、正在流式转发 | 是——guard 在 `for await` 迭代中 | **大**（Phase 2） |

这个区分是整个设计的枢纽：**subagent 复审抓到的 P1 CRITICAL（把 cancel 折进 guard `clientSignal` 会误判成客户端断开 → 静默断流 + 错记终态）只在 mid-stream 成立**——因为 P1 的误判发生在 guard 内，而 pre-response 时 guard 没在跑。故 pre-response 半可以用最朴素的"折进 fetch 信号"实现而**不触发 P1**。

---

## 3. Phase 1 — pre-response reaper teeth（小而完整，无 P1）

### 3.1 设计

给 `RequestContext` 加一个生命周期 `AbortController`，把它的 signal **只折进上游 fetch 信号**（不碰 guard 的 `clientSignal`），reaper force-fail 时 abort 它。

**改动锚点（3 处 + 测试）：**

1. **`RequestContext` 加 cancel 能力**（[request.ts](../../src/lib/context/request.ts) `createRequestContext` + [types.ts:231](../../src/lib/context/types.ts#L231) 接口）：
   - 内部 `const lifecycleAbort = new AbortController()`。
   - 暴露 `readonly cancelSignal: AbortSignal`（= `lifecycleAbort.signal`）。
   - 暴露 `cancel(): void`：`if (!lifecycleAbort.signal.aborted) lifecycleAbort.abort()`（幂等）。
   - **per-ctx、非 module-global** → 无需登记 `RESETTERS`（L1 守卫 `resetters-complete.unit.test.ts` 不涉及）。

2. **transport 把 `env.ctx.cancelSignal` 折进上游 fetch**（[http-transport.ts:66-106](../../src/lib/transport/http-transport.ts#L66) 的 `send` + [responses-transport.ts:71](../../src/lib/transport/responses-transport.ts#L71) 的 `send`，两者都已收 `env: RequestEnvelope`）：
   - 把传给 `sendUpstreamHttp` 的 `clientAbortSignal` 从 `deps.clientAbortSignal` 改为 `combineAbortSignals(deps.clientAbortSignal, env.ctx.cancelSignal)`（[stream.ts:89](../../src/lib/stream.ts#L89)）。
   - **关键：不碰 `guardSseIterable` 的 `clientSignal`**（[http-transport.ts:102](../../src/lib/transport/http-transport.ts#L102) / [responses-transport.ts:137](../../src/lib/transport/responses-transport.ts#L137) 维持 `clientSignal: deps.clientAbortSignal`）。pre-response 阶段 guard 还没跑，cancel 经 fetch 信号即可中止 `sendUpstreamHttp`；mid-stream 的 cancel 处理留 Phase 2。
   - 这一改对**正常运行零影响**：`cancelSignal` 永不触发 → `combineAbortSignals` 多折一个不触发的信号（[逐字节等价考量](#36-逐字节等价与-abortsignalany-考量)）。

3. **reaper fail-then-cancel**（[manager.ts:200](../../src/lib/context/manager.ts#L200)）：在 `ctx.fail(...)` 之后加 `ctx.cancel()`。
   - **次序硬约束**：先 `fail`（同步设 `settled=true`，[request.ts:401/430](../../src/lib/context/request.ts#L430) 无 await 间隙 → 同步坐实 `failed` 终态）→ 再 `cancel`（abort fetch）。这保证 handler 后续因 abort 而走的任何 settle（`ctx.fail`/`ctx.abort`）都被 `settled` guard 兜成 no-op，终态确定为 `failed`、无竞态。

### 3.2 pre-response cancel 的传播路径（已核验）

reaper `ctx.cancel()` → `cancelSignal` abort → `combineAbortSignals` 合并信号 abort → `sendUpstreamHttp` 的 `fetchSignal` abort → `http2Fetch` 的 `onPreResponseAbort`（[http2-client.ts:148](../../src/lib/transport/http2-client.ts#L148)）`req.close(NGHTTP2_CANCEL) + reject(AbortError)` → 这个 reject 被 handler 的 awaited 链（`await driver.runRequest`，[handler-v4.ts:323](../../src/routes/messages/handler-v4.ts#L323)）接住 → 进 catch（[handler-v4.ts:332](../../src/routes/messages/handler-v4.ts#L332)）。

catch 里的判别：`error instanceof Error && isAbortError(error) && clientAbort.signal.aborted`（[handler-v4.ts:349](../../src/routes/messages/handler-v4.ts#L349)）。**reaper 用的是 `ctx.cancelSignal`、不是 handler 的 `clientAbort`**，故 `clientAbort.signal.aborted` 为 false → 不走 499/aborted 分支 → 落 `ctx.fail`（已被 reaper 的 fail 设 settled → no-op）→ rethrow → `forwardError` 出 504（response-header 超时分支，[forward.ts:457](../../src/lib/error/forward.ts#L457)）。

**终态语义正确**：reaper 砍的是"上游太慢"，记 `failed` + 对（已 settled 的）客户端出 504 是对的。**且崩溃安全**：即使这个 fetch promise 在 cancel 触发时碰巧已被遗弃（无 awaiter），缺陷⑤ 的 `withRejectionObserver`（commit `c824df4`）已兜住它不崩服务器。

### 3.3 Phase 1 不解决什么（诚实标注）

- **mid-stream（`state: streaming`）的 reaper 砍**：cancel 经 fetch 信号传到 `http2Fetch` 的 **post-response** abort 监听器（[http2-client.ts:213](../../src/lib/transport/http2-client.ts#L213) `req.close(NGHTTP2_CANCEL)`）会关上游流，但 guard 的 `clientSignal` 没收到信号 → guard 不会优雅 throw、而是因底层 stream 关闭抛一个 `"other"` 类错误 → 被 handler 当 `stream-error` / truncation 处理（合成 error 帧给客户端）。**这恰好不会撒谎**（客户端收到 error 帧、记 failed），但 error 帧的语义是"上游截断"而非"超龄取消"——不精确。精确化留 Phase 2。**Phase 1 已消除主要泄漏**（fetch 被取消、流被关），只是 mid-stream 的客户端错误帧语义待 Phase 2 提纯。
- **非 HTTP 路径**：embeddings/count_tokens（无 ctx 或 catch-all 吞错，不泄漏）、web_search 双跳（legacy 路径，`executeRequestPipeline`，不经此 transport——见 §5）。

### 3.4 测试（Phase 1）

- `tests/context/`（新 `.it`，用 `useIsolatedRuntime`）：构造一个 ctx，`ctx.cancel()` 后断言 `ctx.cancelSignal.aborted === true`；二次 `cancel()` 幂等不抛。
- `tests/transport/http-transport.it.test.ts`（扩既有）：注入 mock fetch，`env.ctx.cancel()` 后断言传给 `sendUpstreamHttp` 的 signal 已 abort（fetch 收到 abort）。
- `tests/context/`（reaper `.it`）：mock 一个 `durationMs > maxAge` 的活跃 ctx，跑 `runReaperOnce`，断言 `ctx.cancelSignal.aborted === true` **且** `ctx.state === "failed"`（fail-then-cancel 次序，终态确定）。
- **回归**：`streaming-l2-baseline.http.test.ts` + `pre-response-abort.http.test.ts` 全绿（多折一个不触发信号，逐字节/状态码不变）。

### 3.5 Commit invariants（Phase 1）

| commit | 终态不变量 |
|---|---|
| **P1a: RequestContext cancel 能力** | 加 `cancelSignal`/`cancel()`，无消费者（死代码但无害）。typecheck/test 绿。系统行为零变化。 |
| **P1b: transport 折入 + reaper fail-then-cancel** | 两 transport 的 `send` 把 `env.ctx.cancelSignal` 折进 fetch 信号（不碰 guard clientSignal）；reaper `ctx.fail()` 后 `ctx.cancel()`。pre-response 超龄请求的上游 fetch 现在被真正取消（不再滞留到 1200s）。`streaming-l2-baseline` 逐字节绿（cancelSignal 永不在正常路径触发）。 |

### 3.6 逐字节等价与 AbortSignal.any 考量

`combineAbortSignals`（[stream.ts:89-94](../../src/lib/stream.ts#L89)）对单信号返回原信号、对 2+ 用 `AbortSignal.any`。Phase 1 让 fetch 信号从"可能单个"变成"总是 ≥2 个的 `AbortSignal.any` 复合"。subagent 复审（pre-response-abort 那篇的对应 reviewer）就此提了 P7（[stream.ts:82-87](../../src/lib/stream.ts#L82) 的 WeakRef 注释警告长寿命消费者慎用 `.any`）。**裁决**：fetch 信号是 per-request、请求结束即不可达，属注释明确豁免的"短命 per-request 用途"，**非**它警告的"跨多 tick 的长寿命 stream generator"。`AbortSignal.any` 对短命请求安全（[[reference-bun-fetch-tcp-keepalive]] 同款用法已在 send.ts 用了）。逐字节等价的真 invariant 是"对在意的消费者无可观测行为变化"（[[feedback-byte-equivalence-is-proxy-calibrate-by-consumer]]）——cancelSignal 永不在正常路径触发，故上游 wire 与客户端 forwarded 都逐字节不变；`streaming-l2-baseline` 是回归门。

---

## 4. Phase 2 — mid-stream reaper teeth（需新 provenance，依赖 Phase 1）

### 4.1 问题：为什么不能照搬 Phase 1

mid-stream 时 guard 在 `for await` 迭代。若把 `cancelSignal` 折进 guard 的 `clientSignal`（[http-transport.ts:102](../../src/lib/transport/http-transport.ts#L102)），则 guard 的 abort 判别（[stream.ts:290-291](../../src/lib/stream.ts#L290)）**只有 shutdown / client 两个桶**：

```
if (shutdownSignal?.aborted) throw new StreamShutdownError()
if (clientSignal?.aborted) throw new StreamClientAbortError()   // ← reaper-cancel 会落这里
return { value: undefined, done: true }
```

reaper-cancel 折进 `clientSignal` → guard throw `StreamClientAbortError` → `classifyStreamError === "client-abort"`（[stream.ts:66](../../src/lib/stream.ts#L66)）→ `runResponseSink` 返回 `{kind:"settled-abort"}`（[driver.ts:472](../../src/lib/pipeline/driver.ts#L472)）→ 5 格式 handler 的 settled-abort 站点（messages:701 / cc:347 / responses:294 / ws:332 / gemini:274）调 `ctx.abort(...)`。

**双重错误**（subagent P1 CRITICAL）：
1. **客户端静默断流**：`settled-abort` 是"客户端已走、写零字节"的语义；但 reaper 砍时**客户端还连着**，它应收到一个合成 error 帧（"请求超龄被取消"），而非流突然死掉、无任何终止符（正是 [[methodology-stream-eof-not-completeness]] 打击的"客户端报 Stream ended without receiving any events"）。
2. **终态记错倾向**：`ctx.abort()` 记 `aborted`（"client disconnected"）。虽然 Phase 1 的 reaper fail-then-cancel 已先 `ctx.fail()` 设 settled、使下游 `ctx.abort()` 成 no-op（终态实际仍 `failed`）——但这是"靠 settled guard 兜住一个语义错误的第二次 settle"，是 [[feedback-mine-the-pass-with-warn]] 说的"no-op 是冰山尖"：依赖巧合而非设计。

### 4.2 正确设计：第三 provenance `StreamReaperCancelError`

引入独立的 reaper-cancel 错误类型，让 guard 能与 client-abort / shutdown 区分，映射到 `stream-error`（→ handler 给仍连着的客户端发协议专属 error 帧、记 `failed`）。

**改动锚点：**

1. **`stream.ts` 加错误类 + kind**：
   - `export class StreamReaperCancelError extends Error`（name `"StreamReaperCancelError"`），镜像 [StreamClientAbortError](../../src/lib/stream.ts#L46)。
   - `StreamErrorKind` 联合（[stream.ts:54](../../src/lib/stream.ts#L54)）加 `"reaper-cancel"`。
   - `classifyStreamError`（[stream.ts:63](../../src/lib/stream.ts#L63)）加 `if (error instanceof StreamReaperCancelError) return "reaper-cancel"`。

2. **`guardSseIterable` 收第三信号**（[stream.ts:220-292](../../src/lib/stream.ts#L220)）：opts 加 `reaperCancelSignal?: AbortSignal`，注册到 local controller（[stream.ts:235-238](../../src/lib/stream.ts#L235)），在 abort 判别（[stream.ts:290](../../src/lib/stream.ts#L290)）按优先级插入：
   ```
   if (shutdownSignal?.aborted) throw new StreamShutdownError()
   if (reaperCancelSignal?.aborted) throw new StreamReaperCancelError()   // ← 新，client 之前还是之后？见下
   if (clientSignal?.aborted) throw new StreamClientAbortError()
   ```
   **优先级裁决**：reaper-cancel 与 client-abort 并发（客户端恰在超龄瞬间断开）时，**client-abort 优先**更忠实（客户端确实走了 → 写零字节最省）。故 `reaperCancelSignal` 判别应放在 `clientSignal` **之后**。但 shutdown 仍最先（进程级、retryable）。最终序：shutdown > client > reaper-cancel。（实现期在测试里固定此优先级。）

3. **两 transport 把 `env.ctx.cancelSignal` 作 `reaperCancelSignal` 传给 guard**（[http-transport.ts:99-103](../../src/lib/transport/http-transport.ts#L99) / [responses-transport.ts:134-138](../../src/lib/transport/responses-transport.ts#L134)）：与 Phase 1 折进 fetch 信号**并存**（fetch 信号管 pre-response 取消、guard 信号管 mid-stream 取消，同一个 `cancelSignal` 两处接入，各司其职）。

4. **driver 映射 `reaper-cancel` → `stream-error`**（[driver.ts:468-475](../../src/lib/pipeline/driver.ts#L468) `runResponseSink` 的 catch + [driver.ts:544/573](../../src/lib/pipeline/driver.ts#L544) `runResponseBufferedSink`）：`classifyStreamError(error) === "client-abort"` 的分支保持（仍 `settled-abort`）；`reaper-cancel` 落 `{kind:"stream-error", error}`（默认分支已是 stream-error，故只需**不**把 reaper-cancel 误并进 client-abort 分支——天然就对，但要加测试锁住）。

5. **5 格式 handler 的 stream-error 站点**：已存在（H3 路径），handler 在 `outcome.kind === "stream-error"` 时合成协议专属 error 帧 + `ctx.fail`。reaper-cancel 复用此路径**无需新增 handler 分支**——只要 driver 把它映射成 `stream-error`，5 格式自动各发自己的 error 帧。**这是关键简化**：Phase 2 的 handler 侧改动量≈0，全部集中在 stream.ts + driver 映射 + transport 接线。
   - error 帧文案：reaper-cancel 该映射成一个语义清晰的 message（如 `"request exceeded maximum age of {N}s"`）。各格式的 stream-error→error-frame 合成器（Anthropic `anthropicStreamErrorType` / OpenAI `streamErrorToOpenAIErrorType` / Gemini）目前按 StreamErrorKind 映射——需确认 `reaper-cancel` 有合理落点（多半映射成 `overloaded_error`/`internal` 类，实现期定，**不**要新拍平成误导类型，呼应 pre-response-abort RFC §4.2.5 的"保 error.type"教训）。

### 4.3 Phase 2 测试

- `tests/streaming/`（`.http`，每格式）：mid-stream 时触发 `ctx.cancel()`，断言客户端收到**合成 error 帧**（非静默断流）+ history `state === "failed"`（非 `aborted`）。**5 格式都要**（[[methodology-stream-eof-not-completeness]] 的教训：一格式多平行传输 handler 须枚举全部，Responses HTTP + WS 是两条）。
- `tests/streaming/`：reaper-cancel 与 client-abort 并发 → client-abort 优先（记 aborted/settled-abort）。
- `tests/streaming/`：reaper-cancel 与 shutdown 并发 → shutdown 优先。
- **回归**：`streaming-l2-baseline` + 所有现有 streaming-abort 测全绿。

### 4.4 Commit invariants（Phase 2）

| commit | 终态不变量 |
|---|---|
| **P2a: StreamReaperCancelError + kind + classify** | 新错误类 + `StreamErrorKind` 加 `"reaper-cancel"` + `classifyStreamError` 识别。无生产消费者（guard 还没传信号）。typecheck/现有 stream 测绿。 |
| **P2b: guard 收 reaperCancelSignal + 优先级** | `guardSseIterable` opts 加 `reaperCancelSignal`，按 shutdown>client>reaper-cancel 优先级 throw。无生产传入（transport 还没接）→ 行为不变。单测锁优先级。 |
| **P2c: transport 接 reaperCancelSignal + driver 映射 + handler error 帧** | 两 transport 把 `env.ctx.cancelSignal` 作 `reaperCancelSignal` 传 guard；driver 把 `reaper-cancel` 映射 `stream-error`；5 格式经既有 stream-error 路径发 error 帧、记 failed。mid-stream 超龄请求现在给仍连着的客户端发 error 帧（非静默断流）。全格式 streaming-abort 回归绿。 |

---

## 5. 不做什么（YAGNI 边界）

- **web_search 双跳**（[orchestrator.ts](../../src/lib/anthropic/web-search/orchestrator.ts) / `web-search-direct.ts`）走 legacy `executeRequestPipeline`、**不经本文的 v4 transport**（[[project-v4-pipeline-rearchitecture]] 的 `[bypass]` 路径）。它有自己的 `clientAbortSignal` 折叠（[backends.ts:316](../../src/lib/anthropic/web-search/backends.ts#L316)）但无 ctx 生命周期 cancel。**不在本文范围**——若 web_search 迁 driver（pre-response-abort RFC D1 暂缓项）时一并收敛。本文 §3/§4 只覆盖 4 个 v4 格式。
- **非流式（`stream:false`）pre-response 取消**：已被 Phase 1 覆盖（非流式也走同一 transport `send` 的 fetch 信号折入；catch 在 handler 外层共用）。无需额外工作。
- **不新增 reaper 配置**：`staleRequestMaxAge`（[state.ts](../../src/lib/state.ts)）已足够；cancel 是 fail 的副作用，不引入新开关（YAGNI）。
- **不改 `http2-client` 的 abort 合成**：缺陷⑤ 已加 `withRejectionObserver`；abort 路径功能正确。

---

## 6. Open Questions

1. **Q1 Phase 2 error 帧的 StreamErrorKind 落点** — `reaper-cancel` 在各格式 stream-error→error-type 合成器里映射成什么 `error.type`？需读 `anthropicStreamErrorType`（[streaming-pump.ts](../../src/routes/messages/streaming-pump.ts)）/ `streamErrorToOpenAIErrorType`（[openai/stream-error.ts](../../src/lib/openai/stream-error.ts)）/ Gemini 映射，选一个不撒谎的类型（倾向 `overloaded_error`/`internal`/`UNAVAILABLE` 这类"服务端放弃"语义，**非** `api_error` 拍平）。实现期定。
2. **Q2 是否值得让 Phase 1 单独发布** — Phase 1 已消除主要泄漏（fetch 取消 + 流关闭），mid-stream 的"客户端收 error 帧 vs 当前的截断式错误"是语义提纯。Phase 1 独立可发、系统不半坏。倾向 Phase 1 先合、观察生产 reaper 日志是否还有 mid-stream 形态（`state: streaming` 的 force-fail），再决 Phase 2 优先级。**但 Phase 2 是 architecture-health-first 要求的完整修复，非可选**——只是排序在 Phase 1 之后。

---

## 7. 验证命令

```bash
bun run typecheck
bun run test:backend        # 含新 context/transport/streaming 测 + 全格式 streaming-abort 回归
bun run lint:all
```

需验证 live reaper 行为（真实超龄取消）时让用户手动启动服务器（`no-auto-server-no-kill`）。

## 8. doc-sync（实现完成时）

- [DESIGN.md](../../DESIGN.md) `staleRequestMaxAge` 行：去掉"不取消在飞 fetch（缺陷④ 待修）"的暂缓注记，改为"reaper force-fail 取消在飞上游 fetch（Phase 1）+ mid-stream 发 error 帧（Phase 2）"。
- [DESIGN.md](../../DESIGN.md)「活的架构现状」表：若 Phase 2 落地，stream guard 行补 reaper-cancel provenance。
- [pre-response-abort-handling.md](../../spec/pre-response-abort-handling.md) 缺陷④：标注已实现 + 指向本文。
- 更新记忆 [[project-pre-response-abort-rfc]] 的 ④ 状态。
