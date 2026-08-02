# 修复：优雅关机 Step 1 秒杀在途请求 + abort 归因失真

> **实施状态：✅ 已完整落地（2026-07-28）。** 计划正文保持定稿时原样（含当时的行号），后续以代码、[docs/DESIGN.md](../DESIGN.md)、[docs/API.md](../API.md) 与 [docs/lifecycle.md](../lifecycle.md) 为准。
>
> **范围远超原计划**：原计划只有 Phase 1（关机时序）+ Phase 2（abort provenance）。实际经**八轮**异模型对抗评审（`gpt-souls:reviewer`，同一实例逐轮 `SendMessage` 复审），
> 每轮的发现都不是新范围，而是同一目标在我漏掉的格子上：计划轮 4H+2M → 合并态 3H+2M → 1H+2M → 1H+2M+1L → 2M+1L → 1H+2M+1L → 2M+1L → **收口 0 BLOCKER/HIGH/MED**。
> 每轮处置见文末对应小节；累计交付还包括跨阶段 wire 类型统一（第四轮）、`abort_provenance_gaps_total` 可观测（第六轮起）与其单一漏斗定位（第七轮）。
>
> **这份计划最该被后人读的部分不是正文，是文末各轮记录**——它们记着每一次「我以为修完了」是怎么被证伪的。

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

---

## 实施记录（2026-07-28）

**与计划的偏差（都是实施期发现的更正确形状，非缩水）**：

1. **`isShutdownCausedAbort` 取代了计划里的两个分散判据**。Step 3 现在 `abort(new DOMException("Server is shutting down","AbortError"))`，该谓词按**对象身份**（沿 `cause` 链）+ `pool-closed` tag 回答「这次中止是不是关机造成的」。同时 `send.ts` 的 529 门多了一路探针：`fetchSignal.reason`——若某个 transport 仍然合成新错误而丢掉 reason，组合信号自己的 reason 仍能给出正确归因（`AbortSignal.any` 取首个中止源的 reason，故不会把 reaper 误判成 shutdown）。
2. **新增 `packages/foundation/src/error/cancellation-reason.ts`**（计划未预见）：与既有 `transport-reason.ts` 同构的 Symbol-tag 机制，承载 `stale-reaper` / `request-deadline` / `request-cancel` / `dispatch-cancel` 四个取消来源。`REQUEST_DEADLINE_CANCEL_REASON` 常量同时被 `manager.ts` 与 `request.ts` 引用，避免魔法字符串两处漂移。
3. **`PostCommitAbortKind` 是七种不是六种**：计划漏了 `request-cancel`。把它折进 `reaper-cancel` 就是本次要修的那种撒谎，故单列。
4. **`request_deadline` 在 pre-commit 边界给 504（不是计划初版的 503）**——它被 `manager.ts` 建模为 `category:"timeout"`，503 会丢掉这个语义（评审 MED-2）。

**测试与正样本对照（4 组 mutation，全部实测先红后绿）**：

| 锁住的行为 | 测试 | mutation（还原旧行为后必须变红） |
|---|---|---|
| Step 1 不拆池、在途建连能 drain 完 | `tests/shutdown/shutdown-h2-pool-drain.it.test.ts` | Step 1 加回 `closeHttp2Sessions()` → 红（`settled` 在 Step 1 后已是 `rejected`） |
| preflight 分支保留 `TimeoutError` 身份 | `http2-client.it.test.ts`「PRE-ABORTED TimeoutError」 | `runHttp2Fetch` 首行改回 `abortError()` → 红 |
| mid-wait 分支保留 reason 对象 | `http2-client.it.test.ts`「MID-WAIT abort」 | `onPreResponseAbort` 改回 `abortError()` → 红 |
| 529 门是**因果**判据不是时间判据 | `http-transport.it.test.ts`「REAPER cancelled it: NOT 529」 | 门换成 `getIsShuttingDown()`（计划初版方案）→ 红 |

其余覆盖：`tests/infra/error.unit.test.ts` 五条 precedence 臂（含「非 TimeoutError 的 abort 不得产出 header-timeout 文案」阴性断言）、`post-commit-error.unit.test.ts` 的 provenance 组 + 每种 kind 的 frame 文案、`model-operation-bypass.http.test.ts` 走完整 HTTP 路径的 503/504 两臂。

**门禁**：`bun run typecheck` 绿、改动文件 eslint 干净（`src/lib/context/request.ts` 余 2 条 `perfectionist/sort-imports` 经核实在 HEAD 即存在，未扫入本次改动）、`bun run test:backend` **6590 pass / 0 fail**。

**端到端真 h2 验证**：计划里的「黑盒 41411 实例 + SIGTERM」未单独执行——方案 A（进程内真 h2c 上游 + 真 `gracefulShutdown`）已经覆盖同一因果链，且它带正样本对照（黑盒臂没有）。这不是省略验证，是用更强的那一个替掉了更弱的那一个；若将来要复现完整信号路径（真 SIGTERM handler → 真 supervisor 重启），黑盒臂仍然值得补。

## 合并态复审后的第二轮修复（2026-07-28）

异模型 subagent 对合并态做了带实测探针的复核，提了 3 HIGH + 2 MED，**全部采纳并修掉**——它们不是新范围，而是同一目标（「任何中止的成因随错误对象一路带到边界」）在我第一轮漏掉的路径上：

| 编号 | 缺口 | 修法 |
|---|---|---|
| HIGH-1 | `guardSseIterable` 对 `ctx.lifecycleSignal` 一律抛 `StreamReaperCancelError`——**post-header 的 `request_deadline` 在所有流式端点上被说成 stale reaper**，pre-header 修好了 post-header 照旧撒谎 | 按 reason 的 cause tag 分派；`StreamErrorKind` 加 `request-deadline`/`request-cancel`（类型系统逼出 4 个 codec 的 5 处穷尽 Record）；deadline 在 Anthropic/OpenAI 映射 `timeout_error`、Gemini `DEADLINE_EXCEEDED`；**untagged 仍默认 reaper**（那正是裸 lifecycle abort 一直以来的含义，不静默改标） |
| HIGH-2 | Responses 上游 WS 在握手/请求取消/first-event 超时三处重建 Error，tag、shutdown 身份、`TimeoutError` 全丢 | 握手与请求取消**保留该层 message + 把 reason 挂 `cause`**（两个读取器都走 cause 链，既留 provenance 又留「死在哪一层」的信息，既有测试的 message 断言也仍然成立）；first-event 看门狗透传 `TimeoutError`；`requestAbort` 转发各源 reason |
| HIGH-3 | post-commit 对**无任何证据**的 abort 仍默认 `header-timeout`，而 pre-commit 已经拒绝猜——我甚至写了条测试把这个旧兜底锁成绿 | 新增 `unknown-abort` kind；删掉那条锁旧行为的断言，改成阴性断言 |
| MED-1 | legacy `anthropic/client.ts` 仍用 `getShutdownSignal().aborted` 时间判据（与 `send.ts` 刚修好的因果判据两套语义） | 同样收紧成 `isShutdownCausedAbort` + 调用方 signal reason 兜底 |
| MED-2 | 文档把「h2 pre-header 修好」外推成「所有路径都已携带 provenance」 | skill 补 post-header / WS 两段，说明各自的适用范围 |

**正样本对照**：把 `request-deadline` 分支改回 `StreamReaperCancelError` → 新测试 `the hard deadline on the lifecycle signal is NOT reported as a reaper cancel` 变红；改回即绿。

**门禁**：typecheck 绿、改动文件 eslint 干净（`openai-responses/codec.ts:61` 的 import 格式错经 `git diff` 核实为既有、不在本次改动行内）、`test:backend` **6592 pass / 0 fail**。

**复审已核实成立、无需改动的 9 条**（不复议）：Phase 1 的 teardown 移位与其 mutation 有效性、h2 pre-header reason 保真、undici 路径本就保留 reason（探针 `same:true`）、pre-commit precedence 顺序、`isShutdownCausedAbort` 在 `_resetShutdownState` 后不跨测试串、`fetchSignal.reason` 兜底探针不会把 reaper 误判成 shutdown、Phase 1 无资源/生命周期泄漏、`docs/lifecycle.md` 与实现一致、测试整体非自证。

## 第三轮复审后的修复（2026-07-28）

同一异模型 reviewer 复核了第二轮的修复本身，提 1 HIGH + 2 MED，**全部采纳并修掉**。这一轮的教训比修复本身更重要：

**HIGH——「landed 的映射」根本没接到活路径上。** 第二轮给四个 codec 的穷尽 `Record` 加了 `request-deadline` 条目，类型系统逼出了每一处、测试全绿、我据此报告「deadline 在 Anthropic 映射 `timeout_error`、Gemini `DEADLINE_EXCEEDED`」。实测下来 **codec 的 `formatError` 没有任何生产调用者**：Anthropic 活路径走 `error-shaping.ts:classifyStreamErrorType`（3-case switch，deadline 落 default `api_error`），Gemini 走 `handler-v4.ts` 里的私有 `geminiStreamErrorStatus`（deadline 落 default `INTERNAL`）。OpenAI 那条腿之所以是对的，纯粹因为它的映射早就抽成了共享的 `streamErrorKindToOpenAIErrorType`，codec 与 handler 调的是同一个函数。

分歧比「少一个条目」更宽——两份映射连 `reaper-cancel` 都不一致（codec 给 `overloaded_error`/`UNAVAILABLE`，活路径给 `api_error`/`INTERNAL`）。

修法不是把值抄一遍，是**消灭双份**，按仓库里已被证明不会漂移的 OpenAI 形状收敛：

| 表 | 位置 | 谁在用 |
|---|---|---|
| 消息文案 | `packages/foundation/src/stream.ts:STREAM_ERROR_KIND_MESSAGES` | 4 个 codec（此前是 4 份逐字重复的私有副本） |
| Anthropic `error.type` | `src/lib/anthropic/error-shaping.ts:ANTHROPIC_STREAM_ERROR_TYPE` | 活 handler（经 `classifyStreamErrorType` 薄包装）+ codec |
| Gemini `{code,status}` | `src/lib/gemini/stream-error.ts`（新建，镜像 `~/lib/openai/stream-error`） | 活 handler 4 处 + codec |
| OpenAI `error.type` | `src/lib/openai/stream-error.ts:OPENAI_STREAM_ERROR_TYPE` | 活 handler + codec（本就共享，改成穷尽 Record） |

从 8+ 处重复降到 4 张穷尽表。顺带修掉的名实分裂：Gemini 的 `error.code` 此前是 `shutdown ? 503 : 500` 独立硬编码，会配出 `status:"DEADLINE_EXCEEDED"` + `code:500`；现在 code 由 status 经**规范 gRPC↔HTTP 表**推导，两个字段不可能再打架。

**分组判据（三协议一致）**：凡是**我方跑完的时钟**都报 timeout——frame-idle 看门狗、hard deadline、以及 stale-request reaper（`stale_request_max_age` 到期本质就是 deadline）。`shutdown` 是唯一真正「立刻重试」的条件。取消类在有对应字面量的协议（Gemini `CANCELLED`）用它、没有的（Anthropic）诚实退化到通用桶而非借一个不相干的。

**MED-1——untagged lifecycle abort 不再冒充 reaper。** 第二轮我把它保留成 reaper 并写了理由「那是裸 lifecycle abort 一直以来的含义」。该理由已经失效：仓库里每个 producer 现在都打 tag，所以 untagged 只意味着**某个 producer 漏了契约**，答「reaper」等于把接线缺口重新藏起来——恰好违背同一轮新增 `unknown-abort` 的目的。新增 `StreamUnknownCancelError` / kind `unknown-cancel`（与 post-commit 的 `unknown-abort` 刻意不同名：这里我们**知道**是 lifecycle cancel，只是不知道是哪个）。

连带发现：两个 transport 测试用**裸 `reaper.abort()`** 模拟 reaper——在模拟一个 producer 却不走它的契约。改成用真实的 `cancellationAbortError("stale-reaper", ...)`，既忠实又真的证明了接线。

**MED-2——WS 与 legacy 的修复此前只有临时探针、没有回归测试。** 已固化。

**测试与正样本对照（新增 3 组 mutation，全部实测先红后绿）**：

| 锁住的行为 | 测试 | mutation |
|---|---|---|
| 三协议活路径**确实在读**共享表 | `tests/streaming/stream-error-wire-provenance.http.test.ts`（新文件，3 test）——从 `ctx.cancel(request_deadline)` 驱动到真实客户端字节 | 三张共享表各改坏一个条目 → **3/3 变红** |
| WS 保留 message + 挂 cause | `upstream-ws-connection.unit.test.ts` +2（握手、已发请求） | 去掉 `{ cause: ... }` → 2/2 变红 |
| legacy 529 门是因果不是时间 | `anthropic-client.it.test.ts` +4（正向 2 + 阴性 2） | 门换回 `getShutdownSignal().aborted` → **恰好两条阴性臂变红、正向臂仍绿**（时间门的谎报特征） |

新测试刻意同时断言「现在必须是什么」与「以前是什么、不许再出现」——只锁正向值的话，退回私有副本仍然可能全绿。

**门禁**：typecheck 绿、改动文件 eslint 干净（`openai-responses/codec.ts:61` 两条 import 格式错经 `eslint --stdin` 对 HEAD 版本核实为既有）、`test:backend` **6605 pass / 0 fail**（含上一轮那条 `multiprocess-rotation` perf flaky，本轮全绿）。

## 第四轮复审后的修复（2026-07-28）

第三轮的 HIGH 是同一个根模式挪了一格：我把 post-header 那格的双份映射消灭了，**没对账 delayed-commit pre-header 那格**。

**HIGH——同一个 cause，三格三个答案。** Anthropic 的默认路径是 delayed-commit：已经 commit 200 SSE，上游却仍在 pre-header 静默。这时的取消由 `postCommitAbortFrame()` 交付，而它对所有 kind 硬编码 `api_error`。于是同一条 hard deadline：

| cause | pre-commit HTTP | 已 commit、上游 pre-header | 上游 post-header |
|---|---|---|---|
| `request-deadline` | 504 | `api_error` | `timeout_error` |
| `stale-reaper` | **503** | `api_error` | `timeout_error` |
| shutdown | 529 | `api_error` | `overloaded_error` |

答案取决于「上游响应头到没到」——那不是关于「什么结束了这个请求」的事实。

修法：把 Anthropic 表的键从 `StreamErrorKind` 扩到 `AnthropicErrorCauseKind = StreamErrorKind | "header-timeout" | "unknown-abort"`。`PostCommitAbortKind` 的每个成员都落在这个词汇表里，所以两套 taxonomy 共用**同一张表**而不是各自维护。pre-commit 那格的 `stale-reaper` 也从 503 兜底臂提到自己的 504 臂——reaper 既已正式归入 timeout（`stale_request_max_age` 到期本质是 deadline，配置里甚至带着改名为 `upstream_request_deadline` 的 TODO），就不该只在最后一格是 timeout。

两条被打到的既有断言都是锁旧不一致行为的，已诚实更新：`postCommitAbortFrame` 的「每种 kind 都是 `api_error`」改成**对照共享表**断言（重复字面量的话，未来的本地硬编码还能溜回来）+ 分组抽查；`forwardError` 的 reaper 503 改 504，并补一条「dispatch teardown 仍是 503」证明不是把所有取消一股脑提级。

**MED-1（两条 WS 跨层空档）**——补齐了，其中一条**第一版写错了**：我用一个 `readyState=1` 但从不派发 `open` 的 socket，结果测试卡在**握手**超时、根本没走到 first-event 看门狗，mutation 打上去毫无反应。探针打出 cause 链才看清（`Upstream WebSocket connection aborted` ← `TimeoutError`，是 connect 那条）。修正为让握手先成功，并把断言收紧到「顶层必须是 **request** wrapper」——这才是「走到了看门狗」的证据。这条正是「新写的 oracle『一定咬得住』只是推理不是实验」。

**MED-2（`codec.formatError` 是死契约）**——核实属实：全仓零生产调用，且 finalize-stream 重设计**已裁决不要这样接线**（WS 表达不成 `ClientFrame`、codec 拿不到 raw message）。`docs/v4/01-architecture.md` 的 S7 行却仍写 `codec.formatError`，与 `docs/DESIGN.md` 自相矛盾——**文档撒谎的部分当场改掉**。删除本身**没做**：项目纪律禁止以「无消费者」为名擅自删接口契约，且这是需要用户拍板的契约变更，已按四段式完整记入 [docs/todo/deferred-backlog.md](../todo/deferred-backlog.md)（含删除清单与「删之前必须先确认什么」）。

**关于 reaper→timeout 的裁决**：复审独立查了 shipped config 与 schema，确认 `stale_request_max_age` 的语义就是「上游单次尝试最大存活秒数」，判定分组站得住；并核实文案（「stale-request reaper」）与 type（`timeout_error`）不矛盾——前者是精确触发器、后者是宽类别，保留 reaper 名字反而提高运维可观察性。也确认我改的那条既有断言不是为了让测试变绿而扭曲判据。

**新增 mutation（4 组，全部先红后绿）**：`postCommitAbortFrame` 改回硬编码 `api_error` → delayed-commit 那条红；删掉 `responses-transport` 取消门的 lifecycle 臂 → pre-first-event 那条红；看门狗改回合成通用 error → TimeoutError 身份那条红（**修正测试之前不红**）；共享表条目改坏 → 三协议 wire 测试红。

**门禁**：typecheck 绿、改动文件 eslint 干净、`test:backend` **6610 pass / 0 fail**。

## 第五轮复审后的修复（2026-07-28）—— 0 BLOCKER / 0 HIGH

第四轮复审确认上一轮的 HIGH 已闭合（Anthropic 三格现共用同一张表；pre-commit reaper 提 504 是定向修正、dispatch 仍 503；两条 WS 接缝测试真实载重，独立探针复现了 `open → send → close` 全序列，证明修正后确实走的是 first-event 看门狗而非握手）。剩 2 MED + 1 LOW，全部处理：

**MED-1（unknown 是线索，但没人在看）**——两类 unknown 都退化成协议通用桶（`api_error` / `server_error` / `INTERNAL`），在 `/metrics` 上与任何别的 generic failure 无从区分，只能靠人工打开单条 History 才发现。新增 `abort_provenance_gaps_total{phase,surface}`（`src/lib/observability/abort-provenance-gaps.ts`，与 `retry-giveups.ts` 同构）。**任何非零值都是行动项**，不是可以看趋势的健康指标。

接线位置换过一次，值得记：我最初把它放在**三个协议 mapper 的 error-in 包装**里（"boundary observation point"），lint 当场否决——`no-restricted-imports` 规定 `src/lib/{anthropic,openai,gemini}/**` 不得 import `~/lib/observability/*`（RFC observability-rewrite §2.2）。**规则是对的**：一个「把 kind 映射成字符串」的函数是放副作用的怪地方，而且 codec 也调它。改到 `dispatch-lifecycle` 的 catch —— 两个 transport 的每条被 guard 的流都恰好经过它一次，是真正的单一漏斗；transport 把 `env.clientFormat` 传下来，surface 标签因而准确。**没有**逐个插桩那 18 个塑形 error frame 的 route 站点：漏掉一个就让「零」读作「没有 gap」，比没有这个指标更糟。

**MED-2（backlog 措辞失真）**——我原写「那 4 处 `codec.formatError` 测试是共享表在 codec 侧的唯一覆盖，删之前须确认新测试覆盖同样判据」。复审核实**只对一半**：它们是「codec 这个方法」的唯一调用测试，但共享表本身已由 `error-shaping.unit.test.ts`（逐 kind 全 taxonomy）、`post-commit-error.unit.test.ts`（对照共享表）和三协议真实 wire 测试覆盖；反过来它们自己也不完整（只测 Anthropic 4 种 + CC 3 种，Gemini 与 Responses 根本没测）。已改正，并写明真正要保留的是共享 mapper 全 taxonomy 单测 + production wire oracle。

**LOW（post-commit 的 untagged 仍冒充 reaper）**——`classifyPostCommitAbort` 收的是 `reaperAborted: boolean`，于是任何触发的 lifecycle signal + 未打标错误都答 `reaper-cancel`，正是 `guardSseIterable` 已经放弃的那套理论。改成收 **signal**，顺带解锁一条新臂：真实 transport（h2/undici）会合成自己的 AbortError 而不透传 `signal.reason`，从 signal 上读 tag 能救回被错误对象丢掉的成因——布尔值早就把唯一能回答的东西扔了。全无 tag → `unknown-abort`。类型系统逼出了全部 9 处测试站点。

**新增 mutation（2 组，先红后绿）**：摘掉 dispatch-lifecycle 里那唯一的记录点 → 计数测试变红；`postCommitAbortFrame` 改回硬编码（上一轮）仍红。

**门禁**：typecheck 绿、改动文件 eslint 干净（`handler-v4.ts` 余 4 条经 `eslint --stdin` 对 HEAD 版核实为既有）、`test:backend` **6616 pass / 0 fail**。

## 第六轮复审后的修复（2026-07-28）

第五轮复审用探针证实了我自己在派单时点名最不确定的那处：**Responses upstream WebSocket 成功腿绕过 `dispatch-lifecycle` 漏斗**——它返回自己构造的 lifecycle、frames 从未经过 `ownFrames()`。探针给的是确定性假零（`{"unknown":true,"counts":[]}`），不是推断。

**这是 gap 检测器最坏的失效形态**：功能正确、outcome 正确、所有测试绿，只有计数静默漏报，于是「零」被读成「没有 gap」。比没有这个指标更糟。

**修法**：漏斗上移到 driver。`streamErrorOutcome()` 成为**唯一**产出 `stream-error` outcome 的地方（8 处裸字面量全部改走它），计数在路过时打，surface 取自 `env.clientFormat`——每个 transport 的 frames 都由 driver 消费，这才是诚实的漏斗。加 `tests/architecture` 守卫拒绝裸 `{ kind: "stream-error" }` 字面量（正样本对照验过会红）：绕过是**不可见**的，outcome 照样对、只有计数少。

**测试形态也一并纠正**（这是假零能溜过去的直接原因）：原测试直接调 `createDispatchLifecycle()` 并手工喂四个 surface，只证明了「**如果**漏斗被调用，标签是对的」，看不到「某条 transport 根本不经过漏斗」。现在全部走真实 app（真 driver + 真 transport + 真 client surface）。untagged lifecycle abort 在生产里已无产生者（正是本意），故由上游 body 直接抛出那个「漏了契约的 producer 本会造成」的 `StreamUnknownCancelError`——同一个对象、同一条 driver 路径。

**MED（pre-commit surface 固定 unknown）**——`c.req.path` 本来就知道协议，记 `unknown` 等于把已有信息扔掉、让排查还得回去翻单条 History。新增 `gapSurfaceForPath()`，**刻意比 `server.ts:detectErrorWireFormat` 更细**：后者把 CC 与 Responses 合并成 `openai`，而这两条是分开的腿（其一还是 WebSocket），一条腿的 gap 不能算到另一条头上。10 行路径表测（含 Azure alias 与未知路径）。

**LOW（`/metrics` 零值注释不准确）**——采纳。只有 HELP/TYPE 没有 sample 是**合法**的，但它不创建可查询序列：PromQL 返回空向量，`absent()` 分不清「零 gap」与「旧版本 / 接线坏了 / 没被 scrape」。注释改成诚实说法，并写上真正可用的告警式 `sum(increase(...[5m])) > 0` + 独立的 target health 守卫。

**门禁**：typecheck 绿、改动文件 eslint 干净、`test:backend` **6629 pass / 0 fail**。

## 第七轮复审后的修复（2026-07-28）—— 0 BLOCKER / 0 HIGH

第六轮复审确认漏斗上移成立：driver 确实是 HTTP、upstream WS、**下游 `/responses` WS**（它调 `runResponseBufferedSink`/`runResponseSink`，同样经过 helper）与 buffered/hedged 各分支共同经过的唯一 outcome 产出点；全仓再无别处 mint `stream-error`；helper 自伤（正则把它自己的 return 也换掉、造成无限递归）已修且 8 处传参正确。剩 2 MED + 1 LOW，全部处理：

**MED（阳性测试只覆盖 HTTP，没覆盖本轮修复目标）**——一针见血：**本轮修的就是 upstream WS 那条腿，却没有一条测试驱动它**，正确性靠代码追踪，而「靠追踪不靠运行」正是这个 bug 当初混进来的方式。已补真实 app 驱动的 upstream-WS 用例。

踩到一个 fixture 陷阱值得记：我的 fake 只 yield `{ type: "response.created" }`，缺 `response` 对象 → **累加器先抛 `undefined is not an object`**，测试于是观察到一个与它要测的东西无关的错误、计数当然为空。是探针打出 body 才看清（`TRANSPORTS: ["upstream-ws"×4]` 说明腿走对了、错在帧形状）。教训与本轮那条「mutation 不红有两解」同源：**绿/红都要先确认执行到了目标分支**。

**MED（delayed-commit 那格没断言计数）**——补齐，含 tagged 阴性。它的记录点是唯一活在 handler 而非 driver 的一处，别的测试都够不着。新增 test-only seam `ctx.abortLifecycleUntaggedForTests()`：untagged lifecycle abort 在生产已无产生者（正是本意），只能**故意扮演漏了契约的 producer**；测试若改为自建裸 controller，则证明不了「我们的 ctx」的行为。

**LOW（守卫是逐行 regex、可绕过）**——采纳，改为遍历 `src/**` 全部文件的 **AST 扫描**。写的过程中它自己暴露了第二个盲点：helper 的 return 是 `"stream-error" as const`，`isStringLiteralLike` 直接看不见 → 统计到 **0 个字面量**，也就是说这个守卫**同样会放过写成 `as const` 的绕过**。是那条「helper 必须恰好 mint 一次」的正样本对照把它抓出来的；现已解包 `as` / 括号 / `satisfies`。两种绕过形态（单行、跨行+`as const`）都实测变红，后者正是 regex 版漏掉的。

**门禁**：typecheck 绿、改动文件 eslint 干净（`context/types.ts` 与 `handler-v4.ts` 的既有 lint 错经 `eslint --stdin` 对 HEAD 核实）、`test:backend` **6632 pass / 0 fail**。

### 三阶段 × 传输 的计数覆盖矩阵（当前状态）

| 格 | 真实驱动的阳性 | 阴性对照 | mutation 验过 |
|---|---|---|---|
| pre-commit | ✅ 真实 `forwardError` | ✅ tagged deadline | ✅ |
| delayed-commit | ✅ 真实 app | ✅ tagged deadline | ✅ |
| post-header · HTTP | ✅ 真实 app（CC + Anthropic） | ✅ tagged deadline | ✅ |
| post-header · upstream WS | ✅ 真实 app | （与 HTTP 共用 driver 分支） | ✅ |
| post-header · 下游 WS | ✅ 真实 WS server | ✅ tagged truncation | ✅ |

（第八轮补齐最后一格。）

## 第八轮复审后的修复（2026-07-28）—— 收口

第七轮确认两条测试缺口已补且真的进入目标路径（upstream WS fixture 修正后栈显示 `streamWsEvents → guard → response processor → driver`，不是 accumulator shape error 也不是 pre-first-event fallback）。剩 2 MED + 1 LOW，全部处理：

**MED（守卫声称的能力强于实际）**——复审用探针实测：computed `["kind"]`、指向同文件 const 的 identifier、shorthand `{ kind }` **三种都能大摇大摆走过去**。已全部支持（外加 string-literal 属性名），四种绕过形态逐一 mutation 变红。

更重要的是措辞：**一个「宣称的覆盖面 > 实际覆盖面」的守卫本身就是一种假绿**——它诱使人说「机器会查的」，而这正是造出假零的那个信念。注释现在既列出抓得住什么，也**点名**抓不住什么（跨模块 import 的值、函数返回值）；根治要么写常量求值器、要么给 stream-error variant 加只有 helper 能造的 brand，已记 backlog。

**MED（下游 `/responses` WS 那格）**——采纳「现在就补，别继续留白」。理由复审说得对：这个计数器**已经连续两次**「代码追踪认为对、测试矩阵缺格」，而下游 WS 还独有 `makeDeliveryWsSink`、`sendErrorAndClose`+1011、buffered/live 分支——HTTP 测试代表不了它。新测试一次断言整条终止序列（客户端 error 帧 + 1011 + history failed + 计数），外加 tagged 阴性；mutation 精确红。

**LOW（test-only seam 放在生产公开接口）**——采纳。`RequestContext` 上的 test-only mutator 是所有生产消费者在类型层可调用的、要永久在接口文档里解释一个「不该在生产发生」的操作、且绑死未来任何实现。改为 WeakMap 支撑的导出 helper：行为不变（仍 abort 真实 `lifecycleAbort`，这正是它有牙的原因），生产表面保持干净。在 resetters 守卫里显式豁免并写明理由（per-request mutator，无 module-global 状态可 reset）。

**门禁**：typecheck 绿、改动文件 eslint 干净、`test:backend` **6634 pass / 0 fail**。覆盖矩阵五格全绿。
