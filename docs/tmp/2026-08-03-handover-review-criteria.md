# HANDOVER 判据证伪评审

被审对象：`/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md` 与同目录 `KICKOFF.md`。

冻结文档基线：master `b7504c51d94dd031bfb674a6fe1a0637c59297ef`。

裁判轴：长远正确 + 完整；每项以独立命令证据裁决，不采信文档自述。

## 验收矩阵

- 硬事实表逐行：P0/P1/P2/P6、M1、`ClientSink`、`beginLeg`/`noteWinner`、terminal 调用点、session 生产引用、keepalive 默认值、O-6 门。
- 状态与数字：21 次连跑口径、`cc909c81` 后是否仅文档提交、所有数字的对象/范围/commit/生成命令。
- 待办 T1–T6：验收判据与证伪方式能否同时拒绝错误状态并接受正确状态。
- 冻结上游文档对账：检索范围和关键词能否支撑否定性断言。
- KICKOFF：是否忠实转述 HANDOVER，且启动 gate 可执行。

## 发现

### 已闭合证据：基线与分支状态

命令与原样输出：

```text
$ cd /home/xp/src/copilot-api-js && pwd -P && git rev-parse --show-toplevel && git rev-parse HEAD && git show-ref --heads master feat/inter-block-anchor-allocator
/home/xp/src/copilot-api-js
/home/xp/src/copilot-api-js
b7504c51d94dd031bfb674a6fe1a0637c59297ef
2c3397847b3d85eebfe32e794d3ad700cb00e1f4 refs/heads/feat/inter-block-anchor-allocator
b7504c51d94dd031bfb674a6fe1a0637c59297ef refs/heads/master

$ cd /home/xp/src/copilot-api-js/.worktrees/anchor-alloc && pwd -P && git rev-parse --show-toplevel && git symbolic-ref --short HEAD && git rev-parse HEAD && git log --oneline master..feat/inter-block-anchor-allocator
/home/xp/src/copilot-api-js/.worktrees/anchor-alloc
/home/xp/src/copilot-api-js/.worktrees/anchor-alloc
feat/inter-block-anchor-allocator
2c3397847b3d85eebfe32e794d3ad700cb00e1f4
2c339784 Merge branch 'master' into feat/inter-block-anchor-allocator
854421d4 Merge branch 'master' into feat/inter-block-anchor-allocator
e744f59d docs(review): record the recheck round that kept the capability-boundary major open
920d9c1e docs(review): two reviews of the owner/wire boundary design
08131f59 docs(review): third-party adjudication of the M1 guard axis
6fb9ed67 docs(review): M1 code review from two orthogonal perspectives
1cccb846 fix(delivery): preserve owner failures and close-site oracles
6333d800 feat(delivery): repeatable anchor lifecycle and close authority in the wire owner
```

判定：HANDOVER:29 的“M1 代码在分支上未合并”成立；该命令确有 8 个 feature-only commit，且 master 与 feature tip 均与文档相符。

### [minor] HANDOVER:3 的“核验基线 master `98e6875e`”在被审提交自身已过期

断言原文：`核验基线：master 98e6875e（2026-08-03）`。

命令与原样输出：

```text
$ cd /home/xp/src/copilot-api-js && pwd -P && git rev-parse --show-toplevel && git rev-parse HEAD
/home/xp/src/copilot-api-js
/home/xp/src/copilot-api-js
b7504c51d94dd031bfb674a6fe1a0637c59297ef
```

判定：不成立。HANDOVER 所在 master 提交就是 `b7504c51`，不是 `98e6875e`；虽然差异仅为该 handover commit，但“当前核验基线”必须锚定自身落地后的 HEAD，否则接手者第一步就看到自相矛盾的基线。

建议改法：改成 `b7504c51`，并区分“事实复核所用代码基线 `98e6875e`”与“交接文档落地提交 `b7504c51`”。

### 已闭合证据：`cc909c81` 后提交类型

命令与原样输出：

```text
$ cd /home/xp/src/copilot-api-js && git log --format='COMMIT %H %s' --name-status cc909c81..master
COMMIT b7504c51d94dd031bfb674a6fe1a0637c59297ef docs(handover): the RFC half is done, the plan half is not
M docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md
M docs/plan/2026-07-27-inter-block-anchor-allocator/KICKOFF.md
COMMIT 98e6875edae2ec1d8d00808cdab677e1f7f0dc5b docs(rfc): pin the four edges of the structural stop, including the one that made `as any` a door
M docs/rfc/2026-08-03-generation-emission-command-algebra/design.md
COMMIT 580fa2586bdc98ccbd806c6652c92eee4f109577 docs(rfc): make the downward closure stop on structure, not on my judgement
M docs/rfc/2026-08-03-generation-emission-command-algebra/design.md
COMMIT 1ffb88f53477ab16124b253aa9a5db92c4d68167 docs(tmp): 21 green runs, and what they do and do not establish
M docs/tmp/2026-08-03-baseline-flake-status.md
COMMIT 9dcf1fa4c2032c0d03414ccc819ab8f66aae6e0a docs(rfc): close the capability closure downward as well, or the allocator escapes it
M docs/rfc/2026-08-03-generation-emission-command-algebra/design.md
COMMIT ce05b05653e4ad09334fb26fab10475c190b6546 docs(tmp): record the real cause of the phantom out-edge, and correct my own guess
M docs/tmp/2026-08-03-baseline-flake-status.md
```

判定：`cc909c81` 之后至被审 master `b7504c51` 的 6 个提交均只改文档，因此 HANDOVER:6/KICKOFF:49 将 21 次测试口径锚定到代码状态 `cc909c81` 未被后续生产代码提交作废。21 次是否确实执行并全绿仍需独立核验其原始记录。

### 已闭合证据：分支硬事实的代码位置

以下命令均在 feature worktree gate 下运行：

```text
$ cd /home/xp/src/copilot-api-js/.worktrees/anchor-alloc && pwd -P && git rev-parse --show-toplevel && git symbolic-ref --short HEAD && git rev-parse HEAD
/home/xp/src/copilot-api-js/.worktrees/anchor-alloc
/home/xp/src/copilot-api-js/.worktrees/anchor-alloc
feat/inter-block-anchor-allocator
2c3397847b3d85eebfe32e794d3ad700cb00e1f4
```

`ClientSink`：

```text
$ rg -n 'ClientSink' src/lib/pipeline/types.ts src/lib/pipeline/delivery/types.ts
src/lib/pipeline/delivery/types.ts:5:  ClientSink,
src/lib/pipeline/delivery/types.ts:12:export interface OwnerRawSink extends ClientSink {
src/lib/pipeline/types.ts:747:export interface ClientSink {

$ perl -ne 'printf "%6d %s", $., $_ if $. <= 24' src/lib/pipeline/delivery/types.ts
     1 import type { ClientFrameEnvelope } from "../stream/frame-envelope"
     2 import type {
     3   //
     4   ClientFrame,
     5   ClientSink,
     6 } from "../types"
...
    12 export interface OwnerRawSink extends ClientSink {
...
    16 export type {
    18   LegToken,
    19   OwnerResult,
    20   WireBlockAllocationPort,
    21   WireBlockMapping,
    22   WireEnvelopeFactory,
    23   WireWriteSpec,
    24 } from "../types"
```

判定：HANDOVER:30 在 feature `2c339784` 上成立。`ClientSink` 恰声明于 `pipeline/types.ts:747`；`pipeline/delivery/types.ts` 只通过 `import type` 引入它，export type 清单不含它。注意文中缩写 `delivery/types.ts` 不足以唯一定位，实际路径是 `src/lib/pipeline/delivery/types.ts`。

`beginLeg`／`noteWinner`：

```text
$ perl -ne 'printf "%6d %s", $., $_ if $. >= 882 && $. <= 889' src/lib/pipeline/driver.ts
   882     const source = { candidateId: String(selected.candidate), dispatchId: String(selected.dispatch) }
   883     const allocationPort = outerOpts?.wireAllocationPort ?? getDownstreamDeliverySession(sink)?.allocationPort
   884     if (allocationPort?.wireState) {
   885       const leg = await allocationPort.beginLeg("primary", source)
   886       if (!leg.ok) return ownerFailureOutcome(leg, "begin-leg", env)
   887     }
   888     getDownstreamDeliverySessionForPortOrSink(outerOpts?.wireAllocationPort, sink)?.noteWinner(source)
```

判定：HANDOVER:31 成立。`beginLeg` 位于 `allocationPort?.wireState` 条件内；`noteWinner` 不受该条件门控，但仍受 optional chaining 的 session 存在性约束。“无条件”应理解为“不受 wireState 条件限制”，不是绝对必调用。

terminal close：

```text
$ bun -e '<TypeScript AST：枚举 src 下 callee 名为 closeAnchorViaOwner 且参数含字符串 terminal 的 CallExpression>'
count=10
src/lib/pipeline/driver.ts:1436
src/lib/pipeline/driver.ts:1611
src/routes/messages/handler-v4.ts:702
src/routes/messages/handler-v4.ts:1464
src/routes/messages/handler-v4.ts:1584
src/routes/messages/handler-v4.ts:1623
src/routes/messages/handler-v4.ts:1688
src/routes/messages/handler-v4.ts:1808
src/routes/messages/handler-v4.ts:1848
src/routes/messages/handler-v4.ts:1893
```

判定：HANDOVER:32 成立。独立 AST 计数恰为 10，列出的 8+2 个行号逐个正确。集合边界由 HANDOVER:37 给出，但该行仍缺 feature commit 与生成命令，见后续数字 provenance 发现。

session 反查：

```text
$ bun -e '<TypeScript AST：枚举 src 下 getDownstreamDeliverySession(...) CallExpression>'
count=9 files=4
src/lib/pipeline/driver.ts:883
src/lib/pipeline/driver.ts:944
src/lib/pipeline/driver.ts:1012
src/lib/pipeline/driver.ts:1097
src/lib/anthropic/keepalive-anchor.ts:280
src/lib/anthropic/live-reconcile.ts:139
src/routes/messages/handler-v4.ts:1112
src/routes/messages/handler-v4.ts:1422
src/routes/messages/handler-v4.ts:1772
```

判定：HANDOVER:33 的“约 10 点”可接受为 9 个生产调用点，但“5 文件”不成立：调用点只在 4 个文件；若把定义文件 `pipeline/delivery/session.ts:90` 算进去才是 5 文件，而定义不是“生产引用”。

### [minor] HANDOVER:33 混用了调用文件与定义文件，集合口径不实

断言原文：`生产引用 5 文件约 10 点`。

证据同上：AST 得到 `count=9 files=4`；文本检索另有 `src/lib/pipeline/delivery/session.ts:90` 的定义。

判定：部分不成立。点数约 10（实际 9）成立，生产引用文件数实际 4；“5 文件”把定义文件混入了引用集合。

建议改法：写成“feature `2c339784` 的 `src/` 下生产调用表达式 9 处／4 文件；另有定义 1 处”，并附 AST 生成命令。

### [major] HANDOVER:24–35 没有声明硬事实究竟属于 master 还是未合并 feature，导致同表事实在 master 上互相冲突

断言原文：表标题“已确证的硬事实”，其中 HANDOVER:28 说 P0/P1/P2/P6 在 master，HANDOVER:29 说 M1 未合并，随后 HANDOVER:30–33 直接给出代码位置与计数。

命令与原样输出：

```text
$ cd /home/xp/src/copilot-api-js && git rev-parse HEAD && rg -n 'ClientSink' src/lib/pipeline/types.ts src/lib/pipeline/delivery/types.ts
b7504c51d94dd031bfb674a6fe1a0637c59297ef
rg: src/lib/pipeline/delivery/types.ts: No such file or directory (os error 2)
src/lib/pipeline/types.ts:737:export interface ClientSink {

$ <master 上同一 AST terminal 计数>
count=0

$ <feature 2c339784 上同一检查>
src/lib/pipeline/types.ts:747:export interface ClientSink {
count=10
```

判定：表中 HANDOVER:30–33 只在未合并 feature `2c339784` 上成立，在文档头部所谓 master 基线上不成立。接手者若照表标题在 master 复算，会得到文件不存在、行号偏移、terminal 调用点为 0。该歧义会直接污染 RFC/plan 的闭包清单与 cutover 起点，属可执行交接缺陷。

建议改法：把表拆成“master `b7504c51` 事实”与“未合并 M1 feature `2c339784` 事实”，每行显式写 tree/commit；所有 `file:line` 按对应 tree 标注。

### [minor] HANDOVER:31 的“noteWinner 无条件调用”缺少限定语

断言原文：`noteWinner 无条件调用`。

证据：实际表达式是 `getDownstreamDeliverySessionForPortOrSink(...)?.noteWinner(source)`。

判定：若意思是“不受 `wireState` 门控”则成立；若按自然语言绝对解释则不成立，因为 optional chaining 在 session 缺失时不会调用。交接件后文称其为 R-14 的“唯一理由”，该限定不能靠读者猜。

建议改法：改为“只要能反查 session，`noteWinner` 就调用；它不受 `allocationPort?.wireState` 门控”。

### 已闭合证据：keepalive 默认值

```text
$ cd /home/xp/src/copilot-api-js && perl -ne 'printf "%6d %s", $., $_ if $. >= 120 && $. <= 123' packages/foundation/src/state-defaults.ts
   120   streamKeepalivePingSec: 20,
   121   streamKeepaliveEscalateSec: 200,
   122   streamKeepaliveMode: "ping" as "ping" | "enveloped_ping" | "empty_text", // D2 partial reversal 2026-07-27: ping stays the normal shape; content delta/anchor is injected only near the 300s deadline
   123   streamCommitAfterSec: 180,

$ rg -n 'streamKeepaliveMode|onDemandEscalation' src/routes/messages/handler-v4.ts
1117:  const anchorHooks = buildAnthropicAnchorHooks(state.streamKeepaliveMode !== "ping" || onDemandEscalation)
```

判定：HANDOVER:34 的默认值为 `"ping"` 成立；`onDemandEscalation` 可在 mode 为 ping 时开启 anchor hooks 也成立。文中路径 `keepalive-anchor.ts:306` 与当前 master/feature 实际路径和行号均需另核，不能由默认值检查自动外推。

### [minor] HANDOVER:34 的可达性链只给了旧/错路径行号，未形成可复算证据

断言原文：`故 keepalive-anchor.ts:306 在默认配置下经 200s 升级即可达`。

命令与原样输出：

```text
$ cd /home/xp/src/copilot-api-js && rg -n 'onDemandEscalation|injectContentAnchor' src/routes/messages/handler-v4.ts src/lib/anthropic/keepalive-anchor.ts src/lib/pipeline/client-sink.ts
src/routes/messages/handler-v4.ts:1117:  const anchorHooks = buildAnthropicAnchorHooks(state.streamKeepaliveMode !== "ping" || onDemandEscalation)
src/lib/pipeline/client-sink.ts:79:  injectContentAnchor?: () => Promise<boolean>
src/lib/pipeline/client-sink.ts:510:          ...(heartbeat.injectContentAnchor && { injectContentScaffold: heartbeat.injectContentAnchor }),
```

判定：默认 mode 与 escalation gate 可证，但仓库没有文中所指的 `src/lib/delivery/keepalive-anchor.ts`；实际文件为 `src/lib/anthropic/keepalive-anchor.ts`，且目标逻辑不在 306 行。该可达性全链未由给出的 file:line 闭合。

建议改法：以 feature `2c339784` 为基线，列出 `onDemandEscalation` 的产生点、200s 配置读取点、hook 构造点和 injector 消费点，而不是只给一个漂移路径。

### 已闭合证据：P0／P1／P2／P6 已进入 master

命令与原样输出：

```text
$ cd /home/xp/src/copilot-api-js && git branch -a --contains 92c4325b && git branch -a --contains f8230e9e && git branch -a --contains a15ea821
+ agent-aedbd110267b7e81c
  feat/anchor-allocator-p1p2
+ feat/inter-block-anchor-allocator
* master
+ scratch/anchor-m1-mutations
[后两次同样包含 * master]

$ for c in 13211ca3 e1a2fc39 a0890d0c 73e1d6be f8230e9e 92c4325b 16a3a933 a15ea821; do git merge-base --is-ancestor "$c" master ...; done
13211ca3 master=yes feat(anchor): runtime-incrementing sequential index allocator (P1 primitive)
e1a2fc39 master=yes refactor(anchor): parameterize anchor frame indices
a0890d0c master=yes feat(anchor): thread generation allocator through anchor state
73e1d6be master=yes feat(anchor): gate remapping on mapping identity
f8230e9e master=yes feat(anchor): add atomic allocation entries and leg tokens
92c4325b master=yes feat(delivery): bind wire allocation to serialized writes
16a3a933 master=yes fix(pipeline): close heartbeat before terminal drain flush
a15ea821 master=yes fix(delivery): freezeHeartbeat must not permanently kill the heartbeat

$ perl -ne '...' docs/plan/2026-07-27-inter-block-anchor-allocator/README.md
3 - 状态：P0 / P1 / P2 / P6 已完成；...
```

判定：HANDOVER:28 成立。P1/P2/P6 的具名实施提交均是 master 祖先；P0 的完成状态由同目录计划 checklist 与 README 当前状态共同支持。缺陷是 HANDOVER 自身只写“本轮未变”，没有列 commit/生成命令，读者无法仅靠该表复算，见数字 provenance 发现。

### 已闭合证据：O-6 正确态与错误态双控

正确态实跑：

```text
$ cd /home/xp/src/copilot-api-js && PORT=43187 WORK_DIR=/tmp/inter-block-anchor-allocator-review-20260803 RECAPTURE=0 bash /home/xp/src/copilot-api-js/exp/inter-block-anchor-allocator/byte-equivalence.sh
1c6163c62f568fd5e1a46605c23716d1017b47232021b371f3cb145b2a4277f9  /tmp/inter-block-anchor-allocator-review-20260803/current-wire.sse
764 /tmp/inter-block-anchor-allocator-review-20260803/current-wire.sse
port=43187 listener_pid=2758115 spawn_pid=2758101
capture=/tmp/inter-block-anchor-allocator-review-20260803/current-wire.sse
O-6 PASS: captured wire is byte-identical to /home/xp/src/copilot-api-js/exp/inter-block-anchor-allocator/pre-change-wire.sse
SCRIPT_RC=0
```

错误态正样本对照在 `/tmp` 隔离副本中只给 baseline 追加一字节：

```text
$ REPO_OVERRIDE=/home/xp/src/copilot-api-js PORT=43189 WORK_DIR=/tmp/inter-block-anchor-allocator-review-positive-control RECAPTURE=0 bash /tmp/o6-positive-control-20260803/byte-equivalence.sh
1c6163c62f568fd5e1a46605c23716d1017b47232021b371f3cb145b2a4277f9  /tmp/inter-block-anchor-allocator-review-positive-control/current-wire.sse
764 /tmp/inter-block-anchor-allocator-review-positive-control/current-wire.sse
port=43189 listener_pid=2762198 spawn_pid=2762190
capture=/tmp/inter-block-anchor-allocator-review-positive-control/current-wire.sse
O-6 FAIL: captured wire differs from /tmp/o6-positive-control-20260803/pre-change-wire.sse
cmp: EOF on /tmp/inter-block-anchor-allocator-review-positive-control/current-wire.sse after byte 764, line 18
POSITIVE_CONTROL_RC=9
```

判定：HANDOVER:35 与 KICKOFF:53 成立。默认路径比较独立 capture 与冻结 baseline；正确样本 rc=0，一字节错误样本 rc=9。脚本拒绝 4141，且无 `pkill`/`killall`。第一次尝试用 `CAPTURE_OVERRIDE` 指向变异文件是无效 mutation，因为脚本会覆盖 capture；报告保留这一失败尝试作为判据自证的一部分：

```text
O-6 PASS: captured wire is byte-identical ...
MUTATION_SCRIPT_RC=0
```

这不是门失效，而是 mutation 没改到 oracle；随后隔离 baseline mutation 才有效。

### [major] HANDOVER:6／KICKOFF:51 的 21 次全绿缺失其自称存在的逐次原始记录，无法独立核验

断言原文：`连跑 21 次全绿（6845 pass / 0 fail，代码状态 cc909c81）`；来源文档又声称“命令与逐次结果见 docs/tmp/ 同批记录”。

命令与原样输出：

```text
$ cd /home/xp/src/copilot-api-js && rg -l '21 次|21次|6845 pass' docs/tmp | sort
docs/tmp/2026-08-03-baseline-flake-status.md
docs/tmp/2026-08-03-handover-review-criteria.md

$ rg -n 'run ?[0-9]+|第 ?[0-9]+ ?次|6845 pass|21 次|21次' docs/tmp
...baseline-flake-status.md:39: master @ cc909c81 连跑全套件 21 次（6+15），全部 6845 pass / 0 fail；命令与逐次结果见 docs/tmp/ 同批记录...
```

判定：无法核验。仓库里只有汇总断言，没有 21 次逐次结果、时间戳、日志路径或可复算 artifact；所谓“同批记录”不存在。`cc909c81` 后仅文档提交可证数字未被代码更新作废，但不能证明数字当初真实发生。按用户要求，缺生成证据的数字降级为“未核实”。

建议改法：若原始日志尚存，提交每轮 rc/summary 的机器生成 manifest，并附命令、commit、环境与日志 hash；否则改写为“历史会话声称 21 次，当前无逐次记录可独立核验”，不得在 KICKOFF 以事实口吻复述。

### [major] HANDOVER:37 的“计数事实集合边界”仍缺生成命令与对应 tree/commit，违反其自己的数字口径要求

断言原文：`10 处 terminal 决策点 = src/ 下...`、`21 次连跑 = unit+it+http...代码状态 cc909c81`。

命令与输出见上：terminal 数只在 feature `2c339784` 为 10，在 master 为 0；21 次只有汇总文本、无逐次记录。

判定：不满足“对象、范围、基线 commit、生成命令”四项。terminal 数有对象/范围，却没写 feature commit 和 AST 命令；21 次有对象/范围/commit，却没原始生成记录。两项都必须降级为“未核实”，不能用“实测”证据等级。

建议改法：每个数字旁写 `tree@full-SHA` 与完整可复制命令；近似词“约”也必须给精确底数和是否计定义/调用。

## T1–T6 判据证伪

### [blocker] HANDOVER:53 标题声称“每条带验收判据与证伪方式”，但 T1 根本没有验收/证伪门

断言原文：`待办（每条带验收判据与证伪方式）`；T1 只有“两条路径”与“不裁决的后果”。

命令与原样输出：

```text
$ perl -ne 'printf "%6d %s", $., $_ if $. >= 53 && $. <= 62' HANDOVER.md
    53 ## 待办（每条带验收判据与证伪方式）
    55 ### T1 —— 用户拍板：是否起执行（当前就卡在这里）
    56 - 两条路径：(a) 直接按 RFC §7 起执行；(b) 先补三层结构的 plan + prompts 层（见 T4）再执行。
    57 - 不裁决的后果：无损失，RFC 已在主线随时可起。
    59 ### T2 ...
    61 - 验收：...
    62 - 证伪：...
```

判定：不成立。T1 是整个交接的当前 blocker，却没有机械判定“用户已明确裁决”的一手来源，也没有防止把沉默/旧裁决误当批准的反例。KICKOFF:26 只能把 T1 再摆给用户，不补这个门。

建议改法：T1 验收应要求记录用户明确原话/会话链接/日期及选择值；证伪应是“只有文档作者推断、用户沉默、或只裁了 RFC 形状而未裁执行时机”。

### [major] HANDOVER:62 的 T2“证伪方式”不是验收判据的反向控制，且会在正确状态下永不发生

断言原文：验收为“裁决落盘进 RFC §9.2，并同步 §4.9 与 Commit 5 条目”；证伪为“Commit 5 开工时 telemetry schema 仍无定形”。

命令与原样输出：

```text
$ rg -n 'Q1|Commit 5|前置停门' docs/rfc/2026-08-03-generation-emission-command-algebra/design.md
643:### 7.8 Commit 5 — Per-command telemetry与History generation operation detail
645:- 前置停门：Q1已裁；request-scoped accumulator与settle freeze point已核实。Q4已裁决方案B。
692:#### Q1. Per-command telemetry需要何种联合查询能力？
699:- 不裁决会怎样：阻塞Commit 5 telemetry schema与SQLite migration；不阻塞Commit 0～4...
734:Q1保持open并在Commit 5前停...
```

判定：判别力不足。“Commit 5 开工时仍无定形”只检查最晚时间点，不会抓“用户已裁但三处文档只同步两处”“三处内容互相矛盾”“错误地提前实现 schema”；在正常流程中，正确状态不会触发所谓证伪，因此它不是可执行 negative control。

建议改法：用结构化一致性门：Q1 状态必须由单一 decision id 驱动，§9.2、§4.9、Commit 5 对 chosen option、schema shape、迁移任务精确一致；分别 mutation 漏一处/改一处必须红，且 Commit 0–4 在 Q1 open 时仍可绿。

### [blocker] HANDOVER:66–67 的 T3 验收与证伪都不可裁决“已修”，会让未修 flaky 通过

断言原文：验收为“从机制上确认或排除与第 3 条同因，或在人为 I/O 负载下定向复现”；证伪为“因为最近没见到就宣布已修”。

命令与原样输出：

```text
$ perl -ne 'printf "%6d %s", $., $_ if $. >= 35 && $. <= 47' docs/tmp/2026-08-03-baseline-flake-status.md
    35 ## 第 1 条：待定性
    37 尚未单独诊断。它在原始观测里只出现过一次。
    41 ...即使它完全没被修好，也有约四分之一的机会看到这样一串全绿。
    43 两种可能，不要凭猜择一：①它与第 3 条同因...②它是独立的时序敏感缺陷...
    45 处置：记为未证实已修。若要定性，两条路——(a) 读那条测试...；(b) 在人为 I/O 负载下定向复现。
```

判定：存在 blocker。验收只要求“确认/排除某个候选同因”或“复现”，两者都不等于修复；复现反而证明缺陷仍在。证伪只禁止一种错误论证，不要求修后 mutation red、受控负载绿、或 entry ≥15 全绿。因此 T3 可在“成功复现但完全未修”状态下被标为验收完成，随后却又被 Commit 0 入场条件要求“根因修复”，逻辑断裂。

建议改法：拆成诊断 AC 与修复 AC。诊断 AC：确定根因并有 deterministic reproducer。修复 AC：旧实现/逆 mutation 在 reproducer 下红，修复后同负载绿；守护判据 false-red 对照绿；再在 entry commit 连跑 ≥15 次且保存逐次结果。未闭合修复 AC 时不得开始 cutover。

### [major] HANDOVER:72–73 的 T4 只防“虚构签名”，防不住计划漏任务/漏门/错接线

断言原文：验收为“每个 commit 的可满足门有可复跑命令；锚点表给 file:line”；证伪为“plan 里出现 RFC 未冻结的签名”。

命令与原样输出：

```text
$ rg -n '每个commit结束|Commit 0|Commit 4|R-14|O-9' docs/rfc/2026-08-03-generation-emission-command-algebra/design.md
536:每个commit结束都必须满足：typecheck、unit it http、O-6、正负控...
594:### 7.3 Commit 0 ...
761:| R-14 | 非Anthropic profile的candidate provenance不退化为 legacy | ...
775:| O-9 continuation腿×gap anchor交叉缝 | 仍待M7，绝不删除 |
779:...R-14与其余必过项同级...
```

判定：判别力不足。一份 plan 可以不虚构任何签名，却漏掉 R-14、漏某 commit 的 false-red control、把命令放错 commit、或只列 file:line 不证明调用缝可达，仍通过 T4 的“证伪”。这正是 HANDOVER:101 自述曾发生的失效形态。

建议改法：从 RFC 的 Commit 0–8、R-1–R-14、O-1–O-9、调查缝和停点生成双向 traceability matrix；要求每项恰有 owner commit/命令/正控/反控/可达生产入口，反向要求每个 plan task 有 RFC 来源。mutation：删除 R-14 或把一个门挪到不可满足 commit 时必须红。

### [major] HANDOVER:79 的 T5“2 腿 × 2 跳”没有定义四个 cell，且“direct 与 translate 各一条 oracle”只覆盖两条

断言原文：`核实矩阵 = 2 腿 × 2 跳，direct 与 translate 各一条 oracle`。

命令与原样输出：

```text
$ perl -ne 'printf "%6d %s", $., $_ if $. >= 57 && $. <= 66' src/lib/codec/anthropic/request-rewrite-adapter.ts
    57 export function createAnthropicSanitizeRewrite(...)
    65     appliesTo: (env) => env.targetEndpoint === ENDPOINT.MESSAGES,
    66     apply: (env) => applyAnthropicSanitize(env, deps),
```

判定：T5 的事实前提成立：sanitize 的确按 outbound `targetEndpoint === MESSAGES` 门控。但验收矩阵表述不闭合：2×2 应有 4 个明确 cell，而“direct 与 translate 各一条”只有 2 个 oracle；它没有写两条腿和两跳如何做笛卡尔积，也没要求 CC 与 Responses 分别由真实上游/官方 oracle 校准。实现者可只测 direct-Anthropic 与 translate-CC 两条，漏 translate-Responses，仍声称“各一条”。

建议改法：列四个具名 cell、输入 fixture、预期空块保留/丢弃、oracle 类型与上游错误码；若实际维度是 2 target × 2 stage，则不要再叫 direct/translate 两腿。每 cell 都要有已知空块正样本，避免“翻译先丢掉所以 sanitize 看似覆盖”的 false-green。

### [blocker] HANDOVER:83–87 的 T6 没有给 O-1～O-9、R-1～R-14 的逐项验收/证伪，标题所称“每条带判据”严重失实

断言原文：`收口清单现在是 O-1 ~ O-9 加 R-1 ~ R-14`；T6 仅点名 O-4/O-5/O-6、ADR、Q5、O-9。

命令与原样输出：

```text
$ rg -n '^\| R-|^\| O-' docs/rfc/2026-08-03-generation-emission-command-algebra/design.md
748:| R-1 | ...
...
761:| R-14 | ...
[O-1～O-9 对账位于 10.3；其中]
770:| O-4 ...仍待P8...
771:| O-5 ...仍待P8...
772:| O-6 ...每commit必跑...
775:| O-9 ...仍待M7，绝不删除...
```

判定：存在 blocker。T6 是“P8 验收与文档后果”，却没有为 23 项逐项给 PASS/FAIL/NOT-YET-IN-SCOPE 的命令、正负控和责任 commit；RFC:779 明确要求这张逐项记录。只列集合名可让遗漏任意一项仍“收口”。尤其 O-9 被提醒“别漏”，但没有可执行命令，正是最容易被漏掉的状态。

建议改法：T6 直接引用/生成 23 行 acceptance ledger，每行含 scope、owner phase、命令、correct sample、fault mutation、artifact、verdict；集合精确相等守卫确保漏一行即红。O-5 的 `escalate=0` 对照还应证明 client 会在 >300s 失败，而不是只证明测试能跑三次。

## 冻结上游文档对账

### [blocker] HANDOVER:93 的五关键词检索不足以支持“除上述外无冲突命中”这一否定性断言

断言原文：范围为 `docs/spec/`、`docs/decisions/`、本 plan 目录；关键词仅 `wireTorn`／`closeOpenAnchor`／`command algebra`／`帧序`／`selectWinner`；据此称“除上述外无冲突命中”。

命令与原样输出：

```text
$ find docs/spec docs/decisions docs/plan/2026-07-27-inter-block-anchor-allocator -type f -name '*.md' | wc -l
122
$ rg -i -l 'wireTorn|closeOpenAnchor|command algebra|帧序|selectWinner' <三范围> | wc -l
21
$ rg -i -n 'wireTorn|closeOpenAnchor|command algebra|帧序|selectWinner' <三范围> | wc -l
70
$ rg -i -l 'wire.?index|anchor|frontier|synthetic.*block|content.?block|winner|generation.*emission|close.*anchor|open.*anchor' <三范围> | wc -l
66
$ rg -i -n '<同上>' <三范围> | wc -l
1260
```

语义相关但五词零命中的文件包括：

```text
docs/decisions/2026-07-05-richest-data-flow.md
docs/decisions/2026-07-09-unconditional-keepalive-timeout-safety.md
docs/decisions/2026-07-11-block-level-buffered-retry.md
docs/decisions/2026-07-22-continuation-retry-sequential-anchor.md
docs/plan/2026-07-27-inter-block-anchor-allocator/plan-1-allocator-state.md
docs/plan/2026-07-27-inter-block-anchor-allocator/plan-4-continuation-frontier.md
docs/plan/2026-07-27-inter-block-anchor-allocator/plan-6-heartbeat-lifecycle-fix.md
docs/plan/2026-07-27-inter-block-anchor-allocator/plan-7-multi-turn-replay.md
docs/plan/2026-07-27-inter-block-anchor-allocator/plan-8-acceptance-and-docs.md
docs/spec/2026-07-08-buffered-keepalive-empty-text-anchor.md
docs/spec/2026-07-11-block-level-buffered-retry.md
docs/spec/2026-07-22-continuation-retry-and-sequential-anchor.md
docs/spec/2026-07-27-inter-block-keepalive-carrier.md
```

判定：存在 blocker。查询只覆盖 122 个 Markdown 中 21 个文件，却漏掉承载 C1/C4/C6/C7/C8、D2、continuation offset、anchor 生命周期与 P7/P8 的核心文档。五词多为新 RFC 术语，旧冻结文档恰恰可能用旧术语表达冲突；空/少命中不能证明无冲突。

建议改法：先冻结权威文档 manifest，再按契约轴而非新 API 名搜索：index allocation/order/reuse/offset、anchor open/close/lifecycle、serializer/write/emit、synthetic provenance、winner/candidate/dispatch、heartbeat/escalation、continuation/recovery、History/telemetry。对每个 manifest 文件给 disposition；对 C1–C11 与用户裁决做双向 trace，不能用单次 `rg` 替代语义审计。

## 其他状态与数字断言

### [major] HANDOVER:16 的 RFC“11 节，786 行”两项数字均已漂移

断言原文：`RFC（11 节，786 行）`。

命令与原样输出：

```text
$ wc -l docs/rfc/2026-08-03-generation-emission-command-algebra/design.md
818 docs/rfc/2026-08-03-generation-emission-command-algebra/design.md
$ rg -n '^## ' docs/rfc/2026-08-03-generation-emission-command-algebra/design.md
7:## 0. 摘要与规范用语
...
781:## 11. 诚实边界：本设计证不了什么
```

判定：不成立。顶层编号为 0～11，共 12 节；文件为 818 行，不是 786。两项都没有 commit/生成命令，且 HANDOVER 落地时已经错误。

建议改法：不要在交接复制易漂移的行数/节数；若确有导航价值，写“§0～§11，见标题索引”，并由命令生成。

### [major] HANDOVER:20 的“第 3 条记为未证实已修”编号错误，会把接手者导向已修项

断言原文：`3 条修 2 条；第 3 条记为未证实已修`。

命令与原样输出：

```text
$ perl -ne 'printf "%6d %s", $., $_ if $. >= 10 && $. <= 14' docs/tmp/2026-08-03-baseline-flake-status.md
    10 | # | 用例 | 观测 | 处置 |
    12 | 1 | History V3 store performance ... | 1296ms | 待定性 |
    13 | 2 | legacy Vue ui/... | 5416ms | 已修 51b1e1c9 |
    14 | 3 | state → foundation... | 17.71ms | 已修 cc909c81 |
```

判定：不成立。未证实已修的是第 1 条，不是第 3 条。HANDOVER 后文 T3:64 又正确写“第 1 条”，形成文内矛盾。

建议改法：改为“第 1 条未证实已修”，并用测试全名代替脆弱编号。

### 已闭合证据：HANDOVER:22 的四个修复提交

```text
4f7a3989 fix(exp): make the O-6 byte gate compare instead of overwrite its own baseline
200aba8b test(architecture): give the remap allowlist guard room to finish
51b1e1c9 fix: stabilize exhaustive ESLint ignore guard
cc909c81 fix: isolate architecture guard mutations
```

旧 O-6 脚本扫描：

```text
$ git show 4f7a3989^:exp/inter-block-anchor-allocator/byte-equivalence.sh | rg -n 'cmp|BASELINE|CAPTURE'
9:CAPTURE="${CAPTURE_OVERRIDE:-$DIR/pre-change-wire.sse}"
150:  > "$CAPTURE"
[无 cmp 命中]
```

判定：HANDOVER:22 成立。旧脚本默认直接把 capture 写到 baseline 且无 `cmp`；另外三个提交标题和改动文件与陈述一致。

### [minor] HANDOVER:131–135 的 memory 大小当前成立，但读取上限与“整个索引读不出来”无可复算证据

断言原文：`32.4KB`、读取上限约 `24.4KB`、超限即整个索引读不出来；目标 `<17.1KB`。

命令与原样输出：

```text
$ wc -c /home/xp/.claude/projects/-home-xp-src-copilot-api-js/memory/MEMORY.md
32645 /home/xp/.claude/projects/-home-xp-src-copilot-api-js/memory/MEMORY.md
```

判定：32.4KB 当前成立。24.4KB 上限、22.1→32.4KB 增长过程、17.1KB 目标来源都没有命令/commit/日志，按数字规则降级为未核实；当前会话上下文事实上收到了 MEMORY.md 内容，但这不能证明读取工具没有截断，也不能证明“整个索引读不出来”。

建议改法：给出触发截断的真实 `Read` 输出、字节阈值探针和时间戳；把目标解释为阈值的安全余量公式，否则只写“需压缩并用 wc 验证”，不要冒充硬上限。

### [blocker] KICKOFF:52 的“隔离 worktree 中 bun run test 会因 rustup 前置失败”与当前测试脚本定义冲突

断言原文：`隔离 worktree 里 bun run test 会因 rustup 前置失败——用上面那条 parallel-test.ts 命令。`

命令与原样输出：

```text
$ rg -n 'rustup|build:history-search' package.json scripts tests | sed -n '1,80p'
package.json:38: "build:history-search": "bun run scripts/build-history-search.ts",
package.json:59: "test:ci": "bun run build:history-search && bun run test:backend && bun run test:pty && bun run test:e2e",
[仅 build-history-search/test:ci 接 native build；普通 test 无 rustup]

$ bun -e 'const p=await Bun.file("package.json").json(); ...'
test "bun run test:fast"
test:fast "bun scripts/parallel-test.ts unit http"
test:backend "bun scripts/parallel-test.ts unit it http"
prepare "bun run build"
build "bun run build:backend"
```

判定：不成立，且会误导接手者。当前 `bun run test` 本身就是 `parallel-test.ts unit http`，没有 rustup/build-history-search 前置；只有 `test:ci` 明确先构建 native。即使某个旧 worktree 曾因依赖安装触发 rustup，KICKOFF 没有 tree/commit/输出，不能写成当前硬事实。

建议改法：删除该断言；需要 unit+it+http 时直接写其真实语义是 `test:backend` 或显式 parallel 命令，而不是用不存在的 rustup 故障作理由。

### [minor] KICKOFF:13 复述了已经错误的 master 基线

断言原文：`HANDOVER 头部的核验基线是 master 98e6875e`。

证据同前：被审文档所在 HEAD 为 `b7504c51`。

判定：不成立。KICKOFF 虽要求“复验而非采信”，仍把错误基线作为权威启动事实重复了一遍。

建议改法：与 HANDOVER 一并改为文档落地 commit，或删 SHA 复述，只要求接手者以 `git log -- HANDOVER.md` 找文档版本。

## 待查疑点

- HANDOVER:17 声称“两路评审报告各含六轮追加”。Claude 报告存在 R8 最终确认，GPT 报告以多轮/聚焦复评组织，轮次命名并非机械六段；本轮未构造可靠的轮次 parser，因此不升级为发现。
- HANDOVER:108、125–127 关于 agent 不实报告、API 中断次数与 SendMessage 有效性依赖会话 transcript；仓库文档只有二手叙述，本轮未取得 transcript oracle，全部按“未核实”处理。

## 汇总与 verdict

- blocker：5
- major：8
- minor：6
- nit：0
- 总体 verdict：**存在阻断缺陷**。HANDOVER/KICKOFF 不能作为下一会话的权威启动档案：当前 blocker 包括 T1 无批准门、T3 可在未修状态下通过、T6 的 23 项收口集合无逐项 ledger、冻结文档否定性对账查询结构性漏面，以及 KICKOFF 的 rustup 硬事实错误。生产代码位置待 debugger 定位：无；这些均为交接文档/验收判据缺陷，建议由 doc-writer/implementer 修订后重新独立复评。

## 实际运行命令摘要

- 主树/feature provenance gates：`pwd -P`、`git rev-parse --show-toplevel`、full HEAD、branch/ancestor checks。
- Git 状态：`git log master..feature`、`git log cc909c81..master --name-status`、phase commit ancestry。
- TypeScript AST：terminal close 与 `getDownstreamDeliverySession` 调用表达式枚举。
- O-6：非 4141 端口正确态实跑 rc=0；`/tmp` baseline 一字节 mutation rc=9。
- 文档审计：窄查询与契约轴扩展查询覆盖对照；RFC/报告行数与标题；逐次测试记录存在性扫描。

# 复审：master `8ea97bec`

复审基线：`8ea97bec38b0b61ee9e8ed10251c17161513fe8b`。本轮逐 hunk 对照 `b7504c51..8ea97bec`，不是按关键词判断。

## 已真正闭合

- 原 blocker“冻结文档否定性检索漏面”：闭合。HANDOVER:106–107 明确撤销“无冲突”断言，保留 `122 Markdown / 21 hit files` 的实测口径，并把契约轴检索、逐文件 disposition、C1–C11 双向 trace 列为未完成待办。复跑仍得到 `markdown_files=122`、`claimed_query_files=21`。
- 原 blocker“T1 无批准门”：闭合。HANDOVER:60–64 要求用户原话、日期、路径及执行时机，并列出作者推断／沉默／形状裁决冒充执行裁决三种反例。
- 原 blocker“T3 未修也可验收”：闭合。HANDOVER:71–77 已拆诊断 AC 与修复 AC，逆 mutation、同负载、false-red、entry ≥15 逐次记录四腿齐全。
- 原 blocker“T6 无 23 项 ledger”：闭合。HANDOVER:92–99 要求恰 23 行及每行七字段，并给少行、无命令、O-9 无命令三种证伪；O-5 对照须证明客户端 >300s 真失败。
- 原 blocker“KICKOFF rustup 断言错误”：闭合。当前脚本实测为 `test=test:fast`、`test:fast=unit http`、`test:backend=unit it http`、`test:ci=build:history-search + backend + pty + e2e`，KICKOFF 已准确改写。
- 原 major RFC 节数/行数、第 1/3 条编号、feature/master tree 混用，以及原 minor 9/4 调用点、`noteWinner` 限定语：正文改动均与复算结果一致。
- 原 keepalive 可达性疑点撤销：在 feature `2c339784` 实读 `src/lib/anthropic/keepalive-anchor.ts:306` 确为 `allocateAndWriteAnchor`；`handler-v4.ts:1156–1216` 把默认 `streamKeepaliveEscalateSec=200` 接到 `onDemandEscalation`、`contentDeadlineSec` 与 `injectContentAnchor`。上一轮该 minor 是在 master 错树上复算产生，不再保留。

## 未闭合 major

### [major] HANDOVER:66–69：T2 的判据未修改，仍只能抓“最晚没定形”，抓不住三处漏同步／互相矛盾

断言原文仍是：验收要求同步 RFC §9.2、§4.9、Commit 5；证伪只有“Commit 5 开工时 telemetry schema 仍无定形”。

命令与原样输出：

```text
$ git diff --unified=0 b7504c51..8ea97bec -- HANDOVER.md | rg 'T2|telemetry schema'
[无命中；T2 未改]
$ nl -ba HANDOVER.md | sed -n '66,69p'
66 ### T2 —— Q1 未裁决...
68 - 验收：裁决落盘进 RFC §9.2，并同步 §4.9 与 Commit 5 条目。
69 - 证伪：Commit 5 开工时 telemetry schema 仍无定形。
```

判定：未闭合。正确 negative control 应让“漏同步任一处”“chosen option/schema shape 三处不一致”“Q1 open 时错误阻塞 Commit 0–4”转红；当前证伪方式对这些错误全绿。

建议改法：增加三处结构化一致性检查与逐处 omission mutation，并保留 Q1 open 时 Commit 0–4 可通过的 false-red 对照。

### [major] HANDOVER:79–83：T4 判据未修改，仍防不住漏 R-14／漏任务／门放错 commit

命令与原样输出：

```text
$ git diff --unified=0 b7504c51..8ea97bec -- HANDOVER.md | rg 'T4|plan 里出现'
[无命中；T4 未改]
$ nl -ba HANDOVER.md | sed -n '79,83p'
79 ### T4 —— 分相位计划...
81 - 验收：每个 commit 的「可满足的门」...；锚点表给出 file:line。
82 - 证伪：plan 里出现 RFC 未冻结的签名。
```

判定：未闭合。没有虚构签名的 plan 仍可漏 R-14、漏 false-red、漏调查缝、把门放进不可满足 commit。HANDOVER:115 自己记录过 R-14 漏完成清单这一真实反例，但 T4 仍没有防它。

建议改法：要求 RFC Commit 0–8、R-1–R-14、O-1–O-9、调查缝、停点的双向 traceability matrix，并以删 R-14／错置门 mutation 证明门会红。

### [major] HANDOVER:85–90：T5 判据未修改，“2×2”仍只要求 direct/translate 各一条 oracle

命令与原样输出：

```text
$ git diff --unified=0 b7504c51..8ea97bec -- HANDOVER.md | rg 'T5|2 腿|direct 腿'
[无命中；T5 未改]
$ nl -ba HANDOVER.md | sed -n '85,90p'
88 - 验收：核实矩阵 = 2 腿 × 2 跳，direct 与 translate 各一条 oracle。
89 - 证伪：只测 direct 腿就宣称「清洗已覆盖」。
```

判定：未闭合。2×2 是四个 cell，但正文只要求两条 oracle，且没有具名 CC/Responses target 与 stage 的组合；漏 translate-Responses 仍可通过。

建议改法：列出四个 cell 的输入、预期、真实 oracle 和错误码；每 cell 有空块正样本，防“翻译先丢空块”造成 false-green。

### [major] HANDOVER:5 的文档落地基线仍不是本文件所在提交

断言原文：`文档落地基线：master dafa31d8 及其后（本文件所在提交）`。

命令与原样输出：

```text
$ git log -1 --format='%H %s' -- docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md
8ea97bec38b0b61ee9e8ed10251c17161513fe8b docs(handover): answer both reviews of the handover itself
$ git show dafa31d8:.../HANDOVER.md | sha256sum
02691cb37fce2292d3346677a665c0a5df4053ee55d30c7ca49d08c5c45bb132  -
$ git show 8ea97bec:.../HANDOVER.md | sha256sum
686c1ec993385bf8e8af373682c90eeb0ee56f4d2f848effb3881c7a7d1bc801  -
```

判定：未闭合且是本轮新引入的自相矛盾。`dafa31d8` 不含当前 HANDOVER 内容；“及其后”不是冻结基线，不能唯一定位被审档案。

建议改法：状态翻转提交时把文档落地基线精确写为最终提交 full SHA，或采用不会自指漂移的“本文件 blob SHA + 生成命令”。

### [major] HANDOVER:10 把事后手录摘要称为“逐次原始记录”，仍无法独立证明 21 次实际运行

新增文件 `baseline-run-log.md` 确有 21 行 green summary，但它没有原始 stdout/stderr artifact、每轮 rc、时间戳、时长或 hash；该文件在原断言被评审指出后才由 `c10f0269` 新建，仓库没有第二来源。

命令与原样输出：

```text
$ rg -c '^run[0-9]+:.*0 fail' docs/tmp/2026-08-03-baseline-run-log.md
21
$ rg -n 'timestamp|duration|elapsed|sha256|stdout|stderr|artifact|rc=' docs/tmp/2026-08-03-baseline-run-log.md
45:run1 rc=0 ...
...
52:run6 rc=1 ...
[仅修复前 6 次有 rc；21 次绿没有上述 provenance]
$ rg -l '6845 tests|run15: 6845|baseline-run-log' docs scripts tests
HANDOVER.md
KICKOFF.md
baseline-run-log.md
```

判定：未闭合。文件把同一权威声音的汇总拆成 21 行，增加了粒度，但没有增加可独立校验的证据；尤其本文自己记录过 agent 声称测试已跑但实际未跑的事故。可以称“逐次摘要”，不能称“逐次原始记录”或据此把 21 次升级为已核实事实。

建议改法：若原始输出尚存，提交或内容寻址保存每轮日志，并给 manifest（full commit、cwd、开始/结束时间、rc、summary、log SHA-256）；若已丢失，诚实标成“历史手录摘要，无法独立核验”，entry 时按新格式重跑。

## 未闭合 minor

### [minor] HANDOVER:9 的“本工作的产物已于 6cfa0e89 全部提交”被后续本工作产物直接证否

命令与原样输出：

```text
$ git log --oneline 6cfa0e89..8ea97bec -- HANDOVER.md KICKOFF.md baseline-run-log.md
8ea97bec docs(handover): answer both reviews of the handover itself
c10f0269 docs(tmp): land the per-run results behind the 21-green claim
```

判定：本轮新引入。`6cfa0e89` 只补交五份既有报告；run log 和修订后的交接件是更晚的本工作产物。

建议改法：写“此前漏交的五份评审产物已于 6cfa0e89 提交；当前全部产物截至 8ea97bec 已提交”，并在最终状态 commit 复核。

### [minor] HANDOVER:149 的 memory 读取阈值断言仍无探针证据

正文仍称约 24.4KB 上限且“整个索引读不出来”；本轮只修正 inode/git 可恢复性，没有补真实 Read 截断输出、阈值探针或目标 17.1KB 的来源。上一轮该 minor 未处置，继续保留。

## 新引入缺陷扫描结论

新增 2 项：文档落地基线用非唯一“dafa31d8 及其后”且误称本文件所在提交（major）；“全部产物已于 6cfa0e89 提交”被 c10f/8ea 后续产物反证（minor）。T1/T3/T6/否定性检索/KICKOFF 修订未发现新的 blocker。

## 复审汇总

- blocker：0
- major：5
- minor：2
- nit：0
- verdict：**不可放行；无未决 blocker，但仍有 5 个未决 major，不能声明“无未决 blocker/major”，也不能把头部状态从“草稿·未评审”改为通过。**

# 第三轮复审：master `cf82f0f5`

复审基线：`cf82f0f56d2318633a6cbb7f469bdc0ec0e5ebe7`；逐 hunk 对照 `8ea97bec..cf82f0f5`。

## T2

### 已闭合：三处决策一致性判据具备双向判别力

命令与原样输出：

```text
$ git diff --unified=60 8ea97bec..cf82f0f5 -- HANDOVER.md
+ 验收：§9.2 记方案/原话/日期；§4.9 记 key 形状；Commit 5 记迁移任务；三处引用 Q1。
+ 证伪：只同步一两处，或三处互相矛盾。
+ 正控：把三处之一改成另一个方案的形状 → 对账必须报冲突。
```

判定：上轮 major 闭合。正确状态（三处都引用 Q1，且 letter→key shape→migration task 一致）会通过，不会因“最新时点未定形”这种永不触发条件而失去裁决力。目标变异有两类：①删除 §4.9 或 Commit 5 的 Q1 引用，三处完备性检查红；②保留 Q1 id 但把 §4.9 从 A 的 compound key 改成 B 的 multidimensional key，语义对账红。正确状态正控是 Q1 尚 open 时 Commit 0–4 仍可执行，避免把 Commit 5 停门错误前移。

## T4

### 已闭合：双向 traceability 同时防漏项、孤儿、错序与不可达

命令与原样输出：

```text
$ git diff --unified=60 8ea97bec..cf82f0f5 -- HANDOVER.md
+ 正向：每项恰一个归属 commit／命令／正样本／目标 mutation／生产入口可达路径。
+ 反向：每个 plan task 指回 RFC 出处。
+ 证伪：虚构签名、矩阵孤儿、门先于依赖、只有 file:line 无生产驱动入口。
+ 正控：删 R-14 或把 O-9 挪到 Commit 2 → 必须报红。
```

判定：上轮 major 闭合。正确状态不会永不触发：它的通过态是有限冻结集合全部被双向映射、依赖拓扑合法且生产入口可达，而非等待某个未来时点。目标变异：①删除 R-14 行，`R-1..R-14` 集合精确相等检查缺项转红；②新增无 RFC source 的 task，反向 orphan 检查转红；③把 O-9 owner 改成 Commit 2，依赖能力／可达路径尚未就位，拓扑检查转红；④只留 file:line、删 production entry path，可达性字段缺失转红。合法的 NOT-YET-IN-SCOPE 项仍可具名映射到后续 owner，不会被误判为漏项。

注意：正文用 `Commit 0–8 × R-1～R-14 × O-1～O-9 × ...` 表示多轴覆盖，不应按数学 Cartesian product 解读；后文“每一项恰好一个归属 commit”已消除歧义，本轮不列缺陷。

## T5

### [major] 四格已具名，但 translate 一格同时包含 `@cc` 与 `@responses`，仍允许只测其一而漏掉另一 target

命令与原样输出：

```text
$ nl -ba HANDOVER.md | sed -n '98,110p'
101 验收：2 腿 × 2 跳 = 4 格...
107 | 3 | translate（@cc / @responses） | 翻译跳 | Anthropic→CC/Responses ...
108 | 4 | translate | 上游跳 | CC / Responses 上游...
110 证伪：只测 direct；只给 2 条 oracle；第 4 格用推断...
```

判定：上轮“只要求 2 条 oracle”的缺陷已部分闭合，但仍有 major。正确状态不会永不触发：四格均有 fixture/oracle/响应码即可通过。可是目标失败态“Responses translate 保留空块而 CC translate 丢弃”仍可假绿——执行者在第 3/4 格各只测 CC，就满足“四格各一条 oracle”，却完全没测 Responses。反向只测 Responses 也同理。`@cc` 与 `@responses` 是两个不同 target endpoint/codec/upstream validator，不是同一 cell 的两个名字。

目标变异：只破坏 Anthropic→Responses 的空块翻译（CC 保持正确），现四格判据可继续全绿；因此判别力不足。

建议改法：把 translate 的两格各拆成 CC 与 Responses 子格，形成 direct-Anthropic 2 格 + translate-CC 2 格 + translate-Responses 2 格，共 6 个具名 cell；或在每个 translate 格明确要求 **CC 与 Responses 各一条** oracle/实测响应码，并以只破坏其中一个 target 的 mutation 必须红。

## 基线与 run log

### 已闭合：自指 SHA 改为现算命令；跨树观测不再冒充受控前后对照

命令与原样输出：

```text
$ git -C /home/xp/src/copilot-api-js log -1 --format='%h %ad' --date=short -- HANDOVER.md
cf82f0f5 2026-08-03
$ git merge-base --is-ancestor cc909c81 2c339784; echo $?
1
$ git merge-base --is-ancestor 2c339784 cc909c81; echo $?
1
$ git merge-base cc909c81 2c339784
200aba8b5f43471b0f028b2ca572de81c33d1201
```

判定：文档基线 major 闭合；现算命令不会因下一次文档 commit 自动作废。跨树口径纠正成立：feature `2c339784` 与 master `cc909c81` 互不为祖先，6848 vs 6845 不是受控 before/after；HANDOVER 与 run log 均明确不得替代 T3 同树逆 mutation AC。三行计数边界表也正确分离 feature 调用计数与 master 测试计数，未制造新孤儿。

### [major] 21 次记录仍是无原始 artifact 的事后摘要；`cf82f0f5` 未改变这一证据等级

`c10f0269` 确实早于上轮复审且文件可读；问题不是“文件当时不存在”，而是其中 21 次 green 只有 21 行手录 summary，无每轮 rc、时间戳、duration、stdout/stderr artifact 或 hash。`cf82f0f5` 只纠正跨树解释，没有补 provenance，HANDOVER 仍称“逐次原始记录”。

目标失败态：agent 实际未跑 21 次、却手写 21 行 `6845 pass`；当前文件形状无法区分它与真实运行，因此仍 false-green。判定维持 major。

建议改法不变：有原始日志则提交 manifest+hash；没有则降格为“历史逐次摘要，无法独立核验”，并以 entry commit 新格式重跑作为真正 gate。

## 新引入／遗留口径

### [minor] “本工作的产物已于 `6cfa0e89` 全部提交”仍被后续三个本工作提交反证

```text
$ git log --oneline 6cfa0e89..cf82f0f5 -- HANDOVER.md baseline-run-log.md
cf82f0f5 docs(handover): stop framing the pre-fix runs as a controlled before/after
8ea97bec docs(handover): answer both reviews of the handover itself
c10f0269 docs(tmp): land the per-run results behind the 21-green claim
```

该 minor 未整改。应改为“漏交的五份评审产物于 6cfa0e89 补交；当前产物截至现算 HEAD 已提交”。

### [minor] memory 24.4KB 读取阈值仍无探针证据

HANDOVER 尾部该段未改；上一轮 minor 继续保留。

## 第三轮汇总

- T2：闭合；目标 omission/conflict mutation 会红，正确 open-Q1 状态不会 false-red。
- T4：闭合；删 R-14、造 orphan、错置 O-9、删生产入口 mutation 会红，完整双向矩阵可绿。
- T5：未闭合；四格可绿，但只破坏 Responses translate 而保留 CC 时仍可假绿。
- 本轮新引入 blocker/major：0；新增孤儿：0。跨树修订正确，没有制造新口径矛盾。
- blocker：0；major：2（T5、21 次原始证据）；minor：2（`6cfa0e89` 全部提交、memory 阈值）；nit：0。
- verdict：**不可放行；仍不能声明“无未决 blocker/major”。**

# 第四轮复审：master `37f13c90`

复审基线：`37f13c9087664af2e8b3beb1abc6cc827c85b184`；逐 hunk 对照 `cf82f0f5..37f13c90`。

## 21 次记录

### 已闭合：证据等级诚实降级，未来 gate 改为保存原始 artifact

HANDOVER、KICKOFF、run log 三处现均称“自我报告的逐次摘要，非独立可核验”，明确形式上无法区分真跑与手写 21 行，禁止作为门禁已过证据。T3 AC④要求每次保存 `date -Is`、full HEAD、`git status --porcelain`、完整 stdout 文件，摘要只作索引；当前 21 次明确不满足。正确状态可绿，目标伪造态因缺原始 artifact/hash 不能再升级为 PASS。上轮 major 闭合，判据未改松。

未在 dirty 主树重跑是正确处置：当前 peer WIP 会改变被测代码，不能冒充 master 基线。

### [major] 新写的原始输出配方没有把 provenance 命令与测试绑定到同一 artifact，仍可让“声称的 HEAD/status”与实际测试分离

run-log:14 写“每个文件自带 `date -Is`、`git rev-parse HEAD`、`git status --porcelain` 与完整 stdout”，但给出的可复制命令只有：

```text
FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http 2>&1 | tee run-NN.log
```

该命令不会把 date/HEAD/status 写入 log；执行者必须另跑命令并手工拼接，正好重开“摘要可手写”的证据缝。更严重的是，`git status --porcelain` 非空时配方没有 fail，dirty WIP 仍能产出看似合格 artifact；也没有 `PIPESTATUS[0]`/`set -o pipefail` 保存真实测试 rc，`tee` 可掩盖测试失败。

目标失败态：先把错误 HEAD/status 文本写入 `run-01.log`，随后在另一 tree/dirty tree 跑测试并 append；或测试 rc=1 而 tee rc=0。当前配方都可能被当成合格原始 artifact。

建议改法：给一个单 shell、同一 gated invocation 的完整脚本：`set -o pipefail`，先 `pwd -P`/full HEAD/status 写入 log，并要求 status 为空；再在同一 shell 运行测试，保存 `${PIPESTATUS[0]}` 到 log 和 manifest；每个 log 计算 SHA-256。若要允许 dirty tree，必须保存 diff hash 并明确它不代表 commit baseline。

## T4 多阶段归属与正控

### 已闭合：`至少一个 + 阶段/等级` 修掉 false-red，未削弱漏项/错序门

RFC R-1/R-2/R-5/R-6/R-12 本就有辅助门与 Commit 4 production 硬门两段，R-11 是每 commit 共同门；从“恰好一个”改为“至少一个”，并要求每个归属显式标阶段与等级，允许正确多阶段状态通过，同时仍由 R/O 集合完整性、反向 task→RFC trace 与阶段标签抓孤儿/压平。

替换正控也成立：R-5 的 production 硬门明确归 Commit 4；把它挪到 Commit 2 时，production registration mutation 因零调用者不可达，阶段依赖检查应红。相较 O-9（RFC 内永久 NOT-YET-IN-SCOPE），R-5 是当前范围内真正有“早期辅助门 + 后期 production 硬门”的样本，判别力更强，没有丢掉原失败面。孤儿失败面仍由删 R-14 的独立正控覆盖。

未见新孤儿：O-9 仍在 23 项 ledger 中以 NOT-YET-IN-SCOPE 具名保留，并明确归后续 M7，不因撤下错序 mutation 而消失。

## RFC Commit 5 Q1 状态

### 已闭合：`Q1 必须已裁` 正确区分入场条件与当前状态，未放宽停门

RFC §7.8 从“Q1已裁”改成“Q1必须已裁——当前仍 open”，与 §9.1/§9.4/§4.9 一致。原本要抓的失败面仍在：Q1 open 时进入 Commit 5 违反“必须已裁”的前置停门；修订只是消除错误的已完成状态，不是允许 open Q1 开工。HANDOVER 另要求任一 Q1 文字改动后重跑 §7.8/§9.1/§9.4/§4.9 四处一致性检查，判据未改松。

## T5 六格

### 已闭合：三腿 × 两跳完整分离，无剩余端点/跳维度折叠

六格分别是 direct-Messages 的清洗/上游、translate-CC 的翻译/上游、translate-Responses 的翻译/上游；每格要求 fixture、空块归宿、oracle 类型、实测响应码。目标 mutation“只破坏 Responses 翻译，CC 保持正确”现在使第 5 格红；只改 CC 上游校验使第 4 格红；拿任一腿响应码外推另一腿由证伪④抓住。正确六格均实测可绿，不会永不触发。

上游取证路线明确使用非 4141 隔离实例与真 GHC，并澄清“Anthropic 上游”是 GHC Anthropic-compatible endpoint。就当前问题轴（target endpoint × processing stage）未发现仍折叠的维度；direct 只有 Messages target，因此无需再拆。

## 第四轮新引入扫描与 verdict

- 已闭合：上一轮 T5 major、21 次证据等级 major、T4 两个 false-red、RFC Q1 状态矛盾。
- 新发现：未来原始日志配方没有同 shell 绑定 provenance/status/test rc，且 `tee` 可掩盖失败，major 1。
- 遗留 minor：`6cfa0e89`“全部提交”陈旧；memory 24.4KB 阈值无探针。
- blocker：0；major：1；minor：2；nit：0。
- verdict：**不可放行；仍不能声明“无未决 blocker/major”。**

# 第五轮复审：master `3be24a4d`

复审基线：`3be24a4d2aaec2a13b13164d6b1325724ad443f3`；逐 hunk 对照 `37f13c90..3be24a4d`。

## baseline-runs.sh

### [major] 六条正控未覆盖 `RUNS=0`；脚本会零次执行却报告 `0/0 green`、rc=0

独立实跑：

```text
$ ALLOW_DIRTY=1 OUT=/tmp/baseline-runs-review-zero-3be24a4d RUNS=0 exp/inter-block-anchor-allocator/baseline-runs.sh
baseline-runs: 0 runs of [...] at 3be24a4d (DIRTY)
baseline-runs: 0/0 green at 3be24a4d; artifacts in /tmp/baseline-runs-review-zero-3be24a4d
SCRIPT_RC=0
RUN_LOG_COUNT=0
```

判定：六条正控不够。目标失败态正是“终端看起来 green，但实际一次都没跑”；`RUNS=0` 无 run log 却 rc=0。负数、非数字、空命令/不存在命令等输入也未做前置验证，但其中大多会非零，不构成已证 false-green；零次是已实证 major。

建议改法：在创建输出目录前验证 `RUNS` 匹配正整数且 `>=1`，`STOP_ON_FAIL`/`ALLOW_DIRTY` 只能为 0/1，命令数组非空；新增 `RUNS=0` 与 `RUNS=abc` 必须 rc=2 的正控，成功后断言日志数精确等于 RUNS。

其余原 major 三腿中的 rc/pipe 问题已闭合。

### [major] dirty gate 有 TOCTOU；运行中变脏仍报告 green

脚本只在循环前按第一次 `dirty` 决定是否拒绝；每轮虽重新记录 status，却不因变脏而失败。隔离 `/tmp` repo 实跑一个会修改 tracked file 后 rc=0 的命令：

```text
baseline-runs: 1 runs ... (clean)
run 01 rc=0
baseline-runs: 1/1 green ...
SCRIPT_RC=0
--- post-run status ---
 M tracked.txt
--- log provenance ---
=== tree : DIRTY
=== exit code : 0
```

因此“日志看起来合规但其实没测 commit”的第二个已证形态是：开始检查时 clean，测试/peer 在运行中写脏生产树；日志诚实标 DIRTY，但脚本仍 rc=0 并打印 green。建议每轮命令前后都复核 full HEAD 未变、status 仍为空；任一变化将 batch 判非门禁并 rc 非零。输出目录若位于 repo 内必须预先 `.gitignore` 或从 status 判定中精确排除本脚本自己的已知 log 目录，否则首次 log 自身会制造 dirty。

## T4 三态

### [major] `NOT-YET-IN-SCOPE` 仍是文档作者可自填的逃生舱；没有机械核对其后继归属与 RFC disposition

正文要求 `NOT-YET-IN-SCOPE + 具名后继相位`，并列 O-3/O-5/O-7/O-9 的合法样本；这修掉了正确项被判孤儿的 false-red，也禁止硬塞当前 commit/删出矩阵。但任意 IN-SCOPE 的 R-14 仍可被错误标为 `NOT-YET-IN-SCOPE: M7`，只要写了一个名字就绕过当前归属门；证伪条款没有要求该状态必须与 RFC §10.2/§10.3 的 disposition 同源、后继相位真实存在且反向 ledger 接住。

目标变异：把 R-14 从 Commit 4 改成 `NOT-YET-IN-SCOPE / M7`。当前规则下它不再是“无归属”，也没被删除或硬塞当前 commit，可能全绿。故三态确实变松。

建议改法：冻结 RFC-derived allowlist，只有 §10.3/§10.4 明列后续的 O-3/O-5/O-7/O-9（及未来经独立裁决加入者）可取 NOT-YET；每项后继 phase 必须与 RFC 原文精确相等，并在后继 plan ledger 有反向入口。正控：把 R-14 标 NOT-YET 或把 O-9 后继从 M7 改 P8，必须红。

R-6 调查项处置正确：RFC 行只有“辅助门；Commit 1/6”，读不出两段等级；禁止接手方自填避免创造孤儿契约。

## T2 五行表

### [major] 五行表混入两个并不含字面 Q1 的位置，却用只枚举 `/Q1/` 的命令声称“实测过”；生成命令无法产出清单

独立运行文中命令：

```text
645: §7.8 ... Q1必须已裁
692: §9.1 / Q1 heading
734: §9.4 ... Q1保持open
```

只得到 3 处。§4.7 当前不含 `Q1` 字面；§9.2 当前正确地不含 Q1。五行表作为**未来状态契约**可以包含这两处，但“核验命令”无法验证表的五行完整性，删掉 §4.7/§9.2 仍不会改变命令输出。证伪④及“删清单任一行”正控没有实际 oracle。

另有潜在漏位：§7.8 的具体 migration task 在同节目标/终态行，不只是首行停门；裁决后必须把 chosen scheme 接到该节任务，但表已把它归 §7.8，可接受，不需增第六位置。全仓语义搜索未见必须另列的位置；真正缺陷是五行表生成/校验方式不成立，而非仍漏第六处。

建议改法：建立机器可读五位置 manifest（heading/anchor，不靠 Q1 字面），脚本逐项检查：§9.1 status、§9.2 decision row、§4.7 key-shape marker、§7.8 stop+task marker、§9.4 stop；并校验没有第六个 Q1 decision marker。正控删任一 manifest entry 或错配 A/B shape 必须红。

## 第五轮汇总

- baseline 脚本：原 pipe/引号/rc 缺陷闭合，但新增实证 `RUNS=0` false-green 与运行中变脏仍 green 两条 major。
- T4：三态修掉合法 out-of-scope false-red，但缺 NOT-YET allowlist/反向后继核对，成为逃生舱，major。
- T2：五个语义位置本身未见漏项，但所称 awk 实测只能找到 3 处，五行完整性 oracle 失效，major。
- blocker：0；major：4；minor：2（`6cfa0e89` 全部提交、memory 阈值）；nit：0。
- verdict：**不可放行；仍不能声明“无未决 blocker/major”。**

# 第六轮复审：master `6d578b57`

复审基线：`6d578b5754c084f27e3d926c99bc54845c285d45`；逐 hunk 对照 `3be24a4d..6d578b57`。

## baseline-runs.sh

### 已闭合：空批次与 tracked-file drift 两条上轮 major

`RUNS`/`MIN_RUNS` 数字门和默认 15 floor 可拒 `RUNS=0/3/abc`；每轮 before/after status 变化计 failed，STOP_ON_FAIL 正确停。原六条正控加新控覆盖了已知形态。

### [major] 只比较 status 不比较 HEAD；运行中提交改动会 `drift=no`、`1/1 green`、rc=0

隔离 `/tmp` repo 实跑命令在运行中修改并 commit tracked file，使前后 status 都为空但 HEAD 改变：

```text
baseline-runs: 1/1 green at 17e5aae8...
BEFORE_HEAD=17e5aae8...
AFTER_HEAD=17c6dd91...
SCRIPT_RC=0
=== head : 17e5aae8...
=== tree : DIRTY
=== exit code : 0
=== tree drift : no
```

日志声称旧 HEAD，测试实际跨越/结束于新 HEAD；门仍假绿。建议每轮前后同时比较 full HEAD 与 status，并把二者写入 log；任一变化 rc 非零。另应在每轮开跑前要求 clean，而不是只比较前后相等——一个 peer 在 header 后、`before_tree` 前写脏并保持脏到结束时，before=after 同样假绿。

## T4 NOT-YET 白名单

### 已闭合：冻结五项 + RFC-derived 后继覆盖，逃生舱已封

白名单恰为 O-3、O-4 完整验收部分、O-5、O-7、O-9；R-14 申领 NOT-YET 必红。后继 phase 要由 §8 行覆盖，M7 通过 M2～M8 区间合法，M9 假红；并要求后继 ledger 具名入口。未发现可绕口子。O-4 partial split 被明确保留：Commit 4 靶向部分 IN-SCOPE，只有完整 P8 部分 NOT-YET。

## q1-locations.sh

### [major] 不同原理的语义查询发现 predicate 对未来措辞仍有盲区；§4.10/§4.8 可承载 Q1 决策影响却不被 checker 纳入

脚本当前 7/7 绿并抓住 4.12，说明比字面 Q1 强。但独立查询不用其 predicate，而按“telemetry/registry/schema/cube 域词 × query/choice/escalation 语义词”找候选，得到包含 §4.8、§4.10 等。人工 disposition：§4.10 当前列“新 schema 必须回答的问题”，其中第 4 项要求 profile/command partial 长期分布；Q1 若选 A/B/C，会改变它是否承诺 cross-axis query，因而可能需要同步。§4.8 的字段基数/存储分界也可能因选 B 改 typed tuple/dictionary 形状。两节均不含 `Q1|联合查询|compound dimension|multidimensional`，未来在此新增“跨轴过滤/tuple/cube”措辞可逃过 checker。

目标变异：在 §4.10 加“schema 必须支持 command × outcome × format 跨轴过滤”，不使用四个 predicate 词；`q1-locations.sh` 仍可能 rc=0。故“有没有未登记第八处”的承重全称断言未闭合。

建议改法：不要继续扩关键词。建立结构化 Q1 decision marker/ID：所有受 Q1 约束的 section 必须显式标 `Q1`（包括 destination marker，即使当前 absent 也放机器注释/表字段），checker 枚举 marker exact set；另以 section manifest 检查职责状态。这样新增 Q1 影响点而不加 marker 属 review/traceability 缺陷，可由双向矩阵抓，而不是靠自然语言 predicate 猜语义。

### 已核：当前七位置未见确定的第八处

独立语义查询候选很多，但逐节 disposition 后，§4.8/§4.10 是可能受裁决影响的邻接职责，不是当前另一个 open-state statement；§7.8 的 stop+task 同节可接受。因此当前清单“七处”未证少算；缺陷在未来 completeness oracle 的判别力。

## 第六轮汇总

- baseline：上轮 RUNS/status major 闭合，新发现 HEAD drift 仍假绿，major。
- T4：五项白名单与区间解析闭合，未见逃生舱。
- Q1：当前七处未见确定第八处；自然语言 predicate 仍无法支撑“未来无未登记处”全称门，major。
- blocker：0；major：2；minor：2（`6cfa0e89` 全部提交、memory 阈值）；nit：0。
- verdict：**不可放行；仍不能声明“无未决 blocker/major”。**

# 第七轮复审：master `ca19f7a8`

复审基线：`ca19f7a8ab28dd17ec3cd101e6fc4b7ee55dca25`；逐 hunk 对照 `6d578b57..ca19f7a8`。

## baseline-runs.sh

### 已闭合：HEAD + status 双轴 drift

运行前后 HEAD/status 任一变化均记 `YES:<axis>` 并 rc 非零；上轮 mid-run commit 假绿已被对应正控覆盖。

### [major] 未绑定被执行工具的身份；PATH 上假 `bun` 可零测试却产出合规 green artifact

隔离 `/tmp` repo，在 PATH 前置一个只打印 `fake bun: no tests executed`、rc=0 的可执行文件；不覆盖脚本默认命令：

```text
baseline-runs: 2 runs of [bun scripts/parallel-test.ts unit it http ] ...
run 01 rc=0 drift=no
run 02 rc=0 drift=no
baseline-runs: 2/2 green ...
SCRIPT_RC=0
=== command : bun scripts/parallel-test.ts unit it http
=== exit code : 0
=== drift : no
fake bun: no tests executed
```

这是“日志合规但没真跑”的已构造形态：命令文字正确、HEAD/status 稳定、日志完整、rc=0，但解析到错误 executable，零测试执行。自定义 `true` 也可 green，但脚本明确允许 override，单独不算缺陷；默认 gate 未记录/校验 `command -v bun` 的物理路径或 Bun 身份才是承重缺口。

建议改法：默认 gate 模式记录并校验 `command -v bun`、`bun --version`，最好使用项目/环境冻结的绝对 Bun 路径；并对 suite 输出做独立完成 oracle（必须出现预期 `parallel-test` batch terminus、测试数 >0、unit/it/http 三档均被枚举），缺 summary 不得仍 green。正控：PATH fake bun rc=0 必须红；合法 Bun + 真 suite 可绿。

尝试过的构造清单：空批次、测试 rc 被 tee 吞、参数词分割、起始脏树、运行中 worktree drift、运行中 HEAD drift、existing batch 混入、STOP_ON_FAIL=0、no-op override、PATH fake Bun。除已修项外，PATH fake Bun 仍成立，因此不能说“已无我能构造的形态”。

## Q1 降级措辞

### [major] 主体警告诚实，但 HANDOVER:90 与脚本头:14–15 仍直接声称“没有未登记第八处／list complete”

诚实边界写得清楚：rc=0 仅代表冻结 predicate 无新命中，不是完备性证明，扩写者欠人工通读。但两处未同步降级：

```text
HANDOVER:90 验收：...且没有未登记的第八处
q1-locations.sh:14–15 NO OTHER section matches ... i.e. the list is still complete. Adding a location anywhere must turn this red.
```

后一句是全称且已被上轮的“跨轴过滤”反例证否；前一句不加“命中冻结谓词”的限定，会让接手者仍把 rc=0 当语义零漏。脚本:108 注释还写“has a seventh location appeared?”，实际已有七处，应为 eighth，虽不影响行为但加剧歧义。

建议改法：HANDOVER:90 改为“七个冻结成员状态符合，且无未登记 section 命中冻结 predicate”；脚本头改为“NO OTHER section matches the frozen predicate; this does not make the list complete”，删除“Adding a location anywhere must turn red”。这样降级才全文自洽。

## 其余未决项核对

T2/T4/T5、21 次降级、R-6、五项 NOT-YET 白名单均维持闭合；本轮未发现其它 blocker/major。遗留 minor 仍是 `6cfa0e89`“全部提交”陈旧与 memory 阈值无探针。

## 第七轮汇总

- blocker：0；major：2（PATH fake Bun 零测试 green、Q1 两处残余完备性暗示）；minor：2；nit：0。
- verdict：**仍有未决 major，不能声明“无未决 blocker/major”，也不能把 HANDOVER 状态改为通过。**

# 第八轮复审：master `b5cb9b86`

复审基线：`b5cb9b86709e6a907e21464d4504d584c6abe762`；逐 hunk 对照 `ca19f7a8..b5cb9b86`。

## baseline-runs.sh

### [major] 默认 `MIN_TESTS=1` 仍允许 selector/runner 退化到只跑 1 条测试并报告整批 green

独立构造 PATH wrapper：记录的命令仍是默认 `bun scripts/parallel-test.ts unit it http`，wrapper 输出合法形状 `1 tests · 1 pass · 0 fail`、rc=0。未显式设置 MIN_TESTS（走默认 1）：

```text
baseline-runs: 1/1 green ...
SCRIPT_RC=0
=== resolves to : /tmp/.../fakebin/bun
=== version : 1.2.3-wrapper
parallel-test selector: 1 tests · 1 pass · 0 fail
=== exit code : 0
=== drift : no
```

因此原构造清单中的 PATH 假 Bun 仍成立，只是从“零输出”升级为“伪造/退化成一条测试的合法 summary”。二进制 provenance 让问题可见，但 gate 仍把它计绿；HANDOVER 的标准调用未设置 `MIN_TESTS=6845`，所以默认门实质只防零测试，不防测试发现矩阵坍缩。另实测 `MIN_TESTS=0` + `true` 仍 green，且 MIN_TESTS 没有数字/下限校验。

建议改法：gate 模式默认 floor 必须来自 entry commit 的冻结测试发现 manifest，而不是 1；至少 HANDOVER 标准调用显式 `MIN_TESTS=<entry expected count>`。更稳的是校验 unit/it/http 三档各自发现集/计数与总数，不能只信一条可伪造 summary。验证 `MIN_TESTS` 为正整数；低于 1 rc=2。PATH provenance 只作人工审计，不应被描述为自动挡住敌意 wrapper。

新增尝试：① fake Bun 伪造 6845 summary——仍 green，但这是文档已诚实排除的敌意 PATH，不能要求本地脚本解决；② `MIN_TESTS=0 true`——green；③ fake selector 只报 1 test、默认 MIN_TESTS=1——green，属于非敌意 test-discovery collapse 也会发生的真实 false-green，故列 major。

## Q1 措辞

### [minor] 主要措辞已诚实降级，但脚本 HONEST BOUNDARY 内仍写“this script would call the set complete”

HANDOVER:93–94 已准确限定为“冻结名单外无 section 命中冻结 predicate”，并摆出 §4.8 反例；不再暗示 rc=0 语义完备。脚本头:12–17 也正确。

剩余一句位于脚本:48–52：未来同义措辞绕过时“this script would call the set complete”，与当前脚本实际输出/声明不符，也会让读者误以为工具仍作 complete verdict。建议改成“the frozen-predicate tripwire would stay green”，保持全篇同一语义。脚本:143 注释“has a seventh location appeared?” 仍是陈旧计数，应改 ninth/unlisted；仅措辞 minor。

当前八成员中 §4.8 使用独立精确 pattern，PHASE pre/post 与 matching-lines-only 修订合理；未发现新的状态 false-red。

## 其余未决核对

T2/T4/T5、21 次降级、R-6、NOT-YET 白名单均维持闭合；除 baseline floor major 外，无其它未决 blocker/major。遗留 minor：`6cfa0e89`“全部提交”、memory 阈值、Q1 两处残余措辞。

## 第八轮汇总

- blocker：0；major：1；minor：3；nit：0。
- verdict：**仍有未决 major，不能声明“无未决 blocker/major”。**

# 第九轮复审：master `10400275`

复审基线：`10400275c6cede87159ab5112bcc66e1ab028419`；逐 hunk 对照 `b5cb9b86..10400275`。

## baseline-runs.sh

### 已闭合：未设 floor、低于 floor、批次内 count drift

独立复跑：未设 `MIN_TESTS` rc=2；假 selector 报 1、`MIN_TESTS=6845` rc=1；100→42 的两轮批次在 `STOP_ON_FAIL=0` 下跑完仍 rc=1。上轮具体构造已全部被新门挡住。

### [major] floor 仍由同一待验证 selector 自校准；稳定漏测可把较低错误数冻成“预期”并整批 green

HANDOVER 要求“先在该 commit 上跑一次拿到真实用例数，再冻进命令”。若 selector 在这次校准前已稳定漏掉一组测试，调用方会把错误低值当真。独立构造稳定只报 6800 的 selector，再按其“实测值”设 `MIN_TESTS=6800`：

```text
run 01 ... 6800 tests · 6800 pass · 0 fail
run 02 ... 6800 tests · 6800 pass · 0 fail
baseline-runs: 2/2 green
SCRIPT_RC=0
=== tests seen : 6800
```

这不是“批次中途退化”，所以 count 一致性抓不到；也不必假定敌意 PATH——真实 `parallel-test.ts` 的稳定发现回归同形。floor 与被测 selector 同源，属于自洽 roundtrip，不是独立 oracle。

建议改法：floor 必须来自 entry commit 之外的可信基线或运行时 test-name manifest 差分，并对合法新增/删除逐项 disposition；至少把“同一坏 selector 先跑一次得 floor”明确降级为已知边界，不得宣称证明 full suite。项目已有 `test-discovery-matrix`，应让 entry gate保存/比较 unit/it/http 三档运行时枚举集合，而不只总数。

收敛判断：这是 baseline capture gate 的承重语义，不是无限加固自然语言绊线；只要它声称“全 backend suite 被执行”，同源自校准就仍是缺陷。若脚本只降级为“记录调用方指定命令的重复运行”，则该项应记已知边界而非缺陷，但 RFC 入场条件还需另一个 full-suite oracle。

## Q1 措辞

### 已闭合：完备性已诚实降级为冻结谓词绊线

HANDOVER 与脚本头均明确 rc=0 只表示冻结名单外无新 section 命中冻结 predicate，不表示集合闭合，并用 §4.8 作为已发生反例。上轮两句残留已清；当前 `all listed/no unlisted` 均被紧邻的“tripwire, not completeness proof”限定。未发现仍暗示语义完备性的句子。

## 其余未决核对与 verdict

T2/T4/T5、21 次降级、R-6、NOT-YET 白名单维持闭合。除 baseline 同源 floor major 外，无其它未决 blocker/major。遗留 minor 仍为 `6cfa0e89`“全部提交”陈旧与 memory 阈值无探针。

- blocker：0；major：1；minor：2；nit：0。
- verdict：**仍有 1 个未决 major，不能声明“无未决 blocker/major”。**

# 第十轮复审：master `5a71607f`

复审基线：`5a71607f3a886bb34c34147916d252d523d88ad2`；逐 hunk 对照 `10400275..5a71607f`。

## [major] 声称没有按处置说明完整降级：精确定义与 T3-b 未落到 HANDOVER/脚本

协调方声称脚本新增 “WHAT THIS SCRIPT CLAIMS, precisely / WHAT IT DOES NOT CLAIM”，但 `git diff 10400275..5a71607f -- baseline-runs.sh` 实际只新增 `MIN_TESTS` 的三行“derive floor elsewhere”警告；脚本仍以：

```text
# Capture N independent full-suite runs as verifiable artifacts.
# The command defaults to the full backend suite.
```

开头，未出现具名命令重复调用的精确 claim，也未出现 “does not claim full backend suite executed”。这两句仍超出脚本能证的范围。

协调方还声称把独立 full-suite 缺口列成 HANDOVER T3-b，含 junit × 磁盘 glob、422/181/67 与文件名集合相等；全仓精确搜索结果只有 `baseline-run-log.md:19` 一句“已列为 HANDOVER 的 T3-b”，HANDOVER 本身不存在 T3-b、junit、glob 或三项计数。即交接指针指向不存在的待办，缺口事实上仍被吞在运行日志叙述里。

HANDOVER:109–114 仍把同源 `MIN_TESTS=<在该 commit 上实测到的用例数>` 的脚本直接列为 T3 修复 AC④，而没有把 AC 强度限定为“具名命令重复运行”；因此接手者仍会把它当 RFC §7.1 full backend 入场证据。

判定：未达到我上一轮给出的放行口径。`baseline-run-log.md:19` 的降级文字方向正确，但它不能覆盖脚本自身和 HANDOVER 验收条款的相反声称。

需要的不是继续加固脚本，而是把已承诺的边界真正落到两个权威入口：脚本精确 claim/does-not-claim，以及 HANDOVER 具名 T3-b；同时 T3 AC④ 明确在 T3-b 落地前只能证明缩小版命题。

## 第十轮 verdict

- 剩余同源 floor 应在完成上述落地后记为已知边界，而非继续加固。
- blocker：0；major：1；minor：2。
- verdict：**仍有未决 major；不能声明“无未决 blocker/major”。**

# 第十一轮复审：master `962a3eea`

复审基线：`962a3eea0c8fe2161fd564132363124d074cadcd`；直接读取 commit object 中的产物，不采信提交信息或协调方描述。

## [major] 主体边界与 T3-b 已真实落盘，但脚本第 2 行仍保留相反的 full-suite 声称

已核实真正落地：

- `baseline-runs.sh:13–24` 现有 precise claim：只证具名命令在同一 commit 被调用 N 次、provenance、自报计数稳定且高于调用方 floor；明确 `WHAT IT DOES NOT CLAIM: "the full backend suite executed."`，并记录同源 6800 构造。
- `HANDOVER.md:115` 将 T3④限定为缩小版命题；`HANDOVER.md:117–123` 有真实 T3-b，含 junit × 磁盘 glob、unit 422 / it 181 / http 67、文件名集合相等、只比总数的证伪与优先级。

但同一脚本开头仍逐字写：

```text
exp/inter-block-anchor-allocator/baseline-runs.sh:2
# Capture N independent full-suite runs as verifiable artifacts.
```

这句直接把 artifact 称为 `full-suite runs`，与第 17–18 行“不声称 full backend suite executed”矛盾，也正好超出缩小口径。第 36 行“The command defaults to the full backend suite”只描述默认 argv，可由后文边界限定；第 2 行则描述脚本产物本身，不能这样解释。

判定：尚未完全降到我上一轮给的放行口径。具体只剩这一句需改为例如“Capture N invocations of a named test command as provenance-bearing artifacts”。改后同源 floor 可记已知边界，T3-b 承接 full-suite oracle 缺口。

- blocker：0；major：1；minor：2。
- verdict：**仍不能声明“无未决 blocker/major”。**

# 第十二轮复审：master `9a8c0cf5`

复审基线：`9a8c0cf5dad8a50c67e7207eec9c3acec642b087`；直接读取 commit object。

`exp/inter-block-anchor-allocator/baseline-runs.sh:2–6` 已改为“记录同一 commit 上具名测试命令的 N 次调用及 provenance”，并在首屏明确不说 full-suite/verifiable；`WHAT THIS SCRIPT CLAIMS/DOES NOT CLAIM`、同源 6800 已知边界、HANDOVER T3-b 与 T3④缩小版限定均保持一致。

脚本第 4 行出现 `full-suite`/`verifiable` 仅是否定式历史说明，不是行为主张；无需为零文本命中而改写。

判定：声称已降到“仅记录指定命令重复运行”的口径。**剩余项应记为已知边界而非缺陷；无未决 blocker/major。**

遗留 minor 仍按 HANDOVER 头部登记，不影响放行。

