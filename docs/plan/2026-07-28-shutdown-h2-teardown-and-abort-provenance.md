# 修复：优雅关机 Step 1 秒杀在途请求 + abort 归因失真

> 本版已吸收异模型 subagent（`gpt-souls:reviewer`）的对抗评审：4 HIGH + 2 MED 全部采纳，见文末「评审处置」。

## Context（为什么做这件事）

用户贴出的两行日志是一次真实 incident：

```
[WARN] 10:35:17 [Driver] No retry strategy claimed this aborted — surfacing it to the client as-is: The operation was aborted.
[FAIL] 10:35:17 POST /v1/messages claude-opus-5 602ms ■ ↑1.7MB ↑0 ↓0: The operation was aborted. req_1785234916721_3573
```

已用 History + 进程证据完成取证（非推断）：

| 证据 | 值 | 含义 |
|---|---|---|
| History `state` / `clientResponse.status` | `failed` / **504** `Upstream timed out before sending response headers` | 排除 client-abort；但被归成「header 超时」 |
| entry / attempt `durationMs` | 609ms / **539ms** | 而 `timeouts.response_header` = **900s** → 这条 504 是**谎报** |
| attempt `upstreamResponse` | `status: 0`，零帧 | 上游响应头从未到达，死在 pre-header 窗口 |
| 该 entry 在 `v3_operations` 的位置 | pid 3377713 的**最后一条**请求 | 进程随即进入关机 |
| 前一条 `req_..._3572`（早 76ms 起） | **completed，dur 7572ms** | 同刻已建流的请求活得好好的 → 不是全局 teardown |
| 新进程启动 | 晚 **201s** ≈ `gracefulWait 60` + `abortWait 120` + finalize | 确认走完整 4 步优雅关机 |
| `maxConcurrentStreamsPerSession` | **1**（`state-defaults.ts:210`） | 每条并发请求都得**新建** h2 session（TLS 握手数百 ms） |

**根因链**（三层，逐层都要治）：

1. **关机时序错**：[shutdown.ts:457](src/lib/shutdown.ts#L457) 在 **Step 1** 就调 `closeHttp2Sessions()`，它 `poolEpoch++` 并清空池；[http2-client.ts:502-509](src/lib/transport/http2-client.ts#L502-L509) / [:608](src/lib/transport/http2-client.ts#L608) 的 epoch 检查让**正在建 session 的在途请求**当场 `throw abortError()`。已建流的请求靠 `session.close()` 的 GOAWAY 语义正常 drain（req_3572 是活证，评审也用最小 Node 探针复现确认），**只有还在握手的那条被秒杀**——这与 Step 2 宣称的「等在途请求自然完成 60s」直接矛盾。对照组：上游 WS 在 Step 1 只 `stopNew()`、`closeAll()` 留到 Step 4/finalize；**h2 缺了这个拆分**，不对称本身即异味。
2. **abort 无 provenance**：[http2-client.ts:860-864](src/lib/transport/http2-client.ts#L860-L864) 的 `abortError()` **丢弃 `signal.reason`**（注释自承「dropping the AbortSignal.timeout TimeoutError identity」）；取消方 [request.ts:996-1019](src/lib/context/request.ts#L996-L1019) 手上明明有 `reason` 却 `abort()` 空手调用；[shutdown.ts:522](src/lib/shutdown.ts#L522) 的 Step 3 abort 同样不带 reason。三类中止遂共用一条字面量——这正是 skill `debugging-claude-client-connection` 那张「只能靠 durationMs 猜是谁干的」取证表存在的原因。
3. **两个边界都在无证据地猜**：pre-commit 的 [forward.ts:547-556](src/lib/error/forward.ts#L547-L556) 把「AbortError 且 client signal 未 abort」直接判成 504 header 超时；post-commit 的 [post-commit-error.ts:105-109](src/routes/messages/post-commit-error.ts#L105-L109) 只看两个 boolean，把 `request_deadline` 也说成「stale-request reaper」。本项目默认 `stream_commit_after_sec=180`，**post-commit 才是主路径**，只修 pre-commit 等于只治一半。

预期结果：关机窗口的在途请求**要么自然跑完，要么拿到诚实且可重试的 529**；任何中止的**成因随错误对象一路带到两个边界**，日志 / History / 客户端说的是同一件真事。

---

## Phase 1 — 关机时序（独立成立，先落地）

**文件**：[src/lib/shutdown.ts](src/lib/shutdown.ts)

- 删掉 Step 1（`:457`）的 `closeHttp2Sessions()`。Step 1 对 h2 **不做任何事**：新请求已被 `server.close(false)` + `getIsShuttingDown()` 中间件挡住，drain 期只剩在途请求，它们**应当**被允许建新 session（`maxConcurrentStreamsPerSession=1` 下这是常态而非边缘）。
- Step 4 强关段（`:556` `peekUpstreamWsManager()?.closeAll()` 旁）加 `closeHttp2Sessions()`——先断上游、再拆下游 writer，理由与 WS 完全相同。
- `finalize()`（`:645` 那句幂等 `closeAll()` 旁）再加一次幂等 `closeHttp2Sessions()`，覆盖 Phase 2/3 自然 drain 完、跳过 Step 4 的路径。
- 就地写注释：「Step 1 拆池 = 用 Step 1 的手撕掉 Step 2 的承诺」，防止被当冗余再挪回去。

**已核实无副作用**（评审独立复核）：全仓无任何生产逻辑或 shutdown 测试依赖「Step 1 后池为空」；已入池 session 在 `:574` `unref()`，不拖住事件循环，且 `main.ts` 显式 `process.exit(0)`；SIGUSR2 交接下旧进程多握几条 session 直到 drain 结束——那正是在途请求要用的资源。

---

## Phase 2 — abort provenance 端到端（消灭「三种中止一条字面量」）

### 2.1 取消方一律带 reason（产生点）

| 文件 | 改动 |
|---|---|
| [request.ts:996-1019](src/lib/context/request.ts#L996-L1019) | `reapInFlight()` → `abort(new DOMException("stale-request reaper", "AbortError"))`；`cancel(reason)` → `abort(new DOMException(reason, "AbortError"))`（reason 已在手上，今天被丢掉；`request_deadline` 就走这条） |
| [shutdown.ts:522](src/lib/shutdown.ts#L522) | Step 3 → `shutdownAbortController.abort(new DOMException("Server is shutting down", "AbortError"))`，使「这次中止是关机造成的」成为**可验证的对象身份**，而不是靠全局标志推断 |

顺带收益：[dispatch-scheduler.ts:342-346](src/lib/pipeline/generation/dispatch-scheduler.ts#L342-L346) 的 `abortReason()` 立刻开始记录真实原因，History 的 `dispatchReason` 从 `candidate-cancelled` 升级为真名。

### 2.2 h2 transport 不再丢弃 reason（传输层）

**文件**：[src/lib/transport/http2-client.ts](src/lib/transport/http2-client.ts)

- `abortError()` 改为 `abortError(signal?)`：`signal.reason instanceof Error` 则**原样返回该 reason**，否则退回合成 AbortError。与 [dispatch-scheduler.ts:348-350](src/lib/pipeline/generation/dispatch-scheduler.ts#L348-L350)、[admission-controller.ts:69](src/lib/transport/admission-controller.ts#L69) 既有写法一致——本文件是仓库里唯一还在丢 reason 的。
- **实施纪律**：不照抄行号清单，用 `rg -n 'abortError\(' src/lib/transport/http2-client.ts` 取全集逐个分类改（**含 `:948` 的 preflight 分支**——评审实测指出漏它会让「进入 fetch 前就已到点的 header timeout」丢掉 `TimeoutError` 身份，被 2.4 判进错误分支）。
- 池 teardown 两处（`:508` epoch 分支、`:608` acquire 循环顶）抛**自己的**错误：`name="AbortError"`（它确实是取消，handler 的 abort 分支要认）+ 明确 message + `tagTransportError(err, "pool-closed")`。
- `TransportErrorReason` 加 `"pool-closed"`：[packages/foundation/src/error/transport-reason.ts](packages/foundation/src/error/transport-reason.ts)。这会让 [classify.ts:83-101](packages/foundation/src/error/classify.ts#L83-L101) 的 `_never` 穷尽守卫**编译期逼出**新 case（返回 `type:"aborted"`；因 `isAbortError` 在其之前先命中，实际走不到——注释写清这层顺序，别让后人当死代码删）。

**前提已实证**：评审用 Bun 探针确认 `AbortSignal.any()` 把首个中止源的 reason **原样透传**（同一对象、`TimeoutError` 名称不变），所以 header-timeout 的身份能活着抵达传输层。

### 2.3 529 改写按 provenance，不按全局标志（send 层）

**文件**：[src/lib/transport/send.ts:265-281](src/lib/transport/send.ts#L265-L281)

判据从 `getShutdownSignal().aborted` 改为「**这个错误就是关机 reason 本身，或带 `pool-closed` tag**」，并加 `!clientAbortSignal?.aborted` 守卫（今天在 Step 3 与客户端断开竞态下会误判成 529，是顺带修掉的既有缺陷）。

> **不采纳**初版计划里的 `getIsShuttingDown()` 方案：评审正确指出它只能证明「进程正在关机」、不能证明「这次中止由关机触发」——drain 窗口内恰好被 reaper / `request_deadline` 取消的请求会被冒充成 529。而 Phase 1 落地后，Step 1 本就不再产生 abort，广义化的动机也随之消失。

### 2.4 pre-commit 边界：只在有证据时才说 header 超时

**文件**：[src/lib/error/forward.ts:540-561](src/lib/error/forward.ts#L540-L561)

改成**有序 precedence 表**（各臂并非互斥——关机期也可能真的 header 超时、client 断开可与关机同时发生；顺序即裁决）：

| 顺序 | 证据 | 结果 | 日志 |
|---|---|---|---|
| 1 | `c.req.raw.signal.aborted` | 499（不变） | 不变 |
| 2 | `getTransportErrorReason(error) === "pool-closed"` 或 error 是关机 reason | **529** `Server is shutting down`（可重试；与 send 层同语义，双层防御） | `[shutdown] …` |
| 3 | `error.name === "TimeoutError"`（`AbortSignal.timeout` 真开火） | 504 `Upstream timed out before sending response headers`（不变） | 保留现有 warn + 秒数 |
| 4 | reason 是 `request_deadline` | **504** + **request deadline** 原文（它被建模为 `category:"timeout"`，不是 Service Unavailable） | warn 打真实 reason |
| 5 | 其余（reaper / dispatch-cancel / 未知） | **503** + **真实 reason 原文**（internal-tool posture：全量暴露） | **不再**冒充 header 超时、不再打无关的 900s |

评审已实测：`@anthropic-ai/sdk` 0.106.0 与 CC 2.1.207 对 503/504 **都**自动重试（各 1+2 次），所以第 4/5 臂不改变客户端重试资格，改的是语义、日志与 History 的真实性。

### 2.5 post-commit 边界：同样按 provenance（本项目主路径）

**文件**：[src/routes/messages/post-commit-error.ts:97-109](src/routes/messages/post-commit-error.ts#L97-L109) + [handler-v4.ts:707-726](src/routes/messages/handler-v4.ts#L707-L726)

- `classifyPostCommitAbort(clientAborted, reaperAborted)` → 接收**真实 error**（signal state 降级为 fallback），`PostCommitAbortKind` 穷尽为：`client-abort | shutdown | header-timeout | request-deadline | reaper-cancel | dispatch-cancel`，各自产出诚实的终端 error frame 文案。
- 同步改掉 `post-commit-error.ts:13-16` 与 handler-v4 里「reason 被丢弃、只能看 signal state」的注释——Phase 2 后那已不成立。
- **不可外推**：已 commit 的 200 + SSE `event: error` **不享受** SDK 的 HTTP 5xx 自动重试（流式协议固有），2.4 的重试结论只适用于 pre-commit。

---

## 测试

**通用纪律**：每条新测试都要有**正样本对照**（把对应源码改动还原 → 确认变红 → 再改回去）。没变红说明这条绿测试证明不了任何东西（skill `positive-control-your-tests`）。

1. **Phase 1 关机时序**（`tests/shutdown/`）：gated session factory（复用 [http2-client.it.test.ts:326-360](tests/transport/http2-client.it.test.ts) 的「建连中途 bump poolEpoch」骨架）+ tracker 保持该请求 active 直到 fetch settle（否则 shutdown 会直冲 finalize，由 finalize 合法关掉测试正在建的 session，得出假结论）。裁决 oracle 依次是：① factory 已被调用（证明确实卡在建连窗口）② Step 1 已过、进入 draining ③ 放行 gate 后 **fetch 成功并读完响应** ④ finalize 后 `getH2SessionStatusSnapshot()` 为空。
   > 评审 MED-1 已指出：**snapshot 只能看已入池 session**，建连窗口里正确/错误实现的 snapshot 都可能为空——它只用于验证最终资源收敛，**不能**单独当「在途 creation 没被 abort」的 oracle。
2. **529 归因**（send 层）：错误 = 关机 reason 对象 / 带 `pool-closed` tag + client signal 未 abort → 期望 `HTTPError` 529；**对照臂**：client signal 已 abort → 原样抛出，不得变 529；**反例臂**：关机窗口内的 reaper 取消 → **不得**变 529。
3. **两个边界的分派**（`tests/infra/error.unit.test.ts` / `tests/routes/messages/error-shaping-glue.unit.test.ts`）：pre-commit 五条臂 + post-commit 六种 kind 各一例，**含阴性断言**「非 TimeoutError 的 abort 不得产出 header-timeout 文案」。
4. **reason 保真**（`tests/transport/http2-client.it.test.ts`）：既有 `/abort/i` 断言里池-teardown 两处（`:352` 附近、`:723` blocked-waiter）收紧成断言 `pool-closed` tag + 新 message；新增「**已 pre-aborted** 的 `TimeoutError` signal 传进 `http2Fetch`，抛出的 err.name 仍是 `TimeoutError`」——这条专门盯 `:948`，mutation 对照要**分别**覆盖 preflight 与 mid-wait 两个分支。
5. **History 端**：一条 reaper-cancel 与一条 `request_deadline` 走完管线，断言 `dispatchReason` / 终端 frame 文案是各自真名，而不是共用「stale-request reaper」。

## 端到端验证（真 h2，不用 hook mock）

> 评审 HIGH-4：用 `upstream-hook-mocking` 的 exchange mock 挂「延迟 3s」**会绕过 `http2-client.ts`**（不调 `next` 的 mock 直接返回合成 `UpstreamStream`，skill 正文 `:102` 明确警告），根本没有 session 可杀——旧代码上也会绿，是典型假绿。

改用二选一，**必须先在旧 Step 1 行为上红**：

- **A（首选，进程内）**：集成测试里起一条**真实本地 h2 上游**（复用 `setHttp2SessionFactoryForTests` 的 h2c 骨架），gated 住 TLS/session 建立，跑真 `gracefulShutdown`。
- **B（黑盒）**：在 `--port 41411` 起测试实例（**绝不碰 4141 主服务器**），把 GHC base URL 指向本地 h2 上游，请求在途时对**该实例 PID** 发 SIGTERM。3s 延迟 + 60s graceful wait 下**唯一可接受的结果是正常完成**（接受 529 会削弱 oracle）。用后按 PID 精确 kill，绝不 `pkill`。

跑完还要：`bun run typecheck` + `bun run lint:all`（不带 `--cache`）+ `bun run test:backend`；然后派**异模型** subagent 审合并态（prompt 显式写裁判轴 = 长远正确 + 完整，非 ROI/YAGNI）。

## 文档同步（收尾必做）

- [docs/lifecycle.md:23](docs/lifecycle.md#L23)：Step 1 清单删掉「关闭 HTTP/2 会话池」，移到 Step 4 / finalize，并写明**为什么**。
- skill `debugging-claude-client-connection` 的「事后判别 `The operation was aborted.`」一节：那张「三类中止共用同一字面量、靠 durationMs 猜」的表在 Phase 2 后**部分作废**——改成「先读 `error.name` / transport reason tag，durationMs 是 fallback」，并把本次 incident（539ms 被谎报成 900s header 超时）写成反例。
- `docs/todo/deferred-backlog.md` 登记两条同类审计项（本次不改）：① Step 1 的 `stopRefresh()` 与 `peekUpstreamWsManager()?.stopNew()` 是否同样饿死 drain 期在途请求 ② driver 的 `No retry strategy claimed this <type>` 对 `aborted` 属噪声（该 warn 本职是抓 400 matcher 漂移），是否该按 type 分级。

## 提交切分（细粒度、显式 pathspec）

1. `fix(shutdown): stop tearing down the h2 pool before the drain phases`
2. `refactor(lifecycle): abort with a named reason at every cancellation source`
3. `refactor(transport): preserve abort reasons through the h2 client`
4. `fix(error): classify aborts by provenance at both client boundaries`
5. `docs: correct the shutdown step-1 h2 teardown and the abort-forensics table`

仓库内有并发 peer 会话在改动（`docs/memory/`、`src/lib/*/tool-name-sanitize.ts` 等已 dirty）——全程 `git add/commit -- <精确路径>`，绝不 `-A`。

## 评审处置

| 编号 | 结论 | 处置 |
|---|---|---|
| HIGH-1 `getIsShuttingDown()` 不能证明因果 | 采纳 | 2.3 改为按 reason 身份 / `pool-closed` tag 判定；Step 3 abort 带具名 reason（2.1） |
| HIGH-2 漏了 `:948` 调用点 | 采纳 | 2.2 改为 grep 取全集 + 点名 `:948`；测试 4 增 pre-aborted `TimeoutError` 臂 |
| HIGH-3 post-commit 仍撒谎 | 采纳 | 新增 2.5（本项目 delayed-commit 是主路径，只修 pre-commit 是只治一半） |
| HIGH-4 hook mock 绕过 h2 | 采纳 | 端到端验证改真 h2 上游，并要求旧代码上先红 |
| MED-1 snapshot 不是合格 oracle | 采纳 | 测试 1 改用四步 oracle，snapshot 只验最终收敛 |
| MED-2 precedence 非互斥 / deadline 语义 | 采纳 | 2.4 改称有序 precedence，`request_deadline` → 504 而非 503 |

**评审独立核实成立的 8 条**（不再复议）：`closeHttp2Sessions()` 生产唯一调用方是 Step 1；`session.close()` 对已建流确为 graceful（Node 探针）；`maxConcurrentStreamsPerSession=1` 确使并发请求各占一条 session（既有测试 `:449-480`）；移走 pool close 无依赖破坏；进程仍能正常退出；SIGUSR2 无额外障碍；`AbortSignal.any()` reason 透传（Bun 探针）；503/504 在 SDK 与 CC 中都重试（实测）。
