# Spec：上游 pre-response 静默与 delayed-commit 时机 —— A（挂起）vs B（长思考）判别问题

- **状态：已接受，部分实施。** architect-advisor 产出 → 异模型对抗审（gpt-souls:reviewer，2026-07-23，4 HIGH 已订正）→ Q5 直读实测闭合（2026-07-23，见 §0 ✅ / §3）。direct Anthropic live B2 已实现：pre-ready delayed-commit、ready transport close 和 ready clean EOF before `message_stop`；buffered B2 与 translated publication 仍 deferred、fail-closed。backend gate 已通过，最终验证状态见 [Task 4.3b 报告](../plan/2026-07-23-upstream-silence-recovery/task-4.3b-implementation-report.md)。核心假设「等 header 判别」现已由直读 `upstreamHeadersAt` **实测证伪**（34 条正样本、header@47-231s ∩ success）。B2 主线既凭「commit 后失去内部恢复能力」的架构问题独立成立、又有实测支撑。Q2 事故类 fresh-retry 对真实 GHC 的效力、Q3 Responses 路径 header 时序和 Q8 GHC pre-content 状态面仍未验证，故不能将离线实现覆盖表述为事故根治结论。
- **日期：** 2026-07-23
- **Owner：** 排查会话（起于第二波事故 req_57/58/63 —— 0 帧干挂 126/164/206 秒后 rstCode=0，用户等 2-3 分钟拿硬失败）
- **前身 / 相关：**
  - [docs/spec/2026-07-08-buffered-keepalive-empty-text-anchor.md](2026-07-08-buffered-keepalive-empty-text-anchor.md)（§10 无条件 timeout-safe keepalive；其 §2「record-not-adopted」已否过一次「上游 stall 快检提前 retry」）。
  - [docs/decisions/2026-07-09-unconditional-keepalive-timeout-safety.md](../decisions/2026-07-09-unconditional-keepalive-timeout-safety.md)（CC 两层 watchdog + 合成 message_start 兜底）。
  - `feat/continuation-retry` 分支（首块 commit 后 mid-stream cut 的续写救援 —— **post-commit + post-content**；本 spec 是 **pre-content**，二者互补，见 §7）。
  - skill `debugging-claude-client-connection`（CC 两层 watchdog + 事后判别 client-abort/reaper/header-timeout）。
- **相关 ADR（价值轴）：** long-termism-wins、richest-data-flow、internal-tool-security-posture。本 spec 判据轴 = **长远正确 + 完整 + 不误伤合法长思考**，不是 ROI/YAGNI。

---

## 0. TL;DR（先说结论，因为它反直觉）

任务交办时提出的关键假设是：**「上游是否已发送 200 响应头」可作为 A（该重试的挂起）vs B（该等的长思考）的判别信号** —— A 的 `status=0`（从未发头），B 应先发 200 头再慢慢流 content。

**这个假设已实测证伪（见下方 ✅ 与 §3）** —— GHC 上游对 heavy-thinking 请求存在一种 **deferred-header（延迟响应头）模式**：思考在上游侧算完之前，**连 200 响应头都不发**，思考结束后才把 `响应头 + message_start + 整段内容` 一次性突发出来。

**✅ 证据口径（2026-07-23 Q5 直读实测闭合，对抗审 HIGH-1/2 已解）：** 早前草案的 header 到达时刻是**从 SSE offset 反推**（`durationMs − max(offsetMs)`、系统性偏晚、对「是否 > 20s」非决定性），且「首帧 synthetic」不足以严格证明走 commit 分支——这两处 caveat **现已闭合**。`upstreamHeadersAt` 四刻绝对时刻的 REST 投影已 landed（`projection.ts:277-283`，早前草案说的「未导出 `projection.ts:267-277`」已过时）。据此对 4141 主服务器 History 做**只读**直读分析（未碰主进程、零额度），在 300 条采样、108 条 streaming heavy-thinking 候选中拿到 **34 条正样本**：`upstreamHeadersAt − startedAt > 20s ∩ responseSuccess=true`，header 直读到达延迟高达 **47s / 75s / 92s / 198s / 219s / 231s**。抽查其 clientResponse 首帧全为 `ping` + `synthetic:"keepalive"` 标记（走 COMMIT 分支的签名）；且**逻辑气密**——header 直读 > 20s 窗口 ⟹ `Promise.race([p, 20s])` 必走 COMMIT 分支（settled-within-window 路径要求 header <20s、被直接排除，故不再依赖「首帧 synthetic」这条弱推断）。**结论从「强线索」升为「实测结论」：** 在 20s（乃至更久）commit 时刻，合法 heavy-thinking（deferred-header，header@47-231s）与真正挂起（A，status=0 永不发头）的可观测状态**完全相同**。持久化 `delayedCommit/commitAt` verdict（§8 Q5 part ②）在证据上**已非必需**（header 直读 > 窗口即证 commit 分支），仅作未来零推断查询的可选增量。分析脚本与样本见本会话记录。

**但本 spec 的架构主张不依赖这段证据的终验**（对抗审建议的两论证拆分）：无论 A/B 在 20s 是否可分类，**「commit 后我方只发了合成脚手架、零真实 assistant 内容，却因流式协议不可逆而失去内部恢复能力」本身就是一个架构缺陷**。真正长远正确的方向不是找更好的判别信号，而是**移除 commit 的不可逆性**：只要能在合成脚手架之后「拼接」一次全新上游尝试的真实内容，那么「20s 早提交」就不再是重试的终点、只是 HTTP 状态码的终点（保持 200 无害）。判别问题随之消解 —— 不再需要在 20s 分辨 A/B。

下文 §3 给实证，§5 穷举候选方案，§6 给推荐与理由，§8 列需用户拍板的分叉。

---

## 1. 问题陈述（实测数据）

### 1.1 事故形态（第二波 req_57/58/63，经 4141 History API 实测，判据轴已交办、不推翻）

- 上游收下大请求（261-678KB）后 **0 帧干挂 126/164/206 秒**，最终被 `rstCode=0` 关闭（`attempts[0].upstreamResponse.status=0`、`sseEvents=[]` —— 连响应头都没回）。
- 我方在 **~20 秒**（`streamCommitAfterSec=20`）已 delayed-commit 200 给客户端（clientResponse 仅 10-14 帧、全是 synthetic keepalive：message_start + 空 content_block_delta + 末尾 synthetic error）。
- 一旦 commit（message_start 已发给客户端），流式协议已提交、**无法 un-send 去重试**，只能补合成 error。CC 对 `200 + SSE-error` 零重试。用户等 2-3 分钟拿硬失败。
- 实测钉死时序：57/58/63 的 `durationMs − terminalError.offsetMs ≈ 20.1s`（terminalError.offsetMs 以 commit 为原点）= 恰在 `streamCommitAfterSec=20` 处 commit。

### 1.2 决策 1/2 为何救不了

- 决策 1（keepalive 无条件 timeout-safe）解决的是**已 commit 之后**客户端不被 CC 两层 watchdog 断连 —— 它让 commit 之后的干挂不至于额外触发 CC 300s 断，但它**不改变 commit 本身**。
- 决策 2（pre-commit network-retry）只能在 **commit 之前**保住原生 HTTP 状态、让客户端原生重试。但事故的 RST 在 126-206s、远晚于 20s commit —— commit 已发生，决策 2 的窗口早关。

---

## 2. 现有机制的代码实证（commit 决策链）

> 本节全部为 **代码实证**（读源码 + 类型），非推断。file:line 均已核对。

### 2.1 delayed-commit 是「等 `p` settle」与「20s 定时器」的竞速

`src/routes/messages/handler-v4.ts:537-554`：流式 Anthropic 请求走
```
first = await Promise.race([ p.then(()=>"upstream"), windowFired(20s) ])
if (first === "upstream") → runUpstreamSettledPath()   // 转发真实 HTTP 状态，保native retry
else                       → COMMIT: 200 + keepalive    // 合成脚手架，post-commit 只能补 SSE error
```
其中 `p = driver.runRequest(...)`（`handler-v4.ts:426`），窗口 = 从**请求 ingress** 起算的 deadline（`state.streamCommitAfterSec * 1000` 减去 pre-handler 已耗时；默认 **180**，clamp 上限 `COMMIT_WINDOW_MAX_SEC = 240`）。**注**：本段原写「默认 20，schema clamp < 60」，2026-07-28 起已不成立。

### 2.2 `p`（runRequest）在**上游响应头到达**时 resolve —— 而非首帧、非 message_stop

链路：`runRequest`（`driver.ts:311-372`）→ `coordinator.runPrimary()`（`coordinator.ts:119-123`）→ `start`（`coordinator.ts:93-114`，`await runtime.run()`）→ `candidate.run()`（`candidate.ts:89-113`，`await scheduler.run(...)` 返回 `ready.upstream`）→ `dispatch-scheduler.ts:205` `response = await input.open(wire,...)` → 物理传输 open。

h2 传输的 open 在 **`req.once("response")`**（响应头帧到达）时 `resolve(new Response(body, {status, headers}))`（`http2-client.ts:864-945`）。body 是懒消费的 ReadableStream。故：

> **`p` 在上游 200 响应头到达时 resolve（经内部 reactive-retry 循环后）。** 因此 **「走 COMMIT 分支」⟺「20s 内上游响应头未到达」**，**「走 settled-within-window 分支」⟺「20s 内响应头已到达」**。

（细微点：scheduler 的 reactive-retry 循环基于**状态码**重试 —— 但对「静默无状态码」的挂起/思考，无状态码可判、不触发 pre-header retry，故 `p` 的 resolve ≈ 首次成功响应头到达。）

### 2.3 header-timeout（300s）vs commit 窗口（20s）的关系

`responseHeaderTimeout` 默认 300s（`state.ts:1994`），是 undici headersTimeout + app-guard（`proxy.ts:133` / `timeout-resolver.ts`）。commit 窗口 20s **远早于** header-timeout 300s，且二者**正交**：commit 不依赖响应头（COMMIT 分支注释 `handler-v4.ts:556-560` 明说 200 在上游 settle 之前 flush、无法转发上游头）。事故 RST 在 126-206s 先于 300s header-timeout 触发 —— GHC 网关自己的 RST 打赢了我方 300s backstop。

### 2.4 hedge 只在 **post-header** 触发 —— 对 pre-header 干挂无效

`maybeRunHedgedResponseSink`（`driver.ts:769-804`）需要 `binding = runtime.bindings.get(upstream)` —— `upstream` 是**已 resolve 的响应**。即 hedge racing 发生在响应头到达**之后**。pre-header 阶段无 hedge。（`generationHedgeEnabled` 默认 true，threshold 300s，`state.ts:1943-1944`。）

---

## 3. 关键假设的实测证伪（本 spec 的枢纽发现）

> 数据源 = 运行中的 4141 主服务器 History REST API（`GET /history/api/entries` + `/entries/:id`，只读、未碰主服务器）。取样 = 近 500 条 generation，聚焦 streaming `anthropic-messages`。**这是 History 实测，非推断。**

### 3.1 offset 基准（代码实证）

上游 `sseEvents[i].offsetMs` 的基准 = 该 attempt 的上游帧采集锚点（首个观测到的上游帧 ≈ 响应头到达时刻）—— `upstream-stream-diagnostics.ts:93` `offsetMs = Date.now() - startedAtMs`。故一条请求的**响应头到达时刻 ≈ `durationMs − max(upstream_offset)`**（末帧 message_stop 的 offset ≈ 整个上游流的跨度）。更强的直接判据：**走 COMMIT 分支（clientResponse 首帧 `synthetic:"keepalive"`）⟺ 上游响应头在 20s 内未到达**（§2.2）。

### 3.2 GHC Anthropic 有两种 header 时序模式（实测）

| 模式 | 特征 | 实例（req_id / dur / header 到达 / commit?） |
|---|---|---|
| **Mode 1 增量流** | 响应头**早到**（<20s），thinking 作为 content_block_delta **增量上线** | req_..._138（dur 130s，header@25ms，settled）、req_..._125（dur 69s，header@3ms，settled）、req_..._222（dur 292s，header@4ms，settled） |
| **Mode 2 延迟批** | 响应头**迟到**（思考算完才发），随后整段突发 | req_..._80（dur 137s，**header@≈137s**，54 帧在末尾 43ms 内突发，committed）、req_..._64（dur 72s，**header@≈31s**，committed）、req_..._3（dur 104s，header@≈95s，committed） |

**这些请求都走了 COMMIT 分支（20s 合成提交）却最终成功** —— 直接证明：**在 20s commit 时刻，合法 heavy-thinking（B，Mode 2）与真正挂起（A）在信号上不可区分。**

### 3.3 结论：「等 header」判别已实测证伪（直读 oracle 闭合）

- A（挂起）：`status=0`，响应头**永不**到达，126-206s 后 rstCode=0。
- B-Mode2（长思考）：`status=200`，响应头在 **直读实测 47-231s** 到达，之前同样 `status=0`、0 帧、静默。
- **二者在 20s（乃至更久）时刻的可观测状态完全相同** —— 「等上游响应头再 commit」= 把 commit 无限推迟到 header-timeout（300s），对 B-Mode2 无害但对 A 也只能干等，**判别力为零**。
- **这已是实测结论**（对抗审 HIGH-1/2 靠直读 `upstreamHeadersAt` 闭合，§0 ✅）。B2 架构主线本就**不依赖**判别证伪、现更有实测背书。

### 3.4 一个反证边界（诚实标注）

- 交办材料引用的 `timeout-resolver.ts:6-9` 注释「gpt-5.5(effort=high) 单次 266-462s 零帧静默由 **streamIdle**（body-idle）守卫」暗示 **Responses/gpt 路径**是 Mode-1-like（响应头早到、静默在 body 阶段）。若属实，「等 header」在 **Responses 路径**可能成立。但事故 req_57/58/63 是 **Anthropic 路径**，本 spec 结论限定 Anthropic；Responses 路径的 header 时序是一个**独立待测项**（§8 Q3）。

### 3.5 ground-truth 已取到（2026-07-23 Q5 直读）

- per-attempt 绝对时刻 `upstreamHeadersAt / upstreamMessageStartAt / upstreamFirstTokenAt / upstreamLastTokenAt`（`request-timing.ts:18-24`，采集于 `driver.ts:642-643`）**已投影进 History V3 REST 详情**（`projection.ts:277-283`）。据此对 4141 主服务器只读直读，`upstreamHeadersAt − startedAt` 即 header 到达延迟，零推断。34 条正样本（>20s ∩ success，最高 231s）见 §0 ✅。早前草案「投影未导出、只能 offset 反推」的 caveat 已作废。
- 唯一仍未持久化的是 `delayedCommit/commitAt` verdict（§8 Q5 part ②）——但如 §0 所述，「header 直读 > commit 窗口」已足以证「走了 commit 分支」，该 verdict 在证据上非必需、仅作未来查询便利与 B2 实现内部状态。

---

## 4. 问题的重新框定（为什么判别是伪命题）

commit 的真正代价**不是**「锁定了内容」，而是「锁定了 **HTTP 状态码 = 200**」，从而**关闭了客户端的原生重试**（CC 对 200+SSE-error 零重试）。但 commit 时我方发给客户端的**全是合成脚手架**、**零真实 assistant 内容**。

**⚠ 脚手架形态随 keepalive mode 而异（对抗审 HIGH-3 订正，B2 必须按模式分支）：**
- **默认 `stream_keepalive_mode: ping`**（`state.ts:1889-1892`）：commit 后立即写的是**裸 `ANTHROPIC_PING`**（`handler-v4.ts:616-623`），**无** synthetic message_start、**无** anchor block、**无** index-remap。
- **`enveloped_ping`**：装 synthetic message_start 注入器（message_start dedup-only，无 anchor）。
- **`empty_text`**：才有 synthetic message_start + 空 text anchor block(0) + index+1 remap（`handler-v4.ts:1030-1059`，决策 1 机制）。

关键洞察（修订）：**「committed 但只发了合成脚手架」的流，结构上等价于一个『内容尚未开始』的合法开放流**——可以在其后用一次全新上游尝试的真实内容填充。但**「怎么拼」随模式不同**：默认 ping 下 fresh attempt 的真实 `message_start` 正常成为首消息即可；`enveloped_ping` 需 dedup；`empty_text` 才需 close/remap。**anchor index-remap 只是 `empty_text` 模式的机件，不是通用前提**——B2 不能假设它总在。

因此：**「早 commit」在重试语义上可以变得无代价** —— 只要 post-commit 能对「pre-semantic-content 上游失败」发起内部重试并把真实内容拼接进同一条客户端流。**A-vs-B 判别不再需要**：无论挂起还是慢思考，早 commit 都不再牺牲重试能力（重试从「客户端原生」搬到「代理内部、脚手架之后」，且更优 —— 无需客户端重传数百 KB 上下文）。

---

## 5. 候选方案穷举（判别信号 + 解决方案两层）

> 每项标注：**可行性** + **是否误伤 B（合法长思考）** + **能否救事故（A pre-content 干挂）**。

### 5.A 判别信号候选（「在 commit 时刻区分 A/B」这条老路）

- **A1 等上游响应头（交办假设）** —— **证伪（Anthropic 路径）**。§3。误伤 B-Mode2（header 到 143s），判别力零。**不采纳**（Anthropic）；Responses 路径待测（§8 Q3）。
- **A2 h2 PING 存活探测** —— 不可行作判别。A 与 B 的**连接**全程存活（GHC 网关服务端挂着 stream 思考/挂起，TCP+h2 都活、PING 都被 ACK，`http2-client.ts:247` scheduleH2KeepalivePing）。差异在 **stream 级静默**，PING 是 **session 级**，测不到 stream 是「在算」还是「死等」。**不采纳**。
- **A3 首字节超时分层（per-model header 阈值）** —— 设一个「pre-header 超 T 即判 A」。**误伤 B-Mode2**：合法思考 header 可达 143s，任何 < 143s 的 T 都会误杀 + 触发无谓重试（正是 2026-07-08 §2 已否的理由）。可行但判据不干净。**降级为逃生舱**（§5.B-3 的 fail-fast 上限，接受「宁可少数长思考失败也不无界等」的取舍，需用户拍板）。
- **A4 探测性早发保活但保留重试窗口** —— 见 §5.B-2（这不是判别，是「延迟不可逆点」）。
- **A5 up-front HEAD/probe 预飞** —— 对生成端点无意义（GHC 不提供无副作用的「你还活着吗」探针；HEAD `/v1/messages` 无定义），且 probe 自身同样会被 deferred-header 挂住。**不采纳**。
- **A6 统计分布 + 自适应**（每 model 学 header 到达分布，超 pXX 判疑）—— 与 A3 同病：B 分布尾巴很长（143s），阈值必然误伤或无用。**不采纳作判别**，但其**遥测**价值可留（§8 Q4）。

**判别层小结：Anthropic 路径不存在「commit 时刻可靠区分 A/B」的信号。** 这不是「还没找到」，是 deferred-header 使「静默无头」成为 heavy-thinking 的正常签名、与挂起同形。

### 5.B 解决方案候选（绕开判别）

- **B1 加宽 commit 窗口至 CC 真实 pre-header 容忍度**（`streamCommitAfterSec` 20 → ~50-55s，先测 CC 容忍度）。
  - **原理**：不 commit 期间客户端仍在等 200 头，原生重试完好。窗口越大，越多 B-Mode2（header@31s/40s）在**原生保护下**拿到真实头 → 走 settled 路径、零合成；越多 A 若在窗口内 RST 则客户端拿到**可原生重试的真实错误**而非 committed 硬失败。
  - **可行性**：高（改默认值 + clamp 上限）。**门槛 = CC 的 time-to-first-response-header 容忍度**（未测，§8 Q1）：SSE `event: ping` 需 200 状态行已发才能发，故 pre-commit 我方**一个字节都发不出**，runway 受限于 CC 对「请求已发、迟迟无 HTTP 响应头」的容忍（可能是 connect/read timeout，非 60s SSE byte-idle）。req_189 观测到 `x-stainless-timeout: 1200`。
  - **误伤 B**：不误伤（只是让 B-Mode2 更多走原生路径，更好）。
  - **救事故 A**：**部分**。事故 RST 在 126-206s，很可能仍 > CC pre-header 容忍度 → 仍会 commit → 仍硬失败。加宽窗口救的是「较短的 B-Mode2」和「在窗口内就失败的 A」，救不了「干挂到 126-206s 才 RST 的 A」。
  - **定位**：低成本、鲁棒、正确方向的**第一层**，但非完整解。

- **B2【推荐核心】post-commit pre-semantic-content 内部重试（拼接进合成脚手架）** —— 见 §4 框定。
  - **原理**：commit 后若上游在**产出任何真实语义内容之前**失败（RST / header-timeout / clean-EOF），此时客户端只收到合成脚手架（无真实内容）→ 发起**一次全新上游 dispatch**（fresh attempt），成功则把真实内容缝进**同一条 committed 客户端流**。
  - **可行性（对抗审 HIGH-3/4 订正，别高估复用度）**：中偏难。这是一个**新拓扑：post-commit、pre-ready / pre-semantic-content recovery**，**不是** continuation-retry 的小变体。可复用的是 candidate/recovery、history/dispatch、reconcile 的**部分**机件；但 continuation `runContinuation` gated 在 `committedAny=true` 且需一个已 ready 的 parent candidate（`coordinator.ts:143-153`），而 pre-header RST 时 `runRequest` 尚未返回 ready upstream/binding —— 故需**新建**「pre-ready failure 重新发起 + 同 sink splice + 预算/History verdict/abort/header-timeout/sink 所有权」拓扑。**wire contract 须按三种 keepalive mode 分支**（§4：默认 ping 让 fresh `message_start` 正常成首消息 / `enveloped_ping` dedup / `empty_text` close+remap），每模式建协议级验收矩阵。
  - **⚠ server-side tool 重复执行边界（对抗审 HIGH-4，必须纳入触发条件）**：「客户端未收到真实内容」**不等于**「上游未执行 server tool」——含 server-executed / unknown-typed tool 的 fresh retry 可能**重复触发远端副作用**。B2 触发条件须是「**尚未向客户端交付语义内容，且不存在 server execution risk**」，复用/等价 `hedge-policy.ts` 的 `classifyServerExecutionRisk` gate（默认拒 server-executed 与 unknown typed tools，仅在有 idempotency key 或可证明未执行时开放）——**不能只写「没有 content_block_delta」**。
  - **误伤 B**：**零**（B 若成功产出真实内容，压根不触发）。
  - **救事故 A**：**取决于 A 是否可重试成功**（§8 Q2 = PoC 门控）。瞬态/单连接病态 → fresh attempt 成功、事故根治、对客户端透明；系统性（大 context 触发 GHC 病态）→ 仍挂 → 退化为 B3。
  - **定位**：**长远正确的主线**（不因上述边界降级）。它消解判别伪命题（早 commit 不再牺牲重试），是 richest-data-flow / long-termism 一致的形状 —— 且**独立于 §3 证据终验成立**（§0 两论证拆分：commit 后失去内部恢复能力本身即架构缺陷）。

- **B3 pre-content 有界等待 + fail-fast 成客户端可行动错误**（内部重试耗尽或禁用时的兜底）。
  - **原理**：给「commit 后仍无真实内容」设一个可配上限（如 90s，< 事故的 126-206s），到点主动收尾成一个**语义清晰、client-actionable 的 SSE error**（如 `overloaded_error` / 附可读文案「上游长时间未产出内容，请重试」），把 206s 硬等压到上限。
  - **可行性**：高。**误伤 B**：**会**（超上限的合法长思考被砍，同 A3 取舍）—— 故上限必须 > 已知 B 尾巴（疑似 143s）或明确接受取舍，**需用户拍板**（§8 Q6）。**救事故 A**：不「救」，但**减损**（缩短用户等待 + 给可行动错误形态）。

- **B4 pre-header 内部重试 + 加宽窗口组合**（B1 + 让 pre-header transport-close 在 dispatch-scheduler 可重试）。
  - 事故 RST 在 126-206s 远晚于任何安全 pre-commit 窗口 → pre-header 重试几乎必在 commit 后才有机会 → 实际落到 B2。**并入 B2 考量**，单独价值有限。

- **B5 pre-header concurrent hedge（对抗审 HIGH-4 补，与 B2 并列比较）**。
  - **原理**：primary 在 pre-header 无头期间，启动第二 candidate 并发飞，先获得有效响应者胜出。现有 hedge 只能 post-header（`driver.ts:769-784` 需已 resolved binding）——这是**现状限制、非不可能**。
  - **可行性/取舍**：中。**资源/计费**：并发飞 = 双份上游成本（对内部工具可接受、但须显式）。**server-tool 副作用**：与 B2 同 —— 须复用 `classifyServerExecutionRisk` gate（并发飞含 server tool 会双执行）。**取消语义**：败者须干净取消。**vs B2**：B5 是「并行赌」（更快但更贵、pre-header 就起）；B2 是「串行救」（commit 后失败才起、省一半成本）。**倾向 B2 为主线、B5 记为备选**（PoC 时一并评估），需用户认可方向。

---

## 6. 推荐方案 + 理由

**分层推荐（三层，逐层朝「真正能用」推进，符合项目 has-meaningful-and-complete 哲学）：**

1. **第一层（鲁棒、低成本、立即可做）：B1 加宽 commit 窗口**至实测的 CC pre-header 容忍度（先做 §8 Q1 探针）。把更多 B-Mode2 与短 A 拉回原生重试保护区。**不依赖任何判别、不误伤 B。**

2. **第二层（长远正确、主线）：B2 post-commit pre-content 内部重试**。这是消解「A-vs-B 判别伪命题」的正解 —— 承认 20s 无法区分、并让区分变得不必要。**门槛 = §8 Q2 PoC**（重试事故类请求能否成功）；PoC 建议交主会话派 `gpt-souls:poc-runner`。

3. **第三层（兜底、取舍项）：B3 pre-content fail-fast 上限**。当 B2 内部重试耗尽/系统性挂起时，把 206s 硬等压到可配上限 + 客户端可行动错误。**上限取值需用户拍板**（§8 Q6）。

**为什么不选「找更好判别信号」（§5.A 全线）：** §3 的 deferred-header 证据（**待 Q5 直读终验，见 §0**）强烈提示：在**本代理当前已接入的同一 response stream 可观测面内**，20s 时刻的判别信号不存在。**不排除** GHC 提供某个独立状态面（§8 Q8 capability probe 待探）。但即便存在这样一个信号，B2 主线也**不依赖**它 —— 早 commit 后失去内部恢复能力本身即架构缺陷（§0 两论证拆分），移除不可逆性优于在 20s 猜 A/B。

**若仍想要判别的替代**：唯一诚实的「判别」是 A3/A6 的**时间阈值 + 遥测**，但它必然在「误伤长思考」与「无用」之间二选一 —— 故本 spec 把它降级为 B3 的 fail-fast 逃生舱（显式取舍、用户拍板），不作主判据。

### 6.1 PoC 裁决（B2 vs B5，2026-07-23，`gpt-souls:poc-runner`，实验代码 `exp/silence-recovery-b2-vs-b5/`）

**结论：B2 为主线，B5 作后续可配置的尾延迟优化层。长远完整形状 = 先做 driver-owned 的 pre-semantic recovery supervisor（B2 覆盖 post-commit pre-content）+ continuation（post-content），形成完整 post-commit 恢复面；B5 后续接同一 pending-open seam 优化延迟、非替代 B2。**

**SDK wire oracle 实测（离线真 `@anthropic-ai/sdk` 0.106.0 探针，4 场景 ×3 次确定，无 GHC/无凭据）**：
- **默认 `ping` 模式：fresh attempt 的真实 `message_start` 可自然成为客户端首消息、无需 remap**（验证 §4 修订：anchor remap 只是 `empty_text` 机件、非通用前提）。
- 三模式 splice wire contract 全通过：

| mode | 已发脚手架 | fresh attempt 拼接规则 |
|---|---|---|
| `ping`（默认） | 裸 `event: ping` | fresh `message_start` 原样成首 message，real block 原 index |
| `enveloped_ping` | synthetic/已捕获 message_start、无 anchor | 丢弃 duplicate message_start；real block 原 index |
| `empty_text` | message_start + anchor `content_block_start@0` + 空 delta | 首 real block 前写 `content_block_stop@0`；丢 dup message_start；real block index +1；失败/终止在首 real block 前也须先 close anchor |

**B2 不是 continuation 小变体（代码实证）**：`runRequest` 只在拿到 ready upstream 后才 bind 返回（`driver.ts:311-374`）；pre-header 失败时 handler 手上只有 rejected `p`、**无 CoordinatedCandidate、无 ready parent**，而 `runContinuation` 要求 ready parent + `committedAny=true`（`coordinator.ts:143-153` / `driver.ts:1401-1454`）。**B2 必须新建**（可复用 candidate/dispatch/history/budget/sink/reconcile 底层机件）：① pre-ready failure ownership（driver 暴露/持有 pending primary、把 pre-ready 失败结算为可追踪 parent）；② 统一 semantic-content gate（不能只看 `committedAny`——它只表示 buffered 某完整 block 已写；须覆盖 pre-ready + ready 后首 semantic frame 前 + live/buffered）；③ sink lifetime supervisor（首失败路径不能 close sink 后再拼第二条，由上层 recovery supervisor 管最终 close）；④ 三模式协议级回归矩阵（覆盖 primary failure/recovery failure/abort/header-timeout/budget exhaustion）；⑤ pre-ready primary / recovery / winner 的 discarded/failed/winner history settlement。

**server-tool 双执行 gate（B2 与 B5 共用，spec Q9）**：复用 `classifyServerExecutionRisk`（`hedge-policy.ts:152-183`，从最终 target `PreparedRequest` 分类、非猜客户端格式）。B2 fresh dispatch 前必调，条件 = 「未向 client 写真实 semantic content **且** `classifyServerExecutionRisk(finalWire).kind === "none"`」。**注意**：该 gate 是保守 capability 预防、**不能证明上游未执行**；`allowServerTools:true` 无条件放行**不满足**安全要求、主线不应用它绕过；classifier 会跳过无字符串 `type` 的 tool object——若安全目标扩至「畸形/未类型化 tool 也禁 dup dispatch」需另加 stricter gate。

**B5 可行但仍是新 pre-ready 拓扑**：现有 hedge 是 post-header（`driver.ts:769-837` 需已 ready binding），B5 需新建 pending-open race（primary dispatch 起即暴露 pending-ready promise、threshold 到期 race 两个**未 ready** opening、opening failure 不即取消另一个、winner 建议按「first complete semantic block」而非「first header」否则可能选中一个之后继续静默的流）。B5 在 candidate race/cancel/budget 子域比 B2 复用更多，但缺 pending-open race + pre-header winner predicate + 败者 semantic-frame delivery gate。

**待验证门（PoC 明确未验证）**：真实 GHC 大 context fresh-retry 成功率（= §8 Q2，决定 B2 根治 vs 退化 B3）、GHC cancel 后计费语义、server tool 首 token 前执行时点。（**pre-header 容忍度已于 2026-07-27 实测闭合**，见 §8 Q1；**post-header 的真实 CC 300s watchdog 由更早的 `exp/cc-idle-280s/` 实测**——ping-only ~300s 断、空 content delta 撑过 340s，**不是**本轮 Q1 测的，两者是不同机制。）

---

## 7. 与既有机制的交互

- **delayed-commit（`streamCommitAfterSec`）**：B1 直接调其值 + clamp 上限（**2026-07-28 已落地：默认 180、`COMMIT_WINDOW_MAX_SEC = 240`**；原文的「当前 clamp < 60」已过时）；B2 在 COMMIT 分支的 post-commit catch（`handler-v4.ts:634-699`）里新增「pre-content 失败 → 内部重试 splice」路径。
- **CC 两层 watchdog**：B1 的窗口上限由 CC pre-header 容忍度（**2026-07-27 已实测 ≈300s**，归 undici 默认 `headersTimeout`；非 60s SSE byte-idle —— 那层在 commit 后才生效，见 §8 Q1）决定；commit 后决策 1 的 empty_text 无条件保活继续压住 60s/300s 两层（不变）。
- **keepalive sink / anchor**：**仅 `empty_text` 模式**才需 anchor 的 index-remap（真实块落 index+1、锚点收口）；默认 `ping` 不需 remap、`enveloped_ping` 只需 message_start dedup（§6.1 三模式 contract 表、SDK 探针实测）。**anchor remap 不是 B2 的通用前提**。
- **决策 2 的 pre-commit network-retry**：只在 commit 前起作用（保原生状态）；B1 加宽窗口 = 扩大决策 2 的有效区间。
- **hedge（post-header）**：现状与本 spec 正交（hedge 在响应头之后 racing 慢首 token）；但 **B5 拟把 hedge 扩到 pre-header**（§6.1，新 pending-open race）。
- **`feat/continuation-retry`（post-commit + post-content 续写救援，已 landed master）**：**互补关系**。continuation 救「首块已发、mid-stream 被掐」（`committedAny=true` + ready parent）；本 spec B2 救「一个真实块都没发、pre-content/pre-ready 干挂」（`committedAny=false` + 无 ready parent，**非 continuation 小变体**，§6.1）。**若两者都落地，post-commit 重试覆盖 = pre-content（本 spec B2）∪ post-content（continuation），形成完整 post-commit 恢复面。**
- **buffered-retry（`protect_streaming_generation`，默认 OFF）**：buffered 缓冲全部真实帧到 message_stop 再 commit、mid-stream RST 透明重试 —— 但它 commit **晚**（message_stop 后），对「pre-response 纯静默、连 message_start 都没有」的事故场景，buffered 一样在 commit 前干等、且其 pre-commit keepalive 走的正是决策 1 的 anchor。buffered 与本 spec B2 的关系需在 plan 阶段厘清（§8 Q7）。

---

## 8. 开放问题 + 需用户/主会话拍板的取舍

- **Q1【已闭合 · 2026-07-27 实测】** CC 对「请求已发、迟迟无 HTTP 200 响应头」的容忍度 ≈ **300s**，且**不是** Anthropic SDK 的 1200/1250s request timer、**也不是** CC 那个响应头后才武装的 stream-idle watchdog——直接触发器**与 undici 默认 `headersTimeout` 一致**（`node_modules/undici/lib/dispatcher/client.js` 默认 `300e3`）。作用域：**本机 CC 2.1.220、其内置 Node v26.3.0 transport 默认配置**下，四个完整 attempt 的 pre-header abort 落在 **299.667–300.280s**；裸 `fetch`（无 SDK 无 CC）抛 `UND_ERR_HEADERS_TIMEOUT`；把 `CLAUDE_STREAM_IDLE_TIMEOUT_MS` 抬到 600000 **不移动**该点；裸 TCP socket 打同一 handler 420.1s 未被关（排除我方服务端）。**这是可配置、可随版本变化的 transport 默认值，不是协议物理常量**，换客户端/runtime 版本需重新校准。撞上后 CC **原生重试**（观测 4 个完整周期，backoff ≈ 0.55/1.05/2.16/4.06s；最大尝试数**未测定**——该轮由我方主动终止），代价是上游从头重算。证据与对照见 [`exp/silence-recovery-gates/FINDINGS.md`](../../exp/silence-recovery-gates/FINDINGS.md) §「Q1 续测」+ `results/q1-firstfail/`。**推论**：B1 窗口上限 = 该 transport default 减余量；**单个 pre-header attempt 必须在 ~300s 前 commit，否则接受该 attempt 被中止**。⚠ **不得**由此推出「总预算 T+300s」或「~600s 天花板」——commit 后的 300s 是**可重置的 idle watchdog**（非-ping 事件即重置），且我方 `streamKeepaliveEscalateSec` 默认 200s 会主动重置它（`src/lib/state.ts:410-415`），post-commit 存活时长由 keepalive/escalation 契约决定。pre-header 与 post-commit 的两个 300s **相互独立配置、当前默认值相同，不得合并做预算**。
- **Q2（PoC 门控，B2 成败关键）** 事故类请求（261-678KB 大 context、GHC 0 帧干挂）**在 fresh retry 下能否成功**？若 A 是瞬态 → B2 根治；若 A 系统性（大 context 必挂）→ B2 退化为 B3。**建议交主会话决定是否派 `gpt-souls:poc-runner`** 复现 + 重试实测。**未验证前，B2 的「救事故」效力是假设、非结论。**
- **Q3（独立待测）** Responses/gpt 路径的 header 时序是 Mode-1（头早到、body 静默）还是 Anthropic 式 deferred-header？若前者，「等 header」在 Responses 路径可能成立 —— 但那是另一个 spec 的事，不混入本 Anthropic spec。
- **Q4** 是否值得为 A3/A6 补一层「pre-header 静默时长」遥测（不作判据、只作可观测 + 未来分析），以便日后若 GHC 行为变化能发现？→ 倾向做（richest-data-flow / 低成本可观测）。
- **Q5【已闭合 · 对抗审 HIGH-1/2 解除】** 直读 `upstreamHeadersAt` 已固定 §3 结论：① 四刻投影**已 landed**（`projection.ts:277-283`）；② `delayedCommit/commitAt` verdict **未持久化但证据上非必需**（header 直读 > commit 窗口即证 commit 分支，无需 verdict）——若日后要零推断查询或 B2 实现需内部 commit 状态，可补（`request.ts` 当前 commit 分支只发 observability event、未持久化）；③ 「`upstreamHeadersAt − startedAt > 20s` ∩ responseSuccess」的正样本已重跑 §3，34 条命中、header 最高 231s（§0 ✅）。**deferred-header 证伪已从『强线索』升为『实测结论』。**
- **Q6（取舍，需用户拍板）** B3 fail-fast 上限取值：定在 > 已知 B 尾巴（143s，如 180s）= 不误伤但减损有限；定在 < 143s（如 90s）= 更快失败但**会砍掉极长合法思考**。这是「等待时长 vs 误杀长思考」的真取舍，摆 3-4 个量化选项交用户。
- **Q7** buffered-retry 路径与 B2 的边界：pre-content 内部重试是否应统一覆盖 live/delayed-commit/buffered 三路径，还是先只做 delayed-commit（事故路径）？（against-YAGNI：倾向设计上统一、执行上分阶段，不 silently 砍。）
- **Q8（capability probe，对抗审 MED）** GHC 在 pre-content 阶段是否提供任何**独立状态面**（job/status API、关联 ID、HTTP/2 informational response、其他 pre-content metadata）——真实 GHC 请求探测。即便最终不采用作判别，也记录探测结果 + 排除理由（避免「信号根本不存在」这类超出已验证范围的绝对结论）。
- **Q9（server-tool 边界，对抗审 HIGH-4）** B2/B5 的 fresh retry 触发条件须复用 `classifyServerExecutionRisk` gate（默认拒 server-executed / unknown typed tools）——确认这个安全边界在 plan 阶段被显式设计，不能只判「无 content_block_delta」。

---

## 9. 结论证据分级（实证 vs 假设，逐条标注）

**代码实证（读源码，file:line 已核）：**
- delayed-commit = `Promise.race([p, 20s])`，`p` 在 pipeline 取得最终可用 upstream response 时 resolve（经 h2 `response` header 事件，`handler-v4.ts:537-554` + `http2-client.ts:864-945`）。**精确含义（对抗审 MED）：「committed ⟺ 20s 内代理未取得最终可用 upstream response」**（含 parse/translate/preflight/admission/reactive-retry 时间），**不是**独立测得「wire 响应头从未在 20s 内到达」——后者须 `upstreamHeadersAt` 直证。§2。
- commit 后客户端只收合成脚手架、无真实内容；**脚手架形态随 keepalive mode 而异**（默认 ping=裸 ping 无 anchor；`empty_text` 才有 anchor+remap）。§4。
- hedge 只在 post-header 触发（`driver.ts:769-804`）——**现状限制、非不可能**（B5 探讨 pre-header hedge）。§2.4。
- continuation-retry gated 在 committedAny=true + 需 ready parent candidate，与本 spec pre-content（committedAny=false、pre-ready）互补但**非小变体**。§7。

**History 直读实测（4141 只读 REST，300 条采样 / 108 streaming 候选 / 34 正样本，2026-07-23 Q5）——实测结论：**
- GHC Anthropic **存在** deferred-header 模式；成功长思考的响应头到达（`upstreamHeadersAt − startedAt` 直读）实测 47-231s。**这是 `upstreamHeadersAt` 直读、非 offset 反推；「committed」由「header 直读 > 20s 窗口」证明（settled-within-window 路径被排除），佐以首帧 `synthetic:"keepalive"`。** §0 ✅ / §3.2。
- → **「等 header」判别已实测证伪。** 对抗审 HIGH-1/2（offset 反推非决定性 + committed 由弱推断）均已闭合。§3.3。

**推断（标注为推断，未直接实测）：**
- A（挂起）与 B-Mode2（长思考）连接层全程存活、PING 均 ACK → PING 不可判别（§5.A-2）—— 基于「GHC 网关服务端挂 stream」的行为模型推断，未打 PING 探针直证。
- 「Anthropic 路径不存在可靠判别信号」应限定为「**在本代理当前已接入的同一 response stream 可观测面内**不存在」——不能证明 GHC 不提供独立状态面（§8 新增 capability probe）。

**待实测/PoC（明确未验证，交用户裁决前的门）：**
- Q2 事故请求 fresh-retry 可恢复性、Q3 Responses 路径 header 时序、Q8 GHC pre-content 状态面 capability probe。**这些验证前，B2 救事故效力、跨路径推广均为假设。**（Q5、Q1 已闭合、不再是门——**B1 窗口上限现为实测的 300s**，见 §8 Q1。）
