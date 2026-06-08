# Streaming Path 三问题修复 Plan

## 背景

上一轮分析 streaming path 后发现 3 个非阻塞问题。本 plan 给出完整修复方案。
核心约束:**不破坏既有测试契约**(尤其 OpenAI 形态 shutdown→`server_error` 是被测试明确固定的有意行为)。

实质逻辑改动仅在 [src/lib/stream.ts](../../src/lib/stream.ts) 与 [src/lib/anthropic/stream.ts](../../src/lib/anthropic/stream.ts);其余多为注释 + handler 错误映射显式化。

---

## 问题1:StreamShutdownError 可重试语义不一致 / doc 过度承诺

### 根因
[stream.ts](../../src/lib/stream.ts) `StreamShutdownError` 的 doc 写「Each handler's existing catch block
translates this into a **retryable** error for the client」。但实测各 handler 映射不同:
- Anthropic → `overloaded_error`(messages/handler.ts:517)
- Gemini → `UNAVAILABLE`/503(gemini/handler.ts:354)
- chat-completions / responses / fallback → 落入 `server_error`(内联三元只区分 idle-timeout)
- responses-ws → `server_error`(sendErrorAndClose 默认)

经查 **OpenAI 形态 shutdown→`server_error` 是既定测试契约且有意为之**:
- tests/responses/responses-ws.http.test.ts:419-422 注释「retryable server_error frame」并 `expect(...).toBe("server_error")`
- tests/shutdown/shutdown-mid-stream.http.test.ts:230,290 `expect(text).toContain("server_error")`

→ 不应改 OpenAI 的 error type(server_error 即 OpenAI 5xx 暂时性语义)。根因是 **doc 过度承诺 + 各 handler 散布裸 instanceof 链**。

### 方案
1. **新增协议无关分类原语**(放 stream.ts,与两个 stream 错误类同文件,内聚):
   ```ts
   export type StreamErrorKind = "idle-timeout" | "shutdown" | "other"
   export function classifyStreamError(error: unknown): StreamErrorKind {
     if (error instanceof StreamIdleTimeoutError) return "idle-timeout"
     if (error instanceof StreamShutdownError) return "shutdown"
     return "other"
   }
   ```
2. **三个 OpenAI handler** 用 classify 做显式三分支映射,shutdown 显式归 `server_error`(行为不变,但意图可见、消除内联三元):
   - chat-completions/handler.ts:617
   - responses/handler.ts:337
   - responses/fallback.ts:265
   映射:`idle-timeout`→`timeout_error`,`shutdown`→`server_error`,`other`→`server_error`。
3. **anthropic / gemini 现有 helper**:经 review 收缩范围,**维持现状不动**(`anthropicStreamErrorType`、`geminiStreamErrorStatus` 已是清晰具名函数,改用 classify 无可读性收益、gemini 还要动签名)。`classifyStreamError` 当前仅 OpenAI 三处经 `streamErrorToOpenAIErrorType` 共享。
4. **修正 doc**:把 StreamShutdownError 注释从笼统「retryable」改为准确描述——各 handler 将其映射到本协议的暂时性错误形态(Anthropic `overloaded_error`、Gemini `UNAVAILABLE`、OpenAI `server_error`),客户端据此退避重试。

### 不做
- 不改任何对外 error type/status(测试契约)。
- responses-ws 已是 server_error,逻辑不变;仅其 catch 若复用 classify 可选,保持最小改动可不动。

---

## 问题2:重构后过时的 "per-iteration" 注释

### 根因
重构已把「per-iteration thunk 重算 abort signal」改为「stable signal + 单个 local AbortController + 显式 listener 清理」。以下注释仍描述旧机制:
- src/lib/anthropic/client.ts:108 「per-iteration guard in processAnthropicStream」
- src/lib/openai/chat-completions-client.ts:56 「the per-iteration ...」
- src/lib/openai/responses-client.ts:296 「the per-iteration ...」
- tests/shutdown/shutdown-mid-stream.http.test.ts:5,64,224
- tests/shutdown/shutdown-anthropic.http.test.ts:15,59

### 方案
逐处改为准确描述(stable-signal local-controller guard owns shutdown for the streamed body)。
**保留** stream.ts:154「no per-iteration recomputation is needed」——它是新设计的正确表述。

---

## 问题3:throw/abort 终止路径未关闭上游 iterator

### 根因
`for await` 在 `.next()` 返回 `{done:true}` 或抛错时**不调用** iterator 的 `.return()`。
故以下路径上游 iterator 未释放:
- idle-timeout throw(StreamIdleTimeoutError)
- shutdown throw(StreamShutdownError)
- client clean-done(返回 `{done:true}`)

shutdown 场景进程将退出,影响小;但 **idle-timeout 场景非 shutdown**,上游 SSE/fetch 连接悬挂到上游超时/TCP keepalive 回收。预存行为,本次一并修复。

### 方案(实现已修订为 fire-and-forget)
**guardSseIterable**:新增幂等 `closeInner()`(`inner.return?.()`,try/catch 吞错,只跑一次);保留 `detach()`(移 listener)。
- `catch`(idle-timeout / 其它 reject):detach + **`void closeInner()`**(fire-and-forget),再 rethrow
- `STREAM_ABORTED`(shutdown throw / client done):detach + **`void closeInner()`**(fire-and-forget)
- `result.done`(自然完成):**只 detach**(inner 已自行 done,不再 close)
- `return()`(消费者 break,无 in-flight next):detach + **`await closeInner(value)`**(保留 return 值转发)

**processAnthropicStream**(async generator):所有退出路径都过 `finally`。在 finally(移 listener)中追加 **fire-and-forget** `void Promise.resolve().then(() => iterator.return?.()).catch(()=>{})`。

### 测试
- 扩展 tests/streaming/stream-guard.unit.test.ts:各路径 inner.return 调用次数 + natural-done 不调用 + **return() 永不 resolve 仍不挂起**。
- 扩展 tests/streaming/stream-shutdown-race.it.test.ts:processAnthropicStream shutdown 终止时关闭上游 + return() 永不 resolve 不挂起。

### 权衡 / 风险(关键修订)
- **不能 `await inner.return()`**:对停在 `await` 中的 async generator 调 `return()` 会排队等待那个 pending 的 `next()`(永不 settle)→ **挂起**。故 next()/finally 路径一律 fire-and-forget,仅消费者 break 的 `return()`(无 in-flight next)才 await。
- **best-effort 局限**:对真正 stalled 的上游(idle-timeout),排队的 `return()` 要等上游 settle / Phase 4 才执行——非即时释放。但优于修复前(非自然路径此前完全不调 return),且避免了挂起这一更严重 bug。代码注释如实说明。
- `closeInner` 幂等(innerClosed 同步置位)避免 double-close;内部 try/catch 使其 promise 永不 reject,`void closeInner()` 无 unhandled rejection。

---

## 验证
1. typecheck:`~/.bun/bin/bun node_modules/typescript/bin/tsc --noEmit`(绕过 Volta 无 Node)
2. 测试:`~/.bun/bin/bun test tests/streaming tests/shutdown tests/anthropic tests/openai tests/responses tests/gemini`
3. lint:`eslint --fix` 改动文件

## 受影响文件清单
- src/lib/stream.ts(classifyStreamError + closeInner + doc)
- src/lib/anthropic/stream.ts(finally 关 iterator)
- src/routes/chat-completions/handler.ts(classify 映射)
- src/routes/responses/handler.ts(classify 映射)
- src/routes/responses/fallback.ts(classify 映射)
- src/routes/messages/handler.ts(anthropicStreamErrorType 用 classify)
- src/routes/gemini/handler.ts(用 classify)
- src/lib/anthropic/client.ts(注释)
- src/lib/openai/chat-completions-client.ts(注释)
- src/lib/openai/responses-client.ts(注释)
- tests/shutdown/shutdown-mid-stream.http.test.ts(注释)
- tests/shutdown/shutdown-anthropic.http.test.ts(注释)
- tests/streaming/stream-guard.unit.test.ts(新增 inner.return 断言)
