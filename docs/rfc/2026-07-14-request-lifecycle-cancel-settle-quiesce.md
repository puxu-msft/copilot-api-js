# RFC: 请求生命周期 cancel / settle / quiesce 三态分离与统一取消信号

- 状态: **草案 v3(4 轮独立 GPT 对抗复核;v3 据轮 4 新 blocker 修:有界 cancellation grace(不 quiesce 的 operation 仍能 settle、reaper 强制 settle)、keyed finalization coordinator、root 不自 join、第六类逃逸点+global operation scope、§4 同步 v2 架构 —— 待第 5 轮确认收敛 → 计划)**
- 日期: 2026-07-14
- 关联: [docs/shutdown.md](../shutdown.md)、[docs/streaming.md](../streaming.md)、[docs/timeout-attribution-audit.md](../timeout-attribution-audit.md)、[docs/request-pipeline.md](../request-pipeline.md)
- 取代/影响: `docs/shutdown.md` §Stale Request Reaper 与 §Shutdown 信号、`docs/DESIGN.md` 活的架构现状(超时相关行)

## 1. 问题陈述(带 file:line 证据 + 证实状态)

用户观测:一条 `POST /v1/messages`(gpt)耗时 **2800.9s**,远超所有配置超时(用户 config: `stale_request_max_age:1200` / `stream_idle:300`(gpt-5.5 override 600) / `response_header:600`)。经 History 取证(4141 只读探针)+ 服务器日志 + GPT 异模型对抗复核,定位到**多根因、跨模块**的架构病:**settle(记录终态)、cancel(真正停底层工作)、quiesce(底层异步退出)三者被混为一谈**,且取消信号覆盖在 (reaper × client × shutdown × deadline) ×(pre-header fetch / stream body / 退避 delay / 限流 sleep)矩阵上**不一致**;优雅退出 drain 等的是"未 settle 的 context",而非"未静止的 operation"。

### 1.1 根因清单(逐条标注证实状态)

| ID | 根因 | 状态 | 证据(file:line) |
|---|---|---|---|
| RC1 | streaming 请求 pre-response fetch **故意排除** shutdown signal → Phase 3 abort 够不着延迟提交期卡在 pre-response 的流式请求 → 挂到 Phase 4 强关 | **证实** | `src/lib/transport/send.ts:113`(`stream ? undefined : getShutdownSignal()`)+ `src/routes/messages/handler-v4.ts:434`(commit 后 `transition("streaming")` 但底层 `await p` 仍 pre-response)+ 日志 2026-07-12 19:13:00→19:15:00 Phase3 abort 后仍 active 120s→Phase4 |
| RC2 | reaper timer 曾发生 ≥198s 的**有效调度延迟**(1398s vs 1200s),**具体机制未坐实**。候选:①config 热重载改 `staleRequestMaxAge` 但 reaper cadence 冻结不重建;②**进程/WSL2 suspend**——本机运行于 WSL2,suspend/resume 会让**所有** timer 一起冻结(比单纯 event-loop 阻塞更可能,两份 GPT 复核之一独立提出);③同步 HistorySink persist / SQLite / codec 重活累计阻塞事件循环(待验证)。**已证伪**:"退避 `delay()` 饿死 timer"(与 JS timer 语义相反,实测 setInterval 照常触发) | **强候选(机制未坐实)** | `src/lib/context/manager.ts:213-217`(interval 启动时算)+ `:187`(阈值 live 读)+ `src/lib/config/config.ts:857`(reload 只 setTimeoutConfig 不重调度)+ 日志: req 09:32:39 越过 1200s,09:35:05 `Reloaded config.yaml`,09:35:57 才 reap(age 1398s);WSL2 环境见 platform `microsoft-standard-WSL2` |
| RC3 | 退避 `delay()` **不接任何 signal**,且重试循环在 sleep 后/下个 attempt 前**不检查** `ctx.settled` → reaper/shutdown 已 settle 后底层仍 sleep、甚至起新 attempt | **证实** | `src/lib/pipeline/driver.ts:476-479`(`await delay(action.waitMs)`)+ `:1053-1055`(`delay`=裸 setTimeout)+ 循环无 settled gate |
| RC4 | 限流 `rejectQueued()` 与在飞 `processQueue()` 竞争:`request` 已取到局部变量后,rejectQueued reject 调用方,但 processQueue 随后仍 `request.execute()` → 调用方已拿到"shutting down"却仍执行 upstream 工作 | **证实** | `src/lib/adaptive-rate-limiter.ts:442-535` |

### 1.2 被复核推翻的错误假设(诚实记录)

- **"事件循环饥饿导致 reaper 迟到"被证伪**:实测 `await delay()` 期间 `setInterval` 正常触发(GPT reviewer 独立复现)。RC2 的真机制是热重载 cadence 冻结,非 event-loop starvation。
- **"1200-1201s 大簇"证据不足**:当前 `history.db` 只 11 条 stale-reaper failure、900s 桶为 902–956s,无法复核该聚集,**撤回**。
- **"orphan(ctx 没了但工作还在)是 07-12 挂起主因"不准确**:07-12 日志显示 context 全程 **active 未 settle**、Phase 3 abort 无效——是 RC1(未 settle 的不可中断),非 orphan。orphan 拓扑(RC3/RC4)确实存在但属另一类。

### 1.3 doc-vs-code 矛盾(RFC 须修正)

`docs/shutdown.md:29` 承诺"每个在途流式请求 / 上游 fetch 在发起时就把 shutdown 信号注册进自己的 abort race"——被 `send.ts:113` 对 streaming pre-response fetch 的**排除**证伪。该承诺对**延迟提交窗口的 pre-header 阶段是 aspirational/不成立**的。

## 2. 当前状态分析

### 2.1 超时参数覆盖矩阵(现状)

三轴不对称是理解缺口的关键:

- **轴 1 idle vs total**:除 `stale_request_max_age`(reaper,墙钟总量)外,**所有**超时都是 idle 型(response_header 到首字节、stream_idle 帧间、upstream_h2_ping/keepalive 周期)。→ 只要上游持续吐帧或反复重试,总时长唯一天花板是 reaper。
- **轴 2 上游 vs 下游**:下游保活(stream_keepalive_ping_sec)**绝不重置**上游 stream_idle(不同 racer,`upstream-idle-margin` 锁定测试)。
- **轴 3 h2 vs WS**:h2(opus)有 TCP keepalive + h2 PING 两层上游保活;WS(gpt/Codex)**零应用层上游保活**,恢复防线是 buffered-retry(默认 OFF)。

`stale_request_max_age` 是 RequestContext 注册后**唯一的跨 attempt 总年龄策略**,但:①**不覆盖** pre-context 工作(JSON parse / model resolve / preprocess,发生在 `codec.parse` 的 `manager.create()` 之前,见 `handler-v4.ts:187-229` vs `codec/anthropic/codec.ts:354-374`);②当前是**周期采样器非严格 deadline**(真实终止 = maxAge + scan delay + 热重载语义延迟)。

### 2.2 settle / cancel / quiesce 混淆(架构病根)

- `ctx.fail()`/`complete()`/`abort()`(`request.ts:638-770`)只做:冻结终态 + 发布事件 + `onSettled`→从 `activeContexts` **出册**。**不取消**底层异步。
- 唯一触发底层取消的是 `ctx.reapInFlight()`(`request.ts:329-331`,abort lifecycleSignal),但它只被 reaper 调用,且**不覆盖不接 signal 的 `delay()`/限流 sleep**。
- drain 等待集 = `getRequestContextManager().getAll()`(`shutdown.ts:345`)= reaper 扫的同一个 `activeContexts`。→ 已 settle 出册的请求 drain "看不见";但底层 fetch/sleep 可能仍在飞(RC3/RC4)。

**取消信号覆盖矩阵(现状,GPT 复核校准)**:

| 取消源 \ 等待点 | pre-header fetch(non-stream) | pre-header fetch(**stream**) | stream body guard | 退避 `delay()` | 限流 sleep |
|---|---|---|---|---|---|
| client abort | ✅ | ✅ | ✅ | ❌ | 部分 |
| reaper(lifecycle) | ✅ | ✅ | ✅ | ❌ | ❌ |
| **shutdown** | ✅ | **❌(RC1)** | ✅ | ❌ | reject-race(RC4) |
| deadline | ❌(不存在) | ❌ | ❌ | ❌ | ❌ |

## 3. 目标架构

### 3.1 四段生命周期(核心不变量)——修订自三态(第 3 轮复核 blocker)

> **第 3 轮 GPT 复核发现 blocker**:原"cancel→quiesce→settle 且 quiesce 含所有 sink write"是**因果环**——terminal sink write(History `finalizeEntry`、CalibrationSink)由 `settle` 发布的 terminal event 触发(`history.ts:290` `void finalizeEntry`),若"等 quiesce 再 settle"则死锁。且 History 本就有**独立**的 finalization drain(`pendingFinalizations`/`shutdownHistory`,`history/state.ts:140-154`)。故修订为**四段 + 两个 join**。

把终结拆成四个**显式、有序**阶段;区分 **settle-前 operation-body 工作** 与 **settle-后 finalization 工作**两个 join:

1. **`cancel(reason)`** —— 请 settle-前工作停止:abort `operationSignal` + 置 `cancelled` 禁止新 attempt。幂等,不写终态。
2. **operation-body quiesce**(`whenOperationQuiesced()`)—— 该请求拥有的 **settle-前** 工作全退出:fetch、stream、retry loop、退避 sleep、限流 sleep、token-refresh 等待、hook/preSend/onResolved 扩展点、response-side heartbeat serializer。
3. **`settle(outcome)`** —— 冻结并发布终态(现有 complete/fail/abort,不变 wire)。发布 terminal event(触发 finalization)。
4. **finalization drain**(`whenFinalized()`)—— settle-**后** 由 terminal event 触发的异步工作:History `finalizeEntry`、Calibration token-count、WS terminal broadcast。**复用现有 History `pendingFinalizations` drain 语义**,扩展到 Calibration/`bus.flush()`。

**顺序不变量(强制终止 = reaper/deadline/shutdown)——有界 grace,非无限等待(修第 4 轮复核 blocker)**:

> **第 4 轮复核发现新 blocker**:v2 的"cancel → 等**完全** operation-body quiesce → settle"让 deadline/reaper **无法处理真正不 quiesce 的 operation**(忽略 AbortSignal 的 hook/第三方 IO/serializer wedge)——若永不 quiesce 则 `whenOperationQuiesced` 永不 resolve → 永不 settle → 客户端永远拿不到 deadline-exceeded → 泄漏 reaper 自己也被卡。**这恰恰打败 RFC 核心目标**(处理"无法及时退出的工作"),且与现状矛盾(现 reaper 无视 quiesce **强制** settle)。

修订:强制终止 = **`cancel(reason) → race(whenOperationQuiesced, cancellationGrace) → settle(outcome) → 等 finalization drain`**。

- grace 内静止 → 正常 settle,operation scope 释放。
- **grace 超时仍必须 settle**(客户端/History 拿到 deadline/reaper terminal outcome)+ 标 `operationLeak=true` + operation scope **保留在 manager** 继续挡 shutdown resource drain 并告警(operator 可见"有请求越 deadline 仍未静止");orphan 最终由 Phase4 / 进程退出兜底。
- **"settle 后禁副作用"由 `operationSignal` gate + `cancelled` 标志保证**(attempt 边界 gate),**不靠**无限等所有旧工作结束。
- **stale reaper 必须能强制 settle 未 quiesce scope**(有界 grace 后 force-settle),否则"泄漏 reaper"名不副实。

**正常完成**:`自然 operation quiesce → settle → 等 finalization drain`(**不** cancel、无 grace 竞速——正常完成的 operation 已自然结束)。两路径**只在是否 cancel 上不对称,finalization ownership 对称**(修第 3 轮 major #11——正常 complete 也有 Calibration/finalize 未 quiesce,不能在 finalization 上不对称)。

**settle 后禁副作用不变量**:`failed`/`aborted`/`completed` 之后不得再起 attempt 或产生 upstream 业务副作用(由 operationSignal/cancelled gate 保证,非靠等待)。

### 3.1.1 finalization 用 keyed coordinator,非 global `bus.flush()`(修第 4 轮复核 major)

`whenFinalized()` 是 **per-request** join,但现 `bus.flush()`(`bus.ts:161-167`)与 History `pendingFinalizations`(`entries.ts:143-173`)都是 **global set**、按 request 无法区分、只 snapshot 一次不循环至稳定。故引入 **keyed finalization coordinator**:

- `registerFinalization(requestId, promise)` / `sealFinalizations(requestId)` / `whenFinalized(requestId)`。
- History terminal write、Calibration token-count、WS terminal broadcast 均把各自 promise 注册到**同一 request id**。
- global shutdown 另有 `drainAllFinalizations()`;**不拿 global `bus.flush()` 冒充 per-request join**。

### 3.2 统一 `operationSignal` + 分层穷尽等待点表(修第 3 轮 major #6/#7/#8)

每请求一个 `operationSignal = combineAbortSignals(clientAbort, lifecycle/reaper, shutdown, deadline)`,在**所有** settle-前上游等待点/副作用源折入。第 3 轮复核证明原四项列表**不穷尽**,改为**分层表**(每加一层前 grep 全仓同类 await,防"设计漏掉的事件源"):

| 层 | 等待点/副作用源 | 现状 | 证据 |
|---|---|---|---|
| transport | pre-header fetch(non-stream) | ✅ 已折 shutdown/reaper/client | `send.ts:113` |
| transport | pre-header fetch(**stream**) | ❌ RC1 排除 shutdown | `send.ts:113`(`stream ? undefined`) |
| transport | stream body guard | ✅ | `http-transport.ts:99-110` |
| strategy | 退避 `delay()` | ❌ RC3 不接 signal | `driver.ts:476-479,1053-1055` |
| strategy | **token refresh**(第五类,新发现) | ❌ 只接自身 15s/30s、不接 operationSignal | `strategies/token-refresh.ts:52-56`、`token/copilot-token-manager.ts:95-119`、`copilot-client.ts:17-25` |
| ratelimit | 限流 sleep | ⚠️ reject-race | `adaptive-rate-limiter.ts:442-535` |
| hook | `preSend`/`onExchange`/`onResolved` 扩展点 | ❌ 不接 signal、可任意 async I/O + 副作用持久化 | `driver.ts:372-398,411-418`、`feature-negotiation.ts:512-535` |
| response sink | heartbeat detached serializer write | ⚠️ close 清 timer 但已入队 write 未撤 | `client-sink.ts:341-349,513-523,108-123` |
| **global(非请求私有)** | feature-negotiation debounce persist(第六类,第 4 轮发现)、共享 token refresh | ❌ `onResolved` 同步返回后 detached 1s timer→`atomicWriteJson`;多请求合并同一 debounce | `unsupported-beta-retry.ts:187-197`、`feature-negotiation.ts:512-535` |

**global operation scope(第 4 轮 major)**:feature-negotiation debounce persist 与共享 token refresh **不属单请求**(多请求合并/共享),不能塞进 per-request scope(跟踪 `onResolved` promise ≠ 跟踪它安排的 detached timer)。归 **`globalOperationScope`**:请求侧只拥有 waiter(`raceWithSignal` 退出),底层归 global;**shutdown 必须 cancel debounce + flush 最新 snapshot + await 序列化 chain**、并整体 drain 共享 refresh 的 fetch/backoff。这是独立于 per-request finalization 的 global drain。

**token refresh 特例(共享 refresh 不能被单请求粗暴 abort)**:多请求共享 `refreshInFlight`,单请求取消用 `raceWithSignal(sharedRefreshPromise, operationSignal)` **退出等待**、不 abort 共享 refresh(其他请求仍需);共享 refresh 归 `globalOperationScope`、仅 global shutdown 整体 abort/drain。

### 3.3 双 registry:drain 等 operation、UI 等 visible(修第 3 轮 major #9)

原"active record 直到 quiesce 才移除 + getAll() 仍返回 ctx"会让**已 settle 未 quiesce** 的 ctx 继续出现在 UI connected 快照/status activeCount,与 WsSink 增量递减冲突。拆两个 registry:

- **`visibleContexts`** —— terminal settle 即删除,服务 UI/status/`getAll()`/`activeCount`(保持现语义:terminal event 即离开 active UI)。
- **`operationScopes`(lifecycle record)** —— **finalization 完成后**才删除(修第 4 轮 major:删除时点统一为 finalize 后,不是含糊的"quiesce/finalize");其中 operation **child registry** 可在 operation-body quiesce 后释放,但 **lifecycle record + finalization coordinator 必须保留到 finalize 完成**。服务 shutdown drain。新增 `trackedOperationCount`(与 `activeCount` 分离)。

**operation scope 结构化并发(sealing + root owner,修第 3 轮 major #4/#5 + 第 4 轮 self-join)**:operation 分阶段出现(exchange 先结束、response pump 后登记、buffered retry 响应期还可能重进 `runExchange`)。开放式"随时 track"会在暂时归零窗口过早 resolve → 新 attempt 成 drain 看不见的 orphan。改结构化:scope 维护 `childCount` + `sealed`;**仅 `sealed && childCount===0` 才 quiesced**;顶层 handler/pipeline 在唯一 `finally` `seal()`。**root owner 不计入 childCount**(修第 4 轮:否则 handler `await whenOperationQuiesced()` 自等 → self-join 死锁);lifecycle orchestrator 在 **root operation 之外**等待 quiescence。测试覆盖"暂时归零后又登记 buffered retry"**与**"root 不自 join"两个反例。

### 3.4 双旋钮:request_deadline + 泄漏 reaper(修第 3 轮 major #10/#12 config 矛盾)

- **`timeouts.request_deadline`(新增)** —— 用户可依赖的硬总时长 SLA。per-request 单调 deadline timer(**属 operation scope、settle/quiesce/manager dispose 时清理、`unref`**——修第 3 轮 major #10:否则 dry-run capturing manager 每次留最长 deadline 的悬挂 timer),到点 `cancel(deadline) → 等 operation quiesce → settle`。`0 = 禁用`。
- **dry-run/inspection 豁免**:capturing manager 的 ctx 声明 `mode:"inspection"`,**不启动 deadline**、不注册生产 operation;capturing manager 需显式 `dispose()`。
- **`stale_request_max_age`(保留,降级为泄漏安全网)** —— 只清理**异常未 quiesce** 的 context(应配 > `request_deadline`),命中即**告警** + 强制 settle。热重载**重调度**(修 RC2)。
- **config 语义(修矛盾)**:`request_deadline=0(显式禁用)时行为 = 旧 `stale_request_max_age`-only 路径,字节不变`——这是**唯一**诚实的兼容主张。**bundled `config.yaml` 是有效默认(每次启动 `mergeConfigs(bundled,user)` 合入,非示例文件)**,故 bundled 给显式值 = **有意的产品默认变更**(镜像 `gpt-5.5:600` bundled 先例),须**带迁移说明 + golden**,**不得**声称"未配即旧行为"。取舍见 §8.2 决议(采有意默认变更,符合项目"无向后兼容负担、正确即强制迁移"哲学;reviewer 推荐的 bundled=0 纯兼容方案记录为 record-not-adopted)。

## 4. 接口契约

> 具体签名在计划阶段定稿,此处定契约方向(第 4 轮复核已同步 v2 架构,清除 v1 残留名)。

- `RequestContext`:新增 `cancel(reason: CancelReason): void`(abort operationSignal + 置 `cancelled` 禁新 attempt)、`operationSignal: AbortSignal`(union: client/reaper/shutdown/deadline)、`trackOperationBody(p): void`(注册 settle-前 child)、`sealOperationScope(): void`(root 唯一 finally 调,此后不再登记)、`whenOperationQuiesced(): Promise<void>`(`sealed && childCount===0`,**root 不计入 childCount**)。现有 `complete/fail/abort` 保持 settle 语义、不变 wire。**`cancel` 与 settle 解耦**:强制终止路径 `cancel → race(whenOperationQuiesced, grace) → settle`。
- finalization coordinator(keyed,§3.1.1):`registerFinalization(requestId, p)` / `sealFinalizations(requestId)` / `whenFinalized(requestId)`;global `drainAllFinalizations()`。History/Calibration/WS terminal handler 注册到同 request id。
- `RequestContextManager`:**双 registry**——`visibleContexts`(terminal settle 即删,服务 `getAll()`/`activeCount`/UI/status,语义不变)+ `operationScopes`(finalize 后删,服务 drain);新增 `getTrackedOperations()`/`trackedOperationCount`。`getAll()`/`activeCount` **来源仍是 visibleContexts**(UI 无可观测变化)。
- `globalOperationScope`(§3.2):feature-negotiation debounce persist + 共享 token refresh 归此;shutdown `drainGlobalOperations()`(cancel debounce + flush snapshot + await chain + drain 共享 refresh)。
- ClientSink:新增 `closeAndDrain(): Promise<void>`——暴露 serializer tail promise,quiescence 等**实际 tail**、非只清 timer(修第 3 轮 minor #8 接口未同步)。
- `sendUpstreamHttp`:`fetchSignal` 一律含稳定 shutdown signal(删 `stream ? undefined` 分支);新增 deadline 分量(经 operationSignal)。
- `delay()` → `abortableDelay(ms, signal)`:signal abort 抛 `OperationCancelledError(reason)`;driver retry loop 在每个 attempt 边界 gate `ctx.cancelled || operationSignal.aborted` → break。
- adaptive-rate-limiter:queue item 加 `cancelled` 状态/ per-item signal;sleep 返回后 execute 前重校验。

## 5. 切换计划(按 commit,含 invariant)——重排自第 3 轮复核 DAG

> 第 3 轮复核证明原 `C1→…→C6` 线性顺序**有隐藏依赖**:C4(deadline)依赖 C5 的 `cancel/operationSignal/whenQuiesced`;C1/C2 在统一 signal 前无法保证"shutdown-abort-529 不在已取消请求上重试";C6 的 `frozen-interval` 观测必须在 C4 改掉 timer **之前**采集才能坐实 RC2。重排为下列 DAG,每 commit **终态不变量**:测试套件通过、无半破碎中间态、无新旧双写、过渡态显式无害。

- **C0-observe(先,不改行为)**:旧 reaper drift/frozen-cadence 观测(scheduledAt/actualAt/driftMs/scan-duration/live-maxAge/frozen-interval + monotonic-vs-wall-clock 区分 suspend vs 阻塞)+ config reload timeout 字段 before/after diff + `monitorEventLoopDelay` histogram。**invariant**:纯增观测、行为不变;**必须早于 C4b**(否则旧 frozen cadence 已消失、RC2 无法坐实)。可与 C0-lifecycle 并行。
- **C0-lifecycle(基础设施,不接生产路径)**:引入 `operationSignal`、`cancelled` state、operation scope(childCount+sealed+seal API、**root 不计入 childCount**)、`visibleContexts`/`operationScopes` 双 registry、`whenOperationQuiesced()` + **keyed finalization coordinator**(`registerFinalization`/`sealFinalizations`/`whenFinalized(requestId)`)。新 API 尚不接生产、行为不变(显式无害:仅定义,不订阅)。**invariant**:typecheck + 现有测试全过、生产路径零行为变化。
- **C1+C2(原子切换,避免 529 重试窗口)**:streaming pre-header fetch 折入稳定 shutdown signal(RC1)+ `abortableDelay`(RC3)+ retry loop attempt 边界 gate `cancelled || operationSignal.aborted`(**不只 settled**——Phase3 cancel 与 terminal settle 间 settled 仍 false)+ shutdown-abort-529 不得在已取消请求上重试。三者**同一原子 commit**(拆开会留 529 重试窗口)。golden 预捕获 RC1"挂到 Phase4"行为 → 修 → 证 Phase3 即中断。**invariant**:streaming/non-stream pre-header 取消对称;settle/cancel 后不起新 attempt。
- **C3(限流所有权)**:per-item `cancelled` 状态/signal + reject/execute 竞争消除。内部实现可与 C1/C2 并行开发,但 **integration 依赖 C0-lifecycle 的 signal 契约**。**invariant**:调用方拿到 shutdown 响应后无 upstream 副作用。
- **C4a(遗漏等待点接入,含 global scope)**:token refresh(共享 refresh 归 `globalOperationScope`、单请求用 `raceWithSignal` 退出)、hook `preSend`/`onExchange`/`onResolved`、heartbeat serializer(`closeAndDrain`)、**feature-negotiation debounce persist(第六类)归 `globalOperationScope`** 全接入。**invariant**:§3.2 分层表每层(含 global)可取消/可追踪。
- **C4b(deadline + reaper 降级,有界 grace)**:`request_deadline` per-request timer(属 operation scope、unref、dispose 清理、inspection 豁免)→ **`cancel(deadline) → race(whenOperationQuiesced, grace) → settle`**(grace 超时仍 settle + `operationLeak=true` + scope 保留告警);`stale_request_max_age` 降为泄漏安全网(有界 grace 后**强制 settle** 未 quiesce scope)+ 热重载重调度(修 RC2)+ compat。**依赖 C4a**。**invariant**:`request_deadline=0` 时旧行为字节不变;不 quiesce 的 operation **仍能 settle**(客户端拿到终态)。
- **C5(drain 原子切换双 join + global drain)**:shutdown drain 切到 operation-body quiesce(有界 grace)+ **keyed finalization drain**(per-request coordinator)+ **`drainGlobalOperations()`**(feature-negotiation debounce / 共享 token refresh)。**严格串行、必须晚于 C4a**。**invariant**:强制终止 = cancel→race(quiesce,grace)→settle→finalization-drain;drain 不因出册漏等未 quiesce/未 finalize 工作;UI/status active 语义不变(visibleContexts);grace 超时的 leak 不阻塞 settle、但仍挡 resource drain 并告警。
- **C6-final(长期 observability + 收尾)**:新机制长期指标(`operationLeak` 计数、trackedOperationCount)、文档同步(shutdown.md/DESIGN.md/streaming.md)、whole-domain audit。

**DAG 关键边**:C0-observe ∥ C0-lifecycle → (C1+C2) → C3(integration 依赖 C0-lifecycle)→ C4a → C4b(依赖 C4a)→ C5(严格串行,晚于 C4a)→ C6。deadline 与 drain 切换**必须**在 operation coverage(C4a)完成后,不可提前。

> C0/C1+C2/C3 是证实根因(RC1/RC3/RC4)的可落地修复;C4b 是治根(deadline);C5 建架构不变量;C0-observe+C6 坐实 RC2 并防复发。按证实度分阶段请用户签字。

## 6. 范围外

- WS(gpt/Codex)上游应用层保活(prevention 层)—— 仍是 deferred backlog(buffered-retry 是恢复防线),本 RFC 只统一**取消**覆盖、不新增 WS 保活。
- pre-context 工作(JSON parse/model resolve)纳入 deadline —— 记为 open question(§8),默认本 RFC 仍从 `manager.create()` 起算。
- 更换 undici / 传输层重构 —— 无关。

## 7. 验证

- **golden 预捕获**(large-refactor §4):改动前锁定 shutdown drain 序列 / reaper force-fail 行为 / abort 分类(client vs reaper vs timeout,`post-commit-error.ts`)/ 现有 `reaper-abort-unhandled.it.test.ts` 通过 → 重构后同测试仍过。
- **新增测试**:C1 delayed-commit pre-header shutdown 集成;C2 settle/cancel 后不起新 attempt;C3 限流 reject/execute 竞争;C4 deadline 到点 cancel+**有界 grace**+settle & `request_deadline=0` 时旧行为字节等价 & 热重载重调度 & **不 quiesce 的 operation 仍能 settle(leak 不阻塞)**;C4a "暂时归零后又登记 buffered retry" + "root 不自 join" 两反例;C5 drain 等未 quiesce operation + keyed finalization + global scope drain;C6 observability 字段存在性守卫。
- **flaky/时序**:deadline/reaper 时序测试用 fake timers + 连跑 10–25× 证确定性(empirical-verification)。
- **真实验证**:C1 落地后可在非 4141 端口起隔离测试服务器复现 delayed-commit + Ctrl+C,确认 Phase3 即中断(绝不碰 4141 主服务器)。

## 8. Open questions —— 决议(用户 2026-07-14「继续」授权按推荐默认拍板)

1. **pre-context 工作是否纳入 deadline?** → **否(默认)**。deadline 从 `manager.create()`(codec.parse 内)起算,不覆盖 route 入口的 JSON parse / model resolve / preprocess。理由:pre-context 工作有界且罕见,覆盖它需把计时起点前移到 route 入口、扩大范围;先不做,记为**未来考量**(§6 范围外已列)。极大 payload 的 parse 当前不在任何 total-cap 内,属已知残余,C6 observability 可暴露其耗时以便日后决策。
2. **`request_deadline` 默认值 + config 语义(第 3 轮复核修矛盾 major #10/#12)?** → **`CONFIG_MANAGED_DEFAULTS=0` + bundled `config.yaml` 给显式值(建议 1800s)= 有意的产品默认变更**。**关键澄清**:bundled config 是**有效默认**(每次启动 `mergeConfigs(bundled,user)` 合入、无 user config 也合入 `mergeConfigs(bundled,{})`,`config.ts:504-526`),故标准安装 effective `request_deadline` **就是** 1800、**非** 0。因此**唯一诚实的兼容主张**是"`request_deadline=0`(显式禁用)时 = 旧 stale-only 路径字节不变";不得声称"未配即旧行为"。采有意默认变更符合项目"无向后兼容负担、正确即强制迁移旧→新"哲学,**须带迁移说明 + golden**(长于 1800s 但未越 `stale_request_max_age` 的请求将新增 deadline failure)。deadline timer 属 operation scope、`unref`、settle/quiesce/dispose 清理、inspection 豁免(修 dry-run 悬挂 timer)。**record-not-adopted**:reviewer 推荐的"bundled=0 纯兼容、推荐值只写注释"方案未采——与项目哲学冲突(该给的正确默认就 bundled 进去,不靠用户手配)。
3. **正常 `complete` 是否也 track→quiesce→settle?(第 3 轮复核修 major #11)** → **只在"是否 cancel"上不对称,finalization ownership 对称**。正常完成:`自然 operation quiesce → settle → 等 finalization drain`(不 cancel);强制终止:`cancel → operation quiesce → settle → 等 finalization drain`。**两路径都追踪 settle-后 finalization**(History finalize / Calibration token-count / WS terminal broadcast)——原"正常 complete 工作已自然结束"被证伪(`bus.ts:95-130` 普通 publish 不 await async handler、Calibration/finalize 是 settle-后 detached)。C5 测试锁此对称。
4. **C6 event-loop histogram 是否常驻?** → **常驻**(`monitorEventLoopDelay` 开销极小 + internal-tool 全量暴露哲学)。

> 以上决议已并入本 RFC;若第 3 轮对抗审查或实现期发现决议 2/3 有具体反例,回本节修订并记录理由(record-not-adopted)。

## 9. 验证入口(活的真相)

- 运行实例 `GET /openapi.json`(端点全表面)、4141 `GET /history/api/entries/:id`(逐请求 attempts/state/timing oracle)、`~/.local/share/copilot-api/copilot-api.log*`(reaper force-fail / shutdown phase 序列)。
