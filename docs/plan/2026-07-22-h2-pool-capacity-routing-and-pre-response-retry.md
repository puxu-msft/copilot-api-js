# h2 连接池按容量选路 + pre-response 关闭可重试

> **实施状态**（2026-07-23，已实现）：计划获批 → 异模型对抗审查（HIGH-1 已修正）→ C1–C4 全部落地 → 合并态异模型审查（无 CRITICAL/HIGH，2 条 LOW 已处理）。全后端 `test:backend` **6170 pass 0 fail**、typecheck+lint 绿、idle-reap 时序 8×确定。C1/C2 已在 master；C3/C4/守卫修复/审查加固在分支 `feat/h2-pool-capacity-cap`（`.worktrees/h2-pool-cap`），**合并回 master 待并发 peer 的 `favor` WIP 先提交**（二者在 `state.ts` 的 `setUpstreamTransportConfig` union 单行碰撞，须 3-way 保留双字段）。
> - [x] C1 classify pre-response 可重试（决策 2）— 独立表 + 4 条守卫（master `b69a18fd`）
> - [x] C2 池重构（Map<origin,entry[]> + 预留 + 容量感知 pending，N=0 字节等价）（master `aa320228`）
> - [x] C3 启用 N（默认 1）+ 并发 .it 测试（`b5892380`）
> - [x] C4 idle-reap + `idle_session_timeout`（`3ff3781b`）+ 守卫修复（`640c728e`）+ 审查加固（`ea607777`）

## Context（为什么做这个改动）

一波网络事故（2026-07-22 20:39–20:40）：同一 pooled h2 session 上的 **4 条并发大请求**（`/v1/messages`，请求体 271KB–780KB）被上游一次**会话级 teardown** 一起打断。经 4141 History API 实测裁决（非凭错误串猜），两种形态：

| req | 模型 | `state` | upstream `status`/帧数 | dispatchReason | 形态 |
|---|---|---|---|---|---|
| 1429 | sonnet-5 | failed | **0** / **0 帧** | failed-open | pre-response 关闭 |
| 1430 | opus-4.8 | failed | **0** / **0 帧** | failed-open | pre-response 关闭 |
| 1433 | sonnet-5 | failed | **0** / **0 帧** | failed-open | pre-response 关闭 |
| 1431 | opus-4.8 | failed | — / **11 帧** | closed without message_stop | mid-stream 截断（走 L2 buffered-retry，本次不改） |

**根因**：单条多路复用 h2 session 承载全部并发流，上游边缘/LB 的会话级 drain（GOAWAY / 流上限收流）一次带走所有 in-flight 流。形态 A（3 条 pre-response 关闭）当前**不被判为可重试**（classify.ts 只认 `NGHTTP2_REFUSED_STREAM`），硬 FAIL。

### 第二波（22:09，实测复核）——带出三类 + 两点意外

| 类 | 例 | committed 200? | 时长 | 判读 |
|---|---|---|---|---|
| ② pre-commit 秒拒（3 条并发 opus） | 68/69/70 | **否** | 1.2–1.4s | **决策 1 blast-radius 实时复现**（3 条压同一死 session 被一起秒拒）；**决策 2 直接救得了**（commit 前 network-retry 重连） |
| ① 上游静默数分钟后死 | 57/58/63 | **是**（各 10–14 帧全 synthetic keepalive） | 126/164/206s | **新意外**：上游收下大请求后 0 帧干挂 2–3 分钟才 rstCode=0；已在 ~20s delayed-commit → **决策 2 救不了** |
| ③ mid-stream 截断 | 66/67 | 是（真实帧后截断） | 19–22s | 走 L2 buffered-retry（`↻` 记账），本次范围外 |

**实测钉死 commit 时机**：57/58/63 的 `durationMs − terminalError.offsetMs ≈ 20.1s`（offset 以 commit 为原点）= `streamCommitAfterSec=20` 处 commit。默认时序：`streamCommitAfterSec=20` < `responseHeaderTimeout=streamIdleTimeout=300`、`streamKeepalivePingSec=20`。

**由此暴露的设计张力**：~20s delayed-commit 会把一个**本可重试的 pre-response 失败**转成**不可重试的 post-commit 硬失败**——上游静默数分钟时，提前 commit=放弃重试机会。要让决策 2 在 commit 前救下 57/58/63，必须在「上游挂起（该重试）vs 慢首 token/长 thinking 静默（该等）」间区分，**这就是 commit 时机取舍** → 归**单独 spec**（用户裁决）。本计划不塞无法安全触发的半成品旋钮。

**目标产出**（用户已拍板两个决策）：
1. **消灭 blast radius**：h2 session 每条同一时刻并发流软上限 **N（默认 1）**，超过就用另一条 connection；原 session 的流 done 后仍可复用。→ 池从「每 origin 单 session」升为「每 origin 多 session、按容量选路」。
2. **pre-response rstCode=0 关闭无条件判为可重试**：复用 network-retry 腿，弱于 REFUSED_STREAM 但用户接受极小概率双执行。

## 决策记录

- **决策 1**：配置键 `upstream_transport.http2.*`，默认 N=1，**默认启用**。语义=「超 N 用另一条 connection、流释放后复用」（**非** retire-to-drain）。0 语义拟=不限并发（回退旧单 session 多路复用）。热重载改 N 绝不杀在飞流。
- **决策 2**：**无条件**启用（不加开关），保持 REFUSED_STREAM 严格边界不动、新增独立的 pre-response 可重试判定。**归因澄清（用户）**：连接已死（status=0、零帧），重连重发是给 client 交付任何可用响应的**唯一出路**、不是可权衡的「选项」；不重试只会「既（可能）扣了 quota、又没拿到响应」。极小概率下若 teardown 前那次上游已计量，会记为两次——这是**固有不可避免**、且 History/telemetry **如实记录**（不掩盖），`hasRetried` 闩限死额外尝试至多 1 次。**不是**「弱保证/接受双执行的取舍」。

## 实现设计

### A. 池数据结构：每 origin 多 session + 按容量选路

`sessions: Map<string, H2SessionEntry>` → `Map<string, H2SessionEntry[]>`。为保住现有 identity 守卫（`if (sessions.get(origin) === entry)`，:350/:354），引入两个 identity-preserving 助手：
- `addSessionEntry(entry)`：`(sessions.get(origin) ?? []).push(entry)`（新键先 set）。
- `removeSessionEntry(entry)`：splice 掉 `=== entry` 的元素；数组空则 `sessions.delete(origin)`。

**选路（同步）** `tryReserveLiveSession(origin, N)`：扫数组，跳过 `lifecycle!=="active"` / `session.closed||destroyed` / （N>0 时）`activeStreamCount >= N` 的 entry；在仍 `< N` 的合格 entry 里 **best-fit** 选 `activeStreamCount` 最高者（tie-break 取 MRU 保暖），把负载往少数 session 集中、让多余 session 尽快落 idle 被回收。命中即**同步** `activeStreamCount += 1`（RESERVE）后返回。**N=0 = 不限并发**：总复用第一条 live entry ⇒ 每 origin 恰一条 session，与今天单 session 多路复用**字节等价**（这是本键 0 的明确语义=回退旧行为）。

**`pending` connect 去重：改为容量感知，不删除**（reviewer HIGH-1 修正）。旧 `pending`（:105）的根本目的是**冷启动并发去重**——整段删除会使 N=0 下并发冷启动各自建 session、破坏「每 origin 恰一条」的字节等价。正确形状：**join 与否取决于 N**——
- **N=0（不限并发）**：冷启动 miss 时若有在飞 `pending` 创建则 `await` 它并在结果 entry 上 `activeStreamCount += 1`（reserve）。所有冷启动 caller 汇入同一条创建 ⇒ 恰一条 session、多路复用、与今天**真字节等价**。
- **N≥1（隔离）**：冷启动 miss 时**各自** `createAndAdmitBornReserved`（不 join）⇒ 每 caller 一条自己的 session、一流一连接，正是事故要的隔离。
- `pending` 始终按「create own」populate（identity-guarded `finally`：仅 `pending.get(origin)===p` 才 delete，杜绝旧 :276-282 的 stale-finally 误删）；join 分支仅 N=0 读取。N 是全局 config（每 caller 同值），不会并发混用 N=0/N≥1。

### B. reservation 竞态 → 真 cap（保住 exactly-once 减法）

根因：`getSession` 返回（:622）与 `request()` 自增（:656）之间的 async gap，N=1 时两个并发都看到 count=0 各自 request 到 2。修法：**「选中即同步预留」**——用预留取代 :656 的自增。**一次预留 = 一次 `activeStreamCount += 1`**，由最后持有它的那层恰好释放一次。

`acquireSession(origin, signal)`：① `tryReserveLiveSession` 命中 ⇒ 直接返回已预留 `{session, entry}`（瞬时无竞态）；② 未命中 ⇒ **N=0 且有在飞 `pending`：`await` 它 + 在结果 entry 上 reserve**（容量感知去重，见 A 节）；否则 `entry = await createAndAdmitBornReserved(origin)`（**出生即预留**，`activeStreamCount` 从 1 起，在 epoch/generation 两检查**通过之后**才建预留 ⇒ 两个自毁/重试分支 :296-303 / :313-319 都在预留存在前、不泄漏计数；shutdown-epoch 分支改成 throw 而非返回死的已预留 entry），之后 `if (signal?.aborted) { releaseReservation(entry); throw abortError() }`。

`runHttp2Fetch`（替换 :622 + :654-668）用 `transferred` 标志 + `finally` 兜底，三路径穷举各恰好一次：
```
const { session, entry } = await raceAbort(acquireSession(origin, signal), signal) // 已预留
let transferred = false
try {
  if (signal?.aborted) throw abortError()          // PATH 2：request 前 abort → finally 释放
  return new Promise((resolve, reject) => {
    const req = session.request(headers)            // PATH 3：request() 抛错 → reject，transferred 仍 false → finally 释放
    transferred = true                              // 流已接管预留
    req.once("close", () => { entry.activeStreamCount -= 1; maybeReclaim(entry);
                              init.onStreamClosed?.(); resolveRequestClosed() })  // PATH 1：Node 保证单次 close 释放
    ...现有 executor 其余不变...
  })
} finally { if (!transferred) releaseReservation(entry) }
```
`sessionEntryByHttp2Session` WeakMap（:104/:347/:654）可删——entry 现直接串下去（已核实仅 http2-client.ts 内部用）。

### C. idle session 生命周期（镜像 WS 池）

N=1 峰值并发 C ⇒ C 条 session，峰值散去 C-1 条 idle。**镜像已存在的 WS 池 idle-reap**（真实先例在 `src/lib/openai/upstream-ws*.ts`，由 `state.pooledConnectionIdleTimeout` 驱动——**注：Plan agent 原写的 `transport/upstream-ws.ts` 路径有误，实际在 `openai/`**）：
- 新**专用**键 `upstream_transport.http2.idle_session_timeout`（秒，0=永不），让 h2/WS 各自独立调。proxy.ts 加 `getUpstreamH2IdleSessionTimeoutMs()` fresh-read。
- `H2SessionEntry` 加 `idleTimer?`。`activeStreamCount → 0` 时武装 `unref`'d 计时器；触发时若仍 `count===0 && lifecycle==="active"` 则 `session.close()`（dispose 负责移除）。任何预留时 `clearTimeout(idleTimer)`。
- **idle-reap 与 retiring/maybeReclaim 不重叠**（reviewer 预告项）：idle-reap **只**管 `lifecycle==="active"` 的空闲 entry；`retiring` 的空闲 entry 走既有 `maybeReclaimRetiringSession`（release 里已调用）——两条生命周期路径互斥（active↔retiring 单向），不会双重 close。retire 发生时若 entry 有 idleTimer 需 `clearTimeout`（移交给 maybeReclaim 语义）。
- 推荐 idle-reap 为主（避 fd 泄漏、重连便宜、WS 已验证）；否掉「全留靠 unref」（长 idle 泄 fd）与「纯 eager-close」（突发抖动重连）。
- **总 per-origin cap 暂不做**（open Q4）：实测约 4 并发、fd 成本可忽略，idle-reap 收敛长尾；仅在病态 fan-out 才需，留 backlog。

### D. 与既有机器交互（逐不变量，`sessions` 全部 8 处）

| 位置 | 改动 | 保住的不变量 |
|---|---|---|
| :96 声明 | `→ entry[]` | — |
| :269 快路径 | `→ tryReserveLiveSession` | — |
| :350/:354 dispose/retire 删 | `→ removeSessionEntry` | identity 守卫 |
| :364 set | `→ addSessionEntry` | — |
| :462 reconcile 遍历 | 遍历展平后 entry（active→retiring、数组清空） | **热重载不杀在飞流**；N fresh-read 只影响后续选路 |
| :510 status | 展平数组 | **`H2SessionStatusRow` 形状不变**（status-snapshot.ts 是 P4-README-locked 消费者） |
| :803 close | 展平 + `sessions.clear()` | epoch bump 不变 |

- generation/epoch 竞态循环、retire/dispose/pingTimer 拆分、`maybeReclaimRetiringSession` **原封不动**（现在同 origin 多条各自可独立 retire，`retiringSessions` 本就是 Set，按 entry 成立）。
- 新键 N + idle_session_timeout 加进 `setUpstreamTransportConfig` 的 tracked 字段，走 `onUpstreamTransportChange` 热重载（改 N 绝不碰在飞流）。

### E. 决策 2：classify（REFUSED 严格边界一字不改）

`HTTP2_RETRYABLE_MESSAGE_TOKENS = ["NGHTTP2_REFUSED_STREAM"]` 与 `isRetryableHttp2StreamError` **不动**（协议保证零处理那一类）。新增**独立**判定，单列自成一表（语义与 REFUSED 不同：REFUSED 有协议保证、这条是「连接已死、重连是唯一出路」），绝不混入 REFUSED 表：
```
// 连接在收到任何响应头前死亡（status=0、零帧）。重连重发是给 client 交付
// 可用响应的唯一出路——不重试只会「既可能已扣 quota、又零响应」。若 teardown 前
// 上游已计量，会记两次(固有不可避免，History/telemetry 如实记录不掩盖)；
// network-retry hasRetried 闩 → 额外尝试至多 1 次（已核实）。
// 仅在 !headersReceived 的 close backstop（http2-client.ts:791）产生。
const HTTP2_PRE_RESPONSE_RETRYABLE_TOKENS = ["upstream stream closed before any response"]
function isRetryablePreResponseHttp2Close(error): boolean  // 子串(大小写无关) + cause 递归
```
在 `classifyError` 里接独立分支（`isRetryableHttp2StreamError` 之后）→ `type:"network_error"`（复用 network-retry，cap=1）。**子串唯一性已核实**：与 mid-body `closed before end`（:754，post-headers、必须仍作 body-stream error）、形态 B `truncated: closed without message_stop`（走 L2 buffered-retry）**均不相交**。

**决策 2 的作用边界（第二波实测澄清、必须写进注释+守卫）**：network-retry 只能在**流尚未 commit**（message_start 未发给客户端）时重连重发。故决策 2 覆盖 **pre-commit 的 pre-response 失败**（如 68/69/70，秒级、`committed=false`）；对 **post-commit**（delayed-commit 已在 ~20s 触发、如 57/58/63）无能为力——message_start 已送出、流式协议已 commit，只能走 error-shaping 补合成 error（CC 对 200+SSE-error 零重试）。这不是缺陷、是流式协议固有；把「让长静默在 commit 前被救」提前触发，依赖「慢 vs 挂」区分策略 → 归单独 spec（G 节）。

### G. 上游静默数分钟型退化（第二波带出，纳入本计划的可安全落地部分）

用户裁决：**纳入本计划**（机制），但 commit 时机取舍**另开 spec**。二者调和——本计划做**不需要动 commit 时机、即安全**的部分：
- **决策 1 对它无效**（非 blast-radius，是上游单请求退化），**决策 2 对已 commit 的它也无效**（上如）——如实记录，不假装治好。
- 本计划落地：把「上游静默数分钟」作为**一等驱动场景**记进设计与测试意图（现有 delayed-commit + keepalive 已能撑住 CC 不早断，这条链保持 retry-ready、不被池重构破坏）；classify 决策 2 让其中 **pre-commit 变体**（秒级 pre-response，如 68/69/70）被救。
- **不做**：任何需要重排 commit/header-wait 相对时序、或需区分「慢首 token vs 上游挂起」的旋钮——那会无法安全触发（误伤长 thinking/慢首 token）。
- **出口**：
  - 「commit 时机 vs 重试机会」深层取舍（delayed-commit 该推多远、post-commit 续写救援、慢 vs 挂区分探测）→ **单独 spec**（`docs/spec/`，可能与 `feat/continuation-retry` 分支相关），本计划只注明边界不预设结论。
  - 若观察确认「上游静默数分钟」是持续退化而非一时抱态 → 另在 `docs/todo/deferred-backlog.md` 记根因场景（含 History 取证 req_57/58/63）。

### F. Commit 拆分（每 commit 终态自洽、中间态不半坏）

- **C1（classify，决策 2）**：pre-response 可重试表 + 判定 + 分支 + 守卫测试。**独立于池改动、立刻兑现硬 FAIL→可重试收益**。不变量：REFUSED 表字节不变；形态 B/mid-body 不被重分类。
- **C2（池重构、行为保持）**：`Map<origin, entry[]>` + add/remove 助手 + 预留模型 + exactly-once 释放 + **容量感知 `pending`（N=0 join）**，**N 实质无限**。不变量：N=0 ⇒ 每 origin 一条 session、与今天字节等价（**含并发冷启动**——靠 join，非删 pending；风险重构隔离在无行为翻转的 commit）。
- **C3（启用 N，默认 1）**：schema 键（`max_concurrent_streams_per_session`，0=无限）+ state 字段 + getter + config.ts 接线 + tracked + 默认 1 + 并发 .it 测试。
- **C4（idle 生命周期）**：idle-reap 计时器 + `idle_session_timeout` 键 + status/reconcile/close 集成 + 测试。C3→C4 间 idle session 滞留但 `unref`'d（非半坏）；若连瞬态 idle fd 都不可接受则并进 C3。

## 涉及文件（已定位核实）

- `src/lib/transport/http2-client.ts` —— 池核心（`sessions` 8 处 + `getSession`/`runHttp2Fetch` 记账 + reconcile/status/close）。
- `src/lib/error/classify.ts` —— 新增 pre-response 独立判定（决策 2）。
- `src/lib/config/schema.ts` —— `UpstreamTransportHttp2ConfigSchema` 加 `max_concurrent_streams_per_session` + `idle_session_timeout`。
- `src/lib/state.ts` + `src/lib/config/config.ts` + `src/lib/proxy.ts` —— 新键 state 字段/tracked/notify + getter + 接线（mirror `getUpstreamH2PingIntervalMs`）。
- `src/lib/transport/status-snapshot.ts` —— **仅核实契约**：`h2Sessions: [...getH2SessionStatusSnapshot()]` 形状不变，无需改。
- 测试：`tests/transport/http2-client.it.test.ts`、`tests/infra/error.unit.test.ts`。

## Verification

- **Unit**：classify 边界四条（pre-response→network_error；形态 B / mid-body `before end` **不**匹配；REFUSED/CANCEL/INTERNAL 分类不变）；`tryReserveLiveSession` + N=1 cap（同 origin 两次同步 acquire ⇒ 第二次新建，status snapshot 断言 `activeStreamCount` 从不 > N）；exactly-once 减法（驱动 PATH1/2/3、每次回 0，PATH3 用 `session.request` 抛错的 factory）；**epoch/generation 自毁分支净变化=0**（reviewer MEDIUM：注入一个在 epoch/generation 检查处触发自毁的 factory，断言 `activeStreamCount` 无残留预留——锁「预留在检查后创建」这条实现纪律不变量）；**N=0 并发冷启动等价**（reviewer HIGH-1：同 origin ≥2 并发首请求 ⇒ 恰建 **1** 条 session，非多条——锁容量感知 `pending` join）。
- **.it**（本地 h2c server，复用现夹具）：N=1 四条并发 ⇒ 4 个不同 server session；**在飞行中轮询** status 证峰值 `activeStreamCount ≤ 1`（事后查=false green，见 skill `catching-false-green-tests`）；destroy **一条** server session ⇒ 只它的流失败、sibling 完成；idle-reap（短 timeout，busy 不被回收）；热重载改 N 在飞流存活。
- **Node http2 夹具**（Bun server 不发忠实 RST，见 `exp/http2-refused-retry/`）：server 响应前 `session.destroy()` ⇒ reject `"closed before any response"` → classify network_error → messages handler 新 session 重试 1 次。两 runtime 实测确认「bare close rstCode=0」现身形态。
- **决策 2 commit 边界**（第二波实测驱动）：验证 pre-response network-retry 只在 **pre-commit** 的 reactive-retry attempt 循环内触发（由 handler-v4 的循环相对 commit 点的位置**结构保证**）——post-commit（delayed-commit 已发 message_start）的 pre-response 关闭走 error-shaping、**不**进 retry 循环。用一个「上游延后 >`streamCommitAfterSec` 才 rstCode=0 关闭」的 mock 断言：已 commit → 客户端收 message_start + 合成 error、无第二次上游 attempt；未 commit → 新 session 重试。
- **门**：`bun run typecheck` + `bun run lint:all` + `bun run test:backend`（交付档）；连跑并发/idle 时序测试 10–25 次证确定性。
- **live GHC e2e**（靶向、可选）：skill `live-ghc-e2e-verification` 起隔离测试服务器，真请求确认 N=1 下多 session 路由 + 真帧真计费无回归。

## 已核实的 load-bearing 事实（非推断）

- network-retry `hasRetried` 闩 → 决策 2 双计费**至多 1 次**（[network-retry.ts:35](src/lib/request/strategies/network-retry.ts#L35)）。
- classify 子串唯一（2 处不同站点不同串）。
- WeakMap `sessionEntryByHttp2Session` 仅内部用（可删）。
- WS idle-reap 先例真实（`src/lib/openai/upstream-ws*.ts`，非 plan 原写的 `transport/`）。
- status-snapshot.ts 是 `H2SessionStatusRow` 的 P4-locked 消费者（形状须保）。

## 开放问题（已按 invariant/合理默认裁决，非用户偏好分叉）

1. 去 `pending` connect 去重：对 N=1 正确且最优；N>1 冷突发过量建连随后被 idle-reap 收敛 → **接受**。
2. 冷 connect abort 不再瞬时（完整 await caller-owned connect，复用路径仍瞬时，`session_connect_timeout` 兜底）→ **接受**。
3. idle 键专用 vs 复用 WS → **专用**（h2/WS 独立调）。
4. 总 per-origin cap → **暂不做**，只靠 idle-reap，留 backlog。
5. N=0=不限并发=回退旧多路复用 → 采纳。
6. 决策 2 归因：**重连是唯一出路、非取舍**（连接已死则不重试=零交付）；沉没账与重试无关；如记双次则如实记录。cap=1 已核实（hasRetried 闩）。

## 异模型 reviewer 处置（gpt-souls:reviewer，网络三挂后 resume，报告 §3 后被截断、经落盘 `/tmp/h2-plan-review.md` 抢救）

- **reservation exactly-once：判定自洽、无 leak/double-decrement**（三路径 + raceAbort 只弃等待不取消底层 promise + executor 内抛错 `transferred` 仍 false 均核过）。→ 采纳，无需改设计。
- **MEDIUM「预留在 epoch/generation 检查后创建」是纯实现纪律不变量**：已补专门单测（Verification 新增「自毁分支净变化=0」）。
- **HIGH-1「N=0 字节等价」原方案有反例**（删 `pending` 破坏冷启动去重）：已修正为**容量感知 `pending`（N=0 join / N≥1 各自建）**，两个不变量都真成立；已补「N=0 并发冷启动恰建 1 条」单测。
- **报告被网络截断的尾部 LOW/MED 预告项**（idle-reap↔maybeReclaim 整合、reconcile 展平测试缺口、MRU tie-break 机制、过期注释清理）：idle-reap↔retiring 互斥已在 C 节钉清；reconcile 展平 + status 形状测试列入 `.it`；MRU=best-fit 选 `activeStreamCount` 最高者、tie 取数组末位（实现细节，非设计分叉）；过期注释归实现期清理。**未 resume 补审**（三次网络挂 + 全量重读成本过高，承重两项已获，尾部为 polish、我已逐条预处理）——实现落地后由**合并态 review** 兜底覆盖这些集成缝。
