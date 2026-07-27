# Kick-off 提示词

> 本计划分 9 个相位（P0–P8），依赖图见 [README.md](README.md)。下方提供**整体 kick-off**（一个执行主体从头做到尾）与**分相位 kick-off**（并行/分派时用）。由谁在哪执行（当前会话 / 新会话 / subagent）是编排决策，本文档只提供可直接复制的提示词。

---

## 整体 kick-off（推荐起点）

```text
执行 generation-scoped 单调 wire-index allocator（方案 A）的实施计划。

计划入口：docs/plan/2026-07-27-inter-block-anchor-allocator/README.md —— 先完整读它（相位 DAG + 冻结契约表 C1-C9 + 承重项映射 + **9 条**验收 oracle + 风险登记 R1-R10），再读 plan-0，然后按 DAG 顺序执行。

冻结设计（唯一权威，不得重议其目标与方案选择）：docs/spec/2026-07-27-inter-block-keepalive-carrier.md
配套审查（其发现已逐条映射进 plan）：同目录 -review-claude.md

一句话背景：Claude Code 有 300s「无真实内容」watchdog。本项目基于块级 buffered（已放弃流式与整响应缓冲），该制度下客户端在 content_block_stop 前收不到任何块帧，故首块提交后的长生成期客户端轨完全静默。当前已落地的只是 pre-content-only 升级（delivery/session.ts 里 `semanticBlockCount === 0` 那道门），首块后仍暴露。本计划就是该门的解除条件：让合成 gap anchor 占据单调递增的 wire index，后续真实块按 frontier 动态 remap。

裁判轴（**不是 ROI/YAGNI**）：长远正确 + 完整；架构健康 > 回归风险。不得以工程量为由把正确方案降级为可选或推迟。范围有疑问时停下问，不自行缩水。

纪律（每个相位都适用，README「全局纪律」有完整版）：
- TDD：每个 task 严格「写失败测试 → 跑，红 → 实现 → 跑，绿 → 提交」。若预测的红没咬，不得提交假绿，降级为 characterization 并在 plan 里注明。
- commit invariants：每个 commit 终态必须 typecheck 绿 + test:fast 绿 + C1/C2 两条不变量不处于半坏态。**绝不允许**「已按 frontier 分配但某个 remap 站点还在算 +1」的中间态落盘。主链顺序 **P1→P2→P3→P4→P5** 是硬性的，就是为了这一点（P3 的分配依赖 P2 的 owner API；gap anchor 这个多-anchor 的唯一来源在 P5，晚于 P3 的 remap 切换）。
- 每语义单元一提交，显式 pathspec（`git commit -F <msgfile> -- <精确路径>`），conventional commits，不加模型署名。
- **绝不碰 4141 端口的用户主服务器**。需要真服务器的 oracle 一律自起非 4141 实例，按 PID 精确 kill，绝不 pkill/killall。
- 实施中若与冻结设计冲突、或发现不可行处，**停下回报**，不自行改需求。

隔离 worktree：`git worktree add .worktrees/anchor-alloc -b feat/inter-block-anchor-allocator master`
（**P0 Task 0.0 第一件事**：核实 `fix/client-proxy-keepalive-300s` 是否已合并 master——P5 依赖它的 contentDeadlineMs / injectContentScaffold 机制；未合并则从该分支起 worktree 并记录实际 base。）

已知的三个前置事实（planner 实测 / 审查坐实，直接采信，别重新推）：

1. **C3 短路的判据是「映射恒等」，不是「anchor 计数」**（首轮 plan review 的 blocker，已修订）。原表述「`anchorsOpened()===0` 即无条件短路」会让**无 anchor 的续写腿**跳过 remap、复用主腿已交付的 wire 0——这是**默认路径**（ping 模式 + 从未升级），比有 anchor 的撞车常见得多。修订后：短路当且仅当该腿 upstream index === 将分配的 wire index（等价条件 = 无 anchor **且** 主腿）。README「C3 的修订」有四场景表；P1.4 与 P4.1 各有对应的 red-first oracle。
   **附带教训**（写进 README 风险表 R9）：这条短路是上一轮设计 reviewer 建议、用户采纳的**风险缓解措施**，结果它自己引入了新缺陷——**为降风险而加的机制，本身要过同样的对抗检验**。

2. **P6 修的是当前现网缺陷，不只是 A 的前置门**：生产 delivery-session sink 上，driver 的 boundary commit 序列 suspend → freeze → resume 会让心跳**永久死亡**（freezeHeartbeat 被映射为 closeHeartbeat，置 heartbeatStopped，而 resume 的守卫会因此直接 return）。raw sink 上不会——而现有 anchor 测试全用 raw sink，所以结构性测不到。**Responses HTTP 的 buffered 默认就是 true 且有 output_item 边界，故它在 bundled 默认配置下就受影响**（CC 默认也 true 但边界退化到只认 error 帧，正常响应结构性幸免；Anthropic 默认 false，开启 protect_streaming_generation 即中招）。因此 P6 **可以独立于 A 先行落地与合并**（路径 P0 → P6），它自身就有生产价值。
   **但 P6 → P2 是硬依赖**（原称「无代码重叠可并行」是事实错误）：两者都改 `delivery/session.ts` 的 heartbeat 生命周期语义。P6 若独立先合并，allocator worktree 必须 rebase/merge 到含 P6 的 master 后再做 P2。

3. **审查 F4 的一个断言是假的**：它说「本仓库没有入站空 text block 清洗」，实际 `sanitize/content-blocks.ts:13` 的 filterEmptyAnthropicTextBlocks 无条件跑在生产 Anthropic 入站路径上。P7 因此从「实现兜底」重定位为「核实触达 + 真 CC 多轮实证」，FAIL 分叉的兜底仍在范围内。

先从 P0 开始（基线与守卫）。P0 不产生任何 src/ 改动，但它建的三条 oracle 是后面每一相位的验收基础——本改造的失败模式是**静默重排客户端内容**，typecheck 绿和单测绿都不足以发现。

（若当前优先级是尽快止血现网 keepalive 缺陷，可只走 P0 → P6 先交付，A 的其余相位另行排期。）

## 执行期必须停下回报的分叉（**不得自行拍板**）

| # | 分叉 | 何时停 |
|---|---|---|
| 1 | ~~P3.1 谁调 `allocateRealBlock`~~ | **已在计划期消解**——由 P2 的 owner API 冻结。仅当 owner 形状实施时站不住（如 live 腿装饰器接不进）才停下回报 |
| 2 | P4.3 删 `continuationOffset` 后跨格式破坏 | 先 grep + 跑测试确认**真实消费者**（现码只有 Anthropic handler 构造 `ContinuationHooks`）。确认是真消费者且冲突时才停；**不得**为不存在的消费者保留双权威 |
| 3 | P6.2 终局 freeze/close 裁决 | 若两条 sink 的 `close()` 副作用不一致而无法统一。方向已定（freeze 可恢复 / close 永久），需现场核的是 `close()` 是否还关写通道；若不同，引入**窄的**永久停 heartbeat primitive，而非复用语义过宽的 close |
| 4 | **P7.2 选择 β 载体**（新增） | α 不可行、必须改 anchor 载体时**必停**——β 改变客户端可见协议、最终文本与冻结的 carrier 形状，是产品/协议裁决 |
| 5 | **P8.4 ADR D2**（停点已前移） | **写 ADR 文件之前**就停：只产出逐段 replacement 草案，获用户明确同意后才改文件 |
```

---

## 分相位 kick-off

### P0 — 基线与守卫

```text
执行 docs/plan/2026-07-27-inter-block-anchor-allocator/plan-0-baseline-and-guards.md。先读同目录 README.md 的冻结契约表与 oracle 总表。

目标：建三条独立 oracle 的可复用 harness + 现有 anchor 套件的红绿基线。本相位**无 src/ 改动**。

三条 oracle：O-1 wire index 严格单调无复用无跳号；**O-2 块协议状态完整性**（不只是 maxOpen<=1——还要每个 delta/stop 引用当前唯一 open 的 index、stop 后集合为空、**终局无悬挂块**；原「只维护 openSet 断言峰值 1」会放行 orphan delta 与终局悬挂）；O-6 短请求字节等价（**权威基线 = 本 task 在实施 base 上捕获的 pre-change 字节**并保留字节文件供 `cmp`；历史 SHA 只作 provenance，差异必须先证明 hook/请求/配置相同再归因到具体 base change，不得直接换值）。

关键要求：断言原语必须有**正样本对照**——每条子断言各配一个故意错误的帧序列证明它会红（重复 index、跳号、两块并存、orphan delta、错误 stop index、终局悬挂、重复 stop）。「测试通过」不自证检查触达了目标。

harness 必须同时支持 raw sink（makeSseSink）与生产 sink（makeDeliverySseSink）两种注入——P6 揭示的缺陷只在后者可见。

绝不碰 4141：字节等价脚本用自选非 4141 端口起自己的服务器，脚本末尾按 PID 精确 kill。

裁判轴：长远正确 + 完整（非 ROI/YAGNI）。
```

### P1 — allocator 状态归位

```text
执行 plan-1-allocator-state.md。前置 P0 已完成。先读 README 的 C1/C3 两条契约与「C3 的修订」小节。

目标：把已存在但未接线的 createAnchorIndexAllocator（src/lib/anthropic/keepalive-anchor.ts:49-62）挂进共享 AnchorState，把 AnchorHooks 的三个固定 index-0 帧改为 index-parameterized factory，并建立**恒等**短路 primitive。

本相位**不改任何 remap 站点**（那是 P3）。结束时三处 remap 仍走旧的固定 +1。

**提交结构是三个原子单元，别自行拆**（plan 有表）：U1 = Task 1.1+1.2 一个 commit（AnchorHooks 类型改动会打红全部构造点，拆开则中间 commit 不编译）；U2 = Task 1.3（allocator 挂进 state + injector 取 index 同 commit）；U3 = Task 1.4。

**承重点（C3，本轮 blocker 所在）**：短路判据是**映射恒等**（`realBlockOffset(i) === 0`），**不是** `anchorsOpened() === 0`。后者会让无 anchor 的续写腿跳过 remap、复用主腿的 wire 0——那是默认路径。Task 1.4 的四个场景测试里，**场景 B（无 anchor 续写腿必须 remap）是 blocker 的回归锁**，必须先红。另加一条架构守卫：`anchorsOpened()` 不得出现在任何 remap 分支条件里。

AnchorState.allocator 设为**必填**而非可选——让类型系统逼出全部构造点。

桥接断言**只覆盖 anchor 侧**：真实块的分配要到 P3.1 才接线（依赖 P2 的 owner API），此时断言真实块 offset 就是自欺。

裁判轴：长远正确 + 完整（非 ROI/YAGNI）。
```

### P2 — 分配临界区

```text
执行 plan-2-allocation-critical-section.md。前置 P1 + **P6**（两者共享 delivery/session.ts 的 heartbeat 生命周期语义，见下）。先读 README 的 C5/C9 契约与 plan 的 Interfaces 小节。

目标：定义并落地**唯一 owner API**，使 index 分配与其帧写出在**同一个 serializer operation** 内完成。

**这不是「描述意图」而是要先定可执行接口**：delivery/serializer.ts 的 enqueue 被 session 私有持有，ClientSink.write* 各自 enqueue 一次。所以「先 allocate 再分别 writeAnchor/writeKeepalive」是**队列外分配 + 两个 operation**，既不满足 C5 也挡不住 TOCTOU。plan 已冻结 owner API 形状（allocateAndWriteAnchor / allocateAndWriteRealBlock / beginLeg）与三条语义要点（失败即不推进 = C9；delta/stop 不分配只查 mapping；ClientSink 不再暴露裸分配入口）。

**P6 依赖**：P6 改变「boundary commit 后 heartbeat 是否继续入队」，直接扩大本相位竞态的可达状态。若 P6 已独立合并 master，先把 worktree rebase/merge 到含 P6 的 master 再做 P2——否则会在旧 heartbeat 生命周期上写竞态 oracle，合并后测试语义失效。Task 2.2b 是专门的交叉门（其场景在 P6 之前不可达）。

关键要求：并发 oracle 必须有**正样本对照**——注入一个「先 allocate 再分别 write」的 fake owner（= 非法形状），证明 harness 真能咬住队列外分配。若主测试一上来就绿，**不得**据此认为安全，调整 harness 直到正样本对照能咬住。时序测试**连跑 15 次**证确定性。另需一条 C9 测试：write 失败不推进 frontier。

**P3.1 的原停点（谁调 allocateRealBlock）已由本相位的 owner API 消解**——答案是 delivery session 是唯一 owner，driver flush 与 live-reconcile 各自在自己的真实块 start 帧上调它。仅当该形状实施时站不住才停下回报。

裁判轴：长远正确 + 完整（非 ROI/YAGNI）。
```

### P3 — 三腿的「分配 + remap」完整矩阵

```text
执行 plan-3-remap-sites.md。前置 P1 + P2（**owner API 是本相位分配步骤的前提**）。先读 README 的 C4 契约与 plan 头部的三腿矩阵表。

目标：三条腿各自的**分配 + remap** 全部走单一权威——
  S1 driver.ts:1185（buffered flush）
  S2 driver.ts:1242（retreat 写穿）
  S3 live-reconcile.ts:141（live 腿）

**原 plan 只枚举了 remap、漏了 allocate**（审查坐实）：realBlockOffset 只有在开块时记录过 mapping 才能 remap 后续 delta/stop，仅把硬编码 1 换成 resolver **不会自动创建 mapping**，S2/S3 会读到缺失或旧 mapping。故每条腿都必须具名回答：start 帧谁分配、delta/stop 如何查同一 leg 的 mapping、同一块不会重复分配。

**live 腿不能漏**，且注意它的结构：reconcileLiveFrame 是**纯函数**（docstring 明写），不能在里面做 wire 写 —— 分配由装饰器 makeReconcilingSink 经 owner API 完成，remap 仍在纯函数内。若装饰器拿不到 delivery session，**停下回报**（这是 P2 owner 形状的真实性检验）。

**测试纪律**：多 anchor 状态必须由**真实的 gap 静默**驱动（FakeClock 推进过 deadline），**禁止**手工 allocateAnchor() 预置——那会让测试准备替实现完成关键动作，生产漏分配照样绿。

必做：**6 格** mutation 矩阵 = 三条腿 × 两个维度（A：remap 改回硬编码 1；B：**删除该腿的 allocate 调用**）。维度 B 专门咬「mapping 从未被创建」的漏接线，原 plan 完全没有它。每格都要记录是哪条测试转红；空格 = 该维度无覆盖，补测试。

golden 纪律：先用 O-1/O-2 独立验证新 wire 结构正确，**再**重捕 golden，绝不为让 golden 绿而扭曲实现。重捕单独一个 commit。（pre-content-only 场景**不应有**字节变化；意外变红是回归信号，停下查根因。）

裁判轴：长远正确 + 完整（非 ROI/YAGNI）。
```

### P4 — continuation frontier 统一

```text
执行 plan-4-continuation-frontier.md。前置 P3。先读 README 的 C4 契约与 plan 里的撞车序列。

目标：作废 `wireIndex(i) = i + anchorShift + continuationOffset` 双偏移，续写腿的块也从同一 frontier 分配。

**两个分支的撞车 oracle 都必须先写出并跑红**（Task 4.1）：
- **分支一（默认路径、本轮 blocker）**：零 anchor 的续写腿。主腿 real@0 已交付 → cut → 续写腿 upstream 从 0 重启；若因 anchorsOpened()===0 而短路，会再写一次 wire 0。这是 ping 模式下的**常见路径**，原 plan 完全漏了。
- **分支二（审查给的序列）**：anchor@0 → real@1(上游0) → gap-anchor@2 → real@3(上游1)，续写腿 realBlockOffset(0) 命中主腿旧映射得 wire 1 → 再叠 continuationOffset=2 → wire 3 → **已被占用**。

两条各配一个 positive control（分别注入「按原 C3 判据短路」的 fake 与「双偏移」的 fake，证明 oracle 能咬住对应故障）。若某条写完就绿，多半是 continuation 分支根本没进——调 harness 而非改断言。

删 ContinuationHooks.remap 前**不要**反射式清理——先 `rg -n "continuation.*remap" src/` 逐处核实。**已知事实**：现码只有 Anthropic handler 构造 ContinuationHooks（handler-v4.ts:1280），Responses/CC 的 continuation 测试更多是未来/合同核实。所以 Task 4.3 多半**不是真分叉**——先用 grep 与测试确认真实消费者，确认确有消费者且冲突时才停下回报；**不得**为不存在的消费者保留双权威。零消费者则加 @deprecated 保留，交 P8 统一裁决。

裁判轴：长远正确 + 完整（非 ROI/YAGNI）。
```

### P5 — gap anchor 生命周期

```text
执行 plan-5-gap-anchor-lifecycle.md。前置 P2 + P3 + **P4**（Task 5.4 的交叉缝要用到 leg 语义）+ **P6**（心跳必须先修好，否则本相位的 oracle 会在 raw sink 上假绿而生产上是死码）。

目标：解除 delivery/session.ts 里 `semanticBlockCount === 0` 那道门（其注释明写解除条件就是本 allocator），让 gap anchor 能在任意「客户端无 open block」窗口注入，并在下一个真实块前关闭。

三个承重点：
- per-gap latch（5.1）：contentScaffoldAttempted 从一次性改为每 gap 重新武装。注意判据是「有过新真实内容」而非「anchor 关了」——后者会让心跳在同一 gap 内连开多个 anchor。
- close-before-real（5.2）要覆盖**每一个** gap anchor，不只第一个。三条路径都要：flush 循环 per-frame、retreat 分支、live-reconcile。并须有 anchor stop 的 **exactly-once** 测试（终局站点两两组合）。
- **续写腿 × gap anchor 的跨相位集成缝（5.4）**——独立 red-first task，**不要**指望 P8 的合并态审兜底。其 mutation 要求是**交叉矩阵**：**同一条**交叉测试对「删 P4 的 beginLeg」与「删 P5 的跨腿 latch re-arm」两个 mutation 分别以**可辨识的不同原因**失败，另加两条单侧 control。只要求「同文件任一条红」是不够的——那最多证明文件里同时有两侧测试。

**AnchorState 状态机已冻结**（plan 有表，别自行猜）：**删除 anchorClosed 与 anchorBlockOpen 两个字段**，由 `openAnchorIndex?: number` 的 undefined → index → undefined 转移**单一**承担 per-anchor 关闭与终局 once guard。原 plan 曾给出三种互斥语义，已裁决统一。若确实需要 generation-terminal 标志，**另起名** terminalClosing/terminalClosed 并补全写者/读者表 + exactly-once 测试，**不得**复活 anchorClosed 的模糊语义。

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

**O-7 已按审查重写——绝不能只断 numTurns>=2**：该值在本仓库**已是 stall 的可观测签名**（tests/e2e-client/anthropic-cli.e2e.test.ts:50 明写 "empty-string end_turn STALLS the agent loop (num_turns>1, result empty)"），它无法区分「按设计的工具第二轮」与「agent 空转重问」。改用**确定性 tool-use mock**，断言四条：① 第二轮 tool_result 的 tool_use_id **精确等于**第一轮那个；② **上游命中恰为 2**；③ 第二轮请求体含正确 tool_result **且无空 text block**；④ 最终 marker 非空、无第三轮。另加 mutation：让 mock 按真实校验规则对空 text block 返 400 并临时绕过 sanitize，证明测试能咬住泄漏。连跑 >= 3 次。非 4141 端口，按 PID 精确清理。

**范围限定要写进 FINDINGS**：本 oracle 用 upstream hook，证明的是「CC 如何回传 + 我方送出什么」，**不是**「真 GHC 是否接受」——后者已登记 backlog（P8.6）。

**β 载体是停下回报的分叉**：若 α（补齐清洗接线）不可行、必须改 anchor 载体，**停，回主会话**。β 改变客户端可见协议、最终文本与冻结设计选定的 carrier 形状，是产品/协议裁决，不是实现细节。

裁判轴：长远正确 + 完整（非 ROI/YAGNI）。
```

### P8 — 端到端验收与文档后果

```text
执行 plan-8-acceptance-and-docs.md。前置 P4 + P5 + P7。

三层验收 oracle，缺一不可：
1. O-4 真 @anthropic-ai/sdk 累积顺序 —— 断言 finalMessage 深等值、content 顺序与 wire 一致、gap anchor **在中间不在末尾**。这正是当初发现原 blocker 的手法（重复 index 会被 SDK 静默重排）。positive control 须**先断言 wire 上确有 duplicate index**（防 mock 没生效导致对照组本身失效）。
2. O-5 真 CC inter-block >300s —— 静默必须发生在**两个真实块之间**（首块已 stop），连跑 >= 3 次；要有**对照组**（escalate_sec=0 应当 FAIL）；并**记录 anchor 帧确实出现 + 上游静默实测时长**（防 PASS 来自 hook 没真等）。它证明的是特性效果，需与 O-1/O-3 联合裁决 allocator 正确性。
3. O-6 短请求字节等价 —— 必须与 **P0 在实施 base 捕获的字节** 逐字节相同（`cmp`，不是比对三天前的历史 SHA）。不同就是 C3 恒等短路失效的信号，回 P1.4 查，不是「可接受的小变化」。

文档后果（承重项 7）：
- **Task 8.4b（先做）**：同步冻结 spec 的**状态行**——它目前仍写「设计候选，待用户裁决」，与本 plan 自称「已冻结、用户已选 A」矛盾。只改状态行 + §9 措辞，**不动设计正文**。这是记录既有裁决，不需再次征求同意。
- **Task 8.4（ADR D2）：停点在写文件之前**。只产出逐段 replacement 草案 → 回主会话取得用户明确同意 → 获批后才改 docs/decisions/2026-07-22-continuation-retry-sequential-anchor.md。未获批时 P8 其余验收照常，但**不得宣称文档收口**。
- 作废 Q5 的 `wireIndex(i) = i + anchorShift + continuationOffset`：验收判据是**分类审计**（先用宽 pattern `rg -n "wireIndex|anchorShift|continuationOffset" docs/ src/` 列命中，逐条分为「已作废历史记录」或「仍具规范性」，要求**无未标注作废的规范性消费者**），**不是字面零命中**——那不可能成立（本 plan 自己就会命中）。Q5 正文的表/公式/示例/标题都要同步，不只是加修订记录。
- backlog 登记：J（长 text 块 idle 分块）+ B 的复活条件 + 「空 anchor 对真 GHC 的可接受性未证明」（O-7 的范围限定）。

收口清单是 **O-1 ~ O-9 九条**（README 总表、P8 验收记录表、本清单三处对账，别漏 O-9 交叉缝）。

合并态审查（Task 8.7）：派**异模型** reviewer（本计划由 Claude planner 写 → 用 gpt-souls:reviewer），prompt 必须显式写裁判轴「长远正确 + 完整，非 ROI/YAGNI」。plan 列了 5 个重点检查面。注意其中的跨相位集成缝（P4 leg 语义 × P5 gap anchor）**已由 Task 5.4 落成独立 red-first task**，reviewer 的职责是复核 5.4 的覆盖是否够（四个形状是否穷尽、交叉 mutation 是否真咬交叉），不是从零发现它。reviewer 的「无消费者/可安全删/已通过」类断言要亲自对照代码复核。

交付前跑 `bun run test:backend`（不是 test:fast）+ `lint:all`（不带 cache）。
```
