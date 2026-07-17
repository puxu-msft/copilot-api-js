# 优雅重启（零停机换代）Implementation Plan

> **实施状态（2026-07-15）：已全部实现并合并 master（`ea1f9314`）。** Task 0-15 全落地 + 2 轮异模型对抗审查（逮出 supervised overlap 缺口 → root-cause 改进程存活性裁决、退役 predecessor-registry）+ 确认复审 ready-to-merge；e2e 真双进程接管复跑 6 pass；合并态全量套件我域零新增失败。承重实现细节以 [docs/lifecycle.md](../lifecycle.md)「优雅重启」节为准（本 plan 为执行拆解、留档）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 copilot-api-js 支持零停机换代——旧进程立即停止 accept 新连接 + 优雅 drain 已有连接的同时，新进程立刻监听并接受新会话，覆盖裸手动 / systemd / pm2 三种运行环境。

**Architecture:** 统一机制 = SO_REUSEPORT 重叠窗口接管（新旧进程短暂同时绑 :4141），交接信号 = SIGUSR2（复用现有 4-phase `gracefulShutdown`）。裸手动路径由新进程自管理（pidfile 活性 guard + 自读自发信号）；systemd（blue-green 双槽模板 `@a`/`@b`）与 pm2 由脚本/supervisor 驱动信号、跳过 pidfile 机制（按 `NOTIFY_SOCKET`/`PM2_HOME` 环境判别）。overlap 期靠两个靶向修（reclaim-orphan 排除 live 前任 + Phase 1 停 telemetry rollup timer）+ WAL 串行化保证共享状态安全。

**Tech Stack:** Bun（`Bun.serve` reusePort）、`@hono/node-server`（Node 回退路径）、node:dgram（sd_notify AF_UNIX datagram）、bun:test、现有 `src/lib/shutdown.ts` / `src/lib/history/sqlite/` / `src/lib/request-telemetry.ts`。

**权威设计文档：** [docs/lifecycle.md](../lifecycle.md)「优雅重启（零停机换代）」节。本计划是其实现拆解，实现中若与设计冲突以设计文档为准、并同步回改。

> **R1 评审修订（2026-07-14，GPT 异模型对抗审查 + 亲手实测）**：一轮对抗审查（实测复现）逮到 4 BLOCKER + 3 MAJOR，均已并入本计划与设计文档：
> - **B1** Task 0 PoC 探针假阳性（`fetch()` keep-alive 连接池复用旧连接，8/8 误判）→ 改 fresh-connection 探针 + 双探针交叉验证。
> - **B2** `removePidfile` 无所有权校验，接管后旧进程退出误删后继者活 pidfile → 新增 `removePidfileIfOwnedBySelf`（compare-and-delete），Task 5/12。
> - **B3** `node:dgram unix_dgram` 实测不可用（`Bad socket type`）→ 新增 Task 0.5（sd_notify 传输选型 PoC），Task 9 改 PoC-gated。
> - **B4** 新进程启动 VACUUM 与旧进程并发写→`SQLITE_BUSY` 静默丢记录 → 新增 Task 7b（接管跳过 `maybeVacuumOnStartup`）+ 设计 overlap ⑤。
> - **M1** Phase 1 停 telemetry timer 但未注销 config 订阅，drain 期热重载重新拉活 → Task 10 补注销 `telemetryConfigUnsub`。
> - **M2** states.json（negotiation/calibration）debounce 全量覆盖写从请求路径触发、Phase 1 停不掉、旧进程晚到覆盖丢新知识 → 新增 Task 10b（flush-then-freeze）+ 设计 overlap ③ 改「真修」。
> - **M3** 全计划 53 处测试路径 `test/` → 实际根目录 `tests/`（`bunfig.toml`）→ 全局改正。
> - MINOR（同终端 TUI raw-mode 冲突警告 / 链式重启局限 / `ManualStartupResult` 类型显式化）已并入设计与相关 Task。
>
> **R2 确认复审修订（2026-07-14，同一 reviewer resume）**：R2 确认 4 原 BLOCKER 全部正确闭环，但逮到 R1 修订**新引入**的问题，已再修：
> - **BLOCKER-NEW-1**（M2 的 `persistenceFrozen` 模块级永久单例无 reset、绕过 L1 守卫、被任意 `gracefulShutdown` 无条件触发 → 污染 6+ 测试文件）→ **根因修**：freeze 门控到 handoff（`signal==="SIGUSR2"`，普通关机不 freeze）+ unfreeze 折进既有 `clearAnthropicFeatureNegotiationForTests`/`resetAllLimitsForTesting`（已在 RESETTERS、L1 守卫覆盖），Task 10b 重写。
> - **MAJOR-NEW-1**（14 个新测试文件用裸 `.test.ts`，被 `test:backend` 子串过滤静默排除）→ 全部按隔离级别改名 `*.unit/it/http.test.ts`、e2e 挪 `tests/e2e/`。
> - MINOR-NEW（Task 9 `sendDatagram` 占位待 Task 0.5 别提前编译 / Phase 1 handoff 路径含 IO）已注记。
> - R2 反馈的**终局经验门**：实现 Task 10b 后**必须跑真实全量 `bun run test:backend`**（非分文件）确认无跨文件污染——已写进 Task 10b Step 5。

## Global Constraints

- **无向后兼容负担**：本项目对旧版本无硬性兼容义务（CLAUDE.md）。但**配置例外**：新增 config 键 `pidfile` 走 warn-continue，绝不因配置问题杀进程。
- **reusePort 无条件常开**：`Bun.serve` 与 Node 路径都必须无条件带 reusePort——不是只在 `--restart` 时开（旧进程必须已 reusePort 绑定，新进程才接管得了）。
- **pidfile 机制仅裸手动路径**：pidfile 写入 + 活性 guard + 自发 SIGUSR2 只在**无 supervisor**（`detectSupervisor() === null`）时启用；systemd/pm2 下完全跳过，否则 blue-green 新槽 `@b` 会被自己的 guard 拒绝启动。
- **SIGUSR2 = 交接信号**：drain 行为与 SIGTERM 完全一致（复用 `gracefulShutdown`），仅日志标签区分。三环境共用同一 handler，差异仅在「谁按下」。
- **never-throw 边界**：pidfile 读写、sd_notify、pm2 notify 全部 never-throw（缺失 socket / 权限 / 陈旧文件都不得中断启动或关闭）。
- **保护 4141 主服务器**：所有测试服务器必须用**非 4141** 端口，按 PID 精确清理自己启动的实例，绝不 `pkill`/`killall`（CLAUDE.md）。
- **测试隔离**：后端测试经 DI 注入临时目录，绝不碰真实 `$HOME`/`~/.claude`（skill `test-isolation`）。
- **提交纪律**：显式 pathspec（`git add -- <精确路径>`）、conventional commits、不加模型署名。

---

## File Structure

**新建：**
- `src/lib/restart/supervisor-env.ts` — 环境判别（systemd / pm2 / 裸手动）。leaf 模块，零项目内依赖。
- `src/lib/restart/pidfile.ts` — pidfile 读/写/活性检查/清理。
- `src/lib/restart/predecessor-registry.ts` — 进程级「待排除的 live 前任 `(pid,bootTime)`」寄存器。leaf 模块，供 `connection.ts` 读（避免循环依赖）。
- `src/lib/restart/takeover.ts` — 裸手动路径决策（proceed/takeover/refuse）+ 发交接信号。
- `src/lib/restart/notify.ts` — sd_notify（`READY=1`/`STOPPING=1`）+ pm2 `process.send('ready')`。
- `contrib/systemd/copilot-api@.service` — blue-green 模板单元样例。
- `contrib/systemd/copilot-api-deploy.sh` — A1+B1 无状态换代脚本样例。
- `contrib/pm2/ecosystem.config.cjs` — pm2 样例。

**修改：**
- `src/lib/config/paths.ts` — 新增 `PIDFILE` 常量。
- `src/lib/serve.ts` — Bun 与 Node 路径无条件加 reusePort。
- `src/lib/shutdown.ts` — `setupShutdownHandlers` 注册 SIGUSR2；Phase 1 停 telemetry background work。
- `src/lib/request-telemetry.ts` — 新增 exported `stopTelemetryBackgroundWork()`（= stopPeriodicPersistence + stopRollupTimer）。
- `src/lib/history/sqlite/connection.ts` — `reclaimOrphanedActiveRows` 排除 live 前任。
- `src/start.ts` — wire：`--restart` flag、启动 guard、写 pidfile、`notifyReady`、退出清理。
- config schema + bundled config.yaml — 新增可选 `pidfile` 键（warn-continue）。

---

## Phase 0：PoC 门槛 — reusePort overlap 内核连接分发正确性

> 这是设计列出的唯一实现前置 PoC。**必须先绿**才能建其上。产物留 `exp/graceful-restart-reuseport/`。
>
> **实施状态（2026-07-14，GPT 实施者）：Phase 0 全部完成，两个门槛均 PASS。**
> - Task 0：fresh-connection 探针 5/5 连跑 100% 确定性 PASS（关旧 listener 后新连接全落新进程），keep-alive 对照探针复现假阳性、证实方法论警告成立。commit `5eb153db`。
> - Task 0.5：sd_notify 传输选型定为 **`bun:ffi socket(2)+sendto(2)` 直接 syscall**（3/3 连跑稳定 PASS，零外部依赖）；候选 2（spawn `systemd-notify --no-block`）同样可行，留作 fallback 记录；`node:dgram unix_dgram` 与原生绑定包 `sd-notify` 均确认不可行。commit `59c15aca`。

### Task 0: reusePort 重叠窗口内核分发 spike

**Files:**
- Create: `exp/graceful-restart-reuseport/probe.ts`
- Create: `exp/graceful-restart-reuseport/FINDINGS.md`

**Interfaces:**
- Produces: 结论「旧进程关闭 listen socket 后，新连接 100% 落到新进程、无 RST、无丢连；已建连接在旧进程存活直到完成」——写入 FINDINGS.md，被后续 Phase 门控。

- [x] **Step 1: 写 probe（fresh-connection 探针——每次新建 TCP，绝不复用连接池）**

> ⚠️ **承重方法论（R1 评审 BLOCKER-1，实测 8/8 复现）**：用默认 `fetch()` 会因 keep-alive 连接池复用**指向旧进程的旧连接**，把「客户端复用旧连接」误判成「内核仍往旧进程分发新连接」→ 假阳性 FAIL、进而可能误判 reusePort 机制不可靠。**必须每次新建 TCP 连接**（`Connection: close` + `keepalive:false`，或 `net.connect`），并用 keep-alive vs fresh 双探针交叉验证。

```ts
// exp/graceful-restart-reuseport/probe.ts
import { connect } from "node:net"

const PORT = 41990 // 非 4141

const oldSrv = Bun.serve({ port: PORT, reusePort: true, fetch: () => new Response("OLD") })
const newSrv = Bun.serve({ port: PORT, reusePort: true, fetch: () => new Response("NEW") })

// fresh-connection 探针：每次新建裸 TCP 连接发一个最小 HTTP/1.1 请求，读响应体。
// 绝不用 fetch()（连接池会复用旧连接，制造假阳性——见上方 R1 警告）。
function hitFresh(): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect({ port: PORT, host: "127.0.0.1" }, () => {
      sock.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
    })
    let buf = ""
    sock.on("data", (d) => (buf += d.toString()))
    sock.on("end", () => resolve(buf.includes("OLD") ? "OLD" : buf.includes("NEW") ? "NEW" : "?"))
    sock.on("error", reject)
  })
}

// 重叠期：两者都绑，内核 LB（fresh 连接应两边都出现）。
const overlap = await Promise.all(Array.from({ length: 20 }, hitFresh))
console.log("overlap 分布:", overlap.reduce((a, s) => ((a[s] = (a[s] ?? 0) + 1), a), {} as Record<string, number>))

// 旧进程 Phase 1：停 accept（不强杀已建连接），旧进程仍存活。
await oldSrv.stop(false)
await Bun.sleep(100)

// 关键断言：此后 fresh 新连接必须 100% 落 NEW。
const after = await Promise.all(Array.from({ length: 50 }, hitFresh))
const distinct = new Set(after)
console.log("关旧 listener 后 fresh 分布:", [...distinct], "count:", after.length)
if (distinct.size === 1 && distinct.has("NEW")) {
  console.log("PASS: 关旧 listener 后 fresh 新连接 100% 落新进程")
} else {
  console.log("FAIL: fresh 分发不确定，含非 NEW =", after.filter((s) => s !== "NEW").length)
}
await newSrv.stop(true)
```

- [x] **Step 1.5: 交叉验证——keep-alive 探针复现假阳性、fresh 探针稳定通过**

再写一个用 `fetch()`（keep-alive）的对照探针，确认它会 FAIL（含 OLD）；证明 fresh 探针的通过不是运气、而是真排除了连接池变量。把两者结果都记进 FINDINGS.md。

- [x] **Step 2: 连跑 5 次证时序确定性**

Run: `for i in 1 2 3 4 5; do bun run exp/graceful-restart-reuseport/probe.ts; done`
Expected: 每次都 `PASS: 关旧 listener 后 fresh 新连接 100% 落新进程`，「关旧 listener 后 fresh 分布」恒为 `[NEW]`。

- [x] **Step 3: 若任一次 FAIL — 停下上报，不继续后续 Phase**

FAIL 意味着 reusePort 重叠机制无法保证零停机分发，需回设计文档改形（如改为「新进程绑定前旧进程先关 listener」的无重叠交接，牺牲部分零停机）。**这是硬门。**

- [x] **Step 4: 写 FINDINGS.md 记录结论 + 连跑输出**

```markdown
# reusePort overlap 内核分发 PoC 结论
- Bun 版本: <bun --version>
- 结论: 关旧 listener（`stop(false)`）后，新连接 100% 落新进程（5/5 连跑确定）。
- 含义: 支撑 lifecycle.md「T3 旧关 listen fd → 内核只把新连接投给新进程」。
```

- [x] **Step 5: Commit**

```bash
git add -- exp/graceful-restart-reuseport/probe.ts exp/graceful-restart-reuseport/FINDINGS.md
git commit -m "test(restart): PoC reusePort overlap kernel dispatch correctness"
```

### Task 0.5: sd_notify 传输选型 PoC（B3，systemd sd_notify 腿的前置门槛）

> R1 评审 BLOCKER-3：`node:dgram` 实测**不支持** AF_UNIX datagram（`createSocket("unix_dgram")` → `Bad socket type`），而 systemd `$NOTIFY_SOCKET` 正是 `SOCK_DGRAM`。sd_notify 的 datagram 发送方式必须先 PoC 定选型，不能在 Task 9 里边写边试。**这只卡 systemd sd_notify 一个后端**——pm2 `process.send` + 接管 `process.kill` 不受影响，Phase 1-3 可先并行推进；Task 9 依赖本 PoC 结论。

**Files:**
- Create: `exp/graceful-restart-sdnotify/probe.ts`
- Create: `exp/graceful-restart-sdnotify/FINDINGS.md`

**Interfaces:**
- Produces: 结论「在 Bun 1.3.x 下向 systemd `SOCK_DGRAM` `$NOTIFY_SOCKET` 发 `READY=1` 的可行方式 = <选定方案>」，供 Task 9 实现 `sdNotify` 时照此写。

- [x] **Step 1: 起一个真 `SOCK_DGRAM` AF_UNIX server（Python，模拟 systemd）+ 逐个试候选发送方**

候选按优先级实测（每个都对准真 dgram server、验证 server 收到 `READY=1`）：
1. **`bun:ffi` 直接 syscall**：`socket(AF_UNIX, SOCK_DGRAM, 0)` + `sendto(2)` 到 socket 路径（含 abstract socket 前导 NUL 处理）。最无外部依赖、最可控。
2. **spawn `systemd-notify` 二进制**：`Bun.spawn(["systemd-notify","--ready"], { env: { NOTIFY_SOCKET } })`。实测本机成功，但引入对 systemd-utils 二进制的运行时依赖（仅 systemd 环境本就有，可接受）。
3. **原生绑定包**（如 `unix-dgram`）：先验证能否在 Bun 下真正加载（`sd-notify` 包实测 Bun 下加载失败，node-gyp 预编译包在 Bun 有系统性风险）。

```ts
// exp/graceful-restart-sdnotify/probe.ts —— 骨架，实现者补三候选
// 1. Python 起 dgram server: socket.socket(AF_UNIX, SOCK_DGRAM).bind(path)
// 2. 逐个候选发 "READY=1"，断言 server 收到
// 3. 记录每个候选：可行? 依赖? 复杂度?
```

- [x] **Step 2: 选定 + 写 FINDINGS.md**

```markdown
# sd_notify 传输选型 PoC 结论
- node:dgram unix_dgram: FAIL（Bad socket type，Bun+Node 均不支持）
- bun:ffi sendto: <结果>
- spawn systemd-notify: <结果>
- 选定: <方案> — 理由 <...>
- Task 9 的 sdNotify() 按此实现。
```

- [x] **Step 3: Commit**

```bash
git add -- exp/graceful-restart-sdnotify/
git commit -m "test(restart): PoC sd_notify SOCK_DGRAM transport selection under Bun"
```

---

## Phase 1：reusePort 无条件常开 + SIGUSR2 handler

### Task 1: `Bun.serve` 与 Node 路径无条件加 reusePort

**Files:**
- Modify: `src/lib/serve.ts`（`startBunServer` 约 :159、`startNodeServer` listen 约 :121）
- Test: `tests/serve-reuseport.http.test.ts`

**Interfaces:**
- Produces: 两个测试进程可同时绑同一非 4141 端口（reusePort 生效的可观测证据）。

- [ ] **Step 1: 写失败测试（两次 startServer 同端口都成功）**

```ts
// tests/serve-reuseport.http.test.ts
import { expect, test } from "bun:test"
import { startServer } from "../src/lib/serve"

test("reusePort: 两个 server 可同时绑同一端口", async () => {
  const PORT = 41991
  const opts = { fetch: () => new Response("ok"), port: PORT, hostnames: ["127.0.0.1"] }
  const a = await startServer(opts)
  const b = await startServer(opts) // 无 reusePort 时这里会 throw "port in use"
  expect(a).toBeDefined()
  expect(b).toBeDefined()
  await a.close(true)
  await b.close(true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/serve-reuseport.http.test.ts`
Expected: FAIL——第二个 `startServer` 抛 `Failed to start server. Is port 41991 in use?`（当前 `Bun.serve` 未带 reusePort）。

- [ ] **Step 3: `startBunServer` 加 `reusePort: true`**

在 `Bun.serve({...})` 选项里加一行（`src/lib/serve.ts` `startBunServer`）：

```ts
  const bunServer = Bun.serve({
    fetch(request: Request, server: unknown) {
      return options.fetch(request, { server })
    },
    port: options.port,
    hostname: options.hostname,
    reusePort: true, // 零停机换代：新旧进程重叠期同绑一端口（lifecycle.md「优雅重启」）
    idleTimeout: 255,
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    ...(options.bunWebSocket ? { websocket: options.bunWebSocket } : {}),
  })
```

Node 路径 `startNodeServer` 的 `listen` 已有 `exclusive: false`；补 `reusePort: true`（Node 23.1+ 支持；旧 Node 忽略未知选项、由 `exclusive:false` 兜底）：

```ts
    nodeServer.listen(
      {
        port: options.port,
        host: options.hostname,
        exclusive: false,
        reusePort: true, // 与 Bun 路径对齐（lifecycle.md「优雅重启」）
        ipv6Only: options.ipv6Only,
      },
      () => { /* ... */ },
    )
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/serve-reuseport.http.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -- src/lib/serve.ts tests/serve-reuseport.http.test.ts
git commit -m "feat(serve): unconditional reusePort for zero-downtime handover"
```

### Task 2: SIGUSR2 → gracefulShutdown("handoff")

**Files:**
- Modify: `src/lib/shutdown.ts`（`setupShutdownHandlers` :607）
- Test: `tests/shutdown-sigusr2.unit.test.ts`

**Interfaces:**
- Consumes: 现有 `handleShutdownSignal(signal, opts)`（:550）、`gracefulShutdown`。
- Produces: 进程收到 SIGUSR2 走与 SIGTERM 相同的 4-phase drain，日志标签为 `handoff`。

- [ ] **Step 1: 写失败测试（SIGUSR2 触发 gracefulShutdown，signal 标签透传）**

```ts
// tests/shutdown-sigusr2.unit.test.ts
import { expect, mock, test } from "bun:test"
import { handleShutdownSignal, _resetShutdownState } from "../src/lib/shutdown"

test("SIGUSR2 经 handleShutdownSignal 触发 gracefulShutdown 且透传 signal 标签", async () => {
  _resetShutdownState()
  const calls: Array<string> = []
  const gracefulShutdownFn = mock((signal: string) => {
    calls.push(signal)
    return Promise.resolve()
  })
  await handleShutdownSignal("SIGUSR2", { gracefulShutdownFn, exitFn: () => {} })
  expect(calls).toEqual(["SIGUSR2"])
})
```

- [ ] **Step 2: 跑测试确认失败/通过基线**

Run: `bun test tests/shutdown-sigusr2.unit.test.ts`
Expected: PASS（`handleShutdownSignal` 本已 signal-agnostic）——本步锁定「signal 标签透传」契约。若已 PASS，进入 Step 3 补真正缺的注册。

- [ ] **Step 3: 写失败测试（setupShutdownHandlers 注册了 SIGUSR2 监听）**

```ts
// 追加到 tests/shutdown-sigusr2.unit.test.ts
import { setupShutdownHandlers } from "../src/lib/shutdown"

test("setupShutdownHandlers 注册 SIGUSR2 监听", () => {
  const before = process.listenerCount("SIGUSR2")
  setupShutdownHandlers()
  expect(process.listenerCount("SIGUSR2")).toBe(before + 1)
  // 清理：移除本测试新增的监听，避免污染其它测试
  process.removeAllListeners("SIGUSR2")
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `bun test tests/shutdown-sigusr2.unit.test.ts`
Expected: 第二个测试 FAIL（当前只注册 SIGINT/SIGTERM）。

- [ ] **Step 5: 在 setupShutdownHandlers 注册 SIGUSR2**

`src/lib/shutdown.ts` `setupShutdownHandlers`：

```ts
export function setupShutdownHandlers(): void {
  const handler = (signal: string) => {
    void handleShutdownSignal(signal)
  }
  process.on("SIGINT", () => handler("SIGINT"))
  process.on("SIGTERM", () => handler("SIGTERM"))
  // 优雅重启交接信号：与 SIGTERM 同款 drain，仅日志标签区分（lifecycle.md「优雅重启」）。
  // 三环境共用（裸手动=新进程自发、systemd/pm2=脚本/supervisor 发）。
  process.on("SIGUSR2", () => handler("SIGUSR2"))
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `bun test tests/shutdown-sigusr2.unit.test.ts`
Expected: 两个测试都 PASS。

- [ ] **Step 7: Commit**

```bash
git add -- src/lib/shutdown.ts tests/shutdown-sigusr2.unit.test.ts
git commit -m "feat(shutdown): SIGUSR2 triggers graceful drain (handoff signal)"
```

---

## Phase 2：环境判别 + pidfile 基建

### Task 3: supervisor-env 环境判别

**Files:**
- Create: `src/lib/restart/supervisor-env.ts`
- Test: `tests/restart/supervisor-env.unit.test.ts`

**Interfaces:**
- Produces:
  - `type Supervisor = "systemd" | "pm2" | null`
  - `detectSupervisor(env?: NodeJS.ProcessEnv): Supervisor`
  - `isSupervised(env?: NodeJS.ProcessEnv): boolean`

- [ ] **Step 1: 写失败测试**

```ts
// tests/restart/supervisor-env.unit.test.ts
import { expect, test } from "bun:test"
import { detectSupervisor, isSupervised } from "../../src/lib/restart/supervisor-env"

test("systemd 判别：NOTIFY_SOCKET 或 INVOCATION_ID", () => {
  expect(detectSupervisor({ NOTIFY_SOCKET: "/run/x.sock" })).toBe("systemd")
  expect(detectSupervisor({ INVOCATION_ID: "abc" })).toBe("systemd")
})
test("pm2 判别：PM2_HOME 或 pm_id", () => {
  expect(detectSupervisor({ PM2_HOME: "/x/.pm2" })).toBe("pm2")
  expect(detectSupervisor({ pm_id: "0" })).toBe("pm2")
})
test("裸手动：无 supervisor 环境 → null", () => {
  expect(detectSupervisor({})).toBeNull()
  expect(isSupervised({})).toBe(false)
  expect(isSupervised({ NOTIFY_SOCKET: "/run/x.sock" })).toBe(true)
})
test("systemd 优先于 pm2（同时存在时）", () => {
  expect(detectSupervisor({ NOTIFY_SOCKET: "/run/x.sock", PM2_HOME: "/x" })).toBe("systemd")
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/restart/supervisor-env.unit.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// src/lib/restart/supervisor-env.ts
/**
 * 进程 supervisor 判别 —— 决定优雅重启走哪条路径（lifecycle.md「优雅重启」）。
 *
 * 裸手动（null）：新进程自管理 pidfile + 活性 guard + 自发 SIGUSR2。
 * systemd / pm2：由脚本/supervisor 驱动信号；跳过 pidfile 机制，否则 blue-green
 * 新槽会被自己的 guard 拒绝启动。
 */
export type Supervisor = "systemd" | "pm2" | null

export function detectSupervisor(env: NodeJS.ProcessEnv = process.env): Supervisor {
  // systemd 优先：Type=notify 设 NOTIFY_SOCKET，所有 systemd 服务设 INVOCATION_ID。
  if (env.NOTIFY_SOCKET || env.INVOCATION_ID) return "systemd"
  // pm2：PM2_HOME 恒设，pm_id 是 worker 序号（"0" 亦真，故判 !== undefined）。
  if (env.PM2_HOME || env.pm_id !== undefined) return "pm2"
  return null
}

export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return detectSupervisor(env) !== null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/restart/supervisor-env.unit.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -- src/lib/restart/supervisor-env.ts tests/restart/supervisor-env.unit.test.ts
git commit -m "feat(restart): supervisor environment detection (systemd/pm2/manual)"
```

### Task 4: PIDFILE 路径常量

**Files:**
- Modify: `src/lib/config/paths.ts`（PATHS 对象，约 :57-70）
- Test: `tests/restart/pidfile-path.unit.test.ts`

**Interfaces:**
- Produces: `PATHS.PIDFILE`（默认 `path.join(APP_DIR, "copilot-api.pid")`）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/restart/pidfile-path.unit.test.ts
import { expect, test } from "bun:test"
import { PATHS } from "../../src/lib/config/paths"

test("PATHS.PIDFILE 在 APP_DIR 下、名为 copilot-api.pid", () => {
  expect(PATHS.PIDFILE.endsWith("copilot-api.pid")).toBe(true)
  expect(PATHS.PIDFILE.startsWith(PATHS.APP_DIR)).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/restart/pidfile-path.unit.test.ts`
Expected: FAIL（`PATHS.PIDFILE` undefined）。

- [ ] **Step 3: 加常量**

`src/lib/config/paths.ts` PATHS 对象内加一行（紧邻其它文件常量）：

```ts
  /** 裸手动路径优雅重启的 pidfile（pid+bootTime+port）。仅无 supervisor 时写入。 */
  PIDFILE: path.join(APP_DIR, "copilot-api.pid"),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/restart/pidfile-path.unit.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -- src/lib/config/paths.ts tests/restart/pidfile-path.unit.test.ts
git commit -m "feat(restart): add PIDFILE path constant"
```

### Task 5: pidfile 读/写/活性/清理

**Files:**
- Create: `src/lib/restart/pidfile.ts`
- Test: `tests/restart/pidfile.unit.test.ts`

**Interfaces:**
- Produces:
  - `interface PidfileContent { pid: number; bootTime: number; port: number }`
  - `writePidfile(path: string, content: PidfileContent): void`（原子写，never-throw→warn）
  - `readPidfile(path: string): PidfileContent | null`（缺失/损坏→null）
  - `isProcessAlive(pid: number): boolean`
  - `readLivePredecessor(path: string, selfPid?: number): PidfileContent | null`（pidfile 存在 + pid 存活 + pid≠self）
  - `removePidfile(path: string): void`（无条件删；never-throw，忽略 ENOENT）
  - `removePidfileIfOwnedBySelf(path: string, self: { pid: number; bootTime: number }): void`（**compare-and-delete**：仅当 pidfile 里 `pid`==self.pid 时才删——防接管后误删后继者的活 pidfile，B2）

- [ ] **Step 1: 写失败测试（用临时目录，绝不碰真实 $HOME）**

```ts
// tests/restart/pidfile.unit.test.ts
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isProcessAlive, readLivePredecessor, readPidfile, removePidfile, removePidfileIfOwnedBySelf, writePidfile } from "../../src/lib/restart/pidfile"

const dirs: Array<string> = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pidfile-"))
  dirs.push(d)
  return join(d, "copilot-api.pid")
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

test("write→read round-trip", () => {
  const p = tmp()
  writePidfile(p, { pid: 1234, bootTime: 999, port: 4141 })
  expect(readPidfile(p)).toEqual({ pid: 1234, bootTime: 999, port: 4141 })
})
test("readPidfile 缺失→null", () => {
  expect(readPidfile(tmp())).toBeNull()
})
test("readPidfile 损坏 JSON→null（never-throw）", () => {
  const p = tmp()
  writeFileSync(p, "{not json")
  expect(readPidfile(p)).toBeNull()
})
test("isProcessAlive：自身存活、天文数字 pid 不存活", () => {
  expect(isProcessAlive(process.pid)).toBe(true)
  expect(isProcessAlive(2 ** 30)).toBe(false)
})
test("readLivePredecessor：自身 pid 被排除（不把自己当前任）", () => {
  const p = tmp()
  writePidfile(p, { pid: process.pid, bootTime: 1, port: 4141 })
  expect(readLivePredecessor(p, process.pid)).toBeNull()
})
test("readLivePredecessor：死 pid → null", () => {
  const p = tmp()
  writePidfile(p, { pid: 2 ** 30, bootTime: 1, port: 4141 })
  expect(readLivePredecessor(p, process.pid)).toBeNull()
})
test("readLivePredecessor：活的别的进程 pid → 返回内容", () => {
  const p = tmp()
  // 用一个真实存活的其它 pid：pid 1（init）恒存活，且 ≠ 本测试进程
  writePidfile(p, { pid: 1, bootTime: 1, port: 4141 })
  expect(readLivePredecessor(p, process.pid)).toEqual({ pid: 1, bootTime: 1, port: 4141 })
})
test("removePidfile 幂等（缺失不抛）", () => {
  const p = tmp()
  expect(() => removePidfile(p)).not.toThrow()
  writePidfile(p, { pid: 1, bootTime: 1, port: 4141 })
  removePidfile(p)
  expect(readPidfile(p)).toBeNull()
})
test("removePidfileIfOwnedBySelf：pid 匹配才删（B2 防误删后继者）", () => {
  const p = tmp()
  // 后继者已用 pid=200 覆写；自己是 pid=100 → 不该删（不是我的了）
  writePidfile(p, { pid: 200, bootTime: 2, port: 4141 })
  removePidfileIfOwnedBySelf(p, { pid: 100, bootTime: 1 })
  expect(readPidfile(p)).toEqual({ pid: 200, bootTime: 2, port: 4141 }) // 仍在
  // 若还属于自己（pid=100）→ 删
  writePidfile(p, { pid: 100, bootTime: 1, port: 4141 })
  removePidfileIfOwnedBySelf(p, { pid: 100, bootTime: 1 })
  expect(readPidfile(p)).toBeNull()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/restart/pidfile.unit.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// src/lib/restart/pidfile.ts
import consola from "consola"
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"

/** pidfile 内容 —— 复用 process-identity 的 pid+bootTime，加 port。 */
export interface PidfileContent {
  pid: number
  bootTime: number
  port: number
}

/** 原子写（写临时文件 + rename）。never-throw：失败仅 warn，不中断启动。 */
export function writePidfile(path: string, content: PidfileContent): void {
  try {
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(content), "utf8")
    renameSync(tmp, path)
  } catch (err) {
    consola.warn(`[restart] 写 pidfile 失败（非致命，接管协议将不可用）: ${path}`, err)
  }
}

/** 读并解析。缺失 / 损坏 / 字段缺失 → null（never-throw）。 */
export function readPidfile(path: string): PidfileContent | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PidfileContent>
    if (typeof raw.pid !== "number" || typeof raw.bootTime !== "number" || typeof raw.port !== "number") {
      return null
    }
    return { pid: raw.pid, bootTime: raw.bootTime, port: raw.port }
  } catch {
    return null // ENOENT / 损坏 JSON / 权限 —— 一律当「无有效 pidfile」
  }
}

/** 进程是否存活。`kill(pid, 0)` 不实际发信号，只探存在性。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH = 不存在；EPERM = 存在但无权限（仍算存活）。
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** 读到「活的、不是自己」的前任 pidfile 内容，否则 null。 */
export function readLivePredecessor(path: string, selfPid: number = process.pid): PidfileContent | null {
  const content = readPidfile(path)
  if (!content) return null
  if (content.pid === selfPid) return null // 自己写的、别当前任
  if (!isProcessAlive(content.pid)) return null // 陈旧 pidfile（崩溃/被 SIGKILL 残留）
  return content
}

/** 删除。never-throw，忽略 ENOENT。 */
export function removePidfile(path: string): void {
  try {
    unlinkSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      consola.warn(`[restart] 删 pidfile 失败（非致命）: ${path}`, err)
    }
  }
}

/**
 * compare-and-delete（B2 承重）：仅当磁盘 pidfile 的 pid == 自己时才删。
 * 接管后新进程已用自己的 pid 覆写同一路径；旧进程退出时若无条件删会误删后继者的
 * 活 pidfile → guard 永久失效、下次普通启动静默叠加第三实例。故只删「还属于自己」的那份。
 */
export function removePidfileIfOwnedBySelf(path: string, self: { pid: number; bootTime: number }): void {
  const content = readPidfile(path)
  if (!content) return // 已被删/损坏 → 没什么可删
  if (content.pid !== self.pid) {
    // 已被后继者接管改写 → 不是我的，别碰。
    return
  }
  removePidfile(path)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/restart/pidfile.unit.test.ts`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add -- src/lib/restart/pidfile.ts tests/restart/pidfile.unit.test.ts
git commit -m "feat(restart): pidfile read/write/liveness/cleanup primitives"
```

---

## Phase 3：接管决策 + live 前任寄存器 + reclaim-orphan 修复

> **2026-07-16 修订（合并态审查逮到 supervised 路径 overlap 保护缺失，MAJOR）**：本 Phase 当时设计的 `predecessor-registry`（Task 6）只在 bare-metal takeover 分支被填充，systemd/pm2 supervised 路径走 `{kind:"skip"}` 从不填充——导致 reclaim 排除（Task 7）与 VACUUM 跳过（Task 7b）这两项数据完整性保护在 supervised 环境完全不生效。已**退役** `predecessor-registry.ts`，reclaim/VACUUM 改为直接按 `isProcessAlive(owner_pid)` 的**进程存活性裁决**（环境无关、三路径天然统一）。以下 Task 6/7/7b 描述的 registry 机制是**历史记录，已被取代**，权威现状见 `docs/lifecycle.md`「overlap 共享状态安全 ①⑤」+ `src/lib/history/sqlite/connection.ts` 的 `hasLiveForeignOwner`/`distinctActiveOwnerPids`。

### Task 6: live 前任寄存器（供 connection.ts 读）

**Files:**
- Create: `src/lib/restart/predecessor-registry.ts`
- Test: `tests/restart/predecessor-registry.unit.test.ts`

**Interfaces:**
- Produces:
  - `setExcludedPredecessor(p: { pid: number; bootTime: number } | null): void`
  - `getExcludedPredecessor(): { pid: number; bootTime: number } | null`

**为何独立 leaf 模块：** `connection.ts` 需读「要排除的 live 前任」但不能 import `takeover.ts`/`start.ts`（循环依赖）。寄存器是零依赖 leaf，`start.ts` 在 `initHistory` 前 set、`connection.ts` 读。

- [ ] **Step 1: 写失败测试**

```ts
// tests/restart/predecessor-registry.unit.test.ts
import { afterEach, expect, test } from "bun:test"
import { getExcludedPredecessor, setExcludedPredecessor } from "../../src/lib/restart/predecessor-registry"

afterEach(() => setExcludedPredecessor(null))

test("默认 null", () => {
  expect(getExcludedPredecessor()).toBeNull()
})
test("set 后可读回", () => {
  setExcludedPredecessor({ pid: 42, bootTime: 100 })
  expect(getExcludedPredecessor()).toEqual({ pid: 42, bootTime: 100 })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/restart/predecessor-registry.unit.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/lib/restart/predecessor-registry.ts
/**
 * 进程级寄存器：优雅重启接管时，新进程记下「仍活着、正在 drain 的 live 前任」的
 * (pid, bootTime)，供 `history/sqlite/connection.ts` 的 reclaimOrphanedActiveRows
 * 排除——避免误把前任正在 drain 的在途行刷成 interrupted（lifecycle.md「overlap 共享状态安全 ①」）。
 *
 * leaf 模块、零项目内依赖：connection.ts 读它，避免 import start/takeover 造成循环依赖。
 */
let excluded: { pid: number; bootTime: number } | null = null

export function setExcludedPredecessor(p: { pid: number; bootTime: number } | null): void {
  excluded = p
}

export function getExcludedPredecessor(): { pid: number; bootTime: number } | null {
  return excluded
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/restart/predecessor-registry.unit.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -- src/lib/restart/predecessor-registry.ts tests/restart/predecessor-registry.unit.test.ts
git commit -m "feat(restart): live-predecessor registry for reclaim-orphan exclusion"
```

### Task 7: reclaimOrphanedActiveRows 排除 live 前任

**Files:**
- Modify: `src/lib/history/sqlite/connection.ts`（`reclaimOrphanedActiveRows` :236）
- Test: `tests/restart/reclaim-excludes-predecessor.it.test.ts`

**Interfaces:**
- Consumes: `getExcludedPredecessor()`（Task 6）。
- Produces: 当寄存器有 live 前任时，reclaim 的 SELECT/UPDATE WHERE 额外 `AND NOT (pid=? AND boot_time=?)`，不动前任在途行。

- [x] **Step 1: 写失败测试（内存 DB，插前任 active 行，set 寄存器，验 reclaim 不动它）**

```ts
// tests/restart/reclaim-excludes-predecessor.it.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { setExcludedPredecessor } from "../../src/lib/restart/predecessor-registry"
// 注：reclaimOrphanedActiveRows 当前是 connection.ts 内部函数；本 task 顺带导出它以便隔离测。
import { openDatabase } from "../../src/lib/history/sqlite/connection"

afterEach(() => setExcludedPredecessor(null))

test("set live 前任后，reclaim 不把前任的 active 行刷 interrupted", () => {
  // 用一个内存/临时库开库（openDatabase 会跑 reclaim）；插入一条属于「前任」的 active 行，
  // 再模拟第二次开库（新进程）时前任仍活 → 该行须保持 active。
  // 具体断言：前任 (pid=999, bootTime=111) 的 streaming 行在 set 寄存器后 reclaim 不变。
  setExcludedPredecessor({ pid: 999, bootTime: 111 })
  // ... 用临时 DB 插入 entries_v2 一行 (pid=999,boot_time=111,status='streaming')，
  //     调 reclaimOrphanedActiveRows(db)，断言该行 status 仍为 'streaming'。
  //     再插一行 (pid=888,boot_time=222,status='streaming')（非前任、非自己）→ reclaim 后应为 'interrupted'。
})
```

> 实现者注：本测试需要 `reclaimOrphanedActiveRows` 可被隔离调用 + 一个可插入 entries_v2 的临时库。落地时把 `reclaimOrphanedActiveRows` 从 connection.ts **导出**（当前是 module-private），并复用 `schema.ts` 的 SCHEMA_SQL 建临时库。断言两行对照：前任行留 active、非前任非自己行转 interrupted。

- [x] **Step 2: 跑测试确认失败**

Run: `bun test tests/restart/reclaim-excludes-predecessor.it.test.ts`
Expected: FAIL（当前 reclaim 会把前任行也刷成 interrupted）。

- [x] **Step 3: 改 reclaimOrphanedActiveRows 排除 live 前任**

`src/lib/history/sqlite/connection.ts`：

```ts
import { getExcludedPredecessor } from "../../restart/predecessor-registry"

function reclaimOrphanedActiveRows(database: Database): void {
  const { pid, bootTime } = getProcessIdentity()
  const predecessor = getExcludedPredecessor()
  // 基础排除：自己的行。接管场景额外排除 live 前任的行（它仍在 drain、还在写这些行）。
  let where = "status IN ('pending','executing','streaming') AND NOT (pid = ? AND boot_time = ?)"
  const params: Array<number> = [pid, bootTime]
  if (predecessor) {
    where += " AND NOT (pid = ? AND boot_time = ?)"
    params.push(predecessor.pid, predecessor.bootTime)
  }
  const { n } = database.prepare(`SELECT COUNT(*) AS n FROM entries_v2 WHERE ${where}`).get(...params) as { n: number }
  if (n === 0) return
  database
    .prepare(
      `UPDATE entries_v2 SET status = 'interrupted', ended_at = COALESCE(ended_at, started_at), error_message = COALESCE(error_message, 'orphaned by a prior process — recovered on restart') WHERE ${where}`,
    )
    .run(...params)
  consola.info(`[history/sqlite] reclaimed ${n} orphaned active row(s) from a prior process → interrupted`)
}
```

同时把该函数 `export`（供隔离测）。

- [x] **Step 4: 跑测试确认通过**

Run: `bun test tests/restart/reclaim-excludes-predecessor.it.test.ts`
Expected: PASS。

- [x] **Step 5: 跑既有 history 连接测试防回归**

Run: `bun test tests/history/ 2>/dev/null || bun test --rerun-each 1 tests/ -t reclaim`
Expected: 既有 reclaim / connection 测试仍 PASS（无寄存器时行为不变）。

- [x] **Step 6: Commit**

```bash
git add -- src/lib/history/sqlite/connection.ts tests/restart/reclaim-excludes-predecessor.it.test.ts
git commit -m "fix(history): reclaim-orphan excludes live predecessor during handover overlap"
```

> **实施记录（2026-07-14）**：commit `c9555ae9`。测试全绿（2 pass）。`bun test tests/history/` 504 pass / 1 skip / 1 pre-existing fail（`history-ui-route.unit.test.ts` GET /ui 404，与本改动无关，属计划已知基线失败之一）。`bun run typecheck` 仍是基线的 2 个既有错误（`item_id` on `OutputTextDeltaEvent`），无新增。

### Task 7b: 接管时跳过启动 VACUUM（B4，overlap 数据丢失防护）

**Files:**
- Modify: `src/lib/history/sqlite/connection.ts`（`openDatabase` :84 的 `maybeVacuumOnStartup` 调用）
- Test: `tests/restart/vacuum-skip-on-takeover.it.test.ts`

**Interfaces:**
- Consumes: `getExcludedPredecessor()`（Task 6）。
- Produces: predecessor registry 非空（=接管中）时，`openDatabase` 跳过 `maybeVacuumOnStartup`。

> R1 评审 BLOCKER-4：`maybeVacuumOnStartup` 在 `openDatabase` 同步路径（Phase 3、早于 listen/发信号）跑；VACUUM 需独占整库写锁、时长随库大小线性增长（可远超 `busy_timeout=5000`）。此刻旧进程完全不知接管、正常流量写 history.db → 命中阈值时旧进程写 `SQLITE_BUSY`→never-throw 静默降级 = **history 记录丢失**。接管场景（predecessor 非空）必须跳过 VACUUM；它本是有阈值的一次性维护，延后到下次真正独占启动即可（reaper incremental vacuum 仍安全）。

- [x] **Step 1: 写失败测试（set predecessor 后 openDatabase 不跑 full VACUUM）**

```ts
// tests/restart/vacuum-skip-on-takeover.it.test.ts
import { afterEach, expect, test } from "bun:test"
import { setExcludedPredecessor } from "../../src/lib/restart/predecessor-registry"

afterEach(() => setExcludedPredecessor(null))

test("predecessor 非空时 openDatabase 跳过 maybeVacuumOnStartup", () => {
  // 用一个 freelist 超阈值的临时库（迫使非接管时会 VACUUM），set predecessor 后开库，
  // 断言 VACUUM 未发生（freelist_count 未被回收 / 或对 maybeVacuumOnStartup 注入 spy 验证未调）。
  // 实现者注：maybeVacuumOnStartup 当前 module-private；本 task 顺带把「是否跳过」的判定抽成
  // 可测点——或导出 maybeVacuumOnStartup 并在 openDatabase 里用 getExcludedPredecessor() gate。
  setExcludedPredecessor({ pid: 1, bootTime: 1 })
  // ... 断言跳过
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test tests/restart/vacuum-skip-on-takeover.it.test.ts`
Expected: FAIL（当前无条件跑 VACUUM）。

- [x] **Step 3: gate maybeVacuumOnStartup**

`src/lib/history/sqlite/connection.ts` `openDatabase`（:84 附近）：

```ts
import { getExcludedPredecessor } from "../../restart/predecessor-registry"

  // ...openDatabase 内，maybeVacuumOnStartup 调用处：
  if (getExcludedPredecessor()) {
    // 接管中：旧进程仍存活、正常流量写库。VACUUM 需独占写锁、耗时不定，会让旧进程写 SQLITE_BUSY
    // 静默丢记录（lifecycle.md overlap ⑤）。延后到下次独占启动；reaper incremental vacuum 仍安全。
    consola.info("[history/sqlite] 检测到接管中的前任，跳过启动 VACUUM（延后到下次独占启动）")
  } else {
    maybeVacuumOnStartup(db, dbPath)
  }
```

- [x] **Step 4: 跑测试确认通过 + 既有 connection 测试防回归**

Run: `bun test tests/restart/vacuum-skip-on-takeover.it.test.ts && bun test tests/history/`
Expected: PASS，既有开库/VACUUM 测试无回归（无 predecessor 时行为不变）。

- [x] **Step 5: Commit**

```bash
git add -- src/lib/history/sqlite/connection.ts tests/restart/vacuum-skip-on-takeover.it.test.ts
git commit -m "fix(history): skip startup VACUUM during handover overlap (SQLITE_BUSY data loss)"
```

> **实施记录（2026-07-14）**：commit `330e7f68`。测试全绿（2 pass，覆盖「接管跳过」+「非接管行为不变」两支）。`bun test tests/restart/ tests/history/` 合跑 504 pass / 1 skip / 1 pre-existing fail（同上 history-ui-route，与本改动无关）。`bun run typecheck` 无新增错误。

### Task 8: 接管决策 + 交接信号

**Files:**
- Create: `src/lib/restart/takeover.ts`
- Test: `tests/restart/takeover.unit.test.ts`

**Interfaces:**
- Consumes: `readLivePredecessor`（Task 5）、`PidfileContent`。
- Produces:
  - `type StartupDecision = { kind: "proceed" } | { kind: "takeover"; predecessor: PidfileContent } | { kind: "refuse"; predecessor: PidfileContent }`
  - `type ManualStartupResult = StartupDecision | { kind: "skip" }`（`"skip"` = supervisor 环境跳过整个 pidfile 机制；Task 12 的 `resolveManualStartup` 返回此类型）
  - `decideStartup(args: { pidfilePath: string; hasRestartFlag: boolean; selfPid?: number }): StartupDecision`
  - `signalPredecessorHandoff(pid: number): void`（`process.kill(pid, "SIGUSR2")`，never-throw→warn）

- [ ] **Step 1: 写失败测试**

```ts
// tests/restart/takeover.unit.test.ts
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { decideStartup } from "../../src/lib/restart/takeover"
import { writePidfile } from "../../src/lib/restart/pidfile"

const dirs: Array<string> = []
function tmpPidfile(): string {
  const d = mkdtempSync(join(tmpdir(), "takeover-")); dirs.push(d); return join(d, "copilot-api.pid")
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

test("无 pidfile → proceed（不论 flag）", () => {
  expect(decideStartup({ pidfilePath: tmpPidfile(), hasRestartFlag: false })).toEqual({ kind: "proceed" })
  expect(decideStartup({ pidfilePath: tmpPidfile(), hasRestartFlag: true })).toEqual({ kind: "proceed" })
})
test("live 前任 + 无 --restart → refuse", () => {
  const p = tmpPidfile()
  writePidfile(p, { pid: 1, bootTime: 1, port: 4141 }) // pid 1 恒存活
  const d = decideStartup({ pidfilePath: p, hasRestartFlag: false })
  expect(d.kind).toBe("refuse")
})
test("live 前任 + --restart → takeover（带前任内容）", () => {
  const p = tmpPidfile()
  writePidfile(p, { pid: 1, bootTime: 1, port: 4141 })
  const d = decideStartup({ pidfilePath: p, hasRestartFlag: true })
  expect(d).toEqual({ kind: "takeover", predecessor: { pid: 1, bootTime: 1, port: 4141 } })
})
test("陈旧 pidfile（死 pid）→ proceed（当作无前任）", () => {
  const p = tmpPidfile()
  writePidfile(p, { pid: 2 ** 30, bootTime: 1, port: 4141 })
  expect(decideStartup({ pidfilePath: p, hasRestartFlag: false })).toEqual({ kind: "proceed" })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/restart/takeover.unit.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/lib/restart/takeover.ts
import consola from "consola"

import type { PidfileContent } from "./pidfile"

import { readLivePredecessor } from "./pidfile"

/**
 * 裸手动路径的启动决策（lifecycle.md「路径一」+「pidfile 活性检查」）。
 * supervisor 路径不调用本模块（start.ts 按 isSupervised 分流）。
 */
export type StartupDecision =
  | { kind: "proceed" } // 无 live 前任，正常启动
  | { kind: "takeover"; predecessor: PidfileContent } // live 前任 + --restart：接管
  | { kind: "refuse"; predecessor: PidfileContent } // live 前任 + 无 --restart：拒绝

export function decideStartup(args: { pidfilePath: string; hasRestartFlag: boolean; selfPid?: number }): StartupDecision {
  const predecessor = readLivePredecessor(args.pidfilePath, args.selfPid)
  if (!predecessor) return { kind: "proceed" }
  return args.hasRestartFlag ? { kind: "takeover", predecessor } : { kind: "refuse", predecessor }
}

/** 向 live 前任发 SIGUSR2 交接信号。never-throw：前任恰好在此刻退出（ESRCH）不算错。 */
export function signalPredecessorHandoff(pid: number): void {
  try {
    process.kill(pid, "SIGUSR2")
    consola.info(`[restart] 已向前任进程 pid=${pid} 发送 SIGUSR2 交接信号`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      consola.info(`[restart] 前任 pid=${pid} 已自行退出，无需交接信号`)
    } else {
      consola.warn(`[restart] 向前任 pid=${pid} 发 SIGUSR2 失败（非致命）`, err)
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/restart/takeover.unit.test.ts`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add -- src/lib/restart/takeover.ts tests/restart/takeover.unit.test.ts
git commit -m "feat(restart): startup decision (proceed/takeover/refuse) + handoff signal"
```

---

## Phase 4：就绪通知（sd_notify + pm2）

### Task 9: notify 模块

**Files:**
- Create: `src/lib/restart/notify.ts`
- Test: `tests/restart/notify.unit.test.ts`

**Interfaces:**
- Produces:
  - `sdNotify(state: string, env?: NodeJS.ProcessEnv): void`（写 `$NOTIFY_SOCKET` AF_UNIX datagram，无 socket→no-op，never-throw）
  - `notifyReady(env?: NodeJS.ProcessEnv): void`（sd_notify `READY=1` + pm2 `process.send('ready')`）
  - `notifyStopping(env?: NodeJS.ProcessEnv): void`（sd_notify `STOPPING=1`）

- [ ] **Step 1: 写失败测试（起真 AF_UNIX datagram socket 收 READY=1）**

```ts
// tests/restart/notify.unit.test.ts
import { afterEach, expect, test } from "bun:test"
import { notifyReady, sdNotify } from "../../src/lib/restart/notify"

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

test("sdNotify 无 NOTIFY_SOCKET → no-op（不抛）", () => {
  expect(() => sdNotify("READY=1", {})).not.toThrow()
})

test("sdNotify 有 NOTIFY_SOCKET 但发送失败 → never-throw", () => {
  // 不存在的 socket 路径：sendDatagram 内部失败必须被吞（never-throw 契约）
  expect(() => sdNotify("READY=1", { NOTIFY_SOCKET: "/nonexistent/notify.sock" })).not.toThrow()
})

test("notifyReady 在 pm2（有 process.send）时调 process.send('ready')", () => {
  const calls: Array<unknown> = []
  const orig = process.send
  ;(process as { send?: unknown }).send = (m: unknown) => { calls.push(m); return true }
  cleanups.push(() => { (process as { send?: unknown }).send = orig })
  notifyReady({}) // 无 NOTIFY_SOCKET，只测 pm2 腿
  expect(calls).toContain("ready")
})
```

> 实现者注：**真 `SOCK_DGRAM` 送达**由 Task 0.5 选定的 `sendDatagram` 实现，其送达正确性由 Task 0.5 的 PoC（对准真 Python dgram server）覆盖，此处单测只验分发逻辑 + never-throw。**不要**用 `node:dgram unix_dgram`（实测 `Bad socket type`）。若 `sendDatagram` 需要注入以便更细单测，把它做成模块内可替换的函数引用 + 一个 test-only setter。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/restart/notify.unit.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// src/lib/restart/notify.ts
import consola from "consola"

/**
 * 就绪 / 生命周期通知（lifecycle.md「notifyReady 一点三后端」）。
 * 无对应环境时各腿 no-op；全部 never-throw（通知失败绝不中断启动/关闭）。
 */

/**
 * 向 systemd 的 $NOTIFY_SOCKET 投递一条状态消息（AF_UNIX SOCK_DGRAM）。
 *
 * ⚠️ 传输方式由 Task 0.5 PoC 选定（B3）——`node:dgram` 不支持 unix datagram，
 * 不可用 `createSocket("unix_dgram")`。按 PoC 结论用以下之一实现 `sendDatagram`：
 *   - bun:ffi 直接 socket(AF_UNIX,SOCK_DGRAM)+sendto(2)（含 '@'→前导 NUL 的 abstract socket）
 *   - spawn `systemd-notify`（仅 systemd 环境有该二进制）
 *   - 已验证能在 Bun 加载的原生绑定包
 * 把发送封装成一个内部 `sendDatagram(path: string, payload: Buffer): void`（never-throw），
 * sdNotify 只负责组装 state + '@' abstract 转换 + 调它。
 */
export function sdNotify(state: string, env: NodeJS.ProcessEnv = process.env): void {
  const socketPath = env.NOTIFY_SOCKET
  if (!socketPath) return // 非 systemd Type=notify → no-op
  try {
    const target = socketPath.startsWith("@") ? `\0${socketPath.slice(1)}` : socketPath
    sendDatagram(target, Buffer.from(state)) // ← Task 0.5 选定的实现
  } catch (err) {
    consola.debug("[restart] sd_notify 异常（非致命）", err)
  }
}

/** 就绪：sd_notify READY=1 + pm2 process.send('ready')。 */
export function notifyReady(env: NodeJS.ProcessEnv = process.env): void {
  sdNotify("READY=1", env)
  try {
    process.send?.("ready") // pm2 wait_ready 契约；非 pm2 时 process.send 不存在 → 跳过
  } catch (err) {
    consola.debug("[restart] pm2 ready 通知失败（非致命）", err)
  }
}

/** 进入 drain：sd_notify STOPPING=1（让 systemd 知道正在收尾）。 */
export function notifyStopping(env: NodeJS.ProcessEnv = process.env): void {
  sdNotify("STOPPING=1", env)
}
```

> 实现者注：`sendDatagram` 的具体实现来自 **Task 0.5 的 FINDINGS.md**。测试策略：sdNotify 的**分发逻辑**（有无 NOTIFY_SOCKET、'@' abstract 转换、pm2 腿）用注入 mock sender 单测；真 `SOCK_DGRAM` 送达用一个 Python dgram server 的 e2e（Phase 6/7，或 Task 0.5 already 覆盖）。**不要**用 `node:dgram unix_dgram`——实测 `Bad socket type`。

- [ ] **Step 4: 跑测试确认通过（分发逻辑单测；真送达走 e2e）**

Run: `bun test tests/restart/notify.unit.test.ts`
Expected: PASS。unix_dgram 若不支持，改 mock-sender 单测 + 标记 e2e 延后到 Phase 7。

- [ ] **Step 5: Commit**

```bash
git add -- src/lib/restart/notify.ts tests/restart/notify.unit.test.ts
git commit -m "feat(restart): sd_notify + pm2 readiness/stopping notifications"
```

### Task 10: Phase 1 停 telemetry background work + 关机发 STOPPING

**Files:**
- Modify: `src/lib/request-telemetry.ts`（新增 exported 包装）
- Modify: `src/lib/shutdown.ts`（Phase 1 调用 + notifyStopping）
- Test: `tests/restart/telemetry-stop-on-phase1.unit.test.ts`

**Interfaces:**
- Produces: `stopTelemetryBackgroundWork(): void`（= `stopPeriodicPersistence()` + `stopRollupTimer()`，幂等）。
- Consumes（shutdown.ts）：`stopTelemetryBackgroundWork`、`notifyStopping`。

- [ ] **Step 1: 写失败测试（stopTelemetryBackgroundWork 被导出且幂等）**

```ts
// tests/restart/telemetry-stop-on-phase1.unit.test.ts
import { expect, test } from "bun:test"
import { stopTelemetryBackgroundWork } from "../../src/lib/request-telemetry"

test("stopTelemetryBackgroundWork 导出且可重复调用不抛（幂等）", () => {
  expect(() => { stopTelemetryBackgroundWork(); stopTelemetryBackgroundWork() }).not.toThrow()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/restart/telemetry-stop-on-phase1.unit.test.ts`
Expected: FAIL（未导出）。

- [ ] **Step 3: 在 request-telemetry.ts 加导出包装**

`src/lib/request-telemetry.ts`（`stopPeriodicPersistence`/`stopRollupTimer` 之后）：

```ts
/**
 * Phase-1 早停 telemetry 后台 timer（优雅重启接管场景）。停 persist + rollup 两个 timer
 * **并注销 config 热重载订阅**。
 * **rollup 是承重**：两进程并发上卷会重复放大（watermark 幂等只防同进程重放、不防跨进程并发）。
 * **注销订阅是承重（M1）**：只停 timer 不注销 `telemetryConfigUnsub`，drain 期（最长 180s）任一次
 * 配置热重载（在途请求走 applyConfigToState）会经 restartTelemetryTimers 把 rollup timer 重新拉活、
 * 抵消本修复。故这里必须一并注销订阅。
 * 最终 flush 仍推迟到 finalize 的 shutdownRequestTelemetry（drain-before-close，不丢在途 delta）。
 * 幂等：两个 stop 自带 null 守卫；telemetryConfigUnsub 注销后置 null，finalize 再注销是 no-op。
 * 见 lifecycle.md「overlap 共享状态安全 ②」。
 */
export function stopTelemetryBackgroundWork(): void {
  stopPeriodicPersistence()
  stopRollupTimer()
  telemetryConfigUnsub?.() // 注销 onTelemetryConfigChange 订阅，防 drain 期热重载重新拉活 timer（M1）
  telemetryConfigUnsub = null
}
```

- [ ] **Step 4: shutdown.ts Phase 1 调用 + notifyStopping**

`src/lib/shutdown.ts` `gracefulShutdown` Phase 1（`stopHistoryBackgroundWork()` 之后）：

```ts
import { stopTelemetryBackgroundWork } from "./request-telemetry"
import { notifyStopping } from "./restart/notify"

  // ...在 Phase 1 stop 后台服务处：
  stopRefresh()
  stopHistoryBackgroundWork()
  stopTelemetryBackgroundWork() // 停 telemetry rollup timer，避免与接管的新进程并发上卷（lifecycle.md overlap ②）
  closeHttp2Sessions()
  peekUpstreamWsManager()?.stopNew()

  // 通知 supervisor 正在收尾（systemd STOPPING=1；非 systemd no-op）
  notifyStopping()
```

- [ ] **Step 5: 跑测试 + 既有 shutdown 测试防回归**

Run: `bun test tests/restart/telemetry-stop-on-phase1.unit.test.ts && bun test tests/ -t shutdown`
Expected: PASS，既有 shutdown 4-phase 测试无回归。

- [ ] **Step 6: Commit**

```bash
git add -- src/lib/request-telemetry.ts src/lib/shutdown.ts tests/restart/telemetry-stop-on-phase1.unit.test.ts
git commit -m "feat(shutdown): stop telemetry rollup in Phase 1 + sd_notify STOPPING on drain"
```

### Task 10b: states.json flush-then-freeze（M2，防覆盖丢失）

**Files:**
- Modify: `src/lib/anthropic/feature-negotiation.ts`（新增 `flushAndFreezePersistence()` + `unfreezePersistenceForTests()`，并把 unfreeze 折进既有 `clearAnthropicFeatureNegotiationForTests`）
- Modify: `src/lib/models/calibration/engine.ts`（新增 `flushAndFreezePersistence()` + unfreeze 折进既有 `resetAllLimitsForTesting`）
- Modify: `src/lib/shutdown.ts`（Phase 1 **仅 handoff 信号**调用两者）
- Test: `tests/restart/states-flush-freeze.it.test.ts`

**Interfaces:**
- Produces（各模块）：`flushAndFreezePersistence(): Promise<void>`——立即 flush 一次（清 debounce、落最后快照），随后把 `schedulePersist` 降级为 no-op（freeze）。
- Consumes（shutdown.ts）：两个 `flushAndFreezePersistence`，**仅在 handoff（SIGUSR2）路径调用**。

> R1 评审 MAJOR-2：feature-negotiation（18 处）+ calibration 都是 **debounce 全量快照覆盖写**，从**请求处理路径**触发、**不受 Phase 1 现有 stop\* 影响**；overlap 期旧进程处理在途请求仍会 `schedulePersist`，整内存态覆盖整磁盘态会把新进程新学到的负反馈**整体覆盖丢失**。修法 = flush-then-freeze。
>
> **R2 确认复审 BLOCKER-NEW-1（本轮修订必须一并解决的两点）**：
> 1. **freeze 必须门控到 handoff（SIGUSR2）路径**——freeze 的语义前提是「有后继者接手学习职责」，只有接管才成立；普通 SIGINT/SIGTERM 关机无后继者、freeze 纯属多余，且会让测试里的 28+ 处 `gracefulShutdown("SIGINT"/"SIGTERM")` 调用**污染同进程后续测试**。`gracefulShutdown(signal)` 有 signal 参数，据此 gate = 既是正确语义、又根除污染。
> 2. **`persistenceFrozen` 是模块级单例，必须可 reset 且被 L1 守卫覆盖**——把 unfreeze 折进**既有** `clearAnthropicFeatureNegotiationForTests` / `resetAllLimitsForTesting`（它们已在 `tests/helpers/isolated-fixture.ts` 的 `RESETTERS` 表里、被 `tests/infra/resetters-complete.unit.test.ts` L1 守卫覆盖），**不新增** RESETTERS 条目——避开「新单例绕过命名约定守卫」的盲区（[[feedback-fix-all-comparison-sites]] 同类：新 module-global 必须登记）。

- [ ] **Step 1: 写失败测试（freeze 后 schedulePersist no-op；且仅 handoff 触发 freeze；且 reset 能解冻）**

```ts
// tests/restart/states-flush-freeze.it.test.ts
import { afterEach, expect, test } from "bun:test"
// 用 DI 注入临时 states 路径（skill test-isolation）+ spy atomicWriteJson 计数。
test("feature-negotiation: flushAndFreeze 后 schedulePersist 冻结为 no-op", async () => {
  // flushAndFreezePersistence() 后计数 +1（最后一次 flush）；之后多次 schedulePersist() → 计数不变
})
test("reset 解冻：clearAnthropicFeatureNegotiationForTests 后 schedulePersist 恢复写盘", async () => {
  // freeze → reset → schedulePersist 再次落盘（证 persistenceFrozen 被 reset 清回 false）
})
test("gracefulShutdown 普通信号(SIGINT)不 freeze、仅 handoff(SIGUSR2) freeze", async () => {
  // 调 gracefulShutdown("SIGINT") 后 schedulePersist 仍写盘（未冻结）；
  // 调 gracefulShutdown("SIGUSR2") 后 schedulePersist 冻结。
})
test("calibration: 同上三条（flush no-op / reset 解冻 / 仅 handoff freeze）", async () => {})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/restart/states-flush-freeze.it.test.ts`
Expected: FAIL（未实现）。

- [ ] **Step 3: 实现 flushAndFreezePersistence + reset 折入既有 resetter（两模块各一份）**

```ts
// feature-negotiation.ts / calibration/engine.ts 各自：
let persistenceFrozen = false

// 现有 schedulePersist 头部加：
export function schedulePersist(): void {
  if (persistenceFrozen) return // handoff 后冻结：学习落盘所有权已让给接管的新进程（M2）
  // ...原有 debounce 逻辑...
}

/** handoff（SIGUSR2）Phase 1：立即落最后一份快照，随后冻结后续写。never-throw。 */
export async function flushAndFreezePersistence(): Promise<void> {
  try {
    await persistNow() // 复用已有 serialized persist；清 debounce
  } catch (err) {
    consola.warn("[restart] states flush 失败（非致命）", err)
  } finally {
    persistenceFrozen = true
  }
}

// 折进【既有】的 ForTests resetter（不新增 RESETTERS 条目、L1 守卫自然覆盖）：
// feature-negotiation.ts 的 clearAnthropicFeatureNegotiationForTests() 内加一行：
//   persistenceFrozen = false
// calibration/engine.ts 的 resetAllLimitsForTesting() 内加一行：
//   persistenceFrozen = false
```

> 实现者注：① `persistNow()` 复用各模块已有 serialized-persist 原语（见 calibration engine.ts:267 注释）。② freeze flag 放在**所有** `schedulePersist` 汇聚的单一入口，别在 18 调用点各加。③ **unfreeze 必须折进既有 `clearAnthropicFeatureNegotiationForTests`/`resetAllLimitsForTesting`**（已在 RESETTERS 表），别新建 resetter——否则 L1 守卫（只抓 `*ForTest(s|ing)` 命名的**新增导出**）测不到这个隐藏单例。

- [ ] **Step 4: shutdown.ts Phase 1 —— 仅 handoff 信号调用**

`gracefulShutdown(signal, deps)` Phase 1（`stopTelemetryBackgroundWork()` 之后）：

```ts
import { flushAndFreezePersistence as freezeNegotiation } from "./anthropic/feature-negotiation"
import { flushAndFreezePersistence as freezeCalibration } from "./models/calibration/engine"

  // states.json flush-then-freeze —— 仅 handoff（有后继者接管学习）才做；普通关机无后继者、无需 freeze
  // （且普通关机 freeze 会污染测试里 28+ 处 gracefulShutdown("SIGINT"/"SIGTERM")——R2 BLOCKER-NEW-1）。
  if (signal === "SIGUSR2") {
    await Promise.allSettled([freezeNegotiation(), freezeCalibration()])
  }
```

> 注：`gracefulShutdown` 已 async，`await` 合法。`allSettled` 防一个 flush 失败阻断另一个。SIGUSR2 是三环境统一的 handoff 信号（裸手动新进程发 / systemd·pm2 脚本发），故这个 gate 对三路径都正确。

- [ ] **Step 5: 跑测试确认通过 + 既有 negotiation/calibration/shutdown 测试防回归 + 全量套件验无污染**

Run: `bun test tests/restart/states-flush-freeze.it.test.ts && bun test tests/anthropic/ -t negotiation && bun run test:backend`
Expected: PASS；**必须跑全量 `test:backend`**（非仅分文件）确认无跨文件污染——普通 shutdown 测试不再 freeze、negotiation/calibration 测试不受污染。

- [ ] **Step 6: Commit**

```bash
git add -- src/lib/anthropic/feature-negotiation.ts src/lib/models/calibration/engine.ts src/lib/shutdown.ts tests/restart/states-flush-freeze.it.test.ts
git commit -m "fix(shutdown): flush-then-freeze states.json only on handoff (SIGUSR2), reset via existing resetters"
```

---

## Phase 5：start.ts 全链路接线 + CLI/config

### Task 11: `--restart` flag + config `pidfile` 键

**Files:**
- Modify: `src/start.ts`（`start` 命令 args + knownArgs + RunServerOptions + runServer 调用）
- Modify: config schema + bundled `config.yaml`（可选 `pidfile`）
- Test: `tests/restart/cli-restart-flag.unit.test.ts`

**Interfaces:**
- Produces: `RunServerOptions.restart: boolean`；CLI `--restart`（默认 false）。

- [ ] **Step 1: 写失败测试（args 定义含 restart、knownArgs 含 restart）**

```ts
// tests/restart/cli-restart-flag.unit.test.ts
import { expect, test } from "bun:test"
import { start } from "../../src/start"

test("start 命令声明 --restart 布尔 flag（默认 false）", () => {
  expect(start.args?.restart).toMatchObject({ type: "boolean", default: false })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/restart/cli-restart-flag.unit.test.ts`
Expected: FAIL。

- [ ] **Step 3: 加 CLI flag + RunServerOptions 字段 + 透传**

`src/start.ts`：
- `RunServerOptions` 加 `restart: boolean`。
- `start` 的 `args` 加：
```ts
    restart: {
      type: "boolean",
      default: false,
      description: "零停机接管：若已有实例在跑，绑定同端口并向其发 SIGUSR2 交接（仅裸手动路径；systemd/pm2 由 supervisor 编排）。",
    },
```
- `knownArgs` Set 加 `"restart"`。
- `runServer({...})` 调用加 `restart: args.restart`。

config：schema 加可选 `pidfile?: string`（warn-continue，缺省用 `PATHS.PIDFILE`）；bundled config.yaml 加注释样例（默认注释掉）。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/restart/cli-restart-flag.unit.test.ts && bun run typecheck`
Expected: PASS + typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add -- src/start.ts src/lib/config/ config.yaml
git commit -m "feat(restart): --restart CLI flag + optional pidfile config key"
```

### Task 12: runServer 接线（guard→set 前任→写 pidfile→notifyReady→交接→退出清理）

**Files:**
- Modify: `src/start.ts`（`runServer`：Phase 0 校验后加 guard；Phase 5 listen 后加 notifyReady/交接；退出路径加 pidfile 清理）
- Test: `tests/restart/runserver-wiring.unit.test.ts`（对可抽出的纯逻辑做单测；全链路留 Phase 7 e2e）

**Interfaces:**
- Consumes: `detectSupervisor`/`isSupervised`、`decideStartup`/`signalPredecessorHandoff`、`setExcludedPredecessor`、`writePidfile`/`removePidfile`、`notifyReady`、`PATHS.PIDFILE`、`getProcessIdentity`。

**接线序（裸手动路径，isSupervised()===false 时）：**

```ts
// runServer 内，Phase 0 校验之后、Phase 1 之前（早于 initHistory！reclaim 要读寄存器）：
const pidfilePath = config.pidfile ?? PATHS.PIDFILE
let takeoverPredecessor: PidfileContent | null = null
if (!isSupervised()) {
  const decision = decideStartup({ pidfilePath, hasRestartFlag: options.restart })
  if (decision.kind === "refuse") {
    consola.error(
      `已有实例在运行（pid=${decision.predecessor.pid}, port=${decision.predecessor.port}）。` +
        `用 --restart 接管，或先停旧实例。`,
    )
    process.exit(1)
  }
  if (decision.kind === "takeover") {
    takeoverPredecessor = decision.predecessor
    // 关键：在 initHistory（reclaim）之前 set，使 reclaim 排除前任在途行。
    setExcludedPredecessor({ pid: decision.predecessor.pid, bootTime: decision.predecessor.bootTime })
    consola.info(`[restart] 接管模式：将在监听后向前任 pid=${decision.predecessor.pid} 发交接信号`)
  }
}

// ...（Phase 3 initHistory 时，connection.ts 的 reclaim 已读到寄存器）...

// Phase 5 listen 成功、setServerInstance 之后（写 pidfile：仅裸手动路径）：
if (!isSupervised()) {
  const id = getProcessIdentity()
  writePidfile(pidfilePath, { pid: id.pid, bootTime: id.bootTime, port: options.port })
}

// 就绪通知（三后端，各自按环境 no-op）：
notifyReady()
// 裸手动接管：现在才发交接信号（新进程已在监听，前任可安全停 accept）。
if (takeoverPredecessor) signalPredecessorHandoff(takeoverPredecessor.pid)

// ...（waitForShutdown 之后的 finally / 退出路径，清理 pidfile：仅裸手动路径）...
```

- [x] **Step 1: 写测试（把「接管序」关键不变量抽成可测纯函数或用注入 dep 的小测）**

对「decideStartup=refuse→exit(1)」「takeover→先 setExcludedPredecessor 再返回前任」这类可隔离逻辑，若 runServer 太大难单测，抽一个 `resolveManualStartup(pidfilePath, restart, isSupervised, deps)` 纯函数承载决策 + 副作用注入，对它单测：

```ts
// tests/restart/runserver-wiring.unit.test.ts
import { expect, mock, test } from "bun:test"
import { resolveManualStartup } from "../../src/lib/restart/takeover"

test("supervised 环境跳过 pidfile guard（返回 skip）", () => {
  const r = resolveManualStartup({ pidfilePath: "/x", restart: false, supervised: true })
  expect(r).toEqual({ kind: "skip" })
})
test("takeover 时先登记前任到寄存器", () => {
  // 注入 pidfile 读到 live 前任 → 期望 setExcludedPredecessor 被调 + 返回 takeover
})
```

> 实现者注：把 supervisor 分流 + decideStartup + setExcludedPredecessor 收进 `resolveManualStartup`（takeover.ts），返回 `ManualStartupResult`（= `StartupDecision | { kind: "skip" }`，见 Task 8 Interfaces——`"skip"` 是 supervisor 环境）。runServer 只调它 + 按返回 kind 做 exit(refuse)/记 predecessor(takeover)/直接继续(proceed|skip)。这样接管决策可完整单测，runServer 只剩 IO 编排（留 e2e）。术语与 Task 8 保持一致，勿新造第四态。

- [x] **Step 2: 跑测试确认失败 → 实现 resolveManualStartup → 通过**

Run: `bun test tests/restart/runserver-wiring.unit.test.ts`
Expected: 先 FAIL 后 PASS。

- [x] **Step 3: runServer 按上「接线序」接入 + 退出清理**

退出清理：在 `runServer` 末尾 `waitForShutdown()` 的 `finally`（`stopModelRefreshLoop()` 旁）加。**必须用 compare-and-delete（B2）**——接管后新进程已用自己的 pid 覆写同一 pidfile，无条件删会误删后继者的活 pidfile：

```ts
  } finally {
    stopModelRefreshLoop()
    if (!isSupervised()) {
      const id = getProcessIdentity()
      removePidfileIfOwnedBySelf(config.pidfile ?? PATHS.PIDFILE, { pid: id.pid, bootTime: id.bootTime })
    }
  }
```

并加一个 best-effort 兜底 `process.on("exit", () => { if (!isSupervised()) removePidfileIfOwnedBySelf(path, self) })`（同步、compare-and-delete，覆盖非优雅退出路径；同样绝不无条件删）。

- [x] **Step 4: typecheck + 既有 start/serve 测试防回归**

Run: `bun run typecheck && bun test tests/ -t serve`
Expected: 绿。（typecheck 剩基线既有 2 个 `item_id` 错误，与本 Task 无关，不新增；`test:backend` 剩既有 history UI 1 个基线失败，同样与本 Task 无关。）

- [x] **Step 5: Commit**

```bash
git add -- src/lib/restart/takeover.ts tests/restart/runserver-wiring.unit.test.ts
git commit -m "feat(restart): resolveManualStartup pure decision function (Task 12 Step 1-2)"
git add -- src/start.ts
git commit -m "feat(restart): wire takeover guard/pidfile/notifyReady/handoff into runServer"
```

**实施状态**：已完成（commit `47d5c29e` + `ef73b4cf`）。接线序与计划一致：`resolveManualStartup` 在 Phase 2.7（config 加载后、Phase 3 `initHistory` 之前）调用；pidfile 写入在 Phase 5 `setServerInstance` 之后；`notifyReady` + `signalPredecessorHandoff` 顺序不变；退出清理的 `finally` 与 `process.on("exit")` 兜底均用 `removePidfileIfOwnedBySelf`（compare-and-delete）。**2026-07-16 修订**：`takeover` 分支不再调 `setExcludedPredecessor`——该寄存器已退役，overlap 保护改按进程存活性裁决（见上 Phase 3 修订注）。

---

## Phase 6：整链路 e2e（裸手动接管）

### Task 13: 两进程真接管 e2e（非 4141 端口）

**Files:**
- Create: `tests/e2e/handover.e2e.test.ts`

**Interfaces:**
- Consumes: 整链路（spawn 真进程）。用 History API / HTTP 探针当 oracle。

**验收 oracle（lifecycle.md 目标）：**
1. 旧进程在非 4141 端口启动 → 起一个**慢请求**（占住在途，用 mock 上游或一个 sleep 端点）。
2. 新进程带 `--restart` 同端口启动 → 应成功绑定（reusePort）+ 向旧进程发 SIGUSR2。
3. 断言：接管后**新连接全部由新进程服务**（打健康端点，验响应来自新进程——用不同 `--ghc-api-base-url` 或进程 pid 标记区分）。
4. 断言：旧进程的**在途慢请求完成、不被中断**（drain），完成后旧进程退出。
5. 断言：旧进程在途请求的 history 行**未被新进程 reclaim 成 interrupted**（查 history.db，状态为 completed）。

- [x] **Step 1: 写 e2e（spawn 两进程，端口 41992，独立 history.db 临时目录）**

```ts
// tests/e2e/handover.e2e.test.ts —— 骨架，实现者补全 spawn/探针细节
import { afterAll, expect, test } from "bun:test"
// 复用 skill `client-proxy-e2e-testing` / `live-ghc-e2e-verification` 的 spawn+隔离骨架：
// - 两进程共用同一临时 APP_DIR（同一 history.db + pidfile），端口 41992
// - 旧进程用 mock 上游（skill upstream-hook-mocking）造一个可控慢响应占住在途
// - 新进程 --restart 启动，探针验证接管 + 旧进程 drain + reclaim 未误杀
test("裸手动接管：新进程接新连接、旧进程 drain 在途、reclaim 不误杀", async () => {
  // 1. spawn old on 41992 → 起慢请求
  // 2. spawn new --restart on 41992 → 等 new 的 notifyReady
  // 3. 打 41992 N 次 → 全部由 new 服务
  // 4. 等旧慢请求完成 → old 退出
  // 5. 查 history.db：旧在途行 status=completed（非 interrupted）
  expect(true).toBe(true) // 占位，实现者替换为真断言
})
```

> 实现者注：这是承重验收测试，务必用**正样本对照**先证探针能抓到「未接管」的坏情况（如不发 SIGUSR2 时旧进程仍接连接），再信绿。连跑 5 次证时序确定性（reusePort 分发 + drain 时序）。参考 skill `client-proxy-e2e-testing`（spawn 骨架）、`upstream-hook-mocking`（造慢响应）、`empirical-verification`（History API 当 oracle）。

- [x] **Step 2: 跑 e2e**

Run: `bun test tests/e2e/handover.e2e.test.ts`
Expected: PASS，连跑 5 次确定。

- [x] **Step 3: Commit**

```bash
git add -- tests/e2e/handover.e2e.test.ts
git commit -m "test(restart): end-to-end manual takeover handover e2e"
```

> **实施记录（2026-07-16）**：commit `1799da9c`（含 3 文件：`tests/e2e/handover.e2e.test.ts` + `tests/e2e/harness/{spawn-handover-proxy,handover-upstream-hook}.ts`，实际比计划骨架多拆两个 harness 模块）。5 条验收 oracle 全部实测 PASS（真 spawn 双进程 + 真 `Bun.serve({reusePort:true})` + 真 SIGUSR2，非 mock OS 原语；GHC 上游经 config-hook 全程 mock，零额度消耗）：
> 1. 旧进程非 4141 端口启动 + 慢请求在途 ✅（hook 按请求体 `SLOWMARKER` 子串 sleep 1.5s）
> 2. 新进程 `--restart` 同端口绑定成功 + 发 SIGUSR2 ✅（`resolveManualStartup`/`signalPredecessorHandoff` 真实链路，非 mock）
> 3. 接管后新连接全部落新进程 ✅（收敛式断言：reusePort overlap 窗口内允许瞬时命中旧进程/503/ECONNRESET——非 defect，短 poll 收敛到 100% NEW，符合 PoC 结论「关旧 listener 后新连接 100% 落新进程」）
> 4. 旧进程在途慢请求完成不受扰 + 旧进程随后自行退出 ✅（`process.kill(pid,0)` liveness 轮询确认）
> 5. 旧进程在途请求 history 行未被误 reclaim 成 interrupted、稳定为 completed ✅（`GET /history/api/entries?pid=<old>` 查询）
>
> **正样本对照**（未接管坏情况，empirical-verification 要求）：① 无 `--restart` 时第二实例走 `decideStartup` 的 refuse 分支 exit(1)，旧进程从未收到信号、继续以自身 pid 服务请求（专项验证，独立于主 e2e）；② 主 e2e 内置的「positive control」用例：单进程无接管场景下，探针 100% 命中自身 pid（证明探针本身有辨别力，非恒真断言）。
> **连跑确定性**：完整测试文件（positive control + 5 次 handover run）本次交付过程中连续跑 5 次全绿，另加多次单场景调试跑，0 例外。
> **承重踩坑**（均已写入两个 harness 文件的 header 注释）：
> a) `bun run ./src/main.ts`（+ volta bun shim）把真 server 包进父子进程树，`Subprocess.pid` 是 launcher 非真 server pid——用 `pgrep` 递归 child-walk 按 cmdline 含 `main.ts start --port <port>` 精确定位真 server pid（供 `process["pid"]` 标记比对 + 精确清理）。
> b) 两进程共享同一 `--port`，**不可用**既有 `spawn-proxy.ts` 的 `killByPort`（`pkill -f "...--port <port>"`）清理——会把接管中仍存活的旧进程一并误杀；改用按精确 PID kill（`SIGKILL` 目标 pid，never-throw）。
> c) hook 走 data-URL loader（`Bun.Transpiler`），**任意点号属性访问**（`foo.bar`）在 Bun 1.3.14 下会让具名导出静默丢失（比既有 skill `upstream-hook-mocking` 记录的「仅 JSON.stringify / 对象字面量触发」更宽——本次 bisect 新增证据），全文件改用方括号访问 `foo["bar"]` 规避。
> d) **反直觉发现**：两进程共享 reusePort 端口时，"旧进程专属 HTTP 探针"（如轮询旧进程 `/api/status` 等其 `shutdown.phase` 变化）不可信——内核按 fd 级负载均衡分发，同一 `baseURL` 的请求可能落到新进程（本次实测：轮询"旧进程"`/api/status` 15 次全显示 `phase:"idle"`，即便旧进程早已退出——因为连接实际全落在新进程上）。唯一无歧义的单进程 oracle 是 OS 级 `process.kill(pid, 0)` 存活检查，非 HTTP 层。
> e) `bun test` 运行时下，长驻子进程的 stdout/stderr `data` 事件（Bun `Subprocess.stdout` 异步迭代器 + Node `child_process` 均如此）从不触发（同一 API 对短命令/普通 shell 回显正常，仅长驻嵌套 bun 进程受影响）——弃用日志抓取式断言，改用行为层 HTTP/进程存活 oracle。
> **spawn 端口所有权验证**：每次 spawn 后用 `ss -ltnp` 核实监听 PID 确为本次 spawn 的进程（非 peer 泄漏），会话结束前确认 4141 未被触碰、测试端口范围（419xx）无残留监听。


---

## Phase 7：contrib 样例（systemd blue-green + pm2）

### Task 14: systemd 模板单元 + 换代脚本

**Files:**
- Create: `contrib/systemd/copilot-api@.service`
- Create: `contrib/systemd/copilot-api-deploy.sh`
- Create: `contrib/systemd/README.md`

- [ ] **Step 1: 写模板单元**

```ini
# contrib/systemd/copilot-api@.service
# blue-green 双槽模板：实例化为 copilot-api@a / copilot-api@b。
# 零停机换代靠 app 层 reusePort 接管（见 copilot-api-deploy.sh），非 socket activation。
[Unit]
Description=copilot-api (slot %i)
After=network.target

[Service]
Type=notify
# 用 bun 直连入口（非 `bun run`，否则 LISTEN_PID/notify 归属子进程混乱）
ExecStart=/usr/bin/bun /opt/copilot-api/src/main.ts start
# 交接时旧槽 drain 完 exit 0 → 不复活；仅真崩溃（非零退出）重启同色槽
Restart=on-failure
# 对齐 drain 宽限（shutdown.graceful_wait + abort_wait，默认 60+120=180s，留余量）
TimeoutStopSec=200
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: 写 A1+B1 无状态换代脚本**

```bash
#!/usr/bin/env bash
# contrib/systemd/copilot-api-deploy.sh —— A1 无状态发现活槽 + B1 脚本发交接信号
set -euo pipefail

# A1：现场问 systemd 运行态确定当前活槽（零 app 状态文件）
if systemctl is-active --quiet copilot-api@a; then CUR=a; else CUR=b; fi
NEXT=$([ "$CUR" = a ] && echo b || echo a)
echo "当前活槽=$CUR，换代到=$NEXT"

# 启新槽，阻塞到 READY=1（Type=notify + notifyReady）
systemctl start "copilot-api@$NEXT"

# B1：脚本发交接信号 → 旧槽停 accept + 4-phase drain
systemctl kill -s SIGUSR2 "copilot-api@$CUR"

# 旧槽 drain 完自行退出后，stop 仅收敛记账（幂等）
systemctl stop "copilot-api@$CUR"

# 翻转开机默认槽（enablement 符号链接，systemd 配置态）
systemctl disable "copilot-api@$CUR"
systemctl enable "copilot-api@$NEXT"
echo "换代完成：活槽=$NEXT"
```

- [ ] **Step 3: 写 README（安装 + 首次启动 + 换代用法 + 关键约束说明）**

README 覆盖：`ExecStart` 路径改法、首次 `systemctl enable --now copilot-api@a`、之后一律 `./copilot-api-deploy.sh` 换代、为何 `Restart=on-failure` 而非 `always`、为何不用 `bun run`。

- [ ] **Step 4: 语法校验（脚本 shellcheck + 单元文件 systemd-analyze verify 若可用）**

Run: `bash -n contrib/systemd/copilot-api-deploy.sh && systemd-analyze verify contrib/systemd/copilot-api@.service 2>&1 | head`
Expected: 无语法错误（systemd-analyze 对 ExecStart 路径不存在的 warning 可接受）。

- [ ] **Step 5: Commit**

```bash
git add -- contrib/systemd/
git commit -m "docs(restart): systemd blue-green template unit + stateless deploy script"
```

### Task 15: pm2 ecosystem 样例

**Files:**
- Create: `contrib/pm2/ecosystem.config.cjs`
- Create: `contrib/pm2/README.md`

- [ ] **Step 1: 写 ecosystem 配置**

```js
// contrib/pm2/ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "copilot-api",
      script: "src/main.ts",
      interpreter: "bun",
      args: "start",
      wait_ready: true, // 等 process.send('ready')（notifyReady 的 pm2 腿）
      listen_timeout: 30000,
      // 对齐 drain 宽限（graceful_wait + abort_wait），让优雅 drain 跑完
      kill_timeout: 200000,
      // pm2 stop/restart 发 SIGINT → 触发 4-phase drain
    },
  ],
}
```

- [ ] **Step 2: 写 README（零停机换代用法：起带 --restart 的第二实例接管，或 pm2 托管 + 手动 reusePort 换代）**

说明：pm2 原生 `reload` 在 fork 模式 = 重启（有间隙）；零停机走 `bun run start --restart` 由 pm2 托管的 reusePort 接管。

- [ ] **Step 3: 语法校验**

Run: `node -e "require('./contrib/pm2/ecosystem.config.cjs'); console.log('ok')"`
Expected: `ok`。

- [ ] **Step 4: Commit**

```bash
git add -- contrib/pm2/
git commit -m "docs(restart): pm2 ecosystem sample + zero-downtime reload guide"
```

---

## Phase 8：文档同步 + 收尾

### Task 16: lifecycle.md 状态转「现状」+ DESIGN.md 活的架构现状行

**Files:**
- Modify: `docs/lifecycle.md`（「优雅重启」节头部 `状态：设计（未实现）` → 现状描述）
- Modify: `docs/DESIGN.md`（活的架构现状表加优雅重启行 `[done]`）
- Modify: `docs/API.md`（若 `--restart` 需在 CLI/基础设施节记一笔）

- [ ] **Step 1: lifecycle.md 去掉「未实现」状态注、把设计语气改现状语气**

- [ ] **Step 2: DESIGN.md 活的架构现状表加行**

指向 `src/lib/restart/`、`docs/lifecycle.md`、本 plan；一句话概括机制。

- [ ] **Step 3: 跨文档 grep 验证**

Run: `grep -rn "优雅重启\|--restart\|reusePort\|src/lib/restart" docs/*.md | head`
Expected: lifecycle.md / DESIGN.md 引用一致、无悬空。

- [ ] **Step 4: 全量 typecheck + lint + 全测**

Run: `bun run typecheck && bun run lint:all && bun test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add -- docs/lifecycle.md docs/DESIGN.md docs/API.md
git commit -m "docs(restart): flip lifecycle.md to landed + DESIGN.md live-arch row"
```

### Task 17: 从 backlog 摘除已实现项（若适用）+ 更新记忆库

**Files:**
- Modify: `docs/todo/deferred-backlog.md`（persistence-service 条目保留——它是 deferred 选项、非本特性实现项，**不删**；仅确认触发条件描述仍准）
- 记忆库：为「reusePort 无条件常开 / pidfile guard 需环境判别否则打死 blue-green / telemetry rollup 才是并发真风险」等本特性硬教训按需补 stub。

- [ ] **Step 1: 复核 backlog persistence-service 条目仍准确（保留）**

- [ ] **Step 2: 按 skill `session-closeout` 走收尾五步（subagent audit / doc-sync / 归档 plan / 提炼教训 / 细粒度提交）**

- [ ] **Step 3: Commit**

```bash
git add -- docs/todo/deferred-backlog.md
git commit -m "docs(restart): reconcile backlog after graceful-restart landing"
```

---

## Self-Review（写完对照 spec）

**1. Spec coverage**（对照 lifecycle.md「优雅重启」各节，含 R1 修订）：
- 统一机制 reusePort + SIGUSR2 → Task 1, 2 ✅
- notifyReady 三后端（sd_notify 传输经 PoC 选型） → Task 0.5, 9 ✅
- 路径一裸手动 pidfile guard + 交接 + compare-and-delete 清理 → Task 5, 8, 11, 12, 13 ✅
- 路径二 systemd blue-green（A1+B1、`@a`/`@b`、零状态） → Task 14 ✅
- 路径三 pm2 → Task 15 ✅
- overlap ① reclaim 排除 live 前任 → Task 6, 7 ✅
- overlap ② telemetry rollup Phase 1 停 + 注销 config 订阅 → Task 10 ✅
- overlap ③ states.json flush-then-freeze → Task 10b ✅
- overlap ④ WAL → 无需改代码（WAL 现成）✅
- overlap ⑤ 接管跳过启动 VACUUM → Task 7b ✅
- 环境判别（guard 仅裸手动） → Task 3, 12 ✅
- PoC 门槛 ① reusePort 内核分发（fresh-connection） → Task 0 ✅
- PoC 门槛 ② sd_notify 传输选型 → Task 0.5 ✅
- 不采纳（socket activation 等） → 无实现任务（正确）✅

**2. Placeholder scan**：Task 7/7b/10b/12 Step 1 与 Task 13 e2e 的测试骨架标注了「实现者注」——这些是**需要真实库/spawn/dgram 的集成测试**，给了完整验收 oracle 与骨架但未逐行填 DB 插入/spawn/socket 细节（依赖既有 skill 骨架）。已显式标注为承重测试 + 正样本对照要求，非隐藏 TODO。可接受（细节强依赖运行时环境，计划给足 oracle 与方法）。

**3. Type consistency**：`PidfileContent`（pid/bootTime/port）跨 Task 5/8/12 一致；`StartupDecision` + `ManualStartupResult`（含 `skip`）跨 Task 8/12 显式定义、术语一致；`Supervisor` 跨 Task 3/12 一致；`getExcludedPredecessor` 跨 Task 6/7/7b 一致；`stopTelemetryBackgroundWork` 跨 Task 10 定义/调用一致；`removePidfileIfOwnedBySelf` 跨 Task 5/12 一致；`flushAndFreezePersistence` 跨 Task 10b 两模块 + shutdown.ts 一致。✅

**已知需实现者补全的集成细节**（非 placeholder，是运行时依赖）：Task 7/7b/10b/12/13 的 DB 插入 / 两进程 spawn / dgram server 骨架——复用现有 skill（client-proxy-e2e-testing / upstream-hook-mocking / test-isolation / empirical-verification）的既有基建。
