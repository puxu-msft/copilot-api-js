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

