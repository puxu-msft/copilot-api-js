---
name: process-lifecycle-shutdown
description: 当在 copilot-api-js 修改或排查进程信号、Ctrl+C、SIGINT/SIGTERM、SIGUSR2 交接、重复信号、graceful shutdown 四步、第二终止信号强退、TUI raw/cooked 恢复、runtime PID 投递、waitForShutdown latch、History/Telemetry/Diagnostic finalization 或 shutdown 状态真值时使用。
---

# 进程生命周期与分类信号关闭

## 对外契约

信号先按语义分类，再结合 lifecycle state 裁决；“已经收到一个信号”本身不是判据。

| 当前状态 | 收到信号 | 行为 |
|---|---|---|
| `idle` | SIGINT/SIGTERM（终止信号） | 启动完整关闭流水线：stop ingress→graceful drain→deadline 后 abort→abort deadline 后 force-close |
| `idle` | SIGUSR2（交接信号） | 启动同一关闭流水线，并保留 `signal === "SIGUSR2"` 供 handoff-only flush/freeze 使用 |
| 非 `idle`、非 `stopped` | SIGINT/SIGTERM | 立即 `process.exit(128+signal)`；SIGINT=130、SIGTERM=143，不推进 phase、不等待任何 durability barrier |
| 非 `idle`、非 `stopped` | SIGUSR2 | 幂等返回已有 shutdown task，不强退、不重新执行 handoff-only 副作用 |
| `stopped` | 任意已注册关闭信号 | 忽略或返回已完成 latch |

如果 shutdown 由 SIGUSR2 启动，随后**第一个** SIGINT/SIGTERM 已经是强退请求；反过来，SIGINT/SIGTERM 启动 shutdown 后再收到 SIGUSR2，SIGUSR2 仍只是幂等交接。故“第二信号强退”是错误简写，准确说法是“lifecycle 已进行时的终止信号强退”。

`stopped` 只表示 History terminal、Telemetry outbox、Diagnostic WAL/sink、终态通知和资源 close 全部成功。持久化失败进入 `failed` 并 exit 1，不能 resolve 成功 latch。

活实现：`src/lib/shutdown.ts`；活文档：`docs/lifecycle.md`。

## 信号入口的结构要求

第一次信号必须**同步认领 lifecycle**，再启动 async shutdown task；否则两个紧邻信号会落入 idle/phase1 竞态。进入非 idle 分支后先用窄类型守卫区分 `SIGINT | SIGTERM` 与 SIGUSR2；`forcedExitCode` 只接受终止信号，禁止用“SIGTERM→143，其余→130”的兜底把未来信号静默归成 SIGINT。

重复信号判据只读 process state，不按当前 phase 做“升级一格”，也不按信号计数器裁决。SIGUSR2 返回现有 `shutdownPromise`；SIGINT/SIGTERM 才进入 emergency exit。关键反馈用 `terminal-coordinator.emergencyWrite` 的 never-throw wrapper，绕过 consola→observability→FileSink→History。即使 terminal hook 抛错，终止信号仍必须执行 `exitFn`。

`setupShutdownHandlers()` 注册必须幂等，测试 reset 必须成对 `removeListener`。Raw-mode TUI 吞掉 kernel SIGINT，所以第一次 Ctrl+C 由 `TerminalUi.onInput` 转发；收到 draining event 后同步 restore cooked mode，第二次 Ctrl+C 再成为真实 SIGINT。两入口必须调用同一个 `handleShutdownSignal` coordinator。

## 信号投递对象：runtime PID，不是启动句柄

信号 handler 的能力结论必须绑定到**实际收到信号的进程**。Volta shim、`bun run`、shell wrapper、supervisor 或测试 harness 可能在 JS runtime 外包一层 launcher：

- `Bun.spawn(...).pid`、`pty.fork()` 返回值、systemd MainPID、pm2 记录 PID 和应用内 `process.pid` 不能预设相同。
- 给 launcher 发 SIGUSR2 可能触发 launcher 的内核默认终止动作，JS runtime 根本没有收到信号；这不能推出“Bun 不支持 `process.on("SIGUSR2")`”。
- 本项目裸接管 pidfile 写的是 `initProcessIdentity().pid`／应用 `process.pid`，因此 `signalPredecessorHandoff` 的目标是 runtime PID。

真实信号探针必须让 fixture 先输出 `process.pid`，驱动端解析后向该 PID 发信号，并分别记录外层启动 PID、runtime PID、PPID、启动命令和 Bun 版本。出现 launcher/runtime 分叉时，再用 `volta which bun` 或等价方式解析出的真实 Bun 二进制作对照。本轮 Linux/Bun 1.3.14 探针中，直接二进制下两 PID 相同且 handler 生效；这只能在该对照条件下把 wrapper 识别为差异变量，不能扩大成所有 Bun 版本、平台或 supervisor 配置都如此。

## 状态真值与 completion latch

内部状态可细分 `idle/stopping/draining/aborting/forcing/finalizing/notifying/stopped/failed`，但不允许把 `finalizing` 提前广播成完成：

1. 请求 operation 已 quiesce 或 force-close。
2. History canonical finalization barrier 完成。
3. Telemetry pending-delta flush/close 完成。
4. Diagnostic 全会话 WAL seal/fsync、长期 sink generation/marker fsync、end/close 完成。
5. 向观察者发布 finalized；观察者 socket 随后 best-effort 关闭。
6. 才置 `stopped`、打印 complete、resolve completion latch。Socket close 失败不作为 durability failure；terminal notification failure 才阻止成功。

`waitForShutdown()` 必须是真 latch：多个早期 waiter 全部 resolve；成功后新 waiter 立即 resolve。不能是“最后一个 resolver”槽。失败路径不 resolve 成功 latch。

## Step 1 停的是「新增工作」，不是「在途请求正在用的资源」

四步流水线里 Step 1 = stop ingress，Step 2/3 承诺给在途请求 60s+120s 自然完成。**任何在 Step 1 拆掉在途请求还要用的资源的动作，都是用 Step 1 的手撕毁 Step 2 的承诺**——而且症状不像关机 bug：客户端看到的是一条几百毫秒就失败的普通请求。

2026-07-28 事故：Step 1 调 `closeHttp2Sessions()`（`poolEpoch++` + 清池），把**正在建 session** 的在途请求当场打死。`maxConcurrentStreamsPerSession=1` 下每条并发请求都得新建 session，所以这不是边缘情况。已建流的请求靠 `session.close()` 的 GOAWAY 语义活得好好的——**正是这一点让它难查**：同刻的兄弟请求正常完成，看起来不像全局 teardown。修法是把 `closeHttp2Sessions()` 移到 Step 4 + `finalize()`（幂等），Step 1 对 h2 不做任何事。

**判据**（改 shutdown 任一 step 时逐个问）：这个 stop 会不会让一条**已被接纳**的在途请求失败？会 → 它属于 Step 4/finalize，Step 1 只保留「停止新增工作」的语义。

**红旗信号**：同族资源的处理不对称。上游 WS 一直是 `stopNew()`（Step 1）/ `closeAll()`（Step 4）两分，h2 却只有一个 `closeHttp2Sessions()` ——这个不对称本身就该引起怀疑，早于任何 incident。

**取证手法**：看**同刻的兄弟请求是否存活**。全局 teardown 会一起死；只杀「正在握手」的那条会留下「早 76ms 起的那条跑完了 7.5s」这种签名。再用「新进程启动时刻 − incident 时刻 ≈ gracefulWait + abortWait + finalize」确认走的是完整优雅关机。

**邻域未查项**（同构、未证实）：Step 1 的 `stopRefresh()` 与 `peekUpstreamWsManager()?.stopNew()` 是否同样饿死 drain 期需要刷 token / 新建上游 WS 的在途请求——记在 `docs/todo/deferred-backlog.md`，别当已排除。

详见 `docs/plan/2026-07-28-shutdown-h2-teardown-and-abort-provenance.md` Phase 1 与记忆 [[methodology-shutdown-step1-stop-new-vs-kill-inflight]]。

## 持久化与后台维护分流

不要把“异步”误等于“可 detached”：`main.ts` 在命令返回后会 `process.exit(0)`，纯 fire-and-forget 会被截断。

- **必须进首次信号 durability barrier**：已接受请求的 History terminal records、Telemetry outbox delta。
- **不应在 shutdown 启动/排空**：History backfill、Archive migration/compact/seal、Telemetry rollup等可恢复后台维护。它们应在 Step 1 seal producer，只完成已领取 durable unit，然后停止；见 skill `archive-background-lifecycle`。
- History DB 必须保持打开直到请求 drain 期间产生的 terminal finalization 全部 settle。Archive DB 只等已领取 unit；不排空 backlog。
- Telemetry 先 seal config callback/timer producer，再 flush serialized outbox，最后 close，防 await 窗口 timer 被热重载重新拉活。
- Diagnostic 细节归 skill `diagnostic-durability`：不要在 `StructuredFileSink` 内补 flush 循环；全会话 WAL、delivery identity、roll/file+directory fsync、generation-keyed facade 和分层 oracle 必须整体维护。

## 错误与退出码

- listener close、force-close 的 best-effort 错误可日志后继续资源收敛。
- History/Telemetry/Diagnostic durability barrier reject 是 shutdown failure：状态 `failed`、exit 1，不能打印无条件 success。
- lifecycle 已进行时的 SIGINT/SIGTERM 是用户显式放弃 durability：立即 130/143，允许丢正在进行的写。
- `uncaughtException`/`unhandledRejection` 保持全局 fail-fast；产生点须用 crash-safety primitive 消灭良性 orphan rejection/error event，不放宽全局策略。

## 测试与实证 oracle

### 组件测试

- idle 下 SIGINT、SIGTERM、SIGUSR2 都能启动四步；卡请求最终有 `server.close(false)`→abort signal→`server.close(true)`。
- 以 SIGINT 和 SIGUSR2 两种入口分别启动 held shutdown，再发 SIGUSR2：两次都返回同一个 promise，`exitFn` 不被调用。
- 以 SIGUSR2 启动 held shutdown，再发 SIGINT/SIGTERM：即使这是本轮第一个终止信号，也立即 exit 130/143。
- SIGINT/SIGTERM 覆盖 stopping/draining/aborting/forcing/finalizing/notifying 的强退；`stopped` 后忽略。
- controllable History、Telemetry、Diagnostic、notification barriers 精确断言顺序；barrier 前 `waitForShutdown` 不 resolve。
- persistence reject 后状态 failed、成功 latch 不 resolve。
- broken terminal hook 不能阻止 lifecycle 已进行时的 SIGINT/SIGTERM exit。
- production publisher 只在 durability 后发 finalized。
- Diagnostic production facade 必须用真实 attach→shutdown integration 覆盖；默认无 active sink 的 no-op 不能充当接线测试。

### PTY 真终端

普通 `Bun.spawn` 后台进程可能继承 shell 的 SIGINT ignored disposition，不能作为 Ctrl+C oracle。用 Python `pty.fork()` 启前台真 TTY，向 master 写 `\x03`：

- 第一次 Ctrl+C 反馈“graceful shutdown started”，子进程仍活。
- fixture 输出 runtime `process.pid`；驱动向该 PID 发 SIGUSR2，等待一个足以让坏实现退出的窗口，同时确认外层 launcher 与 runtime 都仍存活，且输出没有 `Second termination signal (SIGUSR2)`。
- 真实 TerminalUi raw path 恢复 ICANON+ECHO。
- 随后的 Ctrl+C 在硬超时内 exit 130，证明修 SIGUSR2 没削弱逃生舱。
- 连跑 8–25 次证时序确定性；waitpid 必须有硬 deadline，并保存中途已 reap 的 status，坏实现不能把 `ChildProcessError` 冒充产品失败。

活测试：`tests/shutdown/shutdown.unit.test.ts`、`tests/shutdown/shutdown-signals.pty.test.ts`、`tests/shutdown/fixtures/two_signal_pty.py`。

### 运行实例取证

不杀 4141。用 `ss -ltnp` 得 PID，核 `/proc/<pid>/{cwd,cmdline}`；启动日志 `Process: pid=... sha=...` 必须晚于目标提交。再查 `/health`、`/api/status.shutdown.phase`、HOT History API。Archive API 按 effective config 分支：disabled→409 `archive_unavailable`；enabled+initialized→正常响应，不能出现内部 DB-not-initialized 500。

## 常见 false-green

- `process.listenerCount("SIGUSR2") === 1` 只证明 JS 注册表有 listener，不证明 OS 信号送到了 runtime PID。
- PTY 向 `pty.fork()` 返回的外层 launcher PID 发 SIGUSR2，测到的是 wrapper 默认动作，不是应用 handler。
- 单测注入 no-op History/Telemetry，删除真实 await 仍全绿——必须用 controllable barriers。
- 将 `finalized` 在 persistence 前发布，dashboard 显示完成但进程仍写盘。
- 只测 `exitFn` mock，不测 PTY raw/cooked 与真实退出码。
- `Promise.all`/tracked set 表面空，但 sibling work 仍运行——Archive 归 `archive-background-lifecycle` 审计。
- 运行实例只看 `/health`，未核 PID/cwd/sha，可能仍跑旧码。
- 单个 250ms sink race 同时声称证明 backend callback、durability、fsync、shutdown——测试真相域错配；按 `diagnostic-durability` 五层矩阵拆开。

## 鉴别力正控

提交前冻结一份只删除 `if (!isTerminationSignal(signal)) return shutdownPromise` 的 exact patch：注入后，组件测试应观测到错误的 exit 130，真实 PTY 应观测到 SIGUSR2 后 runtime/launcher 至少一方提前死亡；反向恢复同一 patch 后两者重新变绿。若只红一侧，说明另一侧没有覆盖它声称的机制；若两侧都不红，禁止用“测试已覆盖 SIGUSR2”作结论。
