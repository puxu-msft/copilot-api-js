---
name: debugging-server-crashes
description: 当 copilot-api-js 服务器意外整进程退出（一条良性取消/错误却杀掉所有并发请求）时使用——三条同构放大链：① 孤儿 promise（无 live awaiter）的 reject 变全局 unhandledRejection；② EventEmitter（socket/h2 session）emit 'error' 时无监听者变 uncaughtException；③ seal 后晚到的 best-effort 观测写（timing/headers）撞 assertWritable 抛错、经①放大（判据=语义写保持 loud-throw、best-effort 观测静默丢弃；同族不对称即红旗）。main.ts 的 process.on 两个 handler 都 →process.exit(1) 把良性事件放大成崩溃（生产 911s abort incident + "[http2] TLS connect timeout" 崩溃）。根因修=产生点挂对称的两个 class-eliminator 原语（`src/lib/transport/crash-safety.ts` 的 withRejectionObserver / withErrorSink），在取得所有权处统一应用、别放宽全局 handler。跨传输/持久化/reaper 的通用崩溃防御模式。
---

# 调试服务器意外退出

服务器整进程退出、一条请求的取消/错误把所有并发请求一起杀掉——`main.ts` 有两个都 `process.exit(1)` 的全局 handler，任一都会把一条良性事件放大成整服务器崩溃：

- **`process.on("unhandledRejection")`** ← **孤儿 promise 的 reject**（无 live awaiter）。
- **`process.on("uncaughtException")`** ← **EventEmitter emit `'error'` 时无监听者**（Node 把无人监听的 `'error'` 事件同步 rethrow）。

**这是跨层崩溃防御模式**，不是某传输专属：实例虽出在 `http2Fetch`（传输层），但两个根因模式会出现在 transport / 持久化 fire-and-forget / reaper 等任何「产生 promise/EventEmitter 但可能没人接住其 reject/'error'」的地方。故独立成 skill，不并入 `debugging-ghc-api-upstream-transport`。

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

## 根因修 = 产生点挂防御原语（两个对称 class-eliminator，共置 `src/lib/transport/crash-safety.ts`）

两个变体各有一个**产生点原语**,消除**整类**逃逸,**不依赖枚举每个 teardown/handoff/abandon 点**(逐点枚举易漏——本次 reviewer 正是找到 executor 漏的第 2 处 session-race)。都**非消费**:真实 awaiter / 真实 `'error'` listener 仍独立 fire,原语只把「无真实消费者」从崩溃变为安全忽略。

- **变体 A** `withRejectionObserver(p)`:`p.catch(() => {})` 标记已观察但不消费,返回原 `p` → 真实 awaiter 仍独立收到 reject。
- **变体 B** `withErrorSink(emitter)`:挂常驻 inert `'error'` listener(`.on` 非 `.once`——迟到 teardown 可多次 emit),返回原 emitter。在 transport **取得 emitter 所有权处**统一应用(socket 创建、从注入工厂接收 session):`createSession` 的两个 `tls.connect`、`getSession` 的 `sessionFactory` 返回值、`proxy-connect` 的 socks/http-connect socket。覆盖全部下游 teardown(handshake 超时、shutdown-race close、创建→adopt handoff gap、未来新增创建点),无需逐一定位。

配合的第二层(defense-in-depth,非必需):`settle` 失败分支用 `sock.destroy()`**不带 err**(err 已由 `reject` 投递)——`destroy()` 无 err 参数**不会** re-emit `'error'`,故即使没有 sink 也不触发 classic `destroy(err)` re-emit 崩溃。两层任一独立即可防住 timeout 路径;都保留。

### 变体 C:**seal 后晚到的 best-effort 观测写抛错**(2026-07-28,upstream-silence B2 Task 0.6)

变体 A 的一类**产生点**,值得单列因为它不在 transport 层、且修法方向相反(不是挂 observer,是**让写本身别抛**)。

- **形状**:某个记录器/账本在 settle 后 `seal`,其写入口用 `assertWritable()` **loud-throw**;而一个**晚到的异步回调**仍会写它 → 抛错沿调用栈上抛 → 若原 promise 已无 live awaiter(handler 因 reap/abort/deadline 早已移交)→ 孤儿 rejection → `unhandledRejection` → `process.exit(1)`。**良性的迟到观测被放大成整进程退出**。
- **本项目实例**:`dispatch-scheduler` 在 `await input.open()` resolve 后无守卫调 `recording.recordOpened(...)`;GHC 的 **deferred-header** 可让 header 迟到 47-231s(上界未知,见 spec `2026-07-23-upstream-silence-commit-timing`),期间 reaper / `request_deadline` / candidate-discard 完全可能已 seal 掉 operation。窗口越长、race 越现实。
- **判据(关键,别一刀切)**:分两类写——**语义写**(payload/frame,seal 后写会**腐化记录**)保持 loud-throw,**绝不放宽**;**best-effort 晚到观测**(timing 四刻、response headers 这类只增诊断价值的证据)应与同族逐帧 capture 对齐、`if (sealed) return` **静默丢弃**。同族不对称本身就是红旗:本项目的逐帧 `captureForwardedGenerationFrame` 早已 `if (sealed) return`,唯独 timing 走 `assertWritable` 抛错。
- **修法**:守卫**整条晚到观测**(整个 `recordOpened` 开头早返回),而非只堵当前会抛的那一处——seal 后整条观测本就该整体丢弃,且防未来往同一回调新增无守卫写;并让 setter 自身也对齐 `if (sealed) return` 作双保险(别只靠调用点)。
- **正样本对照**:去掉守卫后 seal-race 回归测试必须变红(实测 3/3 红),否则测试没咬住;测试挂 `process.once("unhandledRejection")` 探针 + 覆盖 reaper/deadline/abort × late-header 组合。


**How to apply**：
1. **别放宽全局 handler** 用 `isAbortError` 之类豁免——过宽（`TimeoutError` / 含 "abort" 子串 / cause 链），会静默降级真正该崩的未知 reject/exception；根因修在产生点、全局 handler 保持严格。
2. 任何可能 reject 而调用方可能提前停止 await 的 promise → `withRejectionObserver`；任何会在无监听窗口 emit `'error'` 的 EventEmitter(socket / h2 session)→ 在**取得所有权处** `withErrorSink`,别在每个 teardown 点补。
3. 测试分层、各自正样本自证(revert 必挂):**原语单元测试** `tests/transport/crash-safety.unit.test.ts`(无 sink 时 `emit('error')` 真会 throw → sink 载重;非消费;返回同实例)+ **端到端集成** `http2-client.it.test.ts` 两条:(a) socket 腿走真实 createSession 的 TLS connect timeout 路径(`setConnectTimeoutForTests` 缩短 deadline + 黑洞 TCP server + server/client 同用 `localhost` 主机名规避 SNI 禁 IP 且地址族一致);(b) session 腿用 gated 注入工厂触发 shutdown-drain race(`closeHttp2Sessions` 期间 establish),race 分支不挂 `drop`、sink 是**唯一防线**,手动 `session.emit('error')` 断言不崩(revert getSession 的 withErrorSink 即红)。**测试载重性关键**:socket 腿因有两层(destroy 无 err + sink)只在两层都移除时红,故必须另设 sink-是-唯一防线的站点(session race 腿 / 原语单测)来独立锁 sink 载重——否则「sink 应用」这一核心价值物无回归保护(reviewer 2026-07-08)。proxy-connect 的 sink 站点仍 0 覆盖,见 `docs/todo/deferred-backlog.md`。

## 相关

同类「后台任务逃逸 reject 崩进程」主题：`fire-and-forget` 必须 never-throw（后台 backfill / 异步持久化——见 skill `history-backfill` 与记忆 methodology-sync-to-async-persistence-refactor-invariants 的 fire-and-forget-never-throw 条）；变体 A 是 pre-response-abort RFC 的缺陷⑤（reaper `ctx.fail()` 不取消在飞 fetch = 缺陷④，暂缓）。探针 harness 须复制生产接线（否则「全栈复现 0 unhandled」只证主路径安全、不证遗弃不存在），见 skill `empirical-verification`。
