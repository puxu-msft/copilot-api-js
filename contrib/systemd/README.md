# systemd blue-green 零停机换代

本目录提供 copilot-api 在 systemd 下的**双槽（blue-green）零停机换代**样例：`copilot-api@.service` 模板单元 + `copilot-api-deploy.sh` 部署脚本。

机制背景、时序、共享状态安全（reclaim / telemetry rollup / VACUUM / states.json）等设计细节见项目内 [docs/lifecycle.md](../../docs/lifecycle.md#路径二systemd-blue-green-模板单元--reuseport)——本 README 只讲“怎么装、怎么用”。

## 原理一句话

零停机靠 app 层 **`SO_REUSEPORT` 重叠窗口接管**：新槽先绑定 `:4141`（此刻新旧两槽同时监听，内核已开始把新连接分给两边），新槽就绪后向旧槽发 `SIGUSR2` 触发交接——旧槽立即关自己的 listen socket（停止 accept）并走 4-phase 优雅 drain，drain 完退出。全程无 socket activation、无 fd 传递，两个槽都是 systemd 原生管理的独立单元实例。

## 安装

1. 把仓库部署到目标机（例如 `/opt/copilot-api`），确保 `bun` 在 `/usr/bin/bun`（或按需改 `ExecStart` 路径）。
2. 复制模板单元与部署脚本：

   ```bash
   sudo cp copilot-api@.service /etc/systemd/system/
   sudo install -m 0755 copilot-api-deploy.sh /usr/local/bin/copilot-api-deploy.sh
   sudo systemctl daemon-reload
   ```

3. 按实际路径编辑 `/etc/systemd/system/copilot-api@.service` 的 `ExecStart`（入口脚本、工作目录、环境变量等按需补充 `WorkingDirectory=` / `EnvironmentFile=` 等指令，样例只给最小骨架）。

## 首次启动

只需启用其中一个槽（例如 `@a`）：

```bash
sudo systemctl enable --now copilot-api@a
```

`Type=notify` 会让 `systemctl start` 阻塞到应用发出 `READY=1`（新代码已绑定 `:4141` 并可接受流量）才返回，避免“命令返回但服务其实还没就绪”的窗口。

此刻 `@b` 处于 `inactive`/`disabled`，属正常——它是留给下一次换代用的另一色槽。

## 换代（零停机部署新代码）

部署好新代码（例如 `git pull` + 依赖安装）后，跑：

```bash
sudo /usr/local/bin/copilot-api-deploy.sh
```

脚本会：
1. 现场问 systemd `is-active` 判断当前活槽（`@a` 或 `@b`），零 app 状态文件参与判断。
2. 启动另一色槽，阻塞到其 `READY=1`。
3. 向旧槽发 `SIGUSR2`——旧槽立即停止 accept 新连接、开始 drain 在途请求。
4. `systemctl stop` 旧槽（此时它多半已自行 drain 完退出，`stop` 只是收敛记账，幂等）。
5. 翻转 `enable`/`disable`，让下次开机默认拉起新的活槽。

全程 `:4141` 无停机——重叠窗口内两槽同时监听，内核把新连接全部投给新槽（旧槽 listen fd 已关）。

## 为何 `Restart=on-failure` 而非 `always`

交接（`SIGUSR2` handoff）时旧槽走完 4-phase drain 后是**正常退出（exit code 0）**。如果 `Restart=always`，systemd 会把这次“正常交接后的退出”也当作“需要重启”处理，把旧槽又拉起来——两个进程又抢占同一个端口/资源，交接变成无限重启循环。`on-failure` 只在**非零退出**（真崩溃）时才复活同色槽，交接产生的 exit 0 不触发。

## 为何不用 `bun run start`（而是直连 `bun /path/main.ts start`）

`bun run <script>` 会先 fork 出一个 `bun run` 父进程，再由它启动脚本里定义的实际命令（子进程）。这层额外的父子关系会打乱两件事：
- **`LISTEN_PID`/`sd_notify` 归属**：systemd `Type=notify` 靠 `$NOTIFY_SOCKET`（以及某些集成里的 `LISTEN_PID`）判断“是哪个 PID 在发通知”，而 `bun run` 的父进程与真正监听端口、发 `READY=1` 的子进程是不同 PID，会让 systemd 的就绪判定与实际服务进程错位。
- **信号路由**：`systemctl kill -s SIGUSR2` 发给的是 `MainPID`（`ExecStart` 直接跑起来的那个进程）。若 `ExecStart` 是 `bun run start`，`MainPID` 是 `bun run` 父进程而非真正处理请求、注册了 `SIGUSR2` handler 的应用进程，交接信号可能根本送不到该去的地方。

直连 `bun /path/main.ts start` 让 `ExecStart` 启动的进程就是应用本体，`MainPID`、`sd_notify`、信号路由三者一致。

## app 侧无需 pidfile

systemd 路径下 app **完全不写、不读 pidfile**——活槽发现（A1）问的是 systemd 运行态，交接信号（B1）由部署脚本外部发送。app 只需注册好 `SIGUSR2 → gracefulShutdown("handoff")` 这一个共享原语，`pidfile` 自管理机制是裸手动路径专属，两者互不干扰（详见 `docs/lifecycle.md`「pidfile 机制是裸手动路径专属」一节的环境判别逻辑）。
