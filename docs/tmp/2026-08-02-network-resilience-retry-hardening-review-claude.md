# 评审报告：网络韧性重试加固（架构与完整性轴 · Claude 对抗性评审）

- 评审对象：[docs/tmp/2026-08-02-network-resilience-retry-hardening.md](2026-08-02-network-resilience-retry-hardening.md)（草案 · 待评审）
- 评审轴：架构闭合性 / 完整性 / 公理落地彻底性 / 预算自洽（**不做 §2 逐条事实核验**，那是并行 reviewer 的范围；本报告只在与架构结论耦合时才取证 §2）
- 判据：CLAUDE.md「长远正确 + 完整 > 最小可交付」「无向后兼容负担」「架构健康 > 回归风险」+ 草案 §3 的 A1–A4。**本报告不含任何 ROI / YAGNI / 影响面 / 工作量类否决理由。**
- 日期：2026-08-02

## 0. 总体裁决

**须重做（§4.0 / §4.4 / §4.5 三节结构性返工后重审）。**

- Blocker 4 条，Major 10 条，Minor 7 条。
- §4.2 / §4.3（静默终止 + Responses 续写）的**方向与骨架正确，可保留**，但需补齐 M5–M9 的语义定义。
- 三节返工的原因不是"做得不够小心"，而是三个核心手段各自撞上一个**已被仓库冻结、草案未引用**的前置事实：
  1. §4.0 的 Anthropic 块级默认翻转，撞上 ADR 2026-07-22 D2（2026-07-27 修订）明写的**硬前置门**（inter-block keepalive allocator 方案 A 未落地）；
  2. §4.4 的「网络类 → 9」在当前代码下是**纯空操作**（策略内部有硬编码闸），用户的头号诉求不会被实现；
  3. §4.5 的 3600s 在用户 live config 下**结构上不可达**（两个 1200s wall-clock 杀手），且其中一个就是"per-request 总时长预算"本身 —— §4.5 会造出第二条平行轨，违反 A2。

不返工就执行的后果，不是"效果打折"，而是：Anthropic 客户端在首块提交后 >300s 静默必断流（比今天更糟，因为今天默认是 live）、9 次网络重试实际仍是 1 次、3600s 实际是 1200s。

## 1. 我做了什么（双视角覆盖证据）

### 1.1 机械核对（扫描 / 对账 / 查证）

| 做了什么 | 落点 |
|---|---|
| 逐行读 `runResponseBufferedSink` 全体（driver.ts:1048-1568），标出 committedAny / retreated / continuation / 预算四组状态的**全部** return 点 | 支撑 B4 / M3 / M4 |
| 对账 §4.0 表格四行的每个删除目标，grep 其**全部**消费者 | 支撑 M1 / M2 / m4 |
| 读 `network-retry.ts` / `server-error-retry.ts` 源码，核对「max_reactive_retries 是不是真的绑定约束」 | 支撑 B2 |
| grep `requestDeadline` / `staleRequestMaxAge` 全消费者 + 读用户 `config.yaml` 实际值 | 推翻 §2 C6，支撑 B3 |
| 追 `generationMaxTotalCandidates` / `MaxTotalDispatches` 从 config → runtime-policy → generation-budget 的完整链路，手算最坏组合 | 支撑 M4 |
| 交叉核对 ADR 2026-07-11 决策 2 表 vs ADR 2026-07-22 D4，找 ADR 间自相矛盾 | 支撑 M10 |
| 核实 §6 O1（server_tool_use 归一）—— 读 extractor 实现 + ledger docstring | 闭合 O1（m1） |
| 核实 §6 O4（统一时钟源）—— 已存在两处 | 闭合 O4（§5 节） |
| 读 `docs/todo/2026-07-22-client-proxy-keepalive-300s.md` + `docs/spec/2026-07-27-inter-block-keepalive-carrier.md` + `docs/plan/2026-07-27-inter-block-anchor-allocator/README.md` + `git log` 判断方案 A 落地状态 | 支撑 B1 |
| 读 plan-4-responses-ws.md 全文 + ws.ts 的 P4 Task 1 原始注释，比对草案对该论证的复述是否完整 | 支撑 M10 / m5 |

### 1.2 第一人称执行视角（模拟走查的流程与分支）

我假装自己是**一个真实请求**，沿以下路径各走一遍，记录每一步落进哪条腿：

1. **Anthropic 直连 + 块级 + 首块前 RST** → 情形 1 ✓（透明重试可达）。
2. **Anthropic 直连 + 块级 + 首块后 RST（前缀含 tool_use）** → 情形 2（草案要新建）。走查 CC 侧行为时发现 carrier spec §2.2 记录了 CC 2.1.207 是 **eager per-block 执行工具**，这实际**支持** §4.2 的方向（见 §4「站得住的部分」）。
3. **Anthropic 直连 + 块级 + 首块后 `streamIdleTimeout` 触发** → **落不进任何一条腿**（B4）。
4. **Anthropic 直连 + 块级 + 生成超 16 MiB 后被掐** → retreat 分支先 return，**三腿全失效**（M3）。
5. **`/v1/messages` + `@cc` / `@responses` 模型（translate leg）** → 结构上没有 buffered 路径，**零条腿**，且 §4.0 要删的 `liveReconcilingSink` 正是它在用（M2）。
6. **长生成跑到第 1200 秒** → reaper / request_deadline 强杀，与 §4.5 的"不打断进行中的腿"直接对撞（B3）。
7. **首块提交后进入第 2 次续写腿，上游 320s 没吐第一个字节** → 客户端轨无 open block → 只发裸 ping → CC 300s watchdog 断流（B1）。
8. **9 次重试全部发生 + 每次都伴随一次网络重试** → 手算候选/派发预算，撞 `generation-budget` 的 throw，且透明重试分支没有 try/catch（M4）。
9. **超预算 + 已提交前缀无 tool_use** → §4.5 说落 §4.2 的优雅终止，但 §4.2 的终止符 `stop_reason:"tool_use"` 对该前缀非法 → **第四态未定义**（M8）。
10. **Responses 续写第 2 腿** → 走查客户端会看到 `sequence_number` 从 0 重新开始、`response.id` 与 `response.created` 不一致（M9）。

## 2. 事实性发现

> 编号规则：B=Blocker、M=Major、m=Minor、n=Nit。每条给：问题 → 证据（file:line / 命令输出）→ 修法。

---

### B1 · Blocker · §4.0 Anthropic 块级默认翻转撞上仓库已冻结的硬前置门（草案完全没引用该门）

**问题（客观事实）**：块级 buffered 下，driver 只在 `content_block_stop` 边界原子 flush，因此**正在生成的上游块在客户端轨上根本不存在**。首块提交之后的任何长静默，客户端看到的都是"无 open block 的静默"，此时保活只能发裸 ping，而裸 ping **不重置** Claude Code 的 300s no-real-content watchdog。当前代码里的 content 升级（`streamKeepaliveEscalateSec: 200`）被一个 `semanticBlockCount === 0` 门**限死在 pre-content**。

**证据**：

- 代码，带自述注释：
  ```
  src/lib/pipeline/delivery/session.ts:126-129
  // Fixed anchor@0 is valid only before any real block has completed. After the first
  // committed block, a no-open window needs the future monotone index allocator; reusing
  // index 0 would make the SDK reorder content. Until that design lands, stay on ping.
  if (pendingOpenBlocks.length === 0 && semanticBlockCount === 0 && heartbeat.injectContentScaffold && !contentScaffoldAttempted) {
  ```
  旧 sink 路径同门：`src/lib/pipeline/client-sink.ts:429` 的 `!everOpenedRealBlock`。
- ADR，2026-07-27 修订正文：`docs/decisions/2026-07-22-continuation-retry-sequential-anchor.md:27` —— 「块级 buffered 下首块后的生成对客户端没有 open block，固定 anchor@0 不能复用；完整覆盖依赖独立方案 A（generation-scoped 单调 wire-index allocator），**并是 Anthropic 块级默认翻转的硬前置门**」。
- 冻结设计的冻结前提：`docs/spec/2026-07-27-inter-block-keepalive-carrier.md` §1.5 —— 「方案 A 必须在 Anthropic 块级 buffered 默认翻转前落地」。
- todo 文档同结论：`docs/todo/2026-07-22-client-proxy-keepalive-300s.md` 头部 ——「首块提交后的无-open窗口暂不升级……并硬阻塞 Anthropic 块级默认翻转」。
- 方案 A **尚未完成**：`docs/plan/2026-07-27-inter-block-anchor-allocator/README.md` 状态为「计划待审」，`git log` 显示只有 P0 基线与 P6（心跳生命周期修复）落地：
  ```
  2e1041e8 docs(plan): P6 final confirmation — approved for merge
  a15ea821 fix(delivery): freezeHeartbeat must not permanently kill the heartbeat
  1bf9bf89 test(anchor): establish allocator implementation baselines
  ```
  P1–P5 / P7 / P8 未落地。

**这条为什么是 Blocker 而不是"注意事项"**：草案 §4.5 自己写了「承重因果链：3600s 只在保活撑得住时才有意义」，并在 §2 C10 断言当前 `20s ping + 200s escalate` 已覆盖两层客户端边界。**C10 的覆盖只对 pre-content 成立**，而本设计的三条腿全部作用在 post-content。因此这条链在本设计的**主战场上是断的**：9 次重试 + 续写腿本身就会制造大量"首块后长静默"（单腿 header 等待上限 300s，`config.yaml:249` 还给 gpt-5.5 开到 600s），断流概率随重试次数上升而**上升**。

**修法**：三选一，草案必须显式选并写理由：

- (a) 把方案 A（`docs/plan/2026-07-27-inter-block-anchor-allocator/` P1–P5/P7/P8）列为本设计的**前置阶段**，本设计的 §4.0 排在其后；
- (b) 如果要并行推进，§4.0 的 Anthropic 默认翻转必须拆成独立阶段并显式标注"受 allocator 门控"，而 §4.2/§4.3/§4.4 先行；
- (c) 若用户裁决推翻这个门，必须先在 ADR 2026-07-22 D2 上写反转记录 + 实证 oracle（真 CC >315s，`exp/cc-idle-280s`），不能靠本草案静默越过。

---

### B2 · Blocker · §4.4「网络类 → 9」是空操作：network-retry 内部硬闸 1 次、server-error 硬编码 2 次

**问题（客观事实）**：用户的头号诉求是"网络波动 → 重试次数默认 9 次"。§4.4 的实现手段是把 `retry.max_reactive_retries` 按族拆解并把网络族抬到 9。但 `max_reactive_retries` **不是网络重试的绑定约束** —— 两个网络族策略各自有内部硬编码上限，**低于**当前的 5，所以现在这个 5 就已经不是绑定约束了，抬到 9 一个字节的行为都不会变。

**证据**：

```
src/lib/request/strategies/network-retry.ts:35   let hasRetried = false
src/lib/request/strategies/network-retry.ts:41   return error.type === "network_error" && !hasRetried
src/lib/request/strategies/network-retry.ts:50   hasRetried = true
```
`canHandle` 在第一次重试后永久返回 false → **每个 candidate 至多 1 次 network 重试**（策略实例由 `createDriverCoordinator` 的 `createCandidate` 每候选新建：driver.ts:499 `const retry = createSemanticRetryPolicy(deps)`，所以准确说是"每候选 1 次"，不是"每请求 1 次"—— 无论哪种口径，抬 5→9 都无效）。

```
src/lib/request/strategies/server-error-retry.ts:24  const SERVER_ERROR_MAX_RETRIES = 2
src/lib/request/strategies/server-error-retry.ts:43  return error.type === "server_error" && retries < SERVER_ERROR_MAX_RETRIES
```

驱动侧的预算门在这两个闸**之后**才生效：
```
src/lib/pipeline/driver.ts:589
const overBudget = action.learning ? learningRetries++ >= deps.maxLearningRetries : normalRetries++ >= deps.maxRetries
```
`canHandle` 已经返回 false 时，driver 走的是 `recordRetryGiveUp("unclaimed", ...)` 分支（driver.ts:563-570），根本到不了预算判定。

**修法**：§4.4 必须把"策略内部硬闸参数化"写成一等实现项，而不只是改配置标量：

- `createNetworkRetryStrategy` 的 `hasRetried` 布尔闸改为计数 + 上限来自族预算，并加退避（当前是固定 `NETWORK_RETRY_DELAY_MS = 1000`，9 次 1s 间隔重试对瞬时抖动有效，对持续断网是无意义风暴 —— 应与 server-error 一样上指数退避）；
- `SERVER_ERROR_MAX_RETRIES` 从常量改为族预算解析；
- **并补一个守卫测试**：断言"族预算 = N 时，注入 N 次 network_error 恰好产生 N 次重试"。没有这个正样本，改完仍然无法证明预算真的接上了（→ 记忆 `feedback-pass-null-clean-not-self-validating`：通过性结论不自证）。
- 顺带：`token-refresh` 被草案划进"网络类 9 次"。它的失败语义与网络抖动不同（凭据无效时重刷 9 次是打 auth 端点），建议单列或保留低值，并在文档写明理由。**这是我的判断，不是事实缺陷。**

---

### B3 · Blocker · §2 C6 事实错误 + §4.5 的 3600s 在用户 live config 下结构不可达，且会造出第二条平行总时长轨（违 A2）

**问题（客观事实）**：C6 断言「仓库中**不存在**任何 per-request 总时长预算」。仓库里存在**两个**，且都在用户 live config 里被设成 1200s，都会在 1200s 强杀请求 —— 3600s 结构上到不了。

**证据**：

- 机制一（per-request 硬 deadline，精确定时器，cancel + settle）：
  ```
  src/lib/context/manager.ts:410-424
  if (armDeadlineTimers && state.requestDeadline > 0) { ... setTimeout(..., state.requestDeadline * 1000) }
  ```
  它的注释自述：「Per-request hard-deadline timers (RFC C4b) …… each request gets a precise monotonic timer armed at create() for `state.requestDeadline` seconds」。
- 机制二（stale reaper，周期扫描，`reapInFlight()` + `fail()`）：
  ```
  src/lib/context/manager.ts:290-330
  const maxAgeMs = state.staleRequestMaxAge * 1000
  for (const [id, ctx] of activeContexts) if (ctx.durationMs > maxAgeMs) { ctx.reapInFlight(); ctx.fail(...) }
  ```
- 用户 live config 两者都开着，都是 1200：
  ```
  config.yaml:254-255   # TODO: rename stale_request_max_age as upstream_request_deadline
                        stale_request_max_age: 1200
  config.yaml:260-261   # TODO: rename request_deadline as client_request_deadline
                        request_deadline: 1200
  ```
  config.yaml:258 的自述文案正是「**客户端请求**的最大存活秒数……一次客户端请求可能会被多次内部重试」—— 这就是 §4.5 想造的东西。
- 而且 `request_deadline` 已经在做 §4.5 想要的"开新腿前检查"语义：
  ```
  src/lib/pipeline/generation/runtime-policy.ts:8   const requestDeadlineAtMs = state.requestDeadline > 0 ? monotonicNow() + state.requestDeadline * 1000 : 0
  src/lib/pipeline/generation/hedge-policy.ts:128   if (context.nowMs + expectedHedgeCompletionMs + cleanupMarginMs >= requestDeadlineAtMs) { ... }
  ```

**修法**：§4.5 必须重写为「**扩展既有 `timeouts.request_deadline`**」而不是新增 `retry.total_budget_sec`：

- 语义上，`request_deadline` 现在是**硬掐**（到点 cancel 在途），§4.5 想要**软预算**（到点不开新腿、不打断在途）。这是同一个量的两种执行方式 —— 正确形状是给这一个键加执行模式（如 `timeouts.request_deadline_mode: hard | admission`），或把 admission 检查加在硬掐之前（预算耗尽先停止开新腿，硬掐保持在更外层作兜底）。**绝不能是两个键各管一半。**
- `stale_request_max_age`（= 单次上游尝试上限，见 config.yaml:252 的中文注释）与总预算是不同的量，必须在文档里点名"这两个键是不同层"，并给出把总预算抬到 3600 时 `stale_request_max_age` 应取何值的推导（当前 1200 > 单腿上限 600，是合理的；但如果总预算 3600 而 reaper 仍按 `ctx.durationMs`（**整个客户端请求**的年龄）判定 —— 见 manager.ts:290 用的是 `ctx.durationMs` —— 则 reaper 会在 1200s 杀掉一个总预算 3600 的请求。这是 config.yaml:254 那个 TODO（"rename as upstream_request_deadline"）指出的命名谎言：它名字像单次上游，实现却按客户端请求年龄判。**这个不一致必须在本设计里解决，否则 3600s 永远到不了。**）
- C6 需改写为「已有两个机制，本设计的工作是归一，不是新增」。

---

### B4 · Blocker · 三条腿按 commit 状态分类，代码按 error class 门控：`idle-timeout` / `reaper-cancel` / `request-deadline` 落不进任何一条腿

**问题（客观事实）**：草案的三情形分类轴是"提交了多少块"。但驱动的两个门都额外要求错误属于 `"other"` 类：

```
src/lib/pipeline/driver.ts:1430   const retryable = (thrown ? classifyStreamError(thrown) === "other" : true) && !committedAny
src/lib/pipeline/driver.ts:1479-1487  const canContinue = committedAny && (thrown ? classifyStreamError(thrown) === "other" : true) && ...
```

`classifyStreamError` 的取值域是 9 个：
```
packages/foundation/src/stream.ts:164-174
idle-timeout / shutdown / client-abort / reaper-cancel / request-deadline / request-cancel / dispatch-cancel / unknown-cancel / other
```

**后果**：`StreamIdleTimeoutError`（`streamIdleTimeout` 默认 300s）无论是否已提交块，**既不透明重试、也不续写**，直接落错误帧。而"上游长时间零帧"正是本仓库**文档化的 GHC 主要病理**：

```
config.yaml:246-249
# 观察到 gpt-5.5 (effort=high) 爆发前有 266–462s 的零帧静默期
stream_idle_overrides:
  gpt-5.5: 600
```

也就是说：草案 §4.1 写的「情形 1 机制已存在……**零新机制**」对用户抱怨的主流失败形态（网络抖动导致的静默/挂死）**不成立**。9 次重试预算在这个形态下一次都用不上。

**修法**：

- §4 必须加一张 **error-class × commit-state 的二维穷尽表**（9 个 kind × {未提交, 已提交无 tool_use, 已提交有 tool_use}），每格填"落哪条腿 / 为什么故意不救"。这也是 A3「完整」的直接要求。
- 至少需要显式裁决：`idle-timeout` 在**零提交**时是否应可透明重试（我的判断：应该 —— 客户端一个字节都没收到，重试是安全的，而且这正是用户抱怨的形态；`streamIdleTimeout` 是**代理自己设的**门限，不是上游的终局决定）。
- `reaper-cancel` / `request-deadline` / `shutdown` 保持不救是对的（它们是本进程的主动决定），但必须写进表里而不是留给读者推断。
- 取证提示（避免重蹈 `methodology-abort-provenance-tag-at-source-not-guess-at-boundary`）：改这里时，两条臂（idle-timeout 与 transport-close）要分别写 mutation 测试，别只测一条。

---

### M1 · Major · §4.0 摧毁 live 会连带废掉 hedge，而 hedge 恰是 config 里注明的 CC watchdog 对抗手段；草案未记录这个后果

**问题（客观事实）**：buffered 路径**结构性地跳过** hedge：

```
src/lib/pipeline/driver.ts:823-825
// Explicit buffered-recovery mode retains its sequential multi-candidate topology until P7-T3
// folds recovery and hedge budgets into one coordinator. ...
if (outerOpts && "retryCap" in outerOpts) return undefined
```

Anthropic 的 buffered 分支永远带 `retryCap`（`src/routes/messages/handler-v4.ts:1344`），所以 §4.0 把 Anthropic 全量切到 buffered 之后，**hedge 对 Anthropic 全面失效**。今天 Anthropic 默认走 live（`runResponseSink`，driver.ts:979 也调 hedge），hedge 是活的。

而 hedge 在用户 config 里是开的，且注释明写它的用途正是本设计关心的那条边界：
```
config.yaml:968-973
generation:
  hedge:
    # The conservative 300s default targets the Claude Code no-real-content watchdog tail; this is not an ordinary low-latency hedge.
    enabled: true
    threshold_sec: 300
```

**这不构成"因此不要块级"**（A1 是公理，块级是终态）。问题在于：草案在"摧毁 live"时**静默摧毁了另一个默认开启的韧性机制**，既没记录，也没说要不要一并把 P7-T3（hedge 与 recovery 预算合一）拉进范围。按 `no-silently-cut-but-defer`，这必须显式处理。

**修法**：§4.0 加一行后果记录 + 三选一裁决：(a) 把 P7-T3 拉进本设计范围（hedge 与 buffered recovery 统一到一个协调器，长远正确形状）；(b) 明确记录"Anthropic 失去 hedge 是本次代价"，并写进 `docs/todo/deferred-backlog.md` 带解除条件；(c) 用户裁决退役 hedge。**不能不写。**

---

### M2 · Major · `liveReconcilingSink` 有第二个消费者（Anthropic translate leg），且该 leg 结构上没有 buffered 路径 —— `/v1/messages` + `@cc`/`@responses` 模型是"零条腿"

**问题（客观事实）**：§4.0 表格写「`liveReconcilingSink` → 删除」，但它有两个调用点：

```
src/routes/messages/handler-v4.ts:1367   : await driver.runResponseSink(upstream, env, liveReconcilingSink(sink, anchorHooks, anchorState))   ← direct leg（草案要删的）
src/routes/messages/handler-v4.ts:1665   const clientSink = liveReconcilingSink(sink, anchorHooks, anchorState)                              ← translate leg（草案没提）
```

translate leg（`pumpTranslateLegStreamingV4`）是 `/v1/messages` 请求打到 `@cc` / `@responses` 模型时的路径，**在 §1 声明的范围内**（它就是 Anthropic `/v1/messages`）。而它**结构上不能 buffered**，代码自述：

```
src/routes/messages/handler-v4.ts:1640-1646
L2 buffered-retry (`protect_streaming_generation`) is NOT applied on the translate leg — the buffered
commit's `sawMessageStop` gate reads the Anthropic terminator, which here is synthesized by
`flushResponse` AFTER the render loop ... so buffered-retry on the translate leg is deferred to a follow-up
```

**后果**：(a) 按字面执行 §4.0 会删掉 translate leg 在用的函数（编译错误 —— 这是好的，会被发现）；(b) 更重要的是，A1 公理在范围内端点上**并未全覆盖**：一个 `/v1/messages` + `@cc` 模型的请求，三条腿一条都没有，且草案对此完全沉默。这是"落不进任何一条腿"的第二个实例（与 B4 并列）。

**修法**：§4.0 表格补 translate leg 行，并三选一：(a) 把 translate leg 的块级化（根因是 `flushResponse` 在 driver 循环外合成终止符 —— 与 Gemini 同根因，见 ADR 2026-07-11 决策 5）拉进范围；(b) 保留 `liveReconcilingSink` 专供 translate leg 并在函数 docstring 写明"唯一存活理由"，同时把 translate leg 块级化记进 `docs/todo/deferred-backlog.md` 带解除条件；(c) 用户裁决 translate leg 出范围（但仍须记 backlog）。

---

### M3 · Major · retreat（buffer cap）分支在三腿之前 return，且 `bufferedBytes` 在块级 commit 后不清零 —— 长生成会静默退回 live，三腿全部失效

**问题（客观事实）**，两个叠加缺陷：

1. **retreat 短路在三腿之前**：
   ```
   src/lib/pipeline/driver.ts:1375-1385
   if (retreated) {
     notifyBufferedResolve?.("retreated", attempt, { vendor })
     if (drained) return { kind: "complete", ... }
     await closeAnchorIfOpen()
     ...  ← 直接 return stream-error，永远到不了 1430 的重试门和 1479 的续写门
   }
   ```
   一旦 retreat，情形 1/2/3 **全部**不可达，客户端拿到今天那个 error 帧。§4.2 只替换 `partial-degrade`，**不覆盖 `retreated`**。
2. **`bufferedBytes` 在块级 commit 后不清零**（这是块级路径上的实质缺陷）：
   ```
   src/lib/pipeline/driver.ts:1227   let bufferedBytes = 0                      ← 每 attempt 一个
   src/lib/pipeline/driver.ts:1274   bufferedBytes += (toWrite.data?.length ?? 0) + (toWrite.event?.length ?? 0)
   src/lib/pipeline/driver.ts:1275   if (bufferCapBytes > 0 && bufferedBytes > bufferCapBytes) { retreated = true; ... }
   ```
   块级 commit 分支只做 `buffer.length = 0`（driver.ts:1340 附近），**没有** `bufferedBytes = 0`。也就是说：这个"OOM 护栏"在块级路径上度量的是**整条腿的累计渲染字节**，而不是**当前驻留在内存里的字节**（内存在每次边界 flush 时就已经释放了）。默认 cap 是 16 MiB（`packages/foundation/src/state-defaults.ts:125` `bufferCapBytes: 16_777_216`）。

**为什么这两条叠加是 Major**：一个跑满 3600s 预算的长生成，正是最容易累计到 16 MiB 的形态（Anthropic 每 token 一个 `content_block_delta` 帧，含 `event:` 行与 JSON 包装，单帧约 100–200 B；十几万 token 量级即触顶）。于是本设计最想保护的那类请求，会在中途**静默**退回 live 写透，然后失去全部三条腿。**未验证部分**：我没有实测过一个真实 3600s 生成的累计字节数，所以"必然触顶"是推理不是实验；但"度量的是累计而非驻留"是代码事实，与生成长度无关。

**修法**：

1. `bufferedBytes` 在每次边界 commit flush 成功后清零（护栏的语义是"驻留内存上限"，块级下这才是它想守的量）—— 这是**根因修复**，不是绕过；
2. §4 显式定义 `retreated` 在三腿体系里的位置。我的判断：在 A1 公理下（"绝不提供逐 token 流式体验，冲突内容摧毁而非并存"），**retreat-to-live 本身就是一个与公理冲突的退路**，应当一并摧毁：cap 超限时的正确行为不是"退回 live 写透"，而是"按已提交边界正常交付 + 走 §4.2/§4.3 的终止/续写"（此时前缀已提交，形状与情形 2/3 同构）。这需要用户裁决，但草案连这个分叉都没摆出来。

---

### M4 · Major · §4.4 的 `12 / 32` 数量级不足（附推导），且候选/派发预算耗尽时透明重试分支**没有** try/catch，会硬崩而非优雅降级

**（a）候选数推导** —— 草案的 12 勉强够，但草案没给推导，读者无法验证：

- 每次透明重试与每条续写腿**各开一个候选**（driver.ts:1462 `runRecovery` / driver.ts:1500 `runContinuation`；ADR 2026-07-22 D4 亦如此描述）。
- 共享预算：`cap - attempt - continuationCount`，续写首次有 floor 1（driver.ts:1477-1478）。
- 最坏路径 = 首块前用满 9 次透明重试（attempt=9）→ 提交一个块 → 被掐 → `remainingShared = 0` 但 `continuationCount === 0` 触发 floor → 再开 1 条续写腿。
- **候选总数 = 1（primary）+ 9（recovery）+ 1（floor 续写）= 11**。
- 12 够用（余量 1）。**建议在 §4.4 写出这个推导**，否则将来改 cap 时没人知道 12 是怎么来的。

**（b）派发数推导** —— 草案的 32 **不够，差一个数量级**：

- 生产路径的预算来自 hedgePolicy，不是那个 `Math.max` 兜底：
  ```
  src/lib/pipeline/driver.ts:481   const maxTotalCandidates = deps.hedgePolicy?.maxTotalCandidates ?? Math.max(5, 1 + deps.maxRetries)
  src/lib/pipeline/driver.ts:486   maxTotalDispatches: deps.hedgePolicy?.maxTotalDispatches ?? perCandidateDispatchBudget * maxTotalCandidates
  src/lib/pipeline/generation/runtime-policy.ts:19-22   maxTotalCandidates: state.generationMaxTotalCandidates, maxTotalDispatches: state.generationMaxTotalDispatches
  ```
  所以生产里就是 config 的 5 / 16（`config.yaml:983-984`），兜底公式不生效。
- **每个候选内部**还能反应式重试：兜底公式自己给出的每候选预算是 `Math.max(16, 1 + maxRetries + maxLearningRetries)`（driver.ts:476）= `max(16, 1+5+32) = 38`。
- 按草案的族预算（网络 9 + 协商 5，且 learning 32 仍在），单候选最坏派发 = 1 + 9 + 5 + 32 = 47；保守地把 learning 剔除也有 1 + 9 + 5 = 15。
- **最坏总派发 = 11 候选 × 15 ≈ 165**（含 learning 则 ≈ 517）。草案的 32 只够 11 个候选每个 ~2.9 次派发。
- 换句话说：网络真的差到要用满 9 次流中断重试时，恰恰也是每条腿都要用网络重试的时候 —— **两个预算是相乘关系，草案按相加估了**。

**（c）预算耗尽时是硬崩不是降级**（客观事实）：

```
src/lib/pipeline/generation/generation-budget.ts:45   if (totalCandidates >= limits.maxTotalCandidates) throw new Error(`[generation-budget] total candidate budget exhausted before ${role}`)
src/lib/pipeline/generation/generation-budget.ts:53   if (totalDispatches >= limits.maxTotalDispatches) throw new Error("[generation-budget] total dispatch budget exhausted")
```
续写分支**有** try/catch 兜住这个 throw 并降级成 `continuation-exhausted`（driver.ts:1496-1512），但**透明重试分支没有**：
```
src/lib/pipeline/driver.ts:1460-1463
const coordinator = parent?.coordinator ?? createDriverCoordinator(deps, currentEnv)
const recovered = parent ? await coordinator.runRecovery(...) : await coordinator.runPrimary()   ← 裸 await，无 try
```
外层 `try { for(;;) ... } finally { sink.close?.() }` 只有 finally。于是预算在**透明重试**阶段耗尽 = 异常穿出 driver → handler 的 catch → 通用失败。抬到 9 次重试会让这条路径**从几乎不可达变成常规可达**。

**修法**：

1. `generationMaxTotalDispatches` 按 `候选上限 ×（1 + 族预算之和）` 推导取值，并把推导写进 §4.4（数字会随族预算变，写死一个 32 迟早再错一次）；
2. 透明重试分支补 try/catch，降级到与续写同族的显式终态（如 `recovery-budget-exhausted`），**绝不让预算异常穿到 handler 通用 catch** —— 预算耗尽是可预期的正常终局，不是意外（`never-swallow-errors` 的对偶：也不要把可预期终局伪装成意外崩溃）；
3. 更长远的正确形状：预算检查应该是 **admission**（开腿前问"还有额度吗"）而不是 **throw**，与 §4.5 的总预算检查点天然同构 —— 建议两者用同一个 admission seam，别造两套。

---

### M5 · Major · §4.2 新终态与 handler 既有分支阶梯的**优先级未定义**（现有阶梯有 4 个兄弟分支，且彼此的 "MUST precede" 关系是逐条论证过的）

**问题（客观事实）**：Anthropic handler 在 `outcome.kind === "complete"` 之后是一条 if/else-if 阶梯，每一支都带着"为什么必须排在这个位置"的论证：

```
src/routes/messages/handler-v4.ts:1442   if (acc.streamError)                    ← H2 上游终态 error 帧
src/routes/messages/handler-v4.ts:1461   else if (isContentlessRefusal(...))     ← 注释："MUST precede the truncation branch"
src/routes/messages/handler-v4.ts:1496   else if (env.ctx.unrepairableToolInput !== null)  ← 注释："MUST precede the truncation branch"
src/routes/messages/handler-v4.ts:1525   else if (!acc.sawMessageStop)           ← 截断 → 合成 error 帧
```

§4.2 的合成终止符**不会**经过上游轨 accumulator（它是我们造的），所以 `acc.sawMessageStop` 仍是 false → 落进 1525 的截断分支 → 客户端在我们的干净终止符之后**又收到一个 error 帧**。这正是记忆 `reference-exactly-one-terminal-is-not-exactly-one-complete-terminus` 的同族陷阱（"一个终态 ≠ 一个完整终止符"），也正是 1461 那条注释在防的东西（"appending a second one would hand the client `message_delta(end_turn)` followed by `event: error`"）。

**修法**：§4.2 必须给出新终态在这条阶梯里的**确切位置与理由**，并逐对说明与 refusal / unrepairableToolInput 的先后。我的初判（需实现期验证）：新终态应由 driver 的 outcome kind 承载（而非靠 acc 推断），在 handler 顶层与 `settled-abort` / `stream-error` 并列判定，**早于**整条 complete 阶梯；因为它是 driver 主动做的交付决定，不是从 acc 反推出来的诊断。`unrepairableToolInput` 与它可能共存（一个已提交 tool_use + 另一个块修复失败），需要显式定夺谁赢。

---

### M6 · Major · §4.2 的 `usage:<已累计>` 无定义，且 acc 每 attempt 被重置 —— "已累计"在续写之后并不存在

**问题（客观事实）**：`onAttemptReset` 在每次透明重试与每条续写腿前重建 accumulator：

```
src/routes/responses/ws.ts:70(plan 记录) / 各 handler
onAttemptReset: () => { acc = createResponsesStreamAccumulator(); eventsReceived = 0 }
src/lib/pipeline/driver.ts:1443 / 1491   opts.onAttemptReset?.()
```
所以在情形 2 触发的时刻，`acc` 里只有**最后一条腿**的 usage，而客户端已经收到了前面若干条腿提交的块。同时，每条续写腿都会把已提交前缀作为 assistant 轮**重发**（ADR D3 明写"重发整上下文 + 重新计费"），所以 input token 天然被多次计费。

**后果**：`message_delta.usage.output_tokens` 是 Claude Code 展示成本/进度的依据。填最后一腿 = 显著少报；填累加 = input 重复计入。二者都不是"对"，必须裁决并写死。

**修法**：§4.2 明确写出四件事：(1) `output_tokens` 取值定义（我倾向：**跨腿累加已交付块对应的 output**，因为这才对应客户端真的拿到的内容）；(2) `input_tokens` 定义（倾向：只报第一腿的，续写腿的重复 input 计入 History/telemetry 但不进客户端 wire —— 客户端的 usage 是"这一轮 assistant 消息"的，不是"我们花了多少"）；(3) 明说这两者会与 History 里的账不等，并说明为什么（presentation vs 记账，与 M7 同一原则）；(4) 需要一个**跨腿 usage 累加器**（当前不存在），这是 §4.2 的新增实现项，草案漏列。

---

### M7 · Major · 「History entry 记为正常完成」与仓库既有的诚实记账先例冲突，并会毁掉评估本特性有效性所需的指标

**问题**：§4.2 写「History entry 记为正常完成」。仓库里有一个形状**完全同构**的先例，结论相反 —— contentless refusal：客户端收到一个干净合成的 `end_turn` 轮，但记账仍是 fail：

```
src/routes/messages/handler-v4.ts:1483-1494
// The verdict is FAILED in every mode: the client receiving a clean synthesized turn is a
// PRESENTATION policy, not a claim that the turn produced anything.
env.ctx.fail(acc.model || model, new Error(summary), {...}, { upstreamSucceeded: true })
```

情形 2 的结构与它一模一样：客户端拿到干净终止符（presentation），但上游这条腿**确实被网络掐了**（事实）。

**后果**（这是我判断中最实际的一条）：如果记成功，`protect_streaming.by_vendor` 的成功率、History 的失败率、telemetry 的中断计数都会把"网络掐断"记成"正常完成"。而本设计的**验收依据**恰恰是"网络中断造成的伤害下降了多少"—— 把伤害记成成功，就再也无法验证本设计是否有效。这与项目「架构健康 / 可观测性 > 向后兼容」直接相关。

**修法**：把 §4.2 的记账拆成两个正交轴（沿用既有词汇）：客户端交付 = 干净（presentation），请求判定 = `fail` 或一个新的第三态，**并带 `upstreamSucceeded: false` + 新终态标签 `tool-boundary-terminated`**。§5 拍板 2「不向客户端插入任何文字提示」是对的、应保留 —— 但"对客户端静默"不等于"对 History/telemetry 静默"，草案把这两件事混成了一件。

---

### M8 · Major · 第四态未定义：已提交前缀 + **无** tool_use + 预算耗尽（草案的三腿覆盖不到，§4.5 的落点在该态下非法）

**问题**：§4.5 写「超预算行为：不再开新腿 → 落 §4.2 / §4.3 的优雅终止」。但当已提交前缀**没有** tool_use 且预算已尽时：

- §4.3（续写）按定义不可用（要开新腿）；
- §4.2 的终止符是 `message_delta{stop_reason:"tool_use"}` —— 对一个不含 tool_use 的前缀是**非法**的（客户端会去找工具调用，找不到）。

同一个态今天由 `continuation-exhausted` / `partial-degrade` 承载（driver.ts:1554-1556）并发 error 帧。草案把 error 帧路径删了一半（只讲了 tool_use 那一半），这一半悬空。

而且这个态在本设计下**变得更常见**，不是更罕见：预算从 3 抬到 9、总预算 3600s，意味着更多请求会走到"腿用完了但还没生成完"。

**修法**：§4 补第四态的显式定义。可选形状（需用户裁决，草案应摆出来）：

- (a) 合成 `message_delta{stop_reason:"max_tokens"}` + `message_stop` —— 语义上"内容没写完但轮结束了"，Claude Code 对 `max_tokens` 有既定处理路径，且仓库已有 max_tokens 续传的观测层（DESIGN.md `max-tokens-terminal-observer`）可复用；
- (b) 保持 error 帧（今天的行为），代价是客户端丢弃已提交内容；
- (c) 合成 `end_turn` —— **我明确反对**：这会把"被截断"伪装成"模型说完了"，客户端与用户都无从察觉，是 `never-swallow-errors` 与"合成帧必可辨识"（A4）的双重违反。

无论选哪个，都必须与 M7 一起裁决记账口径。

---

### M9 · Major · §4.3 Responses 续写缺 `sequence_number` / `response.id` 的跨腿一致性钩子；§4.2 的 Responses 分支对 §4.3 有未声明的实现顺序依赖

**问题（客观事实）**：

1. Responses 协议的**每个**事件都带单调递增的 `sequence_number`（`src/types/api/openai-responses.ts:286` 注释 + 其后每个事件类型都有该字段）。全仓 `src/` 下**没有任何一处重写它**（grep `sequence_number` 只命中 types 定义）。续写腿的上游会从头开始编号 → 客户端在同一条流里看到序号回退。§4.3 列的"三个格式钩子"（`response.created` 去重 / `output_item.added` index remap / 块起始判别）**不含**这一项。
2. 同理 `response.id`：ws.ts:466-468 会用 `acc.responseId` 注册 session；续写腿的 `response.completed.id` 会与首腿的 `response.created.id` 不同。
3. §4.2 的 Responses 侧要合成 `response.completed`（`output` 含已提交 item）。但 accumulator 每腿重置（M6），所以**必须**先有 §4.3 的 `extractResponsesCommittedBlocks` ledger 才能重建跨腿的 `output` 数组。草案把 §4.2 写在 §4.3 之前，且没声明这个依赖。

**修法**：§4.3 的钩子清单补 `sequence_number` 重映射与 `response.id` 归一（并注意记忆 `reference-ghc-responses-item-id-reencrypted-per-event`：跨事件关联要用 `output_index`/`call_id`，不能用 `item.id`）；§4.2 显式声明"Responses 分支依赖 §4.3 的 ledger 先落地"。**未验证**：我没有实测 Codex / `@openai` SDK 是否真的校验 `sequence_number` 连续性 —— 这需要一个探针（记忆 `methodology-probe-external-mechanism-before-writing-it-into-design`：写进设计前先跑探针）。

---

### M10 · Major · §4.0 推翻 WS terminal-only 的论证不完整：漏了原论证的两点、漏了 ADR 间的自相矛盾、也漏了它会让 plan-4 已锁的时序测试前提失效

**（a）ADR 自相矛盾，草案两个都列作"关联"却没裁决**：

- ADR 2026-07-11 决策 2 的表：Responses WS = **terminal-only**，依据"无中途块需求；且 close-code 时序与整响应恢复更契合"，并明写「这个非对称是**正确性要求**，不是妥协」（`docs/decisions/2026-07-11-block-level-buffered-retry.md:30,34`）。
- ADR 2026-07-22 D4：「**Responses WS 升块级**、CC 升块级」（`docs/decisions/2026-07-22-continuation-retry-sequential-anchor.md:53`）。

也就是说 §4.0 想做的事**已经被 D4 决定过了**，而 D4 与 2026-07-11 决策 2 直接冲突，仓库里没有谁 supersede 谁的记录。草案把两个 ADR 都列进"关联"，却把这当成一个**新论证**来打 —— 这是 `what-decided-is-decided` 的反面（重新论证已决之事）与文档一致性缺口的叠加。

**（b）原论证不止草案复述的那一条**。草案说 P4 Task 1 的论证是「块级提交会关掉重试窗口，提交后掉线只能降级半截生成」。ws.ts:372-385 的原注释还包含：

- 「WS has no mid-stream block/anchor needs」（WS 消费者是 Codex，不是逐块渲染的 CLI）；
- 「terminal-only ... is the correct — and only — shape here」，理由包含 close-code(1011) 与 commit/retreat 的时序。

**（c）更实质的**：plan-4 Task 2 明确记录，它锁的时序不变量是**建立在 partial-degrade 在 WS 上结构不可达之上**的：

```
docs/plan/2026-07-11-block-level-buffered-retry/plan-4-responses-ws.md:95
partial-degrade（原 (c) 的一支）在 WS 上也不可达——WS 不接 commitBoundaries，committedAny 恒 false。
```
块级化会让 `partial-degrade` / `continuation-exhausted` / `retreated` 在 WS 上**全部变得可达**，那三个锁测试的前提失效，需要重新推导 1011 与已提交帧的先后（"重试是透明的，客户端不该在重试间隙收到 1011" 这条不变量在续写腿存在时要重新表述）。

**（d）续写腿在 WS 上能否成立未验证**：WS 上游是长连接 session（`src/lib/openai/upstream-ws-connection.ts`），续写要求在同一个 generation 里**再开一次 dispatch**。这条路径没有任何现存生产调用点。**未验证** —— 这正是记忆 `methodology-appliesto-matches-but-chain-never-driven` 的形态（钩子接上了不等于链被驱动）。

**修法**：§4.0 的 WS 段重写为：(1) 先记录 D4 supersede 2026-07-11 决策 2（或反过来），并同步两份 ADR；(2) 逐条回应原论证的**全部**三点，而不只是重试窗口那点；(3) 把 plan-4 Task 2 三个锁测试列为必须重写的回归项；(4) 把"WS 上能否开续写 dispatch"列为前置 PoC 门（不是敞口，是门）。

---

### m1 · Minor · §6 O1 已可闭合（extractor 确实丢弃 `server_tool_use`），但 §4.3 新增的 Responses extractor 必须继承同一契约

**证据（O1 可闭合）**：

```
src/lib/anthropic/committed-block-extractor.ts:53-60
if ("_brand" in block || "_generic" in block) continue
if (block.type === "text") { ... } else if (block.type === "tool_use") { ... }
// thinking / redacted_thinking / server_tool_use → dropped (see docstring)
```
ledger 的谓词 docstring 也是同一断言（`src/lib/pipeline/committed-blocks-ledger.ts:33-38`）。所以 `hasCompleteInteractiveToolUse` 在 Anthropic 上**不会**被 `server_tool_use` 误触发，§2 C11 的担心与 O1 都可标记为"已核实、无风险"。

**但**：§4.3 要新增 `extractResponsesCommittedBlocks`，Responses 侧的等价问题（O2）**仍然开着** —— Responses 的 `function_call` item 与上游自执行工具（web_search 等）需要区分，否则情形 2 会在 Responses 上吞掉本该续写的场景。建议把这条契约提升为**共享不变量**并加守卫测试（记忆 `feedback-fix-all-comparison-sites`：这类判别谓词几乎总在多处复发）。

### m2 · Minor · §2 C5 与 §4.4 的族划分漏了已存在的第四族（learning）

**证据**：反应式预算今天**已经**是两族，不是"单一标量通吃"：
```
src/lib/pipeline/driver.ts:589   const overBudget = action.learning ? learningRetries++ >= deps.maxLearningRetries : normalRetries++ >= deps.maxRetries
src/routes/messages/handler-v4.ts:209-210   /** learning 预算 = 32 */ const MAX_LEARNING_RETRIES = 32
```
`effortLearning` 是 `RETRY_STRATEGY_CONFIG_KEYS` 里的一员（`src/lib/config/schema.ts:975`）但走的是另一条预算。§4.4 的三档表把它漏了；实现时"按 configKey 打族标签"会与既有 `maxLearningRetries` 撞车。

**修法**：§4.4 的表改成四族（流中断 / 网络 / 协商 / learning），learning 保持 32 并注明它已是独立预算、本次不动。

### m3 · Minor · `generation.recovery.max_candidates` 是死旋钮，而它的名字正好像是本设计要调的那个

**证据**：`config.yaml:979` 有 `recovery: max_candidates: 3`，config 会写进 state（`src/lib/config/config.ts:928`、`packages/foundation/src/state-defaults.ts:191`），但 `src/` 下**没有任何消费者**（grep `generationRecoveryMaxCandidates` 只命中 config/state 定义，无读取点）。

**为什么值得写进设计**：一个读 config 的人（或未来的实现者）会非常自然地认为"9 次恢复要把这个 3 抬上去"。要么接线（接线时必须 ≥11，见 M4）、要么删。按 `feedback-never-paper-over-smells-warn-loudly`，名实不符的旋钮应当当场处理而不是沉默。

### m4 · Minor · §4.0 表格里 WS 块级化指错了改动位置

**证据**：WS 的 `commitBoundaries` 不是在 `ws.ts` 里省略的，而是由 candidate session 按 transport 分发：
```
src/routes/responses/candidate-response-session.ts:140
...(transport === "http" && { commitBoundaries: (_state: unknown, frame: ClientFrame) => isResponsesCommitBoundary(frame) }),
```
`ws.ts` 里的省略只是注释说明。改动点是这个 `transport === "http"` 门。表格写错位置会让执行者去改错文件（→ 记忆 `methodology-plan-verify-interface-location-and-wiring-channel`）。

### m5 · Minor · ws.ts 现状与 plan-4 记录已不一致，WS 块级化会把块级谓词套到 via-CC-fallback 翻译流上（未验证组合）

**证据**：plan-4 Task 1 Step 3 记录落地版是 `const buffered = bufferedConfigured && !viaFallback`（`plan-4-responses-ws.md:48`），但当前代码是：
```
src/routes/responses/ws.ts:386-387
const { buffered: bufferedConfigured } = resolveResponsesBufferedAndHeartbeat()
const buffered = bufferedConfigured
```
`viaFallback` 仍存在（ws.ts:329/332/465/473）。ws.ts:384-385 的注释说明了原因（fallback 的收尾帧现在走 finish 边界）。**但**：块级谓词 + fallback 翻译流是一个**从未验证过**的组合（`response.output_item.done` 在 CC→Responses 翻译产物上的语义）。应并入 O3 并列为门而非敞口。

### m6 · Minor · §4.6 只提了后端 telemetry，未提前端与 doc 同步面

新终态要进 History 的终局枚举与 `ui-v4` 的展示。CLAUDE.md 的文档路由要求端点/终局这类事实有单一归属（`docs/API.md` / `docs/DESIGN.md`「活的架构现状」）。**未验证**：我没有查 `ui-v4` 是否对 outcome 做穷尽 switch（若是，加新终态会是编译错误，属好事；若是字符串透传则会静默显示未知值）。建议 §4.6 补一句"前端与 DESIGN.md 同步"作为验收项。

### m7 · Minor · §4.5「不打断进行中的腿」的退化情形没有草案想的那么糟，但预算判据仍要改成 admission 形式

评审提问里假设"一条腿跑 3000s 导致总预算形同虚设"。**实际单腿上限是有界的**：`responseHeaderTimeout: 300` + `streamIdleTimeout: 300`（`packages/foundation/src/state-defaults.ts:246-247`），加上模型级覆盖 `stream_idle_overrides.gpt-5.5: 600`（`config.yaml:248-249`）。所以最坏单腿约 600s 量级（首字节 300s + 之后每 600s 一个静默窗口 —— 严格上界取决于上游是否持续吐字节，**未验证**是否存在"持续缓慢吐字节因而永不触发 idle"的病态腿）。

**修法**：总预算判据写成 `now + 最坏单腿时长 > deadline → 不开新腿`（与 `hedge-policy.ts:128` 的 `nowMs + expectedHedgeCompletionMs + cleanupMarginMs >= requestDeadlineAtMs` 同构，直接复用该 seam），而不是裸比较 `now > deadline`。否则会出现"在第 3595 秒开了一条最长 600s 的新腿"。

### n1 · Nit · §4.4 表格的"现状"列把 `max_reactive_retries` 描述为"单一标量通吃全部反应式策略族"

见 m2，实际是两族。另外该列写「网络类……与协商类共用 `max_reactive_retries: 5`」在**名义上**成立，但（B2）实际绑定约束是策略内部硬闸，表格会误导读者以为改这个键就够。

---

## 3. 主观建议（预期影响，非失败场景）

| 位置 | 改进点 | 预期影响 | 推荐做法 |
|---|---|---|---|
| §4 整体 | 三情形是**用户语言**，代码的判别轴是「error class × commit state × retreat × 预算」四维 | 现在读者要自己在脑内做笛卡尔积，B4/M3/M8 三条 blocker/major 都是这个投影损失造成的 | 加一张四维穷尽表（可用穷尽 `Record` 让类型系统逼出全站点，见记忆 `methodology-route-variant-to-existing-outcome-and-exhaustive-record-audit`），三情形保留为该表的**读者视图** |
| §4.5 | 预算检查点写成"开新腿之前" | 现在有三处开腿（透明 / 续写 / 反应式）+ hedge 的既有 admission，四处各写一遍必然漂移 | 抽一个 `admitNewLeg(costEstimate)` seam，四处共用；与 M4 的候选/派发 admission 合一 |
| §4.6 | 只列了要加的维度 | 无法回答"这个特性有没有用" | 补一条**验收指标**：改动前后，"客户端收到 error 帧的请求占比"与"三腿各自救回的次数"。这也是 M7 记账口径的下游消费者 |
| §4.2/§4.3 | 未提测试如何证伪 | 合成终止符这类产物最容易出现"测试绿但 wire 错" | 明确要求：(1) 用**真实** `@anthropic-ai/sdk` 累积合成终止符（独立 oracle，别用自家 accumulator 自证）；(2) 每条腿写 mutation control（记忆 `methodology-verify-the-mutation-actually-applied`）；(3) 情形 2 的验收必须包含真 Claude Code 拿到终止符后**确实发出了 tool_result** |
| §3 A1 | 公理只说了"摧毁 live" | `retreated`（M3）与 hedge（M1）都是"事实上的 live 退路"，但不叫 live，于是逃过了公理扫描 | A1 的落地清单改为"枚举全部**把未缓冲帧写给客户端**或**绕过块级提交**的路径"，按行为而不是按名字扫 |

## 4. 草案里站得住、且我特意去证伪但没证伪的部分

按 `no-sycophancy`，这些是**查过之后**才写的，不是客套：

- **§4.2 的核心断言成立**：Anthropic 的 commit boundary 就是 `content_block_stop`（`src/lib/codec/anthropic/commit-boundaries.ts:16-22`），所以"已提交前缀恒为完整块序列 ⇒ 不存在半截块要闭合"是对的，合成 `message_delta` + `message_stop` 在结构上合法。（**唯一补充**：anchor 若已注入且未关闭，新终止符路径也必须调 `closeAnchorIfOpen`，见 driver.ts:1113-1125 与 handler-v4.ts:1400 的既有处理。）
- **§4.2 的方向被一份独立实证支持，草案自己没引用**：`docs/spec/2026-07-27-inter-block-keepalive-carrier.md` §2.2 记录，CC 2.1.207 打包源码显示 `content_block_stop` 时**立刻** yield 该块并 `addTool → processQueue → executeTool`，工具是 **eager per-block** 执行。也就是说情形 2 发生时客户端**已经在跑那个工具了** —— 今天发 error 帧等于让一次已执行的工具调用悬空。这是 §4.2 比 C2 现状正确的**强证据**，建议补进草案。
- **§4.1 的"零新机制"在其适用范围内是对的**：`!committedAny` 门确实已存在（driver.ts:1430），Anthropic 打开块级后自动生效。问题只在适用范围被高估（B4）。
- **§4.4 的候选数 12 够用**：见 M4(a) 的推导，最坏 11。草案的数字对，缺的是推导。
- **§5 拍板 1、3 合理**：零提交超预算返回错误是对的（没有内容可保时，静默成功是撒谎）；CC/Gemini 出范围 + 记 backlog 符合 `no-silently-cut-but-defer`（但 backlog 条目要补上 M2 的 translate leg）。

## 5. 对 §6 四个敞口的裁定

| 敞口 | 裁定 |
|---|---|
| **O1**（server_tool_use 归一） | **可闭合**，无风险。证据见 m1。但 Responses 侧的等价问题（O2）要继承同一契约 |
| **O2**（Responses 可交互 tool_use 谓词） | 仍然开着，且是 §4.2 Responses 分支的**前置**而非敞口。建议升级为门 |
| **O3**（WS 块级 × 帧序） | 开着，且范围被低估：还要含 M10(c) 的 1011 时序重推导、M10(d) 的 WS 续写 dispatch 可行性、m5 的 fallback 组合 |
| **O4**（统一时钟源"未核实"） | **可闭合**。已有两个可用起点：`ctx.durationMs`（reaper 在用，`src/lib/context/manager.ts:290`）与 `requestDeadlineAtMs`（`src/lib/pipeline/generation/runtime-policy.ts:8`，hedge 在用）。与 B3 一并解决 |

**§6 还漏了的敞口**（应补入）：hedge 失效（M1）、retreat 与三腿的关系（M3）、error-class 门（B4）、translate leg 零覆盖（M2）、派发预算耗尽的 throw 路径（M4c）、跨腿 usage 累加器不存在（M6）。

## 6. 建议的返工顺序

1. **先解 B3 的事实错误**（C6 改写 + §4.5 重写为扩展 `request_deadline`）—— 它最便宜，且会连带修正 §4.5 的全部数字。
2. **B2**（策略内部硬闸参数化）—— 这是用户头号诉求的**唯一**有效落点，且与 §4.0 正交，可独立先行。
3. **B4 + M3 + M8**（四维穷尽表 + retreat 归位 + 第四态定义）—— 这三条是同一件事的三个面：把"三腿"从用户语言翻译成代码判据。
4. **B1**（与 allocator 方案 A 的排序裁决）—— 需要用户拍板，建议单独提问，摆 3–4 个带量化影响的选项。
5. **M1 / M2 / M10**（公理落地的三个漏网路径 + ADR 冲突裁决）。
6. **M5 / M6 / M7 / M9**（§4.2/§4.3 的语义补全）。

## 7. 我的取证边界（明确标注未验证项）

- 我**没有**启动任何服务器、没有跑测试套件，全部结论来自源码、config、ADR/spec/plan/todo 文档与 `git log`。
- 明确标注为**未验证**的判断：M3 的"必然触顶 16 MiB"（累计口径是代码事实，触顶与否依赖真实生成长度）；M9 的"Codex/SDK 是否校验 `sequence_number` 连续性"；M10(d) 的"WS 能否开续写 dispatch"；m6 的"ui-v4 是否穷尽 switch"；m7 的"是否存在永不触发 idle 的慢腿"。
- 我**没有**复核 §2 的 C1/C2/C3/C4/C7/C8/C9/C12（并行 reviewer 的范围）；C5 / C6 / C10 / C11 因与架构结论直接耦合而顺带取证，结论见 m2 / B3 / B1 / m1。
- 本报告未修改仓库任何其他文件。
