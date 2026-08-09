# 优雅关闭、优雅重启与请求生命周期

> **运行验证（2026-07-16）**：用户重启后的 4141 进程从主树启动，日志记录 `pid=1762072 sha=27b65b89-dirty`（晚于 lifecycle `e7bc33d0` 与 Archive follow-up `27b65b89`），`/health` healthy、shutdown phase=`idle`、HOT History API 正常。**2026-07-18 更新**：内置三层降温归档已随 History V2 removal 整体退役，Archive API 不再存在，`?tier=archive` 固定返回 `400`（见 [API.md](API.md)「History REST」）；本条运行验证记录的 `409 archive_unavailable` 是当时（Archive 仍在生产）的实测结果，现已过时，仅作历史时间点记录保留。

维护入口：进程两信号关闭与 durability barrier 见 skill `process-lifecycle-shutdown`；Archive durable-unit 协作停与恢复见 skill `archive-background-lifecycle`。

优雅重启（零停机换代）本质是「新进程接管 + 旧进程复用同一套 drain 流水线」，与优雅关闭共享同一生命周期，故合为一篇。阅读顺序：先「优雅关闭」（drain 机制是基础），再「优雅重启」（在其上叠加接管协议）。

## 优雅关闭

`src/lib/shutdown.ts` 实现首信号无损排空。shutdown 只拥有进程入口和资源生命周期，不拥有请求终止权。

信号契约分为终止信号与交接信号：

1. idle 时收到 SIGINT／SIGTERM／SIGUSR2，同步认领 lifecycle，停止 ingress，并等待已接纳 operation 自行终态。
2. lifecycle 已经进行时收到 SIGINT／SIGTERM，立即 `process.exit(128 + signal)`；SIGINT 为 130，SIGTERM 为 143。它不等待请求、持久化、通知或日志。
3. lifecycle 已经进行时收到 SIGUSR2，幂等返回已有 shutdown task，不强退、不重复 handoff-only 副作用。

信号必须投递到应用记录的 runtime PID。Bun CLI／Volta shim 可能在 JS runtime 外再包一层 launcher；给 launcher 发 SIGUSR2 会走内核默认动作，根本到不了 `process.on("SIGUSR2")`。裸接管 pidfile 写入 `process.pid`；PTY 回归也从子进程输出读取 runtime PID 后发信号。

### Stop ingress（立即）

- `_isShuttingDown` 置位，middleware 拒绝此后进入的新请求。
- `server.close(false)` 停止监听新连接，保留已建连接。
- `RequestContextManager.stopReaper()` 停止周期泄漏扫描；每个 context 已武装的 `request_deadline` 继续生效。
- 停止 History maintenance 和 Telemetry rollup 等后台 producer，但保持 History、Telemetry 与 Diagnostic 写入可用。
- 浏览器观察者 WS 保持连接，用于观察 draining 和 finalized。
- token runtime、rate limiter 队列、上游 WS／h2 池保持完整能力。已接纳 operation 可能仍需刷新 token、等待 permit、创建新 transport 或重试；首信号拆除其中任一资源都会破坏无损契约。

### Lossless drain

`RequestContextManager.getTrackedOperations()` 与 lightweight operation in-flight registry 共同构成“已接纳”的机械边界。generation context 从创建起进入 manager registry，直到 operation body quiesce、delivery finalize 和 immutable canonical terminal 发布完成后才离开；count_tokens／embeddings 从创建起进入 lightweight registry，在 terminal publish 完成后注销。

shutdown 不设置自己的排空 deadline，也不发布 request abort。请求只由正常协议终态、客户端取消、`timeouts.request_deadline`、response-header timeout、stream-idle timeout等请求级机制结束。只要 registry 非空，进程继续轮询并定期输出活跃请求摘要。

> **[wip] 超长驻留 operation 的 lifecycle 修复**——退出摘要曾打出 `POST /v1/messages gpt-5.6-sol (failed, 17620s)` 这种自相矛盾的行：logical terminal 已是 `failed`，operation 却仍占着 registry 不走。根因是 candidate／dispatch／delivery／operation owner 四类 lifecycle 事实被混为一谈（`failed` ≠ quiesced），修法是拆开这四类并给 manager 单一 release primitive。**唯一入口：[plan/2026-08-08-long-resident-operation-lifecycle/HANDOVER.md](plan/2026-08-08-long-resident-operation-lifecycle/HANDOVER.md)**（spec、plan、评审证据、Tasks 5–8 的两道启动 gate 都从那里进）。**当前状态：文档已在主线，Tasks 1–4 的代码仍只在特性分支 `fix-long-resident-operations` 上、未合并**——本节描述的仍是 master 现行行为。

### Finalizing 与 Stopped

registry 清零后，进程进入 `finalizing`：

1. `RequestContextManager.drainModelOperationFinalizations()` join finalizer registry，并暴露排空期间记录的 canonical terminal 发布失败。
2. 释放 token runtime，随后关闭上游 WebSocket 与 h2 池。此时不存在会被 teardown 中断的 operation。
3. `shutdownHistory()` 排空 terminal subscriber／V3 writer并关闭数据库。
4. `shutdownRequestTelemetry()` 封闭 config 订阅与 timer producer，排空 pending delta 并关闭数据库。
5. `shutdownStructuredFileSink()` 写 sealing marker，排空并 fsync Diagnostic。
6. durability barrier 全部成功后向观察者发布 `finalized`，再关闭观察者 WS。
7. 所有资源成功关闭后进入 `stopped` 并 resolve `waitForShutdown()`；任一 barrier 失败则进入 `failed`，不 resolve 成功 latch。

`finalizing` 不等于完成；该阶段的第二次 Ctrl+C 仍立即强退。`waitForShutdown()` 是真正的 latch：多个并发 waiter 都会被唤醒，关闭完成后才注册的 waiter 也会立即 resolve。

### 用户可见反馈不依赖持久化

第一次和第二次信号的关键反馈经 `terminal-coordinator.emergencyWrite()` 直接写当前终端 owner；无 TUI owner 时由 `EmergencyOutput` best-effort 写 stderr。它不经过 consola adapter、observability bus、StructuredFileSink、History 或 Telemetry，避免“History 正在落盘，所以 Ctrl+C 看起来没有响应”的依赖环。普通阶段进度日志走 canonical `system.diagnostic` 管线。finalize 聚合 History/Telemetry/diagnostic 三个 barrier：writer drop/error 是 sticky failure，发布 `system.shutdown_failed` 且不 resolve 成功 latch；只有全部 durability barrier 成功才发布唯一 finalized wire 终态并进入 stopped。

纯 JavaScript 信号回调只能在事件循环获得调度时运行。主树 History finalize 已把 zstd 放到 libuv，并分片搜索索引，但大型 `JSON.stringify` 与短同步 SQLite transaction 仍可能造成有界延迟；第二信号一旦进入 JS handler，绝不再等待这些 barrier。若未来实测同步块重新增长，必须继续把 CPU prepare 移出主线程，而不是削弱两信号契约。

`bun run dev` 使用 `bun --watch`。若 watch 父子进程把用户的一次 Ctrl+C 分别转发成两个 SIGINT，进程会按统一契约把第二个信号解释为强退；这是刻意保持“第二个进程信号永远是逃生舱”的结果，而不是再引入按时间猜测“重复信号”的特殊窗口。需要验证完整持久化关闭时，应使用 `bun run start`；watch 模式的首要目标是快速结束开发进程树。

## 优雅重启（零停机换代）

> 状态：**已实施**（`feat/graceful-restart`，Task 0-15 全落地 + 两轮异模型对抗审查，合并态 review 逮出 supervised 路径 overlap 保护缺口并按 root-cause 修复——见 overlap ①⑤「按进程存活性裁决」）。**唯一 gated follow-up**：真双进程 bare-metal e2e（`tests/e2e/handover.e2e.test.ts`）需在 GitHub API 无故障时复跑确认（重构后曾撞 GitHub `/user` 503 维护态未跑成，代码级已由存活性单测 + 全量套件零新增 + boot 实证覆盖）。实现代码见 `src/lib/restart/*` + `src/lib/{serve,shutdown}.ts` + `src/lib/history/sqlite/connection.ts`。

### 目标

旧进程**立即停止 accept 新连接 + 优雅 drain 已有连接**的同时，新进程**立刻监听并接受新会话**——换代期间 :4141 对客户端零停机。

> ⚠️ **「零停机」只对新建连接成立，对 keep-alive 连接池不自动成立**（2026-08-09 实测事故，已修）。一次接管从 13:02:06Z 开始，客户端到 **13:09:24Z** 仍在收 `503 Server is shutting down`——七分钟后、新实例早已在服务。History 在 13:01:57.734Z–13:11:46.755Z 之间**零记录**，因为关机期的拒绝在建 `RequestContext` 之前就返回了，故障在我们自己的记录里**天然不可见**。
> 两条机制都能把客户端钉死在垂死的旧进程上，事故证据**不足以区分是哪一条**，因此两条都堵：
> - **(A) 客户端连接池复用旧 socket**——它根本不会向内核请求新连接，于是永远到不了新实例。堵法：关机期返回的任何**失败**响应都带 `Connection: close`，由最外层的 `shutdownConnectionCloseMiddleware` 统一负责（`src/lib/observability/middleware.ts`）。放在最外层是因为关机期的拒绝不止一条路径：config/token 中间件排在它之前且带 await，抛错直接进 `server.onError`；等在 History admission 上的请求被 `stopHistoryAdmission()` 中止后同样由 `onError` 塑形。
> - **(B) 旧进程还没走到关 listener 那一步**——`gracefulShutdown` Step 1 曾把 `server.close(false)` 排在 `drainAdmissionHandoffs()` 与交接专属的 `freeze*` 落盘之后，二者都无上界；背着大量 History 写入积压时可以卡住数分钟，而这期间它**既拒绝、又继续 accept**。堵法：`server.close(false)` 移到置 `_isShuttingDown` 之后、**所有 await 之前**（`src/lib/shutdown.ts`），这才让本节开头那句里的「立即停止 accept」为真。
>
> 守卫在 `tests/shutdown/shutdown.unit.test.ts`（顺序不变量 + 组合真实中间件栈的 ingress 拒绝断言，含 pre-gate 抛错路径）。注意既有的 `tests/e2e/handover.e2e.test.ts` **守不住这两条**：它只断言 fresh connection 在 5 秒内收敛到新进程，并显式容忍重叠期的 503/ECONNRESET。
> **残留（已知、未做）**：drain 期间**成功**返回的 2xx 不加该头，客户端下一次请求仍会先吃一条 503 再重连；要覆盖它就得给已在流式传输的 SSE 响应加头，那是另一个问题，此处未决。

### 统一机制：SO_REUSEPORT 重叠窗口接管

三种运行环境（裸手动 / systemd / pm2）**共用同一个 app 层接管协议**，只是「谁按下交接信号」不同。核心是一个**重叠窗口**——新旧进程短暂同时持有 :4141。

- **SO_REUSEPORT 是唯一机制**（实测：Bun `reusePort:true` 下两进程可同时绑 :4141；不带则第二个绑定被拒）。旧进程绑定时也必须带 `reusePort`，否则新进程绑不上——所以 `Bun.serve` 无条件加 `reusePort:true`（`src/lib/serve.ts` 的 Bun 路径；Node 路径已有 `exclusive:false`，补 `reusePort`）。
- **交接信号 = SIGUSR2**。SIGINT/SIGTERM 已是「关机」语义且 supervisor 会发，SIGUSR2 专表「被接管触发的交接」——drain 行为与 SIGTERM **完全一样**（复用 `gracefulShutdown`），但日志可区分、不与真关机混淆。`setupShutdownHandlers`（`src/lib/shutdown.ts`）新增 `SIGUSR2 → gracefulShutdown("handoff")` 注册。SIGUSR2 handler 是**三环境共享原语**，区别仅在「谁按下」。
- **就绪钩子 `notifyReady()`**：新进程绑定成功、`Listening` 之后触发，统一喂三个后端——① 接管协议（此刻才允许向旧进程发 SIGUSR2）② sd_notify `READY=1`（写 `$NOTIFY_SOCKET`，systemd `Type=notify` 的就绪栅栏）③ pm2 `process.send('ready')`（pm2 `wait_ready` 契约）。一个触发点、三后端，按环境变量存在性分发。
  - ⚠️ **sd_notify 传输方式是待定 PoC（实现前置门槛）**：实测 `node:dgram` **不支持** AF_UNIX datagram（`createSocket("unix_dgram")` → `Bad socket type`），而 systemd 的 `$NOTIFY_SOCKET` 正是 `SOCK_DGRAM`；`Bun.connect({unix})` 只建 `SOCK_STREAM` 连不上 dgram server。故 sd_notify 的 datagram 发送需专门 PoC 定选型（候选：`bun:ffi` 直接 `sendto(2)` / spawn `systemd-notify` 二进制 / 已验证能在 Bun 加载的原生绑定包）。**pm2 腿与接管腿不受影响**（`process.send` / `process.kill` 都可用），仅 systemd sd_notify 这一后端卡在传输选型上。

### 路径一：裸手动 `bun run start --restart`

操作者在**新终端**跑 `bun run start --restart`（前台带 TUI）。时序：

```
T0  新进程启动，走完 boot（auth/models/config/history 开库）
T1  新进程 reusePort 绑 :4141 成功（旧进程仍在监听，内核此刻把新连接 LB 到两边）
T2  notifyReady() → 新进程读 pidfile 找到旧进程 → 向旧进程发 SIGUSR2
T3  旧进程收到 → 关闭自己的 listen socket（立即停止 accept）+ 进入无损 drain
    ↑ 此刻起旧 listen fd 已关，内核只把新连接投给新进程
T4  新进程打印 Listening、TUI 就绪、接新会话
T5  旧进程 drain 完在途请求 → 退出 → 旧终端回到 shell
```

- `--restart` 是**显式 opt-in**，且安全网机制**不是** bind 报错——因为 reusePort 无条件常开（见上「唯一机制」条，旧进程必须已 reusePort 绑定新进程才接管得了），第二个实例的 bind **会成功、不报错**。防误启第二个实例靠 **pidfile 活性检查**：启动时若检测到**活的**前任 pidfile（pidfile 存在 + 其 `pid` 进程存活）——**不带** `--restart` → 拒绝启动并提示「已有实例在 :4141，用 `--restart` 接管或先停旧实例」；**带** `--restart` → 执行接管（reusePort 绑定 + SIGUSR2 旧进程）。UX 与「撞端口退出」一致（都拒绝误启第二个），但判据从「内核 bind 失败」换成「pidfile 活性」。
- **pidfile 机制是裸手动路径专属**（承重边界，定错会打死 systemd blue-green）：pidfile 写入 + 活性 guard + 自读自发 SIGUSR2，**只在无 supervisor 时启用**。systemd / pm2 路径由**脚本/supervisor** 驱动信号（B1）、故意让第二个活实例并存并从外部发 SIGUSR2——若在那里跑 guard，新槽 `@b` 会因「`@a` pidfile 活 + 未带 `--restart`」被自己拒绝启动。**环境判别**：检测到 `NOTIFY_SOCKET`/`INVOCATION_ID`（systemd）或 `PM2_HOME`/`pm_id`（pm2）→ 跳过 pidfile 写入与 guard，把生命周期完全交给 supervisor；否则（裸终端）走 pidfile 自管理。SIGUSR2 handler 本身**三环境共用**，差异仅在「谁写/读 pidfile、谁按信号」。
- **pidfile**（`$APP_DIR/copilot-api.pid`，含 `pid` + `bootTime` + `port`）是**裸手动路径**下新进程①判断有无活前任、②找到前任发 SIGUSR2 的唯一途径，写在 `initProcessIdentity` 之后。**退出清理必须 compare-and-delete（承重）**：接管后新进程已用**自己的 pid** 覆写同一个 pidfile；旧进程 drain 完退出时若无条件 `unlink` 同路径，会**误删新进程仍在用的活 pidfile**（→ guard 永久失效、下次普通启动静默叠加第三实例）。故删除前必须核对「文件里 `pid` == 自己」，只删自己那份、别人接管改写过的不碰（原语 `removePidfileIfOwnedBySelf`）。**陈旧 pidfile**（进程已死但文件残留）：活性检查按「pid 不存活」判为无前任、正常启动并覆写。可选 config 键 `pidfile` 覆盖默认路径。
  - **同终端误用警告**：务必在**真正独立的终端窗口 / tmux pane** 跑 `--restart`。不要在同一 tty 里把旧进程 `&` 后台化再前台起新实例——两进程会对同一 `process.stdin` 抢 raw-mode（TUI `setRawMode(true)`），终端控制冲突。
  - **不保证链式重叠重启**：pidfile 单槽只登记一个直接前任。若上一轮 drain 未结束就发起下一轮接管，更早的前任行可能落在 reclaim 排除范围外——运维应确保上一轮 drain 完全结束再发起下一轮。

### 路径二：systemd blue-green 模板单元 + reusePort

**不用 socket activation**（评估后否决——见下「不采纳」）。用双槽模板单元 `copilot-api@.service`（实例 `@a` / `@b`），零停机靠**同一个 reusePort 接管**，无 systemd 专有代码。

**单元关键约束**（想透后才浮现，定错就坏）：
- `Type=notify` —— `systemctl start` **阻塞到新槽发出 `READY=1`** 才返回，给部署脚本一个确定性的「新槽就绪」栅栏。
- `Restart=on-failure`（**不是** `always`）—— 交接时旧槽 drain 完以 **exit 0** 正常退出，systemd 不复活它；只有真崩溃（非零退出）才重启同色槽。定成 `always` 会把每次交接当故障无限拉起。

**部署脚本（A1 无状态发现 + B1 脚本发信号，`@a`/`@b`，零 app 状态文件）**：

```bash
CUR=$(systemctl is-active copilot-api@a >/dev/null && echo a || echo b)   # 现场问 systemd 运行态
NEXT=$([ "$CUR" = a ] && echo b || echo a)
systemctl start copilot-api@$NEXT                 # 阻塞到 READY=1（新槽 reusePort 绑 :4141）
systemctl kill -s SIGUSR2 copilot-api@$CUR        # 脚本发交接信号 → 旧槽停 accept + drain
# 轮询 is-active，等待旧槽自行 exit 0；禁止再发 stop/SIGTERM，否则会成为强退信号
systemctl disable copilot-api@$CUR                # 仅在旧槽正常退出后翻转开机默认槽
systemctl enable  copilot-api@$NEXT
```

**两类「状态」都在 systemd 领地、app 侧零状态文件**（实测坐实）：
- **活槽 = 运行态**（systemd PID 1 内存）：`systemctl is-active copilot-api@a copilot-api@b` 每单元一行 `active`/`inactive`，或 `systemctl list-units 'copilot-api@*' --state=active --plain` 枚举活实例。
- **默认槽 = 配置态**：`/etc/systemd/system/<target>.wants/copilot-api@<slot>.service` enablement 符号链接，由 `systemctl enable/disable` 翻转，落在 **systemd 配置目录**而非 app 目录。

三个收益：
- **信号由脚本发（B1）**：systemd 下 app **只需 SIGUSR2 handler**，新槽起来时完全不碰旧槽（不读 pidfile、不自发信号），编排权归脚本——systemd 路径**无需 pidfile**。脚本发 SIGUSR2 后只轮询旧槽自行退出，禁止再发 `systemctl stop`／SIGTERM。
- **新槽起不来 = 零影响**：新代码有 bug 则 `systemctl start` 失败、脚本止步，旧槽从没收到 SIGUSR2、持续正常服务（相对「原地 restart」的硬优势——原地一旦新码崩就有停机窗口）。
- **崩溃重启干净**：`Restart=on-failure` 拉起同色槽，此刻无另一活实例、reusePort 绑 :4141 无冲突；无 live 前任则跳过交接。per-instance MainPID / 日志 / Restart 策略全是 systemd 原生跟踪。

### 路径三：pm2

pm2 fork 模式 `pm2 reload` = 重启（有 drain 间隙、非零停机）；cluster 模式 + Bun 兼容性不稳。故 pm2 也**复用 reusePort 接管**，不依赖 pm2 原生 reload：
- 样例 `ecosystem.config.cjs`：`wait_ready:true` + `listen_timeout` 保证新槽就绪；SIGINT／SIGTERM 触发无损 drain。pm2 只能配置有限 `kill_timeout`，而 bundled request deadline 为 0，因此它不构成严格的无损保证；部署脚本应先确认旧槽 `activeRequests.count=0` 再删除。
- **零停机换代（脚本/操作者显式发信号，非新实例自动接管）**：⚠️ pm2 托管的旧实例 `isSupervised()`=true → **不写 pidfile**（pidfile 机制仅裸手动路径），故新实例**读不到** pidfile、无法自动发现前任并自发 SIGUSR2——「起个 --restart 新实例自动接管」在 pm2 下**发不出信号、两实例永久并存**（一半流量打旧码）。正确形态同 systemd：**双 app 条目（blue/green）+ 操作者/脚本显式发信号**：`pm2 start ecosystem --only copilot-api-green`（reusePort 绑 :4141、`wait_ready` 等 `READY=1`）→ `pm2 sendSignal SIGUSR2 copilot-api-blue`（旧实例 drain）→ `pm2 delete copilot-api-blue`。overlap 期数据安全由 ①⑤ 的**进程存活性判据**自动保证（与 pidfile/信号无关）。
- `process.send('ready')` 与 sd_notify `READY=1` 共用 `notifyReady()` 钩子。

### overlap 窗口的共享状态安全

T1–T5 之间新旧两进程同时活着、连着同一批磁盘文件（history.db / telemetry.db / states.json）。**核心原则：旧进程一进 drain 就从「共享可变状态的写者」降级为「只完成自己在途请求」**，把所有权干净交给新进程。逐个隐患：

- **① （History V2 removal 2026-07-18 后已过时——原 V2 专属机制随 V2 整体删除，非本条 bug 仍在）** ~~必修 bug —— `reclaimOrphanedActiveRows`（`src/lib/history/sqlite/connection.ts`）~~：原设计是「新进程开 history.db 时会把所有非『自己 `(pid, bootTime)`』的 active 行刷成 `interrupted`——overlap 期间会误杀任何仍存活进程正在 drain / 正常服务的在途行」，本节记录的按进程存活性裁决修法（`isProcessAlive` 判存活跳过）曾是待落地的正确性 bug 修复方向。**现状**：`reclaimOrphanedActiveRows`/`entries_v2`/pid-bootTime 存活行模型随 History V2 removal（2026-07-18）整体删除——History V3 的 `v3_operations` 只落**终态**，无「active/pending 行」概念，因此**没有可供误杀的中间态行**，本条描述的风险类别对 V3 天然不存在（不是修复方案被采纳、是问题本身随存储模型变化而消失，见 skill `history-sqlite-schema` DB-health 节「不采纳存活共享库跳过」的裁决记录）。
- **② 遥测并发写（telemetry.db）**：区分两类，只有一类是真风险——
  - **persist（pending-delta flush）不双计**：每个进程有**独立的内存 pending-delta outbox**，旧进程 flush 的是它自己服务过的请求 delta、新进程 flush 自己的，两者写进 `tel_cumulative` 恰好是正确相加（A+B），无重叠。
  - **rollup 才是承重风险**：rollup timer 读 `tel_raw` 链式上卷 hourly/daily 并推进 `tel_meta` watermark，两进程并发上卷可能都从同一 watermark 起、重复上卷放大（watermark 幂等只防**同进程重放**，不防**跨进程并发**）。
  - **修法**：旧进程 Step 1 停**两个 telemetry timer（persist + rollup）**——`stopPeriodicPersistence()` + `stopRollupTimer()`。最终 `shutdownRequestTelemetry()` 已先注销 `telemetryConfigUnsub`，再停 timer、排空并关闭数据库，保证 await 窗口内 config 热重载不能把 timer 重新拉活。接管场景还应在 Step 1 提前执行 producer seal，避免 drain 期与新进程并发上卷；最终 flush 仍推迟到 `finalizing`（drain-before-close，不丢在途 delta）。
- **③ states.json（calibration `learned-limits.json` / feature-negotiation）—— 真有竞争，非「无冲突」**：两者都是 **debounce 全量快照覆盖写**（`schedulePersist()` → `atomicWriteJson` 整文件替换），且从**请求处理路径**触发（feature-negotiation 18 处、calibration 多处），**不受 Phase 1 的 `stopHistoryBackgroundWork`/`stopTelemetryBackgroundWork` 影响**——旧进程在整个 drain 期处理在途请求时仍会继续 `schedulePersist`。因是**整内存态覆盖整磁盘态**（非 telemetry 的可加 delta、非 reclaim 的行级 WHERE），若旧进程一次覆盖写 `rename()` 晚于新进程的覆盖写落地，会把新进程 overlap 期新学到的负反馈**整体覆盖丢失**。**修法（flush-then-freeze，仅 handoff）**：旧进程收到 **handoff 信号（SIGUSR2）时**对两个持久化各做一次 flush（清空 debounce、落最后一份），随后把 `schedulePersist` 降级为 **no-op（freeze）**——把「继续学习并落盘」的所有权让给新进程。**freeze 仅在 handoff 路径**：普通 SIGINT/SIGTERM 关机无后继者、freeze 无意义（且会污染反复 gracefulShutdown 的测试）——`gracefulShutdown(signal)` 据 `signal==="SIGUSR2"` gate。`persistenceFrozen` 单例的 reset 折进既有 `clearAnthropicFeatureNegotiationForTests`/`resetAllLimitsForTesting`（已在 RESETTERS 表、被 L1 守卫覆盖）。丢失只是可重学的缓存（符合「无向后兼容负担」下可接受的降级），但正确形状是 handoff-gated freeze、不是放任覆盖竞争。**Phase 1 IO 注记**：handoff 路径 Phase 1 因此含两次 `atomicWriteJson` 落盘（有界毫秒级），不再是纯同步 CPU-bound setup；普通关机 Phase 1 仍纯同步。
- **④ WAL 并发写**：history.db 仍有「旧进程在途请求 settle 的 finalize 写」+「新进程新请求写」。WAL + `busy_timeout=5000` 已串行化两写者——这正是 SQLite WAL 多进程写者的设计场景，几秒内几笔串行写余量绰绰有余，无需额外锁。
- **⑤ （History V2 removal 2026-07-18 后现状已变——原风险窗口的对策不再是「跳过」而是「本就无条件跑」）** ~~新进程一次性 schema/维护动作 —— `maybeVacuumOnStartup`（VACUUM）是承重遗漏~~：原设计描述的风险是「新进程 VACUUM 独占整库写锁，命中阈值时旧进程正常流量的任意 `entries_v2` 写会 `SQLITE_BUSY`」，本节记录的修法是按存活性裁决跳过 VACUUM。**现状**：History V3 的 `maybeVacuumOnStartup` 在 `openDatabase` 路径**无条件**跑（不采纳"存活共享库跳过"门槛——`v3_operations` 只落终态、无 V2 那种"进行中行"概念，overlap 期没有"另一进程正在写自己的行"这个并发风险维度，见 skill `history-sqlite-schema` DB-health 节的裁决记录）。overlap 窗口下若新旧进程恰好都在跑 startup VACUUM，WAL + `busy_timeout` 仍提供基础串行化保护（同④），但本条描述的「按 pid 存活性跳过」方案未随 V3 采纳，风险性质已从「entries_v2 写丢失」变为「V3 写在 busy_timeout 内重试／WAL 序列化」，两者不是同一问题。

> **为何不把 history/telemetry 拆成独立持久化服务**（曾评估）：overlap 写竞争是**有界、罕见、可被靶向修覆盖**的（旧进程降级后只剩个位数在途 finalize + 新进程新写），几个真隐患（reclaim 误杀 / telemetry rollup 并发上卷 / VACUUM 独占锁 / states.json 覆盖竞争）都是廉价靶向修（排除 WHERE / 停 timer+注销订阅 / 接管跳过 VACUUM / flush-then-freeze）。而拆服务代价不成比例：需给极富且在演进的 payload（zstd blob / 内容寻址 search_index / 异步两相 finalize / DDSketch）定义 IPC wire 协议，把「同进程一个 await 保证的 never-lose-settle 不变量」变成分布式投递协议；读侧（`/history/api/*`、`/api/status`、`/metrics`、WS 实时推送）也全是进程内同步读；SQLite 的价值本就是嵌入式零 IPC。本项目是单用户内部工具、并发仅「偶尔重启一次」，为有界问题引常驻 sidecar 是过度工程。**触发条件**（满足才值得重做，见 `docs/todo/deferred-backlog.md`）：转向多进程/多 worker 常驻并发 serving；或持久化背压开始阻塞请求 serving；或体量长出 SQLite、本就要迁 client-server DB。

### CLI / config / 交付物

- **CLI**：`start` 新增 `--restart`（布尔，默认 false）激活接管模式。
- **config**：shutdown 无排空时限旋钮；请求终止由 `timeouts.*` 负责。可选 `pidfile` 键覆盖默认路径。
- **交付物**：样例 `contrib/systemd/copilot-api@.service` + 部署脚本 + `contrib/pm2/ecosystem.config.cjs` + 本节。

### 实现前置 PoC 门槛

- **① reusePort overlap 下内核连接分发正确性**：旧进程关 listen fd 后，新连接 100% 到新进程、无 RST / 无丢连。这是零停机的唯一硬保证，实现前必须实测绿。⚠️ **探针必须每次新建 TCP 连接**（`Connection: close` + `keepalive: false` 或 `net.connect`）——实测用默认 `fetch()` keep-alive 连接池会**假阳性 FAIL**（8/8 复现：客户端复用了指向旧进程的旧连接，被误判成「内核仍往旧进程分发新连接」）。这类「看似测内核、实则测客户端连接池」的陷阱须用「keep-alive vs fresh-connection 双探针交叉验证」排除。
    ⚠️ **但当年只修了探针、没修生产**：那个 8/8 复现的「客户端复用指向旧进程的旧连接」不只是测量假象，**真实 keep-alive 客户端的行为与那个「有问题的探针」完全一致**——它同样不会去建新连接，所以本条 PoC 证明的「关旧 listener 后新连接 100% 落新进程」对连接池客户端**根本不适用**。2026-08-09 该形态以生产事故出现（见上「目标」节的实测记录与两条修复）。
- **② sd_notify 传输选型 PoC**：`node:dgram` 不支持 AF_UNIX datagram（实测 `Bad socket type`），需 PoC 定 systemd `$NOTIFY_SOCKET` 的 `SOCK_DGRAM` 发送方式（`bun:ffi sendto` / spawn `systemd-notify` / 原生绑定包）。仅卡 systemd sd_notify 腿；pm2 + 接管腿不受影响，可先行。

（socket activation 曾要求的「node-under-Bun + fd-inherited 的 WS/流式」PoC **已随其否决而移除**——见下。）

### 不采纳

- **systemd socket activation**（评估后否决）：它是唯一逼迫「强制走 node:http 适配器 + 在继承 fd 上 `listen({fd})`」的路径（`Bun.serve` 无 fd 继承选项，PoC 证明只有 `@hono/node-server` 的 Node 路径能接管 systemd 传入的 fd）。去掉它后 reusePort 成为三环境**唯一机制**、全程留在 `Bun.serve`、砍掉 node-adapter 分叉及其「WS/流式在 fd 继承下是否正常」的 PoC 风险。blue-green 模板单元用同一个 reusePort 接管即可达成 systemd 原生零停机，systemd 的保活 / 自启 / 日志 / per-instance 跟踪价值全保留。
- **systemd「薄监管」路径**（app 层 reusePort 接管、systemd 只保活）：接管在 systemd 视野外换掉进程，旧 service 退出后 MainPID 记账错乱、systemd 不认新进程。blue-green 双槽把每个进程都纳入 systemd 原生跟踪，更干净。
- **`Type=notify-reload` / SIGHUP 进程内 reload**：只重载配置、不换代码 / 不起新进程；而本项目配置本就每请求热重载（`applyConfigToState`），对「重启到新代码」无用。

## 请求上下文管理

`RequestContextManager`（`src/lib/context/manager.ts`）跟踪所有活跃请求的生命周期：

- 每个请求创建一个 `RequestContext`（`src/lib/context/request.ts`）
- 状态机：非终态 `pending` → `executing` → `streaming`，终态 `completed` / `failed` / `aborted` / `interrupted`（`RequestLifecycleState`，`src/lib/history/types.ts`）
- 生命周期事件经 observability bus 发布（`src/lib/observability/`），各 sink（console / file / history / telemetry / ws）订阅消费：请求完成时落盘 / 广播（取代已删除的 `consumers.ts` 消费者注册模型）

### Stale Request Reaper

- `state.staleRequestMaxAge`：活跃请求最大存活秒数（bundled 默认 0，即禁用）。
- 运维显式设正值时，reaper 超龄会取消并清理请求；该选项会对合法长思考施加 wall-clock 上界，因此启动时显式告警。

### Hard Request Deadline（`request_deadline`，2026-07-14 新增，RC2 治根）

- `state.requestDeadline`（config `timeouts.request_deadline`，bundled 默认 0，即禁用）：运维显式设正值时，它是单请求硬总时长上限。默认禁用避免仅凭 wall-clock 误杀无上界合法思考。
- **由 per-request 精确 `setTimeout` 强制**（`manager.create` 武装、`onSettled` 清除、`unref`），到点调用与 reaper 同款 `reapInFlight()`（取消在飞上游）+ `fail()`（记终态）。
- **为何独立于 stale reaper**：reaper 是**周期扫描**（`staleRequestMaxAge/3` clamp 到 [250ms,60s]），实测会**迟到**（一次迟 198s，age 1398s vs max 1200s）——候选机制：config 热重载改阈值但 scan cadence 冻结、或**进程/WSL2 suspend** 让所有 timer 一起冻结（诊断见 `reaper-diagnostics.ts`，坐实判据 = 墙钟 gap vs 单调 gap）。per-request timer 按 T 精确触发、**绕过**这个迟到。
- 两个 wall-clock guard 默认都禁用；运维同时显式启用时，`request_deadline`（精确主上限）应小于 `stale_request_max_age`（周期泄漏兜底）。
- **dry-run 豁免**：capturing manager（`withCapturingManager`）传 `armDeadlineTimers:false`，inspection ctx 不武装 deadline。

相关代码：`src/lib/shutdown.ts`、`src/lib/context/`、`src/lib/observability/reaper-diagnostics.ts`
