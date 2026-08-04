# M1 守卫判据轴第三方裁决

> 状态：裁决进行中。工作树与代码保持只读；本文件按用户要求作为唯一新增裁决产物逐条追加。


## 争议清单与资格

- 裁决资格：具备。我未参与实施、前两轮评审或主会话的两次判据换轴。
- [1] 不变量归属层：**两者皆误于把单一局部机制当作不变量本体**。正确归属是“generation delivery owner 的语义状态转换 + 唯一 wire emission choke point”；能力边界只是实现该归属的一种手段，帧构造权与运行期对象形状都不是充分判据。
- [2] 运行期摘除是否结构性闭合：**两者皆误**。摘除是必要局部修复，但普通 `ClientSink.write` 与公开 raw factory 仍可绕过 owner，不构成闭合。
- [3] “窄判据 + 显式登记表”是否正当：**支持质疑方**。当前形状是自我授权的降级；只有外部裁决、诚实限缩 claim、具体阻塞物、独立正控和确定恢复门同时存在时才正当。
- [4] 两处同族 oracle 问题的定级：**七个 settlement 分流点支持主会话，major；close registry 则两者皆误，presence 门有价值但不能替代行为门，行为缺口仍是 major。**

## [1] 不变量的正确归属层

**裁决态：两者皆误。** 主会话先后选择的“同行 regex”与“`ClientSink` 类型能力边界”都不是这条不变量的归属层；把归属改成“帧构造权”也仍然设错。正确不变量应表述为：**一个 generation 中，anchor close 的判定、所关闭的 `openAnchorIndex`、`content_block_stop` 的发射、关闭状态清除与 heartbeat/diagnostic 副作用，必须在 delivery owner 的同一个 serialized command 内原子完成；所有可到达客户端 wire 的路径都不得绕过这个 owner command。**

### 独立证据

1. 冻结契约已经把真正的 canonical state 放在 owner：`WireBlockAllocationPort.closeOpenAnchor` 只接收 builder，index 由 owner 提供（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/types.ts:319-331`）；实现从 `wireState.openAnchorIndex` 取 index，写成功后清空并更新 mirror/clock（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/delivery/session.ts:417-447`）。这组状态转换才决定“这个 stop 是不是该 generation 的 anchor close”，而不是某个函数名或帧字节。
2. `stopFrame` 只是可重造的协议值：`AnchorHooks.stopFrame` 是公共纯 builder（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/types.ts:418-440`），具体实现不过是 `anthropicSseFrame({ type: "content_block_stop", index })`（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/anthropic/keepalive-anchor.ts:172-175`）。即使隐藏该函数，任何代码仍可构造同字节的普通 `ClientFrame`；同时真实 upstream block 也合法拥有 `content_block_stop`。因此“谁能构造 stop 帧”既不能归一识别 anchor provenance，也会误伤合法真实块，不能成为结构性边界。
3. `writeAnchor` 也不是关闭权威本体。owner 最终仅用它选择 synthetic sampling 通道，缺失时退化到普通 `write`（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/delivery/session.ts:581-601`）。这说明该方法表达的是 transport/sampling capability，而非“有权决定 anchor 生命周期”。真正的权威是调用前已经发生的 owner state transition与 serialized ordering。
4. 冻结计划自己的原话支持这个归属：M1 要“close 权威 + exactly-once by construction”，并明确否决让 legacy flag 继续充当幂等权威（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:143-152`）；计划还要求 owner 用自己的 `openAnchorIndex` 构造 stop，不能硬编码 `0`（同文件 `:154-170`）。

### 相对三个候选的优劣

- 相对“能力边界”：更强，因为它守的是**语义动作及其全部副作用**，不会把 `writeAnchor` 这个标记/采样方法误认成关闭权威；代价是必须把所有 wire 出口真正收口，不能只改 TypeScript 表面类型。
- 相对“帧构造权”：更准确，因为纯数据可被任意重造，且同字节 stop 可能是合法真实块；禁止构造既不闭合又制造假阳。帧的 `anchor` provenance 应由 owner 在 emission command 内铸造，但纯 builder 无需被当作安全能力。
- 相对“运行期对象形状”：对象摘掉某个方法只能消灭一条旁路；若仍有 `write`、raw factory 或直接 transport 出口，同字节仍可发射。运行期收口可作为实现手段，但判据应是“所有 client-visible emission 是否经过 owner canonical state”，而非 `"writeAnchor" in sink`。

### 对“连续两次换轴”的正面回答

**怀疑成立，但理由不是“换了两次”这个次数本身。** 次数只是报警信号；决定性证据是两次 witness 都利用了同一事实：判据观察的是源码拼写或 TypeScript view，而真正违规是**绕过 owner canonical state 后仍能产生 client-visible wire effect**。第一次变量提取绕过 regex，第二次 assertion/raw factory 绕过类型墙，说明判据持续落在表示层。应停止围绕 `writeAnchor` 加固，把门迁到 owner command 与唯一 wire emission choke point。

### 对后续的影响

正确承接者应是 `gpt-souls:architect-advisor` 先冻结 owner/wire 边界形状，再由 `gpt-souls:implementer` 落实；不能让实现者继续枚举 `writeAnchor` 拼写。验收要植入一个真实 production consumer 绕过 owner 发射 anchor stop 的 witness，并由 producer wire oracle/O-2 与 owner state oracle共同转红。

## [2] 运行期摘除是否结构性闭合

**裁决态：两者皆误；运行期摘除 `clientSink.writeAnchor` 是正确且必要的局部修复，但不是结构性闭合。**

### 实测结果

所有动态探针均在独立 scratch worktree `/tmp/m1-guard-axis-arbiter-1488586`、detached `6fb9ed67` 执行；被审树未运行 mutation、未改代码、未触碰 4141。

1. `makeDeliverySseSink` 当前交出的对象**实际仍有** `writeAnchor`。运行时输出：

   ```json
   {"deliveryWriteAnchor":"function","rawWriteAnchor":"function","deliveryKeys":["close","finalize","freezeHeartbeat","resumeHeartbeat","suspendHeartbeat","write","writeAnchor","writeKeepalive","writeSynthetic","writeSyntheticEnvelope"]}
   ```

   原因是 session 内部把 `clientSink` 声明成 `OwnerRawSink` 并直接放入 `writeAnchor`（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/delivery/session.ts:483-504`），随后仅以较窄的静态返回类型 `ClientSink` 暴露（同文件 `:506-518`）。这不是运行期摘除，只是 TypeScript view narrowing。
2. **没有合法 production 消费方依赖“交给外部的 `clientSink.writeAnchor`”。** 全 `src/**/*.ts` 审计中，`.writeAnchor` 的唯一真实调用是 owner 的 raw transport dispatch（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/delivery/session.ts:581-585`）；production route 全部只 import `makeDeliverySseSink`，不调用 returned sink 的 `writeAnchor`。anchor open 走 `allocateAndWriteAnchor`（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/anthropic/keepalive-anchor.ts:266-324`），anchor close 走 `closeOpenAnchor`（handler：`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/routes/messages/handler-v4.ts:1105-1121`；driver：`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/driver.ts:1178-1191`）。因此从 returned `clientSink` 运行期删除该 property 不需要迁移合法生产消费者。
3. **测试确有依赖，但都是测试绕过／正控，不是生产契约。** 直接把 `delivery.clientSink` cast 为 `OwnerRawSink` 的命中共 6 处：`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/tests/pipeline/allocation-outside-owner-control.it.test.ts:79-80,130-131` 与 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/tests/pipeline/delivery-session.unit.test.ts:182,266`。前四处故意制造 out-of-owner 违规作为 positive control；后两处直接驱动 transport/heartbeat 形状。摘除后应把前者改为显式测试-only adversarial seam 或更真实的 wire bypass witness，把后者改走 owner port；不能为了保测试方便保留生产泄漏。

### 为什么摘除后仍有 witness

1. **普通 `ClientSink.write` 已足以绕过 owner lifecycle。** scratch 实测：先用 owner `allocateAndWriteAnchor` 打开 anchor，再直接 `delivery.clientSink.write(anchorStopFrame(index))`。输出为：

   ```json
   {"openAnchorIndex":0,"ledgerOpenBlocks":[],"wireTypes":["content_block_start","content_block_stop"]}
   ```

   客户端 wire ledger 已被普通 stop 关闭，但 canonical `wireState.openAnchorIndex` 仍为 `0`。随后 owner 仍会认为 anchor 未关闭并可再发第二个 stop。这是无需 `writeAnchor`、无需 type assertion、完全使用公共 `ClientSink.write` 的 witness。
2. **raw capability 仍可公开取得。** `OwnerRawSink` 公开导出（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/delivery/types.ts:11-14`），`makeSseSink` 公开返回它（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/client-sink.ts:187-188`）。当前 production 没有滥用只是现状，不是闭合证明；任意生产模块仍可 import raw factory 或类型。
3. 即便同时隐藏 raw factory 与 `writeAnchor`，任何持有公共 `ClientSink.write` 的代码仍可写出同字节 stop。要结构性闭合，必须让暴露给非 owner 的“写端”不再是无条件 wire emission capability，或让 client-visible sink 只接受 owner minted/validated token，使所有协议结构帧在 canonical owner state 中归一后才写。

### 结论与后续影响

- **立即摘除 returned `clientSink` 上的运行期 `writeAnchor`**：支持，且 production 无合法消费者；这会消灭当前 `as OwnerRawSink` witness。
- **把它称为结构性闭合**：不支持。普通 `.write(stopFrame)` 与公开 raw factory 都是剩余 witness。
- 正确完成标准不是“对象上没有某 property”，而是“任一 production client-visible stop emission 都先经过 owner canonical state，且绕过 owner 的真实 production witness 会被独立 wire/state oracle 咬住”。改法明确后由 `gpt-souls:implementer` 承接；若要重塑 sink/token 边界，先由 `gpt-souls:architect-advisor` 定契约。

## [3] “窄判据 + 显式登记表”是否可接受

**裁决态：支持“这是当前给自己留口子”的质疑。以当前提出方式，它不是可接受降级。**

### 判据

“窄判据 + 显式登记表”只有在以下条件**同时**成立时才正当：

1. **诚实限定 claim**：门名与计划必须只声称它能证明的性质，例如“冻结的 13 个源区段仍各含一次指定调用”，不得继续称“owner 外零 anchor-stop 写点”“exactly-once”或“行为回归门”。
2. **具体可核验阻塞物**：必须点名为何语义 oracle 当前造不出来，例如缺少可从真实入口稳定驱动的某个 failure source，而不能写“实现成本高”“以后补”。工程量不是阻塞物。
3. **范围缩小由外部裁决**：提出登记表的人不能自行把冻结的行为门降为文本门；须由用户／未卷入裁决者明确批准，并记录降级的期限、恢复条件和 owner。主会话本人是冻结计划与退路作者，不能同时裁定自己的替代门等价。
4. **窄门有独立正控**：登记 population 必须来自独立 canonical source 或显式冻结契约，而不是由同一实现者看代码后手填；真实扫描入口要对删除、重复、遗漏 registry member 转红。
5. **行为 oracle 仍保留为未完成硬项**：登记表只能补“存在性／人口基线”，不能替代真实入口的 wire、settle、snapshot、History 结果。必须有确定到达的后续 gate，而不是开放式 backlog。

### 当前登记表为何不满足

`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/tests/architecture/anchor-close-sites.unit.test.ts:19-111` 手写 13 个 `{before, after, call}`，测试只读源码切片并断言其中包含调用文本（`:113-138`）。复核已明确验证：改变 mode、去掉 `await`、让 helper 内部提前 return 都照绿（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/tmp/2026-08-03-m1-code-review-walkthrough.md:255-258`）。因此它只能证明拼写存在，不能证明关闭发生、顺序正确或结果被消费。

更关键的是，冻结计划没有授权该降级：M1 commit 表要求“13 站点关闭回归”，并把有-anchor 零变化归因于站点回归（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:51`）；验收分层又明确要求“所有正常可达的 terminal／close-before-real 站点回归也走真实入口”（同文件 `:282-287`）。文本 registry 与这个 oracle 不同真相域。

### 同一方既当运动员又当裁判的结论

主会话可以**提出**降级方案、记录原因和级别，但不能自行宣布它满足原门。否则流程是：自己冻结行为门 → 自己发现行为门难满足 → 自己定义较窄替代物 → 自己宣布等价，所有条件仍由同一方自评，结构上可被滥用。正确动作是“记录为 provisional，交未卷入者／用户裁决”；在获得明确裁决前，原行为门仍未满足。

### 后续处置

保留 registry 可以，定位为辅助 L1 presence ratchet；它不应被删除，也不应被夸大。行为层由 `gpt-souls:verifier` 从冻结计划独立推导每类终局的 oracle，再由 `gpt-souls:implementer` 补真实入口 coverage。若某一站点确实无法从真实入口确定性驱动，由 verifier 点名具体不可达机制，并把该站点归 owner-level oracle，而不是整批降成文本表。

## [4] 两处同族 oracle 问题的定级与处置

### [4a] 七个 `settleMessagesOwnerFailure` 分流点逐个中和后全绿

**裁决态：支持主会话，定级 major；复核者的 minor 定级错误。主会话没有小题大做。**

#### 所用定级判据

- **major**：冻结的承重行为／显式验收门未被独立 oracle 锁住，现有 suite 可在生产接线退回已知错误形状时全绿；继续相位会让后续大改无信号地回归。
- **minor**：局部覆盖不足，但不违反冻结门、不让承重行为在 mutation 下静默失效，或有另一独立 oracle完整覆盖同一生产接线。

#### 独立证据

1. 该行为不是附属细节。冻结计划要求 `client-gone`／`session-terminating` 必须短路、零追加字节，且 ctx 收尾归 pump（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:105-113`）；又要求可从真实入口造出的 `client-gone × true/false` 走真 handler/driver，断言零追加、settle 一次、aborted、forwarded snapshot 与 `PipelineInfo` History 读回（同文件 `:282-287`）。
2. 当前七个生产接线点确实存在（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/routes/messages/handler-v4.ts:1466,1586,1625,1690,1809,1849,1894`），但已有单测只直接调用 helper（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/tests/messages/owner-failure-settlement.unit.test.ts`），证明 classifier/helper，不证明七处 handler 接线。
3. 复核做了最强正控：逐点把 `if (settleMessagesOwnerFailure(...))` 中和为 false，七次完整后端套件均 `6848 pass / 0 fail`（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/tmp/2026-08-03-m1-code-review-walkthrough.md:197-216,287-290`）。这不是“少一条测试”，而是**已知错误接线可恢复且全绿**；按冻结门必须判 major。
4. 复核自己尝试的真实 HTTP 探针在修复前后输出相同，因此无判别力（同报告 `:211-214`）。这进一步证明当前没有可替代 oracle，不能据“行为看起来正确”降级。

#### 处置

M1 不应定稿。至少按**控制流类别与真实入口**补足判别 oracle：direct 与 translate 各覆盖可达的 stream-error／truncation／catch 类别，并对独有 unrepairable-tool 分支单列；每条须对“中和 settlement 调用”转红，且断言终态、零追加 wire、snapshot 先于 settle、partial-delivery History。若多个站点经代码结构可证明共享同一个 production branch，可合并 oracle，但不能以源码 registry 代替。承接者建议 `gpt-souls:implementer`；oracle 独立推导交 `gpt-souls:verifier`。

### [4b] 13 个 close registry 是源码文本 oracle

**裁决态：两者皆误。** 首轮“7 个关闭站点删除后全绿”是 major；新增 registry 只修复了“调用文本被删”这个窄问题，没有关闭原本的“真实关闭行为无 oracle”major。把剩余行为缺口降为 minor不成立；但把 registry 本身当成无价值也不成立，它是有用的辅助 presence ratchet。

#### 独立证据

- registry 的实现只在手写 `before/after` 区段查 `call` 子串（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/tests/architecture/anchor-close-sites.unit.test.ts:19-138`）。它对 helper 提前 return、错误 mode、漏 await、错误处理未消费都失明。
- 冻结计划要求的是“13 站点关闭回归”以及“任一处改回 legacy 转红”（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:289-293,321-339`），并要求正常可达站点走真实入口（`:282-287`）。presence 与 behavior 是两条不同门，前者不能替代后者。
- 复核明确承认真正行为覆盖仍主要只有原 6 处，而新增 7 处删除时只红 registry 自身（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/tmp/2026-08-03-m1-code-review-walkthrough.md:237-258`）。因此“Major 的核心已解决”这一判断把“静默删调用”误当成全部风险；实际同样危险的“调用仍在但 no-op／参数错／结果丢弃”仍全绿。

#### 处置

保留 registry 并重命名／注释为“13-site source-presence ratchet”，不得把它计入行为验收。为七个缺口补 producer/HTTP wire oracle，至少断言 anchor stop 在终局前、exactly once、owner state 清空、错误终态分类正确；对无法真实入口造出的站点，必须逐项给不可达机制证明与 owner-layer positive control。此项仍是 M1 定稿前 major。

## 两次换轴是否满足“结构性闭合证明”三要件

### 第一次：同行 regex

**不满足，三要件全缺。**

- canonical fact：没有。它读取的是同一源码行上的 `writeAnchor` 与 `stopFrame` 拼写，不是 compiler/runtime/owner state 产出的事实。
- 归一：没有。变量提取成两行后合法编译且逃逸，已经是实证 witness（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/tmp/2026-08-03-m1-code-review-oracles.md:54-64`）。
- 独立正控：只有单行 mutation 会红；多行 witness 走真实扫描入口仍绿，所以正控证伪了闭合而非证明闭合。

### 第二次：`ClientSink` 类型能力边界

**也不满足。只有一个局部 compiler fact 与局部正控，缺关键归一。**

- canonical fact：局部有——TypeScript compiler 能证明静态类型 `ClientSink` 没有 `writeAnchor`（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/tests/architecture/package-boundaries.unit.test.ts:591-598`）。
- 归一：没有。所有合法写法没有先归一到该静态 view：公开 `OwnerRawSink` assertion、公开 `makeSseSink` raw factory 都可绕过；更根本地，普通 `ClientSink.write` 可写同字节 stop。复核的 `as OwnerRawSink` witness typecheck 绿（`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/tmp/2026-08-03-m1-code-review-oracles.md:104-119`），本次 scratch 又实测普通 `write` 造成 wire 已关而 `openAnchorIndex` 仍为 0。
- 独立正控：删除 `@ts-expect-error` 会 compile-red，只证明 type view 接线；它没有证明 production wire 的全部 emission 都消费该 fact。因此不能算结构性闭合。

### 拟议第三次：运行期摘除

尚未实施，不能预先授予闭合证明。即使 `makeDeliverySseSink` returned object 不再含 `writeAnchor`，仍缺“所有合法 wire emission 在入口前归一到 owner canonical state”这一要件；普通 `write` 与 raw factory witness 已证明当前方案单独不够。

## 最终路由建议

1. 先由 `gpt-souls:architect-advisor` 把边界改写成“owner canonical state + 唯一 emission choke point”，明确哪些帧可以由 generic sink 直写、anchor provenance/token 如何不可伪造或如何在 owner 内验证。
2. 由 `gpt-souls:verifier` 从冻结契约独立推导 M1 行为 oracle，尤其七个 settlement 接线与七个仅 presence-covered close 站点。
3. 形状冻结后由 `gpt-souls:implementer`：运行期摘除 leaked `clientSink.writeAnchor`、迁移测试正控到显式 adversarial seam、补真实入口 oracle；不要继续给 regex／登记表加拼写。

## 附带观察（不属于本次裁决，不定级）

- `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/driver.ts:1166-1177` 的注释仍描述 legacy `anchorClosed` 协调与 best-effort swallow，但当前实现已走 owner result；这是文档漂移，交 `gpt-souls:doc-writer` 另行核对。
