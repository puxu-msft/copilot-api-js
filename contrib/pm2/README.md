# pm2 零停机换代

本目录提供 copilot-api 在 pm2 下的托管样例：`ecosystem.config.cjs`（`copilot-api-blue` / `copilot-api-green` 两个 app 条目——日常只运行其中一个，换代时才短暂并存，详见下方「零停机换代」）。

机制背景（reusePort 接管、SIGUSR2 交接协议、共享状态安全）见项目内 [docs/lifecycle.md](../../docs/lifecycle.md#路径三pm2)——本 README 只讲“怎么装、怎么用”。

## 安装与启动

```bash
npm install -g pm2   # 或任意包管理器
pm2 start contrib/pm2/ecosystem.config.cjs --only copilot-api-blue   # 首次只起一个槽
pm2 save             # 可选：让 pm2 开机自启时恢复此进程列表
```

`wait_ready: true` + `listen_timeout` 让 `pm2 start`/`pm2 restart` 阻塞到应用调用 `process.send('ready')`（`notifyReady()` 的 pm2 腿）才认为启动成功；`kill_timeout` 对齐了 `shutdown.graceful_wait + shutdown.abort_wait` 的默认宽限（60+120=180s），给足 4-phase 优雅 drain 跑完的时间——若你的 `config.yaml` 调大了这两个值，务必同步调大 `kill_timeout`，否则 pm2 会在 drain 完成前发 `SIGKILL`。

## 为何不用 `pm2 reload`

pm2 的 `reload` 在 **fork 模式**（本项目使用的模式，Bun 不是 pm2 cluster 模式的稳定目标）下**等价于重启**：先杀旧进程再起新进程，中间有真实的服务间隙（非零停机）。pm2 的 cluster 模式虽然理论上支持零停机 reload，但依赖 Node 的 `cluster` 模块语义，与 Bun 运行时兼容性不稳定，本项目不采用。

## 零停机换代：显式双 app 条目 blue/green

pm2 托管的实例 `isSupervised()`=true → **不写 pidfile**（pidfile 机制仅裸手动路径专属），所以新实例**读不到**旧实例的 pidfile、无法自动发现前任并自发 SIGUSR2——「起个 `--restart` 新实例自动接管」在 pm2 下**发不出信号、两实例会永久并存**（一半流量打旧码）。

正确形态与 systemd blue-green 一致：**两个 pm2 app 条目**（不同 `name`，例如 `copilot-api-blue` / `copilot-api-green`）+ **操作者 / 部署脚本显式发信号**，不依赖任何"自动接管"：

```bash
# 1. 部署好新代码后，起 green 槽（reusePort 绑定同一端口，wait_ready 等 READY=1）
pm2 start ecosystem.config.cjs --only copilot-api-green

# 2. green 就绪后，显式向 blue 槽发交接信号（不是杀它——SIGUSR2 触发 4-phase drain）
pm2 sendSignal SIGUSR2 copilot-api-blue

# 3. blue 走完 drain 后以 exit 0 正常退出（pm2 记为进程退出，不会被自动重启）；
#    确认退出后清理该条目
pm2 delete copilot-api-blue
```

下次换代时反过来（起 blue、向 green 发信号、删 green），两个条目互相扮演对方的"新槽"——原理与 systemd 双槽完全一致，只是把"槽"从 systemd 实例换成 pm2 app 条目。

overlap 期（blue/green 短暂同时持有端口、同时写 history.db/telemetry.db）的数据安全由 lifecycle.md「overlap 共享状态安全 ①⑤」的**进程存活性判据**自动保证——与是否走了这套显式脚本、是否有 pidfile 无关，reclaim/VACUUM 只看"这个 owner pid 现在还活不活"，环境无关。

## `process.send('ready')` 与 sd_notify 共用同一钩子

应用侧只有一处 `notifyReady()` 调用点：它同时喂 pm2 的 `process.send('ready')`（`wait_ready` 契约）和 systemd 的 `sd_notify READY=1`（无 `$NOTIFY_SOCKET` 环境变量时该腿自动 no-op）。pm2 环境下无需任何额外配置——`pm_id`/`PM2_HOME` 环境变量被应用侧的 supervisor 判别逻辑识别后，会自动跳过裸手动路径专属的 pidfile 机制（见 `docs/lifecycle.md`「pidfile 机制是裸手动路径专属」）。
