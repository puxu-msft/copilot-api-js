---
name: debugging-server-crashes
description: 当 copilot-api-js 服务器意外整进程退出（一条良性取消/错误却杀掉所有并发请求）时使用——两条同构放大链：① 孤儿 promise（无 live awaiter）的 reject 变全局 unhandledRejection；② EventEmitter（socket 等）emit 'error' 时无监听者变 uncaughtException。main.ts 的 process.on 两个 handler 都 →process.exit(1) 把良性事件放大成崩溃（生产 911s abort incident + "[http2] TLS connect timeout" 崩溃）。根因修=产生点挂防御 no-op observer/error-sink，别放宽全局 handler。跨传输/持久化/reaper 的通用崩溃防御模式。
---

# 调试服务器意外退出

服务器整进程退出、一条请求的取消/错误把所有并发请求一起杀掉——`main.ts` 有两个都 `process.exit(1)` 的全局 handler，任一都会把一条良性事件放大成整服务器崩溃：

- **`process.on("unhandledRejection")`** ← **孤儿 promise 的 reject**（无 live awaiter）。
- **`process.on("uncaughtException")`** ← **EventEmitter emit `'error'` 时无监听者**（Node 把无人监听的 `'error'` 事件同步 rethrow）。

**这是跨层崩溃防御模式**，不是某传输专属：实例虽出在 `http2Fetch`（传输层），但两个根因模式会出现在 transport / 持久化 fire-and-forget / reaper 等任何「产生 promise/EventEmitter 但可能没人接住其 reject/'error'」的地方。故独立成 skill，不并入 `bun-upstream-transport`。

## 症状 → 根因

### 变体 A：孤儿 promise reject → unhandledRejection

`http2Fetch` 的 `onPreResponseAbort` reject(AbortError)，当 fetch promise 在 abort 触发时**已被遗弃**（await 链经他路先 settle，如 stale reaper force-fail）→ 崩服务器（生产 911s incident）。孤儿 promise = 创建后无 live awaiter；abort 拒绝在**被 await 时正常捕获**、在**遗弃时变 unhandled**。

### 变体 B：socket 'error' 无监听者 → uncaughtException

`http2-client.ts` 的 `awaitH2Handshake` → `settle(err)`：**先** `removeListener("error", onError)`，**再** `sock.destroy(err)`。`destroy(err)` 会在 socket 上 emit `'error'`；此时已无监听者 → Node 同步 rethrow → uncaughtException → exit(1)。日志里是 `Uncaught exception: Error: [http2] TLS connect timeout after 10000ms`（一条上游 TLS 连接超时杀掉整服务器）。`reject(err)` 那条 promise 链一切正常（retry 逻辑本可正常消费），崩溃与 promise 无关。

关键陷阱：**只有把 FRESH error 交给 destroy 的路径会崩**——timeout（`onTimeout → settle(new Error)`）与 ALPN-downgrade 是 socket 的首次 `'error'` emission → 崩；而 onError 路径的 socket 之前已 emit 过并被消费，`destroy(err)` 在已 errored 的 socket 上**不会**再 emit → 不崩。写回归测试必须走 timeout 路径，别用 RST 图快（会假绿，见 `exp/http2-connect-timeout-crash/3-error-path-does-not-crash.mjs`）。

## 实测裁决要点

- **变体 A** `exp/stale-abort-unhandled/`（真实本地 node:http2 server）：abort 拒绝在被 await 时正常捕获、在遗弃时变 unhandled（栈逐帧一致）；最小化 reject-in-abort-listener 不泄漏 → 确属**遗弃 promise 特有**、非 Bun 通病，Bun+Node 双端一致。
- **变体 A 遗弃源常难纯静态定位**：主 handler/driver/retry 全 await = 安全，多轮 subagent 全栈复现仍 0 unhandled；最可能是 detached `void this.processQueue()` 或并发共享 h2 session 边角。「全栈复现 0 unhandled」不自证遗弃不存在、只证主路径安全（[[feedback-pass-null-clean-not-self-validating]]）。
- **变体 B** `exp/http2-connect-timeout-crash/`：摘 error 监听后 `destroy(err)` → CRASH（Bun+Node 双端）；挂 `sock.on("error", noop)` + `destroy()`（不带 err）→ 不崩且真实 awaiter 仍收 reject。onError（RST）路径实测不崩，证明只有 fresh-error 的 timeout/ALPN 路径需修。

## 根因修 = 产生点挂防御性 no-op observer / error-sink

- **变体 A** `withRejectionObserver`：`p.catch(() => {})` 标记已观察但**不消费**，返回原 `p` → 真实 awaiter 仍独立收到 reject。消除**整类**孤儿-fetch-abort 崩溃，**不依赖定位每个遗弃源**（belt-and-suspenders）。
- **变体 B** teardown 前挂 `sock.on("error", noop)` 再 `sock.destroy()`（不带 err，err 已由 `reject(err)` 投递给 awaiter）。无条件挂 sink 兼防 teardown 期任何异步 socket error。

**How to apply**：
1. **别放宽全局 handler** 用 `isAbortError` 之类豁免——过宽（`TimeoutError` / 含 "abort" 子串 / cause 链），会静默降级真正该崩的未知 reject/exception；根因修在产生点、全局 handler 保持严格。
2. 任何可能 reject 而调用方可能提前停止 await 的 promise 工厂，在返回点挂 observer；任何会在无监听窗口 emit `'error'` 的 EventEmitter（尤其 `socket.destroy(err)`），teardown 前先挂 error-sink。
3. 回归测试须走**真会崩的那条路径**、且用正样本自证（revert 修复后测试必挂）：变体 A abandoned 无 unhandledRejection + 真实 awaiter 仍收 reject；变体 B TLS connect timeout 无 uncaughtException（`setConnectTimeoutForTests` 缩短 deadline + 黑洞 TCP server + `localhost` 主机名规避 TLS SNI 禁 IP）。均在 `tests/transport/http2-client.it.test.ts`。

## 相关

同类「后台任务逃逸 reject 崩进程」主题：`fire-and-forget` 必须 never-throw（后台 backfill / 异步持久化——见 skill `history-backfill` 与记忆 methodology-sync-to-async-persistence-refactor-invariants 的 fire-and-forget-never-throw 条）；变体 A 是 pre-response-abort RFC 的缺陷⑤（reaper `ctx.fail()` 不取消在飞 fetch = 缺陷④，暂缓）。探针 harness 须复制生产接线（否则「全栈复现 0 unhandled」只证主路径安全、不证遗弃不存在），见 skill `empirical-verification`。
