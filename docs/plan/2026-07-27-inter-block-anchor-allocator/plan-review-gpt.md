# GPT 异模型对抗评审：generation-scoped anchor allocator TDD plan

> 状态：完整终稿。

## 评审范围

- 待审计划：`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc-plan/docs/plan/2026-07-27-inter-block-anchor-allocator/`，commit `4945d988`。
- 冻结设计：`/home/xp/src/copilot-api-js/docs/spec/2026-07-27-inter-block-keepalive-carrier.md` 及 Claude 评审报告。
- 相关 ADR／计划／代码：continuation ADR、Q5 三方叠加计划、allocator 姊妹计划，以及 `driver.ts`、`delivery/session.ts`、`client-sink.ts`、`keepalive-anchor.ts`、`live-reconcile.ts`、Responses／Chat Completions／Anthropic 路由。

## 已读取／执行的证据

- 逐行读取 README、kickoff、P0–P8、冻结设计、设计评审、ADR D2/D3、Q5 计划与 allocator 姊妹计划。
- 代码核验：三个 remap 站点、continuation 双偏移、delivery serializer、两种 sink 的 freeze／resume 语义、各端点 buffered 默认值和 commit-boundary 接线、空 text block 入站清洗链。
- 独立探针：
  - `ccCommitBoundaries`：普通 chunk=`false`、finish chunk=`false`、error=`true`。
  - `isResponsesCommitBoundary`：`response.output_item.done`／`response.completed`／`error`=`true`。
  - delivery sink 执行 `suspend → freeze → resume` 后等待多个 heartbeat interval，观测写入数为 `0`。
  - 聚焦测试：continuation、delivery-session、Responses buffered、CC buffered，共 `34 pass / 0 fail`。

## 总体 verdict

**存在 blocker，必须先修订；当前不可开工实施。** 核心冲突是 C3 的 `anchorsOpened===0` 无条件短路会破坏无-anchor continuation 的 index 接续；此外 allocator 分配所有权、P2 临界区、P3 三腿接线与若干 oracle 仍不闭合。P6 的现网影响面主结论经独立核验成立。

- blocker：**1**
- major：**11**
- minor：**5**
- nit：**0**

## 事实性发现（已确认部分）

### [major] P2 Task 2.2／P5 Task 5.3 — “在 delivery serializer 内分配”没有可执行接口，计划描述的实现实际仍可能在队列外分配

- `delivery/serializer.ts` 的 `enqueue` 被 `createDownstreamDeliverySession` 私有持有；`ClientSink.write*` 每次各自 enqueue，调用方无法把“allocate + start + delta”封成同一个 serializer operation。
- P2.2 一面要求分配进入 serializer，一面又写“driver 侧真实块分配紧邻 `sink.write` 且中间无 await”。后者发生在调用 `sink.write` **之前**，不在 delivery queue 内；heartbeat injector 若先 `allocateAnchor()` 再分别调用 `writeAnchor`／`writeKeepalive`，同样在队列外分配且两次写是两个 operation。
- 这没有满足冻结契约 C5，也不足以排除在飞 heartbeat operation 与 driver flush 的 TOCTOU。
- 建议：计划先明确唯一 owner API，例如由 delivery session 暴露 generation-scoped `allocateAndWriteBlockStart`／`writeGapAnchor`，在一个 enqueue callback 内完成 allocate + state commit + 必要帧写出；或者明确采用“首个 await 前同步分配并提交”的另一条冻结方案，并把成功写失败后的 frontier 语义写成契约。不能同时含糊地声称“进 serializer”与“driver 紧邻 write”。

### [major] P3 Tasks 3.1–3.3 — 只枚举了三处 remap，却没有为 retreat 与 live 两腿安排“真实块恰好一次分配”

- P3.1 明确在 S1 buffered flush 的 `content_block_start` 调 `allocateRealBlock`。
- P3.2 只说 S2 retreat 改走 `resolveRemappedFrame`；P3.3 只说 S3 live-reconcile 改走该 primitive。两处都没有具名步骤在真实 `content_block_start` 上调用 `allocateRealBlock`。
- 当前 allocator 的 `realBlockOffset(upstreamIndex)` 只有在开块时记录了 wire mapping 才能 remap 后续 delta／stop；仅把硬编码 `+1` 换成 resolver 不会自动创建 mapping。S2／S3 会读到缺失或旧 mapping，尤其 continuation leg upstream index 重启时会静默复用 index。
- P3.1 的测试通过“手工推进 allocator 到多 anchor 状态”会掩盖生产路径漏分配：测试准备替实现完成了关键动作。
- 建议：将三个站点改成“allocation + remap”完整矩阵，每腿都具名说明 start 帧谁分配、delta／stop 如何查同一 leg mapping、同一块不会重复分配；mutation 不仅把 remap 改回 `1`，还要分别删除每腿的 allocate 调用并确认生产路径测试转红。

### [major] README DAG／P6 头部 — P6 与 P2 被称为“可并行且无代码重叠”不成立，缺少两者的交叉验证

- P2 与 P6 都修改 `src/lib/pipeline/delivery/session.ts`：P2 改 serializer／分配写入临界区，P6 改 heartbeat freeze／resume 生命周期。它们共享的正是 heartbeat operation 入队、挂起、恢复与 flush 交接语义。
- P6 可独立先交付成立，但“可与 P1–P4 并行（无代码重叠）”是事实错误。即使 Git 文本可合并，P6 改变 heartbeat operation 是否会在 boundary commit 后继续入队，直接扩大 P2 竞态的可达状态。
- 建议：若 P6 先独立合并，则 P2 必须基于含 P6 的 base 实施；DAG 增加 `P6 → P2`，或增加 P2×P6 独立交叉 task：boundary commit 后 resume，tick 在 flush await 让点入队，断言 frontier 无重复／无跳号且 anchor 不插入真实块内部。

### [major] O-2／P0.2 — `maxOpen===1` 断言过弱，无法证明块协议平衡和 delta／stop 归属正确

- 计划原语只维护 openSet 并断言峰值为 1。坏实现若把 `start@1` 正确 remap、但把同块的 delta／stop 留在 upstream `@0`，单块终局场景的峰值仍是 1；流最后却悬挂 `@1`，且 delta／stop 指向未 open index。
- 当前正样本对照只覆盖“两次 start 并存”，没有覆盖 orphan delta、错误 stop index、终局 openSet 非空。
- 建议：把 O-2 升级为 protocol-state oracle：每个 delta／stop 必须引用当前唯一 open index；stop 后集合为空；终局必须无 open block；重复 stop／orphan delta 必须红。`maxOpen <= 1` 只是其中一个子断言。

### [major] Task 5.4 Step 5 — 当前“任一侧 mutation 让本文件转红”不能证明测试咬住的是交叉缝

- 删除 P4 `onLegStart()` 可以让纯 continuation index 断言红；破坏 P5 latch reset 可以让纯多-gap 计数红。只要求“同一测试文件中至少一条红”，最多证明文件同时含两侧测试，不证明某个 oracle 依赖 P4×P5 的交叉。
- 建议：指定同一个交叉场景（例如主腿 gap + continuation-leg gap + upstream index 重启），建立 mutation 矩阵：删除 `onLegStart()` 与删除跨腿 latch re-arm 时，**同一条交叉测试**分别因明确不同的期望失败；另保留两条单侧 control，证明 mutation 不是只被 P4.1 或 P5.1 的既有性质捕获。

### [major] P7.2 — 载体侧 β 会改变客户端可见协议与最终文本，却允许 executor 自行选择，属于漏掉的停下回报分叉

- α 是补齐入站清洗接线；β 是把空 anchor 改为“非空但不可见”载体。β 会改变 O-4 的 SDK 累积、客户端渲染、历史内容与冻结设计中的 carrier 形状，不是普通实现细节。
- 计划目前写“按实测失败形状选 α 或 β，在此记录为什么”，这让 executor 自行作产品／协议裁决。
- 建议：α 若可行可直接执行；若必须转 β，停下回主会话／用户裁决，并补独立客户端矩阵后再冻结。

### [minor] P6 影响面矩阵 — 主结论成立，但 CC 应写成“正常响应不受影响；error 后续帧契约待验证”，不是无条件“实际幸免”

- 独立代码与探针确认：Responses HTTP 默认 `responsesBufferedRetry=true`，HTTP candidate 挂 `isResponsesCommitBoundary`，`response.output_item.done` 命中，且使用 delivery sink，因此默认中招结论成立。
- Responses WS 明确省略 `commitBoundaries`，结论成立。Anthropic 默认 `protectStreamingGeneration=false`，显式开启才中招，结论成立。
- CC 默认 buffered=true；`ccCommitBoundaries` 对普通／finish chunk 为 false，只对 in-band error 为 true。因此正常成功响应没有 mid-generation boundary commit，确实不受该缺陷影响。
- 但 driver 不因 error boundary 自动 break；若协议畸形地在 error 后仍有帧，freeze 死亡仍可能影响后续。P6.3b Step 5 已要求核实，这是正确的。矩阵措辞应限缩为“正常响应结构性幸免；error 后续帧按契约／实测裁决”。

### [minor] P6 的两层实证 — 根因与方向可独立复现，精确 `RAW 5 / DELIVERY 0` 尚无仓库内可重跑产物

- 我独立复现了 sink 契约层：delivery sink `suspend → freeze → resume` 后 heartbeat 写入为 0；raw sink 代码的 freeze 不置永久 stopped，机制差异坐实。
- driver 控制流也明确执行 boundary `suspend → flushBufferedFrames(freeze) → resume`，故 production sink 死亡可由代码推出。
- 但计划引用的 120s 真 driver 精确计数 `RAW 5 / DELIVERY 0` 只存在于文档叙述，当前分支没有对应 probe／测试可直接复跑。P6.3 会把它固化，这是必要工作；开工前不应把精确数字当作已留存的可重复证据。

## 已确认无问题的重点

- 文档后果有具名 task：P8.4 修订 ADR D2；P8.5 作废 Q5 公式并提供替代记账表述。
- P8.5 包含跨文档 grep，但终稿仍需核对其 pattern 是否覆盖全部公式变体。
- P6 作为独立生产缺陷先交付的方向正确；其 freeze 可恢复、close 永久的契约与 raw sink 注释一致。


## 追加事实性发现

### [major] README:32-40／P1:145-155／P2:1-3／P3:1-2 — DAG 图与正文的硬链不一致，P1 的“等价桥接”也没有对应的生产记账步骤

- README 正文说 `P1→P2→P3→P4→P5` 是串行链，P3 头部也写前置含 P2；但 Mermaid 只有 `P1→P2` 与 `P1→P3`，**没有 `P2→P3`**。按图编排会允许 P2/P3 并行。
- P1 收口又要求 `onAnchorOpen`／`onRealBlockOpen` 已在生产 sink 正确调用，才能证明旧 `+1` 与 allocator 记账等价；但 P1.3 的实现步骤只把 allocator 挂入 `AnchorState`，真实块的 `allocateRealBlock` 被推迟到 P3.1。P1 的桥接测试若靠测试手工推进 allocator，不能证明生产中间态满足 commit invariant。
- P1.2 还要求两个 injector “改为向 allocator 要 index”，而 allocator 到 P1.3 才挂进共享 state；按 task 顺序无法既保持 generation 唯一实例，又在 P1.2 独立提交。
- **建议**：重排为原子、可提交的链：先定义 state／factory 类型与 generation allocator owner，再在同一 commit 接上 pre-content anchor 和真实块的生产分配，最后建立桥接；或者把 P1.2–P1.3 合成一个 commit invariant 单元。Mermaid 明确补 `P2→P3`，并将 P6 的 base 要求与 P2 交叉门一并画出。

### [major] P5:27-44,66-83 — `anchorClosed` 的目标语义自相矛盾，终局幂等 owner 没有冻结

- Files 小节说 `anchorClosed` 从“一次性”改为“当前 anchor 是否已关”；语义表又说保留为“终局收口是否已做”；Task 5.2 随后改用 `openAnchorIndex` 表示当前 anchor，并说终局也用 `openAnchorIndex` 幂等。
- 这三种语义不能同时成立。多 anchor 下若 `anchorClosed` 在第一次 gap close 后永久为 true，后续终局 close 可能短路；若每个 gap 重置，又不能充当整个请求的终局 once guard；若 `openAnchorIndex` 已是 close-off 的单一判据，`anchorClosed` 则是残留双轨。
- **建议**：计划先冻结一个单一状态机。优先删除 `anchorClosed`，由 `openAnchorIndex` 的 `undefined → index → undefined` 转移同时承担 per-anchor 与终局幂等；若确需 generation-terminal 标志，另命名为 `terminalClosing/terminalClosed`，并写出所有写者／读者和 exactly-once 测试。不能把语义裁决留给实现者猜。

### [major] O-7／P7.3:67-83 — `numTurns>=2` 不能区分“按设计的工具第二轮”与 agent stall／自动重问，当前真 CC oracle 可能假绿

- 现有仓库已经把 `num_turns>1` 用作 **stall** 的可观测签名；因此只断言 `numTurns>=2` 并不能证明 CC 正常完成了多轮历史回传。
- P7.3 说 prompt “要求用一个工具”即可必然产生第二轮，但没有断言第一轮确实输出指定 `tool_use`、客户端确实回传匹配 `tool_use_id` 的 `tool_result`、第二轮原因是工具结果而非空转重问，也没有限制上游请求次数。
- 它还使用 upstream hook，所以能独立证明的是“真 CC 怎样回传、我方送给 hook 的第二轮请求体是什么”，不是“真 GHC 是否接受”；后者只能由生产 sanitize 后的请求体 oracle或靶向真上游补证。
- **建议**：用确定性的 tool-use mock：第一轮固定返回唯一 `tool_use`，捕获 CC 执行及第二轮 `tool_result`，断言 exact tool id、上游命中恰为 2、第二轮 messages 中既有正确 tool_result 又无空 anchor、最终非空 marker 且无第三轮。另保留一个故意绕过 sanitize 的 mutation，使 mock 按真实校验规则 400，证明测试能咬住空块泄漏。

### [major] P8.4:49-59 — “先改 ADR、后征得同意”与 ADR 权限纪律冲突，应在修改文件前停下

- Task 8.4 Step 1/2 直接要求修改 ADR，Step 3 才说“本 task 产出草案，交主会话呈用户拍板”。这会让 executor 在未获用户同意前先改权威决策文件；末尾还预置了 commit。
- **建议**：把停点前移：先生成逐段 replacement／diff 草案（不写 ADR），回主会话取得明确同意；获批后才修改 `/home/xp/src/copilot-api-js/docs/decisions/2026-07-22-continuation-retry-sequential-anchor.md` 并提交。未获批时 P8 可完成其余验收，但不得宣称文档收口。

### [major] README:2-5／冻结 spec:2,184-193 — 被称为“冻结唯一权威”的 spec 头部仍写“设计候选，待用户裁决”

- 实际 master spec 的状态仍是“设计候选，已按两轮异模型评审修订，待用户裁决”，而计划声称用户已选 A、spec 已冻结。执行者同时读到两个相反状态。
- P8.6 只计划在实现完成后加“已落地”注解，没有在开工前把“方案 A 已获用户裁决、需求冻结”同步为事实。
- **建议**：在 plan 合并／执行前增加一个文档同步 task，按用户既有裁决更新 spec 状态与选定方案，不改设计正文；并记录裁决日期／指向 plan。否则“冻结契约”只存在于计划自述，不在其权威来源中。

### [minor] C8／P0.1:30-39 — 固定 SHA 被列为冻结契约，但 P0 又允许静默重捕，合同层级混淆

- 基线来源可追溯：`/home/xp/src/copilot-api-js/docs/todo/keepalive-300s-fix-review-gpt.md:98` 记录了两个隔离端口、`escalate=0/200`、1675 bytes 与同一 SHA；这不是无来源数字。
- 但该 hash 是某一 commit、请求、hook、配置和 SSE writer 的 characterization，不应是跨 master 前进永久不变的需求。P0 正确地允许在实现 base 上重新捕获，却会与 README C8 的“冻结精确 hash”冲突。
- **建议**：C8 改成“在 P0 的实施 base 捕获 pre-change bytes，P8 必须逐字节等于该捕获物”；旧 SHA 只作 provenance／sanity check。若重捕，必须先证明 hook、请求与配置相同，并记录造成差异的 base change，不能仅因“不匹配”直接换值。

### [minor] P8.5:61-70 — 有具名作废 task，但 grep 的“零残留”判据不可执行且 pattern 不完备

- `rg -n "anchorShift|i \+ 1 \+ continuationOffset" docs/ src/` 会命中 P8.5 自己新增的 round-3 历史说明、本计划 README／kickoff、旧评审中的引用；因此“全仓无残留”不可能成立。
- 它也漏掉 `wireIndex = i + anchorShift + continuationOffset`、空格／反引号差异及只写 `continuationOffset` 的规范性表述。
- **建议**：先以 `rg -n "wireIndex|anchorShift|continuationOffset" docs/ src/` 生成命中清单，再逐条分类为“已作废历史记录”或“仍具规范性”；验收应是**无未标注作废的规范性消费者**，不是字面零命中。同步 Q5 全文的表、公式、示例和标题，并给每个保留历史命中加明确 superseded 标记。

### [minor] P8.8:100-119 — 收口清单仍写“O-1～O-8 八条”，与总表的 9 条不一致

- README 与 P8 验收表都有 O-9，P8.8 却只要求记录 O-1～O-8。执行者照 checklist 可漏掉最重要的 P4×P5 交叉 oracle。
- **建议**：改成 O-1～O-9，并让验收记录表／kickoff／README 三处由同一个清单对账。

## 9 条 oracle 逐条审计

| Oracle | 结论 | 独立性／会不会咬 | 必要修订 |
|---|---|---|---|
| O-1 单调、无复用、无跳号 | **基本成立** | 驱动真实 `runResponseBufferedSink`、收全量 client frames，期望 `[0..n-1]` 不从 allocator 内部状态推导；重复 index control 能证明基础断言有牙齿 | 每腿再做“删除 allocate 调用”mutation，避免测试手工预置 mapping 替生产接线完成工作 |
| O-2 `maxOpen===1` | **不充分，major** | 只测 start 的并存峰值；错误 delta／stop index、orphan delta、终局悬挂都可通过 | 升级为完整 block protocol state oracle，见前述发现 |
| O-3 canonical gap shape | **成立** | 精确 expected wire 序列独立于实现，且“加回 semantic gate”mutation 可咬；不是只看计数 | 明确强制生产 delivery sink；否则 P6 已证明 raw sink 可假绿 |
| O-4 真 SDK 累积 | **强** | 真 `@anthropic-ai/sdk` 是独立 consumer oracle；重复 index positive control 直接复现原始静默重排故障 | 对照应验证实际 wire 确有 duplicate，防 mock 未生效；保留 finalMessage 深等值 |
| O-5 真 CC >300s | **强但昂贵** | 真 CC、两个真实块之间 >310s、三次、`escalate=0` FAIL 对照，能证明客户端可观察保活有效 | 再记录 anchor 帧确实出现及上游静默时长，防 PASS 来自 hook 没真正等待；对照证明 feature 效果，不单独证明 allocator 正确，需与 O-1/O-3 联合裁决 |
| O-6 短请求 bytes | **强，前提是 pre-baseline 固定** | pre-change capture 与 post-change raw SSE `cmp` 是独立字节 oracle；单元里的引用相等负／正样本能证明 `resolveRemappedFrame` 两分支，但不能单独证明所有调用站点都走它 | 以实施 base 的 P0 捕获为权威；保留架构守卫与三站点 mutation。引用相等测试本身不是自证，但仅是 primitive test，必须与端到端 byte probe 配对 |
| O-7 真 CC 多轮 | **当前会假绿，major** | `numTurns>=2` 同时可能表示正常工具回合或 stall；hook 不能证明真上游接受 | 按前述 exact tool-use/tool_result/upstream-hit oracle 重写 |
| O-8 boundary 后心跳 | **成立** | delivery sink red、raw sink control、修复后回归及改回永久 stopped mutation形成红绿闭环；Responses HTTP 单独覆盖默认受害端点 | 把 planner 的一次性 `RAW 5 / DELIVERY 0` 固化为仓库测试；CC 正常响应与 error-after-frame 分开记录 |
| O-9 continuation×gap | **场景方向正确，mutation 设计不充分** | 四个场景覆盖有价值；但“同一文件任一测试红”不能证明交叉依赖 | 同一个交叉场景对 P4／P5 两个 mutation 分别红，并有单侧 controls，见前述发现 |

## 四个已声明停点的裁决

1. **P3.1 谁调用 `allocateRealBlock`**：该停点合理，但问题应更早在计划期冻结，因为它决定 C5 的 owner 与 S1/S2/S3 接线。当前计划连可执行 serializer API 都未定义，不能把整个所有权问题留到实现期才发现。建议修订 plan 后消除该分叉，或至少在 P2 PoC 后、进入 P3 前形成明确决策记录。
2. **P4.3 删除 `continuationOffset` 后跨格式破坏**：停下合理；不过现码只在 Anthropic handler 构造 `ContinuationHooks`，计划举的 Responses／CC continuation 测试更多是未来／合同核实。先用 grep 与测试确认真实消费者，再决定是否是真分叉，不能为了兼容不存在的消费者保留双权威。
3. **P6.2 终局 freeze／close**：停下合理。`freezeHeartbeat` 可恢复、`close` 永久的方向已有既有接口注释支撑；真正需要现场核的是 raw sink 与 delivery sink 的 `close()` 是否还会关闭写通道。若副作用不同，应引入窄的永久停 heartbeat primitive，而不是复用语义过宽的 close。
4. **P8.4 ADR D2 草案**：该停点必要，但位置太晚；必须在写 ADR 前停，见 major。

**遗漏的停点**：P7.2 若 α 不可行而要选择 β 载体，必须停下；β 改变客户端可见协议与冻结 carrier，不应由 executor 自行拍板。

## 完整性与“交给 P8.7”审计

- 冻结设计的 8 项承重项均有具名 task；新增 P6 与 P5.4 也有独立 task，没有把这两项静默砍掉。
- P5.4 从 merged-state reviewer 备注升格为 red-first task是正确方向；P8.7 只复核覆盖，不代替实现测试，**这里没有滥用**。
- P8.7 仍合理保留四类合并态检查：三 remap 单一权威、跨 vendor C3、P6 终局路径、旧 `AnchorState` 语义残留。这些确属跨模块最终代码审，不应前移成只读计划推导。
- 但当前计划仍漏了具名的 **P2×P6 交叉 task**、S2/S3 的真实块分配 task、以及 O-2 完整协议平衡 oracle；这些不能靠 P8.7 兜底。
- P7 没有砍掉 FAIL 兜底，但其 β 分叉权限不当；需修订为显式停点。
- 文档后果已落成 P8.4／P8.5，方向完整；P8.5 的 grep 验收需按上文改为分类审计。

## 主观建议

- **[建议] `AnchorIndexAllocator` 命名** — 该对象实际分配真实块、anchor、continuation 的全部 wire index。预期影响：继续叫 Anchor allocator 会弱化“generation wire frontier 是唯一权威”的架构事实。推荐在实施时命名为 `GenerationWireIndexAllocator` 或 `WireBlockIndexAllocator`，anchor 只是其消费者；若保留旧导出名，至少在 P8 统一迁移而非长期双名。
- **[建议] P6 独立交付边界** — P6 可先行，但独立 merge 后应让 allocator worktree rebase／merge 到含 P6 的 master，再执行 P2。预期影响：避免在旧 heartbeat 生命周期上写竞态 oracle，合并后测试语义失效。


## 阻断性发现

### [blocker] README C3/C4、P1.4、P4.2 — `anchorsOpened===0` 无条件短路与“无 anchor 的 continuation 也由 frontier 接续”互相矛盾，正常 continuation 会复用 wire index 0

- 定位：`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc-plan/docs/plan/2026-07-27-inter-block-anchor-allocator/README.md:59-60,90-98`；`plan-1-allocator-state.md:91-143`；`plan-4-continuation-frontier.md:63-74`。
- 失败场景不需要任何 gap anchor：主腿交付 `real@0` 后被 cut，进入 continuation；continuation 上游 index 从 0 重启。P4 删除 `continuationOffset`，要求 allocator 分配其 wire@1；但 C3／`resolveRemappedFrame` 看到 `anchorsOpened()===0` 就**原 frame 引用直返**，结果仍发 `real@0`，与已交付块撞 index。
- 现有 P4.1 只构造“有 pre-anchor + gap-anchor”的撞车序列，完全漏掉默认、更常见的“零 anchor + continuation”分支。O-6 的 no-anchor 引用相等要求若被无条件推广到所有腿，恰好会把这个 bug 固化成合同。
- 这是冻结设计内部两项承重要求的冲突，不是实现者可自行选择的细节；按当前计划实施，核心 continuation 验收确定失败，故升级为 blocker。
- **修复建议**：回到架构层修订 C3。结构性短路的正确判据不能只是 `anchorsOpened===0`，而应是“当前块分配出的 wire index 与该腿 upstream index 相同／mapping identity”或“主腿、无任何 synthetic 插入且 frontier 未偏移”。无 anchor 主腿仍原对象直返，保证 O-6；无 anchor continuation 因 leg-local upstream index 重启且 assigned wire≠upstream，必须 remap。新增 red-first oracle：`real@0 → cut → continuation upstream@0 → wire@1`，并分别 mutation 掉 `onLegStart`、强制 `anchorsOpened===0` 短路，测试都应红。冻结设计／README C3、P1.4 及 O-6 的措辞须一起修订，不能只补一条测试。

## 最终结论

**存在 blocker，必须先修订；当前不可开工实施。**

- blocker：**1**
- major：**11**
- minor：**5**
- nit：**0**

最高优先级是先由 `gpt-souls:architect-advisor` 或原设计作者消解 C3 与 C4 的合同冲突，再由 planner 重写 allocator owner／DAG／oracle。该 blocker 未闭合前，继续细化实现步骤没有可执行的单一正确目标。
