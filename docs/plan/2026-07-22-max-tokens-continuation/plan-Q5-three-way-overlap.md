# Plan-Q5: 三方叠加集成设计（续写×顺序 anchor×重复截断，M 后 P1 前）

> **修订记录（2026-07-23，据 GPT plan-review [major] 修订）**：spec §13 Q5 要求的「三方叠加时序图」+ index/挂载层次/预算账，此前只在 README Global Constraints 提了一句"须画清"，未落到任何具名 plan task——审查指出这不能靠 P4 的 merged-state review 泛化检查覆盖，必须是独立的、M 之后 P1 之前的 integration-design task，产出至少一个三方生产 oracle。
>
> **修订记录二（2026-07-23，据 GPT plan-review round-2 [残留] 修订，index 账错误）**：round-2 亲自核实 `src/lib/pipeline/driver.ts:1145-1149` 的真实计数逻辑后发现，第一版时序图的核心结论**是错的**：原图声称"续写 offset 的计数必须包含 anchor 占位块"，但 master 实际实现是**`wireDeliveredBlocks` 只在 `continuation.isContentBlockStart(frame)` 为真时递增**（`:1149`），而 anchor 帧是通过 `sink.writeAnchor()`（在 injector 里，`keepalive-anchor.ts:235/261`）直接写出、**完全不经过 `flushBufferedFrames` 的 `for (const frame of toFlush)` 循环**——anchor 帧从未参与这个计数器的递增判断。**anchor 的 index 偏移由内层 `anchor.remap(frame, 1)` 独立负责**（`:1145`），续写的 offset 只处理"真实内容块的 wire 计数"，两次 remap 是**链式组合**（`outFrame = anchor.remap(frame,1)`，然后 `if (continuationOffset>0) outFrame = continuation.remap(outFrame, continuationOffset)`），不是"续写 offset 内含 anchor 占位数"。按原图的错误结论实现会导致续写块 index **多算一次 anchor 占位**、产生空洞（如本该是 `anchor@0→real@1→continuation@2` 却因 offset 多算 1 变成 `anchor@0→real@1→continuation@3`，index@2 永远不会被写出）。本次已据实重画。
>
> **额外核实发现（承重，round-2 未直接点名但据实追加）**：`driver.ts:1026-1027` 的现有注释明确写道「Scoped to the anchor-DORMANT path (D2 default `stream_keepalive_mode: ping`, PoC-validated); the empty_text-anchor + continuation combo is an **untested corner (backlog)**」——即 master 代码作者自己已经标注"anchor 开启 + 续写叠加"这个组合**目前未经测试**。这与本文件 Task Q5.3 的定位一致（本任务的生产 oracle 正是要填补这个"untested corner"），但也意味着**若该 oracle 跑出真实冲突（非仅本文档的推理错误，而是代码本身在该组合下有未知 bug），这不是 Q5 本身的失败，是符合预期的"发现一个已知未测组合的真实边界"**——发现后应予以修正而非视为阻塞。
>
> **修订记录三（2026-07-27，planner 亲自读码复核，master `db1cb775`）**：
> 1. **重复截断分支状态的表述有一处不准确，本次更正**：原文"`git log --oneline master -- docs/spec/2026-07-22-stateful-client-outbound-repetition-truncation.md` 无命中"**是错的**——实测该命令返回两个命中（`5be18b83 docs(spec): 有状态 client.outbound + 重复输出截断 spec`、`4ec96a94 docs(plan,spec): 消化合并态审查`），**spec 文档本身已在 master**，`git branch --all --contains 5be18b83` 也确认 master 包含该提交。**未合并 master 的只是"实现代码 + consumer 接线"**：`feat/repetition-truncation` 分支相对 merge-base（`48fe9f59`）唯一的 `src/` 改动是 `src/lib/text-repetition/collapse.ts`（提交 `54ecf327`，114 行，commit message 明确"No consumers yet — pure addition, zero behavior change"）——即使这个纯核心函数落地 master，也**尚未接入** `delivery/session.ts` 的实际折叠管线（`grep -n "repetition\|keep_copies" src/lib/pipeline/delivery/session.ts` 无命中）。**结论不变**（③重复截断在 P1 实施时点大概率仍不构成真实叠加对象），但依据从"spec 都没合并"更正为"spec 已合并，实现仍是零消费者的独立核心函数，未接线"——下述 Task Q5.1 的核实步骤已同步更正。
> 2. **anchor/continuation 交互的"untested corner"有一处可通过读码直接排除，非必须留待 oracle 现场发现**：`driver.ts` 全文 grep 确认 `anchorState.anchorBlockOpen`/`.injected` **只在初始化时置值，运行期从未被重置为 `false`**（无任何 `anchorState.anchorBlockOpen = false` 或等价重置站点）；且 `AnchorState.anchorBlockOpen` 的字段注释（`types.ts:444`）明确写道"stays TRUE for the whole stream once set (index 0 remains reserved even after the anchor is closed)"——即该状态**按设计跨越整个请求生命周期**（含续写的所有轮次），不存在"续写 leg 是否重置"的分支：它就是不重置，这是既有实现的既定契约，不是留给 Task Q5.3 才能确定的未知量。**这意味着 Task Q5.2 步骤 5 原文"若 anchor 状态在续写 leg 未被重置，`anchor.remap` 可能仍然对续写帧 +1"这一支路是唯一实际会发生的分支**（另一支"若已重置"在当前代码下不可达，因为没有重置路径）——下方时序图已据此更正为唯一确定的结论，Task Q5.3 的 oracle 目标也从"验证哪个分支为真"改为"验证按此唯一分支运行结果是否符合预期（即 anchor 持续占用 wire index 0 附近的一个固定偏移量，续写块在此基础上再叠加，无空洞无撞车）"。

## 背景：三套可能同 exchange 叠加的 client-egress 机制

一个 exchange（一次客户端请求-响应交换）在极端情况下可能同时涉及：

1. **姊妹续写 spec 的错误续写**（mid-stream CANCEL 续回）+ **顺序 anchor 的运行时递增 index offset**（姊妹 spec §3.3，其自身仍是未闭合的承重项——据 ADR D2 反转记录，顺序 anchor 代码目前**默认休眠**，`stream_keepalive_mode` 默认 `ping`，anchor 分支在此配置下惰性）。
2. **本 max_tokens 续传 spec 的 post-success 续写**（块 index 连续递增跨 attempt，本计划 P1 的核心机制）。
3. **重复截断 spec（`docs/spec/2026-07-22-stateful-client-outbound-repetition-truncation.md`）的有状态 `client.outbound`**（下沉到 `delivery/session.ts`、eager-forward `content_block_start` + 块内缓冲折叠——**2026-07-27 planner 复核更正**：spec 文档本身**已在 master**（`5be18b83`/`4ec96a94`），`git log --oneline master -- docs/spec/2026-07-22-stateful-client-outbound-repetition-truncation.md` 有命中；**未合并 master 的是实现**——`feat/repetition-truncation` 分支相对 merge-base 唯一的 `src/` 改动是零消费者的 `src/lib/text-repetition/collapse.ts`（纯核心函数，commit message 自述"No consumers yet"），`src/lib/pipeline/delivery/session.ts` 未见任何 repetition/keep_copies 接线）。

## 核实结论（本 planning 期已核实，非假设；2026-07-27 补充复核）

- **顺序 anchor（姊妹机制①）**：据 ADR D2 反转记录，`stream_keepalive_mode` 默认已从 `empty_text`（顺序 anchor 生效）改为 `ping`（anchor 分支惰性）——**2026-07-27 读码复核**：`src/lib/state-defaults.ts:76` 确认默认值 `"ping"`，注释"empty_text retired as default (wrong-shaped, G2-ineffective); kept selectable/dormant for research"。故**默认配置下**，三方叠加的①分量事实上不参与（anchor 代码保留但休眠）。**只有当用户显式配置 `stream_keepalive_mode: empty_text` 时**，①才会真正与②③叠加。这降低了默认路径下的叠加复杂度，但**不能因此跳过分析**——用户仍可开启该配置。
- **重复截断（机制③）**：spec 文档已合并 master，**但实现仍是零消费者的独立核心函数**（`src/lib/text-repetition/collapse.ts`，`feat/repetition-truncation` 分支），未接入 `delivery/session.ts` 实际管线。这意味着本 max_tokens 续传特性若在重复截断的**实现接线**落地 master **之前**上线，实际叠加场景只有①（若开启）+②，③不存在。若重复截断接线先落地，则③成为现实存在的叠加对象。**本任务的时序图需要覆盖两种情形**（③存在/不存在），且需要在 P1 实施前重新确认重复截断实现的合并状态，据此决定是否需要在 P1 就处理与③的叠加，还是可以推迟到③真正落地时再处理。

---

## Task Q5.1: 核实当前依赖状态（先于画图）—— **已完成核实（2026-07-27），实施前须重新确认时效性**

- [x] 核实重复截断实现（`feat/repetition-truncation` 分支）是否在 P1 实施时点已合并 master——**本次核实（2026-07-27）：spec 文档已在 master，实现（`collapse.ts` 核心函数）仍未合并、且无消费者接线**。本任务的时序图仍需覆盖③，标注「③目前未激活（实现未接线），图内该层为前瞻性设计」。
- [x] 核实 `stream_keepalive_mode` 的当前 bundled 默认值（`ping`）——**已确认**（`state-defaults.ts:76`），ADR D2 状态未变。`docs/todo/2026-07-22-client-proxy-keepalive-300s.md` 的调研状态本次未展开核实（不影响本文件结论——即便该 backlog 项后续推进，也不改变"当前默认 ping、anchor 休眠"这一事实，只影响未来某个不确定时点）。
- [ ] **P1 实施前须重新执行本核实**（本次基于 master `db1cb775`，2026-07-27；重复截断分支的合并状态、`stream_keepalive_mode` 默认值均可能在实施时点前被并发会话推进）。
- [ ] **提交** → `docs(plan): Q5 dependency-state re-verification (repetition-truncation spec already on master but implementation unwired; keepalive default confirmed ping)`。

## Task Q5.2: 三方叠加时序图（核心交付物）

> **产出形式**：一张（或多张，按"顺序 anchor 开启/关闭"两种配置分叉）时序图，明确以下三层账目：

### Index 账（三层重编号来源，谁在什么时候对 index 做加法，**已按 master 真实计数逻辑重画**）

**关键校正（round-2）：anchor 帧从不计入 `wireDeliveredBlocks`；两层 remap 是独立、链式组合，非"续写 offset 内含 anchor 占位数"。**

具体机制（`src/lib/pipeline/driver.ts:1140-1149`，逐行核实）：
```ts
// flushBufferedFrames 内部的 for (const frame of toFlush) 循环——只处理"真实上游帧"，anchor 帧走另一条路径
if (anchor?.isContentBlockStart(frame)) await closeAnchorBeforeReal()             // anchor 关闭时机，:1140
let outFrame = injected && anchor && anchorBlockOpen ? anchor.remap(frame, 1) : frame   // 第一层 remap：anchor 占位 +1，:1145
if (continuation && continuationOffset > 0) outFrame = continuation.remap(outFrame, continuationOffset) // 第二层 remap：续写 offset，:1146
if (continuation && continuation.isContentBlockStart(frame)) wireDeliveredBlocks++ // 计数器只在真实块通过后递增，:1149——用的是原始 frame（remap 前），非 outFrame
```

anchor 帧本身（`content_block_start@0`/`content_block_stop@0` 的 anchor 版本）是在 `keepalive-anchor.ts` 的 injector 里通过 `sink.writeAnchor?.(anchor.startFrame)`（`:235`/`:261`）**直接写给 sink**，从未进入上面这个 `for (const frame of toFlush)` 循环——故 `wireDeliveredBlocks` **不可能**数到 anchor 帧，也不需要"减去 anchor 占位"这类补偿逻辑，因为它从一开始就没被计入。

| 层 | 重编号来源 | 何时生效 | 与其余两层的相对顺序 |
|---|---|---|---|
| 顺序 anchor（若开启） | `anchor.remap(frame, 1)`——固定 `+1` 偏移（`remapAnthropicBlockIndex`，`keepalive-anchor.ts:137-153`），只对"真实块"生效，anchor 自己的 index@0 不经过这个 remap（它本来就在 index@0） | 每次真实块 flush 时，作用于该帧的原始 upstream index | **第一层 remap**——直接在"上游原始 index"上加 anchor 占位偏移 |
| 本 max_tokens 续写 | `continuation.remap(outFrame, continuationOffset)`——`continuationOffset` 取自 `wireDeliveredBlocks`（续写新 leg 开始时的快照值，`:1452` `continuationOffset = wireDeliveredBlocks`），**该计数器只累加"已流经 `for` 循环、`continuation.isContentBlockStart(frame)` 为真的真实块数"，不含 anchor** | 续写 leg 的每一帧，在**已经过 anchor remap 之后的 `outFrame` 上**再叠加一层 | **第二层 remap**——链式叠加在第一层结果之上，两层各自独立计数/独立偏移，不是"续写 offset 把 anchor 占位数加总进去" |
| 重复截断（有状态 client.outbound，若已落地） | delivery/session.ts 的块内缓冲折叠——**这层不是"重编号"而是"合并/丢弃"**：把检测到的重复文本折叠为 `keep_copies` 份，可能减少实际发出的 block 数量，间接影响后续 index 的计数基准 | 每个 text block 内部持续检测（非 block 边界事件） | **最外层**——在 anchor + 续写的两层 remap 都完成之后，delivery 层做最后一道折叠；只要折叠不改变 `content_block_start`/`content_block_stop` 的 index 值本身（只改变块内 `text_delta` 的内容/数量），三层不会互相干扰 index 语义，但**需要显式验证这个正交性假设**（Task Q5.3 的 oracle 目标） |

**正确的具体序列示例**（anchor 开启 + text 撞 max_tokens 续写，全部真实值；**2026-07-27 复核更正**：步骤 5 的原推导有误，已重新推导，结论 wire@2 不变但机理不同）：
1. anchor 注入：`content_block_start@0`（anchor，走 `sink.writeAnchor`，不进 `wireDeliveredBlocks` 计数）。
2. 首个真实块到达（上游 index=0 的 text）：`closeAnchorBeforeReal()` 关闭 anchor（`content_block_stop@0`，同时设 `anchorState.anchorClosed = true`）→ `outFrame = anchor.remap(frame,1)` 把上游 index 0 变成 wire index 1 → 此时 `continuationOffset` 还是 0（未进入续写 leg）→ `continuation.remap` 是 no-op → 写出 `content_block_start@1` → `wireDeliveredBlocks++`（因为 `continuation.isContentBlockStart(frame)` 读的是原始 frame 的类型，为真）→ `wireDeliveredBlocks` 变为 1。
3. 该块内容写完，`content_block_stop@1`（不递增 `wireDeliveredBlocks`，只有 `content_block_start` 才递增）。
4. `message_delta{stop_reason:max_tokens}` 到达，触发本特性截获，抑制该终止符，续写 leg 开始：`continuationOffset = wireDeliveredBlocks = 1`。
5. 续写 leg 产出新的上游 index=0（续写响应自己的第一个块，比如剩余 text）——**关键更正**：`anchor.remap` 的调用门槛是 `injected && anchor && anchorBlockOpen`（`driver.ts:1145`），**不含 `!anchorState.anchorClosed`**；而 `anchorState.anchorBlockOpen`/`.injected` 在 master 全文 grep 确认**运行期从无重置为 `false` 的站点**（`AnchorState.anchorBlockOpen` 的字段注释 `types.ts:444` 明文"stays TRUE for the whole stream once set"）——**故 `anchor.remap` 在续写 leg 上并非 no-op，而是继续对每一个后续真实块施加 +1**（这与"anchor 只在首次真实块前生效一次"的直觉不同：anchor 永久占用 wire index 0，所以所有真实块——含续写 leg 的——都要相对各自的本地 upstream index 永久 +1，这正是该注释"real blocks are still shifted +1"在整个流生命周期内的含义,不是"只对第一个块生效一次"）。continuation leg 本地 index=0 的帧：先经 `anchor.remap(frame,1)` → 本地 index 0 变 1；再经 `continuation.remap(outFrame, 1)` → 1 变 1+1=2 → 写出 `content_block_start@2`。
6. **结论：`anchor@0 → real@1 → continuation@2`，无空洞、无撞车**——与此前版本的目标序列一致，但推导路径不同：不是"anchor 在续写 leg 变 no-op"，而是"anchor 的 +1 与续写的 `continuationOffset` 两个独立偏移量组合，且组合方式对任意块数都自洽"（见下方推导）。

**通用性验证（非仅特例，本次补充推导）**：设某 leg 的本地块下标为 `i`（从 0 开始，upstream 自己的编号），代入 driver 的两段 remap：
- anchor 段（`anchor.remap(frame,1)`，条件常真）：本地 index `i` → `i+1`。
- 续写段（`continuation.remap(outFrame, continuationOffset)`）：`i+1` → `i+1+continuationOffset`。
即 `wireIndex(i) = i + 1 + continuationOffset`。
- 主 leg（`continuationOffset=0`）：`wireIndex(i)=i+1`——第 0 块落 wire@1、第 1 块落 wire@2……（anchor 永久占 wire@0，逐块整体 +1，非仅首块）。
- 续写 leg（`continuationOffset=wireDeliveredBlocks=N`，`N`=前序已交付的真实块数）：`wireIndex(i)=i+1+N`——续写本地第 0 块落 wire@(N+1)，紧接主 leg 最后一块（wire@N）之后，**无论 `N` 是 1 还是更大的数，公式都自洽、无空洞**（`wireDeliveredBlocks` 是"块计数"，与 `anchor.remap` 的"index 位移"是两个不同的轴，两者相互独立却恰好复合正确——因为 `wireDeliveredBlocks` 统计的是"已经过 for 循环、类型为 content_block_start 的原始帧数"，不受 anchor 位移影响，是纯计数）。
**该推导表明"anchor 状态在续写 leg 是否重置"并非一个需要 oracle 现场探明"两种可能性哪个为真"的未知量**——运行期没有任何重置路径，只有"永久保持 true"这一确定分支，且该分支下的数学组合本身是自洽、正确的（并非巧合掩盖下的 bug）。Task Q5.3 的 oracle 定位相应从"探明二选一分支"改为"实证此推导——用真实 driver 代码跑一遍，确认输出确实是 `anchor@0→real@1→continuation@2`，而非因某处遗漏的边界条件（如 `closeAnchorBeforeReal` 在续写 leg 首块是否被误触发第二次 `content_block_stop@0`——已确认由 `!anchorState.anchorClosed` 短路，不会二次触发）产生偏差"。

**Task Q5.3 仍须验证的具体点（已从"探明未知分支"降级为"实证既有推导"）**：上述推导基于静态读码，未经运行时验证——遵循项目 `empirical-verification` 原则（实测 > 文档推导），仍须写生产 oracle 实际跑一遍 driver 代码确认数字吻合，而非止步于本文档的手工推导。

**关键结论（已从"待 oracle 验证的假设"改为"已读码确认、待 oracle 实证"）**：anchor remap 与续写 offset 是**两个独立、串联的 remap 操作**，各自的输入输出边界清楚（anchor 对所有真实块永久 +1，续写在此基础上再叠加已交付块计数）——**两层不会互相污染对方的计数，且这一点由代码结构保证（无重置路径），非续写 leg 里某个待实现的显式处理步骤**。重复截断层若确实只折叠块内内容、不碰 index 分配，则与前两层同样正交。这些假设仍须由 Task Q5.3 的生产 oracle 实证。

### 挂载层次账（本 spec 续写缝合在哪层 vs repetition 折叠在 delivery 层的相对次序）

- **本 max_tokens 续写的挂载点**：`driver.ts` 的 `runResponseBufferedSink` 内部（`for(;;)` 循环，terminal drain 分支）——这是**driver 层**，在 candidate-session 的 `onRenderedFrame` 之后、`sink.write` 之前。
- **重复截断的挂载点**（据其 spec §9b）：`delivery/session.ts` 的候选仲裁**之后**的串行写 choke point——这是比 driver 层**更靠近 wire** 的一层（driver 决定"发什么帧"，delivery session 决定"最终怎么写出去"）。
- **相对次序结论**：续写发生在 driver 层决定"这一批帧是否要发给客户端"的阶段；重复截断发生在"已经决定要发的帧，内容本身是否需要折叠"的阶段。**续写在前、重复截断在后**——续写产生的续写轮帧，会像任何其他帧一样经过 delivery/session.ts 的重复检测。这意味着**续写产生的内容本身也可能触发重复截断**（如果续写的内容恰好复读），这是一个需要显式验证的边界情况。

### 预算/attempt 账

- 续写预算（`max_rounds`）与重复截断的 `keep_copies` 是**两个独立的旋钮**，互不消耗对方的预算——续写决定"要不要再来一轮上游交换"，重复截断决定"这一轮里某段重复文本要不要折叠"，两者作用的层次不同（exchange 级 vs 帧内容级）。
- **attempt 记录账**：续写的每一轮是一个新 attempt（姊妹机制已定，本特性复用）；重复截断不产生新 attempt（它是同一 attempt 内的 delivery 层处理，不涉及新的上游交换）。故两者在 History `attempts[]` 的记录粒度上不冲突——重复截断的折叠信息应该记在**该 attempt 的 diagnostic**里（而非新增 attempt），续写的每轮记录仍按现有粒度（新 attempt）。

- [ ] **提交** → `docs(plan): Q5 three-way overlap timing diagram (index/mount-order/budget accounts, corrected anchor accounting per round-2 review)`。

## Task Q5.3: 至少一个三方生产 oracle（验证 Task Q5.2 假设，非纯文档）

> 审查明确要求"写至少一个三方生产 oracle（包括 continuation 后 index 及终局唯一性）"——本 task 是 Q5 的验证性收尾，不能只交时序图了事。**round-2 修订**：oracle 的期望序列已改为正确的 `anchor@0 → real@1 → continuation@2`（非原方案错误的"offset 含 anchor 占位"推导出的序列）。**2026-07-27 复核修订**：Task Q5.2 已通过读码 + 数学推导确认"anchor 状态在续写 leg 从未重置、`anchor.remap` 对所有真实块（含续写 leg）永久生效"是代码结构保证的唯一分支（非需要 oracle 现场探明"哪个分支为真"的未知量）——oracle 的定位相应从"探明二选一分支"改为"用真实 driver 代码实证该推导的数字结果，而非止步于文档手工推导"（仍遵循 `empirical-verification` 原则，实测优先级高于文档推导，纵使推导本身已相当确定）。

- [ ] **Step 1: 写失败测试** —— 构造一个同时触发续写 + 顺序 anchor（显式配置 `stream_keepalive_mode: empty_text`）的场景，断言 index 账按正确序列组合，不禁止性地假设"anchor 计入 wireDeliveredBlocks"。

```ts
test("three-way overlap: sequential anchor (empty_text mode) + max_tokens continuation in the same exchange — CORRECT index sequence is anchor@0 -> real@1 -> continuation@2 (anchor.remap applies a PERMANENT +1 to every real block across ALL legs, incl. continuation; wireDeliveredBlocks counts ONLY real content blocks, never anchor frames)", async () => {
  // mock 上游：pre-content anchor 占位 index@0（走 sink.writeAnchor，不进 wireDeliveredBlocks）
  //          -> 真实 text 块 upstream@0 -> anchor.remap(+1) -> wire@1 -> wireDeliveredBlocks 变为 1
  //          -> max_tokens 截断 -> 续写 exchange 产出剩余块 upstream@0（本地 index 从 0 起算）
  //          -> 断言：续写块最终落在 wire@2（= 续写本地 index 0，经 anchor.remap(+1) 变 1，再经 continuation.remap(+1) 变 2 —— 按
  //             Task Q5.2 的读码+数学推导，这是代码结构保证的唯一可能结果，非"两种可能之一"）
  // 断言：客户端最终只看到一个终局（无双重 message_stop）
  // 断言：绝不出现 index 空洞（wire@0/1/2 依序出现，无跳号）
  // 断言（新增，钉死推导中的短路机制）：续写 leg 首个真实块不触发第二次 content_block_stop@0
  //   （即 closeAnchorBeforeReal 被 !anchorState.anchorClosed 正确短路，不会因续写 leg "看起来像第一个真实块" 而误判为需要再关一次 anchor）
})
```

- [ ] **Step 2: 若重复截断实现已合并 master**（Task Q5.1 核实结果——**当前状态：spec 已合并、实现未合并/未接线**，故本次大概率仍是 skip 分支），追加第二个断言重复截断折叠正交性的测试；**若未合并**，本 test 跳过（标注 `test.skip`，注明依赖重复截断实现 + 接线落地），并在 backlog 登记「Q5 第三方（重复截断）叠加验证待其落地后补测」。
- [ ] **Step 3-4:** 跑失败 → 按 Task Q5.2 的推导，预期该测试**应该直接通过读码验证的数字**（`wire@2`，无需 P1 Task 1.2 做任何"显式重置 anchor 状态"的实现——因为代码结构已经保证正确组合）；**若实际跑出的结果与推导不符**（例如撞成 `wire@3` 或抛出未预期的二次 `content_block_stop@0`），说明推导本身有遗漏或 P1 Task 1.2 的续写触发实现引入了非预期的 anchor 交互，须据实修正实现（而非削足适履改测试断言）。若结果与推导一致，本 oracle 即完成"实证既有推导"的定位，跑通过 → 提交。
- [ ] **Step 5: 提交** → `test(pipeline): three-way overlap production oracle (continuation + sequential anchor, confirms anchor.remap's permanent +1 composes correctly with continuationOffset across legs: anchor@0->real@1->continuation@2)`。

## Q5 收口

- [ ] 时序图（Task Q5.2）+ 至少一个生产 oracle（Task Q5.3）均已产出。
- [ ] `plan-4-closeout.md` 的 Task 4.4（merged-state review）**以本文件的时序图为对账标准**（而非要求 reviewer 自己重新推导三方交互）——即 Task Q5 的产出是 P4 审查的输入，不是被 P4 审查取代的东西。
- [ ] 若 Task Q5.1 在 P1 实施前重新核实、发现重复截断实现已合并 master 且接入 delivery 管线，Task Q5.3 的第二个断言（重复截断折叠正交性）必须补齐，不得永久留 `test.skip`。
