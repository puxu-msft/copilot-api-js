# ADR: 三档 shutdown 信号契约 —— 把「有界墙钟 + 干净 finalize」还回来

- **状态**：Accepted
- **日期**：2026-08-10
- **裁决人**：用户（本会话直接裁决）
- **相关**：推翻 [spec/2026-08-07-lossless-graceful-shutdown-drain.md](../spec/2026-08-07-lossless-graceful-shutdown-drain.md) 的**不变量 4**；[lifecycle.md](../lifecycle.md)「优雅关闭」「优雅重启」；skill `process-lifecycle-shutdown`；guard 处置记录 [tmp/2026-08-10-third-tier-signal-guard-dispositions.md](../tmp/2026-08-10-third-tier-signal-guard-dispositions.md)；同源 ADR [vacuum-gated-on-lock-contention](2026-08-10-vacuum-gated-on-lock-contention.md)

> **2026-08-11 事实订正（本裁决未被推翻，仅其引用的机制已改名／删除）。** 下文正文按当时状态写作，保留原样以存档；读者按现状对照时注意三点：
> ① `timeouts.request_deadline` 已改名为 `timeouts.client_request_deadline`，并新增了 attempt 作用域的 `timeouts.upstream_request_deadline`（烧完只中止一次上游尝试、不消耗 retry 预算）。所以正文「生产上是空的」那条**取决于运行实例是否设了新键**，须实测而非引用此处。
> ② 周期式 stale reaper 已删除（与 `client_request_deadline` 同量同动作、只是最坏晚约 1.33 倍）；正文「`abandonDrain` 走的是 stale reaper 与 `request_deadline` 已经在用的同一组原语」中，`reapInFlight()` + `fail()` 这组原语**依然是它**，只是今天 `reapInFlight()` 的唯一生产驱动者就是 `abandonDrain` 自己。
> ③ 正文第 45 行点名的「取消信号通道仍伪装成 timeout」这条**尚未闭合**：客户端可见文案已从自相矛盾的「stale-request reaper 0s」改成「operator-abandoned drain」，但 `CancellationCause` 标签仍写死 `stale-reaper`。因此正文那句 **「在那条闭合前，不得声称第二档的终态『绝不被读成 timeout』」仍然有效**。

## 背景

2026-08-07 的 incident 里，三个正常工作的长请求在同一秒被 `Server is shutting down` 杀掉——`graceful_wait` 到期后 shutdown 用进程级 `AbortSignal` 中止了所有剩余 operation。随后的无损排空改造（`04e6ecb1` / `c6a5f72c` / `d254d8ae`）删掉了 `shutdown.graceful_wait`、`shutdown.abort_wait` 与整套自动 abort 设施，并立下不变量：**shutdown 不以任何固定时间值终止 operation**。

这个方向是对的，且不应回退。**但它连带删掉了一个没人打算删的能力。**

旧的四步实现里，Step 2（等 `graceful_wait`）、Step 3（abort + 等 `abort_wait`）、Step 4（force close）**无论走哪条分支都会执行 `finalize()`**。也就是说旧行为提供了三个出口，其中一个是「**有界墙钟 + 干净持久化**」：最坏 180 秒后进程必定退出，且 History / Telemetry / Diagnostic 全部 flush 完成。

改造后只剩两个极端：

| 出口 | 墙钟 | 持久化 |
| --- | --- | --- |
| 首信号后等 drain | **无界** | 干净 |
| 第二信号 | 立即 | **全丢**（`process.exit` 跳过所有 barrier） |

中间那档没有了。而**优雅重启的快速切换恰好需要的就是中间那档**：接管时后继者已在服务，旧进程该体面退场，可它现在要么无限期滞留、要么以丢数据为代价强退。

放大这个缺口的两个事实：
- 运行实例的 `config.yaml` **没有设 `timeouts.request_deadline`**（默认 0 = 禁用），所以 spec 不变量 3 所依赖的「请求级 deadline 兜底」在生产上是空的；余下的 `response_header`(900s) 只管首字节前、`stream_idle`(600s) 只管帧间静默，一条持续产帧的长流没有上界。
- overlap 窗口的长度直接决定 `lifecycle.md`「overlap 共享状态安全」各条隐患的暴露面；drain 无界意味着 overlap 也无界，`lifecycle.md` 里「不保证链式重叠重启」从运维纪律问题变成默认会发生。

## 定夺

**信号契约从两档改为三档。界由操作者显式划，不由 shutdown 自行到期。**

| 档 | 触发 | 动作 |
| --- | --- | --- |
| 1 | idle 时首个 SIGINT / SIGTERM / SIGUSR2 | 停 ingress，**无界**等待已接纳 operation（**不变**） |
| 2 | 仍在等请求时的第二个终止信号 | 中止残余 in-flight，**但仍走完 finalize** |
| 3 | 第三个终止信号 | 立即 `process.exit`，不等任何 barrier（**原逃生舱语义不变**） |

### 1. 第二档用请求级原语，不复活进程级 AbortController

`abandonDrain` 走的是 stale reaper 与 `timeouts.request_deadline` **已经在用的同一组原语**——`ctx.reapInFlight()` 取消在飞上游、`ctx.fail()` 记终态。被 `d254d8ae` 删掉的 process-global `AbortController` / `getShutdownSignal()` **不复活**。

因此「只有请求级机制能终止请求」这条不变量**继续成立**：shutdown 仍不拥有 deadline，是**人**按了第二次。终态 attribution 打 `category: "shutdown"` / `code: "operator-abandoned-drain"`，在产生点标签化。

⚠️ **但这只修对了两条 provenance 通道中的一条。** `reapInFlight()` 目前**无参数**、内部写死 `cancellationAbortError("stale-reaper", ...)`（`src/lib/context/request.ts:1125`），消费者 `src/lib/error/forward.ts:573` 据此产出 **504「Request cancelled by our own clock (stale-request reaper …)」**。所以本轮实现里，`fail()` 的 attribution 不伪装成 timeout，**取消信号那条通道仍然伪装成 timeout**——客户端和日志看到的是后者。修复要动 `CancellationCause` 与 forward 分流表，超出本轮范围，已登记 `docs/todo/deferred-backlog.md`（同日条目）。**在那条闭合前，不得声称第二档的终态「绝不被读成 timeout」。**

`abandonDrain` 另有三个够不到的形态（lightweight operation、已 settled 仍在 finalizing 的 operation、drain 开始之前的 `stopping` 等待），逐条见 skill `process-lifecycle-shutdown` 的边界①②③；三者共同的出路都是第三档。

### 2. 第二档只在「还在等请求」的阶段生效（承重收窄）

判据是**当前在等什么**，不是「第几个信号」：

- `stopping` / `draining` —— 等的是**请求** → 第二档生效。
- `finalizing` / `notifying` / `failed` —— 等的是**持久化 barrier 本身**，那正是逃生舱要逃离的东西 → 第二个信号**仍然立即强退**，与原契约完全一致。

这条收窄保住了 `lifecycle.md`「第二信号一旦进入 JS handler，绝不再等待这些 barrier」的原则。**它有独立守护**：既有测试 `second signal during history finalization exits immediately` 未经修改仍然通过；把该收窄变异掉（`waitingOnRequests = true`）会让它变红。

### 3. 自动预算：可配，默认 0 = 无界（**尚未实现，见「状态」**）

用户裁决保留一个可配的自动放弃预算，但**默认关闭**，语义是「操作者预设的放弃点」而非「shutdown 拥有请求终止权」。默认 0 意味着不引入任何行为变化。

## 不采纳

| 方案 | 不采纳原因 |
| --- | --- |
| 恢复 `graceful_wait` / `abort_wait` | 正是 2026-08-07 incident 的成因——固定时间值预估不了模型耗时，只会移动误杀边界 |
| 只让 SIGUSR2（handoff）有界、SIGINT 无界 | spec 已否决过「按信号分裂契约」的对称方案；且操作者的意图与信号种类无关 |
| 把逃生舱整体后移一档 | 会让 `finalizing` 期的 Ctrl+C 也要按两次，直接违反「第二信号绝不等 barrier」 |
| 给 lightweight operation 造取消面 | 见下「已知边界」——不为一个尚未观测到的形态新造基础设施 |

## 已知边界（诚实记录，非遗漏）

1. **第二档够不到 lightweight operation**。`LightweightInFlightOperation`（`src/lib/context/lightweight-model-operation.ts:30`）是只读描述符，无取消面，故 count_tokens / embeddings 不被中止。它们按构造是短请求；真卡住时第三档仍是出路。
2. **第二档不保证 registry 一定清零**。若某 operation 已 logically failed 却仍占着 registry（`lifecycle.md` 记录过的长驻留形态），`fail()` 会被 settled 去重、`reapInFlight()` 也未必让它离开。此时仍需第三档；日志已显式告知下一步。

## 状态

- ✅ 三档信号：`src/lib/shutdown.ts`，unit（含双向变异对照）+ PTY（真实进程，`tier2Alive` 断言，连跑 3 次确定性）。
- ⛔ **可配自动预算尚未实现**——本轮未做，默认 0 意味着缺它不改变任何现有行为。按 `no-silently-cut-but-defer` 登记在 [todo/deferred-backlog.md](../todo/deferred-backlog.md)，等用户决定是否单独起一轮。
