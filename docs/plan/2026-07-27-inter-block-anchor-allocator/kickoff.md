# Kick-off 提示词

> 本计划分 9 个相位（P0–P8），依赖图见 [README.md](README.md)。下方提供**整体 kick-off**（一个执行主体从头做到尾）与**分相位 kick-off**（并行/分派时用）。由谁在哪执行（当前会话 / 新会话 / subagent）是编排决策，本文档只提供可直接复制的提示词。

---

## 整体 kick-off（推荐起点）

```text
执行 generation-scoped 单调 wire-index allocator（方案 A）的实施计划。

计划入口：docs/plan/2026-07-27-inter-block-anchor-allocator/README.md —— 先完整读它（相位 DAG + 冻结契约表 C1-C8 + 承重项映射 + 8 条验收 oracle + 风险登记），再读 plan-0，然后按 DAG 顺序执行。

冻结设计（唯一权威，不得重议其目标与方案选择）：docs/spec/2026-07-27-inter-block-keepalive-carrier.md
配套审查（其发现已逐条映射进 plan）：同目录 -review-claude.md

一句话背景：Claude Code 有 300s「无真实内容」watchdog。本项目基于块级 buffered（已放弃流式与整响应缓冲），该制度下客户端在 content_block_stop 前收不到任何块帧，故首块提交后的长生成期客户端轨完全静默。当前已落地的只是 pre-content-only 升级（delivery/session.ts 里 `semanticBlockCount === 0` 那道门），首块后仍暴露。本计划就是该门的解除条件：让合成 gap anchor 占据单调递增的 wire index，后续真实块按 frontier 动态 remap。

裁判轴（**不是 ROI/YAGNI**）：长远正确 + 完整；架构健康 > 回归风险。不得以工程量为由把正确方案降级为可选或推迟。范围有疑问时停下问，不自行缩水。

纪律（每个相位都适用，README「全局纪律」有完整版）：
- TDD：每个 task 严格「写失败测试 → 跑，红 → 实现 → 跑，绿 → 提交」。若预测的红没咬，不得提交假绿，降级为 characterization 并在 plan 里注明。
- commit invariants：每个 commit 终态必须 typecheck 绿 + test:fast 绿 + C1/C2 两条不变量不处于半坏态。**绝不允许**「已按 frontier 分配但某个 remap 站点还在算 +1」的中间态落盘。相位顺序 P1→P3→P5 是硬性的，就是为了这一点。
- 每语义单元一提交，显式 pathspec（`git commit -F <msgfile> -- <精确路径>`），conventional commits，不加模型署名。
- **绝不碰 4141 端口的用户主服务器**。需要真服务器的 oracle 一律自起非 4141 实例，按 PID 精确 kill，绝不 pkill/killall。
- 实施中若与冻结设计冲突、或发现不可行处，**停下回报**，不自行改需求。

隔离 worktree：`git worktree add .worktrees/anchor-alloc -b feat/inter-block-anchor-allocator master`
（**P0 Task 0.0 第一件事**：核实 `fix/client-proxy-keepalive-300s` 是否已合并 master——P5 依赖它的 contentDeadlineMs / injectContentScaffold 机制；未合并则从该分支起 worktree 并记录实际 base。）

已知的两个前置事实（planner 实测，直接采信，别重新推）：
1. **P6 修的是当前现网缺陷，不只是 A 的前置门**：生产 delivery-session sink 上，driver 的 boundary commit 序列 suspend → freeze → resume 会让心跳**永久死亡**（freezeHeartbeat 被映射为 closeHeartbeat，置 heartbeatStopped，而 resume 的守卫会因此直接 return）。raw sink 上不会——而现有 anchor 测试全用 raw sink，所以结构性测不到。**Responses HTTP 的 buffered 默认就是 true 且有 output_item 边界，故它在 bundled 默认配置下就受影响**（CC 默认也 true 但边界退化、影响极小；Anthropic 默认 false，开启 protect_streaming_generation 即中招）。因此 P6 **可以独立于 A 先行落地与合并**（路径 P0 → P6），它自身就有生产价值；但它**仍是 P5 的前置**，A 开工前必须完成。
2. **审查 F4 的一个断言是假的**：它说「本仓库没有入站空 text block 清洗」，实际 `sanitize/content-blocks.ts:13` 的 filterEmptyAnthropicTextBlocks 无条件跑在生产 Anthropic 入站路径上。P7 因此从「实现兜底」重定位为「核实触达 + 真 CC 多轮实证」，FAIL 分叉的兜底仍在范围内。

先从 P0 开始（基线与守卫）。P0 不产生任何 src/ 改动，但它建的三条 oracle 是后面每一相位的验收基础——本改造的失败模式是**静默重排客户端内容**，typecheck 绿和单测绿都不足以发现。

（若当前优先级是尽快止血现网 keepalive 缺陷，可只走 P0 → P6 先交付，A 的其余相位另行排期。）
```

---

## 分相位 kick-off

### P0 — 基线与守卫

```text
执行 docs/plan/2026-07-27-inter-block-anchor-allocator/plan-0-baseline-and-guards.md。先读同目录 README.md 的冻结契约表与 oracle 总表。

目标：建三条独立 oracle 的可复用 harness + 现有 anchor 套件的红绿基线。本相位**无 src/ 改动**。

三条 oracle：O-1 wire index 严格单调无复用；O-2 任一时刻至多一个 block open；O-6 短请求默认配置字节等价（SHA-256 基线在 plan 里，若与当前 master 不符则重新捕获并记录 commit，不要为对上旧值扭曲配置）。

关键要求：O-1/O-2 的断言原语必须有**正样本对照**——用故意错误的帧序列证明断言会红（例如重复 index、两块并存 open）。「测试通过」不自证检查触达了目标。

harness 必须同时支持 raw sink（makeSseSink）与生产 sink（makeDeliverySseSink）两种注入——P6 揭示的缺陷只在后者可见。

绝不碰 4141：字节等价脚本用自选非 4141 端口起自己的服务器，脚本末尾按 PID 精确 kill。

裁判轴：长远正确 + 完整（非 ROI/YAGNI）。
```

### P1 — allocator 状态归位

```text
执行 plan-1-allocator-state.md。前置 P0 已完成。先读 README 的 C1/C3 两条契约。

目标：把已存在但未接线的 createAnchorIndexAllocator（src/lib/anthropic/keepalive-anchor.ts:49-62）挂进共享 AnchorState，把 AnchorHooks 的三个固定 index-0 帧改为 index-parameterized factory，并建立 `anchorsOpened === 0` 的**结构性**短路。

本相位**不改任何 remap 站点**（那是 P3）。结束时三处 remap 仍走旧的固定 +1，且必须与 allocator 记账一致——plan 里有一条「等价桥接」断言测试锁这个中间态不变量。

承重点（C3，README 风险表 R1）：A 会把今天被三重门挡住的死 remap 路径变成每请求热路径。记账错一处，爆炸半径从「升级过的请求」扩到**全部**普通短请求，且症状是静默重排（真 SDK 会悄悄重排 content 而不报错）。所以短路必须是**结构分支**（未开过 anchor 就返回原 frame 对象，引用相等可断言），不是「记账恰好算出 0」。并抽成单一共享 primitive + 架构守卫测试，禁止三处 remap 各写一遍判断。

AnchorState.allocator 设为**必填**而非可选——让类型系统逼出全部构造点。

裁判轴：长远正确 + 完整（非 ROI/YAGNI）。
```

### P2 — 分配临界区

```text
执行 plan-2-allocation-critical-section.md。前置 P1。先读 README 的 C5 契约。

目标：消除 heartbeat tick 与 driver flush 并发要 index 的竞态。index 分配必须发生在 delivery serializer 内部（与写出同一临界区）。

背景：suspendHeartbeat 只清定时器、**不等待在飞的 injector**。现有代码靠 injector「首个 await 前同步翻 state」躲开 TOCTOU（keepalive-anchor.ts:241-249 的长注释即此教训）。A 引入的是带返回值的分配动作（peek → 写帧 → commit），比布尔翻转更难原子化。

关键要求：并发 oracle 必须有**正样本对照**——注入一个把 peek 与 commit 之间插入 await 的 fake allocator，证明这个 harness 真能咬住竞态。若主测试一上来就绿，**不得**据此认为安全，调整 harness 直到正样本对照能咬住。时序测试**连跑 15 次**证确定性。

裁判轴：长远正确 + 完整（非 ROI/YAGNI）。
```

### P3 — remap 全站点接线

```text
执行 plan-3-remap-sites.md。前置 P1 + P2。先读 README 的 C4 契约。

目标：三处硬编码 `remap(frame, 1)` 全部改走 allocator frontier——
  S1 driver.ts:1185（buffered flush）
  S2 driver.ts:1242（retreat 写穿）
  S3 live-reconcile.ts:141（live 腿）

**live 腿不能漏**：冻结设计的改动面列了它，但设计正文的机制描述只谈 buffered；审查明确指出 live 腿必须接。留一个算 +1 的站点就是 C4 的反例，未来必然被误读。

必做：mutation 矩阵——对三个站点各做一次独立 mutation（改回硬编码 1），逐一确认至少一条测试转红并记录是哪条。若某站点的 mutation 不打红任何测试，说明无覆盖，补测试，不得跳过。

golden 纪律：wire 变化会按设计打红逐字节 golden。顺序不可颠倒——**先**用 O-1/O-2 独立验证新 wire 结构正确，**再**重捕 golden，绝不为让 golden 绿而扭曲实现。重捕单独一个 commit，与实现 commit 分离。
（注意：pre-content-only 场景**不应有**字节变化。这两个 golden 若意外变红，是回归信号而非预期重捕——停下查根因。）

有一处架构分叉在 plan 里标了：「谁调 allocateRealBlock」（driver flush vs delivery session 的 applyPendingFrame）。plan 给了推荐与理由；若实施期发现该选择站不住，**停下记录并回报**，不自行改。

裁判轴：长远正确 + 完整（非 ROI/YAGNI）。
```

### P4 — continuation frontier 统一

```text
执行 plan-4-continuation-frontier.md。前置 P3。先读 README 的 C4 契约与 plan 里的撞车序列。

目标：作废 `wireIndex(i) = i + anchorShift + continuationOffset` 双偏移，续写腿的块也从同一 frontier 分配。

必须先复现的撞车序列（审查给的，已逐层核实）：anchor@0 → real@1(上游0) → gap-anchor@2 → real@3(上游1)，续写腿上游 index 从 0 重启 → realBlockOffset(0) 命中主腿旧映射得 wire 1 → 再叠 continuationOffset=2 → wire 3 → **已被占用**。

Task 4.1 的重放 oracle **必须先写出并跑红**。若写完就绿，说明序列没被正确构造（多半是 continuation 分支根本没进），调 harness 而非改断言。同时要有 positive control。

删 ContinuationHooks.remap 前**不要**反射式清理——先 `rg -n "continuation.*remap" src/` 逐处核实跨格式（Responses/CC）续写腿是否仍在用。零消费者也先加 @deprecated 保留，交 P8 统一裁决。

Task 4.3 有一个可能的真分叉（某格式因删 continuationOffset 而破时该怎么办），plan 写了两个选项与各自代价——遇到就**停下回报**，不自行选。

裁判轴：长远正确 + 完整（非 ROI/YAGNI）。
```

### P5 — gap anchor 生命周期

```text
执行 plan-5-gap-anchor-lifecycle.md。前置 P2 + P3 + **P4**（Task 5.4 的交叉缝要用到 leg 语义）+ **P6**（心跳必须先修好，否则本相位的 oracle 会在 raw sink 上假绿而生产上是死码）。

目标：解除 delivery/session.ts 里 `semanticBlockCount === 0` 那道门（其注释明写解除条件就是本 allocator），让 gap anchor 能在任意「客户端无 open block」窗口注入，并在下一个真实块前关闭。

三个承重点：
- per-gap latch（5.1）：contentScaffoldAttempted 从一次性改为每 gap 重新武装。注意判据是「有过新真实内容」而非「anchor 关了」——后者会让心跳在同一 gap 内连开多个 anchor。
- close-before-real（5.2）要覆盖**每一个** gap anchor，不只第一个（现有 `!anchorClosed` 幂等守卫使它只关一次）。三条路径都要：flush 循环 per-frame、retreat 分支、live-reconcile。同时终局 close-off 的幂等不能破。
- **续写腿 × gap anchor 的跨相位集成缝（5.4）**——用户裁决升格为独立 red-first task，**不要**指望 P8 的合并态审兜底。理由：跨相位集成缝只在合并态才被发现、代价最高（本项目吃过这个亏）。P4 测「续写腿的块从 frontier 分配」、P5 测「gap 静默产生 anchor」，两者的**交叉**（续写腿进行中发生 gap 静默）没有任何一侧覆盖。plan 列了四个要验的具体形状，并要求 mutation 验证它咬的是交叉而非单侧。

AnchorState 字段语义要变（plan 有对照表）：anchorBlockOpen 现在其实是「本 generation 用过 anchor 吗」的历史标志，多 anchor 下不够用，要拆成「用过吗」（allocator.anchorsOpened()>0）与「当前有 open 吗」（openAnchorIndex?: number）。**替换而非并存**（项目不留双轨包袱），grep 全站点逐处迁移。

tool_use 特别注意：CC 是 eager per-block 执行（每个 content_block_stop 就 addTool → processQueue → executeTool）。gap anchor 绝不能推迟 tool_use 块的 stop，也不能插进其 deltas 中间。

**不翻 protect_streaming_generation 默认**——那是 ADR D4 的独立决策，A 是它的前置门而非它的一部分。

裁判轴：长远正确 + 完整（非 ROI/YAGNI）。
```

### P6 — 心跳生命周期修复（**现网缺陷**，可独立于 A 先行交付）

```text
执行 plan-6-heartbeat-lifecycle-fix.md。前置仅 P0。**必须先于 P5**，但**可以独立于 A 的其余相位先行落地与合并**——它修的是当前现网缺陷，自身即有生产价值。

这是 planner 读码 + 实测发现的缺陷，不在冻结设计与审查报告里。它不改变设计目标或架构方向。

缺陷：driver 的 block-level boundary commit 做 suspendHeartbeat(:1269/:1293) → flushBufferedFrames 内部 freezeHeartbeat(:1145) → resumeHeartbeat(:1271/:1326)。生产 delivery-session sink 上 freezeHeartbeat 被映射为 closeHeartbeat（session.ts:167），置 heartbeatStopped=true（:98），而 resume 的守卫 `if (... || heartbeatStopped) return`（:173）导致心跳**永久死亡**。raw sink（makeSseSink）无此问题——其 freezeHeartbeat 只 clearTimeout。

**影响面（已核实，plan 里有完整矩阵）**：Responses HTTP 的 buffered 默认 true（state-defaults.ts:243）+ 有 output_item.done 边界（candidate-response-session.ts:140）+ delivery sink → **默认配置下就受影响**：多 item 响应的首个 item 提交后心跳即永久死亡。CC 默认也 true 但边界退化（只认上游 error 帧），影响极小。Anthropic 默认 false，但开启 protect_streaming_generation 即中招。

实测两层，都带正样本对照：
  层一 sink 契约：suspend→resume raw=ping×4 / delivery=keepalive×10；suspend→freeze→resume delivery=[]
  层二 真 driver：120s 块间静默，raw sink 5 个 keepalive vs delivery sink 0 个

为什么至今没发现：现有 anchor/心跳测试全构造 raw sink，而三条生产 buffered 路径全走 delivery sink；delivery-session.unit.test.ts 虽直接测 delivery session 但从未组合 freeze+resume。症状是沉默的（没异常、没红测，只是静默期少了 ping）。

修法不是新架构决策，是把偏离的实现对齐到既有契约：client-sink.ts:361-366 明写 freezeHeartbeat「stops the timer WITHOUT closing the sink，write 仍可用（unlike close()）」。delivery session 是实现跑偏了。

必做：
- 负样本：修完要有一条「close() 仍然永久，resume 不得复活」的测试，防止修过头。
- **回归锁不能只写 Anthropic**（Task 6.3b）：默认中招的是 Responses HTTP，那条路径必须有自己的回归测试，否则默认受害的路径反而没测。

有一处需现场裁决的点（plan 里写了）：终局路径（closeAnchorIfOpen、driver 终端、pump 各终端分支）依赖 freeze 的永久性，改完后这些站点该调什么。plan 给了裁决依据；若核实发现两条 sink 的 close() 副作用不一致而无法统一，**停下回报**。

若走独立交付：路径 = P0 → P6，交付前补 test:backend 全绿 + 异模型 reviewer 审这一相位 + DESIGN/backlog 同步。

裁判轴：长远正确 + 完整（非 ROI/YAGNI）。
```

### P7 — 多轮空 anchor 回传（核实部分可在 P0 后立刻起）

```text
执行 plan-7-multi-turn-replay.md。核实部分（Task 7.1）前置仅 P0；真 CC 实证（7.3）依赖 P5。

风险：A 注入的空 text block 会进 CC 的对话历史，下一轮原样发回上游；Anthropic 系上游对请求内空 text content block 有已知校验。现有全部真 CC 证据都是 numTurns=1，多轮回传路径从未走过。

**注意 plan 里的一条更正**：审查报告断言「本仓库没有入站空 text block 清洗」是**假的**——sanitize/content-blocks.ts:13 的 filterEmptyAnthropicTextBlocks 经 sanitize-messages rewrite（appliesTo 恒真）无条件跑在生产 Anthropic 入站路径上。所以本相位是「核实触达 + 实证」，不是「从零实现兜底」。但风险方向仍成立，FAIL 分叉的兜底（清洗侧 α / 载体侧 β）仍在范围内，plan 说明了为何 α 明显优于 β。

必做：跨格式桥接腿（anthropic↔responses、openai-cc 反向）也要核实是否过这个 sanitize；某条腿绕过就是真缺口。

真 CC 实证的硬要求：prompt 必须设计成**必然产生第二轮**；若跑出来 numTurns=1，这次跑没有裁决力，**不得**记为 PASS。连跑 >= 3 次。非 4141 端口，按 PID 精确清理。

裁判轴：长远正确 + 完整（非 ROI/YAGNI）。
```

### P8 — 端到端验收与文档后果

```text
执行 plan-8-acceptance-and-docs.md。前置 P4 + P5 + P7。

三层验收 oracle，缺一不可：
1. O-4 真 @anthropic-ai/sdk 累积顺序 —— 断言 content 顺序与 wire 一致、gap anchor **在中间不在末尾**。这正是当初发现原 blocker 的手法（重复 index 会被 SDK 静默重排）。必须配 positive control：注入一个复用 index 的上游脚本，证明这条 oracle 能咬住那个故障形状。
2. O-5 真 CC inter-block >300s —— 静默必须发生在**两个真实块之间**（首块已 stop），连跑 >= 3 次；并且要有**对照组**（escalate_sec=0 应当 FAIL），证明 PASS 是 gap anchor 挣来的而非这次上游恰好快。
3. O-6 短请求字节等价 —— 必须逐字节等于基线。不同就是 C3 结构性短路失效的信号，回 P1.4 查，不是「可接受的小变化」。

文档后果（承重项 7）：
- ADR D2 第 3 点措辞修订（论域从「真实块」扩到「真实块 + 合成块，单一 frontier」）。**ADR 记录用户决策，改它要用户明确同意**——本 task 只产出草案，交主会话呈用户拍板。
- 作废 plan-Q5-three-way-overlap.md 的 `wireIndex(i) = i + anchorShift + continuationOffset`，追加 round-3 修订 + 替代记账表述。跨文档 grep 验证无残留。
- backlog 登记 J（长 text 块 idle 分块，A 的下游收益）+ B 的复活条件（record-not-adopted）。

合并态审查（Task 8.7）：派**异模型** reviewer（本计划由 Claude planner 写 → 用 gpt-souls:reviewer），prompt 必须显式写裁判轴「长远正确 + 完整，非 ROI/YAGNI」。plan 列了 5 个重点检查面。注意其中的跨相位集成缝（P4 leg 语义 × P5 gap anchor）**已由 Task 5.4 落成独立 red-first task**，reviewer 的职责是复核 5.4 的覆盖是否够（四个形状是否穷尽、交叉 mutation 是否真咬交叉），不是从零发现它。reviewer 的「无消费者/可安全删/已通过」类断言要亲自对照代码复核。

交付前跑 `bun run test:backend`（不是 test:fast）+ `lint:all`（不带 cache）。
```
