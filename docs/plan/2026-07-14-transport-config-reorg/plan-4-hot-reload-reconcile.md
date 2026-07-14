> **状态**：待执行。属于 `docs/plan/2026-07-14-transport-config-reorg/README.md` 定义的 P4 阶段——依赖 P2（`plan-2-new-knobs-wiring.md`，必须已落地：`http2-client.ts` 的 `getSessionConnectTimeoutMs()`/keepalive 0-语义、`upstream-ws.ts` 的 `getPooledConnectionIdleTimeoutMs()` + `create()` 的 `idleTimeoutMs` 接线），不依赖 P3。P4 完成后解锁 P5（状态面板）。

# P4 — 热重载 Reconcile：generation-based retire-and-replace

## Goal

`state.setUpstreamTransportConfig()`（P1 落地）触发 `onUpstreamTransportChange` 事件时，`http2-client.ts`/`upstream-ws.ts` 目前对此**完全无感知**——已经建立的 h2 会话、已经建立的 WS 连接，会继续沿用创建时读到的旧配置值（keepalive delay、h2 ping interval、WS idle timeout、soft-max）直到自然关闭。本阶段让这两层连接管理订阅该事件，对**已存在的连接**做 reconcile：

- **h2 会话**：按 origin 做 generation-based retire-and-replace——配置变化后，旧 generation 的会话立即从"可路由新请求"的活跃池移除（新请求必然拿到新 generation 的会话，从而读到新配置值），但旧会话上仍在进行的流（尤其长时间 thinking）不受任何影响，继续在原会话上跑到自然结束；旧会话的 keepalive PING 定时器必须存活到最后一个流真正结束（drain 完成）才清除——这是全局约束 #4 的既有不变量，本阶段绝不能破坏。
- **WS 连接**：已建立的空闲连接的 idle-timeout 定时器被真实重新 armed 为新值；soft-max 超额的空闲连接被主动驱逐到新 cap；busy 连接不被打断，通过既有机制（下次 `finishRequest()` 或下次 `create()` 的 `evictOneIdleIfNeeded()`）自然收敛。

**范围边界**（与 P1/P2/P3/P5 解耦，见 README 依赖表）：
- 不改"新连接读哪个配置值"（P2 职责，本阶段假定 P2 已完成，只处理"已存在的连接如何响应配置变化"）。
- 不新增/不修改 `MutableState`/`setUpstreamTransportConfig`/`onUpstreamTransportChange` 本身（P1 职责，本阶段只是这个事件的一个新消费者）。
- 不接入 `/api/status` 或 ui-v4（P5 职责）；本阶段只负责让 `getH2SessionStatusSnapshot`/`getH2ReconcileStatus`/`getUpstreamWsStatusSnapshot` 这三个查询函数存在且行为正确，不负责把它们接到 HTTP 路由。
- **绝不是 drain-then-replace**：不引入任何"等旧连接排空再建立新连接"的逻辑——新连接的建立与旧连接的排空是两条完全独立、互不阻塞的时间线（全局约束 #2）。

## Architecture

### h2（`http2-client.ts`）

把现有的 `sessions: Map<string, http2.ClientHttp2Session>`（裸 session）升级为 `Map<string, H2SessionEntry>`（`H2SessionEntry` 是模块内部接口，不导出，不是跨阶段契约），新增 `retiringSessions: Set<H2SessionEntry>` 承载"已从活跃池移除、仍在 drain 中"的会话，新增 `sessionEntryByHttp2Session: WeakMap<http2.ClientHttp2Session, H2SessionEntry>` 供 `runHttp2Fetch` 反查裸 session 对应的 entry（`getSession()` 对外仍返回裸 `http2.ClientHttp2Session`，调用方签名零变化）。

**exactly-once 递减的关键设计**：`activeStreamCount` 的递减，靠 Node `Http2Stream` 的 `close` 事件（`req.once("close", ...)`）——这个事件由 Node 保证对每个流精确触发一次，无论流是正常结束、被 RST、被本地 `abort`、还是在 headers 之前/之后失败，都会走到这一个事件。用这个官方保证的 exactly-once 钩子，而不是在 `runHttp2Fetch` 里分别给"正常 end"/"pre-response abort"/"error"/"post-response abort"四条路径手工写递减——手工枚举面对全局约束 #3（"必须恰好递减一次，覆盖所有终止路径"）天然有遗漏风险，借用平台保证的单一事件消除这个风险类别。

**goaway/retiring 语义完整保留既有不变量**：现有 `getSession()` 里 `error`/`close`/`goaway` 三个处理器的既有职责划分（`goaway` 只把会话移出可路由池，不清除 `pingTimer`；`error`/`close` 才真正 dispose 清除定时器）原样保留——只是把"移出可路由池"这个动作从"彻底忘记这个会话"升级为"移入 `retiringSessions` 并标记 `lifecycle:"retiring"`，供状态查询和 reconcile 复用同一条退休路径"。`reconcileH2SessionsForConfigChange()` 触发的"配置变化退休"与 `goaway` 触发的"上游发起退休"，共享同一套 retiring 记账，只是触发源不同。

**为什么 reconcile 只在配置变化"退休"时才主动尝试立即关闭空闲的旧会话**：`goaway` 场景里上游本来就在主动断链，我们不需要越俎代庖去 `close()` 它；但 reconcile 场景里，若一个 origin 的会话此刻恰好没有任何在飞流（`activeStreamCount===0`），继续放着不管既不必要地占着资源，也会让 `retiringSessions` 里堆积永远不会自然关闭的"僵尸"条目（Node 的 h2 session 在没有新流、没有对端 GOAWAY 的情况下可能无限期空闲存活）——所以 `reconcileH2SessionsForConfigChange()` 对每个刚退休的 entry 立即检查 `activeStreamCount`，为零就主动 `close()`；`maybeReclaimRetiringSession()` 在每次流关闭后重新检查同一条件，覆盖"退休时还有在飞流，之后流陆续结束"的情形。

```
配置变化 (onUpstreamTransportChange 触发)
  │
  ▼
reconcileH2SessionsForConfigChange()
  currentGeneration += 1
  for (origin, entry) of sessions（当前活跃池的快照）:
    sessions.delete(origin)                    ← 立即停止路由新请求到这个 entry
    entry.lifecycle = "retiring"; retiringSessions.add(entry)
    maybeReclaimRetiringSession(entry)          ← activeStreamCount===0 时主动 close()
  │
  ▼
下一次 getSession(origin) 对该 origin 走 miss 路径 → createSession() 读取全新配置值
  → 新 entry 的 generation = currentGeneration（已经是新值）
  │
旧 entry 在 retiringSessions 里，pingTimer 继续运行，直到：
  (a) activeStreamCount 归零时被 maybeReclaimRetiringSession 主动 close()，或
  (b) 自然 error/close 事件触发 dispose() 清除定时器 + 移出 retiringSessions
```

**generation 捕获-比较-丢弃竞态（spec §4 HIGH-3，硬性要求，非可选简化）**：`createSession()`（`sessionFactory(origin)`）在 socket/TLS 建连**完成前**就已经固化了连接级参数（`getUpstreamKeepAliveDelayMs()`/`getSessionConnectTimeoutMs()` 在 `await connectProxiedSocket`/`tls.connect` **之前**读取，P2 已定）——这意味着一次 `getSession()` 调用如果与一次 `reconcileH2SessionsForConfigChange()` 并发竞速，其正在建立的底层 TCP/TLS 连接本身，可能已经用了**旧**配置值，即使建连完成的那一刻 `currentGeneration` 已经是新值。仅仅"建连完成后重读配置值再打个新 generation 标签"不能挽救已经用旧参数建立的连接本身——那会让 `H2SessionStatusRow.generation` 撒谎（声称是新 generation，实际连接参数是旧的）。唯一正确的修复是**捕获-比较-丢弃-重试**：`getSession()` 在发起 `sessionFactory(origin)` 之前记下 `generationAtStart = currentGeneration`；建连完成后若 `currentGeneration !== generationAtStart`（说明建连期间发生了一次 reconcile），就丢弃这个刚建好的连接（`session.close()`）并**重新**读取最新配置值、重新建连，而不是把这个用旧参数建的连接硬套上新 generation 标签蒙混过关。这个重试循环收纳在同一个 creation 帧内的 `for (;;)` 结构里（而非递归调用 `getSession()`——递归会产生两层独立的 `pending.set/delete` 括号，在两帧之间的微任务窗口期，若有第三方调用者在外层 `pending` 已被内层 `finally` 误删后插入新的 `pending` 条目，会导致该条目被外层过期的 `finally` 意外删除；用同一帧内的循环从根本上消除这层竞态）。见 Task 1 Step 3 的完整实现。

**reconcile 绝不能把异常向上抛（spec §4 HIGH-3 后半句，硬性要求）**：`state.ts` 的 `setTimeoutConfig()`（第 1418-1434 行）遍历 `requestWatchdogListeners`（原名 `transportTimeoutListeners`，plan-1 Task 5 Step 4b 已改名为 `onRequestWatchdogChange`/`requestWatchdogListeners`，spec §6 item 2 + §7 要求零残留）时是 `for (const listener of requestWatchdogListeners) listener()`——**没有** try/catch。这意味着如果 `reconcileH2SessionsForConfigChange()` 作为其中一个 listener 抛出异常，会中断这个循环、跳过它之后注册的所有其他 listener（包括 WS 侧的 reconcile listener、`proxy.ts` 的 dispatcher 重建 listener），造成"配置本身已经应用成功，但部分订阅者完全没收到通知"的隐蔽不一致状态——这比"reconcile 失败但被记录、其他订阅者正常收到通知"糟糕得多。因此 `reconcileH2SessionsForConfigChange()` 内部必须自己吞掉所有异常，只把结果记录到 `reconcileState`/`lastReconcileError`（可观测，供 P5 的 `getH2ReconcileStatus()` 暴露），绝不重新 `throw`；同时也不能静默吞掉不打日志——用 `consola.error` 打印，确保"failed"状态不是唯一的痕迹。见 Task 1 Step 3 的完整实现。

### WS（`upstream-ws-connection.ts` + `upstream-ws.ts`）

`upstream-ws-connection.ts` 把 `idleTimeoutMs` 从创建时读一次的常量，改为可变闭包变量 `effectiveIdleTimeoutMs`，新增 `rescheduleIdleTimeout(newIdleTimeoutMs)` 方法，并新增一个闭包变量 `idleSince: number | undefined` 记录"这个连接从什么时刻起处于 idle 状态"。

**idle deadline 必须以 idleSince 为基准、不能以 `now` 为基准重算（spec §4 HIGH-6，硬性要求）**：如果 `rescheduleIdleTimeout` 简单地用"从现在起再等 `newIdleTimeoutMs`"重启窗口，会产生一个反直觉且有害的副作用——一个已经空闲了 4 分钟（默认 5 分钟窗口）的连接，遇到配置热更新到 1 分钟新窗口时，正确行为应该是"早就超过新窗口了，立即关闭"，但"从现在重算"会让它反而多活 1 分钟，等于每次 reload 都在无意延长老连接的寿命，且这个效果会随 reload 频率累积。正确设计：`onOpen` 首次建立成功、以及每次 `finishRequest()` 把连接标记回 idle 时，都记录 `idleSince = Date.now()`；`sendRequest()` 把连接标记为 busy 时清空 `idleSince = undefined`；`scheduleIdleClose()` 内部改为按绝对 deadline 调度——`const deadlineMs = (idleSince ?? Date.now()) + effectiveIdleTimeoutMs`，`setTimeout` 的延迟量是 `Math.max(0, deadlineMs - Date.now())`。这样"新 deadline 已过"（超时值缩小到 idle 时长以下）会以 `0` 延迟立即触发关闭；"新 deadline 未过"（超时值增大，或 idle 时间还短）会延到新的绝对时刻；`newIdleTimeoutMs === 0` 沿用既有的 `effectiveIdleTimeoutMs <= 0` bail-out 语义（取消定时器，不再自动关闭）；busy 连接因为 `idleSince===undefined`（且 `busy` 本身也会让 `scheduleIdleClose()` 提前 bail-out）而完全不受影响，下次真正转 idle 时用当时最新的 `effectiveIdleTimeoutMs` 重新起算——不需要额外分支判断，是同一段既有 bail-out 逻辑的自然结果。

`upstream-ws.ts` 的 manager 新增两个方法（`UpstreamWsManager` 接口扩展，非 README 锁定但沿用既有 `breakerSnapshot()` 的同款风格）：`reconcileForConfigChange(newIdleTimeoutMs)`（遍历所有连接调用 `rescheduleIdleTimeout` + 用新增的 per-key `generation` map 记录代际 + 驱逐超额的 idle 连接到新 cap）与 `statusSnapshot()`（供导出的自由函数 `getUpstreamWsStatusSnapshot(manager)` 调用，遍历 `connections` 生成 `UpstreamWsStatusRow[]`）。

**soft cap 必须在 busy→idle 转换时也触发驱逐，不能只在 reconcile/create 时检查一次（spec §4 HIGH-5，硬性要求）**：reload 瞬间允许全部连接暂时超过新 cap 是既有"soft cap"语义的合理延伸（见 `evictOneIdleIfNeeded()` 的既有注释："All connections are busy — pool cap will be temporarily exceeded... We do not refuse the request"）；但如果 reconcile 只在触发的那一刻检查一次"当前 idle 的超额连接"、而全部连接当时都是 busy，driver 就永远没有下一次检查的机会——若这之后很长时间都没有新的 `create()` 调用（也就没有 `evictOneIdleIfNeeded()` 的既有触发点），即使这些 busy 连接后续陆续转回 idle，也不会被驱逐，造成永久超额（spec 明确点名的场景，不是理论风险）。正确设计：给 `CreateUpstreamWsConnectionOptions` 新增 `onIdle?: () => void` 回调，在"标记为 idle"的同一处（`onOpen` 首次建立成功、`finishRequest()`）里，紧跟着 `idleSince = Date.now()` 之后调用 `opts.onIdle?.()`；`upstream-ws.ts` 的 `create()` 直接传入 `onIdle: () => evictOneIdleIfNeeded()`——不需要另包一层重复的 cap 判断：既有 `evictOneIdleIfNeeded()` 内部已经做了 `cap<=0` 与 `connections.size < cap` 的早退检查，每次 busy→idle 转换调它一次，代价只是"已在 cap 以内时的一次廉价早退"，比新增一个重复判断分支更不容易漂移。这样每一次 busy→idle 转换都是一次"是否还超额"的检查点，覆盖了"reload 时全 busy、之后逐个转回 idle"这条此前完全没有被覆盖的路径。同时 `reconcileForConfigChange()` 自身的驱逐循环，不能依赖 `connections.size` 在同一个 tick 内因为 `victim.close()` 而缩小（`evictOneIdleIfNeeded()` 触发的移除是异步生效——`connections.delete(key)` 要等 `onClose` 回调真正触发才执行，见 `upstream-ws.ts` 里 `create()` 的 `onClose` 接线），必须改为按"需要驱逐的数量"计数循环，而不是按 Map 基数变化判断是否继续。见 Task 2 的完整实现。

### 订阅点（两层各自懒加载，遵循 `proxy.ts` 既有惯例）

`proxy.ts` 已有的 `ensureTimeoutSubscription()`（第 228-232 行）是"懒加载单次订阅"的既有先例：一个模块级 `boolean` 标志 + 一次 `on...Change(listener)` 调用，在首次真正需要连接的入口点触发。`http2-client.ts`/`upstream-ws.ts` 各自复刻同一模式：`getSession()` 首次被调用时懒订阅 `onUpstreamTransportChange(reconcileH2SessionsForConfigChange)`；`getUpstreamWsManager()` 首次被调用时懒订阅 `onUpstreamTransportChange(() => manager?.reconcileForConfigChange(getPooledConnectionIdleTimeoutMs()))`。两层各自只在自己关心的事件里做自己的事，`onUpstreamTransportChange` 是覆盖 5 个字段变化的单一粗粒度事件（P1 已定），意味着"只改了 `softMaxUpstreamWsConnections`"这种与 h2 无关的变化，也会触发一次 h2 的 retire-and-replace（旧会话仍然安全 drain，只是会有一次不必要的连接重建）——这是 P1 单一事件设计的既定代价，本计划照单全收，不在本阶段拆分事件粒度；已在 Self-Review 里记录为 FYI，供主会话知悉，非阻断项。

## Tech Stack

不引入新依赖。继续沿用 P2 的确定性测试范式：真实本地 h2c server（`http2.createServer()`，`tests/transport/http2-client.it.test.ts` 的既有 blackhole/流式模式）+ 真实短间隔定时器（`tests/transport/h2-keepalive-ping.unit.test.ts` 的 `sleep(ms)` + 真实 `setInterval` 模式，不用 fake timers）；WS 侧沿用 `tests/responses/upstream-ws-connection.unit.test.ts` 的 `FakeSocket extends EventTarget implements WebSocketLike` 手写测试替身。

## Global Constraints（摘自 README，逐字对齐）

1. `0` 语义在所有数值旋钮上必须一致——本阶段读取 `getUpstreamH2PingIntervalMs()`/`getUpstreamKeepAliveDelayMs()`/`getPooledConnectionIdleTimeoutMs()` 时复用 P2 已经保证这一致性的读取函数，不重新实现语义判断。
2. **新旋钮只影响新建连接是 P2 范围；已存在连接受配置热更新影响是 P4 的专属职责，且必须是 generation-based retire-and-replace，不是 drain-then-replace**——本阶段正是这条约束落地的地方。
3. **每会话 active-stream 计数必须恰好递减一次**，覆盖所有终止路径——本阶段用 `req.once("close", ...)` 兑现，见 Architecture 节；这条不变量不能只靠"正常 end()"一条路径侧面推断，Task 1 Step 1 新增的四行失败矩阵（pre-header `req.error`/post-header `body.cancel()`/服务端 RST without `end`/整会话销毁）逐一用真实 h2c server 验证每条路径都能让 retiring 会话真的被回收（spec §7 追加，reviewer + 用户裁决，A4）。
4. **正在 retire 的会话的 PING/keepalive 定时器必须存活到 drain 完成**——本阶段的 `retire`/`dispose` 分离设计正是为了保留这条既有不变量，见 Task 1 Step 2 的详细论证。
5. SSOT-types——本阶段不新增跨前后端类型（P5 职责）。
6. PUT 迁移——P3 职责，不涉及。
7. **经验验证（独立 oracle）**：每个 Task 至少一个测试观测真实连接行为变化（新请求真的拿到新会话/新连接的定时器真的被重新 armed/旧会话的在飞流真的不受影响），不能只断言内部状态字段被赋值。
8. 测试隔离：h2 侧复用既有 RESETTER `setHttp2SessionFactoryForTests`（已注册进 `tests/helpers/isolated-fixture.ts`，本阶段扩展 `closeHttp2Sessions()` 一并重置 generation/reconcile 状态，不新增独立的 reset 导出）；WS 侧复用既有 RESETTER `resetUpstreamWsManagerForTests`（generation 计数器是 manager 闭包内部状态，随 manager 整体重建自然归零，无需额外 reset 钩子）。
9. 细粒度提交：每个 Task 完成后 `git commit -F <msgfile> -- <精确路径>`。

## 文件总览

| 文件 | 改动 |
|---|---|
| `src/lib/transport/http2-client.ts` | `sessions` 从 `Map<string, http2.ClientHttp2Session>` 升级为 `Map<string, H2SessionEntry>`（新增内部接口，不导出）；新增 `retiringSessions`/`sessionEntryByHttp2Session`/`currentGeneration`/reconcile 状态三变量；`getSession()` 内部改造为 entry 结构 + `for (;;)` generation 捕获-比较-丢弃-重试循环（HIGH-3），goaway 处理器改为 `retire()`；`runHttp2Fetch` 新增 activeStreamCount 追踪（`req.once("close", ...)`）；新增导出 `reconcileH2SessionsForConfigChange()`（catch 块不重新 throw，只记录 `reconcileState="failed"`/`lastReconcileError` + `consola.error`，HIGH-3 后半句；同时对所有 retiring entry 调 `reschedulePingTimer()` 应用新 ping interval，A3）/`getH2SessionStatusSnapshot()`/`getH2ReconcileStatus()`/`H2SessionStatusRow`；新增私有 `maybeReclaimRetiringSession()`/`reschedulePingTimer()`/`ensureH2ReconcileSubscription()`；`closeHttp2Sessions()` 同步清理 `retiringSessions` + 重置 generation/reconcile 状态；新增 import `onUpstreamTransportChange`、`consola` |
| `src/lib/openai/upstream-ws-connection.ts` | `idleTimeoutMs` 常量改为可变 `effectiveIdleTimeoutMs`；新增闭包变量 `idleSince: number \| undefined`（HIGH-6）；`scheduleIdleClose()` 改为按 `(idleSince ?? Date.now()) + effectiveIdleTimeoutMs` 绝对 deadline 调度；新增统一的"标记为 idle"包装（写 `idleSince` + 调 `opts.onIdle?.()` + 调 `scheduleIdleClose()`），替换 `onOpen` 成功回调与 `finishRequest()` 里对 `scheduleIdleClose()` 的直接调用；`sendRequest()` 标记 busy 时清空 `idleSince`；`CreateUpstreamWsConnectionOptions` 新增 `onIdle?: () => void`（HIGH-5）；`UpstreamWsConnection` 接口新增 `rescheduleIdleTimeout(newIdleTimeoutMs: number): void`；返回对象新增该方法实现 |
| `src/lib/openai/upstream-ws.ts` | `UpstreamWsManager` 接口新增 `reconcileForConfigChange(newIdleTimeoutMs: number): void`/`statusSnapshot(): ReadonlyArray<UpstreamWsStatusRow>`；`createUpstreamWsManager()` 新增闭包内 `connectionGeneration: Map<string, number>` + `currentGeneration` 计数器 + 两个方法实现；`reconcileForConfigChange()` 的驱逐改为按"需要驱逐的数量"计数循环（`evictExcessIdleConnections`），不依赖 `connections.size` 同步缩小；`create()` 新增 `onIdle: () => evictOneIdleIfNeeded()` 接线（busy→idle 转换即时触发既有 eviction 检查，HIGH-5）；`create()`/`onClose`/`closeAll()` 同步维护 `connectionGeneration`；新增导出 `UpstreamWsStatusRow`/`getUpstreamWsStatusSnapshot(manager)`；`getUpstreamWsManager()` 新增懒加载订阅 `onUpstreamTransportChange`；新增 import `onUpstreamTransportChange` |
| 新增 `tests/transport/http2-generation-reconcile.it.test.ts` | h2 侧 generation-based retire-and-replace 的完整独立 oracle：新请求拿新会话、在飞流不受影响、状态快照/reconcile 状态正确、keepalive 定时器存活到 drain 完成、config-reload race 期间的 connect 被丢弃重试（HIGH-3）、reconcile 内部异常不向上抛（HIGH-3） |
| `tests/responses/upstream-ws-connection.unit.test.ts` | 追加 `rescheduleIdleTimeout` 的真实定时器行为断言（含 idleSince 保留原起点重调、新 deadline 已过立即关闭两个边界场景，HIGH-6）+ `onIdle` 回调在 busy→idle 转换时被调用的断言（HIGH-5） |
| `tests/responses/upstream-ws.unit.test.ts` | 追加 `reconcileForConfigChange`/`statusSnapshot` 的行为断言 + busy→idle 转换自动触发驱逐超额连接的断言（HIGH-5） |

---

## Task 1 — h2 会话 generation-based retire-and-replace

**Files**
- Modify: `/home/xp/src/copilot-api-js/src/lib/transport/http2-client.ts:25-68`（import + 常量/池数据结构区）、`:189-273`（`scheduleH2KeepalivePing` 邻近 + `getSession`）、`:358-492`（`http2Fetch`/`runHttp2Fetch`）、`:494-509`（`closeHttp2Sessions`）
- New: `/home/xp/src/copilot-api-js/tests/transport/http2-generation-reconcile.it.test.ts`

**Interfaces**（新增导出，逐字对齐 README「P4 产出，P5 消费」）
```ts
export interface H2SessionStatusRow {
  origin: string
  generation: number
  lifecycle: "active" | "retiring"
  activeStreamCount: number
  effectivePingIntervalMs: number
  effectiveKeepAliveMs: number | undefined
}
export function getH2SessionStatusSnapshot(): ReadonlyArray<H2SessionStatusRow>
export function getH2ReconcileStatus(): { state: "idle" | "running" | "failed"; lastCompletedGeneration: number; lastError: string | null }
export function reconcileH2SessionsForConfigChange(): void
```
内部（非导出，不是跨阶段契约）：
```ts
interface H2SessionEntry {
  session: http2.ClientHttp2Session
  origin: string
  generation: number
  lifecycle: "active" | "retiring"
  activeStreamCount: number
  pingTimer: NodeJS.Timeout | undefined
  effectivePingIntervalMs: number
  effectiveKeepAliveMs: number | undefined
}
function reschedulePingTimer(entry: H2SessionEntry, intervalMs: number): void
```

### Step 1 — 写失败测试：reconcile 后新请求拿到新会话、旧会话在飞流不受影响、ping cadence 热切换（A3）、四类终止路径 exactly-once（A4）

在 `/home/xp/src/copilot-api-js/tests/transport/http2-generation-reconcile.it.test.ts` 新建：

```ts
/**
 * h2 generation-based retire-and-replace — the independent oracle for global
 * constraint #2 (P4 owns reconciling ALREADY-established sessions on config
 * hot-reload; P1-P3 must not pre-empt this) and #4 (a retiring session's
 * keepalive PING timer survives until its in-flight streams drain). Uses a
 * real local h2c server (same harness as http2-client.it.test.ts) — never
 * asserts only on internal state, always on observable behaviour: which real
 * TCP session a NEW request lands on, and whether an IN-FLIGHT stream on the
 * old session keeps receiving bytes.
 */

import type { AddressInfo } from "node:net"

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import http2 from "node:http2"

import {
  //
  closeHttp2Sessions,
  getH2ReconcileStatus,
  getH2SessionStatusSnapshot,
  http2Fetch,
  reconcileH2SessionsForConfigChange,
  setHttp2SessionFactoryForTests,
} from "~/lib/transport/http2-client"
import { setUpstreamTransportConfig } from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

let server: http2.Http2Server
let url: string
const serverSessions = new Set<http2.ServerHttp2Session>()

type Handler = (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void
let handler: Handler

beforeEach(async () => {
  server = http2.createServer()
  server.on("session", (s) => serverSessions.add(s))
  server.on("stream", (stream, headers) => handler(stream, headers))
  server.on("sessionError", () => {})
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  url = `http://127.0.0.1:${port}`
  // Fresh h2c connect per call — mirrors production's proxy-agnostic
  // createSession, but cleartext for the test harness.
  setHttp2SessionFactoryForTests(() => http2.connect(url))
})

afterEach(async () => {
  setHttp2SessionFactoryForTests(undefined)
  closeHttp2Sessions()
  for (const s of serverSessions) {
    try {
      s.destroy()
    } catch {
      /* already gone */
    }
  }
  serverSessions.clear()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe("h2 generation-based retire-and-replace", () => {
  autoRestoreState()

  test("reconcile moves the active session to retiring; the NEXT request opens a fresh session", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.end("ok")
    }

    // First request establishes generation-0 session for this origin.
    await http2Fetch(`${url}/a`, {})
    const before = getH2SessionStatusSnapshot()
    expect(before).toHaveLength(1)
    expect(before[0].lifecycle).toBe("active")
    const generationBefore = before[0].generation

    reconcileH2SessionsForConfigChange()

    // Old session is now retiring (no in-flight stream, so it gets reclaimed
    // synchronously by maybeReclaimRetiringSession — it disappears from the
    // snapshot once its own `close` handler runs, which the h2 stack fires
    // asynchronously; poll briefly for that to settle before asserting).
    for (let i = 0; i < 20 && getH2SessionStatusSnapshot().length > 0; i++) await sleep(5)
    expect(getH2SessionStatusSnapshot()).toHaveLength(0)

    // The NEXT request must open a brand-new session at the new generation —
    // not reuse the retired one (would be a silent config-hot-reload no-op).
    await http2Fetch(`${url}/b`, {})
    const after = getH2SessionStatusSnapshot()
    expect(after).toHaveLength(1)
    expect(after[0].generation).toBe(generationBefore + 1)
    expect(after[0].lifecycle).toBe("active")
  })

  test("reconcile does NOT disturb an in-flight stream on the old session", async () => {
    let releaseServerStream: (() => void) | undefined
    const serverStreamReleased = new Promise<void>((resolve) => {
      releaseServerStream = resolve
    })
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.write("first-chunk")
      // Hold the stream open until the test explicitly releases it, so the
      // request is still in-flight when reconcile runs.
      void serverStreamReleased.then(() => stream.end("last-chunk"))
    }

    const responsePromise = http2Fetch(`${url}/slow`, {})
    // Give the request time to reach the server and start streaming.
    await sleep(30)

    reconcileH2SessionsForConfigChange()
    const duringDrain = getH2SessionStatusSnapshot()
    expect(duringDrain).toHaveLength(1)
    expect(duringDrain[0].lifecycle).toBe("retiring")
    expect(duringDrain[0].activeStreamCount).toBe(1)

    releaseServerStream?.()
    const res = await responsePromise
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe("first-chunklast-chunk")

    // Once the stream drained, the retiring entry is reclaimed (closed).
    for (let i = 0; i < 20 && getH2SessionStatusSnapshot().length > 0; i++) await sleep(5)
    expect(getH2SessionStatusSnapshot()).toHaveLength(0)
  })

  test("getH2ReconcileStatus reflects idle -> running -> idle with a bumped lastCompletedGeneration", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.end("ok")
    }
    await http2Fetch(`${url}/a`, {})
    const before = getH2ReconcileStatus()
    reconcileH2SessionsForConfigChange()
    const after = getH2ReconcileStatus()
    expect(after.state).toBe("idle")
    expect(after.lastCompletedGeneration).toBe(before.lastCompletedGeneration + 1)
    expect(after.lastError).toBeNull()
  })

  test("a connect racing a reconcile is discarded and retried — the caller never gets a session stamped with a stale generation (HIGH-3)", async () => {
    // Make the h2c handshake itself slow enough to reliably straddle a
    // reconcile call, so this is a real race on the wall clock, not a
    // hand-waved "assume it can happen" comment.
    let connectCount = 0
    setHttp2SessionFactoryForTests(async () => {
      connectCount += 1
      await sleep(30)
      return http2.connect(url)
    })
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.end("ok")
    }

    const fetchPromise = http2Fetch(`${url}/racing`, {})
    // Let the slow "connect" start (connectCount becomes 1) before reconciling.
    await sleep(10)
    reconcileH2SessionsForConfigChange()
    const generationAfterReconcile = getH2ReconcileStatus().lastCompletedGeneration

    const res = await fetchPromise
    expect(res.ok).toBe(true)

    // The in-flight connect that started under the OLD generation must have
    // been discarded and retried — proven by it actually reconnecting (a
    // second real TCP handshake), not merely by an internal counter.
    expect(connectCount).toBeGreaterThanOrEqual(2)
    const rows = getH2SessionStatusSnapshot()
    expect(rows).toHaveLength(1)
    expect(rows[0].lifecycle).toBe("active")
    expect(rows[0].generation).toBe(generationAfterReconcile)
  })

  test("reconcile reschedules a RETIRING session's PING timer to the freshly configured interval — positive -> 0 stops further pings without closing the session or disturbing the in-flight stream (spec §7 HIGH addition, A3)", async () => {
    setUpstreamTransportConfig({ upstreamH2PingInterval: 15 })
    const pingSpy = mock((cb: () => void) => cb())
    setHttp2SessionFactoryForTests(() => {
      const s = http2.connect(url)
      // Real session, spied `.ping` — scheduleH2KeepalivePing calls session.ping()
      // on its interval, so this observes REAL scheduled invocations, not an
      // internal flag. Mirrors h2-keepalive-ping.unit.test.ts's fake-session
      // pattern, but on a real connected session (this test needs the session
      // to also carry a real in-flight stream).
      s.ping = pingSpy as unknown as typeof s.ping
      return s
    })

    let releaseServerStream: (() => void) | undefined
    const serverStreamReleased = new Promise<void>((resolve) => {
      releaseServerStream = resolve
    })
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.write("first-chunk")
      void serverStreamReleased.then(() => stream.end("last-chunk"))
    }

    const responsePromise = http2Fetch(`${url}/reschedule-to-zero`, {})
    await sleep(30) // request reaches server; session+entry created at the 15ms cadence

    await sleep(40) // ~2-3 ticks at the OLD 15ms cadence before reconcile
    const callsBeforeReconcile = pingSpy.mock.calls.length
    expect(callsBeforeReconcile).toBeGreaterThanOrEqual(2)

    // Config change: ping interval 15 -> 0 (disable). The production wiring
    // would fire this via the onUpstreamTransportChange subscription; call
    // reconcile directly (as the other tests in this file do) so the
    // assertion is decoupled from that subscription wiring.
    setUpstreamTransportConfig({ upstreamH2PingInterval: 0 })
    reconcileH2SessionsForConfigChange()

    const retiring = getH2SessionStatusSnapshot()
    expect(retiring).toHaveLength(1)
    expect(retiring[0].lifecycle).toBe("retiring")
    expect(retiring[0].effectivePingIntervalMs).toBe(0)
    // The reschedule must NOT close the session or disturb its in-flight
    // stream's accounting — only the ping cadence changes.
    expect(retiring[0].activeStreamCount).toBe(1)

    const callsAtReconcile = pingSpy.mock.calls.length
    await sleep(45) // long enough for several old-cadence ticks if NOT actually cancelled
    expect(pingSpy.mock.calls.length).toBe(callsAtReconcile) // no further pings

    // The in-flight stream must still complete intact through the retiring
    // session — proves reschedule-to-zero didn't close() the session.
    releaseServerStream?.()
    const res = await responsePromise
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe("first-chunklast-chunk")
  })

  test("reconcile reschedules a RETIRING session's PING timer to a NEW positive interval — old cadence stops, new cadence starts, in-flight stream still drains intact (spec §7 HIGH addition, A3)", async () => {
    setUpstreamTransportConfig({ upstreamH2PingInterval: 500 }) // slow enough it will not have fired yet at the assertion point below
    const pingSpy = mock((cb: () => void) => cb())
    setHttp2SessionFactoryForTests(() => {
      const s = http2.connect(url)
      s.ping = pingSpy as unknown as typeof s.ping
      return s
    })

    let releaseServerStream: (() => void) | undefined
    const serverStreamReleased = new Promise<void>((resolve) => {
      releaseServerStream = resolve
    })
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.write("first-chunk")
      void serverStreamReleased.then(() => stream.end("last-chunk"))
    }

    const responsePromise = http2Fetch(`${url}/reschedule-to-new-positive`, {})
    await sleep(30)
    expect(pingSpy.mock.calls.length).toBe(0) // the 500ms cadence has not ticked yet

    setUpstreamTransportConfig({ upstreamH2PingInterval: 15 }) // much faster new cadence
    reconcileH2SessionsForConfigChange()

    const retiring = getH2SessionStatusSnapshot()
    expect(retiring).toHaveLength(1)
    expect(retiring[0].lifecycle).toBe("retiring")
    expect(retiring[0].effectivePingIntervalMs).toBe(15)
    expect(retiring[0].activeStreamCount).toBe(1)

    // ~3 ticks at the NEW 15ms cadence within this window proves the OLD
    // 500ms timer was actually replaced (not merely left running alongside
    // a second one, which this assertion would also fail to distinguish
    // from — but a stale 500ms timer contributes 0 calls in this window
    // regardless, so >=2 calls here is solely attributable to the new timer).
    await sleep(55)
    expect(pingSpy.mock.calls.length).toBeGreaterThanOrEqual(2)

    releaseServerStream?.()
    const res = await responsePromise
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe("first-chunklast-chunk")
  })
})

// A4（spec 全局约束 #3 + #4 组合）——activeStreamCount 的 exactly-once 递减必须在
// 全部四类真实终止路径下都成立，不能只靠"正常 end()"这一条路径侧面推断。矩阵：
//
// | # | 场景 | 触发方 | 触发点 | http2Fetch 的 Promise |
// |---|------|--------|--------|------------------------|
// | 1 | pre-header `req.error` | 服务端 | 响应头之前，销毁底层会话 | reject |
// | 2 | post-header `body.cancel()` | 客户端 | 收到响应头之后，主动取消 body reader | resolve，之后读体报错/中止 |
// | 3 | RST without `end` | 服务端 | 收到响应头之后，`stream.close(code)` 但从不调 `.end()` | resolve，之后读体报错 |
// | 4 | session close/reset | 服务端 | 收到响应头之后，销毁整个 h2 会话（不只是这一条流） | resolve，之后读体报错 |
//
// 四行的触发时机/触发方结构性不同（行 1 在响应头之前、无法先 `await` 到 Response；
// 行 2-4 都在响应头之后，但行 2 是客户端主动取消、行 3-4 是服务端单方终止），
// 不适合硬套同一个 `test.each` 参数化模板——所以写成四个独立 `test()`，但共享同一
// 个可观测的后置断言：这个会话在 reconcile 后已经是 `retiring`（唯一一条流），无论
// 走哪条终止路径，这条 retiring 的 entry 最终必须从 `getH2SessionStatusSnapshot()`
// 里彻底消失（`activeStreamCount` 精确归零 → `maybeReclaimRetiringSession` 才会真的
// `close()` 它）——如果 Step 4 的 `req.once("close")` 记账在某条路径下没有触发（例如
// Bun 对某种终止的 h2 事件行为与 Node 不同，这正是本文件其它地方已经记录过的已知
// Bun 差异——见 `tests/transport/http2-client.it.test.ts` 里 rstCode=0 的注释），这个
// entry 会永远卡在 `retiringSessions` 里、快照永远非空——测试会在轮询超时后失败，
// 而不是被内部计数器"看起来对了"糊弄过去。
describe("activeStreamCount exactly-once across every real stream-termination path (spec constraint #3 x #4, A4)", () => {
  autoRestoreState()

  const waitForReclaim = async (): Promise<void> => {
    for (let i = 0; i < 40 && getH2SessionStatusSnapshot().length > 0; i++) await sleep(5)
    expect(getH2SessionStatusSnapshot()).toHaveLength(0)
  }

  test("row 1 — pre-header req.error (server destroys the underlying session before any response headers)", async () => {
    let serverStream: http2.ServerHttp2Stream | undefined
    handler = (stream) => {
      serverStream = stream
      // Never respond — this row's client is still waiting for headers when
      // the underlying transport is forced to error out from under it.
    }

    const fetchPromise = http2Fetch(`${url}/matrix-pre-header-error`, {})
    await sleep(30) // let the stream actually open server-side before we snapshot
    const before = getH2SessionStatusSnapshot()
    expect(before).toHaveLength(1)
    expect(before[0].activeStreamCount).toBe(1)

    reconcileH2SessionsForConfigChange()
    expect(getH2SessionStatusSnapshot()[0]?.lifecycle).toBe("retiring")

    // Force a genuine pre-header client-side `req` error (not a fabricated
    // event) by destroying the SERVER session's socket — the client's
    // `req.once("error", ...)` at http2-client.ts:484 is what turns this into
    // a rejection, since no `response` was ever received.
    serverStream?.session.destroy(new Error("simulated pre-header transport failure"))

    await expect(fetchPromise).rejects.toThrow()
    await waitForReclaim()
  })

  test("row 2 — post-header body.cancel() (client cancels the response body reader after headers arrive)", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.write("first-chunk")
      // Never end() — this row's stream terminates via the CLIENT cancelling
      // the body reader, not via any server-side action.
    }

    const res = await http2Fetch(`${url}/matrix-post-header-cancel`, {})
    expect(getH2SessionStatusSnapshot()[0]?.activeStreamCount).toBe(1)

    reconcileH2SessionsForConfigChange()
    expect(getH2SessionStatusSnapshot()[0]?.lifecycle).toBe("retiring")

    // The ReadableStream adapter's cancel() calls req.close(NGHTTP2_CANCEL) —
    // http2-client.ts:473-475.
    await res.body!.cancel()
    await waitForReclaim()
  })

  test("row 3 — server RST_STREAM without end() (upstream resets the stream but never finishes it)", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.write("first-chunk")
      setTimeout(() => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR), 20)
    }

    const res = await http2Fetch(`${url}/matrix-server-rst`, {})
    expect(getH2SessionStatusSnapshot()[0]?.activeStreamCount).toBe(1)

    reconcileH2SessionsForConfigChange()
    expect(getH2SessionStatusSnapshot()[0]?.lifecycle).toBe("retiring")

    // The body adapter's own close-before-end backstop (http2-client.ts:463-471)
    // turns this into a read error for the CONSUMER — this row only cares
    // whether the SEPARATE Step-4 bookkeeping listener also decremented.
    await res.text().catch(() => {
      /* expected: a reset-without-end body surfaces as a read error, not this row's concern */
    })
    await waitForReclaim()
  })

  test("row 4 — whole session destroyed mid-stream (upstream connection drop, not just this stream)", async () => {
    let serverSession: http2.ServerHttp2Session | undefined
    handler = (stream) => {
      serverSession = stream.session
      stream.respond({ ":status": 200 })
      stream.write("first-chunk")
      // Never end() — the whole session dies out from under this stream instead.
    }

    const res = await http2Fetch(`${url}/matrix-session-destroy`, {})
    expect(getH2SessionStatusSnapshot()[0]?.activeStreamCount).toBe(1)

    reconcileH2SessionsForConfigChange()
    expect(getH2SessionStatusSnapshot()[0]?.lifecycle).toBe("retiring")

    serverSession?.destroy(new Error("simulated upstream session drop"))

    await res.text().catch(() => {
      /* expected: whole-session teardown surfaces as a read error on the open body */
    })
    await waitForReclaim()
  })
})
```

跑 `bun test tests/transport/http2-generation-reconcile.it.test.ts` 确认失败（`getH2ReconcileStatus`/`getH2SessionStatusSnapshot`/`reconcileH2SessionsForConfigChange` 尚未导出，导入报错；新增的两个 reschedule 测试同样因 `reschedulePingTimer` 尚不存在、reconcile 尚未调用它而失败——退休后 `effectivePingIntervalMs` 仍是创建时的旧值，且旧定时器继续按旧 cadence 触发，导致这两个新断言不成立；A4 的四行矩阵测试此时 `activeStreamCount` 恒为 `0`——Step 4 才接线，`before[0].activeStreamCount).toBe(1)` 这类断言会失败）。

### Step 2 — 实现：`H2SessionEntry` + 池结构升级

编辑 `src/lib/transport/http2-client.ts`。

把第 65-70 行：
```ts
/** One multiplexed h2 session per origin (resolved + live). */
const sessions = new Map<string, http2.ClientHttp2Session>()
/** In-flight session creations, so concurrent requests to one origin share a connect. */
const pending = new Map<string, Promise<http2.ClientHttp2Session>>()
/** Bumped by {@link closeHttp2Sessions}; lets an in-flight creation detect a shutdown that raced it. */
let poolEpoch = 0
```
替换为：
```ts
/** Per-origin h2 session tracking, generation-based retire-and-replace (P4). Not exported — {@link getSession} keeps returning a bare session. */
interface H2SessionEntry {
  session: http2.ClientHttp2Session
  origin: string
  generation: number
  lifecycle: "active" | "retiring"
  activeStreamCount: number
  pingTimer: NodeJS.Timeout | undefined
  effectivePingIntervalMs: number
  effectiveKeepAliveMs: number | undefined
}

/** One multiplexed h2 session per origin (resolved + live, routable for new requests). */
const sessions = new Map<string, H2SessionEntry>()
/**
 * Entries that left the routable pool (config hot-reload OR upstream GOAWAY)
 * but still have in-flight streams draining. Their `pingTimer` keeps running —
 * see {@link getSession}'s `retire`/`dispose` split for why.
 */
const retiringSessions = new Set<H2SessionEntry>()
/** Reverse lookup so {@link runHttp2Fetch} can track per-entry active stream count without threading the entry through the whole request path. */
const sessionEntryByHttp2Session = new WeakMap<http2.ClientHttp2Session, H2SessionEntry>()
/** In-flight session creations, so concurrent requests to one origin share a connect. */
const pending = new Map<string, Promise<http2.ClientHttp2Session>>()
/** Bumped by {@link closeHttp2Sessions}; lets an in-flight creation detect a shutdown that raced it. */
let poolEpoch = 0
/** Bumped by {@link reconcileH2SessionsForConfigChange}; stamped onto every entry created afterward. */
let currentGeneration = 0
let reconcileState: "idle" | "running" | "failed" = "idle"
let lastCompletedGeneration = 0
let lastReconcileError: string | null = null
```

### Step 3 — 实现：`getSession()` 改造为 entry 结构 + `retire`/`dispose` 分离 + generation 捕获-比较-丢弃-重试循环

把第 217-273 行的 `getSession` 整体替换为：
```ts
async function getSession(origin: string): Promise<http2.ClientHttp2Session> {
  ensureH2ReconcileSubscription()

  const live = sessions.get(origin)
  if (live && !live.session.closed && !live.session.destroyed) return live.session

  const inflight = pending.get(origin)
  if (inflight) return inflight

  const creation = (async (): Promise<http2.ClientHttp2Session> => {
    // Loop (not recursion into getSession()) so a config-reload race (below)
    // retries within the SAME creation frame/pending-map entry. Recursing into
    // getSession() would open a second, independent pending.set/delete bracket;
    // in the microtask window between the two frames, a third-party caller's
    // freshly-inserted pending entry could be deleted by the OUTER frame's
    // now-stale `finally` — a real race, not a hypothetical one. A single loop
    // has exactly one pending.set/delete pair for the whole retry sequence.
    for (;;) {
      const epochAtStart = poolEpoch
      // Captured BEFORE the (possibly slow) connect — compared after it
      // resolves to detect a reconcile that raced this creation (HIGH-3).
      const generationAtStart = currentGeneration
      // withErrorSink at the point we take ownership of the session (works for the
      // prod factory AND an injected test factory): guards every session teardown —
      // the shutdown-race close below, an eventual socket RST — against an orphaned
      // 'error' → uncaughtException → server crash. See crash-safety.ts.
      const session = withErrorSink(await sessionFactory(origin))
      // If closeHttp2Sessions() ran while this session was being established (shutdown
      // drain racing a new tunnel handshake), don't re-insert it into the just-cleared
      // pool — close it instead, so it doesn't leak as an orphaned open session.
      if (poolEpoch !== epochAtStart) {
        try {
          session.close()
        } catch {
          /* best-effort */
        }
        return session
      }
      // A reconcile ran while sessionFactory's connect was in flight. The
      // connection-level params (keepAliveMs/connectTimeoutMs) are fixed at
      // sessionFactory's own entry point, BEFORE the socket/TLS handshake
      // completes (P2) — so this session may already have been established
      // with STALE config even though currentGeneration has since moved on.
      // Admitting it as "generation = currentGeneration" would make
      // H2SessionStatusRow lie about which config it actually used. Discard
      // it and retry: the next loop iteration calls sessionFactory again,
      // which reads the now-settled (post-reconcile) config from scratch.
      if (currentGeneration !== generationAtStart) {
        try {
          session.close()
        } catch {
          /* best-effort */
        }
        continue
      }
      // Read fresh at entry-creation time (after the possibly-slow proxy/TLS
      // handshake) so a config change that raced this creation is honored —
      // same "no caching across calls" contract P2 already established for
      // createSession's own reads of these functions.
      const effectivePingIntervalMs = getUpstreamH2PingIntervalMs()
      const effectiveKeepAliveMs = getUpstreamKeepAliveDelayMs()
      // The factory (test or prod) owns connection setup; pool management is shared.
      // Two distinct responsibilities, split by event: `retire` stops routing NEW
      // requests to this session (goaway OR a config-hot-reload reconcile — a
      // GOAWAY'd/retired session must not take new streams); `dispose` (error/close)
      // is the only place that clears the keepalive PING timer. A GOAWAY/retire does
      // NOT destroy the session — its already-in-flight streams keep running, so the
      // keepalive must keep pinging them until `close` fires (guaranteed to follow,
      // and clears the timer then). Clearing on retire would strand a draining
      // long-thinking stream in exactly the silence this keepalive exists to defeat.
      const pingTimer = scheduleH2KeepalivePing(session, effectivePingIntervalMs)
      const entry: H2SessionEntry = {
        session,
        origin,
        generation: currentGeneration, // === generationAtStart, confirmed above
        lifecycle: "active",
        activeStreamCount: 0,
        pingTimer,
        effectivePingIntervalMs,
        effectiveKeepAliveMs,
      }
      sessionEntryByHttp2Session.set(session, entry)
      const dispose = (): void => {
        if (entry.pingTimer) clearInterval(entry.pingTimer)
        if (sessions.get(origin) === entry) sessions.delete(origin)
        retiringSessions.delete(entry)
      }
      const retire = (): void => {
        if (sessions.get(origin) === entry) sessions.delete(origin)
        if (entry.lifecycle === "active") {
          entry.lifecycle = "retiring"
          retiringSessions.add(entry)
        }
      }
      session.on("error", dispose)
      session.on("close", dispose)
      session.on("goaway", retire)
      session.unref()
      sessions.set(origin, entry)
      return session
    }
  })()

  pending.set(origin, creation)
  try {
    return await creation
  } finally {
    pending.delete(origin)
  }
}

/** Lazily subscribe (once) to `onUpstreamTransportChange`, mirroring proxy.ts's `ensureTimeoutSubscription()`. */
let h2ReconcileSubscriptionInstalled = false
function ensureH2ReconcileSubscription(): void {
  if (h2ReconcileSubscriptionInstalled) return
  onUpstreamTransportChange(reconcileH2SessionsForConfigChange)
  h2ReconcileSubscriptionInstalled = true
}

/**
 * If a retiring entry has no more in-flight streams, close it now instead of
 * leaving it to linger indefinitely (a GOAWAY'd/retired h2 session with no new
 * streams and no peer-initiated close can otherwise sit open forever).
 */
function maybeReclaimRetiringSession(entry: H2SessionEntry): void {
  if (entry.lifecycle !== "retiring") return
  if (entry.activeStreamCount > 0) return
  try {
    entry.session.close()
  } catch {
    /* best-effort — the session's own close/error handler still runs dispose() */
  }
}

/**
 * Replace an entry's keepalive PING timer with one at `intervalMs`, clearing
 * whatever was running before (spec §7 addition, reviewer + user decision:
 * a config-driven `ping_interval` change must reach RETIRING sessions too, not
 * just sessions created after the reconcile). `intervalMs <= 0` cancels the
 * timer (via {@link scheduleH2KeepalivePing}'s own `<= 0` guard) WITHOUT
 * closing the session or touching `activeStreamCount` — an in-flight stream on
 * a retiring session keeps draining exactly as before, it just stops being
 * pinged. This is the one exception to "retire never clears pingTimer" (see
 * the goaway/retiring invariant note above `getSession()`): that invariant is
 * about NOT losing keepalive coverage silently on retire; this function is an
 * explicit, observable, config-driven replacement of the cadence itself, not a
 * silent loss of coverage — the new cadence (possibly 0, honestly reported)
 * is what `effectivePingIntervalMs` on the status row reflects afterward.
 */
function reschedulePingTimer(entry: H2SessionEntry, intervalMs: number): void {
  if (entry.pingTimer) clearInterval(entry.pingTimer)
  entry.pingTimer = scheduleH2KeepalivePing(entry.session, intervalMs)
  entry.effectivePingIntervalMs = intervalMs
}

/**
 * Hot-reload reconcile (P4): move every currently-routable session to
 * "retiring" and bump the generation counter, so the VERY NEXT request to each
 * origin opens a brand-new session that reads fresh config (keepalive delay,
 * h2 ping interval). Already-in-flight streams on the retired sessions are
 * completely unaffected — they keep running on their original session until
 * they finish naturally (drain), per global constraint #2 (retire-and-replace,
 * never drain-then-replace). The one exception is the PING cadence itself:
 * {@link reschedulePingTimer} applies the freshly configured
 * `getUpstreamH2PingIntervalMs()` to every entry being retired here, so a
 * `ping_interval` change is honored immediately even by sessions still
 * draining — not deferred until their eventual replacement takes over.
 *
 * Must NEVER throw (HIGH-3): this function runs as one of possibly several
 * synchronous listeners inside state.ts's `setTimeoutConfig()` listener loop
 * (`for (const listener of requestWatchdogListeners) listener()` — no
 * try/catch there). A thrown error here would abort that loop and silently
 * skip every listener registered after this one (including the WS-side
 * reconcile listener and proxy.ts's dispatcher-rebuild listener), even though
 * the config change itself already applied successfully. So any failure is
 * caught, recorded (state + a logged message — never silently swallowed), and
 * NOT re-thrown; observability comes from `getH2ReconcileStatus()` (P5), not
 * from an exception the config-apply path would have to handle.
 */
export function reconcileH2SessionsForConfigChange(): void {
  reconcileState = "running"
  try {
    currentGeneration += 1
    const freshPingIntervalMs = getUpstreamH2PingIntervalMs()
    for (const [origin, entry] of sessions) {
      sessions.delete(origin)
      if (entry.lifecycle === "active") {
        entry.lifecycle = "retiring"
        retiringSessions.add(entry)
      }
      reschedulePingTimer(entry, freshPingIntervalMs)
      maybeReclaimRetiringSession(entry)
    }
    // Entries already retiring from an EARLIER event (a prior reconcile, or an
    // upstream-initiated GOAWAY) are a config change's concern too — the fresh
    // ping cadence must reach every draining session, not just the ones this
    // particular reconcile call is newly retiring.
    for (const entry of retiringSessions) reschedulePingTimer(entry, freshPingIntervalMs)
    lastCompletedGeneration = currentGeneration
    lastReconcileError = null
    reconcileState = "idle"
  } catch (err) {
    reconcileState = "failed"
    lastReconcileError = err instanceof Error ? err.message : String(err)
    consola.error(`[http2-client] reconcileH2SessionsForConfigChange failed (generation=${currentGeneration}): ${lastReconcileError}`)
    // Deliberately NOT re-thrown — see the doc comment above.
  }
}

/** Per-origin h2 session status row for /api/status (P5). */
export interface H2SessionStatusRow {
  origin: string
  generation: number
  lifecycle: "active" | "retiring"
  activeStreamCount: number
  effectivePingIntervalMs: number
  effectiveKeepAliveMs: number | undefined
}

function entryToStatusRow(entry: H2SessionEntry): H2SessionStatusRow {
  return {
    origin: entry.origin,
    generation: entry.generation,
    lifecycle: entry.lifecycle,
    activeStreamCount: entry.activeStreamCount,
    effectivePingIntervalMs: entry.effectivePingIntervalMs,
    effectiveKeepAliveMs: entry.effectiveKeepAliveMs,
  }
}

export function getH2SessionStatusSnapshot(): ReadonlyArray<H2SessionStatusRow> {
  const rows: Array<H2SessionStatusRow> = []
  for (const entry of sessions.values()) rows.push(entryToStatusRow(entry))
  for (const entry of retiringSessions) rows.push(entryToStatusRow(entry))
  return rows
}

export function getH2ReconcileStatus(): { state: "idle" | "running" | "failed"; lastCompletedGeneration: number; lastError: string | null } {
  return { state: reconcileState, lastCompletedGeneration, lastError: lastReconcileError }
}
```

在文件顶部 import 区块新增 `onUpstreamTransportChange` 与 `consola`（`reconcileH2SessionsForConfigChange` 的 catch 块需要打印日志，见上）：
```ts
import consola from "consola"

import {
  //
  getProxyUrlForOrigin,
  getUpstreamH2PingIntervalMs,
  getUpstreamKeepAliveDelayMs,
} from "~/lib/proxy"
import { onUpstreamTransportChange } from "~/lib/state"
```
（执行者先跑 `grep -n "^import" src/lib/transport/http2-client.ts` 确认是否已有 `consola` import——若已存在（例如被其他既有代码引入）则不要重复添加，只需新增 `onUpstreamTransportChange`。）

跑 `bun test tests/transport/http2-generation-reconcile.it.test.ts`——此时 `reconcileH2SessionsForConfigChange`/`getH2SessionStatusSnapshot`/`getH2ReconcileStatus` 已存在，但 `activeStreamCount` 恒为 `0`（Step 4 才接线），第二个测试（"does NOT disturb an in-flight stream"）会在 `expect(duringDrain[0].activeStreamCount).toBe(1)` 处失败——记录这是预期的中间态，继续做 Step 4。

### Step 4 — 实现：`runHttp2Fetch` 里用 `req.once("close")` 追踪 `activeStreamCount`

在 `src/lib/transport/http2-client.ts` 的 `runHttp2Fetch` 里，找到第 393 行 `const req = session.request(headers)`，紧接着插入：
```ts
const req = session.request(headers)

// activeStreamCount bookkeeping (P4): Node guarantees `close` fires exactly
// once per h2 stream regardless of outcome (normal end / RST / abort before or
// after headers) — using this single platform-guaranteed event, instead of
// hand-decrementing on every distinct termination path below, is what makes
// global constraint #3 ("exactly-once decrement, every path") hold without
// manually enumerating every path.
const streamEntry = sessionEntryByHttp2Session.get(session)
if (streamEntry) {
  streamEntry.activeStreamCount += 1
  req.once("close", () => {
    streamEntry.activeStreamCount -= 1
    maybeReclaimRetiringSession(streamEntry)
  })
}
```

跑 `bun test tests/transport/http2-generation-reconcile.it.test.ts` 确认全部通过。

### Step 5 — 实现：`closeHttp2Sessions()` 同步清理 `retiringSessions` + 重置 generation/reconcile 状态

把第 494-509 行的 `closeHttp2Sessions` 替换为：
```ts
/** Close all pooled sessions (active + retiring). Called on graceful shutdown, and by `setHttp2SessionFactoryForTests` (test isolation). */
export function closeHttp2Sessions(): void {
  poolEpoch++ // signal in-flight creations to self-close instead of re-inserting
  for (const entry of sessions.values()) {
    try {
      entry.session.close()
    } catch {
      /* best-effort */
    }
  }
  sessions.clear()
  for (const entry of retiringSessions) {
    try {
      entry.session.close()
    } catch {
      /* best-effort */
    }
  }
  retiringSessions.clear()
  // Drop tracking of in-flight creations; their sessions are unref'd and will be
  // closed by their own error handling / GC. Callers drain before close, so this
  // is normally already empty.
  pending.clear()
  // Reset generation/reconcile bookkeeping — a fully-closed pool has no
  // meaningful "in-progress reconcile" state, and per-test isolation (this
  // function backs the `setHttp2SessionFactoryForTests` RESETTER) requires a
  // fresh generation counter so absolute-generation assertions don't leak
  // across test files sharing this module.
  currentGeneration = 0
  reconcileState = "idle"
  lastCompletedGeneration = 0
  lastReconcileError = null
}
```

跑 `bun test tests/transport/http2-generation-reconcile.it.test.ts tests/transport/http2-client.it.test.ts tests/transport/h2-keepalive-ping.unit.test.ts` 确认全部通过（既有 it.test.ts 覆盖的 goaway-free 场景不受影响，因为 `retire`/`dispose` 分离原样保留了既有 error/close/goaway 的可观察行为）。

### Step 6 — 类型检查 + lint

```
bun run typecheck
bunx eslint src/lib/transport/http2-client.ts tests/transport/http2-generation-reconcile.it.test.ts
```

### Step 7 — 提交

```
git add -- src/lib/transport/http2-client.ts tests/transport/http2-generation-reconcile.it.test.ts
git commit -F <msgfile> -- src/lib/transport/http2-client.ts tests/transport/http2-generation-reconcile.it.test.ts
```
提交信息：`feat(transport): generation-based retire-and-replace for h2 sessions on config hot-reload`

**独立 Oracle**：本 Task 的全部测试都通过真实本地 h2c server + 真实 h2 stream 观测，不是仅断言内部状态——"新请求是否真的走了不同的 TCP 会话"（第一个测试断言 generation 变化）、"在飞流是否真的完整收到两段 chunk"（第二个测试用真实的延迟 stream + 真实的 `res.text()` 断言完整拼接结果，而非只断言 `activeStreamCount` 字段）、"新 ping cadence 是否真的按新间隔触发 `session.ping()`"（A3 的两个 reschedule 测试用真实 `setInterval` + spy 观测调用次数变化，而非只断言 `effectivePingIntervalMs` 字段被赋值）、"四类真实终止路径是否都能让 retiring 会话真的从快照消失"（A4 的四行矩阵——真实销毁会话/真实取消 body reader/真实服务端 RST/真实整会话销毁，断言的是 `getH2SessionStatusSnapshot()` 最终清空，而不是断言 `activeStreamCount` 内部计数器归零；后者本身在四条路径下走的是四种不同的 Node/Bun 事件时序，只有让它们真的驱动 `maybeReclaimRetiringSession()` 关闭会话，才是这条 exactly-once 不变量真正被兑现的证据）。

---

## Task 2 — WS 连接池 idle-timeout 重调度 + soft-max reconcile

**Files**
- Modify: `/home/xp/src/copilot-api-js/src/lib/openai/upstream-ws-connection.ts:24-147`（常量区 + `scheduleIdleClose` 邻近）、`:51-62`（`UpstreamWsConnection` 接口）、`:379-421`（返回对象的 getter/method 区）
- Modify: `/home/xp/src/copilot-api-js/src/lib/openai/upstream-ws.ts`（全文件——`UpstreamWsManager` 接口、`createUpstreamWsManager` 闭包、`getUpstreamWsManager`）
- Modify: `/home/xp/src/copilot-api-js/tests/responses/upstream-ws-connection.unit.test.ts`
- Modify: `/home/xp/src/copilot-api-js/tests/responses/upstream-ws.unit.test.ts`

**Interfaces**
```ts
// upstream-ws-connection.ts — UpstreamWsConnection 接口新增方法，逐字对齐 README「P4 产出，P5 消费」
rescheduleIdleTimeout(newIdleTimeoutMs: number): void

// upstream-ws.ts — 新增导出，逐字对齐 README「P4 产出，P5 消费」
export interface UpstreamWsStatusRow {
  key: string
  model: string
  state: "connecting" | "busy" | "idle"
  generation: number
}
export function getUpstreamWsStatusSnapshot(manager: UpstreamWsManager): ReadonlyArray<UpstreamWsStatusRow>
```
`UpstreamWsManager` 接口新增（非 README 锁定，是本阶段为承载 `getUpstreamWsStatusSnapshot(manager)` 而必须新增的实现细节——`getUpstreamWsStatusSnapshot`只接收 README 锁定的 `manager: UpstreamWsManager` 一个参数，manager 内部必须自己暴露状态，别无他法。沿用既有 `breakerSnapshot()` 的同款风格新增）：
```ts
reconcileForConfigChange(newIdleTimeoutMs: number): void
statusSnapshot(): ReadonlyArray<UpstreamWsStatusRow>
```
`CreateUpstreamWsConnectionOptions` 接口新增（非 README 锁定，是 HIGH-5"busy→idle 转换即时触发 eviction 检查"的必要接线——没有这个钩子，`upstream-ws.ts` 就无法在"没有新 `create()` 调用"的窗口期得知一个 busy 连接何时转回了 idle）：
```ts
onIdle?: () => void
```

### Step 1 — 写失败测试：`rescheduleIdleTimeout` 真实重新 armed 定时器

在 `tests/responses/upstream-ws-connection.unit.test.ts` 追加（复用文件已有的 `FakeSocket` + `describe("upstream websocket connection")` 块）：
```ts
test("rescheduleIdleTimeout re-arms the idle timer with the new value (real timer, no fake clock)", async () => {
  const connection = createUpstreamWsConnection({
    headers: {},
    model: "gpt-5.2",
    idleTimeoutMs: 10_000, // long enough that it would NOT fire during this test if left unchanged
    createSocket: () => socket,
  })
  const connectPromise = connection.connect()
  socket.open()
  await connectPromise

  // Shrink the idle window to something the test can actually observe firing.
  connection.rescheduleIdleTimeout(20)

  await new Promise((r) => setTimeout(r, 60))
  expect(socket.closeCalls).toHaveLength(1)
  expect(socket.closeCalls[0]?.reason).toBe("Idle timeout")
})

test("rescheduleIdleTimeout while busy is a no-op until the request finishes (does not interrupt an in-flight request)", async () => {
  const connection = createUpstreamWsConnection({
    headers: {},
    model: "gpt-5.2",
    idleTimeoutMs: 10_000,
    createSocket: () => socket,
  })
  const connectPromise = connection.connect()
  socket.open()
  await connectPromise

  const events = connection.sendRequest({ model: "gpt-5.2", input: "hi", stream: true })
  connection.rescheduleIdleTimeout(20)

  // Busy connection must NOT be closed by the shrunk idle window.
  await new Promise((r) => setTimeout(r, 60))
  expect(socket.closeCalls).toHaveLength(0)

  socket.emitMessage({
    type: "response.completed",
    sequence_number: 0,
    response: { id: "resp_1", object: "response", created_at: 1, status: "completed", model: "gpt-5.2", output: [] },
  })
  for await (const _e of events) {
    /* drain */
  }

  // Now idle — the rescheduled (short) value takes effect on the NEXT
  // scheduleIdleClose() call (finishRequest), per Architecture.
  await new Promise((r) => setTimeout(r, 60))
  expect(socket.closeCalls).toHaveLength(1)
})

test("rescheduleIdleTimeout computes the new deadline from idleSince, not from the reschedule call time (HIGH-6) — extending after a long idle period fires sooner than a fresh full window would", async () => {
  const connection = createUpstreamWsConnection({
    headers: {},
    model: "gpt-5.2",
    idleTimeoutMs: 10_000, // long enough that it would not fire on its own during this test
    createSocket: () => socket,
  })
  const connectPromise = connection.connect()
  socket.open()
  await connectPromise
  // idleSince is stamped when onOpen marks the connection idle, above. Let a
  // good chunk of that idle window elapse BEFORE rescheduling.
  await new Promise((r) => setTimeout(r, 80))

  // If this were "restart a fresh window from now" (the bug this test would
  // catch), the connection would close ~100ms after THIS call. Idle-since
  // based, it closes ~20ms after this call — 80ms of the 100ms window had
  // already elapsed while idle before the reschedule.
  connection.rescheduleIdleTimeout(100)

  await new Promise((r) => setTimeout(r, 45))
  expect(socket.closeCalls).toHaveLength(1)
  expect(socket.closeCalls[0]?.reason).toBe("Idle timeout")
})

test("rescheduleIdleTimeout closes immediately when the new deadline (based on idleSince) has already passed", async () => {
  const connection = createUpstreamWsConnection({
    headers: {},
    model: "gpt-5.2",
    idleTimeoutMs: 10_000,
    createSocket: () => socket,
  })
  const connectPromise = connection.connect()
  socket.open()
  await connectPromise
  await new Promise((r) => setTimeout(r, 80)) // idle for 80ms already

  // The new window (30ms) is already shorter than the 80ms that has elapsed
  // since idleSince — the deadline is already in the past, so this must
  // close essentially immediately (Math.max(0, deadline - now) === 0), NOT
  // wait a further 30ms counted from this call.
  connection.rescheduleIdleTimeout(30)

  await new Promise((r) => setTimeout(r, 15))
  expect(socket.closeCalls).toHaveLength(1)
})

test("onIdle fires every time the connection transitions (back) to idle — the HIGH-5 eviction hook", async () => {
  const onIdleCalls: Array<true> = []
  const connection = createUpstreamWsConnection({
    headers: {},
    model: "gpt-5.2",
    idleTimeoutMs: 10_000,
    createSocket: () => socket,
    onIdle: () => onIdleCalls.push(true),
  })
  const connectPromise = connection.connect()
  socket.open()
  await connectPromise
  // The initial onOpen->idle transition counts as one.
  expect(onIdleCalls).toHaveLength(1)

  const events = connection.sendRequest({ model: "gpt-5.2", input: "hi", stream: true })
  expect(onIdleCalls).toHaveLength(1) // unchanged while busy

  socket.emitMessage({
    type: "response.completed",
    sequence_number: 0,
    response: { id: "resp_1", object: "response", created_at: 1, status: "completed", model: "gpt-5.2", output: [] },
  })
  for await (const _e of events) {
    /* drain */
  }

  expect(onIdleCalls).toHaveLength(2) // finishRequest() transitioned back to idle
})
```

跑 `bun test tests/responses/upstream-ws-connection.unit.test.ts` 确认失败（`rescheduleIdleTimeout` 不存在，TS 编译错误）。

### Step 2 — 实现：`upstream-ws-connection.ts` 的可变 `effectiveIdleTimeoutMs` + `idleSince` + `onIdle` + `rescheduleIdleTimeout`

把第 88 行：
```ts
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
```
替换为：
```ts
  /** Mutable — {@link rescheduleIdleTimeout} (P4 hot-reload) updates this in place. */
  let effectiveIdleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  /**
   * Wall-clock time this connection became idle (the initial handshake
   * settling into idle, or a request finishing) — `undefined` while busy or
   * not yet connected. `scheduleIdleClose()` computes its deadline as
   * `idleSince + effectiveIdleTimeoutMs` (HIGH-6), NOT `Date.now() +
   * effectiveIdleTimeoutMs` — a config-driven reschedule while already idle
   * must extend/shrink from the ORIGINAL idle start, not from the reschedule
   * call's own timestamp. Otherwise every hot-reload would silently add
   * `effectiveIdleTimeoutMs` more wall-clock life to an already-idle
   * connection, and a shrunk timeout would fail to close a connection that
   * is already past the new deadline.
   */
  let idleSince: number | undefined
```

把第 123-138 行的 `scheduleIdleClose` 替换为按 `idleSince` 绝对 deadline 调度：
```ts
  const scheduleIdleClose = () => {
    clearIdleTimer()
    if (!socket || busy || socket.readyState !== socket.OPEN || effectiveIdleTimeoutMs <= 0) return
    const deadlineMs = (idleSince ?? Date.now()) + effectiveIdleTimeoutMs
    const delayMs = Math.max(0, deadlineMs - Date.now())
    idleTimer = setTimeout(
      guardCallback(
        () => {
          closeUpstreamWs(socket, "Idle timeout")
        },
        (error) => {
          consola.warn(`[upstream-ws] idle-timer callback threw (model=${opts.model}): ${toError(error).message}`)
          markUnusable()
        },
      ),
      delayMs,
    )
  }

  /**
   * Single entry point for "this connection just became idle" (HIGH-5 / HIGH-6):
   * stamps `idleSince` BEFORE scheduling so the deadline math above is correct,
   * notifies the pool via `opts.onIdle` so a hot-reload-shrunk soft-max cap gets
   * re-checked on every busy→idle transition (not just at `create()`/reconcile
   * time — see Architecture), then arms the idle timer.
   */
  const markIdle = () => {
    idleSince = Date.now()
    opts.onIdle?.()
    scheduleIdleClose()
  }
```

把 `finishRequest`（第 140-147 行）里的 `scheduleIdleClose()` 调用改为 `markIdle()`：
```ts
  const finishRequest = () => {
    busy = false
    currentAbortCleanup?.()
    currentAbortCleanup = null
    currentQueue?.close()
    currentQueue = null
    markIdle()
  }
```

把 `sendRequest`（第 338-339 行）标记 busy 的两行，追加清空 `idleSince`：
```ts
      clearIdleTimer()
      busy = true
      idleSince = undefined
      currentQueue = createAsyncQueue<ResponsesStreamEvent>()
```

把 `connect()` 里 `onOpen` 成功回调（第 262 行）的 `scheduleIdleClose()` 改为 `markIdle()`：
```ts
              socket = ws
              ws.addEventListener("message", handleMessage)
              ws.addEventListener("error", handleError)
              ws.addEventListener("close", handleClose)
              markIdle()
              resolve()
```

在 `CreateUpstreamWsConnectionOptions` 接口（第 28-41 行）新增 `onIdle`：
```ts
export interface CreateUpstreamWsConnectionOptions {
  headers: Record<string, string>
  model: string
  /**
   * Optional conversation identifier (e.g. from X-Conversation-Id header).
   * Used as a fallback reuse key when `previous_response_id` is absent —
   * mirrors GHC per-conversation WS pattern (#4827) for turn boundaries
   * that don't yet carry a stateful marker.
   */
  conversationId?: string
  onClose?: () => void
  idleTimeoutMs?: number
  createSocket?: (url: string, headers: Record<string, string>) => WebSocketLike
  /**
   * Hot-reload (P4, HIGH-5): called every time this connection transitions
   * (back) to idle — including the very first time, right after the
   * handshake completes. `upstream-ws.ts` wires this to re-check the
   * soft-max cap on every busy→idle transition, not only at `create()` time
   * or when a config-change reconcile happens to run — without this, a pool
   * that is fully busy at reload time would never shed its excess
   * connections once they went idle later (spec-flagged permanent-overage
   * scenario).
   */
  onIdle?: () => void
}
```

在 `UpstreamWsConnection` 接口（第 51-62 行）新增方法，紧接 `handshakeHeaders` 之后、`close()` 之前：
```ts
export interface UpstreamWsConnection {
  connect(opts?: { signal?: AbortSignal }): Promise<void>
  sendRequest(payload: ResponsesPayload, opts?: { abortSignal?: AbortSignal }): AsyncIterable<ResponsesStreamEvent>
  readonly isOpen: boolean
  readonly isBusy: boolean
  readonly statefulMarker: string | undefined
  readonly model: string
  readonly conversationId: string | undefined
  /** Headers captured at handshake time — used for reuse-diff diagnostics */
  readonly handshakeHeaders: Record<string, string>
  /**
   * Hot-reload (P4): update the idle-close deadline used by future/current
   * idle windows (HIGH-6). The new deadline is computed from the connection's
   * ORIGINAL idle-start time (`idleSince`), not from the moment this method is
   * called — so shrinking the timeout below the elapsed idle duration closes
   * the connection essentially immediately, and extending it does not reset
   * an already-idle connection's clock back to zero. A no-op while busy or
   * not yet open; the next transition to idle (`finishRequest`) computes its
   * own deadline from the new value naturally.
   */
  rescheduleIdleTimeout(newIdleTimeoutMs: number): void
  close(): void
}
```

在返回对象（第 234-423 行）里，紧接 `get handshakeHeaders()`（第 402-404 行）之后新增方法：
```ts
    get handshakeHeaders() {
      return opts.headers
    },

    rescheduleIdleTimeout(newIdleTimeoutMs) {
      effectiveIdleTimeoutMs = newIdleTimeoutMs
      // scheduleIdleClose() itself bails out (no-op) when busy/not-open/disabled,
      // and computes its deadline from `idleSince` (unchanged by this call) —
      // so unconditionally calling it here is always safe and correct: while
      // idle+open it re-arms against the SAME idleSince with the new value
      // (closing immediately if that deadline has already passed); while busy
      // it does nothing, deferring to the next `finishRequest()`/`markIdle()`,
      // which will stamp a fresh `idleSince` and read this new value then.
      scheduleIdleClose()
    },

    close() {
```

跑 `bun test tests/responses/upstream-ws-connection.unit.test.ts` 确认通过。

### Step 3 — 写失败测试：manager 的 `reconcileForConfigChange`/`statusSnapshot`

在 `tests/responses/upstream-ws.unit.test.ts`，先读一遍该文件已有的 `describe`/mock 连接工厂命名（执行者须先跑 `grep -n "describe\|connectionFactory\|createUpstreamWsManager" tests/responses/upstream-ws.unit.test.ts` 核实，再按同一模式追加，不重写已有内容），追加：
```ts
describe("reconcileForConfigChange / statusSnapshot (P4 hot-reload)", () => {
  test("reconcileForConfigChange reschedules every connection's idle timeout and bumps its generation", async () => {
    const rescheduleCalls: Array<number> = []
    const fakeConnection = (model: string): UpstreamWsConnection => ({
      connect: () => Promise.resolve(),
      sendRequest: () => (async function* () {})(),
      isOpen: true,
      isBusy: false,
      statefulMarker: undefined,
      model,
      conversationId: undefined,
      handshakeHeaders: {},
      rescheduleIdleTimeout: (ms) => rescheduleCalls.push(ms),
      close: () => {},
    })
    setUpstreamWsConnectionFactoryForTests(() => fakeConnection("gpt-5.2"))
    const manager = createUpstreamWsManager()
    await manager.create({ headers: {}, model: "gpt-5.2" })
    await manager.create({ headers: {}, model: "gpt-5.3" })

    const before = manager.statusSnapshot()
    expect(before.every((row) => row.generation === 0)).toBe(true)

    manager.reconcileForConfigChange(120_000)

    expect(rescheduleCalls).toEqual([120_000, 120_000])
    const after = manager.statusSnapshot()
    expect(after.every((row) => row.generation === 1)).toBe(true)
    setUpstreamWsConnectionFactoryForTests(null)
  })

  test("statusSnapshot reflects busy/idle/model per connection; getUpstreamWsStatusSnapshot delegates to it", async () => {
    const fakeConnection = (model: string, busy: boolean): UpstreamWsConnection => ({
      connect: () => Promise.resolve(),
      sendRequest: () => (async function* () {})(),
      isOpen: true,
      isBusy: busy,
      statefulMarker: undefined,
      model,
      conversationId: undefined,
      handshakeHeaders: {},
      rescheduleIdleTimeout: () => {},
      close: () => {},
    })
    let toggle = false
    setUpstreamWsConnectionFactoryForTests(() => fakeConnection("gpt-5.2", (toggle = !toggle)))
    const manager = createUpstreamWsManager()
    await manager.create({ headers: {}, model: "gpt-5.2" }) // busy=true
    await manager.create({ headers: {}, model: "gpt-5.2" }) // busy=false

    const rows = getUpstreamWsStatusSnapshot(manager)
    expect(rows).toHaveLength(2)
    expect(rows.filter((r) => r.state === "busy")).toHaveLength(1)
    expect(rows.filter((r) => r.state === "idle")).toHaveLength(1)
    expect(rows.every((r) => r.model === "gpt-5.2")).toBe(true)
    setUpstreamWsConnectionFactoryForTests(null)
  })

  test("reconcileForConfigChange evicts excess IDLE connections down to a shrunk soft-max cap; busy connections are left alone", async () => {
    // This fake's close() deliberately notifies the manager's onClose
    // ASYNCHRONOUSLY (via queueMicrotask), mirroring the real connection: a
    // real close() flips `isOpen` to false synchronously (the underlying
    // socket's readyState moves out of OPEN as soon as `.close()` is called)
    // but the manager only learns about it — and deletes the entry from its
    // `connections` Map — when the WS "close" event fires on a later tick.
    // A naive eviction loop that re-reads `connections.size` after each
    // `victim.close()` call would see the size UNCHANGED and either loop
    // forever or (if bounded by a `while (size > cap)` check) stop after the
    // first eviction because it can't tell the difference between "still
    // over cap" and "already scheduled, just not reflected yet". The fix
    // under test computes the excess ONCE and evicts that many connections
    // by count, which is exactly what this test is designed to catch a
    // regression on.
    const fakeIdleConnection = (opts: CreateUpstreamWsConnectionOptions): UpstreamWsConnection => {
      let closed = false
      return {
        connect: () => Promise.resolve(),
        sendRequest: () => (async function* () {})(),
        get isOpen() {
          return !closed
        },
        isBusy: false,
        statefulMarker: undefined,
        model: opts.model,
        conversationId: undefined,
        handshakeHeaders: {},
        rescheduleIdleTimeout: () => {},
        close: () => {
          if (closed) return
          closed = true
          queueMicrotask(() => opts.onClose?.())
        },
      }
    }
    let cap = 4
    setUpstreamWsConnectionFactoryForTests((opts) => fakeIdleConnection(opts))
    const manager = createUpstreamWsManager({ maxConnections: () => cap })
    for (let i = 0; i < 4; i++) await manager.create({ headers: {}, model: "gpt-5.2" })
    expect(manager.statusSnapshot()).toHaveLength(4)

    // Config hot-reload shrinks the cap from 4 to 2 — reconcile must evict two
    // idle connections down to the new cap, observed via `.close()` really
    // being called (not just a count on an internal array).
    cap = 2
    manager.reconcileForConfigChange(300_000)

    // Flush the queueMicrotask-deferred onClose notifications before
    // asserting — a macrotask boundary (setTimeout) guarantees every
    // already-queued microtask has run.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(manager.statusSnapshot()).toHaveLength(2)
    setUpstreamWsConnectionFactoryForTests(null)
  })

  test("create() wires onIdle so a busy→idle transition alone re-checks the soft-max cap, with no intervening create()/reconcile call (HIGH-5)", async () => {
    // Both connections start BUSY (as if created to immediately carry a
    // request) so `create()`'s own `evictOneIdleIfNeeded()` call finds no
    // idle victim and the pool is allowed to sit at 2 connections against a
    // cap of 1 — the "temporarily exceeded" case `evictOneIdleIfNeeded()`
    // already tolerates. The ONLY subsequent trigger is connection #1
    // flipping to idle via its own onIdle callback — there is no further
    // create()/reconcile call in this test.
    const idleTriggers: Array<() => void> = []
    const fakeConnection = (opts: CreateUpstreamWsConnectionOptions): UpstreamWsConnection => {
      let busy = true
      let closed = false
      idleTriggers.push(() => {
        busy = false
        opts.onIdle?.()
      })
      return {
        connect: () => Promise.resolve(),
        sendRequest: () => (async function* () {})(),
        get isOpen() {
          return !closed
        },
        get isBusy() {
          return busy
        },
        statefulMarker: undefined,
        model: opts.model,
        conversationId: undefined,
        handshakeHeaders: {},
        rescheduleIdleTimeout: () => {},
        close: () => {
          closed = true
          opts.onClose?.()
        },
      }
    }
    setUpstreamWsConnectionFactoryForTests((opts) => fakeConnection(opts))
    const manager = createUpstreamWsManager({ maxConnections: () => 1 })
    await manager.create({ headers: {}, model: "gpt-5.2" })
    await manager.create({ headers: {}, model: "gpt-5.2" })
    expect(manager.statusSnapshot()).toHaveLength(2)

    idleTriggers[0]?.()

    expect(manager.statusSnapshot()).toHaveLength(1)
    setUpstreamWsConnectionFactoryForTests(null)
  })
})
```

跑 `bun test tests/responses/upstream-ws.unit.test.ts` 确认失败（`reconcileForConfigChange`/`statusSnapshot`/`getUpstreamWsStatusSnapshot` 不存在，`onIdle` 字段在 `CreateUpstreamWsConnectionOptions` 类型上也还不存在）。

### Step 4 — 实现：`upstream-ws.ts` 的 `UpstreamWsManager` 扩展 + `getUpstreamWsStatusSnapshot`

在 `UpstreamWsManager` 接口（第 51-67 行）新增两个方法，紧接 `breakerSnapshot()` 之后：
```ts
export interface UpstreamWsManager {
  findReusable(opts: { previousResponseId?: string; conversationId?: string; model: string }): UpstreamWsConnection | undefined
  create(opts: { headers: Record<string, string>; model: string; conversationId?: string }): Promise<UpstreamWsConnection>
  stopNew(): void
  closeAll(): void
  resetRuntimeState(): void
  recordSuccessfulStart(key: string): void
  recordFallback(key: string): void
  readonly activeCount: number
  consecutiveFallbacks(key: string): number
  temporarilyDisabled(key: string): boolean
  disabledUntilMs(key: string): number
  breakerSnapshot(): Array<WsBreakerSnapshotRow>
  /** Hot-reload (P4): reschedule every pooled connection's idle-close deadline to `newIdleTimeoutMs`, bump this manager's generation counter, and evict excess IDLE connections down to the (possibly shrunk) soft-max cap. Busy connections are left alone — they converge via existing mechanisms (see Architecture). */
  reconcileForConfigChange(newIdleTimeoutMs: number): void
  /** Per-connection status rows for /api/status (P5). */
  statusSnapshot(): ReadonlyArray<UpstreamWsStatusRow>
  readonly stopped: boolean
}
```

在文件顶部新增导出接口 `UpstreamWsStatusRow`（紧接 `WsBreakerSnapshotRow` 之后，第 43-49 行区域）：
```ts
/** Per-connection status row for /api/status (richest-data-flow). */
export interface UpstreamWsStatusRow {
  key: string
  model: string
  state: "connecting" | "busy" | "idle"
  generation: number
}
```

在 `createUpstreamWsManager()` 内部（第 79-322 行），把第 85-86 行：
```ts
  const connections = new Map<string, UpstreamWsConnection>()
  const lastUsedAt = new Map<string, number>()
```
替换为：
```ts
  const connections = new Map<string, UpstreamWsConnection>()
  const lastUsedAt = new Map<string, number>()
  /** Generation stamped at create() time; bumped on every reconcileForConfigChange() call. Instance-scoped (per-manager), unlike h2's module-global currentGeneration — each manager owns its own connection pool. */
  const connectionGeneration = new Map<string, number>()
  let currentGeneration = 0
```

紧接 `evictOneIdleIfNeeded()` 定义之后（第 106-141 行区域，`findReusable()` 之前）新增辅助函数 `evictExcessIdleConnections()`——**这是 Task 2 唯一一处真正的行为修正点**：一个真实连接的 `close()` 只会同步地让 `isOpen` 变为 `false`（底层 socket 一调用 `.close()`，`readyState` 就立刻离开 `OPEN`），但 `connections` Map 里对应条目的真正删除，要等 `onClose` 回调在之后某个 tick 上真正触发（WS "close" 事件本身是异步的）；因此任何在同一次驱逐循环里反复读取 `connections.size` 来判断"是否还需要继续驱逐"的写法，都会在驱逐第一个连接后立即看到 `connections.size` 原地不变，从而误判"驱逐没有生效"而提前退出循环——这正是 HIGH-5 要求修正的那个 bug（`reconcileForConfigChange()` 下面会复用这个辅助函数，不再自己写循环）：
```ts
  /**
   * Evicts however many idle connections are needed to bring the pool back
   * within `cap`, counted ONCE up front — unlike callers that loop on
   * `connections.size` shrinking, this must not re-read `connections.size`
   * mid-loop: a real connection's close() only removes its entry from
   * `connections` asynchronously (the manager's `onClose` callback fires
   * when the underlying WS "close" event arrives, not synchronously inside
   * `.close()`), so re-checking `connections.size` after each eviction would
   * see it unchanged and the loop would stop after evicting at most one
   * connection, silently leaving the pool oversized (spec §4 HIGH-5).
   */
  const evictExcessIdleConnections = () => {
    const cap = getMaxConnections()
    if (cap <= 0) return
    const excess = connections.size - cap
    for (let i = 0; i < excess; i++) evictOneIdleIfNeeded()
  }
```

把 `create()`（第 196-214 行）里传给 `connectionFactory` 的 opts 新增 `onIdle`（HIGH-5——每次某个连接从 busy 转回 idle，都要重新检查一次是否超额，见 Architecture 的完整论证）：
```ts
    create({ headers, model, conversationId }) {
      if (stopped) throw new Error("Upstream WebSocket manager is not accepting new work")

      evictOneIdleIfNeeded()

      const key = randomUUID()
      const connection = connectionFactory({
        headers,
        model,
        conversationId,
        onClose: () => {
          connections.delete(key)
          lastUsedAt.delete(key)
          connectionGeneration.delete(key)
        },
        onIdle: () => evictOneIdleIfNeeded(),
      })
      connections.set(key, connection)
      connectionGeneration.set(key, currentGeneration)
      touch(key)
      return Promise.resolve(connection)
    },
```

把 `closeAll()`（第 220-226 行）新增一行清空：
```ts
    closeAll() {
      for (const connection of connections.values()) {
        connection.close()
      }
      connections.clear()
      lastUsedAt.clear()
      connectionGeneration.clear()
    },
```

在 `breakerSnapshot()`（第 304-316 行）之后、`get stopped()`（第 318-320 行）之前新增两个方法：
```ts
    reconcileForConfigChange(newIdleTimeoutMs) {
      currentGeneration += 1
      for (const [key, connection] of connections) {
        connection.rescheduleIdleTimeout(newIdleTimeoutMs)
        connectionGeneration.set(key, currentGeneration)
      }
      // The soft-max cap may have shrunk — evict now-excess IDLE connections
      // down to it. Busy connections are left untouched (see Architecture).
      // evictExcessIdleConnections() computes the excess ONCE up front — see
      // its own doc comment for why re-checking connections.size mid-loop
      // would silently under-evict.
      evictExcessIdleConnections()
    },

    statusSnapshot() {
      const rows: Array<UpstreamWsStatusRow> = []
      for (const [key, connection] of connections) {
        const connectionState: UpstreamWsStatusRow["state"] = !connection.isOpen ? "connecting" : connection.isBusy ? "busy" : "idle"
        rows.push({
          key,
          model: connection.model,
          state: connectionState,
          generation: connectionGeneration.get(key) ?? 0,
        })
      }
      return rows
    },
```

**`state` 三值映射（reviewer + 用户裁决强制改名，`"active"` → `"connecting"`）**：起草阶段曾选 `"active"` 表示"握手尚未完成的连接"，套用 h2 侧"active=正在承载工作"的措辞习惯——但两者语义其实相反（h2 的 `"active"` 指"已建立且可路由"，WS 原计划的 `"active"` 却指"尚未建立"），这个反义命名是明显的 footgun，reviewer 抓出后用户裁决改名消除。改后映射：`!connection.isOpen` → `"connecting"`；`isOpen && isBusy` → `"busy"`；`isOpen && !isBusy` → `"idle"`（busy/idle 两档映射不变，只改第一档字符串值）。README「跨阶段共享接口清单」已同步锁定 `state: "connecting" | "busy" | "idle"`，P5 展示层须逐字复用这个映射与字符串值，不得残留 `"active"` 作为 WS 状态字面量。

在文件底部（`setUpstreamWsConnectionFactoryForTests` 之后）新增导出自由函数：
```ts
/** Free-function wrapper (README "P4 produces, P5 consumes" signature) — the manager itself owns the per-connection state, so this just delegates. */
export function getUpstreamWsStatusSnapshot(manager: UpstreamWsManager): ReadonlyArray<UpstreamWsStatusRow> {
  return manager.statusSnapshot()
}
```

跑 `bun test tests/responses/upstream-ws.unit.test.ts` 确认通过。

### Step 5 — 实现：`getUpstreamWsManager()` 懒加载订阅 `onUpstreamTransportChange`

在文件顶部 import 区块（第 1-16 行）追加：
```ts
import { onUpstreamTransportChange, state } from "~/lib/state"
```
（替换原来单独的 `import { state } from "~/lib/state"` 一行）。

把 `getUpstreamWsManager()`（第 326-334 行）替换为：
```ts
let wsReconcileSubscriptionInstalled = false

export function getUpstreamWsManager(): UpstreamWsManager {
  manager ??= createUpstreamWsManager({
    // Read the cap from runtime state on every eviction so config hot-reload
    // takes effect without recreating the manager (which would drop all
    // pooled connections).
    maxConnections: () => state.softMaxUpstreamWsConnections,
  })
  // Lazy-once subscription (P4), mirroring proxy.ts's ensureTimeoutSubscription().
  // References the outer `manager` variable (not a snapshot), so this correctly
  // targets whatever manager instance is current even after
  // resetUpstreamWsManagerForTests() swaps it out.
  if (!wsReconcileSubscriptionInstalled) {
    onUpstreamTransportChange(() => {
      manager?.reconcileForConfigChange(getPooledConnectionIdleTimeoutMs())
    })
    wsReconcileSubscriptionInstalled = true
  }
  return manager
}
```

**依赖 P2 前置条件**：`getPooledConnectionIdleTimeoutMs()` 是 P2 Task 2 在本文件内新增并导出的辅助函数（同文件内可直接调用，不需要 import；P2 选择导出它是为了让 P4 复用同一换算逻辑，见 `plan-2-new-knobs-wiring.md` 的说明）——执行者在做本 Step 前先跑 `grep -n "function getPooledConnectionIdleTimeoutMs" src/lib/openai/upstream-ws.ts` 确认 P2 已落地；若缺失说明 P2 尚未执行完成，应先完成 P2。

跑：
```
bun test tests/responses/upstream-ws.unit.test.ts tests/responses/upstream-ws-connection.unit.test.ts tests/responses/upstream-ws-crash-safety.sub.test.ts
```
确认全部通过。

### Step 6 — 类型检查 + lint

```
bun run typecheck
bunx eslint src/lib/openai/upstream-ws.ts src/lib/openai/upstream-ws-connection.ts tests/responses/upstream-ws.unit.test.ts tests/responses/upstream-ws-connection.unit.test.ts
```

### Step 7 — 提交

```
git add -- src/lib/openai/upstream-ws.ts src/lib/openai/upstream-ws-connection.ts tests/responses/upstream-ws.unit.test.ts tests/responses/upstream-ws-connection.unit.test.ts
git commit -F <msgfile> -- src/lib/openai/upstream-ws.ts src/lib/openai/upstream-ws-connection.ts tests/responses/upstream-ws.unit.test.ts tests/responses/upstream-ws-connection.unit.test.ts
```
提交信息：`feat(upstream-ws): hot-reload reconcile — reschedule idle timeouts + evict excess idle connections to shrunk soft-max cap`

**独立 Oracle**：`rescheduleIdleTimeout` 的两个测试用真实 `setTimeout` 观测 `socket.close()` 是否真的在新的短窗口内被调用（而非断言内部变量被赋值）；soft-max 收缩测试观测真实连接对象的 `close()` 方法调用次数（`statusSnapshot().length` 真的从 4 降到 2），不是仅断言循环执行过。

---

## Task 3 — 跨 Task 回归 + Self-Review

**Files**：无新增改动文件——本 Task 是验证 + 记录，若发现问题回退到 Task 1/2 修正。

### Step 1 — 全量相关回归

```
bun test tests/transport/ tests/responses/upstream-ws.unit.test.ts tests/responses/upstream-ws-connection.unit.test.ts tests/responses/upstream-ws-crash-safety.sub.test.ts
bun run typecheck
bun run lint:all
```

### Step 2 — 手工核对 README 锁定签名逐字一致

执行者核对以下四组签名与 README 第 134-158 行（H2）/ 上方 Task 2 Interfaces（WS）逐字比较，任何偏离都必须回 README 更新而非本文件私自改名：
- `H2SessionStatusRow` / `getH2SessionStatusSnapshot()` / `getH2ReconcileStatus()` —— 一致。
- `UpstreamWsStatusRow` / `getUpstreamWsStatusSnapshot(manager)` —— 一致。
- `UpstreamWsConnection.rescheduleIdleTimeout(newIdleTimeoutMs: number): void` —— 一致。

### Step 3 — Self-Review：发现的缺口 / 待裁决分叉（记入 plan-kickoff 汇总）

**起草过程中自查并已修正的三处设计缺陷**（记录在案，供审查核对本文档现状即为修正后版本，不是遗留风险）：起草期间发现最初的设计草稿在三处违反了 spec §4 的硬性要求，均已在本文档写入最终版之前修正完毕——(a) h2 `getSession()` 最初用递归调用处理"建连完成时 generation 已过期"，改为同一 creation 帧内的 `for(;;)` 循环 + 捕获 `generationAtStart` 比较丢弃重试（HIGH-3），且 `reconcileH2SessionsForConfigChange()` 的 catch 块改为记录 `failed` 状态而不重新 throw；(b) WS `rescheduleIdleTimeout` 最初按"调用时刻 + 新窗口"重新计算 deadline（等价于完整重启窗口、丢弃已经过去的空闲时间），改为按 `idleSince`（记录的绝对空闲起点）+ 新窗口计算绝对 deadline（HIGH-6）；(c) manager 的 `reconcileForConfigChange()` 最初的驱逐循环依赖 `connections.size` 在同一个同步循环内因 `victim.close()` 而缩小，但真实连接的 `onClose` 通知是异步的（WS "close" 事件要等下一个 tick），会导致循环在驱逐第一个连接后就误判"没有生效"而提前退出——改为 `evictExcessIdleConnections()` 按需要驱逐的数量计数循环，并新增 `onIdle` 回调让每次 busy→idle 转换都重新触发一次驱逐检查（覆盖"reload 时全部连接都在 busy、之后陆续转回 idle"这条此前完全没有被覆盖的路径，HIGH-5）。

1. **`UpstreamWsManager` 新增 `reconcileForConfigChange`/`statusSnapshot` 两个方法未被 README 锁定**——是本阶段为了让 `getUpstreamWsStatusSnapshot(manager)` 这个 README 锁定的自由函数有内部状态可读而必须新增的实现细节，沿用了 `breakerSnapshot()` 的既有风格。风险很低（纯新增方法，不改动任何既有方法签名），但记入待裁决清单供主会话确认这类"计划范围内合理延伸"是否需要事后补录进 README 的跨阶段契约清单。
2. ~~**`UpstreamWsStatusRow.state` 的三值映射选定为 `!isOpen→"active"`/`isOpen&&isBusy→"busy"`/`isOpen&&!isBusy→"idle"`**——README 只锁定了类型形状,未规定语义映射...~~ **已裁决（0e3926ab）**：reviewer 抓出 `"active"` 与 h2 侧 `H2SessionStatusRow.lifecycle` 的 `"active"`（已建立可路由）反义，用户裁决改名为 `"connecting"`。README 已同步锁定 `state: "connecting" | "busy" | "idle"`，本文档 Task 2/3 的实现与测试已按新名改写，此条不再是待裁决分叉。
3. **`onUpstreamTransportChange` 是覆盖 5 个字段变化的单一粗粒度事件**——任何一个字段变化都会触发 h2 的全量 retire-and-replace（即使变化的字段与 h2 无关，如单独改 `softMaxUpstreamWsConnections`）以及 WS 的全量 reconcile（即使变化的字段与 WS 无关，如单独改 `sessionConnectTimeout`）。这是 P1 单一事件设计的既定代价，非本阶段引入的新问题，但会造成可观测的、技术上不必要的连接重建（h2 侧尤其明显：一次 reconcile 会让所有 origin 的活跃会话立即变为 retiring，下一个请求都要重新握手）。记入待裁决清单，供主会话评估是否值得在未来某阶段把 `onUpstreamTransportChange` 拆分为按字段分组的更细粒度事件（当前判断：不值得为此增加 P1 的复杂度，代价是"配置很少变化 + 重新握手成本对本项目场景可忽略"，但这是主会话该做的成本判断，不应由本计划单方面定案）。

---

## 交付物清单

- `src/lib/transport/http2-client.ts`（h2 session generation-based retire-and-replace）
- `src/lib/openai/upstream-ws-connection.ts`（可变 idle-timeout + `rescheduleIdleTimeout`）
- `src/lib/openai/upstream-ws.ts`（manager reconcile + status snapshot + 懒加载订阅）
- `tests/transport/http2-generation-reconcile.it.test.ts`（新增）
- `tests/responses/upstream-ws-connection.unit.test.ts`（追加）
- `tests/responses/upstream-ws.unit.test.ts`（追加）

三次提交（Task 1 / Task 2 / 无——Task 3 不产出改动，若 Self-Review 发现问题则回退补充提交）。
