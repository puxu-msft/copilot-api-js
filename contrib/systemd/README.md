# systemd blue-green 零停机换代

本目录提供 copilot-api 在 systemd 下的**双槽（blue-green）零停机换代**样例：`copilot-api@.service` 模板单元 + `copilot-api-deploy.sh` 部署脚本。

机制背景、时序、共享状态安全（reclaim / telemetry rollup / VACUUM / states.json）等设计细节见项目内 [docs/lifecycle.md](../../docs/lifecycle.md#路径二systemd-blue-green-模板单元--reuseport)——本 README 只讲“怎么装、怎么用”。

## 原理一句话

零停机靠 app 层 **`SO_REUSEPORT` 重叠窗口接管**：新槽先绑定 `:4141`（此刻新旧两槽同时监听，内核已开始把新连接分给两边），新槽就绪后向旧槽发 `SIGUSR2` 触发交接——旧槽立即关自己的 listen socket（停止 accept），无损 drain 已接纳请求，随后完成 durability barrier 并退出。全程无 socket activation、无 fd 传递，两个槽都是 systemd 原生管理的独立单元实例。

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
4. 轮询旧槽直到其自行完成 drain 并退出；脚本**不调用 `systemctl stop`**，避免额外 SIGTERM 触发强退。默认最多等待 3600 秒；超时或旧槽进入 failed 时保留双槽与原 enablement，并以非零码停止换代。
5. 仅在旧槽正常退出后翻转 `enable`/`disable`，让下次开机默认拉起新的活槽。

全程 `:4141` 无停机——重叠窗口内两槽同时监听，内核把新连接全部投给新槽（旧槽 listen fd 已关）。

## 为何 `Restart=on-failure` 而非 `always`

交接（`SIGUSR2` handoff）时旧槽无损 drain 并完成 durability barrier 后是**正常退出（exit code 0）**。如果 `Restart=always`，systemd 会把这次“正常交接后的退出”也当作“需要重启”处理，把旧槽又拉起来——两个进程又抢占同一个端口/资源，交接变成无限重启循环。`on-failure` 只在**非零退出**（真崩溃）时才复活同色槽，交接产生的 exit 0 不触发。

## 为何不用 `bun run start`（而是直连 `bun /path/main.ts start`）

`bun run <script>` 会先 fork 出一个 `bun run` 父进程，再由它启动脚本里定义的实际命令（子进程）。这层额外的父子关系会打乱两件事：
- **`LISTEN_PID`/`sd_notify` 归属**：systemd `Type=notify` 靠 `$NOTIFY_SOCKET`（以及某些集成里的 `LISTEN_PID`）判断“是哪个 PID 在发通知”，而 `bun run` 的父进程与真正监听端口、发 `READY=1` 的子进程是不同 PID，会让 systemd 的就绪判定与实际服务进程错位。
- **信号路由**：`systemctl kill -s SIGUSR2` 发给的是 `MainPID`（`ExecStart` 直接跑起来的那个进程）。若 `ExecStart` 是 `bun run start`，`MainPID` 是 `bun run` 父进程而非真正处理请求、注册了 `SIGUSR2` handler 的应用进程，交接信号可能根本送不到该去的地方。

直连 `bun /path/main.ts start` 让 `ExecStart` 启动的进程就是应用本体，`MainPID`、`sd_notify`、信号路由三者一致。

## app 侧无需 pidfile

systemd 路径下 app **完全不写、不读 pidfile**——活槽发现（A1）问的是 systemd 运行态，交接信号（B1）由部署脚本外部发送。app 只需注册好 `SIGUSR2 → gracefulShutdown("handoff")` 这一个共享原语，`pidfile` 自管理机制是裸手动路径专属，两者互不干扰（详见 `docs/lifecycle.md`「pidfile 机制是裸手动路径专属」一节的环境判别逻辑）。

---

# history-search sidecar 服务（可选，独立）

`history-search.service` 是 History 全文搜索 sidecar 的 systemd 单元样例（[docs/plan/2026-07-21-history-search-out-of-process.md](../../docs/plan/2026-07-21-history-search-out-of-process.md)）。与上面的主服务器换代**完全无关**：这是一个**独立进程**，主 `copilot-api start` 从不 spawn/监管/重启它，只持一个 UDS client 查询它。安装步骤与理由见 unit 文件自身头部注释。

## 装之前必须先构建 native 产物

sidecar 依赖原生 Tantivy `.node`（`native/history-search/copilot_history_search.node`）——它被 `.gitignore`（编译产物、非源码），依赖本机 Rust 工具链，`bun install` 与顶层 `bun run build` 都不产出。**启动 systemd 单元前必须显式运行 `bun run build:history-search`**，否则 sidecar 起不来（`getNativeHistorySearch()` reject）；`bun run test:ci` 会自行先构建该产物。

## 要点

- **独立进程、与主服务器无父子关系。** 主进程不 spawn/监管/重启它，只经 UDS client 查询。
- **可选。** 不跑此服务，主服务器照常全功能;全文搜索 `GET /history/api/search` 只是返空结果（`partial: true`）而非报错。`GET /api/status` 的 `history_search` 报告 sidecar 当前是否可达，可达时附 `tail` 子对象（`lastSuccessfulTailAt` / `poisonedCount` / `lastTailError`）——纯可达性 ping 分不清「健康」与「可达但索引已静默停止增长」。
- **零参数默认对齐 PATHS。** `history-search-daemon`（该服务的 citty 子命令）的 `--db`/`--socket`/`--index` 默认值直取主进程 UDS client 读的同一组 `PATHS.HISTORY_V3_DB` / `HISTORY_SEARCH_SOCKET` / `HISTORY_SEARCH_DIR` 常量（`src/lib/config/paths.ts` 单一事实源），两个独立启动的单元间无路径需要保持同步。
- **崩溃恢复全交给 systemd。** `Restart=on-failure` + `RestartSec=`/`StartLimitIntervalSec=`/`StartLimitBurst=` 取代了早期（已废弃）在进程内自研的指数退避 supervisor + crash-loop-abandon 逻辑——systemd 已把这件事做得又好又可见，且不用再引入一个「它自己的死亡也需要被监管」的第二进程。
