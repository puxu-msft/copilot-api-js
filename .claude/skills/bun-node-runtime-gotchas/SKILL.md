---
name: bun-node-runtime-gotchas
description: 当 copilot-api-js 在 Bun/Node 双运行时下遇到 stdlib/Web 标准行为差异、Bun 独有 API 能力边界、undici 跨 realm、Headers 合并、bun:sqlite、Bun.Terminal/node-pty、node:http2 bare close、Bun.serve 内 net.connect ENOENT，或 spawn/PTY/supervisor 信号与清理疑似命中错误 PID 时使用。
---

# Bun / Node 跨运行时 stdlib 陷阱

本项目 bun-first 但 history 走 bun:sqlite（一等）/ node:sqlite（兼容）双驱动、上游 fetch 走 undici（见 skill `debugging-ghc-api-upstream-transport`），故常撞「同一 API 两 runtime 行为分歧」。默认先采用已有代码、文档与既有实测继续工作；当它们与新观测冲突、要据此排除方案、或 Bun 结果将被外推到 Node/不同启动形态时，才进入质疑阶段做最小交叉探针。质疑时必须写清 runtime、版本、平台、执行上下文、启动命令与被测对象，不能用一句“Bun 下实测”覆盖所有条件。

## undici.Response ≠ globalThis.Response（别用 `instanceof Response` 跨 realm）

**Node 运行时下** `import { Response } from "undici"` 与 `globalThis.Response`（lib.dom）是**两个不同的类**：`undici.Response === globalThis.Response` 为 **false**，`undiciFetch(...)` 返回对象 `instanceof globalThis.Response` 为 **false**（`instanceof undici.Response` 才 true）。**Bun 下相反**：Bun 的 fetch shim 返回全局 Response，`undici.Response === globalThis.Response` 为 true——所以 `instanceof Response` 在 Bun 下「恰好」成立，**掩盖** Node 路径的 bug。

**陷阱（C2 实例）**：`web-search/backends.ts` 曾用 `response instanceof Response` 判别 fetch 成功（配 `.catch(e=>e)` 把 reject 转 Error）。改走真 undici（`upstream-fetch.ts`）后，Node 下成功的 undici Response `instanceof globalThis.Response===false` → 成功搜索被误判为失败。`bun test` 测不到（Bun 下 instanceof 恰好成立 + mock 桥返回全局 Response 双重掩盖）。

**修法**：别用 `instanceof Response` 跨 undici/lib.dom 边界判身份。用**结构判别**——这里改 `instanceof Error`（reject 必为 Error，见 fetch 规范），成功分支 `as Response` cast（两者成员级结构兼容、只是名义类型不同）。成员访问（`.ok/.status/.headers.entries()/.json()/.text()/.body`）在两者上都兼容，**只有 `instanceof` 身份判别会坑**。grep 全仓 `instanceof Response` 确认无遗漏。

## new Headers 对异大小写同名键**逗号拼接**（非覆盖）

`new Headers(record)` 对**异大小写同名键**做**逗号拼接**（Bun + Web 标准，`bun -e` 实测）：

```
new Headers({ authorization: "Bearer A", Authorization: "Bearer B" })
  → get("authorization") === "Bearer A, Bearer B"   // 拼接！
```

普通 JS 对象 `{ authorization, Authorization }` 是**两个不同键**，`{ ...low, ...High }` spread 两个都保留；只有到 `new Headers(obj)` 这一步才按 lowercased 折叠、且**拼接**而非取一个。

**后果与护栏**：任何「合并两组头再 `new Headers`」的代码，**绝不能靠 spread 顺序实现"某组优先"**——异大小写撞键会把两边值拼起来（客户端 `authorization` + 代理 `Authorization` → 畸形双 Bearer，把客户端凭证拼给上游）。正确做法：merge **之前**按 **lowercased** 把要让位那组里所有与优先组同名（lowercased）的键**剔除干净**，使两组按 lowercased 无交集。落地于 `anthropic.strict_request_headers` 透传（`buildAnthropicHeaders` + `selectPassthroughHeaders`）：`coreLower = new Set(Object.keys(core).map(toLowerCase))` 从**实际构造出的** core 对象动态取键，据此剔除 passthrough 里所有 core 键后才 `{...pass, ...core}`。两轮 plan review 中这是被推翻的 CRITICAL 假设（最初以为 spread 顺序=优先）。用真实 `new Headers` 实测裁决，别凭直觉。

## bun:sqlite `.get()` 返 null / 触发器写入计入 `.changes`

两个跨 runtime 分歧（实测 `exp/fts-audit/`）：

1. **`.get()` 无匹配的哨兵值分歧**：bun:sqlite 返 **`null`**，node:sqlite 返 **`undefined`**。故 `prepare(...).get() !== undefined` 在 Bun 下对「无行」恒为 `true`（`null !== undefined`）——曾用它做 FTS 表存在性判定，导致 backfill 永不触发。**判存在一律用真值检查 `Boolean(row)` / `if (!row)`，绝不用 `=== undefined`/`!== undefined`**（项目 eslint `eqeqeq` 还禁 `!= null`）。codebase 既有多用 `row ? ... : undefined` 或 `if (!row)`，是对的；strict undefined 比较是 outlier。

2. **触发器写入被 bun:sqlite 计入 `.run().changes`**：一条 UPDATE/DELETE 若触发 AFTER 触发器写别的表，bun 的 `.run().changes` 把触发器侧写入也算进去（实测 1 行真实 UPDATE + FTS 触发器 → changes=9/19；node:sqlite 只算 1）。**凡带触发器/级联的表，行数用 `SELECT COUNT(*)` 单独数，别读 `.changes`**（`reclaimStaleActiveRows`/`reclaimOrphanedActiveRows` 已改 COUNT+UPDATE 同事务；`evictBucket` 早因 `ON DELETE CASCADE` 同理避开）。

> history 的 external-content **FTS5 三陷阱**（COUNT 穿透、`'delete'` 腐败、VACUUM renumber rowid）是 history 专有，见 skill `history-sqlite-schema`。

## wrapper／launcher／runtime：PID 相同是待证条件

`Bun.spawn(...).pid`、`child_process.spawn().pid` 或 Python `pty.fork()` 返回的是它们直接启动的进程，不保证就是执行应用 JS 的 runtime。典型拓扑可能是 `Volta shim → bun run launcher → Bun runtime`；直接执行 `volta which bun` 解析出的 Bun 二进制时则可能只有一个进程。

2026-08-08 的 SIGUSR2 探针同时观察到两种相反结果：

- 经 PATH 中的 Volta shim 启动：外层 PID 与脚本内 `process.pid` 不同。SIGUSR2 发给外层，外层按默认动作退出且 runtime handler 无输出；发给 runtime PID，`process.on("SIGUSR2")` 正常执行、两层均存活。
- 直接执行真实 Bun 1.3.14 二进制：启动 PID 与 `process.pid` 相同，SIGUSR2 正常进入 handler。

所以结论只能写成：“在该 Volta-wrapper 启动形态下，向外层 launcher PID 投递 SIGUSR2 到不了应用 handler。”它**不能**被扩大成“Bun 1.3.14 不支持 SIGUSR2”，也不能反向证明 systemd/pm2 一定跟踪 runtime PID。

### 进程能力／信号／清理探针

1. 让被测脚本输出 `process.pid`、`process.ppid`、runtime 版本与可识别的 READY marker。
2. 驱动端记录自己的 `Subprocess.pid`／`pty.fork()` PID，并抓取 `pgrep -P` 或 `/proc/<pid>/status` 形成最小进程树。
3. 分别把信号发给外层 PID 与 runtime PID；每次都记录目标 PID、handler 输出、两层存活状态和 wait status。
4. 若两者不同，再用解析后的真实 Bun 二进制直接运行同一脚本作为对照，保持脚本、信号与等待窗口不变。
5. 报告结论时携带启动形态和 PID 角色；“kill 后服务仍活”同样先问是不是只杀了 launcher。

`process.listenerCount(signal)` 证明不了内核投递对象，端口仍可访问也证明不了 launcher 仍活。反过来，外层 `waitpid` 已退出不证明 runtime 已退出；清理必须精确检查实际 listener/runtime PID。CLI e2e 的同源实例见 [[reference-cli-e2e-spawn-and-hook-load-gotchas]]。

## Bun.Terminal 伪终端：node-pty 损坏 + 子进程感知不到 resize（PTY 测试）

`tests/tui/pty/` 用 `Bun.Terminal`（Bun 1.3.14 内置伪终端）spawn 真 `TerminalUi` driver、输出喂 `@xterm/headless` 解释成网格，测 raw-mode TUI 的整屏效果（不吞行/footer 钉底/退出还原/切 detail）。三条实测踩出的坑（PoC `exp/poc-js-pty-grid/`、spec/plan `2026-07-14-tui-pty-terminal-grid-testing`）：

1. **node-pty@1.1.0 在 bun 下 spawn 语义损坏**：能装、能加载 N-API addon，但 `spawn` 的子进程提前退出、stdout 非 TTY、`resize` 抛 `ioctl EBADF`（同 addon 在 Node v24 正常）。**别在 bun 用 node-pty**——用 Bun 内置 `Bun.Terminal`（`new Bun.Terminal({cols,rows,data(t,bytes){}})` + `Bun.spawn([...],{terminal})`）。

2. **`Bun.Terminal.resize()` 不给子进程投递 SIGWINCH、子进程 `process.stdout.rows` 不刷新**（亲手实测）：resize 伪终端 24→30 后，子进程 `process.on("SIGWINCH")` **got=0**、`process.stdout.rows` **始终读 24**（INIT/AFTER/FINAL 全 24）。故靠 `process.stdout.rows`（TUI 默认 rows source）感知真实终端 resize 的**那一环** Bun 下无法自动化验。**但重锚逻辑仍可测**——`TerminalUiOptions.rows` 支持函数式 `() => number`（`terminal-ui.ts:171`，`Region.getRows` 经它读值），driver 内部持 mutable `curRows`、发满日志后改值 → 下个重绘周期 `Region` 读到新 rows → `geometryChanged` 走重锚分支（`resize-reanchor.pty.test.ts` 红绿对照：绿 footerCount===1、注释重锚清除 → ===2）。**教训**：一度误判「resize 无法测」降 backlog——被 `process.stdout.rows` 一条生产路径堵死、漏了注入口，靠收尾审计独立探针纠回（呼应 `verifying-authoritative-claims`「通过不自证」，曾被「稳定 6/6 绿」误导实为 resize 从没生效）。**仅「生产尺寸来源链路」留 backlog**（`deferred-backlog.md`）。

3. **`@xterm/headless` 的 `terminal.resize()` reflow 丢 scrollback 行**（时好时坏）：作观察器时**别 resize xterm**，用一个**固定的大观察窗口**（rows 传足够大值）让子进程前后输出都落同一稳定网格。读 buffer 三前提固定：`allowProposedApi:true`、等 `write(data,cb)` 的 cb、遍历 `0..buffer.active.length-1`（含 scrollback）。

> PTY 整屏测试的通用方法论（正样本红绿对照、连跑证时序确定性、pyte/xterm 网格解释）见 user-level skill `pty-terminal-ui-testing`；本节是它在 Bun.Terminal 上的落地限制。

## node:http2 client：服务端 pre-header 销毁会话时 Bun 只发裸 `close`(rstCode=0)、不发 `error`

`http2Fetch`（`transport/http2-client.ts`）等**从 `req` 事件手搭响应**的 h2 客户端，若不为「headers 到达前连接就断」这一路装 backstop，会在 Bun 下**永久挂起**（不是漏记数、是真 hang）。实测两 runtime 事件序列相反（transport 三轴重组 P4 逼出、reviewer 亲写 `exp/` 探针独立复现）：

- **Bun 1.3.14**：服务端响应头前 `session.destroy(err)` → client `req` 只触发 **`close`（rstCode=0）**，`response` 与 `error` **从不触发**。若逻辑只在 `error`/`response` 里 reject/settle，promise 永挂。
- **Node v24**：同场景 `req` 先触发 **`error`（`ERR_HTTP2_SESSION_ERROR`）** 再 `close`（rstCode=2）——`error` 先到、正常 reject。

修法：pre-header 阶段挂一个 `req.once("close")` backstop，`!headersReceived` 时 reject（headers 已到的正常 close 是 no-op、不误 reject）。注意与 active-stream 记账的 `req.once("close")` 归因点**互相独立**（一个 reject fetch promise、一个做计数），别混用同一个 handler 双触发。另注：Bun 对**干净** server RST_STREAM（`stream.close(code)`）投递为普通 `end` + `rstCode=0`（实测），故「干净 RST」在 Bun 下这一路不可辨——依赖 rstCode 判错误类型的逻辑对 Bun 要留退路。

## `net.connect()` 的 ENOENT `'error'` 在**请求处理器上下文**里抢在 post-connect listener 之前投递（listener-after-connect 失效）

`net.connect(path)` **在返回 socket 之前就已启动连接尝试**，故「先 `const s = net.connect(path)` 再 `s.on("error", ...)`」这个几乎所有代码都在用的顺序，对**连不上的路径**（UDS `ENOENT` / `ECONNREFUSED`）有一个 listener-attach 竞态窗口。两 runtime + 两事件循环上下文实测（Bun 1.3.14，2026-07-22 生产崩溃逼出）：

- **独立脚本 / 顶层 async / `bun test` 顶层**：ENOENT `'error'` 在**后续 tick** 异步投递，post-connect listener 来得及挂 → 不崩。**这正是掩盖层**——所有在此上下文写的验证都是 false-green（`bun test` 里靠一次在先的 `net.Server.listen()` 把 Bun 的 UDS-connect 内部「暖」了，见 `tests/helpers/prime-uds-for-bun-test.ts`）。
- **`Bun.serve` 请求处理器内**（真实生产上下文）：同一个 ENOENT `'error'` 在**调用方拿回控制权之前**就投递，post-connect listener **来不及挂** → 无监听者的 `'error'` 变 `uncaughtException` → `main.ts` `exit(1)`（`history-search` sidecar 未起时任何 `/api/search` 打崩整主服务器，250/250 复现）。**注意它不是同步 throw**——`net.connect()` 不抛（`threwSync:false` 实测），故包 `try/catch` 或放进 `new Promise` executor **都接不住**（不是 rejection、是进程级逃逸）。`withErrorSink`(socket) 在此同样失效（它挂在**已经晚了**的返回 socket 上）。

**根因修（唯一可靠形状）**：**别用 `net.connect()`**。造一个**未连接**的 `const s = new net.Socket()` → 挂全部 listener（error sink + 真 error + connect/data/close/end）→ **最后**才 `s.connect(path)`。listener 保证先于任何连接尝试存在，两 runtime × 两上下文都无窗口。落地 `src/lib/history/search/uds-client.ts` `sendRequest`（commit `6729efc7`）。

**测试真相域陷阱**：此崩溃的忠实 oracle **必须**在 `Bun.serve` 处理器上下文、且走真 `bun run`（非 `bun test` 顶层，否则被 warm-up 掩盖）——用 `Bun.spawn([process.execPath, "-e", ...])` 起子进程、handler 内 query 缺失 socket、按 exit code 判崩溃（`uds-transport.it.test.ts` 的「faithful production oracle」测，revert fix 即红）。in-process `process.on("uncaughtException")` 探针在顶层跑=false-green，与 [[reference-picocolors-collapses-to-identity-in-bun-test]] 同族「bun test 环境掩盖真行为」。呼应 skill `debugging-server-crashes`（无监听 `'error'` → `uncaughtException` 放大链）与 `empirical-verification`（两 runtime × 两上下文实测裁决）。

## 通用手法

- 正常路径先采用已有事实，不为“可能有 Bun 差异”仪式化地双跑。出现 Bun/Node 观测冲突、能力结论将排除方案、或单一 runtime 结果要跨边界外推时，写最小 `bun -e` / node 对照探针；结论须绑定 runtime 版本、平台、事件循环上下文、启动命令与输入。
- `bun test` 绿只覆盖测试 runner 提供的上下文；真实生产上下文不同是进入质疑阶段的触发信号，而不是预先否定所有测试。见 skill `empirical-verification`、`verifying-authoritative-claims`。
- 依赖选型 bun-first：外部库须两 runtime 原生可跑，见 ADR `docs/decisions/2026-07-05-dependency-selection-bun-first.md`。
