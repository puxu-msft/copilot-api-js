# pm2 零停机换代

本目录提供 copilot-api 在 pm2 下的托管样例：`ecosystem.config.cjs`。

机制背景（reusePort 接管、SIGUSR2 交接协议、共享状态安全）见项目内 [docs/lifecycle.md](../../docs/lifecycle.md#路径三pm2)——本 README 只讲“怎么装、怎么用”。

## 安装与启动

```bash
npm install -g pm2   # 或任意包管理器
pm2 start contrib/pm2/ecosystem.config.cjs
pm2 save             # 可选：让 pm2 开机自启时恢复此进程列表
```

`wait_ready: true` + `listen_timeout` 让 `pm2 start`/`pm2 restart` 阻塞到应用调用 `process.send('ready')`（`notifyReady()` 的 pm2 腿）才认为启动成功；`kill_timeout` 对齐了 `shutdown.graceful_wait + shutdown.abort_wait` 的默认宽限（60+120=180s），给足 4-phase 优雅 drain 跑完的时间——若你的 `config.yaml` 调大了这两个值，务必同步调大 `kill_timeout`，否则 pm2 会在 drain 完成前发 `SIGKILL`。

## 为何不用 `pm2 reload`

pm2 的 `reload` 在 **fork 模式**（本项目使用的模式，Bun 不是 pm2 cluster 模式的稳定目标）下**等价于重启**：先杀旧进程再起新进程，中间有真实的服务间隙（非零停机）。pm2 的 cluster 模式虽然理论上支持零停机 reload，但依赖 Node 的 `cluster` 模块语义，与 Bun 运行时兼容性不稳定，本项目不采用。

## 零停机换代：起带 `--restart` 的第二实例接管

零停机换代复用与裸手动 / systemd 完全相同的 **reusePort 接管协议**，不依赖 pm2 原生 reload：

```bash
# 部署好新代码后，在 pm2 托管之外临时起一个带 --restart 的新实例；
# 它会 reusePort 绑定同一端口、就绪后向存活的旧实例发 SIGUSR2 触发交接。
bun run src/main.ts start --restart
```

交接完成后：
- 旧实例（原 pm2 托管的那个）走完 4-phase drain 后**正常退出（exit 0）**——pm2 会将其记为进程退出，可用 `pm2 delete copilot-api` 清理该条目。
- 把新实例重新纳入 pm2 托管（例如用同一份 `ecosystem.config.cjs` 重新 `pm2 start`），恢复 pm2 的自愈/开机自启能力。

或者更接近 systemd blue-green 的做法：用**两个 pm2 app 条目**（不同 `name`，例如 `copilot-api-a` / `copilot-api-b`）互相扮演对方的“新槽”，换代时用 pm2 启动另一条目并带 `--restart`，交接后 `pm2 delete` 旧条目——原理与 systemd 双槽一致，只是把“槽”从 systemd 实例换成 pm2 app 条目。

## `process.send('ready')` 与 sd_notify 共用同一钩子

应用侧只有一处 `notifyReady()` 调用点：它同时喂 pm2 的 `process.send('ready')`（`wait_ready` 契约）和 systemd 的 `sd_notify READY=1`（无 `$NOTIFY_SOCKET` 环境变量时该腿自动 no-op）。pm2 环境下无需任何额外配置——`pm_id`/`PM2_HOME` 环境变量被应用侧的 supervisor 判别逻辑识别后，会自动跳过裸手动路径专属的 pidfile 机制（见 `docs/lifecycle.md`「pidfile 机制是裸手动路径专属」）。
