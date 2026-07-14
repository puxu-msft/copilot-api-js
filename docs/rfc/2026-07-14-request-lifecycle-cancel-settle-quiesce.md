# RFC: 请求生命周期 cancel / settle / quiesce 三态分离与统一取消信号

- 状态: **草案(open questions 已决 2026-07-14;已过 2 轮独立 GPT 对抗复核收敛;待第 3 轮聚焦切换计划/invariant → 计划)**
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

### 3.1 三态显式分离(核心不变量)

把当前混为一体的终结拆成三个**显式、有序**的概念:

1. **`cancel(reason)`** —— 请底层工作停止:abort 该请求的 `operationSignal`,并**禁止发起新 attempt**。幂等。不写终态。
2. **`settle(outcome)`** —— 冻结并发布客户端/History 终态(现有 complete/fail/abort 语义)。幂等(现 `settled` 守卫)。不负责取消。
3. **`quiesced`** —— 该请求**拥有**的所有 fetch / stream / 退避 sleep / 限流 sleep / retry loop / sink write 均已退出。可 await/追踪。

**顺序不变量**:任何**外部强制终止**路径(reaper / deadline / shutdown)= `cancel(reason)` → 追踪 quiesce → `settle(outcome)`。正常 `complete` 时工作通常自然结束,不做无差别 abort(避免在 terminal frame / sink flush 未完成时制造新 abort race)。

**settle 后禁止副作用不变量**:`failed`/`aborted`/`completed` 之后不得再发起 attempt 或产生 upstream 业务副作用。

### 3.2 统一 `operationSignal`

每请求一个 `operationSignal = combineAbortSignals(clientAbort, lifecycle/reaper, shutdown, deadline)`,在**所有**上游等待点统一折入:

- pre-header fetch(**含 streaming**,堵 RC1)——`send.ts` 的 `stream ? undefined : getShutdownSignal()` 改为一律折入稳定 shutdown signal;
- stream body guard(已折入,保持);
- 退避 `delay()`(堵 RC3)——改可中断 sleep,abort 后抛带 reason 的 cancellation、**不静默 resolve**;
- 限流 sleep(堵 RC4)——per-item 所有权 + signal,sleep 返回后、execute 前重新校验所有权。

**新增 `deadline` 分量**:per-request 单调时钟 deadline timer(见 §3.4),到点 abort operationSignal。

### 3.3 drain 等 operation 而非等 context

manager 每条 active record 除 `ctx` 外持一个 **operation promise**(该请求所有拥有工作的 join),直到 **quiesced** 才真正移除。drain 等待"tracked operations 全 quiesce",而非"activeContexts 空"。这样即使 settle 已出册,未 quiesce 的底层工作仍挡 drain、Phase 3 abort 能真正触达。

### 3.4 双旋钮:request_deadline + 泄漏 reaper(用户决策)

职责分离,语义各不同:

- **`timeouts.request_deadline`(新增)** —— 用户可依赖的**硬总时长 SLA**。per-request 单调 deadline timer,到点 `cancel(deadline)` → 追踪 quiesce → `settle`(向客户端记 deadline-exceeded 终态)。`0 = 禁用`。是**主**总时长机制。
- **`stale_request_max_age`(保留,降级)** —— 纯**泄漏安全网**:只清理**异常未 quiesce**的 context(应配置为**大于** `request_deadline`),命中即**告警**(operator 可见的"有请求越过 deadline 仍未静止"信号)+ 强制 settle。scan 保留为泄漏兜底,但不再是用户 SLA 的承载者。
- **compat**:旧行为不变——未配 `request_deadline` 时,`stale_request_max_age` 仍作总时长上限(保持现状,不破坏)。config 面加旧键保留、warn-and-continue(遵循项目配置哲学:配置不享"无向后兼容负担",键重命名留旧键别名读时映射,热重载绝不因配置问题杀进程)。
- **reaper 热重载重调度(修 RC2)**:config reload 后显式重调度 reaper cadence,或改为自调度 timeout 每轮按 live config 计算 interval。

## 4. 接口契约

> 具体签名在计划阶段定稿,此处定契约方向。

- `RequestContext`:新增 `cancel(reason: CancelReason): void`(abort operationSignal + 置 `cancelled` 标志禁新 attempt)、`operationSignal: AbortSignal`(union)、`trackOperation(p: Promise<unknown>): void` / `whenQuiesced(): Promise<void>`。现有 `complete/fail/abort` 保持 settle 语义、不变 wire。
- `RequestContextManager`:active record 从 `ctx` 扩为 `{ ctx, operationSignal, whenQuiesced }`;`getAll()` 保持返回 ctx(兼容 UI);新增 drain 用的 `getTrackedOperations()`。
- `sendUpstreamHttp`:`fetchSignal` 一律含稳定 shutdown signal(删 `stream ? undefined` 分支);新增 deadline 分量。
- `delay()` → `abortableDelay(ms, signal)`:signal abort 抛 `OperationCancelledError(reason)`;driver retry loop 在每个 attempt 边界 gate `ctx.cancelled || operationSignal.aborted` → break。
- adaptive-rate-limiter:queue item 加 `cancelled` 状态/ per-item signal;sleep 返回后 execute 前重校验。

## 5. 切换计划(按 commit,含 invariant)

每 commit **终态不变量**:测试套件通过、无半破碎中间态、无新旧双写。分阶段(TDD):

- **C1(RC1,证实、最高性价比)**:`send.ts` streaming pre-header fetch 折入稳定 shutdown signal + reaper/client 已有。补 delayed-commit pre-header shutdown 集成测试(golden 预捕获现有"挂到 Phase4"行为 → 修 → 证 Phase3 即中断)。**invariant**:streaming 与 non-stream 的 pre-header 取消覆盖对称。
- **C2(RC3)**:`abortableDelay` + retry loop attempt 边界 `cancelled/settled` gate。**invariant**:settle 后不再起新 attempt(测试锁)。
- **C3(RC4)**:限流 per-item 所有权 + reject/execute 竞争消除。**invariant**:调用方拿到 shutdown 响应后无 upstream 副作用。
- **C4(deadline + reaper 降级)**:新增 `request_deadline` per-request timer + `stale_request_max_age` 降为泄漏安全网 + 热重载重调度(修 RC2)+ compat 映射。**invariant**:未配 deadline 时旧行为字节不变。
- **C5(三态 + drain 等 operation)**:显式 `cancel/settle/quiesced` + manager operation 追踪 + drain 等 quiesce。**invariant**:强制终止路径 = cancel→quiesce→settle;drain 不因出册漏等未 quiesce 工作。
- **C6(observability,坐实 RC2 + 长期诊断)**:reaper tick 记 `scheduledAt/actualAt/driftMs/scan-duration/active-count/live-maxAge/frozen-interval` + **monotonic clock vs wall clock 差**(区分 event-loop 阻塞 vs 进程/WSL suspend——两者都让 timer 迟到但机制不同)、config reload timeout 字段 before/after diff、`perf_hooks.monitorEventLoopDelay()` histogram、同步 HistorySink persist 耗时 histogram。**invariant**:纯增可观测性、不改行为。

> C1–C3 是证实根因的**独立可落地**修复(每个各自正确);C4–C5 建立架构不变量;C6 坐实 RC2 并防复发。可按证实度分阶段请用户签字。
>
> **承重澄清(两份独立 GPT 复核共识)**:可中断 sleep(C2)只堵"reaper 已触发后底层不退出"的缺口,**不能让 reaper 准时触发**;`request_deadline` per-request 单调 timer(C4)才是"总时长越过 1200s 却跑到 2800s"的**治根**——正确性不再依赖周期扫描精度。C6 用于在真实环境**坐实** RC2 到底是热重载 / WSL suspend / 同步重活哪一个,而非继续推断。

## 6. 范围外

- WS(gpt/Codex)上游应用层保活(prevention 层)—— 仍是 deferred backlog(buffered-retry 是恢复防线),本 RFC 只统一**取消**覆盖、不新增 WS 保活。
- pre-context 工作(JSON parse/model resolve)纳入 deadline —— 记为 open question(§8),默认本 RFC 仍从 `manager.create()` 起算。
- 更换 undici / 传输层重构 —— 无关。

## 7. 验证

- **golden 预捕获**(large-refactor §4):改动前锁定 shutdown drain 序列 / reaper force-fail 行为 / abort 分类(client vs reaper vs timeout,`post-commit-error.ts`)/ 现有 `reaper-abort-unhandled.it.test.ts` 通过 → 重构后同测试仍过。
- **新增测试**:C1 delayed-commit pre-header shutdown 集成;C2 settle 后不起新 attempt;C3 限流 reject/execute 竞争;C4 deadline 到点 cancel+settle & 未配时旧行为等价 & 热重载重调度;C5 drain 等未 quiesce operation;C6 observability 字段存在性守卫。
- **flaky/时序**:deadline/reaper 时序测试用 fake timers + 连跑 10–25× 证确定性(empirical-verification)。
- **真实验证**:C1 落地后可在非 4141 端口起隔离测试服务器复现 delayed-commit + Ctrl+C,确认 Phase3 即中断(绝不碰 4141 主服务器)。

## 8. Open questions —— 决议(用户 2026-07-14「继续」授权按推荐默认拍板)

1. **pre-context 工作是否纳入 deadline?** → **否(默认)**。deadline 从 `manager.create()`(codec.parse 内)起算,不覆盖 route 入口的 JSON parse / model resolve / preprocess。理由:pre-context 工作有界且罕见,覆盖它需把计时起点前移到 route 入口、扩大范围;先不做,记为**未来考量**(§6 范围外已列)。极大 payload 的 parse 当前不在任何 total-cap 内,属已知残余,C6 observability 可暴露其耗时以便日后决策。
2. **`request_deadline` 默认值?** → **`CONFIG_MANAGED_DEFAULTS.request_deadline = 0(禁用)` + bundled `config.yaml` 给显式值(建议 1800s)+ 文档**。理由:内置默认禁用 = 未配时完全走 `stale_request_max_age` 旧行为、零破坏;bundled config 给显式 SLA(镜像 `gpt-5.5:600` 那种 bundled-非-CONFIG_MANAGED_DEFAULTS 的先例)。用户可覆盖。
3. **正常 `complete` 是否也强制 track→quiesce→settle?** → **不对称,可接受**。只对**强制终止**(reaper/deadline/shutdown)要求 `cancel→quiesce→settle`;正常完成工作已自然结束、走现有路径,避免在 terminal frame / sink flush 未完成时制造新 abort race。C5 测试锁此不对称。
4. **C6 event-loop histogram 是否常驻?** → **常驻**(`monitorEventLoopDelay` 开销极小 + internal-tool 全量暴露哲学)。

> 以上决议已并入本 RFC;若第 3 轮对抗审查或实现期发现决议 2/3 有具体反例,回本节修订并记录理由(record-not-adopted)。

## 9. 验证入口(活的真相)

- 运行实例 `GET /openapi.json`(端点全表面)、4141 `GET /history/api/entries/:id`(逐请求 attempts/state/timing oracle)、`~/.local/share/copilot-api/copilot-api.log*`(reaper force-fail / shutdown phase 序列)。
