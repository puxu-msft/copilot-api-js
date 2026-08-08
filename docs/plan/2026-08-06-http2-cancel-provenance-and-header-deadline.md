# HTTP/2 CANCEL 来源归因与 Header Deadline 实施计划

> **实施状态：部分完成**（核验于 2026-08-08，`master` = `bea1dfa3d61896bf2089958676bd1236269877d9`）
>
> - **阶段 1（response-header deadline 作用域）：已完成并合入 `master`。** 落地提交 `0f9023b2`、`b1a0f6e6`、`88bb1039`、`7cf1e896`（+ lint/baseline 校准 `bae83f01`、`a0ad0f1a`、`da584116`，主线合并 `0732fc76`、`b0d9dbf0`、`bea1dfa3`，评审整改 `03a84bcb`）。合并态全门：typecheck、`lint:all`、`test:backend` `7279 executed / 30 skipped / 0 fail`；独立 code reviewer 与 verifier 均 PASS。
> - **阶段 2（termination provenance 生产与策略接线）：未实施。** 无 `TransportTerminationEvidence`／`TransportTerminationObservation` 生产代码或测试（`rg 'TransportTerminationEvidence|TransportTerminationObservation' src tests packages` 零命中，核验于同一 `master`）。
> - **阶段 3（canonical History 与诊断消费）：未实施。** `ModelOperationDispatch.termination` 字段与 `attempts[].transportTermination` 投影均不存在。
>
> 阶段状态的权威来源是 [spec 的「实施状态」节](../spec/2026-08-06-http2-cancel-provenance-and-header-deadline.md)；本注解是它的派生视图，冲突时以 spec 为准。接手请先读 [2026-08-08-header-deadline-stage2-3/HANDOVER.md](2026-08-08-header-deadline-stage2-3/HANDOVER.md)。

> **执行者必读：** 推荐用 `superpowers:subagent-driven-development`，也可用 `superpowers:executing-plans` 逐任务执行。所有步骤使用 checkbox 跟踪。三个阶段各自验证、评审、提交并立即合并 `master`，不得积成一次最终合并。

**目标：** 让 response-header deadline 在收到 headers 后解除，并让 HTTP/2 local、peer RST、session、ambiguous 与 unknown 具备结构化、可持久化的 observation/evidence。

**架构：** `upstreamFetch` 统一拥有可解除的 header watchdog，普通生命周期 signal 继续覆盖 body。HTTP/2 transport 在 close 产生点追加 termination evidence，并提供可重算的保守 attribution snapshot；local 与 peer/session evidence 并存时标为 ambiguous，而不是用 first-writer 伪造因果顺序。canonical/recovery 在 quiescence 后读取最终 observation，随后持久化并投影给 History、日志与 UI。`TransportTerminationObservation` 记录事实，`TransportErrorReason` 保持 retry 语义，两者不合并。

**技术栈：** TypeScript、Bun、Node `node:http2`、WHATWG `Response`/`ReadableStream`、History V3 canonical manifest、React `ui-v4`。

**权威规格：** `docs/spec/2026-08-06-http2-cancel-provenance-and-header-deadline.md`

## 全局约束

- 不启用、不扩展 `anthropic.protect_streaming_generation`；旧 whole-response L2 未来独立删除。
- 不改变 block-level commit、continuation retry、`partial-degrade`、endpoint 默认值或 server-tool retry 产品策略。
- `REFUSED_STREAM` 继续是 HTTP/2 唯一具 RFC 9113 零处理保证、可在普通 S4 network-retry 中重发的 stream error。
- `TransportTerminationEvidence/Observation` 是事实；`TransportErrorReason` 是策略语义。新增 union member必须触发穷尽检查。
- local intent 在调用 `req.close()` 前追加；后续 stream/session evidence 继续保留。`firstObserved` 不是 wire 因果证明，冲突 attribution 必须是 ambiguous。
- GOAWAY 只 retire session；在途 stream 正常完成时不得记录 session termination。
- 旧 History 不 backfill；缺字段保持可读，不能伪造为 peer。
- peer wire oracle使用公开 `stream.destroy(error)` 忠实产生 INTERNAL_ERROR=2，并让Bun production `http2Fetch`验证接线；CANCEL=8字段保真由collector单测独立覆盖。不得用不忠实的`stream.close(code)`或Node私有ABI冒充peer-CANCEL wire oracle。
- 测试不得访问真实 GHC 或 4141；进程级验证使用非 4141 端口、独立配置和独立 History。
- 每阶段开始前合并当前本地 `master`；每个 load-bearing 测试按 `proving-where-a-command-ran` gate 绑定 worktree。
- 每阶段结束必须输出结构怪味记录：`file:line`、类型、本轮修或 backlog及理由。
- 每阶段独立 review 同时检查 false-green 与 false-red；review 未收口不得合并。
- 本地提交使用 Conventional Commits 和精确 pathspec；不 push。

---

## 文件结构与职责

### 阶段 1

- `src/lib/transport/upstream-fetch.ts`：response-header watchdog 的唯一生命周期所有者；transport 选择仍在此处。
- `src/lib/fetch-utils.ts`：提供 timeout error 构造和仅供 WS 使用的 `createUpstreamFirstEventTimeoutSignal`；不再替 HTTP 创建不可解除 signal。
- `src/lib/transport/send.ts`：普通 lifecycle signals 与 `responseHeaderTimeoutMs` 分开传给 `upstreamFetch`。
- `src/lib/anthropic/client.ts`、`src/routes/messages/count-tokens.ts`、`src/lib/models/client.ts`、`src/lib/openai/embeddings.ts`：迁移 direct HTTP 调用点。
- `tests/transport/upstream-fetch.unit.test.ts`：header watchdog 正反控制。
- `tests/transport/http2-client.it.test.ts`、`tests/transport/http-transport.it.test.ts`：body-stage lifecycle signal 与 reservation 回归。

### 阶段 2

- `packages/foundation/src/error/transport-termination.ts`：`TransportTerminationEvidence/Observation` SSOT、evidence collector、attribution 派生与 error snapshot tag。
- `packages/foundation/src/error/cancellation-reason.ts`：扩充可持久化 local signal cause。
- `packages/foundation/src/stream.ts`、`src/lib/abort-bridge.ts`、`src/lib/shutdown.ts`、`src/lib/transport/dispatch-lifecycle.ts`：让 client/shutdown producer 带结构化 cause，并让 lifecycle owner 原样转发 external reason；显式 dispatch dispose 才生成 `dispatch-cancel`。
- `tsconfig.json`：core compatibility alias 指向 foundation termination SSOT。
- `src/lib/transport/upstream-fetch.ts`：`onTerminationEvidence` callback 类型。
- `src/lib/transport/http2-client.ts`：每 stream evidence collector、active-session evidence 通知、error snapshot tagging。
- `src/lib/transport/http-transport.ts`、`src/lib/transport/responses-transport.ts`、`src/lib/pipeline/types.ts`：向 live response 暴露只读 observation accessor。
- `src/lib/pipeline/driver.ts`：buffered recovery 只接受 attribution=`peer|session`，排除 `local|ambiguous|unknown`，同时保留非 H2 legacy 行为。
- `tests/transport/http2-client.it.test.ts`、`tests/transport/http-transport.it.test.ts`、`tests/transport/responses-transport.it.test.ts`、`tests/pipeline/buffered-sink.unit.test.ts`：方向判别和 recovery 双向控制。

### 阶段 3

- `src/lib/context/model-operation-record.ts`：canonical dispatch 一等 termination 字段。
- `src/lib/context/types.ts`、`src/lib/context/request.ts`：dispatch recorder 接线。
- `src/lib/pipeline/generation/dispatch-scheduler.ts`、`src/lib/pipeline/driver.ts`：settlement 时读取 live termination accessor并写 canonical record。
- `src/lib/history/types.ts`、`src/lib/history/v3/projection.ts`：REST `attempts[].transportTermination` 投影。
- `src/lib/upstream-stream-diagnostics.ts`、`src/lib/upstream-diagnostics.ts`：结构化 disconnect 日志。
- `ui-v4/src/components/detail/segments/MetaSegment.tsx`：显示 final attempt termination。
- `tests/context/model-operation-record.unit.test.ts`、`tests/history/v3/readonly-store.it.test.ts`、`tests/history/v3/recovery-projection.unit.test.ts`、`tests/infra/upstream-diagnostics.unit.test.ts`、`tests/infra/upstream-stream-diagnostics.unit.test.ts`：canonical round-trip、兼容与日志。
- `docs/DESIGN.md`、`docs/API.md`、`docs/spec/upstream-http2-transport.md`：活文档同步。

---

# 阶段 1：Response-header deadline 严格止于 headers

## Task 1：在 `upstreamFetch` 建立可解除 header watchdog

**Files:**
- Modify: `src/lib/transport/upstream-fetch.ts:43-103`
- Modify: `src/lib/fetch-utils.ts:18-27`
- Test: `tests/transport/upstream-fetch.unit.test.ts:39-76`

**Interfaces:**
- Consumes: `resolveResponseHeaderTimeoutMs(model?: string): number`
- Produces: `UpstreamFetchInit.responseHeaderTimeoutMs?: number`
- Produces: `createResponseHeaderTimeoutError(ms: number): DOMException`，`name === "TimeoutError"`
- Produces: `createResponseHeaderDeadline(ms): { signal: AbortSignal; complete(): boolean }`；timeout/headers/reject共用一个幂等 finish，只有首个终局的 `complete()`/timer transition成功
- Invariant: `activeUpstreamFetch` 接收的 `signal` 是 `lifecycle signal ∪ still-armed header signal`；Promise resolve/reject 后 deadline已complete、timer已清除。

- [ ] **Step 1：先写完整 header deadline 测试矩阵，不改 production**

在 `tests/transport/upstream-fetch.unit.test.ts` 添加 injected transport，永不 resolve headers，只观察 signal：

```ts
test("response-header deadline rejects a transport that never resolves headers", async () => {
  setUpstreamFetchForTests((_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    }),
  )
  const pending = upstreamFetch("https://upstream.example/stall", { responseHeaderTimeoutMs: 10 })
  const error = await Promise.race([
    pending.catch((value: unknown) => value),
    new Promise((resolve) => setTimeout(() => resolve(new Error("test guard expired")), 100)),
  ])
  expect(error).toBeInstanceOf(DOMException)
  expect((error as Error).name).toBe("TimeoutError")
})
```

Step 1 同时写：pre-header timeout、headers后long body、post-header lifecycle abort、FakeClock headers-first/timeout-first/external-first和deadline `complete()`幂等返回。H2具名listener、`onStreamClosed`与reservation矩阵属于Task 3，由真实adapter接线验证，不混入本Task提交。以下代码块展示关键case。

- [ ] **Step 2：运行完整矩阵确认红**

Run: `bun test tests/transport/upstream-fetch.unit.test.ts --timeout 10000`

Expected: FAIL；当前`responseHeaderTimeoutMs`/deadline primitive不存在，pre-header case在100ms guard返回错误、幂等/cleanup断言失败；existing unrelated H2 cases仍绿。

- [ ] **Step 3：headers 后长 body 的 false-red 控制代码**

transport 立即 resolve `Response`，body 延迟超过 header deadline 才产生数据，并在收到 signal abort 时 `controller.error(signal.reason)`：

```ts
test("response-header deadline disarms when fetch resolves, so a long body survives", async () => {
  setUpstreamFetchForTests((_url, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const onAbort = () => controller.error(init.signal?.reason)
        init.signal?.addEventListener("abort", onAbort, { once: true })
        setTimeout(() => {
          init.signal?.removeEventListener("abort", onAbort)
          controller.enqueue(new TextEncoder().encode("late-body"))
          controller.close()
        }, 40)
      },
    })
    return Promise.resolve(new Response(body, { status: 200 }))
  })

  const response = await upstreamFetch("https://upstream.example/stream", { responseHeaderTimeoutMs: 10 })
  expect(await response.text()).toBe("late-body")
})
```

这条在旧代码上可能因新参数被忽略而绿，故它不是红门；它的判别力由 Step 1 的pre-header正控证明watchdog接线存在，并由 Step 8 的“删除disarm”mutation证明。

- [ ] **Step 4：实现 header watchdog primitive**

在 `src/lib/fetch-utils.ts` 建立可独立测试的幂等 primitive：

```ts
export function createResponseHeaderTimeoutError(ms: number): DOMException {
  return new DOMException(`Upstream response headers not received within ${ms}ms`, "TimeoutError")
}

export function createResponseHeaderDeadline(ms: number): { signal: AbortSignal; complete(): boolean } {
  const controller = new AbortController()
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (reason?: Error): boolean => {
    if (finished) return false
    finished = true
    if (timer !== undefined) clearTimeout(timer)
    if (reason) controller.abort(reason)
    return true
  }
  timer = setTimeout(() => finish(createResponseHeaderTimeoutError(ms)), ms)
  timer.unref?.()
  return { signal: controller.signal, complete: () => finish() }
}
```

`UpstreamFetchInit` 添加 `responseHeaderTimeoutMs?: number`，`upstreamFetch()` 只把标准init交给transport：

```ts
export function upstreamFetch(url: string | URL, init: UpstreamFetchInit): Promise<Response> {
  const { responseHeaderTimeoutMs = 0, signal, ...transportInit } = init
  if (responseHeaderTimeoutMs <= 0) return activeUpstreamFetch(url, { ...transportInit, signal })

  const deadline = createResponseHeaderDeadline(responseHeaderTimeoutMs)
  const combined = combineAbortSignals(signal, deadline.signal)
  return activeUpstreamFetch(url, { ...transportInit, signal: combined }).finally(() => deadline.complete())
}
```

headers resolve、transport reject、external abort后的Promise settle都调用同一个`complete()`；timeout callback也走同一finish。测试直接断言竞争双方只有一个`complete()/finish`返回true，另一方false。

- [ ] **Step 5：实现后校准一般 lifecycle signal 的 false-red 控制**

测试 transport 先 resolve headers，再由 caller abort。body 必须仍被取消，且收到 caller 自己的 reason，而不是因为 header watchdog 被解除就失去一般 signal：

```ts
test("disarming the header deadline does not disarm the request lifecycle signal", async () => {
  const lifecycle = new AbortController()
  const reason = new DOMException("request_deadline", "AbortError")
  setUpstreamFetchForTests((_url, init) => Promise.resolve(responseWhoseBodyRejectsOn(init.signal)))
  const response = await upstreamFetch("https://upstream.example/stream", {
    signal: lifecycle.signal,
    responseHeaderTimeoutMs: 1000,
  })
  lifecycle.abort(reason)
  await expect(response.text()).rejects.toBe(reason)
})
```

`responseWhoseBodyRejectsOn` 在本测试文件内定义，结构与 Step 3 的 stream listener 相同，不引入 production helper。

- [ ] **Step 6：实现后校准确定性竞态与单次清理 oracle**

使用 `tests/helpers/fake-clock.ts` 的 `FakeClock` 固定三种终局：

1. headers-first：在deadline tick前resolve Response；instrument `deadline.complete()`，断言返回true的次数===1、随后调用返回false、`clock.liveTimerCount===0`，advance不abort body。
2. timeout-first：先`clock.advance(timeoutMs)`触发内部finish，再尝试resolve headers；只得到同一`TimeoutError`，之后`deadline.complete()`返回false、`liveTimerCount===0`。
3. external-abort-first：caller reason胜出，Promise finally调用`deadline.complete()`且仅首次true；header timer清除、`liveTimerCount===0`。

“same tick”用同一`fireAt`的两个barrier分别按注册顺序构造headers-first与timeout-first，不依赖真实event loop运气。`AbortSignal.any`内部listener不可作为公开测试seam，不伪造add/remove计数；本Task断言deadline timer归零和`complete()`幂等。H2 pre/post-response具名listener、`onStreamClosed`与reservation由Task3验证。

- [ ] **Step 7：运行阶段 primitive 测试**

Run: `bun test tests/transport/upstream-fetch.unit.test.ts --timeout 10000`

Expected: PASS。

- [ ] **Step 8：执行正向变异控制**

冻结一个exact patch，让`deadline.complete()`不清timer。运行Step3 long-body和Step6 cleanup矩阵必须变红；反向应用同一patch并reverse-apply check。第二个patch把combined改成只用deadline.signal，lifecycle test必须红。第三个patch删除`finished`幂等门，使竞争双方`finish`都返回true/重复副作用，Step6的“true次数===1/后续false”必须红。遵循`mutation-baseline-must-contain-the-real-impl`，不得整文件restore。

- [ ] **Step 9：提交 Task 1**

```bash
git add -- src/lib/fetch-utils.ts src/lib/transport/upstream-fetch.ts tests/transport/upstream-fetch.unit.test.ts
git commit -m "fix: scope response header deadline to fetch open"
```

## Task 2：迁移所有 HTTP header-timeout 调用点，保留 WS first-event 时钟

**Files:**
- Modify: `src/lib/transport/send.ts:230-304`
- Modify: `src/lib/anthropic/client.ts:65-110,165-211`
- Modify: `src/routes/messages/count-tokens.ts:65-73`
- Modify: `src/lib/models/client.ts:45-53`
- Modify: `src/lib/openai/embeddings.ts:1-72`
- Test: `tests/transport/http-transport.it.test.ts`
- Test: `tests/infra/fetch-utils.it.test.ts`
- Create: `tests/architecture/response-header-timeout-scope.unit.test.ts`
- Test: `tests/models/models-client.it.test.ts`
- Test: `tests/openai/openai-embeddings.it.test.ts`
- Test: `tests/messages/count-tokens.http.test.ts`
- Test: `tests/anthropic/pre-response-abort.http.test.ts`

**Interfaces:**
- Consumes: `UpstreamFetchInit.responseHeaderTimeoutMs`
- Produces: `createUpstreamFirstEventTimeoutSignal(model)`，只供 `src/lib/openai/upstream-ws-attempt.ts` first-event deadline 使用
- Produces: `PostAnthropicUpstreamArgs.responseHeaderTimeoutMs?: number`
- Produces: `PreparedEmbeddingsRequest.responseHeaderTimeoutMs: number` and `signal` containing shutdown only

- [ ] **Step 1：加静态 guard，禁止 HTTP 调用把 header signal塞进 lifecycle signal**

新建 `tests/architecture/response-header-timeout-scope.unit.test.ts`，用 `readFileSync` 读取固定调用点并冻结这些要求：

```ts
expect(read("src/lib/transport/send.ts")).toContain("responseHeaderTimeoutMs: resolveResponseHeaderTimeoutMs(modelId)")
expect(read("src/lib/transport/send.ts")).not.toContain("combineAbortSignals(createResponseHeaderTimeoutSignal")
expect(read("src/lib/openai/upstream-ws-attempt.ts")).toContain("createUpstreamFirstEventTimeoutSignal(wire.model)")
```

该 guard 是辅助绊线；行为测试仍是主 oracle。

- [ ] **Step 2：运行 guard 确认当前为红**

Run: `bun test tests/architecture/response-header-timeout-scope.unit.test.ts --timeout 30000`

Expected: FAIL，指出 `send.ts` 仍把 header signal 合入 lifecycle signal。

- [ ] **Step 3：先用 shared send 接线忠实复现原 bug**

在 `tests/transport/http-transport.it.test.ts` 用 `setStateForTests({ responseHeaderTimeout: 0.01 })` 和 `setFetchMock` 返回“headers立即 resolve、body 40ms后结束且监听 init.signal”的 Response。经 `createUpstreamHttpTransport` 获取 upstream 后完整消费 frames。写完后运行 `bun test tests/transport/http-transport.it.test.ts --timeout 30000`，Expected: FAIL，因为现有shared send的10ms header signal延伸到body；Task1的新`upstreamFetch`参数尚未被shared send采用，所以这条测试直接守调用点迁移。

- [ ] **Step 4：迁移 shared `sendUpstreamHttp`**

将：

```ts
const fetchSignal = combineAbortSignals(createResponseHeaderTimeoutSignal(modelId), getShutdownSignal(), clientAbortSignal, reaperSignal, dispatchSignal)
```

改为：

```ts
const fetchSignal = combineAbortSignals(getShutdownSignal(), clientAbortSignal, reaperSignal, dispatchSignal)
const responseHeaderTimeoutMs = resolveResponseHeaderTimeoutMs(modelId)
```

并给 `upstreamFetch` 传 `signal: fetchSignal, responseHeaderTimeoutMs`。shutdown rewrite 继续检查 `fetchSignal.reason`，不读取 header controller。

- [ ] **Step 5：迁移 Anthropic direct/count_tokens**

`PostAnthropicUpstreamArgs` 改成：

```ts
interface PostAnthropicUpstreamArgs {
  // existing fields
  signal?: AbortSignal
  responseHeaderTimeoutMs?: number
}
```

`postAnthropicUpstream` 将两者分别传给 `upstreamFetch`。`createAnthropicMessages` 的 `upstreamSignal` 只合并 shutdown/client，另传 `resolveResponseHeaderTimeoutMs(model)`。`count-tokens.ts` 直接传 timeout ms，不再创建 timeout signal。

- [ ] **Step 6：迁移 models 与 embeddings**

`getModels()`：

```ts
const response = await upstreamFetch(url, {
  headers,
  responseHeaderTimeoutMs: resolveResponseHeaderTimeoutMs(),
})
```

`PreparedEmbeddingsRequest`：

```ts
readonly signal: AbortSignal | undefined // shutdown only
readonly responseHeaderTimeoutMs: number
```

prepare 时分别填 `signal: getShutdownSignal()` 与 `responseHeaderTimeoutMs: resolveResponseHeaderTimeoutMs(payload.model)`，execute 时分别传入。

`getVSCodeVersion()` 的 5s controller 是整个小型操作的 hard deadline，不伪装成 response-header deadline；保持不变。token domain 传入的 signal 语义由 token package 自己拥有，本任务不改。

- [ ] **Step 7：重命名并验证 WS first-event helper**

把 `createResponseHeaderTimeoutSignal` 重命名为 `createUpstreamFirstEventTimeoutSignal`，更新 `src/lib/openai/upstream-ws-attempt.ts` 与 `tests/infra/fetch-utils.it.test.ts` 的 import/call/describe；测试断言名称改为WS first-event语义，但仍覆盖disabled/scalar/per-model override。全仓 `rg 'createResponseHeaderTimeoutSignal'` 必须零命中。该helper内部仍可用`AbortSignal.timeout(resolveResponseHeaderTimeoutMs(model))`，因为WS first-event request controller在首事件后显式移除listener，语义由WS owner掌控。

Run: `bun test tests/infra/fetch-utils.it.test.ts tests/responses/upstream-ws-connection.unit.test.ts tests/transport/responses-transport.it.test.ts --timeout 30000`

Expected: PASS；WS first-event timeout 仍使用可持续 signal。

- [ ] **Step 8：运行调用点测试**

Run: `bun test tests/transport/http-transport.it.test.ts tests/transport/upstream-fetch.unit.test.ts tests/infra/fetch-utils.it.test.ts tests/anthropic/pre-response-abort.http.test.ts tests/messages/count-tokens.http.test.ts tests/models/models-client.it.test.ts tests/openai/openai-embeddings.it.test.ts --timeout 30000`

Expected: PASS。

- [ ] **Step 9：提交 Task 2**

```bash
git add -- src/lib/fetch-utils.ts src/lib/transport/send.ts src/lib/anthropic/client.ts src/routes/messages/count-tokens.ts src/lib/models/client.ts src/lib/openai/embeddings.ts src/lib/openai/upstream-ws-attempt.ts tests/architecture/response-header-timeout-scope.unit.test.ts tests/transport/http-transport.it.test.ts tests/infra/fetch-utils.it.test.ts tests/anthropic/pre-response-abort.http.test.ts tests/messages/count-tokens.http.test.ts tests/models/models-client.it.test.ts tests/openai/openai-embeddings.it.test.ts
git commit -m "refactor: separate header and lifecycle abort scopes"
```

## Task 3：阶段 1 端到端 H2 回归、结构检查、评审与合并

**Files:**
- Modify: `src/lib/transport/http2-client.ts`
- Modify: `tests/transport/http2-client.it.test.ts`
- Modify: `docs/spec/2026-08-06-http2-cancel-provenance-and-header-deadline.md` only for implementation status, not design changes

- [ ] **Step 1：只写 H2 回归测试，不改 production**

在`http2-client.it.test.ts`通过`upstreamFetch("https://fixture.invalid/late",...)`驱动真实selector→HTTP/2 adapter；server立即`respond()`，延迟50ms才`end("late")`，设置`responseHeaderTimeoutMs:10`并断言body为late。

同文件用test-only signal facade统计post-response abort listener：pre-response header-timeout应为0 add/0 remove；natural end与post-header external abort各应1 add/1 remove。三路都断言`onStreamClosed`一次、reservation最终回0。保留direct `http2Fetch` signal测试。

- [ ] **Step 2：运行测试确认旧匿名 listener 被红门咬住**

Run: `bun test tests/transport/http2-client.it.test.ts tests/transport/upstream-fetch.unit.test.ts tests/transport/http-transport.it.test.ts --timeout 30000`

Expected: FAIL；旧实现的post-response listener为匿名函数，natural end无法remove，至少listener 1/1断言失败；headers-long-body行为应绿，证明失败来自cleanup机制。

- [ ] **Step 3：实现具名幂等 listener cleanup**

修改`http2-client.ts`：把post-response匿名abort listener抽成具名`onPostResponseAbort`，在natural end、stream close和abort teardown上通过幂等`detachPostResponseAbort()`移除；pre-response timeout从未注册该listener。

- [ ] **Step 4：运行绿门与正向 mutation**

运行Step 2同一命令，Expected: PASS。冻结exact patch删除natural-end/close上的`detachPostResponseAbort()`调用，listener 1/1断言必须红；reverse-apply check后反向恢复。

- [ ] **Step 5：运行阶段 1 全门**

```bash
bun run typecheck
bun run lint:all
bun test tests/architecture/package-boundaries.unit.test.ts tests/architecture/circular-deps-ratchet.unit.test.ts
bun run test:backend
```

Expected: 全部 PASS。若history-search native未构建，只有项目声明的显式skip可接受。

- [ ] **Step 6：记录结构怪味**

- `src/lib/fetch-utils.ts`：first-event helper是否只剩WS consumer。
- `src/lib/transport/upstream-fetch.ts`：watchdog是否唯一实现。
- `src/lib/openai/embeddings.ts`：deadline与shutdown signal是否仍分离。
- `src/lib/transport/http2-client.ts`：pre/post-response listener是否各有唯一owner与幂等cleanup。

将`file:line + smell + disposition`写入阶段review disposition。

- [ ] **Step 7：提交 production + H2 回归测试**

```bash
git add -- src/lib/transport/http2-client.ts tests/transport/http2-client.it.test.ts
git commit -m "fix: clean up HTTP2 header deadline listeners"
```

- [ ] **Step 8：独立 review**

评审命题：

1. headers 后 timer 确实不可能关闭 body。
2. pre-header timeout 仍保留 `TimeoutError` identity。
3. shutdown/client/reaper/dispatch 在 body 阶段仍有效。
4. HTTP 全调用点已迁移，WS first-event 没被误改。
5. 正样本能过、注入“未 disarm”缺陷会红。

reviewer 必须逐条给 `file:line` 或命令输出，并双向检查 false-green/false-red。

- [ ] **Step 9：收口 review 后提交阶段状态**

把阶段 1 commit 列表与测试命令写入 spec 的实施状态段；该状态提交只含文档：

```bash
git add -- docs/spec/2026-08-06-http2-cancel-provenance-and-header-deadline.md
git commit -m "docs: mark header deadline scope landed"
```

- [ ] **Step 10：合并当前 `master`，重跑定向门，再 fast-forward 主线**

在隔离分支先`git merge master`。若master新改动触及相关文件，先运行Task3 Step4绿门观察实际失败，解决冲突后重跑Task3 Step4–5；不得重跑以FAIL为成功标准的Step2红门。随后按`git-preference:coordinating-a-shared-git-worktree`检查主树WIP；只在Git能无覆盖fast-forward时执行主树`git merge --ff-only nghttp2-root-fixes`。不得stash、restore或覆盖peer WIP。

---

# 阶段 2：Termination provenance 生产与 live 策略消费

## Task 4：定义 foundation termination 与 local cancellation cause

**Files:**
- Create: `packages/foundation/src/error/transport-termination.ts`
- Modify: `packages/foundation/src/error/cancellation-reason.ts`
- Modify: `packages/foundation/src/index.ts`
- Modify: `tsconfig.json`
- Modify: `src/lib/abort-bridge.ts`
- Modify: `src/lib/shutdown.ts`
- Modify: `src/lib/transport/dispatch-lifecycle.ts`
- Modify: `packages/foundation/src/stream.ts`
- Modify: `src/lib/error/forward.ts`
- Modify: `src/routes/messages/post-commit-error.ts`
- Create: `tests/infra/transport-termination.unit.test.ts`
- Test: `tests/infra/abort-bridge.unit.test.ts`
- Test: `tests/transport/dispatch-cleanup-baseline.it.test.ts`
- Test: `tests/streaming/stream-guard.unit.test.ts`
- Test: `tests/shutdown/shutdown-mid-stream.http.test.ts`
- Test: `tests/routes/messages/postcommit-error-shaping.it.test.ts`

**Interfaces:**
- Produces: `TransportTerminationEvidence` and `TransportTerminationObservation`
- Produces: `TransportTerminationCollector` with `append(evidence): void`, `snapshot(): ReadonlyArray<...>`, `observe(): TransportTerminationObservation | undefined`
- Produces: `tagTransportTerminationObservation(error, observation)` / `getTransportTerminationObservation(error)` through cause chain
- Extends: `CancellationCause` with `client-disconnect | shutdown | response-header-timeout`

- [ ] **Step 1：写完 collector、cause consumer 与 dispatch lifecycle 测试**

```ts
test("collector preserves conflicting evidence and derives ambiguous attribution", () => {
  const collector = createTransportTerminationCollector()
  collector.append({ kind: "local-signal", observedAt: 10, code: 8, cause: "request-deadline" })
  collector.append({ kind: "stream-error", observedAt: 11, code: 8, errorCode: "ERR_HTTP2_STREAM_ERROR" })
  const observation = collector.observe()
  expect(observation).toEqual({
    firstObserved: "local-signal",
    attribution: "ambiguous",
    evidence: [
      { kind: "local-signal", observedAt: 10, code: 8, cause: "request-deadline" },
      { kind: "stream-error", observedAt: 11, code: 8, errorCode: "ERR_HTTP2_STREAM_ERROR" },
    ],
  })
  const wrapped = new Error("outer", { cause: tagTransportTerminationObservation(new Error("inner"), observation!) })
  expect(getTransportTerminationObservation(wrapped)).toEqual(observation)
})
```

同文件覆盖 local-only→local、peer-only→peer（含 `stream-error code:8` 字段保真）、session-only→session、peer+session→ambiguous、local+session→ambiguous、bare stream-close code0→unknown、追加顺序不丢 evidence、返回值 deep-frozen。

Step 1 还包括 `tests/transport/dispatch-lifecycle.unit.test.ts` 的 external/explicit 双向case、`stream-guard.unit`/`shutdown-mid-stream`/`postcommit-error-shaping` 的新cause行为断言；此时不改production。

- [ ] **Step 2：运行 producer 测试确认红门**

Run: `bun test tests/infra/transport-termination.unit.test.ts tests/infra/abort-bridge.unit.test.ts tests/infra/error.unit.test.ts tests/transport/dispatch-lifecycle.unit.test.ts tests/transport/dispatch-cleanup-baseline.it.test.ts tests/streaming/stream-guard.unit.test.ts tests/shutdown/shutdown-mid-stream.http.test.ts tests/routes/messages/postcommit-error-shaping.it.test.ts --timeout 30000`

Expected: FAIL，至少命中尚不存在的termination collector、新CancellationCause或external reason identity断言；不得只有无关失败。

- [ ] **Step 3：实现 termination SSOT**

按 spec 定义 evidence union与 observation。collector 不允许写 `unknown` evidence；unknown只由 `observe()` 在已有 failure close但证据不足时派生。归因优先看 evidence集合而非首写：local/非零stream reset/session三类机制中恰一类存在时分别归local/peer/session；任意两类以上共现归ambiguous。规则在类型注释中冻结并由Step 1逐格覆盖。Symbol tag只附不可变 observation snapshot，不附 live collector。

- [ ] **Step 4：扩充 producer cause，但不改变边界结果**

- `bridgeClientAbort`：`clientAbort.abort(cancellationAbortError("client-disconnect", "Client disconnected"))`。
- `shutdownAbortReason()`：保留 fresh object identity，同时 tag 为 `shutdown`。
- Task 1 的 header timeout error：tag 为 `response-header-timeout`，`name` 仍为 `TimeoutError`。
- 现有 `switch(getCancellationCause)` 对三个新 cause显式处理，保持现有 client-facing分类。

- [ ] **Step 5：修 dispatch lifecycle 并运行绿门**

external listener调用 `controller.abort(externalSignal.reason)` 并启动iterator cleanup；不得经公开`cancel(reasonString)`。公开`cancel`/`dispose`保持`abortReason("dispatch-cancel")`。运行Step 2同一命令，Expected: PASS。

- [ ] **Step 6：执行 producer mutations**

Mutation A：collector遇第二条 evidence提前return，ambiguous测试红。Mutation B：external listener重新调用 `dispose(reason.message)`，external identity测试红。Mutation C：显式 cancel原样转发无tag reason，dispatch-cancel正样本红。均用 exact patch/reverse-check恢复。

- [ ] **Step 7：提交 Task 4**

```bash
git add -- packages/foundation/src/error/transport-termination.ts packages/foundation/src/error/cancellation-reason.ts packages/foundation/src/index.ts packages/foundation/src/stream.ts tsconfig.json src/lib/abort-bridge.ts src/lib/shutdown.ts src/lib/transport/dispatch-lifecycle.ts src/lib/fetch-utils.ts src/lib/error/forward.ts src/routes/messages/post-commit-error.ts tests/infra/transport-termination.unit.test.ts tests/infra/abort-bridge.unit.test.ts tests/infra/error.unit.test.ts tests/transport/dispatch-lifecycle.unit.test.ts tests/transport/dispatch-cleanup-baseline.it.test.ts tests/streaming/stream-guard.unit.test.ts tests/shutdown/shutdown-mid-stream.http.test.ts tests/routes/messages/postcommit-error-shaping.it.test.ts
git commit -m "feat: define transport termination evidence"
```

## Task 5：HTTP/2 stream recorder 与 session 关联

**Files:**
- Modify: `src/lib/transport/upstream-fetch.ts:43-58`
- Modify: `src/lib/transport/http2-client.ts:95-1185`
- Test: `tests/transport/http2-client.it.test.ts`

**Interfaces:**
- Consumes: `createTransportTerminationCollector()`
- Produces: `UpstreamFetchInit.onTerminationEvidence?: (evidence: TransportTerminationEvidence) => void`
- Produces: `UpstreamFetchInit.getTerminationObservation?:` 不新增；observation 由 transport-local collector accessor 暴露（Task 6）
- Invariant: evidence callback可多次追加且保持顺序；normal end不发布 failure evidence。

- [ ] **Step 1：先写 local body cancel 与 local signal evidence 测试**

扩展现有 body-cancel测试，捕获 evidence：

```ts
const observed: TransportTerminationEvidence[] = []
const response = await http2Fetch(url, { onTerminationEvidence: (value) => observed.push(value) })
await response.body!.cancel("test")
expect(observed.map(({ observedAt: _, ...value }) => value)).toContainEqual({
  kind: "local-body-cancel",
  code: http2.constants.NGHTTP2_CANCEL,
})
```

signal测试用tagged `request-deadline` reason，headers后abort；先用独立事件探针确认本机Bun对该`req.close(CANCEL)`确实发出非零stream error/close回声，再断言production evidence同时包含local-signal与该raw stream evidence，最终observation严格为ambiguous且保留local cause。不得接受“local或ambiguous”。增加定向mutation：仅当collector已含local evidence时跳过stream append，该测试必须变红。

- [ ] **Step 2：建立公开 API 的真实 peer RST wire oracle，并独立验证 code8 保真**

在现有 `http2-client.it.test.ts` 的本地h2c server handler中写一帧DATA后调用公开 `stream.destroy(new Error("peer reset"))`；Bun测试进程使用production `http2Fetch`消费，先断言body因真实`ERR_HTTP2_STREAM_ERROR/rstCode=2`失败，再断言`onTerminationEvidence`含非零stream reset code2且attribution=`peer`。禁止用不忠实的`stream.close(code)`。该形态已有`exp/curl-transport-rst-arbitration`的Bun/Node/curl交叉实测支撑，本测试直接覆盖wire→Bun production事件提取/callback。

可选Node交叉腿只在 `Bun.which("node")` 返回绝对路径时运行同一server/client probe；缺Node时显式skip，不阻断Bun-only环境。它不替代主Bun production测试。

另在foundation collector单测直接输入 `{kind:"stream-error",code:8,...}`，断言code8逐字保留且无local/session时归peer；该测试只证明code映射，不声称生成了真实CANCEL wire。两条证据职责分离，均必须通过。

- [ ] **Step 3：分开写 bare close、session、GOAWAY 正负矩阵**

1. bare stream close/rstCode0、无session evidence→最终unknown。
2. session error/close在stream close前到达→evidence含session与stream close，归session（code0 close不算peer机制）。
3. 非零peer reset后session error/close也在observer解绑前到达→peer+session共现，归ambiguous，不以session覆盖peer。
4. stream close后才发生session close→observer已解绑，session event不归当前stream；保留先前peer/unknown attribution。
5. local intent后session error→ambiguous，双方evidence均在。
6. GOAWAY后在途stream正常end→无failure observation。

mutation删除及时session通知后，第2正样本必须红；延迟解绑observer则第4负样本必须红；把bare close当peer则第1负样本必须红；peer+session归单一cause则第3测试必须红。

- [ ] **Step 4：运行HTTP/2新测试确认红**

Run: `bun test tests/transport/http2-client.it.test.ts tests/infra/transport-termination.unit.test.ts --timeout 30000`

Expected: FAIL，命中缺少`onTerminationEvidence`/active observer或错误attribution；existing unrelated cases仍绿。

- [ ] **Step 5：在 entry 增加 active stream evidence observers**

`H2SessionEntry` 增加：

```ts
activeStreams: Set<{ appendSessionEvidence(event: "error" | "close", errorCode?: string): void }>
```

stream创建后注册 observer，仅在stream真正quiesced后移除。session `error`/`close` 按发生顺序通知当前active streams，再 dispose；GOAWAY继续只retire、不追加 evidence。

- [ ] **Step 6：实现 per-stream collector 与 publish helper**

在 `runHttp2Fetch` 建 collector。所有本地 `req.close(CANCEL)` 使用共享 helper：

```ts
const closeLocally = (evidence: TransportTerminationEvidence): void => {
  collector.append(evidence)
  init.onTerminationEvidence?.(evidence)
  req.close(http2.constants.NGHTTP2_CANCEL)
}
```

- pre/post-response signal追加 local-signal + `getCancellationCause(signal.reason)`。
- `ReadableStream.cancel()`追加 local-body-cancel。
- stream error/end/close都检查当时 `req.rstCode`；任一事件看到非零code都追加peer结构evidence。只有`end`时code===0才标记natural end；code>0的end必须`controller.error()`，不能误当clean completion。
- session observer追加session evidence。
- body `controller.error()` 的 Error附当前 immutable observation snapshot；后续 evidence仍由 accessor在quiescence后提供最终值。

- [ ] **Step 7：在 stream close 同步边界完成 evidence finalization**

post-response abort listener改为具名函数，在stream close/natural end时移除。session `error`/`close` listener只通知当时仍在 `activeStreams` 的observer；stream `close` handler按同步顺序执行：

1. 追加该stream close/rstCode evidence；
2. 读取已经由更早session listener追加的evidence；
3. 从 `activeStreams` 删除observer，之后任何session event都不再归当前stream；
4. 调用 `onStreamClosed` 并 resolve `requestClosed`。

禁止使用 `setImmediate`、固定延迟或事后读取 `session.closed` 来猜因果。该边界宁可漏记迟到的真实session teardown，也不吸收无关session close。observation accessor在`requestClosed`后稳定；最终canonical settlement仍须在`lifecycle.quiesced`后读取。测试按Step 3六种顺序驱动，并运行reservation、idle reap、shutdown race，断言`onStreamClosed`一次、active observer移除、slot回0。

- [ ] **Step 8：运行绿门与正向变异**

运行Step 4同一命令，Expected: PASS。

Mutation A：local close前不append，local cause测试红。Mutation B：collector丢后续stream/session evidence，ambiguous/session-order测试红。Mutation C：将rstCode0判peer，unknown测试红。Mutation D：GOAWAY通知termination，clean GOAWAY测试红。每次用 frozen exact patch注入/反向恢复。

- [ ] **Step 9：提交 Task 5**

```bash
git add -- src/lib/transport/upstream-fetch.ts src/lib/transport/http2-client.ts tests/transport/http2-client.it.test.ts
git commit -m "feat: record HTTP2 termination evidence"
```

## Task 6：把 termination 暴露给 live transport，并保持失败对象携带 tag

**Files:**
- Modify: `src/lib/pipeline/types.ts:77-89,141-149`
- Modify: `src/lib/transport/upstream-fetch.ts:43-103`
- Modify: `src/lib/transport/http2-client.ts:1025-1050`
- Modify: `src/lib/transport/http-transport.ts:63-127`
- Modify: `src/lib/transport/responses-transport.ts:114-171`
- Modify: `src/lib/transport/send.ts`
- Modify: `src/lib/transport/physical-transport.ts`
- Test: `tests/transport/http-transport.it.test.ts`
- Test: `tests/transport/responses-transport.it.test.ts`

**Interfaces:**
- Produces: `UpstreamStream.getTransportTermination?: () => TransportTerminationObservation | undefined`
- Produces: `UpstreamFetchInit.onPhysicalTransport?: (value: { kind: "http2"; quiesced: Promise<void> } | { kind: "undici" }) => void`
- Produces: `UpstreamStream.terminationQuiesced?: Promise<void>`；只在实际H2选路时取physical `requestClosed`，undici/legacy mock为undefined
- For failed-open: error carries latest immutable snapshot；正常stream在`lifecycle.quiesced`与实际存在的`terminationQuiesced`均完成后读accessor最终值

- [ ] **Step 1：写 streaming accessor 与 snapshot时序测试**

用h2 transport/injected evidence mock断流：local evidence到达后accessor先显示local snapshot；body/iterator lifecycle先quiesce但physical close barrier仍pending时追加peer/session evidence；只有`await upstream.lifecycle.quiesced`再`await upstream.terminationQuiesced`后连续两次读取才必须deep-equal且不再变化。另用`setUpstreamTransportConfig({http2:{favor:false}})`和plain-http路径断言actual transport报告undici、`terminationQuiesced===undefined`且recovery不挂；normal流accessor返回undefined。

- [ ] **Step 2：运行accessor测试确认红**

Run: `bun test tests/transport/http-transport.it.test.ts tests/transport/responses-transport.it.test.ts --timeout 30000`

Expected: FAIL，真实transport返回的`UpstreamStream`尚无`getTransportTermination`或snapshot更新断言失败。

- [ ] **Step 3：实现 transport-local collector capture**

`sendUpstreamHttp` 新增 `onTerminationEvidence` param并转发到 `upstreamFetch`。HTTP/Responses transport持有同一个 collector：

```ts
const termination = createTransportTerminationCollector()
onTerminationEvidence: (value) => termination.append(value)
```

`upstreamFetch`在实际selector分支调用`onPhysicalTransport`：H2由`http2Fetch`在创建`requestClosed`后报告`{kind:"http2",quiesced:requestClosed}`；undici分支在dispatch前报告`{kind:"undici"}`。`sendUpstreamHttp`据此设置`terminationQuiesced`，绝不通过“是否收到onStreamClosed”猜选路。返回`UpstreamStream`时暴露`getTransportTermination:()=>termination.observe()`，仅实际H2携带physical barrier；undici/legacy mock为undefined。若`http2Fetch`已拥有collector，则通过callback追加到transport collector，禁止复制归因逻辑。failed-open error附当时snapshot；scheduler/recovery等待存在的双barrier后优先读owned accessor。

- [ ] **Step 4：保持 hook/mock 兼容**

accessor optional；`physicalTransportFromSend` 不要求 mock提供。真实HTTP transport必须提供，测试覆盖真实路径、snapshot更新与缺失accessor的legacy mock路径。

- [ ] **Step 5：运行 transport suites**

Run: `bun test tests/transport/http-transport.it.test.ts tests/transport/responses-transport.it.test.ts tests/transport/dispatch-cleanup-baseline.it.test.ts --timeout 30000`

Expected: PASS。

- [ ] **Step 6：提交 Task 6**

```bash
git add -- src/lib/pipeline/types.ts src/lib/transport/upstream-fetch.ts src/lib/transport/http2-client.ts src/lib/transport/http-transport.ts src/lib/transport/responses-transport.ts src/lib/transport/send.ts src/lib/transport/physical-transport.ts tests/transport/http-transport.it.test.ts tests/transport/responses-transport.it.test.ts
git commit -m "feat: expose live transport termination provenance"
```

## Task 7：收紧 block-level recovery 的 termination admission

**Files:**
- Modify: `src/lib/pipeline/types.ts:840-852`
- Modify: `src/lib/pipeline/driver.ts:1485-1555`
- Test: `tests/pipeline/buffered-sink.unit.test.ts`
- Test: `tests/pipeline/continuation-retry.it.test.ts`

**Interfaces:**
- Consumes: `getTransportTerminationObservation(error)` and `current.getTransportTermination?.()`
- Produces internal helper: `isBufferedTransportCut(error, upstream): Promise<boolean>`

- [ ] **Step 1：将现有 RST fixture结构化**

把测试中的裸字符串error改为附不可变observation snapshot的error；peer fixture示例包含一条 `stream-error code:8` evidence、`attribution:"peer"`。保留少量完全无observation的legacy mock测试，锁定非H2兼容行为。

- [ ] **Step 2：写六类 attribution 的双向 recovery tests**

使用相同buffer/预算分别构造：local、ambiguous、unknown均`sendCount()===0`；peer、session在`!committedAny && attempt<cap`时发生一次recovery；无observation的clean-EOF truncation保持既有recovery。关键竞态case：accessor初始snapshot为peer，iterator `lifecycle.quiesced`先resolve但`terminationQuiesced`仍pending；随后physical close追加local/session使snapshot变ambiguous并resolve第二道barrier。helper必须等待两道barrier后返回false且不retry；返回的最终`stream-error.transportTermination`必须deep-frozen、attribution=ambiguous且包含完整late evidence。另断言committed block后peer/session仍走continuation/partial-degrade，不扩大透明retry窗口。

- [ ] **Step 3：运行六类recovery测试确认红**

Run: `bun test tests/pipeline/buffered-sink.unit.test.ts tests/pipeline/continuation-retry.it.test.ts --timeout 30000`

Expected: FAIL；当前`classifyStreamError(error)==="other"`会把带local/ambiguous/unknown observation的error仍视为可重试，至少三个负样本失败；peer/session正样本保持现有recovery。

- [ ] **Step 4：实现 helper，不改全局 classifyError**

```ts
async function finalTransportTermination(upstream: UpstreamStream, error: unknown): Promise<TransportTerminationObservation | undefined> {
  await upstream.lifecycle?.quiesced
  await upstream.terminationQuiesced
  return upstream.getTransportTermination?.() ?? getTransportTerminationObservation(error)
}

async function isBufferedTransportCut(error: unknown, upstream: UpstreamStream): Promise<boolean> {
  const observation = await finalTransportTermination(upstream, error)
  if (observation) return observation.attribution === "peer" || observation.attribution === "session"
  return classifyStreamError(error) === "other" // non-H2/legacy transport compatibility
}
```

必须先等待真实transport的iterator lifecycle与physical termination双barrier，再优先读取live accessor；error snapshot可能早于physical close/session evidence。undefined barrier自然立即通过，legacy mock保持fallback。把retry与continuation两处`classifyStreamError(thrown)==="other"`换成`await isBufferedTransportCut(...)`。明确`local|ambiguous|unknown`返回false，不落legacy fallback。`classifyError(mid-body-close)`保持bad_request；普通S4不扩大。

同时把`ResponseOutcome`的`stream-error`分支扩为`transportTermination?: TransportTerminationObservation`。`streamErrorOutcome(error,env,upstream?)`使用同一个`finalTransportTermination`在双barrier后附最终observation；所有拥有current upstream的buffered/live调用点传入，纯delivery error无upstream时保持absent。这样handlers已传递的整个outcome成为diagnostics与canonical共享的冻结事实载体。

- [ ] **Step 5：明确不新增 server-tool gate**

本任务只收紧来源，不改变现有 buffered retry产品契约。不要在本 helper调用 `classifyServerExecutionRisk`；该相邻问题由 `2026-07-23-upstream-silence-commit-timing.md` 的独立设计处理。

- [ ] **Step 6：运行 buffered/continuation tests与 mutations**

Run: `bun test tests/pipeline/buffered-sink.unit.test.ts tests/pipeline/continuation-retry.it.test.ts --timeout 30000`

Mutation A：让local/ambiguous返回true，负样本红。Mutation B：让peer/session返回false，正样本红。Mutation C：让explicit unknown落legacy fallback，unknown测试红。Mutation D：error snapshot优先于live accessor，后到session/ambiguous测试红。Mutation E：`streamErrorOutcome`不附`transportTermination`，frozen outcome生产接线断言必须红。

- [ ] **Step 7：提交 Task 7**

```bash
git add -- src/lib/pipeline/types.ts src/lib/pipeline/driver.ts tests/pipeline/buffered-sink.unit.test.ts tests/pipeline/continuation-retry.it.test.ts
git commit -m "fix: retry only attributable upstream stream cuts"
```

## Task 8：阶段 2 全门、评审与合并

- [ ] **Step 1：运行阶段 2 定向与全量门**

```bash
bun test tests/infra/transport-termination.unit.test.ts tests/transport/http2-client.it.test.ts tests/transport/http-transport.it.test.ts tests/transport/responses-transport.it.test.ts tests/pipeline/buffered-sink.unit.test.ts tests/pipeline/continuation-retry.it.test.ts --timeout 30000
bun run typecheck
bun run lint:all
bun test tests/architecture/package-boundaries.unit.test.ts tests/architecture/circular-deps-ratchet.unit.test.ts
bun run test:backend
```

- [ ] **Step 2：结构怪味记录**

核对并记录：

- `TransportTerminationEvidence/Observation` 是否错误复制到 core。
- `http2-client.ts` stream状态是否散成多组 boolean；若是，收成一个小 recorder/observer对象，不用 RLock/全局 map掩盖职责。
- session observer set是否在每种 close路径清理。
- recovery helper是否在 retry与 continuation重复实现。

- [ ] **Step 3：独立 review 命题**

1. local intent 必须在 close前发布。
2. local error echo不能冒充 peer。
3. 真实 peer样本能被识别，unknown不会被过严/过松误判。
4. GOAWAY-only 不构成 termination。
5. 全局 S4 retry未扩大；只有 buffered recovery消费 attribution=`peer|session`，ambiguous不重试。
6. 正确 local/client/shutdown行为仍保持原协议结果。
7. live observation accessor在stream/lifecycle quiescence后稳定，连续读取不再变化；canonical三条settlement接线属于阶段3 Task9，不作为阶段2合并门。

- [ ] **Step 4：收口并提交状态文档**

把阶段 2 commit 列表与测试命令写入 spec 的实施状态段；该状态提交只含文档：

```bash
git add -- docs/spec/2026-08-06-http2-cancel-provenance-and-header-deadline.md
git commit -m "docs: mark transport termination provenance landed"
```

- [ ] **Step 5：合并最新 master、复验并 fast-forward主线**

重复阶段1 Task3 Step10的merge→复验→`--ff-only`流程；任何同文件master变化都触发重跑阶段2定向门和merged-state review。

---

# 阶段 3：Canonical History、诊断与 UI

## Task 9：Canonical dispatch 字段与 V3 round-trip

**Files:**
- Modify: `src/lib/context/model-operation-record.ts:296-317,477-486,554-574`
- Modify: `src/lib/context/types.ts:544-581`
- Modify: `src/lib/context/request.ts:740-773,1380-1470`
- Modify: `src/lib/pipeline/generation/dispatch-scheduler.ts:41-63,113-166`
- Modify: `src/lib/pipeline/driver.ts:632-724`
- Test: `tests/context/model-operation-record.unit.test.ts`
- Test: `tests/context/generation-finalization.unit.test.ts`
- Test: `tests/pipeline/candidate-runtime.it.test.ts`
- Create: `tests/pipeline/dispatch-termination-recording.it.test.ts`
- Test: `tests/history/v3/readonly-store.it.test.ts`

**Interfaces:**
- Adds: `ModelOperationDispatch.termination?: TransportTerminationObservation`
- Adds: `SettleDispatchInput.termination?: TransportTerminationObservation`
- Adds: `DispatchSettlement.termination?: TransportTerminationObservation`
- Adds: `RequestContext.setGenerationDispatchTerminationProvider(dispatch, { getObservation, lifecycleQuiesced, terminationQuiesced })`，仅运行时、不持久化函数/Promise
- Adds internal scheduler helper: `enrichSettlement(dispatch, settlement): DispatchSettlement`

- [ ] **Step 1：写 recorder typed field 与 immutable settlement测试**

在 `tests/context/model-operation-record.unit.test.ts` 写ambiguous observation typed field/deep-freeze/absence测试；在 `tests/context/generation-finalization.unit.test.ts` 写双barrier+raw error测试；在 `tests/pipeline/candidate-runtime.it.test.ts` 写scheduler settle/dispose两路单元接缝测试；新建 `tests/pipeline/dispatch-termination-recording.it.test.ts`，用production `createDriverRecordingPort`、真实scheduler与真实RequestContext串起三路settlement，禁止fake recording port；在readonly-store写manifest round-trip。此时不改production。

- [ ] **Step 2：运行全部新测试确认红**

Run: `bun test tests/context/model-operation-record.unit.test.ts tests/context/generation-finalization.unit.test.ts tests/pipeline/candidate-runtime.it.test.ts tests/pipeline/dispatch-termination-recording.it.test.ts tests/history/v3/readonly-store.it.test.ts --timeout 30000`

Expected: FAIL，分别命中termination字段/provider/barrier或round-trip缺失；不得仅有无关失败。

- [ ] **Step 3：扩展 canonical types/recorder并记录替代方案**

给 public/mutable/snapshot/settlement四处加 typed observation，使用 foundation SSOT import。`snapshotDispatch`保留immutable value。代码注释说明未采用 `settlementExtensions`/diagnostic bag，因为它们削弱typed exhaustiveness；不得再声称一等字段是数学唯一方案。

- [ ] **Step 4：scheduler 两条路径统一 enrichment**

`ActiveDispatch`保存`getTransportTermination?`、`lifecycleQuiesced`与`terminationQuiesced?`。抽取：

```ts
async function enrichSettlement(dispatch: DispatchHandle, settlement: DispatchSettlement): Promise<DispatchSettlement> {
  const owned = active.get(dispatch)
  await owned?.lifecycleQuiesced
  await owned?.terminationQuiesced
  const termination = settlement.termination
    ?? owned?.getTransportTermination?.()
    ?? getTransportTerminationObservation(settlement.error)
  return termination ? { ...settlement, termination } : settlement
}
```

`disposeDispatch()`与正常`scheduler.settle()`都调用同一async helper，之后才删除active并`recordSettlement`。failed-open从error tag读取。测试分别驱动iterator先quiesce、physical barrier后resolve的两条路径；mutation只等第一道barrier或只修其中一路时，另一条红。

- [ ] **Step 5：接通 driver recording port 与 RequestContext runtime provider**

`recordOpened(dispatch,response)`在stream成功打开时调用`ctx.setGenerationDispatchTerminationProvider(dispatch,{getObservation:response.upstream.getTransportTermination,lifecycleQuiesced:response.lifecycle.quiesced,terminationQuiesced:response.upstream.terminationQuiesced})`；RequestContext的`GenerationAttemptCapture`保存provider/barriers但不序列化。修改logical terminal/finalizer顺序：

1. `recordGenerationLogicalTerminal()` 只冻结 `pendingGenerationTerminal`、seal operation scope并启动finalizer；不再当场settle尚未settled的final attempt。
2. `pendingGenerationTerminal` 分开保存 `runtimeError`（原始对象，仅活到finalizer，用于读Symbol tag）与 `errorSnapshot`（`snapshotForRecorder`结果，用于持久化）；不得从snapshot恢复termination tag。
3. `startGenerationFinalizerIfReady()`先`await operationScope.whenOperationQuiesced()`，再取得未settled final attempt的provider，依次`await provider.lifecycleQuiesced`与`await provider.terminationQuiesced`（undefined自然通过）。两道transport barrier都不由operation scope隐式保证。
4. `commitGenerationObservabilityTerminal()`在operation+iterator+physical三道barrier之后、读取final attempt payload之前，若final attempt尚未settled，则按`explicit termination → provider.getObservation() → getTransportTerminationObservation(runtimeError)`冻结最终observation并调用`settleGenerationAttempt`；持久化terminal error仍使用`errorSnapshot`。
5. scheduler已经settled的attempt保持幂等，不重复settle；provider/barrier在finalizer读取完成前不得清理。

- [ ] **Step 6：实现并校准真实最终失败 production-path 回归**

在`tests/context/generation-finalization.unit.test.ts`构造真实`UpstreamDispatchLifecycle`+独立physical termination deferred：stream pump先抛错，iterator cleanup先resolve `lifecycleQuiesced`，physical close barrier仍pending；logical terminal先发生，随后physical close追加最后evidence并resolve `terminationQuiesced`。请求delivery finalization后断言canonical dispatch包含physical close后的evidence，且Symbol-tagged raw error fallback可读。mutations分别只等operation、只等iterator、从errorSnapshot读tag、logical-terminal当场settle，测试均须红。

`candidate-runtime.it.test.ts`分别覆盖正常`scheduler.settle()`与`disposeDispatch()`内部顺序。`dispatch-termination-recording.it.test.ts`再用production `createDriverRecordingPort→RequestContext`验证这两路和terminal fallback都真正写入canonical record；删除provider注册、错绑handle或绕过recording port时必须红。

- [ ] **Step 7：实现 V3 raw manifest round-trip**

在 readonly-store fixture写带ambiguous observation record，commit→readonly `hydrateManifest`，断言 canonical dispatch字段和evidence顺序逐字相等。另用旧fixture断言absence正常。

- [ ] **Step 8：运行绿门、mutations并提交**

运行Step 2同一命令，Expected: PASS。随后按Step 6说明注入三项mutations（只等operation barrier、从errorSnapshot读tag、logical terminal当场settle），每项须红并用exact patch反向恢复。

```bash
git add -- src/lib/context/model-operation-record.ts src/lib/context/types.ts src/lib/context/request.ts src/lib/pipeline/generation/dispatch-scheduler.ts src/lib/pipeline/driver.ts tests/context/model-operation-record.unit.test.ts tests/context/generation-finalization.unit.test.ts tests/pipeline/candidate-runtime.it.test.ts tests/pipeline/dispatch-termination-recording.it.test.ts tests/history/v3/readonly-store.it.test.ts
git commit -m "feat: persist dispatch transport termination"
```

## Task 10：History REST 投影与结构化 diagnostics

**Files:**
- Modify: `src/lib/history/types.ts:517-570`
- Modify: `src/lib/history/v3/projection.ts:267-348`
- Modify: `src/lib/upstream-stream-diagnostics.ts:98-176`
- Modify: `src/lib/upstream-diagnostics.ts:181-258`
- Modify: `src/routes/gemini/handler-v4.ts:456-464,659-667`
- Create: `tests/history/v3/transport-termination-projection.unit.test.ts`
- Test: `tests/history/v3/recovery-projection.unit.test.ts`
- Test: `tests/infra/upstream-diagnostics.unit.test.ts`
- Test: `tests/infra/upstream-stream-diagnostics.unit.test.ts`
- Test: `tests/gemini/gemini-v4.http.test.ts`

**Interfaces:**
- Adds: `HistoryEntry.attempts[].transportTermination?: TransportTerminationObservation`
- Adds: `UpstreamStreamDisconnectInfo.transportTermination?: TransportTerminationObservation`

- [ ] **Step 1：先写 projection正反测试**

- peer observation投影到attempt。
- local observation保留 `response-header-timeout`/`dispatch-cancel` cause。
- ambiguous observation保留local+peer双方evidence和顺序。
- old record字段absent，投影仍成功且字段undefined。
- normal committed dispatch不产生termination。
- Gemini direct与reverse streaming的真实driver outcome携带late physical observation时，console diagnostics与canonical attempt字段一致；构造只有early error tag、outcome有final ambiguous observation的case，必须记录outcome值。

- [ ] **Step 2：运行projection/diagnostics新测试确认红**

Run: `bun test tests/history/v3/transport-termination-projection.unit.test.ts tests/history/v3/recovery-projection.unit.test.ts tests/infra/upstream-diagnostics.unit.test.ts tests/infra/upstream-stream-diagnostics.unit.test.ts tests/gemini/gemini-v4.http.test.ts --timeout 30000`

Expected: FAIL，`transportTermination`字段/formatter尚不存在；旧record/normal completion既有测试保持绿。

- [ ] **Step 3：实现 History projection**

在attempt object按存在性投影 `attempt.termination`。History type直接import foundation SSOT，不复制union。

- [ ] **Step 4：写 diagnostics formatter implementation and verify tests**

期望片段：

```text
termination=peer first-observed=stream-error evidence=1 h2-code=8
termination=local first-observed=local-signal evidence=1 local-cause=response-header-timeout h2-code=8
termination=ambiguous first-observed=local-signal evidence=2 local-cause=request-deadline h2-code=8
termination=session first-observed=session-error evidence=2 session-event=error
termination=unknown first-observed=stream-close evidence=1
```

absence时保持旧行，不追加误导字段。unknown/ambiguous绝不渲染成peer；原始error detail仍保留。

- [ ] **Step 5：接通 frozen outcome→diagnostics**

阶段2已将`ResponseOutcome`的`stream-error`分支扩为可选`transportTermination`，并在双transport barrier后由driver冻结。`logUpstreamStreamOutcomeError(outcome,ctx)`优先读取`outcome.transportTermination`，其次`getTransportTerminationObservation(outcome.error)`；不再要求handler另传live accessor。Messages、Responses HTTP/WS、Chat callers已传整个outcome。Gemini direct/reverse streaming两处也从`logUpstreamStreamError(outcome.error,ctx)`改为`logUpstreamStreamOutcomeError(outcome,ctx)`，防止late physical evidence丢失。`logUpstreamStreamTruncation`的clean EOF缺终态保持absent。

- [ ] **Step 6：运行投影/日志 tests与 mutation**

Run: `bun test tests/history/v3/transport-termination-projection.unit.test.ts tests/history/v3/recovery-projection.unit.test.ts tests/infra/upstream-diagnostics.unit.test.ts tests/infra/upstream-stream-diagnostics.unit.test.ts tests/gemini/gemini-v4.http.test.ts --timeout 30000`

Mutation：删projection字段，round-trip红；把ambiguous/unknown formatter写成peer，formatter test红；丢第二条evidence或cause wrapping tag，ambiguous/local cause test红。

- [ ] **Step 7：提交 Task 10**

```bash
git add -- src/lib/history/types.ts src/lib/history/v3/projection.ts src/lib/upstream-diagnostics.ts src/lib/upstream-stream-diagnostics.ts src/routes/gemini/handler-v4.ts tests/history/v3/transport-termination-projection.unit.test.ts tests/history/v3/recovery-projection.unit.test.ts tests/infra/upstream-diagnostics.unit.test.ts tests/infra/upstream-stream-diagnostics.unit.test.ts tests/gemini/gemini-v4.http.test.ts
git commit -m "feat: expose transport termination diagnostics"
```

## Task 11：UI、活文档、merged-state review 与最终阶段合并

**Files:**
- Modify: `ui-v4/src/components/detail/segments/MetaSegment.tsx`
- Create: `ui-v4/tests/MetaSegment.vitest.test.tsx`
- Modify: `docs/DESIGN.md`
- Modify: `docs/API.md`
- Modify: `docs/spec/upstream-http2-transport.md`
- Modify: `docs/spec/2026-08-06-http2-cancel-provenance-and-header-deadline.md`

- [ ] **Step 1：先写UI测试并确认红**

新建 `ui-v4/tests/MetaSegment.vitest.test.tsx`，沿用Vitest+jsdom+Testing Library模式渲染四种entry：peer显示attribution/code；local显示cause；ambiguous显示双方evidence count且不显示成peer；无termination时查询label返回null。先运行 `bun run test:ui-v4`，Expected: FAIL，因为MetaSegment尚未渲染termination字段。

- [ ] **Step 2：显示 final attempt termination**

在 `MetaSegment` 读取 `entry.attempts?.at(-1)?.transportTermination`，显示：

- `termination`：attribution
- `first observed`：firstObserved
- `evidence`：数量
- `h2 code`：evidence中的numeric code（多个不同值逐项显示，不静默挑一个）
- `local cause`：local-signal cause
- `session event`：session evidence kind

所有字段 absent时不渲染空行。类型继续从 `@/types`→`~backend/lib/history/store` re-export，不在UI定义镜像union。完成后复跑`bun run test:ui-v4`，Expected: PASS。

- [ ] **Step 3：运行 UI 验证**

```bash
bun run typecheck
bun run typecheck:ui-v4
bun run build:ui-v4
bun run test:ui-v4
```

Expected: PASS；`MetaSegment.vitest.test.tsx` 必须实际执行，build 不可替代该行为测试。

- [ ] **Step 4：同步活文档**

- `docs/DESIGN.md`：transport行说明 header deadline真正止于 headers、termination SSOT和消费者。
- `docs/API.md`：`/history/api/entries/:id` attempt新增可选 `transportTermination` 字段。
- `docs/spec/upstream-http2-transport.md`：更新 abort/RST限制，不再写“只靠错误字符串”；注明 GOAWAY非 termination。
- 当前 spec状态更新为 implemented，逐阶段列 commit。

文档中的每个 `file:line` 在最终文件上重验；数字只写带 commit/命令口径者。

- [ ] **Step 5：运行阶段 3和全项目门**

```bash
bun test tests/context/model-operation-record.unit.test.ts tests/history/v3/readonly-store.it.test.ts tests/history/v3/transport-termination-projection.unit.test.ts tests/history/v3/recovery-projection.unit.test.ts tests/infra/upstream-diagnostics.unit.test.ts tests/infra/upstream-stream-diagnostics.unit.test.ts --timeout 30000
bun run typecheck
bun run lint:all
bun test tests/architecture/package-boundaries.unit.test.ts tests/architecture/circular-deps-ratchet.unit.test.ts
bun run test:backend
bun run typecheck:ui-v4
bun run build:ui-v4
bun run test:ui-v4
```

- [ ] **Step 6：结构怪味记录**

核对：

- canonical/History/UI是否出现第二份 termination类型。
- `dispatchReason` 是否仍被新代码读取做来源判定。
- diagnostics是否重复实现 source formatter；若多处需要，抽一个 foundation/core leaf formatter。
- successful dispatch是否冗余持久化 clean-end。
- docs是否仍把旧 whole-response L2称为推荐路径。

- [ ] **Step 7：独立 merged-state review**

必须逐条验证：

1. header deadline作用域。
2. local-only、peer-only、session-only、local+peer ambiguous、bare-close unknown、GOAWAY+clean-end六格双向判别。
3. block-level recovery只消费 attribution=`peer|session`，且未扩大普通 S4 retry。
4. canonical→persist→hydrate→REST→UI全链路。
5. 日志与History一致，不把 absent/unknown说成 peer。
6. 三阶段 commit各自可部署，commit message与内容相符。
7. 正常成功、client abort、shutdown、REFUSED_STREAM、clean truncation既有契约未回归。

- [ ] **Step 8：处理 review、复评直至无 blocker/major**

每条 finding记录 level、证据、adopt/reject理由。重写触发新 review round；恢复原 reviewer用 `SendMessage`，除非明确 context-window 终态不可调用。

- [ ] **Step 9：提交 docs/UI 状态**

```bash
git add -- ui-v4/src/components/detail/segments/MetaSegment.tsx ui-v4/tests/MetaSegment.vitest.test.tsx docs/DESIGN.md docs/API.md docs/spec/upstream-http2-transport.md docs/spec/2026-08-06-http2-cancel-provenance-and-header-deadline.md
git commit -m "docs: finalize HTTP2 termination observability"
```

- [ ] **Step 10：合并最新 master、重跑 merged-state门、fast-forward主线**

重复前两阶段 merge纪律。合并后在主树用绑定路径的命令确认：

```bash
git rev-parse HEAD
bun run typecheck
bun run test:backend
bun run build:ui-v4
```

不得 push。最终报告三个阶段的本地 commit、master HEAD、测试结果与未决 backlog。

---

## 计划自审清单

- [x] Spec §1 用户裁决全部映射：旧 L2不启用；阶段性基础设施允许先合；逐阶段 merge。
- [x] Spec §3.1 header deadline：Task 1-3覆盖 headers前、headers后、一般 signal、竞态、清理与 mutation。
- [x] Spec §3.2-3.4 termination：Task 4-8覆盖 evidence SSOT、local-only、peer-only、session-only、local+peer ambiguous、bare-close unknown、GOAWAY+clean end与双向控制。
- [x] Spec §3.5 History：Task 9-11覆盖 canonical owner、V3 round-trip、REST、日志、UI。
- [x] Recovery契约：Task 7只收紧来源，不新增 server-tool gate，不扩大普通 S4 retry。
- [x] Placeholder scan：无 TBD/TODO/“类似 Task N”/未定义接口。
- [x] Type consistency：`TransportTerminationEvidence`、`TransportTerminationObservation`、`getTransportTerminationObservation`、`getTransportTermination?()`、`transportTermination` 命名全篇一致。
- [x] 每阶段都有定向测试、正向变异、结构怪味、独立 review、全量门和 master fast-forward步骤。
