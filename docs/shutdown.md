# 优雅关闭与请求生命周期

## 优雅关闭

`src/lib/shutdown.ts` 实现 4 阶段优雅关闭：

### Phase 1: Setup（立即）
- 停止接受新请求
- 标记服务器为 draining 状态
- 停止后台服务（token 刷新 `stopRefresh`、关闭 HTTP/2 会话池 `closeHttp2Sessions`、停止新建上游 WebSocket `stopNew`）
- 停止 history 后台工作（reaper / search-index backfill），但**保持 history DB 打开**——异步 finalize（[spec/history-finalize-async-offload.md](spec/history-finalize-async-offload.md)）的落盘要贯穿 Phase 2/3 drain，故 DB 的 drain-未决-finalize-再-close 推迟到 Finalized 阶段（`shutdownHistory`），旧的 Phase-1 同步关 DB 会丢 drain 期间 settle 的请求
- 排空 rate limiter 队列
- 停止监听新连接（`server.close(false)`，已建连接保留）
- **注意：浏览器观察者 WS 客户端（history/status dashboard）此时不关**——它们订阅 phase 事件，Phase 1 关掉会让用户看不到后续进度；故意留到 Phase 4 才拆

### Phase 2: Graceful Wait
- 等待活跃请求自然完成
- 超时：`state.shutdownGracefulWait` 秒（默认 60）

### Phase 3: Abort
- 向所有仍在进行的请求发送 abort signal
- 等待 handler 处理 abort 并清理
- 超时：`state.shutdownAbortWait` 秒（默认 120）

> **2026-07-14 修复（RFC `2026-07-14-request-lifecycle-cancel-settle-quiesce`）**：此前 streaming 请求的 pre-response fetch **故意排除** shutdown signal（`send.ts` 旧 `stream ? undefined : getShutdownSignal()`），导致 delayed-commit 期卡在 pre-response `await p`（stream-body guard 尚不存在）的流式请求 **Phase 3 abort 够不着** → 一直挂到 Phase 4 强关（2026-07-12 实测卡 120s）。现已改为**对 stream/non-stream 一律折入稳定 shutdown signal**（RC1）。同时 driver 退避改 `abortableDelay` + attempt 边界 cancel gate（RC3），shutdown/reaper 能中断退避、settle 后不起新 attempt。

### Shutdown 信号（稳定信号）

`getShutdownSignal()` 返回一个**进程启动即创建、稳定存在**的 `AbortSignal`，仅在 Phase 3 `abort()` 一次：

- **为什么稳定**：每个在途流式请求 / 上游 fetch 在发起时就把该信号注册进自己的 abort race。若信号延迟到 Phase 1 才创建（返回 `undefined`），一个在 shutdown 开始**之前**就阻塞在停滞上游上的 `iterator.next()` 会捕获 `undefined`，从而**永远观察不到**后来的 Phase 3 abort（只能等 idle timeout / Phase 4 强杀）。稳定信号消除了这个时序缺陷。
- **"是否在 shutdown" 用 `getIsShuttingDown()` 判断**（Phase 1 置位），**不要**用信号是否存在来判断。Phase 3 的 abort 用 `getShutdownSignal().aborted` 判断。
- **约束：shutdown 不可取消**。eager 单例从不重建（`_resetShutdownState` 仅供测试重置），`_isShuttingDown` 守卫保证 `gracefulShutdown` 不重入、Phase 3 的 `abort()` 只调一次。若未来要支持"取消 shutdown"，需重新设计该单例生命周期。
- 流式消费者（`guardSseIterable` / `processAnthropicStream`）把该信号 + per-request 客户端断开信号转发进一个 per-stream 本地 controller，并在所有退出路径**显式移除 listener**——共享信号上每个流恰好 1 个 listener、确定性回收，不依赖 GC。

### Phase 4: Force Close
- 强制关闭所有连接（`server.close(true)`）
- 关闭浏览器观察者 WS 客户端（`closeAllClients`）——延迟到此刻，使 dashboard 能观察到 phase2/3/4 全过程
- 关闭所有上游 WebSocket 连接（`peekUpstreamWsManager().closeAll()`）

### 信号升级

多次收到终止信号（SIGINT/SIGTERM）时的行为：

| 当前 Phase | 信号效果 |
|-----------|---------|
| Phase 1 | 忽略（Phase 1 很快完成，马上进入 Phase 2） |
| Phase 2 | 跳过等待，升级到 Phase 3（发送 abort signal） |
| Phase 3 | 跳过等待，升级到 Phase 4（强制关闭） |
| Phase 4 | `process.exit(1)` 立即退出 |
| Finalized | 忽略（清理已在进行） |

注意：`bun run --watch` 模式下，Ctrl+C 可能导致信号被发送两次（父子进程各一次）。
Phase 1 的信号忽略确保这种情况不会导致意外退出。

## 请求上下文管理

`RequestContextManager`（`src/lib/context/manager.ts`）跟踪所有活跃请求的生命周期：

- 每个请求创建一个 `RequestContext`（`src/lib/context/request.ts`）
- 状态机：非终态 `pending` → `executing` → `streaming`，终态 `completed` / `failed` / `aborted` / `interrupted`（`RequestLifecycleState`，`src/lib/history/types.ts`）
- 生命周期事件经 observability bus 发布（`src/lib/observability/`），各 sink（console / file / history / telemetry / ws）订阅消费：请求完成时落盘 / 广播（取代已删除的 `consumers.ts` 消费者注册模型）

### Stale Request Reaper

- `state.staleRequestMaxAge`：活跃请求最大存活秒数（默认 600，0 = 禁用）
- 超时的请求由 reaper 强制清理，防止泄漏
- 安全网机制：正常情况下请求应通过 stream 完成或超时自然终结

### Hard Request Deadline（`request_deadline`，2026-07-14 新增，RC2 治根）

- `state.requestDeadline`（config `timeouts.request_deadline`，bundled 默认 900s，0 = 禁用）：单请求**硬总时长上限**，是用户可依赖的 SLA。
- **由 per-request 精确 `setTimeout` 强制**（`manager.create` 武装、`onSettled` 清除、`unref`），到点调用与 reaper 同款 `reapInFlight()`（取消在飞上游）+ `fail()`（记终态）。
- **为何独立于 stale reaper**：reaper 是**周期扫描**（`staleRequestMaxAge/3` clamp 到 [250ms,60s]），实测会**迟到**（一次迟 198s，age 1398s vs max 1200s）——候选机制：config 热重载改阈值但 scan cadence 冻结、或**进程/WSL2 suspend** 让所有 timer 一起冻结（诊断见 `reaper-diagnostics.ts`，坐实判据 = 墙钟 gap vs 单调 gap）。per-request timer 按 T 精确触发、**绕过**这个迟到。
- **两旋钮关系**：`request_deadline`（精确、主上限）应 < `stale_request_max_age`（周期、泄漏兜底），reaper 只兜底越过 deadline 仍未静止的异常。
- **dry-run 豁免**：capturing manager（`withCapturingManager`）传 `armDeadlineTimers:false`，inspection ctx 不武装 deadline。

相关代码：`src/lib/shutdown.ts`、`src/lib/context/`、`src/lib/observability/reaper-diagnostics.ts`
