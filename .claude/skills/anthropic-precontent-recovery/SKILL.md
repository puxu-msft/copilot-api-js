---
name: anthropic-precontent-recovery
description: 当正在设计、修改或排查 copilot-api-js 的 **post-commit / pre-content 内部重救**（B2 fresh dispatch）时使用——已 commit 200 但还没向客户端发出任何真实语义内容时，上游失败要不要重发一次全新 dispatch，以及这次重发的结果怎么缝进同一条已提交的流。触发形态：delayed-commit 之后想 fresh retry、`precontent_recovery` 配置键、`shouldAttemptPreContentRecovery` / `evaluateDirectRecovery` / recovery disposition（commit vs discard）、recovery 之后客户端收到两个 `message_start` 或同 index 两个 open block、`ServerExecutionRiskBlocksPreContentRecoveryError`、pre-ready 与 ready-live 两个挂载点判别。**裸的「上游静默」「clean EOF」「没收到 message_stop」不足以触发本 skill**——那些先看下面「不归本 skill」的三个邻域。
---

# post-commit / pre-content 内部重救（B2）

我方在上游还没回响应头时就 commit 了 HTTP 200（delayed-commit），于是「commit 之后失去内部恢复能力」成了架构缺陷：上游此后死掉，客户端只能看见一条已经开头的、再也不会有内容的流。B2 是对这个缺陷的正面修复——**在「已 commit」与「客户端已看到真实语义内容」之间的那段窗口里，上游确定性死亡时发起一次全新 dispatch，把它的真实内容缝进同一条已提交的客户端流。**

## 不归本 skill（先看这三条，别抢邻域的活）

| 症状 | 归属 |
|---|---|
| h2 stream reset / GOAWAY / transport close / 上传卡住 / TLS·代理握手 / 上游 session teardown | skill `debugging-ghc-api-upstream-transport` |
| CC 客户端的三层 timeout、keepalive 节律、SDK `SSEDecoder` 丢帧、200+SSE-error 零重试、事后判别一条 abort 的中止方 | skill `debugging-claude-client-connection` |
| thinking signature 400 / thinking 块布局三约束 / contentless refusal / tool_use 降级 / server_tool_use 400 | skill `ghc-anthropic-upstream` |

这三个 skill 各自完整、本 skill **只引用不复制**它们的内容。判别句：**你问的是「上游为什么死」还是「客户端为什么断」→ 那是它们；你问的是「死了之后我方要不要重发、重发的结果怎么拼」→ 才是这里。**

## 动手前必读的权威来源（本 skill 不复制状态）

本 skill 只维护**稳定的操作合同**。哪条腿已落地、哪条还没接线、当前默认值是多少、测试有多少条——**一律不写在这里**，因为它们会变而 skill 不会自己更新。开工先读：

- [`docs/DESIGN.md`](../../../docs/DESIGN.md) 的「活的架构现状」表——**当前活/wip/bypass/退役路径以它为准**。
- [`docs/spec/2026-07-23-upstream-silence-commit-timing.md`](../../../docs/spec/2026-07-23-upstream-silence-commit-timing.md)——权威 spec。
- [`docs/plan/2026-07-23-upstream-silence-recovery/README.md`](../../../docs/plan/2026-07-23-upstream-silence-recovery/README.md)——**Global Constraints 节是硬约束的单一来源**，包括下面第一条冻结原则的原文。
- [`docs/plan/2026-07-23-upstream-silence-recovery/task-4.3b-implementation-report.md`](../../../docs/plan/2026-07-23-upstream-silence-recovery/task-4.3b-implementation-report.md)——已落地部分的实施报告。
- [`docs/todo/deferred-backlog.md`](../../../docs/todo/deferred-backlog.md)——暂缓项与未接线的敞口。

配置键 `anthropic.precontent_recovery.enabled` 的**生效值按实例取**（`GET /api/config`），不要照抄 `config.yaml` 或 `packages/foundation/src/state-defaults.ts` 里的值——那两处一个是声明值、一个是优先级更低的 code fallback。

## 冻结原则：绝不误杀合法长思考

**这是用户 2026-07-23 定的硬约束（`never-false-kill-legit-thinking`），凌驾其他取舍；放宽它需要新的用户裁决，不是实现选择。** 原文在上面 plan README 的 Global Constraints 节。

合法的 heavy-thinking 会 deferred-header——上游可以几十上百秒不回响应头，**时长无上界**，而且在 commit 时刻与「真挂起」**信号同形、不可区分**。由此推出两条：

1. **B2 只在上游确定性死亡时重发**。确定性死亡 = 连接已经死了（RST / transport close / clean EOF），此时重发不放弃任何还在进行的思考。
2. **凡是不能证明上游死亡的中止，一律不重发**——header-wait timeout、request deadline、stale reaper、request/dispatch cancel、以及**没人打标签的 unknown abort**。连接可能还活着、上游可能正在合法思考，re-dispatch 会让它从头重算 = 误杀。

代码里这条落在 `shouldAttemptPreContentRecovery`（`src/routes/messages/precontent-recovery-gate.ts`）的 `abort` 分支：**每一种 `PostCommitAbortKind` 都显式 `return false`**，并用 `satisfies never` 逼将来新增的 kind 必须显式表态。**改这个 switch 之前先回去读那条冻结原则**——把某个 kind 改成 `true` 就是在推翻用户裁决。

HTTP 侧同理是**白名单**而非黑名单：只有既有的可重试 A 分类（`server_error` / `upstream_rate_limited` / `rate_limited`）放行，bad-request / auth / quota / content-filter / payload / token-limit 全部 fail-closed。

**server-tool 执行风险 fail-closed**：fresh dispatch 前必调 `classifyServerExecutionRisk`（`src/lib/pipeline/generation/hedge-policy.ts:153`），只有 `kind === "none"` 才放行，否则抛 `ServerExecutionRiskBlocksPreContentRecoveryError`（`src/lib/pipeline/driver.ts:256`）。**禁止**用 hedge 的 `allowServerTools:true` 绕过——那是 hedge 的宽松开关，安全等级不同。注意它检查的是**实际要发的那条 recovery wire**（`outboundPrepareWire`），不是原始请求。

## 语义交付门：窗口什么时候关上

判据只有一个观测量：`DownstreamDeliverySession.hasEmittedRealClientContent`（`src/lib/pipeline/delivery/session.ts`）。它**单向不可逆**地翻转，读取口是 `hasDeliveredSemanticContent`（`src/lib/pipeline/generation/semantic-content-gate.ts`）。

翻转条件（`applyWireFrame`，`session.ts:267-278`）三个都要满足：帧 provenance 是 `candidate`、**不带 synthetic 标记**、且是真实 content 帧**或** `content_block_start`。

三条最容易搞错的：

- **真实 `content_block_start` 就算已交付，不必等第一个 delta。** 一个真实块的开启已经是不可逆的客户端可见协议结构；不把它算进去，fresh attempt 就会在同一个 index 上开第二个块、与 primary 还开着的块打架。
- **不要等 `content_block_stop`。** 「delta 已发、stop 未到」是一个真实存在的窗口，按 stop 判会漏掉它并重复内容。这是评审第一轮抓到的 CRITICAL，别改回去。
- **synthetic 不关窗口。** keepalive、synthetic message_start、anchor 都带 synthetic 标记，它们不是内容。同理，**candidate provenance 下带 synthetic 标记的 content delta 也不得翻转这个 flag**——tagged synthetic 帧混在 candidate 轨里是真实存在的形态。

**读不到 raw delivery session 的调用方必须 fail closed。** 少救一次，比把已经发给客户端的内容重放一遍轻得多。

## 两个挂载点：pre-ready 与 ready-live

它们在代码里是**两条完全不同的落点**，覆盖其中一个不等于修好了原始事故形态：

| | pre-ready | ready-live |
|---|---|---|
| 形态 | `driver.runRequest()` 从未 ready（delayed-commit 期间上游就死了），**没有** `CoordinatedCandidate` | 已有 ready 候选，只是响应流失败（live pump 的 stream-error / buffered 耗尽） |
| 执行器 | `coordinator.runRecoveryFromPreReadyFailure` | 复用既有 `coordinator.runRecovery` |
| driver 入口 | `runPreContentRecovery`（`src/lib/pipeline/driver.ts:517`） | `runResponseRecovery`（同文件 `:531`） |

**B2 不是 continuation 的变体。** 它是新拓扑（pre-ready failure、无 `CoordinatedCandidate`），不得包装成 `runContinuation`——后者要求 `committedAny === true` 且已有 ready parent。

## evaluator / owner / disposition：谁有什么权力

这套分层的全部意义是：**recovery 的结果在被判定为「完整」之前，一个字节都不许上 wire。**

- **evaluator**（`evaluateDirectRecovery`，`src/routes/messages/precontent-recovery-evaluator.ts`）把候选驱到一个**只有 `write`、没有任何终端能力**的 collector 里，帧全部攒在内存数组。它的返回类型 `RecoveryAttemptEvaluationResult` 是**穷尽且 authority-free** 的：`complete` / `upstream-error` / `response-stream-failure` / `truncation` / `settled-abort` / `refusal` / `unrepairable-tool-input` / `delivery-finished` / `unexpected-throw`。**evaluator 没有 client 权、没有 winner 权、没有终端权**——它只报告。
- **只有 `complete` 才进入 owner 的 C9 批量发布。** 其余每一种都必须走 `disposition.discard()`。注意 `complete` 本身还要过四道内部检查（`acc.streamError` → `upstream-error`；contentless refusal → `refusal`；`unrepairableToolInput` → `unrepairable-tool-input`；`!sawMessageStop` → `truncation`），**这四道在 evaluator 里，不要在调用方重造一遍**。
- **disposition 是一次性状态机**：`pending → committing/discarding → committed/discarded`，重复处置直接抛。`commit()` / `discard()` 抛错落到 `failed-clean`。**不要把 disposition 当成幂等的清理函数。**
- **C9 是 owner 侧的同步边界**——它紧挨着第一次外部 wire 写之前（`src/lib/pipeline/delivery/session.ts:375-378`）。所有帧/provenance 转换在 C9 之前完成，`commit()` 之后才开始真正写。
- **C9 之前允许回退到 primary，C9 之后绝不允许。** 跨过 C9 后客户端可见性已不可撤销；此后的 cleanup 失败**不能**把结果降级回 primary fallback（`src/routes/messages/handler-v4.ts:582`）。owner failure 带着「是否跨过 commit 点」的标签正是为这条服务（`session.ts:108`）。

## 三种 keepalive 模式的 wire 拼接

recovery 的帧要缝进一条**已经开始的**客户端流，所以拼接方式取决于这条流之前发出去的是什么形状的 keepalive。

**先记住一条与模式无关的通用规则：客户端 turn 至多一个 `message_start`（wire 硬性禁止两个）。判据是「此前有没有 start 已经出去过」，不是「这个 start 属不属于 recovery」**：

- **已经转发过 start**（primary 的真实 start，或注入的合成 prelude start）→ **丢掉 recovery 的那个**。
- **一个 start 都还没出去**（典型：pre-ready 挂载点 + `ping` 模式，此前只发过裸 ping）→ **recovery 的 start 就是客户端的首个 start，必须放行**。

三条分支实现的是同一条规则的不同情形：`src/lib/anthropic/live-reconcile.ts:98-101`（无 hooks 的 `ping`）与 `:111-117`（有 hooks 但未注入 prelude）都是**条件丢弃**（`if (state.messageStartForwarded) return []`）；`:121-123` 是**无条件丢弃**，因为注入的合成 start 已经开过这个 turn 了。

**别把 dedup 当成 `enveloped_ping` 的专属动作**：ready-live 挂载点下 primary 可能早就发出了**真实**的 `message_start`，此时哪怕是 `ping` 模式也必须丢掉 recovery 的那个（回归见 `tests/routes/messages/precontent-recovery-matrix.it.test.ts:1012-1037`：客户端最终看到的是 `msg_primary`，不是 recovery 的 id）。**反过来也别过度推广**：pre-ready + `ping` 的场景里 recovery 的 start 正是客户端首个 start（`exp/silence-recovery-b2-vs-b5/FINDINGS.md:19`），丢了它客户端就收不到 turn 开头。

**模式之间真正的差别只有一处：要不要 close anchor + index remap。**

| 模式 | 已经发到客户端的东西 | 除通用 dedup 外还要做什么 |
|---|---|---|
| `ping` | 只有 `event: ping` | **无**——没有 anchor，也就没有 close 与 remap |
| `enveloped_ping` | 一个合成的 `message_start` + ping | **无**——只注入了信封，没有 anchor 块占住 index 0，真实内容按**原 index** 通过（`live-reconcile.ts:126-128`） |
| `empty_text` | 合成 message_start + 一个 anchor 空 text 块 + 空 delta | **close anchor + index remap**：先关掉锚点块，新内容的 block index 整体 +1 |

**`anchor remap` 不是 B2 的通用前提**——只有 `empty_text` 需要它。三种 wire contract 的实测表在 `exp/silence-recovery-b2-vs-b5/FINDINGS.md`；注意该 FINDINGS 的 `ping` 场景是「fresh start 就是客户端首个 start」的较窄情形，**不覆盖 primary 已先发 start 的 ready-live 形态**，后者以上面那条回归为准。

**三条边界情况各有明确归宿**（别 fall through 到一个笼统的失败）：

- **commit 失败**（C9 之前）：候选 discard，回退到 primary 的终态。
- **wire torn**（C9 之后写失败）：`wireTorn` 标记 + `recordPartialDelivery(operation, "wire-error")`，**不回退**。
- **client gone**（写的时候客户端已走）：走 `finalizeAfterClientGone()`，按是否跨过 commit 点分别记 partial delivery。

## History 与可观测性

按 `richest-data-flow`（ADR `docs/decisions/2026-07-05-richest-data-flow.md`）：合成的 fresh-retry attempt 必须**完整**落 History——独立的新 attempt、`upstreamRequest`/`upstreamResponse` 忠实字节、外层 verdict 忠实反映「内部救援已发生」。别为了 DRY 或「没人消费」裁剪。

计数器在 `src/lib/anthropic/protect-streaming-stats.ts`（`precontentRecoverySuccess` / `precontentRecoveryExhausted`）。**计数器只接了部分路径时会恒打零**——看到某个计数一直是 0，先证明那条路径真的调了它，别直接当成「功能没触发」。

一切 settle 点必须在**真实结算时机**记录，不得靠事后补丁重建（skill `persistence-async-invariants`）；`onAttemptReset` 语义与既有 continuation / buffered-retry 一致——不清累积状态、只清 per-attempt 临时态。

## 验收怎么做才算数

- **从真实 handler 入口驱动**，读客户端实际收到的字节。把 kind 直接喂给 formatter、或在测试里自造 sink/session，**证明不了活路径在读那张表**——这个坑在本项目连续咬过多轮。
- **wire order 用独立 oracle**：真实 `@anthropic-ai/sdk` 消费我方输出（`tests/e2e-client/`）。自洽 golden 会把缺陷输出一起锁住。
- **两个挂载点各自覆盖**，别用其中一个的绿推另一个。
- **协议级矩阵**：三种 keepalive 模式 × {primary 失败 / recovery 失败 / abort / header-timeout / budget 耗尽} × 两个挂载点。
- **首次写失败与第 N 次写失败要分开测**——C9 前后的语义不同。
- **mutation 打在共享判据上**（gate、semantic flag、拼接函数），不是打在测试自造的替身上；并确认变红来自目标机制而非旁路断言。

**离线的 wire/控制流验收，永远证明不了「真实 GHC 请求一定能被救回」。** 它只证明「给定这种失败形态，我方的判定与拼接是对的」。

**要主张后者，必须交出一条完整的观测链，四环缺一不可**（少任一环都只是「一个普通请求成功了」）：

1. **primary 在 post-commit / pre-content 窗口内确定性死亡**——有证据表明它死在 commit 之后、且 `hasEmittedRealClientContent` 仍为 false（不是任何一种 abort/timeout，那些本来就不该触发 B2）。
2. **fresh dispatch 真的发生了**——**证据必须能按 request/entry id 归属**：该 entry 里出现独立的第二个 attempt（带自己的 `upstreamRequest`/`upstreamResponse`），或该请求自己的 trace/日志事件。**全局计数器的增量不算**——它不携带 request identity，并发请求的增量无法排除；计数器只能作为「这条路径整体上被走过」的旁证，不能填这一环。
3. **该 dispatch 产出了客户端可见的完整终态**——真实客户端收到完整、可解析、有终止符的响应。
4. **上面三点属于同一个请求**——用 request/entry id 串起来，不是三份各自的证据。**这一环反过来约束前三环的取证方式：任何拿不到 request id 的证据形式，一开始就不该用。**

**明确会被合理化的那条路，提前堵死**：「我打到了真实 GHC，跑通了」——如果没命中 B2 seam（primary 根本没在那个窗口死），它只证明普通请求成功，**对本机制零信息量**。同理，「离线故障矩阵全绿 + 真实 GHC 冒烟通过」两件事拼在一起**也不构成**这条链——它们各自都缺环。

离线故障矩阵仍然是有价值的**机制层证据**，只是它回答的是另一个问题。

## 常见误判（每条都真实发生过）

1. **把 timeout 当成上游死亡**——最高频、也最贵。它正是冻结原则要防的那件事。
2. **只看 delta、不看真实 `content_block_start`**——于是在同一 index 上开出第二个块。
3. **逐帧直接往 wire 上写 recovery 的产物**——绕过 C9 批量发布，得到一条半新半旧的流。
4. **C9 之后还想回退到 primary**——客户端已经看见了，回不去。
5. **拿 tagged synthetic 的 content delta 去翻转语义交付 flag**——窗口被提前关死，该救的救不了。
6. **把 keepalive 模式的差别记反**——两个方向都踩过：以为 `anchor remap` 是通用前提（`ping` 模式下多做一次 remap 会把 index 错开），或以为 `ping` 模式「什么都不用做」（漏掉 message_start dedup，ready-live 下客户端会收到两个 start）。**dedup 是通用的，remap 只归 `empty_text`。**

## 自验：本 skill 需要实战检验的断言

以下断言在写作时无法自证，只能靠**未来会话在正常使用中顺手观察**来证伪。观察到一条就往 [`verification-log.md`](verification-log.md) 追加一行（记录协议以该文件为准，此处不复述）。**本 skill 的作者不能给自己投证实票。**

| # | 断言 | 证实长什么样 | 证伪长什么样 |
|---|---|---|---|
| V1 | description 的**组合**触发词够准：碰到 B2 相关工作时它自己浮现 | 未被点名就召回，且是在动手改 gate/evaluator/拼接**之前** | 只有被人点名才召回；或改完才想起来 |
| V2 | 它**不抢**三个邻域的活 | 纯 h2/GOAWAY、纯 CC watchdog、纯 thinking-400 的场景下它不出现 | 它被召回并把人引去看 gate，而问题在邻域 |
| V3 | 「先读权威 docs」这条真的被执行 | 使用者报出的路径状态来自 DESIGN/backlog，而非本 skill | 使用者照本 skill 推断某腿已落地 |
| V4 | 「离线验收不外推」这条挡得住 | 有人被这条挡住，明确说出四环观测链里缺了哪一环 | 离线全绿被当成真实效力的证据交付；或用「打到了真实 GHC」冒充（未命中 B2 seam）
