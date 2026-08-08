# HTTP/2 CANCEL 来源归因与 Header Deadline 实施计划

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
- Invariant: `activeUpstreamFetch` 接收的 `signal` 是 `lifecycle signal ∪ still-armed header signal`；Promise resolve/reject 后 header timer已清除。

- [ ] **Step 1：先写 pre-header timeout 的失败测试**

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

- [ ] **Step 2：运行单测确认当前 API/行为为红**

Run: `bun test tests/transport/upstream-fetch.unit.test.ts --timeout 10000`

Expected: FAIL；当前 `responseHeaderTimeoutMs` 未进入 `UpstreamFetchInit`，injected transport永不 settle，测试超时而不是得到 `TimeoutError`。

- [ ] **Step 3：写 headers 后长 body 的 false-red 控制**

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

这条在旧代码上可能因新参数被忽略而绿，故它不是红门；它的判别力由 Step 1 证明 watchdog接线存在，并由 Step 7 的“删除 disarm” mutation证明。

- [ ] **Step 4：实现 header watchdog primitive**

在 `src/lib/fetch-utils.ts` 用明确构造器替代 HTTP 调用方对 `AbortSignal.timeout()` 的依赖：

```ts
export function createResponseHeaderTimeoutError(ms: number): DOMException {
  return new DOMException(`Upstream response headers not received within ${ms}ms`, "TimeoutError")
}
```

在 `UpstreamFetchInit` 添加 `responseHeaderTimeoutMs?: number`。在 `upstreamFetch()` 解构该字段，建立可清理的 controller/timer，并只把标准 init 交给 transport：

```ts
export function upstreamFetch(url: string | URL, init: UpstreamFetchInit): Promise<Response> {
  const { responseHeaderTimeoutMs = 0, signal, ...transportInit } = init
  if (responseHeaderTimeoutMs <= 0) return activeUpstreamFetch(url, { ...transportInit, signal })

  const header = new AbortController()
  const timer = setTimeout(() => header.abort(createResponseHeaderTimeoutError(responseHeaderTimeoutMs)), responseHeaderTimeoutMs)
  timer.unref?.()
  const combined = combineAbortSignals(signal, header.signal)
  return activeUpstreamFetch(url, { ...transportInit, signal: combined }).finally(() => clearTimeout(timer))
}
```

- [ ] **Step 5：补一般 lifecycle signal 的 false-red 控制**

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

- [ ] **Step 6：添加确定性竞态与单次清理 oracle**

使用 `tests/helpers/fake-clock.ts` 的 `FakeClock` 固定三种终局：

1. headers-first：在 deadline tick 前 resolve Response；`settlements===1`、`clock.liveTimerCount===0`，之后 advance 不 abort body。
2. timeout-first：先 `clock.advance(timeoutMs)`，再尝试 resolve headers；只得到同一个 `TimeoutError`，`settlements===1`、`liveTimerCount===0`。
3. external-abort-first：caller reason胜出，header timer清除；`settlements===1`、`liveTimerCount===0`。

“same tick”用同一 `fireAt` 的两个 barrier分别按注册顺序构造 headers-first与timeout-first，不依赖真实 event loop运气。`AbortSignal.any` 的内部 listener不可作为公开测试 seam，不伪造 add/remove计数；listener清理由 H2 integration在具名 listener上分阶段验证：pre-response header-timeout只注册/移除 pre-response listener，post-response listener严格为0 add/0 remove；natural end与post-header external abort各自断言post-response listener为1 add/1 remove。同时断言`onStreamClosed`只调用一次、reservation最终回0。

- [ ] **Step 7：运行阶段 primitive 测试**

Run: `bun test tests/transport/upstream-fetch.unit.test.ts --timeout 10000`

Expected: PASS。

- [ ] **Step 8：执行正向变异控制**

冻结一个 exact patch，把 `.finally(() => clearTimeout(timer))` 临时改成不 clear。运行 Step 3 的 long-body测试和 Step 6 cleanup矩阵，必须变红；反向应用同一 patch并执行 reverse-apply check。再冻结第二个 patch，把 `combined` 改成只用 `header.signal`，运行 lifecycle test必须变红。第三个 patch允许 timeout与resolve双 settle，Step 6 的 `settlements===1` 必须变红。遵循 `mutation-baseline-must-contain-the-real-impl`，不得整文件 restore。

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

在 `tests/transport/http-transport.it.test.ts` 用 `setStateForTests({ responseHeaderTimeout: 0.01 })` 和 `setFetchMock` 返回“headers立即 resolve、body 40ms后结束且监听 init.signal”的 Response。经 `createUpstreamHttpTransport` 获取 upstream 后完整消费 frames，当前实现必须因 10ms header signal延伸到 body而红；Task 1 的新 `upstreamFetch` 参数尚未被 shared send采用，所以这条测试直接守调用点迁移，不与 Task 1 重复。

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

把 `createResponseHeaderTimeoutSignal` 重命名为 `createUpstreamFirstEventTimeoutSignal`，只更新 `src/lib/openai/upstream-ws-attempt.ts` 的 import/call；全仓 `rg 'createResponseHeaderTimeoutSignal'` 必须零命中。该 helper 内部仍可用 `AbortSignal.timeout(resolveResponseHeaderTimeoutMs(model))`，因为 WS first-event request controller在首事件后显式移除 listener，语义由 WS owner掌控。

Run: `bun test tests/responses/upstream-ws-connection.unit.test.ts tests/transport/responses-transport.it.test.ts --timeout 30000`

Expected: PASS；WS first-event timeout 仍使用可持续 signal。

- [ ] **Step 8：运行调用点测试**

Run: `bun test tests/transport/http-transport.it.test.ts tests/transport/upstream-fetch.unit.test.ts tests/anthropic/pre-response-abort.http.test.ts tests/messages/count-tokens.http.test.ts tests/models/models-client.it.test.ts tests/openai/openai-embeddings.it.test.ts --timeout 30000`

Expected: PASS。

- [ ] **Step 9：提交 Task 2**

```bash
git add -- src/lib/fetch-utils.ts src/lib/transport/send.ts src/lib/anthropic/client.ts src/routes/messages/count-tokens.ts src/lib/models/client.ts src/lib/openai/embeddings.ts src/lib/openai/upstream-ws-attempt.ts tests/architecture/response-header-timeout-scope.unit.test.ts tests/transport/http-transport.it.test.ts tests/anthropic/pre-response-abort.http.test.ts tests/messages/count-tokens.http.test.ts tests/models/models-client.it.test.ts tests/openai/openai-embeddings.it.test.ts
git commit -m "refactor: separate header and lifecycle abort scopes"
```

## Task 3：阶段 1 端到端 H2 回归、结构检查、评审与合并

**Files:**
- Modify: `tests/transport/http2-client.it.test.ts`
- Modify: `docs/spec/2026-08-06-http2-cancel-provenance-and-header-deadline.md` only for implementation status, not design changes

- [ ] **Step 1：添加真实 h2c headers-then-long-body 回归**

在 `http2-client.it.test.ts` 通过 `upstreamFetch("https://fixture.invalid/late", ...)` 而不是直接 `http2Fetch` 驱动；现有 `setHttp2SessionFactoryForTests(() => http2.connect(url))` 把逻辑 https origin接到本地 h2c server，确保 transport selector真走 HTTP/2。server 立即 `respond()`，延迟 50ms 才 `end("late")`；设置 `responseHeaderTimeoutMs: 10`，断言 body 为 `late`。同时保留 direct `http2Fetch` signal 测试，证明一般 body abort仍生效。

- [ ] **Step 2：运行 transport 定向测试**

Run: `bun test tests/transport/http2-client.it.test.ts tests/transport/upstream-fetch.unit.test.ts tests/transport/http-transport.it.test.ts --timeout 30000`

Expected: PASS。

- [ ] **Step 3：运行阶段 1 全门**

Run:

```bash
bun run typecheck
bun run lint:all
bun test tests/architecture/package-boundaries.unit.test.ts tests/architecture/circular-deps-ratchet.unit.test.ts
bun run test:backend
```

Expected: 全部 PASS。若 history-search native 未构建，只有项目声明的显式 skip 可接受。

- [ ] **Step 4：记录结构怪味**

至少核对：

- `src/lib/fetch-utils.ts`：`createUpstreamFirstEventTimeoutSignal` 是否只剩 WS consumer；任何 HTTP consumer 都必须当场修正，避免 API 契约再次泄漏。
- `src/lib/transport/upstream-fetch.ts`：watchdog 是否成为唯一实现，调用点是否仍有第二份 timer。
- `src/lib/openai/embeddings.ts`：prepared request 是否把 header deadline 与 shutdown signal 再次混成一字段。

将 `file:line + smell + disposition` 写入阶段 review disposition 或 commit 前记录。

- [ ] **Step 5：独立 review**

评审命题：

1. headers 后 timer 确实不可能关闭 body。
2. pre-header timeout 仍保留 `TimeoutError` identity。
3. shutdown/client/reaper/dispatch 在 body 阶段仍有效。
4. HTTP 全调用点已迁移，WS first-event 没被误改。
5. 正样本能过、注入“未 disarm”缺陷会红。

reviewer 必须逐条给 `file:line` 或命令输出，并双向检查 false-green/false-red。

- [ ] **Step 6：收口 review 后提交阶段状态**

把阶段 1 commit 列表与测试命令写入 spec 的实施状态段；该状态提交只含文档：

```bash
git add -- docs/spec/2026-08-06-http2-cancel-provenance-and-header-deadline.md
git commit -m "docs: mark header deadline scope landed"
```

- [ ] **Step 7：合并当前 `master`，重跑定向门，再 fast-forward 主线**

在隔离分支先 `git merge master`。若 master 新改动触及同一文件，解决后重跑 Task 3 Step 2-3。随后按 `git-preference:coordinating-a-shared-git-worktree` 检查主树 WIP；只在 Git 能无覆盖 fast-forward 时执行主树 `git merge --ff-only nghttp2-root-fixes`。不得 stash、restore 或覆盖 peer WIP。

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
- Create: `tests/infra/transport-termination.unit.test.ts`
- Test: `tests/infra/abort-bridge.unit.test.ts`
- Test: `tests/transport/dispatch-cleanup-baseline.it.test.ts`
- Test: `tests/streaming/stream-guard.unit.test.ts`
- Test: `tests/shutdown/shutdown-mid-stream.http.test.ts`

**Interfaces:**
- Produces: `TransportTerminationEvidence` and `TransportTerminationObservation`
- Produces: `TransportTerminationCollector` with `append(evidence): void`, `snapshot(): ReadonlyArray<...>`, `observe(): TransportTerminationObservation | undefined`
- Produces: `tagTransportTerminationObservation(error, observation)` / `getTransportTerminationObservation(error)` through cause chain
- Extends: `CancellationCause` with `client-disconnect | shutdown | response-header-timeout`

- [ ] **Step 1：写 append-only evidence、归因与 cause-chain 测试**

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

同文件覆盖 local-only→local、peer-only→peer、session-only→session、peer+session→ambiguous、local+session→ambiguous、bare stream-close code0→unknown、追加顺序不丢 evidence、返回值 deep-frozen。

- [ ] **Step 2：实现 termination SSOT**

按 spec 定义 evidence union与 observation。collector 不允许写 `unknown` evidence；unknown只由 `observe()` 在已有 failure close但证据不足时派生。归因优先看 evidence集合而非首写：local/非零stream reset/session三类机制中恰一类存在时分别归local/peer/session；任意两类以上共现归ambiguous。规则在类型注释中冻结并由Step 1逐格覆盖。Symbol tag只附不可变 observation snapshot，不附 live collector。

- [ ] **Step 3：扩充 producer cause，但不改变边界结果**

- `bridgeClientAbort`：`clientAbort.abort(cancellationAbortError("client-disconnect", "Client disconnected"))`。
- `shutdownAbortReason()`：保留 fresh object identity，同时 tag 为 `shutdown`。
- Task 1 的 header timeout error：tag 为 `response-header-timeout`，`name` 仍为 `TimeoutError`。
- 现有 `switch(getCancellationCause)` 对三个新 cause显式处理，保持现有 client-facing分类。

- [ ] **Step 4：给 dispatch lifecycle 写 external/explicit 双向测试并修实现**

在现有 `tests/transport/dispatch-lifecycle.unit.test.ts` 添加：

1. external controller以 tagged `request-deadline` reason abort；`lifecycle.signal.reason` 必须是同一对象，`getCancellationCause`仍为 request-deadline。
2. 直接 `lifecycle.cancel("lost hedge")`；reason必须是新建的 dispatch-cancel。
3. `dispose()` 在没有 external abort时仍产生 dispatch-cancel；external已先 abort时不得覆盖其 reason。

实现中 external listener调用 `controller.abort(externalSignal.reason)` 并启动 iterator cleanup；不得经公开 `cancel(reasonString)`。公开 `cancel`/`dispose` 保持 `abortReason("dispatch-cancel")`。

- [ ] **Step 5：运行类型与 producer 测试**

Run: `bun test tests/infra/transport-termination.unit.test.ts tests/infra/abort-bridge.unit.test.ts tests/infra/error.unit.test.ts tests/transport/dispatch-lifecycle.unit.test.ts tests/transport/dispatch-cleanup-baseline.it.test.ts tests/streaming/stream-guard.unit.test.ts tests/shutdown/shutdown-mid-stream.http.test.ts --timeout 30000`

Expected: PASS。

- [ ] **Step 6：执行 producer mutations**

Mutation A：collector遇第二条 evidence提前return，ambiguous测试红。Mutation B：external listener重新调用 `dispose(reason.message)`，external identity测试红。Mutation C：显式 cancel原样转发无tag reason，dispatch-cancel正样本红。均用 exact patch/reverse-check恢复。

- [ ] **Step 7：提交 Task 4**

```bash
git add -- packages/foundation/src/error/transport-termination.ts packages/foundation/src/error/cancellation-reason.ts packages/foundation/src/index.ts tsconfig.json src/lib/abort-bridge.ts src/lib/shutdown.ts src/lib/transport/dispatch-lifecycle.ts src/lib/fetch-utils.ts tests/infra/transport-termination.unit.test.ts tests/infra/abort-bridge.unit.test.ts tests/infra/error.unit.test.ts tests/transport/dispatch-lifecycle.unit.test.ts tests/transport/dispatch-cleanup-baseline.it.test.ts tests/streaming/stream-guard.unit.test.ts tests/shutdown/shutdown-mid-stream.http.test.ts
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

- [ ] **Step 4：在 entry 增加 active stream evidence observers**

`H2SessionEntry` 增加：

```ts
activeStreams: Set<{ appendSessionEvidence(event: "error" | "close", errorCode?: string): void }>
```

stream创建后注册 observer，仅在stream真正quiesced后移除。session `error`/`close` 按发生顺序通知当前active streams，再 dispose；GOAWAY继续只retire、不追加 evidence。

- [ ] **Step 5：实现 per-stream collector 与 publish helper**

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

- [ ] **Step 6：在 stream close 同步边界完成 evidence finalization**

post-response abort listener改为具名函数，在stream close/natural end时移除。session `error`/`close` listener只通知当时仍在 `activeStreams` 的observer；stream `close` handler按同步顺序执行：

1. 追加该stream close/rstCode evidence；
2. 读取已经由更早session listener追加的evidence；
3. 从 `activeStreams` 删除observer，之后任何session event都不再归当前stream；
4. 调用 `onStreamClosed` 并 resolve `requestClosed`。

禁止使用 `setImmediate`、固定延迟或事后读取 `session.closed` 来猜因果。该边界宁可漏记迟到的真实session teardown，也不吸收无关session close。observation accessor在`requestClosed`后稳定；最终canonical settlement仍须在`lifecycle.quiesced`后读取。测试按Step 3六种顺序驱动，并运行reservation、idle reap、shutdown race，断言`onStreamClosed`一次、active observer移除、slot回0。

- [ ] **Step 7：运行 HTTP/2 定向测试与正向变异**

Run: `bun test tests/transport/http2-client.it.test.ts --timeout 30000`

Mutation A：local close前不append，local cause测试红。Mutation B：collector丢后续stream/session evidence，ambiguous/session-order测试红。Mutation C：将rstCode0判peer，unknown测试红。Mutation D：GOAWAY通知termination，clean GOAWAY测试红。每次用 frozen exact patch注入/反向恢复。

- [ ] **Step 8：提交 Task 5**

```bash
git add -- src/lib/transport/upstream-fetch.ts src/lib/transport/http2-client.ts tests/transport/http2-client.it.test.ts
git commit -m "feat: record HTTP2 termination evidence"
```

## Task 6：把 termination 暴露给 live transport，并保持失败对象携带 tag

**Files:**
- Modify: `src/lib/pipeline/types.ts:77-89,141-149`
- Modify: `src/lib/transport/http-transport.ts:63-127`
- Modify: `src/lib/transport/responses-transport.ts:114-171`
- Modify: `src/lib/transport/send.ts`
- Modify: `src/lib/transport/physical-transport.ts`
- Test: `tests/transport/http-transport.it.test.ts`
- Test: `tests/transport/responses-transport.it.test.ts`

**Interfaces:**
- Produces: `UpstreamStream.getTransportTermination?: () => TransportTerminationObservation | undefined`
- For failed-open: error carries latest immutable `getTransportTerminationObservation(error)` snapshot；正常 stream以 accessor在quiescence后取最终值

- [ ] **Step 1：写 streaming accessor 与 snapshot时序测试**

用 h2 transport/injected evidence mock断流：local evidence到达后 accessor先显示local snapshot；后续peer evidence到达后同一 accessor显示ambiguous且保留两条。`await upstream.lifecycle.quiesced` 后连续两次读取必须 deep-equal且不再变化。正常流 accessor返回 undefined。

- [ ] **Step 2：实现 transport-local collector capture**

`sendUpstreamHttp` 新增 `onTerminationEvidence` param并转发到 `upstreamFetch`。HTTP/Responses transport持有同一个 collector：

```ts
const termination = createTransportTerminationCollector()
onTerminationEvidence: (value) => termination.append(value)
```

返回 `UpstreamStream` 时暴露 `getTransportTermination: () => termination.observe()`。若 `http2Fetch` 已拥有collector，则通过 callback追加到transport collector，禁止复制归因逻辑。failed-open error附当时snapshot；scheduler仍在quiescence后优先读owned accessor取得最终值。

- [ ] **Step 3：保持 hook/mock 兼容**

accessor optional；`physicalTransportFromSend` 不要求 mock提供。真实HTTP transport必须提供，测试覆盖真实路径、snapshot更新与缺失accessor的legacy mock路径。

- [ ] **Step 4：运行 transport suites**

Run: `bun test tests/transport/http-transport.it.test.ts tests/transport/responses-transport.it.test.ts tests/transport/dispatch-cleanup-baseline.it.test.ts --timeout 30000`

Expected: PASS。

- [ ] **Step 5：提交 Task 6**

```bash
git add -- src/lib/pipeline/types.ts src/lib/transport/http-transport.ts src/lib/transport/responses-transport.ts src/lib/transport/send.ts src/lib/transport/physical-transport.ts tests/transport
git commit -m "feat: expose live transport termination provenance"
```

## Task 7：收紧 block-level recovery 的 termination admission

**Files:**
- Modify: `src/lib/pipeline/driver.ts:1485-1555`
- Test: `tests/pipeline/buffered-sink.unit.test.ts`
- Test: `tests/pipeline/continuation-retry.it.test.ts`

**Interfaces:**
- Consumes: `getTransportTerminationObservation(error)` and `current.getTransportTermination?.()`
- Produces internal helper: `isBufferedTransportCut(error, upstream): boolean`

- [ ] **Step 1：将现有 RST fixture结构化**

把测试中的裸字符串error改为附不可变observation snapshot的error；peer fixture示例包含一条 `stream-error code:8` evidence、`attribution:"peer"`。保留少量完全无observation的legacy mock测试，锁定非H2兼容行为。

- [ ] **Step 2：写六类 attribution 的双向 recovery tests**

使用相同buffer/预算分别构造：local、ambiguous、unknown均 `sendCount()===0`；peer、session在 `!committedAny && attempt<cap` 时发生一次recovery；无observation的clean-EOF truncation保持既有recovery。另断言committed block后peer/session仍走continuation/partial-degrade，不扩大透明retry窗口。

- [ ] **Step 3：实现 helper，不改全局 classifyError**

```ts
function isBufferedTransportCut(error: unknown, upstream: UpstreamStream): boolean {
  const observation = upstream.getTransportTermination?.() ?? getTransportTerminationObservation(error)
  if (observation) return observation.attribution === "peer" || observation.attribution === "session"
  return classifyStreamError(error) === "other" // non-H2/legacy transport compatibility
}
```

live accessor优先，因为error snapshot可能早于后到session evidence；该helper只在catch/stream drain已结束后调用。明确 `local|ambiguous|unknown` 返回false，不落legacy fallback。把retry与continuation两处 `classifyStreamError(thrown)==="other"` 换成helper。`classifyError(mid-body-close)` 保持bad_request；普通S4不扩大。

- [ ] **Step 4：明确不新增 server-tool gate**

本任务只收紧来源，不改变现有 buffered retry产品契约。不要在本 helper调用 `classifyServerExecutionRisk`；该相邻问题由 `2026-07-23-upstream-silence-commit-timing.md` 的独立设计处理。

- [ ] **Step 5：运行 buffered/continuation tests与 mutations**

Run: `bun test tests/pipeline/buffered-sink.unit.test.ts tests/pipeline/continuation-retry.it.test.ts --timeout 30000`

Mutation A：让local/ambiguous返回true，负样本红。Mutation B：让peer/session返回false，正样本红。Mutation C：让explicit unknown落legacy fallback，unknown测试红。Mutation D：error snapshot优先于live accessor，后到session/ambiguous测试红。

- [ ] **Step 6：提交 Task 7**

```bash
git add -- src/lib/pipeline/driver.ts tests/pipeline/buffered-sink.unit.test.ts tests/pipeline/continuation-retry.it.test.ts
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
7. `disposeDispatch`、正常 `scheduler.settle()`、最终 logical terminal fallback 三条路径都能在quiescence后取得最终observation。

- [ ] **Step 4：收口并提交状态文档**

把阶段 2 commit 列表与测试命令写入 spec 的实施状态段；该状态提交只含文档：

```bash
git add -- docs/spec/2026-08-06-http2-cancel-provenance-and-header-deadline.md
git commit -m "docs: mark transport termination provenance landed"
```

- [ ] **Step 5：合并最新 master、复验并 fast-forward主线**

重复阶段 1 Task 3 Step 7；任何同文件 master变化都触发重跑阶段 2 定向门和 merged-state review。

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
- Test: `tests/history/v3/readonly-store.it.test.ts`

**Interfaces:**
- Adds: `ModelOperationDispatch.termination?: TransportTerminationObservation`
- Adds: `SettleDispatchInput.termination?: TransportTerminationObservation`
- Adds: `DispatchSettlement.termination?: TransportTerminationObservation`
- Adds: `RequestContext.setGenerationDispatchTerminationProvider(dispatch, provider)`，仅运行时、不持久化函数
- Adds internal scheduler helper: `enrichSettlement(dispatch, settlement): DispatchSettlement`

- [ ] **Step 1：写 recorder typed field 与 immutable settlement测试**

在 model-operation recorder test用含ambiguous evidence的observation settle dispatch，断言 snapshot逐字相等且deep-frozen；重复settle不得覆盖first settlement。另测无termination的成功dispatch保持字段absent。

- [ ] **Step 2：扩展 canonical types/recorder并记录替代方案**

给 public/mutable/snapshot/settlement四处加 typed observation，使用 foundation SSOT import。`snapshotDispatch`保留immutable value。代码注释说明未采用 `settlementExtensions`/diagnostic bag，因为它们削弱typed exhaustiveness；不得再声称一等字段是数学唯一方案。

- [ ] **Step 3：scheduler 两条路径统一 enrichment**

`ActiveDispatch` 保存 `getTransportTermination?`。抽取：

```ts
function enrichSettlement(dispatch: DispatchHandle, settlement: DispatchSettlement): DispatchSettlement {
  const owned = active.get(dispatch)
  const termination = settlement.termination
    ?? owned?.getTransportTermination?.()
    ?? getTransportTerminationObservation(settlement.error)
  return termination ? { ...settlement, termination } : settlement
}
```

`disposeDispatch()` 与正常 `scheduler.settle()` 都必须先 await `lifecycle.quiesced`，再调用同一helper，最后删除active并 `recordSettlement`。failed-open从error tag读取。测试分别驱动两条路径；mutation只修其中一条时另一条红。

- [ ] **Step 4：接通 driver recording port 与 RequestContext runtime provider**

`recordOpened(dispatch,response)` 在stream成功打开时调用 `ctx.setGenerationDispatchTerminationProvider(dispatch,response.upstream.getTransportTermination)`；RequestContext 的 `GenerationAttemptCapture` 保存provider但不序列化函数。修改 logical terminal/finalizer 顺序：

1. `recordGenerationLogicalTerminal()` 只冻结 `pendingGenerationTerminal`、seal operation scope并启动finalizer；不再当场settle尚未settled的final attempt。
2. `startGenerationFinalizerIfReady()` 维持现有 `await operationScope.whenOperationQuiesced()` barrier。
3. `commitGenerationObservabilityTerminal()` 在barrier之后、读取final attempt payload之前，若final attempt尚未settled，则按 `explicit termination → provider() → error tag` 冻结最终observation并调用 `settleGenerationAttempt`。
4. scheduler已经settled的attempt保持幂等，不重复settle。

这样terminal fallback不会在quiescence前冻结旧snapshot；provider函数在finalizer读完之前不得清理。

- [ ] **Step 5：写真实最终失败 production-path 回归**

从driver/candidate路径打开一个stream，注入peer evidence后使最终attempt失败且不进入recovery/continuation；先调用logical terminal，再让一个tracked operation child在下一microtask追加最后evidence并quiesce，最后请求delivery finalization。断言canonical dispatch包含quiescence后evidence。另分别覆盖`scheduler.settle()` recovery parent与`disposeDispatch()` cancellation，三条路径缺一即红；mutation恢复logical-terminal当场settle时测试必须红。

- [ ] **Step 6：V3 raw manifest round-trip测试**

在 readonly-store fixture写带ambiguous observation record，commit→readonly `hydrateManifest`，断言 canonical dispatch字段和evidence顺序逐字相等。另用旧fixture断言absence正常。

- [ ] **Step 7：运行 tests并提交**

Run: `bun test tests/context/model-operation-record.unit.test.ts tests/history/v3/readonly-store.it.test.ts tests/context/generation-finalization.unit.test.ts --timeout 30000`

```bash
git add -- src/lib/context src/lib/pipeline/generation/dispatch-scheduler.ts src/lib/pipeline/driver.ts tests/context tests/history/v3/readonly-store.it.test.ts
git commit -m "feat: persist dispatch transport termination"
```

## Task 10：History REST 投影与结构化 diagnostics

**Files:**
- Modify: `src/lib/history/types.ts:517-570`
- Modify: `src/lib/history/v3/projection.ts:267-348`
- Modify: `src/lib/upstream-stream-diagnostics.ts:98-176`
- Modify: `src/lib/upstream-diagnostics.ts:181-258`
- Create: `tests/history/v3/transport-termination-projection.unit.test.ts`
- Test: `tests/history/v3/recovery-projection.unit.test.ts`
- Test: `tests/infra/upstream-diagnostics.unit.test.ts`
- Test: `tests/infra/upstream-stream-diagnostics.unit.test.ts`

**Interfaces:**
- Adds: `HistoryEntry.attempts[].transportTermination?: TransportTerminationObservation`
- Adds: `UpstreamStreamDisconnectInfo.transportTermination?: TransportTerminationObservation`

- [ ] **Step 1：先写 projection正反测试**

- peer observation投影到attempt。
- local observation保留 `response-header-timeout`/`dispatch-cancel` cause。
- ambiguous observation保留local+peer双方evidence和顺序。
- old record字段absent，投影仍成功且字段undefined。
- normal committed dispatch不产生termination。

- [ ] **Step 2：实现 History projection**

在attempt object按存在性投影 `attempt.termination`。History type直接import foundation SSOT，不复制union。

- [ ] **Step 3：写 diagnostics formatter tests**

期望片段：

```text
termination=peer first-observed=stream-error evidence=1 h2-code=8
termination=local first-observed=local-signal evidence=1 local-cause=response-header-timeout h2-code=8
termination=ambiguous first-observed=local-signal evidence=2 local-cause=request-deadline h2-code=8
termination=session first-observed=session-error evidence=2 session-event=error
termination=unknown first-observed=stream-close evidence=1
```

absence时保持旧行，不追加误导字段。unknown/ambiguous绝不渲染成peer；原始error detail仍保留。

- [ ] **Step 4：接通 observation→diagnostics**

`logUpstreamStreamError` 优先读取 caller提供的live accessor最终snapshot，其次 `getTransportTerminationObservation(error)`；只取结构化值。`logUpstreamStreamTruncation` 的 clean EOF缺终态不是H2 termination，保持字段absent。

- [ ] **Step 5：运行投影/日志 tests与 mutation**

Run: `bun test tests/history/v3/transport-termination-projection.unit.test.ts tests/history/v3/recovery-projection.unit.test.ts tests/infra/upstream-diagnostics.unit.test.ts tests/infra/upstream-stream-diagnostics.unit.test.ts --timeout 30000`

Mutation：删projection字段，round-trip红；把ambiguous/unknown formatter写成peer，formatter test红；丢第二条evidence或cause wrapping tag，ambiguous/local cause test红。

- [ ] **Step 6：提交 Task 10**

```bash
git add -- src/lib/history src/lib/upstream-diagnostics.ts src/lib/upstream-stream-diagnostics.ts tests/history tests/infra/upstream-diagnostics.unit.test.ts tests/infra/upstream-stream-diagnostics.unit.test.ts
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

- [ ] **Step 1：显示 final attempt termination**

在 `MetaSegment` 读取 `entry.attempts?.at(-1)?.transportTermination`，显示：

- `termination`：attribution
- `first observed`：firstObserved
- `evidence`：数量
- `h2 code`：evidence中的numeric code（多个不同值逐项显示，不静默挑一个）
- `local cause`：local-signal cause
- `session event`：session evidence kind

所有字段 absent时不渲染空行。类型继续从 `@/types`→`~backend/lib/history/store` re-export，不在UI定义镜像union。

新建 `ui-v4/tests/MetaSegment.vitest.test.tsx`，沿用Vitest+jsdom+Testing Library模式渲染四种entry：peer显示attribution/code；local显示cause；ambiguous显示双方evidence count且不显示成peer；无termination时查询label返回null。该测试同时防止可选字段导致空行。

- [ ] **Step 2：运行 UI 验证**

```bash
bun run typecheck
bun run typecheck:ui-v4
bun run build:ui-v4
bun run test:ui-v4
```

Expected: PASS；`MetaSegment.vitest.test.tsx` 必须实际执行，build 不可替代该行为测试。

- [ ] **Step 3：同步活文档**

- `docs/DESIGN.md`：transport行说明 header deadline真正止于 headers、termination SSOT和消费者。
- `docs/API.md`：`/history/api/entries/:id` attempt新增可选 `transportTermination` 字段。
- `docs/spec/upstream-http2-transport.md`：更新 abort/RST限制，不再写“只靠错误字符串”；注明 GOAWAY非 termination。
- 当前 spec状态更新为 implemented，逐阶段列 commit。

文档中的每个 `file:line` 在最终文件上重验；数字只写带 commit/命令口径者。

- [ ] **Step 4：运行阶段 3和全项目门**

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

- [ ] **Step 5：结构怪味记录**

核对：

- canonical/History/UI是否出现第二份 termination类型。
- `dispatchReason` 是否仍被新代码读取做来源判定。
- diagnostics是否重复实现 source formatter；若多处需要，抽一个 foundation/core leaf formatter。
- successful dispatch是否冗余持久化 clean-end。
- docs是否仍把旧 whole-response L2称为推荐路径。

- [ ] **Step 6：独立 merged-state review**

必须逐条验证：

1. header deadline作用域。
2. local-only、peer-only、session-only、local+peer ambiguous、bare-close unknown、GOAWAY+clean-end六格双向判别。
3. block-level recovery只消费 attribution=`peer|session`，且未扩大普通 S4 retry。
4. canonical→persist→hydrate→REST→UI全链路。
5. 日志与History一致，不把 absent/unknown说成 peer。
6. 三阶段 commit各自可部署，commit message与内容相符。
7. 正常成功、client abort、shutdown、REFUSED_STREAM、clean truncation既有契约未回归。

- [ ] **Step 7：处理 review、复评直至无 blocker/major**

每条 finding记录 level、证据、adopt/reject理由。重写触发新 review round；恢复原 reviewer用 `SendMessage`，除非明确 context-window 终态不可调用。

- [ ] **Step 8：提交 docs/UI 状态**

```bash
git add -- ui-v4/src/components/detail/segments/MetaSegment.tsx ui-v4/tests/MetaSegment.vitest.test.tsx docs/DESIGN.md docs/API.md docs/spec/upstream-http2-transport.md docs/spec/2026-08-06-http2-cancel-provenance-and-header-deadline.md
git commit -m "docs: finalize HTTP2 termination observability"
```

- [ ] **Step 9：合并最新 master、重跑 merged-state门、fast-forward主线**

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
