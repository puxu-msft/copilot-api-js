# Plan-Q5: 三方叠加集成设计（续写×顺序 anchor×重复截断，M 后 P1 前）

> **修订记录（2026-07-23，据 GPT plan-review [major] 修订）**：spec §13 Q5 要求的「三方叠加时序图」+ index/挂载层次/预算账，此前只在 README Global Constraints 提了一句"须画清"，未落到任何具名 plan task——审查指出这不能靠 P4 的 merged-state review 泛化检查覆盖，必须是独立的、M 之后 P1 之前的 integration-design task，产出至少一个三方生产 oracle。

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

### Index 账（三层重编号来源，谁在什么时候对 index 做加法）

| 层 | 重编号来源 | 何时生效 | 与其余两层的相对顺序 |
|---|---|---|---|
| 顺序 anchor（若开启） | `AnchorIndexAllocator.realBlockOffset(upstreamIndex)`（`keepalive-anchor.ts`），anchor 占位 index + 真实块 remap | 每次真实块 `content_block_start` 前 | **最内层**——离 wire 最近，其余两层的 index 输入已经过 anchor remap 之后的值 |
| 本 max_tokens 续写 | `continuationOffset`（姊妹机制已有的 `wireDeliveredBlocks` 计数器，P1 复用同一套） | 续写 exchange 的新 attempt 开始时，offset = 已上线到客户端的块计数（含 anchor 占位块，若 anchor 开启） | **中间层**——在 anchor remap 之上再叠加一层 offset（如果一个 exchange 内既有 anchor 又有续写，offset 的计数必须包含 anchor 已占用的 index，否则续写块会撞车） |
| 重复截断（有状态 client.outbound，若已落地） | delivery/session.ts 的块内缓冲折叠——**这层不是"重编号"而是"合并/丢弃"**：把检测到的重复文本折叠为 `keep_copies` 份，可能减少实际发出的 block 数量，间接影响后续 index 的计数基准 | 每个 text block 内部持续检测（非 block 边界事件） | **最外层**——在 anchor + 续写的 index 分配都完成之后，delivery 层做最后一道折叠；由于折叠可能减少内容量但不改变 block 边界本身（是块内 text 的裁剪，非跨块 index 变化），**这一层与 index 分配基本正交**——只要 delivery 层的折叠不改变 `content_block_start`/`content_block_stop` 的 index 值本身（只改变块内 `text_delta` 的内容/数量），三层不会互相干扰 index 语义，但**需要显式验证这个正交性假设**（Task Q5.3 的 oracle 目标） |

**关键结论（待 oracle 验证的假设，非定论）**：如果重复截断的折叠严格限于"块内 delta 内容"层面、不触碰 block 边界的 index 分配，那么它与 anchor/续写的 index 账在设计上是正交的，三方可以独立工作而不冲突。**这个假设必须由 Task Q5.3 的生产 oracle 实证，不能只靠这里的推理定论**。

### 挂载层次账（本 spec 续写缝合在哪层 vs repetition 折叠在 delivery 层的相对次序）

- **本 max_tokens 续写的挂载点**：`driver.ts` 的 `runResponseBufferedSink` 内部（`for(;;)` 循环，terminal drain 分支）——这是**driver 层**，在 candidate-session 的 `onRenderedFrame` 之后、`sink.write` 之前。
- **重复截断的挂载点**（据其 spec §9b）：`delivery/session.ts` 的候选仲裁**之后**的串行写 choke point——这是比 driver 层**更靠近 wire** 的一层（driver 决定"发什么帧"，delivery session 决定"最终怎么写出去"）。
- **相对次序结论**：续写发生在 driver 层决定"这一批帧是否要发给客户端"的阶段；重复截断发生在"已经决定要发的帧，内容本身是否需要折叠"的阶段。**续写在前、重复截断在后**——续写产生的续写轮帧，会像任何其他帧一样经过 delivery/session.ts 的重复检测。这意味着**续写产生的内容本身也可能触发重复截断**（如果续写的内容恰好复读），这是一个需要显式验证的边界情况。

### 预算/attempt 账

- 续写预算（`max_rounds`）与重复截断的 `keep_copies` 是**两个独立的旋钮**，互不消耗对方的预算——续写决定"要不要再来一轮上游交换"，重复截断决定"这一轮里某段重复文本要不要折叠"，两者作用的层次不同（exchange 级 vs 帧内容级）。
- **attempt 记录账**：续写的每一轮是一个新 attempt（姊妹机制已定，本特性复用）；重复截断不产生新 attempt（它是同一 attempt 内的 delivery 层处理，不涉及新的上游交换）。故两者在 History `attempts[]` 的记录粒度上不冲突——重复截断的折叠信息应该记在**该 attempt 的 diagnostic**里（而非新增 attempt），续写的每轮记录仍按现有粒度（新 attempt）。

- [ ] **提交** → `docs(plan): Q5 three-way overlap timing diagram (index/mount-order/budget accounts)`。

## Task Q5.3: 至少一个三方生产 oracle（验证 Task Q5.2 假设，非纯文档）

> 审查明确要求"写至少一个三方生产 oracle（包括 continuation 后 index 及终局唯一性）"——本 task 是 Q5 的验证性收尾，不能只交时序图了事。

- [ ] **Step 1: 写失败测试** —— 构造一个同时触发续写 + 顺序 anchor（显式配置 `stream_keepalive_mode: empty_text`）的场景，断言 index 账不冲突。

```ts
test("three-way overlap: sequential anchor (empty_text mode) + max_tokens continuation in the same exchange — index offsets compose correctly, no collision, single final terminator", async () => {
  // mock 上游：pre-content anchor 占位 index@0 -> 真实 text 块@1 -> max_tokens 截断 -> 续写 exchange 产出剩余块
  // 断言：续写块的 index 从"已上线块计数（含 anchor 占位）"续编，不与 anchor 或已发文本块撞车
  // 断言：客户端最终只看到一个终局（无双重 message_stop）
})
```

- [ ] **Step 2: 若重复截断已合并 master**（Task Q5.1 核实结果），追加第二个断言重复截断折叠正交性的测试；**若未合并**，本 test 跳过（标注 `test.skip`，注明依赖重复截断落地），并在 backlog 登记「Q5 第三方（重复截断）叠加验证待其落地后补测」。
- [ ] **Step 3-4:** 跑失败 → 若发现 Task Q5.2 的推理假设有误（如实际 offset 计算确实冲突），据实修正时序图与本特性 P1 Task 1.2 的实现（这是 Q5 存在的意义——在实现前发现设计缝，而非实现后靠 merged-state review 撞见）→ 跑通过。
- [ ] **Step 5: 提交** → `test(pipeline): three-way overlap production oracle (continuation + sequential anchor, index composition verified)`。

## Q5 收口

- [ ] 时序图（Task Q5.2）+ 至少一个生产 oracle（Task Q5.3）均已产出。
- [ ] `plan-4-closeout.md` 的 Task 4.4（merged-state review）**以本文件的时序图为对账标准**（而非要求 reviewer 自己重新推导三方交互）——即 Task Q5 的产出是 P4 审查的输入，不是被 P4 审查取代的东西。
- [ ] 若 Task Q5.1 核实重复截断已在 P1 落地前合并 master，Task Q5.3 的第二个断言（重复截断折叠正交性）必须补齐，不得永久留 `test.skip`。
