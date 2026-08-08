---
name: process-lifecycle-shutdown
description: 当在 copilot-api-js 修改或排查进程信号、Ctrl+C、SIGINT/SIGTERM、SIGUSR2 交接、首信号无损 drain、重复信号、第二终止信号强退、TUI raw/cooked 恢复、runtime PID 投递、waitForShutdown latch、History/Telemetry/Diagnostic finalization 或 shutdown 状态真值时使用。
---

# 进程生命周期与分类信号关闭

## 对外契约

信号先按语义分类，再结合 lifecycle state 裁决；“已经收到一个信号”本身不是判据。

| 当前状态 | 收到信号 | 行为 |
|---|---|---|
| `idle` | SIGINT／SIGTERM | 停止 ingress，无损 drain 已接纳 operation，再执行 durability finalization |
| `idle` | SIGUSR2 | 启动同一无损 drain，并保留 `signal === "SIGUSR2"` 供 handoff-only flush／freeze 使用 |
| 非 `idle`、非 `stopped` | SIGINT／SIGTERM | 立即 `process.exit(128+signal)`；SIGINT=130、SIGTERM=143，不等待请求或 durability barrier |
| 非 `idle`、非 `stopped` | SIGUSR2 | 幂等返回已有 shutdown task，不强退、不重新执行 handoff-only 副作用 |
| `stopped` | 任意已注册关闭信号 | 忽略或返回已完成 latch |

如果 shutdown 由 SIGUSR2 启动，随后第一个 SIGINT／SIGTERM 已经是强退请求；反过来，SIGINT／SIGTERM 启动 shutdown 后再收到 SIGUSR2，SIGUSR2 仍只是幂等交接。

`stopped` 只表示 operation registry 清零、History terminal、Telemetry outbox、Diagnostic WAL／sink、终态通知和资源 close 全部成功。持久化失败进入 `failed` 并 exit 1，不能 resolve 成功 latch。

活实现：`src/lib/shutdown.ts`；活文档：`docs/lifecycle.md`；冻结规格：`docs/spec/2026-08-07-lossless-graceful-shutdown-drain.md`。

## 信号入口的结构要求

第一次信号必须同步认领 lifecycle，再启动 async shutdown task；否则两个紧邻信号会落入 idle／stopping 竞态。进入非 idle 分支后先用窄类型守卫区分 `SIGINT | SIGTERM` 与 SIGUSR2；`forcedExitCode` 只接受终止信号，禁止把未来信号静默归成 SIGINT。

重复信号判据只读 process state，不按当前 phase 做“升级一格”，也不按信号计数器裁决。SIGUSR2 返回现有 `shutdownPromise`；SIGINT／SIGTERM 才进入 emergency exit。关键反馈用 `terminal-coordinator.emergencyWrite` 的 never-throw wrapper，绕过 consola→observability→FileSink→History。

`setupShutdownHandlers()` 注册必须幂等，测试 reset 必须成对 `removeListener`。Raw-mode TUI 吞掉 kernel SIGINT，所以第一次 Ctrl+C 由 `TerminalUi.onInput` 转发；收到 draining event 后同步 restore cooked mode，第二次 Ctrl+C 再成为真实 SIGINT。

## 信号投递对象：runtime PID，不是启动句柄

信号 handler 的能力结论必须绑定到实际收到信号的进程。Volta shim、`bun run`、shell wrapper、supervisor 或测试 harness 可能在 JS runtime 外包一层 launcher：

- `Bun.spawn(...).pid`、`pty.fork()` 返回值、systemd MainPID、pm2 记录 PID 和应用内 `process.pid` 不能预设相同。
- 给 launcher 发 SIGUSR2 可能触发 launcher 的内核默认终止动作，JS runtime 根本没有收到信号；这不能推出“Bun 不支持 `process.on("SIGUSR2")`”。
- 本项目裸接管 pidfile 写应用 `process.pid`，因此 handoff 目标是 runtime PID。

真实信号探针必须让 fixture 先输出 `process.pid`，驱动端解析后向该 PID 发信号，并分别记录外层启动 PID、runtime PID、PPID、启动命令和 Bun 版本。

## 状态真值与 completion latch

内部状态为 `idle/stopping/draining/finalizing/notifying/stopped/failed`。不允许把 `finalizing` 提前广播成完成：

1. `RequestContextManager.getTrackedOperations()` 已清零。
2. generation finalizer registry 已 join，且 canonical terminal 失败已显式暴露。
3. token runtime 与上游 WS／h2 已关闭。
4. History、Telemetry、Diagnostic durability barrier 完成。
5. 向观察者发布 finalized；观察者 socket 随后 best-effort 关闭。
6. 才置 `stopped`、打印 complete、resolve completion latch。

`waitForShutdown()` 必须是真 latch：多个早期 waiter 全部 resolve；成功后新 waiter 立即 resolve。失败路径不 resolve 成功 latch。

## 首信号停的是 ingress，不是在途请求能力

“已接纳”以 `RequestContextManager.getTrackedOperations()` 为机械边界。context 从创建起进入 registry，直到 operation body quiesce、delivery finalize 和 immutable canonical terminal 发布完成后才离开。

首信号阶段只允许：

- `_isShuttingDown=true`，middleware 拒绝新 ingress；
- `server.close(false)` 停止监听；
- `stopReaper()`；
- 停止 History maintenance、Telemetry rollup 等不属于请求完成路径的后台 producer；
- SIGUSR2 handoff 专属的 states flush／freeze。

首信号阶段禁止：

- rate limiter `rejectQueued()`；
- token runtime `dispose()`；
- upstream WS `stopNew()`／`closeAll()`；
- `closeHttp2Sessions()`；
- `server.close(true)`；
- 任何 process-global shutdown AbortSignal 或固定 drain deadline。

已接纳请求可能仍需等待 permit、刷新 token、创建新的 upstream WS／h2 session、策略重试或写终态。任何提前拆除都会制造请求失败。

2026-08-07 incident：三个仍在持续产帧的长请求在旧 300 秒 `graceful_wait` 后同秒收到 `Server is shutting down`。现行修复删除该 deadline、process-global abort、529 改写和 `aborting/forcing` phase。

## 请求终止权

请求只由请求级机制结束：正常协议终态、客户端取消、`timeouts.request_deadline`、response-header timeout、stream-idle timeout、request lifecycle cancel 或真实上游错误。

2026-08-08 起 bundled `request_deadline=0`、`stale_request_max_age=0`，避免仅凭 wall-clock 误杀无上界合法思考。运维显式设正值才启用。两者都为 0 时首信号可能无限等待真正泄漏的请求；操作者用 SIGINT／SIGTERM 显式强退，而不是在 shutdown 内另造隐式 deadline。

## 持久化与后台维护分流

- 必须贯穿 drain：已接纳请求的 History terminal、Telemetry delta、Diagnostic、token refresh、rate-limit admission、上游 transport。
- 首信号可停：History maintenance、Telemetry rollup 等可恢复且不服务已接纳 operation 的后台 producer。
- History DB 必须保持打开，直到 operation registry 清零且 canonical terminal finalizer join 完成。
- Telemetry 先 seal config callback／timer producer，再 flush serialized outbox，最后 close。

## 错误与退出码

- listener `close(false)` 的 best-effort 错误可记录后继续；不存在首信号 `close(true)`。
- token／History／Telemetry／Diagnostic durability barrier reject 是 shutdown failure：状态 `failed`、exit 1，不能打印 success。
- lifecycle 已进行时的 SIGINT／SIGTERM 是用户显式放弃请求与 durability：立即 130／143。
- `uncaughtException`／`unhandledRejection` 保持全局 fail-fast。

## 测试与实证 oracle

### 组件测试

- 首信号调用 `server.close(false)`，跨过旧 deadline 后仍停在 `draining`，且不调用 rate limiter reject、token close、WS／h2 close 或 `server.close(true)`。
- operation registry 清零后，token、upstream transport、History、Telemetry、Diagnostic 和 finalized 通知按序执行。
- `request_deadline` 独立测试仍能终止运维显式设限的 context。
- 以 SIGINT 和 SIGUSR2 两种入口启动 held shutdown，再发 SIGUSR2：两次都返回同一个 promise，`exitFn` 不被调用。
- 以 SIGUSR2 启动 held shutdown，再发 SIGINT／SIGTERM：立即 exit 130／143。
- controllable durability barriers 精确断言顺序；barrier 前 `waitForShutdown` 不 resolve。

### PTY 真终端

- fixture 输出 runtime `process.pid`，驱动向该 PID 发 SIGUSR2，确认 runtime／launcher 都仍存活且无 second-termination 日志。
- 第一次 Ctrl+C 反馈“graceful shutdown started”，恢复 ICANON／ECHO。
- 随后的 Ctrl+C 在硬超时内 exit 130。
- 连跑 8–25 次证时序确定性；waitpid 必须有硬 deadline，并保存中途已 reap 的 status。

活测试：`tests/shutdown/shutdown.unit.test.ts`、`tests/shutdown/shutdown-signals.pty.test.ts`、`tests/shutdown/fixtures/two_signal_pty.py`。

## 常见 false-green

- mock tracker 手动清零，但真实 operation registry 未覆盖 retry／response pump／canonical finalizer。
- 只断言“没有调用 abort”，却未证明 token／rate limiter／新 transport 在 drain 期仍可用。
- `process.listenerCount("SIGUSR2") === 1` 只证明 JS 注册表有 listener，不证明 OS 信号送到了 runtime PID。
- PTY 向外层 launcher PID 发 SIGUSR2，测到的是 wrapper 默认动作，不是应用 handler。
- 单测注入 no-op History／Telemetry，删除真实 await 仍全绿。
- 将 `finalized` 在 persistence 前发布。
- 只测 `exitFn` mock，不测 PTY raw／cooked 与真实退出码。

## 鉴别力正控

冻结一份只删除 `if (!isTerminationSignal(signal)) return shutdownPromise` 的 exact patch：注入后，组件测试应观测到错误 exit 130，真实 PTY 应观测到 SIGUSR2 后 runtime／launcher 至少一方提前死亡；反向恢复后两者重新变绿。
