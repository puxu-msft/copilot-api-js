# Plan-Q5: 三方叠加集成设计（续写×顺序 anchor×重复截断，M 后 P1 前）

> **修订记录（2026-07-23，据 GPT plan-review [major] 修订）**：spec §13 Q5 要求的「三方叠加时序图」+ index/挂载层次/预算账，此前只在 README Global Constraints 提了一句"须画清"，未落到任何具名 plan task——审查指出这不能靠 P4 的 merged-state review 泛化检查覆盖，必须是独立的、M 之后 P1 之前的 integration-design task，产出至少一个三方生产 oracle。
>
> **修订记录二（2026-07-23，据 GPT plan-review round-2 [残留] 修订，index 账错误）**：round-2 亲自核实 `src/lib/pipeline/driver.ts:1145-1149` 的真实计数逻辑后发现，第一版时序图的核心结论**是错的**：原图声称"续写 offset 的计数必须包含 anchor 占位块"，但 master 实际实现是**`wireDeliveredBlocks` 只在 `continuation.isContentBlockStart(frame)` 为真时递增**（`:1149`），而 anchor 帧是通过 `sink.writeAnchor()`（在 injector 里，`keepalive-anchor.ts:235/261`）直接写出、**完全不经过 `flushBufferedFrames` 的 `for (const frame of toFlush)` 循环**——anchor 帧从未参与这个计数器的递增判断。**anchor 的 index 偏移由内层 `anchor.remap(frame, 1)` 独立负责**（`:1145`），续写的 offset 只处理"真实内容块的 wire 计数"，两次 remap 是**链式组合**（`outFrame = anchor.remap(frame,1)`，然后 `if (continuationOffset>0) outFrame = continuation.remap(outFrame, continuationOffset)`），不是"续写 offset 内含 anchor 占位数"。按原图的错误结论实现会导致续写块 index **多算一次 anchor 占位**、产生空洞（如本该是 `anchor@0→real@1→continuation@2` 却因 offset 多算 1 变成 `anchor@0→real@1→continuation@3`，index@2 永远不会被写出）。本次已据实重画。
>
> **额外核实发现（承重，round-2 未直接点名但据实追加）**：`driver.ts:1026-1027` 的现有注释明确写道「Scoped to the anchor-DORMANT path (D2 default `stream_keepalive_mode: ping`, PoC-validated); the empty_text-anchor + continuation combo is an **untested corner (backlog)**」——即 master 代码作者自己已经标注"anchor 开启 + 续写叠加"这个组合**目前未经测试**。这与本文件 Task Q5.3 的定位一致（本任务的生产 oracle 正是要填补这个"untested corner"），但也意味着**若该 oracle 跑出真实冲突（非仅本文档的推理错误，而是代码本身在该组合下有未知 bug），这不是 Q5 本身的失败，是符合预期的"发现一个已知未测组合的真实边界"**——发现后应予以修正而非视为阻塞。

## 背景：三套可能同 exchange 叠加的 client-egress 机制

一个 exchange（一次客户端请求-响应交换）在极端情况下可能同时涉及：

1. **姊妹续写 spec 的错误续写**（mid-stream CANCEL 续回）+ **顺序 anchor 的运行时递增 index offset**（姊妹 spec §3.3，其自身仍是未闭合的承重项——据 ADR D2 反转记录，顺序 anchor 代码目前**默认休眠**，`stream_keepalive_mode` 默认 `ping`，anchor 分支在此配置下惰性）。
2. **本 max_tokens 续传 spec 的 post-success 续写**（块 index 连续递增跨 attempt，本计划 P1 的核心机制）。
3. **重复截断 spec（`docs/spec/2026-07-22-stateful-client-outbound-repetition-truncation.md`）的有状态 `client.outbound`**（下沉到 `delivery/session.ts`、eager-forward `content_block_start` + 块内缓冲折叠——**本 planning 期核实：该 spec 仍在分支 `feat/repetition-truncation`，未合并 master**，`git log --oneline master -- docs/spec/2026-07-22-stateful-client-outbound-repetition-truncation.md` 无命中，只在该分支上有提交）。

## 核实结论（本 planning 期已核实，非假设）

- **顺序 anchor（姊妹机制①）**：据 ADR D2 反转记录，`stream_keepalive_mode` 默认已从 `empty_text`（顺序 anchor 生效）改为 `ping`（anchor 分支惰性）。故**默认配置下**，三方叠加的①分量事实上不参与（anchor 代码保留但休眠）。**只有当用户显式配置 `stream_keepalive_mode: empty_text` 时**，①才会真正与②③叠加。这降低了默认路径下的叠加复杂度，但**不能因此跳过分析**——用户仍可开启该配置。
- **重复截断（机制③）**：仍在分支 `feat/repetition-truncation`，**尚未合并 master**。这意味着本 max_tokens 续传特性若在重复截断落地 master **之前**上线，实际叠加场景只有①（若开启）+②，③不存在。若重复截断先落地，则③成为现实存在的叠加对象。**本任务的时序图需要覆盖两种情形**（③存在/不存在），且需要在 P1 实施前确认重复截断 spec 的合并状态，据此决定是否需要在 P1 就处理与③的叠加，还是可以推迟到③真正落地时再处理。

---

## Task Q5.1: 核实当前依赖状态（先于画图）

- [ ] 核实重复截断 spec（`feat/repetition-truncation` 分支）是否在 P1 实施时点已合并 master。若未合并，本任务的时序图仍需覆盖③，但标注「③目前未激活，图内该层为前瞻性设计」。
- [ ] 核实 `stream_keepalive_mode` 的当前 bundled 默认值（`ping`）是否会在 P1 实施时点前发生变化（读 `docs/todo/2026-07-22-client-proxy-keepalive-300s.md` 的调研状态——若该 backlog 项后续选择"gap 多 anchor"方案落地，顺序 anchor 可能重新默认开启）。
- [ ] **提交** → `docs(plan): Q5 dependency-state verification (repetition-truncation branch status, keepalive default)`。

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

**正确的具体序列示例**（anchor 开启 + text 撞 max_tokens 续写，全部真实值）：
1. anchor 注入：`content_block_start@0`（anchor，走 `sink.writeAnchor`，不进 `wireDeliveredBlocks` 计数）。
2. 首个真实块到达（上游 index=0 的 text）：`closeAnchorBeforeReal()` 关闭 anchor（`content_block_stop@0`）→ `outFrame = anchor.remap(frame,1)` 把上游 index 0 变成 wire index 1 → 此时 `continuationOffset` 还是 0（未进入续写 leg）→ `continuation.remap` 是 no-op → 写出 `content_block_start@1` → `wireDeliveredBlocks++`（因为 `continuation.isContentBlockStart(frame)` 读的是原始 frame 的类型，为真）→ `wireDeliveredBlocks` 变为 1。
3. 该块内容写完，`content_block_stop@1`（不递增 `wireDeliveredBlocks`，只有 `content_block_start` 才递增）。
4. `message_delta{stop_reason:max_tokens}` 到达，触发本特性截获，抑制该终止符，续写 leg 开始：`continuationOffset = wireDeliveredBlocks = 1`。
5. 续写 leg 产出新的上游 index=0（续写响应自己的第一个块，比如剩余 text）：`outFrame = anchor.remap(frame,1)`（anchor 已关闭/`anchorBlockOpen` 状态如何在续写 leg 上处理需要 Task Q5.3 显式验证——**这是本图未定论的一个角落**，若 anchor 状态在续写 leg 未被重置，`anchor.remap` 可能仍然对续写帧 +1；若已重置，`anchor.remap` 是 no-op）→ 假设 anchor 状态在续写 leg 已经"不再注入"（因为 anchor 只在首次 idle 才触发一次），则此步 `anchor.remap` 是 no-op、`outFrame` 保持 upstream index 0 → `continuation.remap(outFrame, 1)` 把它变成 wire index **1+1=2** → 写出 `content_block_start@2`。
6. **结论：`anchor@0 → real@1 → continuation@2`，无空洞、无撞车**——这与 round-2 报告要求的目标序列完全一致。

**Task Q5.3 必须验证的具体角落（非本图能靠推理确定）**：步骤 5 里"anchor 状态在续写 leg 是否已重置"是唯一未经 master 代码逐行确认的环节（因为 anchor 的正常生命周期是"single-shot 首次 idle 注入"，续写 leg 是否会被误判为"仍需 anchor"取决于 `anchorState` 对象是否跨 leg 共享及其 `injected`/`anchorClosed` 标记在续写触发时的状态——这需要在实现 Task 1.2 时显式处理，非本文档的静态推理能确定，Task Q5.3 的 oracle 正是为了钉死这一点）。

**关键结论（待 oracle 验证，已修正后的正确假设）**：anchor remap 与续写 offset 是**两个独立、串联的 remap 操作**，各自的输入输出边界清楚（anchor 只认"是否是首个真实块之前"，续写只认"已通过 for 循环的真实块计数"）——**只要 anchor 状态在续写 leg 正确处理（步骤 5 角落），两层不会互相污染对方的计数**。重复截断层若确实只折叠块内内容、不碰 index 分配，则与前两层同样正交。这些假设必须由 Task Q5.3 的生产 oracle 实证。

### 挂载层次账（本 spec 续写缝合在哪层 vs repetition 折叠在 delivery 层的相对次序）

- **本 max_tokens 续写的挂载点**：`driver.ts` 的 `runResponseBufferedSink` 内部（`for(;;)` 循环，terminal drain 分支）——这是**driver 层**，在 candidate-session 的 `onRenderedFrame` 之后、`sink.write` 之前。
- **重复截断的挂载点**（据其 spec §9b）：`delivery/session.ts` 的候选仲裁**之后**的串行写 choke point——这是比 driver 层**更靠近 wire** 的一层（driver 决定"发什么帧"，delivery session 决定"最终怎么写出去"）。
- **相对次序结论**：续写发生在 driver 层决定"这一批帧是否要发给客户端"的阶段；重复截断发生在"已经决定要发的帧，内容本身是否需要折叠"的阶段。**续写在前、重复截断在后**——续写产生的续写轮帧，会像任何其他帧一样经过 delivery/session.ts 的重复检测。这意味着**续写产生的内容本身也可能触发重复截断**（如果续写的内容恰好复读），这是一个需要显式验证的边界情况。

### 预算/attempt 账

- 续写预算（`max_rounds`）与重复截断的 `keep_copies` 是**两个独立的旋钮**，互不消耗对方的预算——续写决定"要不要再来一轮上游交换"，重复截断决定"这一轮里某段重复文本要不要折叠"，两者作用的层次不同（exchange 级 vs 帧内容级）。
- **attempt 记录账**：续写的每一轮是一个新 attempt（姊妹机制已定，本特性复用）；重复截断不产生新 attempt（它是同一 attempt 内的 delivery 层处理，不涉及新的上游交换）。故两者在 History `attempts[]` 的记录粒度上不冲突——重复截断的折叠信息应该记在**该 attempt 的 diagnostic**里（而非新增 attempt），续写的每轮记录仍按现有粒度（新 attempt）。

- [ ] **提交** → `docs(plan): Q5 three-way overlap timing diagram (index/mount-order/budget accounts, corrected anchor accounting per round-2 review)`。

## Task Q5.3: 至少一个三方生产 oracle（验证 Task Q5.2 假设，非纯文档）

> 审查明确要求"写至少一个三方生产 oracle（包括 continuation 后 index 及终局唯一性）"——本 task 是 Q5 的验证性收尾，不能只交时序图了事。**round-2 修订**：oracle 的期望序列已改为正确的 `anchor@0 → real@1 → continuation@2`（非原方案错误的"offset 含 anchor 占位"推导出的序列），且必须显式验证 Task Q5.2 标注的"anchor 状态在续写 leg 是否重置"这一角落。

- [ ] **Step 1: 写失败测试** —— 构造一个同时触发续写 + 顺序 anchor（显式配置 `stream_keepalive_mode: empty_text`）的场景，断言 index 账按正确序列组合，不禁止性地假设"anchor 计入 wireDeliveredBlocks"。

```ts
test("three-way overlap: sequential anchor (empty_text mode) + max_tokens continuation in the same exchange — CORRECT index sequence is anchor@0 -> real@1 -> continuation@2 (wireDeliveredBlocks counts ONLY real content blocks, never anchor frames)", async () => {
  // mock 上游：pre-content anchor 占位 index@0（走 sink.writeAnchor，不进 wireDeliveredBlocks）
  //          -> 真实 text 块 upstream@0 -> anchor.remap(+1) -> wire@1 -> wireDeliveredBlocks 变为 1
  //          -> max_tokens 截断 -> 续写 exchange 产出剩余块 upstream@0
  //          -> 断言：续写块最终落在 wire@2（= anchor.remap 若 no-op 时的 upstream@0，经 continuation.remap(+1) 得 2；
  //             若 anchor 状态未重置导致 anchor.remap 又 +1，则会错误落在 wire@3——本测试必须能区分这两种情况并断言前者）
  // 断言：客户端最终只看到一个终局（无双重 message_stop）
  // 断言：绝不出现"index@2 被跳过"的空洞（即两种可能结果中，wire@2 必须被写出，不能是 wire@3 起跳）
})
```

- [ ] **Step 2: 若重复截断已合并 master**（Task Q5.1 核实结果），追加第二个断言重复截断折叠正交性的测试；**若未合并**，本 test 跳过（标注 `test.skip`，注明依赖重复截断落地），并在 backlog 登记「Q5 第三方（重复截断）叠加验证待其落地后补测」。
- [ ] **Step 3-4:** 跑失败 → **首先确认这是否正是 `driver.ts:1026-1027` 注释标注的"untested corner"**（anchor 状态在续写 leg 未重置导致的真实 bug，而非本文档的推理错误）——若是，据实修正 P1 Task 1.2 的实现（续写触发时必须显式重置/短路 anchor 状态，确保续写 leg 的 `anchor.remap` 是 no-op）；若发现是测试构造有误，修正测试。无论哪种，最终须让 oracle 断言"wire@2 被正确写出、无空洞"→ 跑通过。
- [ ] **Step 5: 提交** → `test(pipeline): three-way overlap production oracle (continuation + sequential anchor, corrected index composition: anchor@0->real@1->continuation@2)`。

## Q5 收口

- [ ] 时序图（Task Q5.2）+ 至少一个生产 oracle（Task Q5.3）均已产出。
- [ ] `plan-4-closeout.md` 的 Task 4.4（merged-state review）**以本文件的时序图为对账标准**（而非要求 reviewer 自己重新推导三方交互）——即 Task Q5 的产出是 P4 审查的输入，不是被 P4 审查取代的东西。
- [ ] 若 Task Q5.1 核实重复截断已在 P1 落地前合并 master，Task Q5.3 的第二个断言（重复截断折叠正交性）必须补齐，不得永久留 `test.skip`。
