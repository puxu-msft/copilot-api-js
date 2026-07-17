---
name: process-lifecycle-shutdown
description: 当在 copilot-api-js 修改进程信号、Ctrl+C、SIGINT/SIGTERM、优雅关闭四步、第二信号强退、TUI raw/cooked 恢复、waitForShutdown latch、History/Telemetry finalization 或 shutdown 状态真值时使用——两信号契约、emergency feedback、stop/drain/abort/force 与 finalizing/stopped 边界、后台维护和 durability barrier 分流、PTY 真终端验收。
---

# 进程生命周期与两信号关闭

## 对外契约

- 第一个 SIGINT/SIGTERM 启动完整关闭流水线，不要求用户逐步按键：stop ingress→graceful drain→deadline 后 abort→abort deadline 后 force-close。
- 第二个终止信号在任何非 `stopped` 状态直接 `process.exit(128+signal)`；SIGINT=130、SIGTERM=143。它不推进 phase、不等待 History/Telemetry/Archive、不依赖日志系统。
- `stopped` 只表示 History terminal、Telemetry outbox、终态通知和资源 close 全部成功。持久化失败进入 `failed` 并 exit 1，不能 resolve 成功 latch。

活实现：`src/lib/shutdown.ts`；活文档：`docs/lifecycle.md`。

## 信号入口的结构要求

第一次信号必须**同步认领 lifecycle**，再启动 async shutdown task；否则两个紧邻信号会落入 idle/phase1 竞态。重复信号判据只读 process state，不按当前 phase 做“升级一格”。

关键反馈用 `terminal-coordinator.emergencyWrite` 的 never-throw wrapper，绕过 consola→observability→FileSink→History。即使 terminal hook 抛错，第二信号仍必须执行 `exitFn`。

`setupShutdownHandlers()` 注册必须幂等，测试 reset 必须成对 `removeListener`。Raw-mode TUI 吞掉 kernel SIGINT，所以第一次 Ctrl+C 由 `TerminalUi.onInput` 转发；收到 draining event 后同步 restore cooked mode，第二次 Ctrl+C 再成为真实 SIGINT。两入口必须调用同一个 `handleShutdownSignal` coordinator。

## 状态真值与 completion latch

内部状态可细分 `idle/stopping/draining/aborting/forcing/finalizing/notifying/stopped/failed`，但不允许把 `finalizing` 提前广播成完成：

1. 请求 operation 已 quiesce 或 force-close。
2. History canonical finalization barrier 完成。
3. Telemetry pending-delta flush/close 完成。
4. 向观察者发布 finalized，并关闭观察者。
5. 才置 `stopped`、打印 complete、resolve completion latch。

`waitForShutdown()` 必须是真 latch：多个早期 waiter 全部 resolve；成功后新 waiter 立即 resolve。不能是“最后一个 resolver”槽。失败路径不 resolve 成功 latch。

## 持久化与后台维护分流

不要把“异步”误等于“可 detached”：`main.ts` 在命令返回后会 `process.exit(0)`，纯 fire-and-forget 会被截断。

- **必须进首次信号 durability barrier**：已接受请求的 History terminal records、Telemetry outbox delta。
- **不应在 shutdown 启动/排空**：History backfill、Archive migration/compact/seal、Telemetry rollup等可恢复后台维护。它们应在 Step 1 seal producer，只完成已领取 durable unit，然后停止；见 skill `archive-background-lifecycle`。
- History DB 必须保持打开直到请求 drain 期间产生的 terminal finalization 全部 settle。Archive DB 只等已领取 unit；不排空 backlog。
- Telemetry 先 seal config callback/timer producer，再 flush serialized outbox，最后 close，防 await 窗口 timer 被热重载重新拉活。

## 错误与退出码

- listener close、force-close 的 best-effort 错误可日志后继续资源收敛。
- History/Telemetry durability barrier reject 是 shutdown failure：状态 `failed`、exit 1，不能打印无条件 success。
- 第二信号是用户显式放弃 durability：立即 130/143，允许丢正在进行的写。
- `uncaughtException`/`unhandledRejection` 保持全局 fail-fast；产生点须用 crash-safety primitive 消灭良性 orphan rejection/error event，不放宽全局策略。

## 测试与实证 oracle

### 组件测试

- 第一个信号自动走四步，卡请求最终有 `server.close(false)`→abort signal→`server.close(true)`。
- 第二信号覆盖 stopping/draining/aborting/forcing/finalizing/notifying，直接调用 exit 130/143；stopped 后忽略。
- controllable History、Telemetry、notification barriers 精确断言顺序；barrier 前 `waitForShutdown` 不 resolve。
- persistence reject 后状态 failed、成功 latch 不 resolve。
- broken terminal hook 不能阻止第二信号 exit。
- production publisher 只在 durability 后发 finalized。

### PTY 真终端

普通 `Bun.spawn` 后台进程可能继承 shell 的 SIGINT ignored disposition，不能作为 Ctrl+C oracle。用 Python `pty.fork()` 启前台真 TTY，向 master 写 `\x03`：

- 第一次反馈“graceful shutdown started”，子进程仍活。
- 真实 TerminalUi raw path 恢复 ICANON+ECHO。
- 第二次在硬超时内 exit 130。
- 连跑 8–25 次证时序确定性；waitpid 必须有硬 deadline，坏实现不能让测试永久挂。

活测试：`tests/shutdown/shutdown.unit.test.ts`、`tests/shutdown/shutdown-signals.it.test.ts`、`tests/shutdown/fixtures/two_signal_pty.py`。

### 运行实例取证

不杀 4141。用 `ss -ltnp` 得 PID，核 `/proc/<pid>/{cwd,cmdline}`；启动日志 `Process: pid=... sha=...` 必须晚于目标提交。再查 `/health`、`/api/status.shutdown.phase`、HOT History API。Archive API 按 effective config 分支：disabled→409 `archive_unavailable`；enabled+initialized→正常响应，不能出现内部 DB-not-initialized 500。

## 常见 false-green

- 单测注入 no-op History/Telemetry，删除真实 await 仍全绿——必须用 controllable barriers。
- 将 `finalized` 在 persistence 前发布，dashboard 显示完成但进程仍写盘。
- 只测 `exitFn` mock，不测 PTY raw/cooked 与真实退出码。
- `Promise.all`/tracked set 表面空，但 sibling work 仍运行——Archive 归 `archive-background-lifecycle` 审计。
- 运行实例只看 `/health`，未核 PID/cwd/sha，可能仍跑旧码。
