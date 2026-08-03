# M1 形状裁决：全量 command algebra vs 候选 A

> 裁决时间：2026-08-03。被裁对象：候选 A 与全量 command algebra。仓库代码只读；本文件是用户明确要求的唯一裁决产物。

## 争议清单、裁决态与资格

- 裁决资格：**具备**。我未参与本轮设计、两位设计评审、上一轮轴裁决或实施。
- [1] “A 把推断放在承重位置，仍会重演前四次绕过”：**部分成立**。A 确实让 classifier 同时承担识别与路由；但“仍是同一种推断”不成立，且全量方案也不能消灭 classifier。
- [2] “A 的正确性依赖尚未完工的 C1”：**部分成立**。当前设计文字确实用 index 与 owner record 匹配来判 provenance，双命中语义未写；但它真正需要的是“授权 record 对同一 index 至多一个”的不变量，C1 只是充分而非必要条件，而且 A 可在双命中时 fail loud。当前 allocator primitive 已有强单调性，完整 production 接线仍未完成。
- [3] “A 的魔法 write 增加长期维护成本”：**部分成立，且方向支持全量方案**。隐藏 effect absorption 确实降低接口可读性与调用意图可观测性；但后来写腿的人不必各自实现判定，集中 classifier 仍会兜底，故“每个人都必须知道魔法”说得过满。
- [4] “非 Anthropic 三种格式会被强套 indexed lifecycle，构成过度设计”：**不成立于 §2.4 当前形状**。显式 `indexedBlockLifecycle: none` 与 capability-shaped command port 已把 Anthropic allocator 隔离；剩余共同 command algebra 是所有格式本来就有的 generation terminal、observation、serializer 与 transport ownership，不是伪造 block lifecycle。
- [5] 可观测性：**支持全量方案**。全量方案有独立的“调用方声明的 command intent”与“classifier 观测的 actual effect”；A 只有 `write` 与推断 effect，不能区分“故意请求 close”与“本想 generic 却误发 close”。若给 A 补 intent/cause 字段使之可区分，它会向 command algebra 收敛。
- [6] 最终形状：**支持全量 command algebra**。当前不存在需要等待的价值观分叉；在冻结裁判轴“长期架构健康／可维护性／可观测性优先，工程量不得否决”下，全量方案严格更优。

## 判据

本次不重裁两案能否闭合 anchor 原子不变量，只比较长期形状。采用四个可核验判据：

1. **语义意图是否是一等输入**：系统能否在发送前比较 caller intent 与 wire effect，而不是只能从 wire value 反推 intent。
2. **错误是否 fail loud 且可定位**：错误报告能否指出“哪个 command、预期什么、实际分类成什么、在哪个 owner state 下失败”。
3. **跨格式抽象是否按 capability 分层**：无 indexed lifecycle 的格式是否不创建／不暴露 Anthropic allocator，而共同 lifecycle 是否仍统一。
4. **依赖不变量的强度**：安全性是依赖单调 frontier 才成立，还是在 frontier 失效时也能拒绝歧义；依赖的是当前实装事实还是尚未闭合的计划事实。

## [1] “A 把推断放在承重位置”

**裁决：部分成立。结论方向支持全量方案，但主会话把两类推断说成同一种，论证过度。**

### 成立的部分

A 的唯一 public emission 入口仍叫 `write(frame)`，owner 必须先把 frame 分类成 `close-block(index)`，再决定这是 anchor close、real close 还是非法 effect（设计 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/tmp/2026-08-03-m1-owner-wire-boundary-design.md:205-213`）。因此 classifier 漏识别一种合法 block-close 形态时，A 缺少第二个独立的 caller-intent 信号；只剩下“这是一次 write”这个无语义事实。若漏识别结果落为 generic，承重 effect 会被当普通 emission；若选择 unknown→throw，则会安全失败但失去协议扩展的可用性。

全量方案则有两个独立输入：caller 选择的 command（例如 `writeRealBlockFrame`／`closeOpenAnchor`／`terminate`）表达**预期 intent**，classifier 表达 frame 的**实际 effect**。两者不一致时可以在 external write 前报 `CommandEffectMismatchError`。设计已明确把 generic 限制为 classifier 证明“不改变 owner-governed state”，并要求 structured parse failure throw（同文件 `:87-111`）；也明确 full 方案的 generic block effect 是 command/effect mismatch（`:113-121`）。这不是“完全不推断”，而是把推断从唯一 authority 降为交叉验证的一条腿。

当前代码展示了缺少第二信号会产生什么：公共 `clientSink.write` 只是把 frame 包成 candidate envelope，然后进入 generic serializer（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/delivery/session.ts:483-491`）；generic `write` 只运行 `applyPendingFrame`、physical write、`applyWireFrame`，不会清 `wireState.openAnchorIndex`（同文件 `:127-138`）。anchor close 的 canonical transition 只存在于具名 `closeOpenAnchor` command（同文件 `:417-447`）。上一轮实测已经造出“wire ledger 已关，但 `openAnchorIndex` 仍为 0”的普通 `write(stop)` witness（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/tmp/2026-08-03-m1-guard-axis-adjudication.md:57-67`）。A 能修这个 witness，但修法是依赖 classifier 把它吸收；full 则把合法 producer 迁到具名 command，并让 adversarial generic stop 触发 mismatch。

### 不成立的部分

“从语法推断挪到语义推断，没有换掉推断本身”把关键差异抹平了。前几轮的 regex／类型墙是在源码表示层枚举**写法**，变量提取、assertion 或另一条合法调用形态即可绕过；`DeliveryEffectClassifier` 归一的是运行时 frame 的**协议 effect**，alias、wrapper、变量提取都不会改变同一 frame 的 effect。上一轮裁决也已确认真正应归一到 owner canonical state，而不是源码拼写（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/tmp/2026-08-03-m1-guard-axis-adjudication.md:14-37,139-159`）。所以不能仅凭“都叫推断”预测 A 会以同样方式被合法源码变体绕过。

此外，全量方案也不能删除 classifier。`emitGeneric` 必须靠 classifier 拒绝 owner-governed effect，builders 也必须验证所构造 payload 的 effect；设计诚实写明“classifier 天然正确”未被证明，需要 per-format fixtures／真实 SDK oracle（owner-wire 设计 `:316-325`）。因此第 1 条若理解成“full 无推断而 A 有推断”就是错误；准确结论是：**A 让 classifier 同时充当识别器与 command dispatcher，full 让 explicit intent 与 classifier effect 相互校验。后者的故障模式更偏向 fail-closed，且可诊断性更强。**

### 对后续的影响

选择 full 时不能因为 command 显式就削掉 classifier／effect mismatch；否则 generic 入口仍可能承载 owner-governed effect。选择 A 时则必须把 unknown structured effect 默认设为 throw，并对每个 format 的 owner-governed effect 做独立 oracle；仅记录推断结果不够。

## [2] “A 的正确性依赖尚未完工的 C1”

**裁决：部分成立。当前文案有真实的授权歧义，但“必须依赖完整 C1 才能正确”不成立。**

### A 实际依赖什么

A 的设计规则是：`close-block(index)` 精确匹配 active anchor lease 时提升为 anchor close；匹配 real mapping 时按 real stop；无匹配 record 则 throw（owner-wire 设计 `:205-213`）。要使这条规则成为总函数，至少需要以下三态互斥：

1. index 只命中 active anchor；
2. index 只命中一个 active real mapping；
3. index 无命中。

文案没有定义“同一 index 同时命中 active anchor 与 real mapping”或“命中多个 real mappings”时谁优先。这是具体缺口，不是措辞问题。若实现用 `if anchor ... else if mapping`，真实 stop 在碰撞状态会被误提升为 anchor close；若 mapping 优先则 anchor stop 会被误当 real close。正确防御应是先收集 authorization matches，断言 cardinality 恰为 1；0 或 >1 均在 external write 前 fail loud。

因此 A 真正依赖的是较窄不变量：**一个 generation 的 active authorization registry 中，同一 wire index 至多对应一个 owner record。** C1“唯一 monotonic frontier、永不复用”是它的强充分条件，却不是必要条件。即使 C1 因 bug 失效，A 仍可通过 cardinality check 安全拒绝歧义；这时损失可用性，但不会静默误判。反过来，若 A 不做 cardinality check，主会话第 2 条成立得更强。

### 当前 C1 的实装强度

allocator primitive 本身已经是强单调 reservation：`wireCounter` 是唯一 next index；`reserveAnchor` 与 `reserveRealBlock` 都读取同一个 counter，只有 `commit()` 才递增，`rollback()` 不递增（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/anthropic/keepalive-anchor.ts:52-103`）。`beginLeg` 只换 leg token，不重置 counter（`:77-81`）。我在被审树执行只读 probe：

```text
[["anchor-reserved",0,0],["real-primary-reserved",1,1],["anchor-before-rollback",2],["frontier-after-rollback",2],["real-continuation-reserved",2],["frontier-final",3]]
```

命令是：

```bash
bun -e 'import { createGenerationWireIndexAllocator } from "./src/lib/anthropic/keepalive-anchor.ts"; /* reserve/commit/rollback across primary+continuation */'
```

该观测证明 primitive 层：committed anchor@0、real@1 后 frontier 到 2；rollback 的 anchor@2 不消费 index；continuation real 随后合法使用 2；commit 后 frontier 到 3。它不证明全 production 接线都使用该 primitive。

完整 C1 在当前 production 尚未落成。冻结 README 明写 `P3M / P7 / P8 待执行`，且 C1 要求**所有**真实块、anchor、continuation／recovery 都走唯一 allocator（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/plan/2026-07-27-inter-block-anchor-allocator/README.md:1-4,49-60`）。代码搜索结果中 `withAllocatedRealBlock(` 与 `writeBlockFrame(` 在 `src/` 只有接口／owner 定义，没有 production consumer；已接线的 production command 只有 anchor open 与若干 close。与此同时 legacy split-phase API `onAnchorOpen`／`onRealBlockOpen` 仍公开保留（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/types.ts:504-526`），`AnchorState` 仍保留 legacy `anchorBlockOpen`／`anchorClosed`（同文件 `:529-553`）。所以“当前整个系统已有 C1”是错误；准确说法是“allocator primitive 已具 C1 形状，M2–M8 尚要把所有腿接入”。

composition root 也证明目前 allocator 只在 Anthropic Messages 构造：`makeAnchoredSseSink` 创建 allocator／wireState 并传给 delivery sink（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/routes/messages/handler-v4.ts:1124-1168,1192-1200`）；非 Anthropic sink 不带 wire state。

### full 是否完全不依赖 C1

也不是。full 的 `writeRealBlockFrame(leg, upstreamIndex)` 最终仍依赖 mapping registry 唯一映射，`closeOpenAnchor` 仍依赖 active lease，整个 wire 协议仍要 C1 保证客户端 index 单调无复用。full 的优势不是消灭 C1，而是**不需要从一个裸 `close-block(index)` 值反推出 caller 的业务 intent**：caller 已选 command，owner 再按该 command 查对应 registry；碰撞可作为 state corruption 报错，而不是参与 dispatch。

### 对后续的影响

若采用 A，设计必须新增 authorization cardinality rule 与双命中 mutation oracle；否则第 2 条应升级为“成立”。若采用 full，仍须完成 M2–M8 与 C1 producer oracle，不能宣称 command 类型替代 frontier 正确性。

## [3] “A 的 `write` 有魔法，调用方从签名读不出来”

**裁决：部分成立，且在本项目裁判轴下足以支持 full；但“每个后来写腿的人都必须知道魔法”过度。**

成立之处是接口语义：A 的 `write(frame)` 既可能是 ordinary generic emission，也可能因 runtime effect 与 registry 状态被提升为 anchor close 或 real stop。签名不表达这三种后果，代码评审不能从 call site 看出 caller 认为自己在做什么。当前 driver 已有多个裸 `sink.write(...)` fan-in（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/driver.ts:948,952,1048,1265,1319`），当前 live decorator 也先做 close command、再裸写 transformed frame（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/anthropic/live-reconcile.ts:138-158`）。在 A 下，这些表面相同的调用会因 payload 与 owner state 具有不同事务语义；在 full 下，producer 或统一 dispatcher 明确选择 `emitGeneric`、`openRealBlock`、`writeRealBlockFrame`、`terminate`，意图能被类型与 code search 直接看见（owner-wire 设计 `:97-111,199-203`）。

不成立之处是组织责任。A 并不要求每个新 producer 自己识别 anchor close；只要它把 frame 送进 owner，classifier 会集中处理。不了解“魔法”的 producer仍可得到正确吸收或 fail loud。因此维护风险不是“每个作者必须背隐式规则，否则正确性必坏”，而是：

- 调用方不能显式声明预期，reviewer 无法从 call site 区分 intentional close 与 accidental close；
- 新 effect 加入 classifier 后，旧 `write` call site 的运行语义可能在不改调用代码的情况下改变；
- telemetry 只能记录推断后的 effect，不能证明 producer 本来想发什么；
- API 文档必须解释 `write` 的隐藏状态机，类型系统无法枚举 protocol-specific capability。

full 的维护成本也真实存在：要维护 per-format profile、classifier、command/effect compatibility matrix 与更多 command variants；新增 vendor event 必须决定它属于 generic、terminal 还是 indexed lifecycle。可是这不是纯额外成本——A 同样需要 per-format classifier 与 profile，且同样要决定 effect；full 多出来的主要是**显式 intent algebra 与 typed dispatch**。在本项目明确把长期可维护性／可观测性置于工程量之上时，这部分显式性是收益，不是可否决的负担。

### 对后续的影响

full 的 public command port 应按 capability 分型，而不是给所有格式暴露一个巨型 union 后在 runtime 抛“不支持”：共同 port 只含 generic／keepalive／terminal；Anthropic profile额外提供 indexed-block commands。这样 API 可读性收益不会被一个全能大接口抵消。

## [4] A 的最强反论：四格式全量 algebra 是否过度设计

**裁决：不成立于 §2.4 已修订形状；`indexedBlockLifecycle: none` 基本化解了反论。**

独立代码事实表明“共同 owner、格式特有 allocator”不是凭空抽象：

- 四个 streaming vendor 已共享 generation delivery owner。Gemini 用 `makeDeliverySseSink`（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/routes/gemini/handler-v4.ts:422-438`）；Responses WS 用 `makeDeliveryWsSink`（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/routes/responses/ws.ts:345-369`）；Chat Completions、Responses HTTP、Messages 也都有对应构造点。raw factory把 transport／observation交给 `createDownstreamDeliverySession`，非 Anthropic不传 `wireState`（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/client-sink.ts:489-525,695-711`）。
- Anthropic allocator 只在 Messages 的 `makeAnchoredSseSink` composition layer 构造并注入（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/routes/messages/handler-v4.ts:1124-1168,1192-1200`）。
- Responses WS 注释明确“无 mid-stream block/anchor needs”，但仍需要 operation terminal、heartbeat、sampling 与 finalization（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/routes/responses/ws.ts:372-383`）。Gemini 同样没有 anchor，却仍通过 owner运行 generation并有 error terminal／settle（Gemini handler `:415-446`）。

设计 §2.4 没有要求三种非 Anthropic 格式实现假 block state；它要求每个 format profile 显式声明 owner-governed effect set，非 Anthropic声明 `indexedBlockLifecycle: none`，不创建 allocator，且对应 command port不暴露 block commands（owner-wire 设计 `:123-135`）。这正是 capability segregation，而不是“为了统一而统一”。

仍需防一个实现退化：若最终 TypeScript API 是所有格式都拿同一个包含 `openAnchor`／`writeRealBlockFrame` 的大接口，只靠 runtime profile 抛错，那么反论重新成立一部分。设计文字已写“只存在于具该 capability 的 command port”（`:134`）；实施必须用类型层的 discriminated profile／capability composition兑现它。只在 runtime 放一个 `none` 布尔值而不收窄接口，不算化解。

更重要的是，A 也需要 per-format classifier，因为 A 必须知道一个裸 frame 是否是 block close、real mapping stop、terminal 或 generic。故 profile 的基础成本不是 full 独有。full 增加的是让已经存在的共同 owner responsibilities——serializer、observation、keepalive、terminal、operation seal——变成显式 command；这与当前四格式都已共享 owner 的事实一致，不是无需求的抽象。

## [5] 未被主会话充分展开的判据：可观测性

**裁决：full 有实质、可操作的优势；不是仅仅“日志名字更好看”。**

### 当前观测基线

当前 snapshot 只有 session state、winner、wire ledger、rounds 与总 `writeCount`（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/delivery/types.ts:45-52`）；partial failure 只持 `OwnerOperation + cause + committed`（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/delivery/session.ts:275-280`，History schema在 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/history/types.ts:217`）。generic write failure日志统一为 `[delivery] owner wire write failed`（session `:312-355`）；它没有 caller intent、classifier effect、target record、command id或 state-before/state-after。

设计已要求 validated envelope 带 command identity、provenance、candidate identity与 observed time，并在 external attempt 前采样、成功后更新 post-wire state（owner-wire 设计 `:75-85`）。这为两案提供相同的 transport observation 下限，但 command identity 的语义质量不同。

### full 能观测、A 原生观测不到的差异

假设某 producer 本来只想发 ordinary metadata，却因 codec bug 产生了 `content_block_stop@index`：

- **full**：记录 `requestedCommand=emitGeneric`、`classifiedEffect=close-block(index)`、`match=active-anchor|real-mapping|none`，在 physical send 前以 `CommandEffectMismatchError` 拒绝。诊断直接回答“producer intent 与 payload effect 不一致”。
- **A**：记录 `requestedCommand=write`、`classifiedEffect=close-block(index)`，若 index 恰好匹配 active anchor，系统会把它当合法 anchor close并成功吸收。遥测能回答“发生了什么”，却不能回答“这是 producer 有意请求 close，还是 accidental payload 碰巧命中 lease”。两种因果在输入上不可区分。

再看合法 close：

- **full** 可以稳定按 command family 聚合 success／preflight-refusal／wire-partial／mismatch latency与计数，例如 `closeAnchorBeforeRealAndOpenBlock` 的 build-validation 时间、stop 成功但 real-start 失败次数、`terminate` 平衡 anchor 次数。command 名称是低基数、设计冻结的业务维度。
- **A** 的所有普通生产帧先进入 `write`，只能在 classifier 后按 effect聚合。对于 compound “close→real start”，若仍要做原子 command，A 也必须另有 compound API；普通 write telemetry与compound telemetry形成两套语义。更关键的是，classifier版本变化会让历史 `write` 样本重新分桶，调用方 intent不可恢复。

错误定位也不同：full 的 mismatch 可携 `commandId, requestedCommand, expectedEffects, actualEffect, formatProfile, leg, upstreamIndex, leaseId, wireIndex, stateVersion`；A 的失败至少能携 `actualEffect + matches`，但没有 requested semantic action。给 A 增加一个 `expectedEffect`／`purpose` 参数能弥补；然而一旦这个字段是 owner必须验证的枚举，它就是 command discriminator，A 已开始收敛为 command algebra。

### 公平限制

full 不会自动产生好 telemetry。若实现仍只打统一错误字符串，或 command id 不进入 envelope／History，优势不会兑现。反之，A 可以记录 inferred effect、match source、lease id、state transitions，达到很好的“发生了什么”观测。裁决差异只在**因果可辨识性**：没有独立 intent 输入，A 无法从事后数据重建 caller 意图；这是信息论上的缺失，不是多加日志可以补。

### 建议的最小 per-command 遥测契约

无论采用 full，至少冻结以下 bounded fields：`command`, `commandId`, `formatProfile`, `expectedEffect`, `actualEffect`, `targetKind`, `wireIndex`, `legKind`, `outcome`, `committed`, `wireTorn`, `stateBefore`, `stateAfter`；高基数 candidate／dispatch／lease identity进入 trace／History detail，不进入全局 counter labels。compound command另记 phase（`validated`, `stop-sent`, `real-start-sent`, `terminal-sent`）。这比“一次 write 失败 + 推断出的 effect”能直接定位 intent mismatch、partial phase 与调用来源。

## [6] 最终裁决

**支持全量 command algebra。** 在用户给定的裁判轴下，不是“二者都行，请按偏好选”，也不需要因工程量停下来。两案都能闭合冻结的不变量，但 full 长期严格多保留了一项独立事实：**caller 的 semantic intent**。它让 owner 能在 external write 前做 `intent × classified effect × canonical authorization` 三方校验；A 只有 `classified effect × authorization`，成功吸收时无法区分故意 close 与 accidental close。这个差异同时改善可维护性、fail-loud 能力与可观测性，而工程量不被允许作为否决理由。

存在一个可判定的条件，在它成立时 A 可能反而更自然：**producer 在 frame 构造前没有稳定、真实的 semantic intent；业务语义只能由最终 wire frame 与 owner state发现，强迫 producer选 command 只会制造虚假声明。** 当前该条件**不成立**：

- anchor open／close 的 caller 已明确调用 `allocateAndWriteAnchor`／`closeOpenAnchor`（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/anthropic/keepalive-anchor.ts:306-313`；`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/anthropic/live-reconcile.ts:138-157`）；
- real-block API 已要求 caller持有 `LegToken + upstreamIndex`，说明 real lifecycle intent在 emission 前可知（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/types.ts:319-332`）；
- handler明确知道 terminal／synthetic error／`[DONE]` 的业务时点，设计出口审计已枚举这些 call sites（owner-wire 设计 `:22-38`）；
- 非 Anthropic producer也知道 terminal与 ordinary event的差别，只是不具 indexed lifecycle capability。

所以 full 不是把不可知意图硬编码进类型；它是在 API 中保留调用方已经拥有、A 会丢掉的信息。

### 对主会话三条理由的最终核对

| 理由 | 裁决 | 精确修正 |
|---|---|---|
| 1. A 仍把推断放承重位置 | **部分成立** | classifier仍承重，但它是运行时语义归一，不是前四次的源码拼写推断；full 也需要它。full 的优势是多一条 explicit intent 作交叉验证。 |
| 2. A 正确性依赖未完工 C1 | **部分成立** | 当前 A 文案漏了双命中语义；真正依赖 authorization index uniqueness，C1是充分条件。加 cardinality check 可在 C1 失效时 fail loud。当前 allocator primitive强，production全腿接线未完成。 |
| 3. `write` 魔法增加维护成本 | **部分成立** | API/评审/遥测确实不可见 intent；但集中 classifier 会兜底，不是每个作者都必须手工掌握判定。净方向仍支持 full。 |

### A 最强反论的最终核对

`indexedBlockLifecycle: none` **确实化解了主要过度设计风险，前提是类型层也按 capability 收窄 command port**。共同 owner algebra只统一每种格式本来就有的 serializer、observation、keepalive、terminal 与 operation seal；Anthropic allocator／mapping／anchor commands只出现在 Anthropic capability。若实施成所有格式共享一个含 block methods 的大接口、只在 runtime用 `none` 拒绝，则反论重新部分成立，必须阻止该退化。

### 后续影响与路由建议

1. 由 `gpt-souls:architect-advisor` 把 D8 冻结为 full，并补齐：capability-shaped command port、A 暴露出的 authorization cardinality invariant（即使 full 也应作为 state-corruption assertion）、per-command telemetry schema。
2. 由 `gpt-souls:planner` 把 12～18 production 文件与 35～50 test 文件迁移切成单向、每 commit可验证的阶段；工程量如实记账但不得回退到双轨。
3. 由 `gpt-souls:implementer` 承接代码；由 `gpt-souls:verifier` 独立构造 `intent/effect mismatch`、双命中 state corruption、compound partial-phase 与四格式 profile witness。
4. 最终 production surface删除裸 `ClientSink.write`，但 classifier与 `emitGeneric` mismatch validation必须保留；不能把“显式 command”误当成不再需要 runtime effect验证。

## 附带观察

无。本次只收敛 A 与 full 的既有争议，没有把取证中遇到的其他问题混入裁决。
