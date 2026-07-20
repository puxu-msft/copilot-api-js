# 修复：陈旧请求 reaper 空有其名 + 上游 abort 拒绝崩溃整服务器

> **实施状态：已完成**
> **落地**：—
> **现状锚点**：`src/lib/context/request.ts`（reapInFlight/lifecycleSignal）；archive/2606-landed-rfcs/stale-reaper-cancellation.md
> **备注**：两缺陷（reaper 空名 + abort 崩服务器）均修；命名演进为 reapInFlight/lifecycleSignal

## Context（为什么做这个）

生产日志里一条 opus-4.8 流式 `/v1/messages` 请求（L2 buffered retry 开启：`protect_streaming_generation: tool_use_only`）卡住，被 stale reaper 在 911s「force-fail」，紧接着抛出一条 **未捕获的 `AbortError`**：

```
[WARN] Force-failing stale request ... state: executing, age: 911s, max: 900s
[FAIL] POST /v1/messages ... 911.3s ↑628.3KB ↓5.1KB: Request exceeded maximum age of 900s
AbortError: The operation was aborted.
    at abortError (src/lib/transport/http2-client.ts:100)
    at onPreResponseAbort (src/lib/transport/http2-client.ts:138)
```

### 实测确认的根因（exp/stale-abort-unhandled/）

两个独立缺陷叠加，后果是**整个服务器进程被一条良性 abort 打死**：

1. **reaper 空有其名（真实架构 bug）**：`runReaperOnce`（[manager.ts:185](src/lib/context/manager.ts#L185)）只调 `ctx.fail(...)`——而 `RequestContext.fail()`（[request.ts:428](src/lib/context/request.ts#L428)）仅记录终态/写 history/移出 active map，**不取消在飞的上游 HTTP/2 fetch、不中止 handler 协程**。于是「force-fail」是装饰性的：上游 h2 流、handler 协程、客户端 socket 一直活到 `response_header` 超时（用户配 1200s）才真正了结——比声明死亡晚 ~289s 的资源泄漏，且 FAIL 日志是个谎言。`state: executing` + `↓5.1KB` = L2 第一次尝试转发了 5.1KB 后截断、第二次尝试 pre-response 卡住。

2. **abort 拒绝崩服务器（灾难放大器）**：当 abort 最终在某个**已被遗弃（无 awaiter）的** http2Fetch promise 上触发时，`onPreResponseAbort` 的 `reject(abortError())` 变成 unhandled rejection。`process.on("unhandledRejection")`（[main.ts:29](src/main.ts#L29)）随即 `process.exit(1)`——把一条良性的「某个在飞操作被取消」放大成**杀掉所有并发请求的整进程崩溃**。

实测（exp/stale-abort-unhandled/probe.ts，真实本地 h2 server）：http2Fetch 的 abort 拒绝在**被 await 时正常捕获**（Case A），在**promise 被遗弃时变 unhandled**（Case B），栈与生产逐帧一致；最小化的 reject-in-abort-listener 不泄漏 → 确属遗弃 promise 特有，非 Bun 通病。修复手法（不在良性 AbortError 上 exit / defensive observer）已在 Bun+Node 双端验证。

> 注：遗弃 promise 的**确切来源**未能纯静态定位（主 handler/driver/retry 路径全都 await=安全；后台 fetch 都有 .catch）。Fix 2 消除 reaper 关联的 lingering（最可能的遗弃窗口），Fix 1 是兜底安全网 + 可观测性（任何残留遗弃 abort 不再杀服务器、而是高声 warn 留痕待后续定位）。

## 实施

### Fix 1 — 良性 AbortError 绝不杀服务器（[src/main.ts](src/main.ts)）

`unhandledRejection` / `uncaughtException` 处理器：若 reason 是 `AbortError`（cancellation，定义上良性），**warn 留痕但不 `process.exit`**；非 abort 的拒绝仍按原样 exit（未知状态）。复用 [`isAbortError`](src/lib/error/)（error 域已有）判别，别只靠 `name`（与 forward.ts 里既有的判别口径一致）。这是对「exit-on-any-unhandled-rejection」这一过激策略的正确收敛，非掩盖——保留原本的可见性意图。

### Fix 2 — 给 reaper 装上牙齿（真正取消在飞请求）

让 force-fail 真的取消上游 fetch + handler，不再 lingering：

1. **`RequestContext` 增一个生命周期 `AbortController`**（[request.ts](src/lib/context/request.ts) `createRequestContext`）：暴露 `ctx.cancelSignal: AbortSignal` 与 `ctx.cancel(): void`（abort 该 controller，幂等）。per-ctx 非 module-global → 无需登记 RESETTERS。
2. **transport 把 `env.ctx.cancelSignal` 折进上游 fetch + 流守卫**（[http-transport.ts:66](src/lib/transport/http-transport.ts#L66) `send`）：`combineAbortSignals(deps.clientAbortSignal, env.ctx.cancelSignal)` 同时喂给 `sendUpstreamHttp` 的 `clientAbortSignal` 与 `guardSseIterable` 的 `clientSignal`。**统一覆盖全 4 个 v4 格式**（Anthropic/CC/Responses/Gemini 都走此 transport）。正常运行 `cancelSignal` 永不触发 → 多一个不触发的信号 → **逐字节等价**（streaming-l2-baseline 不受影响）。
3. **reaper 先 fail 再 cancel**（[manager.ts:200](src/lib/context/manager.ts#L200)）：`ctx.fail(...)`（同步坐实终态，`settled=true`）→ `ctx.cancel()`（abort controller，取消在飞 fetch）。次序保证 handler 后续 settle 全是 no-op，无 ctx 状态竞态；handler 的 awaited 链拿到 AbortError 后被既有 catch 吃掉（[handler-v4.ts:332](src/routes/messages/handler-v4.ts#L332)，client 没断→落 ctx.fail no-op→504/forwardError，状态对客户端是次要的，请求已被正确判失败）。

### 测试

- `tests/context/`（新 `.it`）：reaper force-fail 时 `ctx.cancelSignal` 被 abort（断言信号传播）。
- `tests/transport/` 或 `tests/streaming/`（新 `.it`/`.http`）：`ctx.cancel()` 取消在飞上游 fetch（注入 mock，断 abort 透传）。
- `tests/streaming/`：复用既有 `streaming-l2-baseline.http.test.ts` 确认逐字节等价仍过（多折一个不触发信号）。
- `tests/infra/` 或 unit：abandoned+aborted 上游拒绝**不**触发 `process.exit`（验证 Fix 1 的 AbortError 分流；用 `isAbortError` 单测覆盖良性/非良性两支）。
- 既有 `pre-response-abort.http.test.ts` / `streaming-abort.http.test.ts` / `streaming-l2-buffered.http.test.ts` 全绿（abort 分类 499/504 不变——折进的是 combined 信号，clientAbort.signal.aborted 判别不动）。

### 文档同步（completion-includes-doc-sync）

- [docs/DESIGN.md](docs/DESIGN.md)「活的架构现状」/ `staleRequestMaxAge` 选项行 + [docs/lifecycle.md](docs/lifecycle.md) reaper 段：reaper 现在**取消在飞工作**而非仅打标。
- 清理 exp 探针或留存于 `exp/stale-abort-unhandled/`（按 feedback-experiments-in-repo-exp-dir 留仓库）。

## 验证命令

```bash
bun run typecheck
bun run test:backend            # 全 offline 套件
bun run lint:all
```

（不跑会起服务器的命令；需验证 live reaper 行为时请用户手动启动。）

## 提交（fine-grained，分阶段）

1. `fix(main): unhandledRejection/uncaughtException 不在良性 AbortError 上退出进程`
2. `fix(context): stale reaper 取消在飞上游请求（RequestContext 生命周期 abort + transport 折入）`
3. `test: reaper 取消 + abort 不崩服务器 覆盖`
4. `docs: reaper 现取消在飞工作（DESIGN/shutdown）`
