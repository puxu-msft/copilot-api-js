---
name: process-lifecycle-shutdown
description: 当在 copilot-api-js 修改进程信号、Ctrl+C、SIGINT/SIGTERM、首信号无损 drain、第二信号强退、TUI raw/cooked 恢复、waitForShutdown latch、History/Telemetry/Diagnostic finalization 或 shutdown 状态真值时使用——两信号契约、stop-ingress/lossless-drain/finalize 边界、后台维护和 durability barrier 分流、PTY 真终端验收。
---

# 进程生命周期与两信号关闭

## 对外契约

- 第一个 SIGINT／SIGTERM／SIGUSR2 同步认领 lifecycle，停止 ingress，无限等待已接纳 operation 自行终态，再执行 durability finalization。shutdown 不拥有请求终止 deadline，也不发送 request abort。
- 第二个终止信号在任何非 `stopped` 状态直接 `process.exit(128+signal)`；SIGINT=130、SIGTERM=143。它不推进 phase、不等待请求、History、Telemetry 或 Diagnostic。
- `stopped` 只表示 operation registry 清零、History terminal、Telemetry outbox、Diagnostic WAL／sink、终态通知和资源 close 全部成功。持久化失败进入 `failed` 并 exit 1，不能 resolve 成功 latch。

活实现：`src/lib/shutdown.ts`；活文档：`docs/lifecycle.md`；冻结规格：`docs/spec/2026-08-07-lossless-graceful-shutdown-drain.md`。

## 信号入口的结构要求

第一次信号必须同步认领 lifecycle，再启动 async shutdown task；否则两个紧邻信号会落入 idle／stopping 竞态。重复信号判据只读 process state，不按当前 phase 做“升级一格”。

关键反馈用 `terminal-coordinator.emergencyWrite` 的 never-throw wrapper，绕过 consola→observability→FileSink→History。即使 terminal hook 抛错，第二信号仍必须执行 `exitFn`。

`setupShutdownHandlers()` 注册必须幂等，测试 reset 必须成对 `removeListener`。Raw-mode TUI 吞掉 kernel SIGINT，所以第一次 Ctrl+C 由 `TerminalUi.onInput` 转发；收到 draining event 后同步 restore cooked mode，第二次 Ctrl+C 再成为真实 SIGINT。两入口必须调用同一个 `handleShutdownSignal` coordinator。

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

“已接纳”以 `RequestContextManager.getTrackedOperations()` 为机械边界。一个 context 从创建起进入 registry，直到 operation body quiesce、delivery finalize 和 immutable canonical terminal 发布完成后才离开。

首信号阶段只允许：

- `_isShuttingDown=true`，middleware 拒绝新 ingress；
- `server.close(false)` 停止监听；
- `stopReaper()`；
- 停止 History maintenance、Telemetry rollup 等不属于请求完成路径的后台 producer；
- SIGUSR2 handoff 专属的 states flush-then-freeze。

首信号阶段禁止：

- rate limiter `rejectQueued()`；
- token runtime `dispose()`；
- upstream WS `stopNew()`／`closeAll()`；
- `closeHttp2Sessions()`；
- `server.close(true)`；
- 任何 process-global shutdown AbortSignal 或固定 drain deadline。

已接纳请求可能仍需等待 permit、刷新 token、创建新的 upstream WS／h2 session、策略重试或写终态。任何提前拆除都会用 shutdown 自己的手制造请求失败。

2026-08-07 incident：三个仍在持续产帧的长请求在旧 300 秒 `graceful_wait` 后同秒收到 `Server is shutting down`。这是旧自动 abort 契约的必然结果，不是日志分类问题。现行修复删除该 deadline、process-global abort、529 改写和 `aborting/forcing` phase。完整证据见冻结规格。

## 请求终止权

请求只由请求级机制结束：正常协议终态、客户端取消、`timeouts.request_deadline`、response-header timeout、stream-idle timeout、request lifecycle cancel 或真实上游错误。

首信号停止 stale reaper，但每个 context 已武装的精确 `request_deadline` 继续生效。若 `request_deadline=0`，首信号可能无限等待真正泄漏的请求；这是配置选择，操作者用第二信号显式放弃，而不是在 shutdown 内另造一个隐式 deadline。

## 持久化与后台维护分流

不要把“异步”误等于“可 detached”：`main.ts` 在命令返回后会 `process.exit(0)`，纯 fire-and-forget 会被截断。

- 必须贯穿 drain：已接纳请求的 History terminal、Telemetry delta、Diagnostic、token refresh、rate-limit admission、上游 transport。
- 首信号可停：History maintenance、Telemetry rollup 等可恢复且不服务已接纳 operation 的后台 producer。
- History DB 必须保持打开，直到 operation registry 清零且 canonical terminal finalizer join 完成。
- Telemetry 先 seal config callback／timer producer，再 flush serialized outbox，最后 close。
- Diagnostic 细节归 skill `diagnostic-durability`。

## 错误与退出码

- listener `close(false)` 的 best-effort 错误可记录后继续；不存在首信号 `close(true)`。
- token／History／Telemetry／Diagnostic durability barrier reject 是 shutdown failure：状态 `failed`、exit 1，不能打印 success。
- 第二信号是用户显式放弃请求与 durability：立即 130／143。
- `uncaughtException`／`unhandledRejection` 保持全局 fail-fast；产生点须用 crash-safety primitive 消灭良性 orphan rejection／error event，不放宽全局策略。

## 测试与实证 oracle

### 组件测试

- 首信号调用 `server.close(false)`，跨过旧 deadline 后仍停在 `draining`，且不调用 rate limiter reject、token close、WS／h2 close 或 `server.close(true)`。
- operation registry 清零后，token、upstream transport、History、Telemetry、Diagnostic 和 finalized 通知按序执行。
- `request_deadline` 独立测试仍能终止真正超时的 context，证明无损 drain 不等于允许泄漏。
- 第二信号覆盖 stopping／draining／finalizing／notifying／failed，直接调用 exit 130／143；stopped 后忽略。
- controllable History、Telemetry、Diagnostic、notification barriers 精确断言顺序；barrier 前 `waitForShutdown` 不 resolve。
- persistence reject 后状态 failed、成功 latch 不 resolve。
- broken terminal hook 不能阻止第二信号 exit。

### PTY 真终端

普通 `Bun.spawn` 后台进程可能继承 shell 的 SIGINT ignored disposition，不能作为 Ctrl+C oracle。用 Python `pty.fork()` 启前台真 TTY，向 master 写 `\x03`：

- 第一次反馈“graceful shutdown started”，子进程仍活。
- 真实 TerminalUi raw path 恢复 ICANON+ECHO。
- 第二次在硬超时内 exit 130。
- 连跑 8–25 次证时序确定性；waitpid 必须有硬 deadline。

活测试：`tests/shutdown/shutdown.unit.test.ts`、`tests/shutdown/shutdown-signals.pty.test.ts`、`tests/shutdown/fixtures/two_signal_pty.py`。

### 运行实例取证

不杀 4141。用 `ss -ltnp` 得 PID，核 `/proc/<pid>/{cwd,cmdline}`；启动日志 `Process: pid=... sha=...` 必须晚于目标提交。再查 `/health`、`/api/status.shutdown.phase` 和 HOT History API。

## 常见 false-green

- mock tracker 手动清零，但真实 operation registry 未覆盖 retry／response pump／canonical finalizer。
- 只断言“没有调用 abort”，却未证明 token／rate limiter／新 transport 在 drain 期仍可用。
- 单测注入 no-op History／Telemetry，删除真实 await 仍全绿。
- 将 `finalized` 在 persistence 前发布，dashboard 显示完成但进程仍写盘。
- 只测 `exitFn` mock，不测 PTY raw／cooked 与真实退出码。
- 运行实例只看 `/health`，未核 PID／cwd／sha，可能仍跑旧码。
