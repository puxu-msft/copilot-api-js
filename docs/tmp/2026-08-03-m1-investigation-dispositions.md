# M1 调查结论 —— 两份评审的逐条处置表（2026-08-03）

- 被处置的两份报告：`2026-08-03-m1-investigation-review-gpt.md`（异模型，1 Blocker / 6 Major / 3 Minor）、`2026-08-03-m1-investigation-review-claude.md`（3 Blocker / 8 Major / 5 Minor / 2 Nit）。
- 处置人：主会话。**事实逐条独立复核后采纳，判断由我裁决**（skill `adopting-agent-findings`）。
- 级别栏用该 skill 的 A/B/C/D 表；标「暂定」的驳回按该表分流合议，**不交回原评审者**。
- 本表是 plan-3「M1 调查结论」修订版的唯一改写依据。**修订后必须再过一轮独立评审才可合主线、才可开工迁移。**

## 我自己独立复核过的事实（不采信单方断言）

| 断言 | 复核方式 | 结论 |
|---|---|---|
| 存在第 13 个 anchor-stop 写出点 `driver.ts:1317-1321` | 直接读码 | **成立**。它在 `if (retreated)` 的 live 写穿分支，每来一个真实 start 独立判定，与 flush 内的站点 11 不是同一处 |
| legacy 关闭不清 `openAnchorIndex` → owner 会写第二个 `stop@0` | 读 `session.ts:399/407` + 各站点守卫 | **成立**。今天靠共享 `anchorClosed` 幂等，M1 拆掉它而 owner 只认 `openAnchorIndex` |
| mint 守卫按**对象字面量**判、不是按类型 | 读 `package-boundaries.unit.test.ts:590-624` | **成立**。`kind:"stream-error"` 的构造点若外层函数名不是 `streamErrorOutcome` 即 offender |
| `recordFeature` 不落 History | 读 `request.ts:2109-2116` + 全部消费者 | **成立**。只 publish；消费者只有 WS 活体广播与 TUI 内存 store |

**我这轮漏掉第 13 个站点的根因（记入教训）**：枚举站点用的 grep 结尾带 `head -60`，`driver.ts` 的命中被截断在 `:1183`，我把**被截断的输出**当完整清单，在其上下了「共 12 个、没有第 13 个」的否定性断言。→ 否定性/完备性结论不自证。

## Blocker

| # | 发现 | 处置 | 级别 | 理由 |
|---|---|---|---|---|
| B-A | 漏第 13 站点；allowlist 在 M1 不可满足 | **采纳** | C | 已复核成立。① 改为 13 行，新增 `driver.ts:1317-1321`（retreat live 写穿的 close-before-real，`Promise<ResponseOutcome>`） |
| B-B | 站点 11/12/13 留 legacy 关闭 → 双写 `stop@0`，exactly-once 门不可满足 | **采纳，取修法 (c)** | C | 见下方「B-B 的裁决」 |
| B-C | decision 的 `kind:"stream-error"` 必触发 mint 守卫 → `test:fast` 门不可满足 | **采纳，取改名** | C | 判别式改 `"fail-loud"`。它本就不是 `ResponseOutcome`，共用词汇是误导；扩守卫 allowlist 会同时要求扩正样本对照，代价与风险都更高 |
| B-D | 性质 7 未满足：`FeatureKind` 不持久 | **采纳，载体改 `PipelineInfo`** | C | 见下方「B-D 的裁决」 |

### B-B 的裁决：把三处 legacy 关闭一并提前到 M1（评审列的修法 (c)）

否决另外两条：

- **(b)「让 legacy 关闭同步清 `openAnchorIndex`」——否决。** 它直接违反 P2 已立的架构守卫「生产代码不得在 owner 外读写 `openAnchorIndex`」（README 承重项 13）。为迁移期方便去松一条刚立的架构守卫，是拿架构健康换迁移便利，方向反了。
- **(a)「`closeAnchorViaOwner` 保留完整 legacy 前置守卫」——否决。** 它等于承认 owner 在 M1–M4 **不是**关闭权威，真正的幂等仍在 legacy 标志上。M1 的整个目标就是「close 权威 + exactly-once by construction」，(a) 把这个目标降级成措辞。

**采纳 (c)**：M1 迁移的是**这个 generation 的全部关闭者**（13 处），而不是「10 个终局站点」。M2/M4 仍然只负责各自腿的**分配 + remap**，与关闭解耦。

可行性已核：站点 11 在 `flushBufferedFrames` 内、站点 12 在装饰器内、站点 13 在 retreat 写穿分支内，三者都能调 `closeOpenAnchor(_, "before-real")`；owner 的 `"before-real"` 模式不停心跳（`session.ts:400` 只有 `"terminal"` 才 `closeHeartbeat`），故不会误伤后续真实块的保活。排序由同一 serializer FIFO 保证。

**连带修正**：
1. 「原子迁移红线」从按**站点**改写为按 **anchor**：同一个 anchor 的所有关闭者不得跨 legacy / owner 两套机制并存。
2. ④ 的 allowlist 随之简化：M1 后 = owner + injector 开侧 + live-reconcile 的**关闭判定**（`live-reconcile.ts:138` 仍写 `anchorClosed`，因为「要不要关」的判定留在纯函数里，M4 随 S3 事务一并迁走）；M4 后 = owner + injector；M5 后归零。
3. M1 的门里加一条**新** oracle：「legacy 关过之后 owner 再关必须得 `"none"`、wire 上只有一个 `stop@0`」——评审已核实**现存套件没有任何一条覆盖这个组合**（`anchor-multiblock-lifecycle.it.test.ts:494` 的两次关闭都是 legacy↔legacy）。

### B-D 的裁决：持久载体用 `PipelineInfo`，不用 `warningMessages`

评审给了三条备选，我选**新增 `PipelineInfo` 字段 + 一个 `ctx.record*` 方法**，照抄既有同形路径（`maxTokensContinuation` ← `ctx.recordMaxTokensTruncation`，`context/types.ts:524`；同族先例 `cacheControlStripped`、`askUserQuestionNormalization` 的注释原文就是「落 history 供全人群审计」）。

否决 `warningMessages`：它是自由文本告警，把结构化诊断塞进字符串会让事后无法聚合查询——而性质 7 要的正是「证据」，不是「提示」。`FeatureKind` 可以**并存**做实时可见性（richest-data-flow：两条轨都要），但持久性由 `PipelineInfo` 承担。

**覆盖面按 Major-6 一并修正**：诊断记录点必须同时覆盖 ① returned 的 client-gone（`committed:true`）与 ② 非 client 的 post-commit 撕裂（那条是 `throw DeliveryOwnerError`，绕过 classifier）。因此记录动作**下沉到 owner 的 commit-aware catch**，而不是放在翻译层——这同时解掉 Minor-1（「唯一记录一次」原本只是调用拓扑约定，下沉到产生点后才是真的一次）。持久 detail 冻结为 `{ operation, cause: "client-gone" | "wire-error", committed: true }`。

## Major

| # | 来源 | 发现 | 处置 | 级别 | 理由 |
|---|---|---|---|---|---|
| Ma-1 | gpt | ④「M4 后 allowlist 缩到 owner 一处」与裁决矛盾（injector 开侧活到 M5） | **采纳** | C | 已随 B-B 的连带修正 2 一并改写 |
| Ma-2 | gpt | ③ 用 C9 论证「owner 不可能同步发布镜像」是误读 | **采纳，改理由不改裁决** | C | 纯 (a) 技术可行（外壳里 `serializer.enqueue` 之前发布）。但混合裁决保留——理由改为「保持 delivery 层格式无关，不让 `injected`/`messageStartForwarded`/content-latch 这些 Anthropic prelude 语义进 owner」。错误的不可能性论证必须删掉 |
| Ma-3 | gpt | ⑥ 类型收紧按原样改 typecheck 真红（TS2322 → 加 overload 后 TS2769） | **采纳** | C | 「构造器写法留给实施者」保不住每步可编译。plan 必须同时写死 `ownerFailure` 与 `ownerUnavailable` 的改法（传对象字面量让判别联合生效），并标注这是 M1 的**同一个** commit |
| Ma-4 | gpt | ⑦ 支撑事实为假 | **采纳** | C | = B-D |
| Ma-5 | gpt | ⑧ 把 `OwnerOperation` 留给实施者不行 | **采纳，现在冻结六值** | C | 它已进公共签名 + 持久 detail 值域。采纳评审给的六值 union（`allocate-anchor` / `allocate-real-block` / `begin-leg` / `close-anchor-before-real` / `close-anchor-terminal` / `write-block-frame`），并加穷尽映射测试 |
| Ma-6 | gpt | ⑦ 漏非 client post-commit partial delivery | **采纳** | C | 已并入 B-D 的覆盖面修正 |
| M-1 | claude | `closeAnchorViaOwner` 签名拿不到 `ctx` | **采纳** | C | 签名补 `ctx`；并写死「`ctx` 为 `undefined` 时 `session-terminating` 视为**未 settle**、走 loud」——站点 1 的 `ctx` 确实可空，宁可吵不可静默吞 |
| M-2 | claude | 统一形状丢掉 settle 前的 `recordForwarded()`；站点 1 被倒置成 settle→snapshot | **采纳** | C | 统一形状改为 `if (d) { recordForwarded(); settleFromOwnerFailure(...); return }`；站点 1 的早退须移出 `finally` 辖域或让 `finally` 感知已 settle。这条与 B-D 叠加会让 partial-delivery 在 History 上彻底不可见，必须一起修 |
| M-3 | claude | driver 站点 9/10 的**无条件** `sink.close?.()` 在 owner 路径下退化为条件性 | **采纳** | C | 迁移时显式保留 `sink.close?.()`；plan 必须写出这条不对称（handler 侧 legacy 是条件性 close、driver 侧是无条件），不能用一句话概括两侧 |
| M-4 | claude | 转移表前言「owner 是唯一写者」已成假命题，对 `injected` 一列本就为假 | **采纳** | C | 改写前言为写者分工表，并与 ④ 交叉引用 |
| M-5 | claude | 「4 个可达组合各一条真实 HTTP oracle」至少一条不可构造、一条无先例 | **采纳，降级为分层验收** | C | 可从真实 HTTP 入口构造的照构造；构造不出来的（`session-terminating`×false / `wire-torn`×false）改为 owner 层 oracle + **明确记录它证不到站点接线**，不得把「造不出来」写成「已覆盖」 |
| M-6 | claude | wire-torn 下短路使客户端收不到任何终止符，与 C9「terminal error 仍可完成」张力未记录 | **采纳，且按 C9 直接定死行为** | C（原判 A，改判理由见下） | 见下方「M-6 的裁决」 |
| M-7 | claude | 未定义 owner `throw DeliveryOwnerError` 的处置；站点 5/8 本身就在无内层保护的 catch 里 | **采纳** | C | plan 必须逐站点写明对 throw 的处置。注意这不是纯新增风险（今天的 `writeAnchor` 也没 catch），但 M1 改变了抛出物与抛出条件 |
| M-8 | claude | 8 站点 settle 语义差异未被适配器吸收（站点 3 的 `upstreamSucceeded`、站点 1 的 ctx 可空、诊断优先级） | **采纳** | C | 适配器签名必须吸收这三个维度，否则会以「站点各自补参数」退化——那正是性质 1 要防的 |

## Minor / Nit

| # | 发现 | 处置 |
|---|---|---|
| mi-1 (gpt) | classifier「唯一记录一次」只是调用拓扑约定 | **采纳**，随 B-D 下沉到 owner 产生点后自然消解 |
| mi-2 (gpt) | 应禁止 `owner-failure.ts` import driver 的 `ResponseOutcome`/`RequestEnvelope` | **采纳**，M1 加边界守卫 |
| mi-3 (gpt) | 「无 owner 时与今天 inert 行为一致」只在字节层成立 | **采纳**，措辞收窄为「只承诺 client wire 字节等价」 |
| m-1 (claude) | M1 门给了 O-6 它证不到的信用 | **采纳**，写明 O-6 论域是无-anchor 主腿，有-anchor 的零变化挂到站点回归上 |
| m-2 (claude) | `types.ts:444` 是陈旧行号（实为 `:536-538`） | **采纳**，改正 |
| m-3 (claude) | 「5 个 `beginLeg` 调用点随签名更新」把两件事说成一件 | **采纳**，改为「`ownerFailureOutcome` 的 5 个调用点（恰好都紧跟 `beginLeg`）」 |
| m-4 (claude) | `delivery-finished` 写「不动」与既有分支静默分岔 | **采纳**，改为「不 settle，但仍 `recordForwarded()` 后 return」 |
| m-5 (claude) | 转移表缺 `writeBlockFrame` 那一行 | **采纳**，补一格 |
| n-1 (claude) | `OwnerOperation` 值域 | **采纳**，= Ma-5 |
| n-2 (claude) | 「纯分类器」称呼与承担副作用不符 | **采纳**，随 B-D 把记录动作移到 owner 后，classifier 恢复为真的纯函数 |
| 建议1 (claude) | 新旧两张站点表的 9/10 编号互换 | **采纳**，删掉旧表的编号列，编号权威唯一归 ① |
| 建议2 (claude) | 红线按 anchor 改写 | **采纳**，= B-B 连带修正 1 |

## 全部采纳，无驳回

### M-6 的裁决：短路是**按 reason 分**的，不是统一的（依据 C9 原文，非我的偏好）

我最初把这条标成 A 级「回用户」。重读 C9 原文后改判 C——**它已经被冻结契约定死了**，属于「适用性清楚、且我的裁定就是遵从既有决定」那一支，按 `what-decided-is-decided` 不重问：

> C9：非 client 撕裂把 generation 置为独立 `wireTorn`，五个 owner 入口此后统一返回 `{ok:false,reason:"wire-torn",…}`，**禁止后续分配但不关闭 session**，因此 **terminal error / close / finalize 仍可完成**。

owner 封锁的是**分配**，不是普通写；而各站点的错误帧走的是 `sink.writeSynthetic`，根本不经过 owner。所以正确行为是：

| reason | 站点该怎么做 | 依据 |
|---|---|---|
| `client-gone` | **短路**：零追加字节 | 客户端已走，写了也没人收 |
| `session-terminating` | **短路**：零追加字节 | 交付已终结 |
| `wire-torn` | **不短路**：跳过 anchor 关闭，但**照常写自己的终局错误帧**并按 failed settle | C9 明写「terminal error 仍可完成」；session 未关，写通道仍在 |

即性质 4 的「短路」必须写成**按 reason 分**，我原稿写成统一形状是错的。

**声明**：这条我用了「引用一手裁决后直接执行」而不是回问用户（skill `adopting-agent-findings` A 级的第二支）。若用户认为 C9 那句「terminal error 仍可完成」指的是 owner 的 terminal command 而非 handler 的错误帧，这条裁决作废、回到统一短路——**这是本轮唯一一处我按自己的读法解释了冻结契约，特此显式留痕以便否决。**

## 无驳回

本轮 **28 条发现无一驳回**（唯一非「照办」的是 M-6：事实采纳、但处置动作是「记录 + 回用户」而非我自行改 C9）。故无「暂定驳回」需要事后合议。

## 修订后的复审要求

修订稿是**指令类文本**，按 `instruction-text-must-be-reviewed` 必须再评审一轮：

1. 事实面回给两位原评审者复核「我的修复是否真的解决了你提的那条」——它们对自己的发现是当事方，但复核「修没修掉」是合适的。
2. **B-B 的裁决（把 13 处关闭一并提前到 M1）是新增的结构决定，必须交给未卷入的第三方**——原评审者只给了三选一，没给裁决。
3. M-6 回用户。
