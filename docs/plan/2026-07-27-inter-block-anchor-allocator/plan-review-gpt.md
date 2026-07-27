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


## 第二轮复审（commit `05b223c1`）

### 复审范围与已核证据

- 对照第一轮 1 blocker + 11 major + 5 minor，读取 `05b223c1` 对 README、P0–P8、kickoff 的完整修订。
- 再读生产代码的 `runResponseBufferedSink` retry／retreat 控制流、`makeDeliverySseSink`、`getDownstreamDeliverySession`、`makeReconcilingSink`，独立核验 planner 点名的 retreat／recovery 与 live 装饰器两处未知。
- 本轮未修改被审计划，未启动服务器，未触碰 4141。

### [major] C3 修订只对主腿／continuation 建模；transparent recovery 会把新的 leg-local mapping 与“上游 index 不重启”混在一起，当前 `beginLeg` 合同不完整

**问题**：把短路条件从 `anchorsOpened()===0` 改为 `realBlockOffset(i)===0`，对“已为当前腿分配过 mapping 的 frame”本身是正确的；零-anchor continuation blocker 因当前腿 mapping 为 upstream0→wire1 而闭合。但计划只在 continuation 时调用 `beginLeg()`，没有明确 transparent retry／recovery 的腿边界。

**代码事实**：`runResponseBufferedSink` 的 transparent retry 只在 `!committedAny` 时发生（`driver.ts:1408`），所以被丢弃 attempt 确实没有任何真实块写入／分配；frontier 仍是 0。此时 recovery upstream index 从 0 重启，**映射应仍是恒等 upstream0→wire0**，无需 `beginLeg()` 也能偶然正确。可一旦 recovery 之前出现过 synthetic pre-content anchor，它已真实写到 client wire、frontier=1，retry attempt 仍未提交真实块；recovery 首块 upstream0 应映到 wire1。若 allocator 当前 mapping 表沿用上一 attempt 的“当前腿”，而上一 attempt 没分配真实块，则 offset 可正确；但计划没有把“transparent recovery 是同一 client generation 的新 upstream round、是否调用 beginLeg、旧 attempt 是否可能留下未写 mapping”冻结成契约。

**C9 相关缺口**：P2 同时写 allocator 的 `allocateRealBlock()` 是同步“返回并已提交”，owner 又要求 write 失败不推进并允许“先写后 commit或回滚”。这意味着 owner 若在真正 write 前调用同步 allocate，就会产生 provisional mapping；失败回滚不仅要退 frontier，还要退**当前腿 mapping**。transparent recovery 正是会观察这类残留的路径。计划只断言“下次分配拿同一 index”，没有断言旧 mapping 被移除、`realBlockOffset` 不会命中失败块。

**建议**：在 C9/P2 增加 transaction 语义：allocation reservation 不能对 `realBlockOffset` 可见，直到同 operation 的 start 帧成功写出；失败必须同时回滚 frontier、anchor count、current-leg mapping、`openAnchorIndex`。新增 recovery oracle 两支：① 无 anchor 的 attempt0 在首块前截断→recovery upstream0→wire0，原对象恒等；② pre-content anchor@0 已写、attempt0 在首个真实块前截断→recovery upstream0→wire1。另加 write-failure mutation，断言失败 start 的 mapping 不可被后续 delta／recovery 查询。明确 transparent recovery 是否调用 `beginLeg()`；推荐将 `beginLeg(kind)` 对所有 upstream round 都调用，但由 allocator 根据“已成功写出的 frontier + 空 current mapping”得出同样结果，避免 continuation 特判。

**结论**：第一轮 blocker 的默认 zero-anchor continuation 分支已被正确识别并有 red-first oracle，但 C3/C9 在 recovery 维度尚未闭合，降为 major 而非原 blocker。

### [major] P2 owner API 目前无法按计划接入 `makeReconcilingSink`：WeakMap 只登记原 delivery sink，装饰器拿到的 inner 可查，但它没有 allocation port，且 `allocateAndWriteRealBlock` 会绕过 reconcile 的 close-before-real 输出

**问题**：planner 把 S3 分成“`makeReconcilingSink` 装饰器负责分配、`reconcileLiveFrame` 负责纯 remap”，方向对，但冻结 API 与当前装饰器形状不兼容。

**代码事实**：`makeDeliverySseSink` 返回 `delivery.clientSink`，`deliveryBySink` 只以这个原 sink 为 key。`makeReconcilingSink(inner, state, hooks)` 的 `inner` 正是原 delivery sink，因此装饰器**可以**通过 `getDownstreamDeliverySession(inner)` 找到 session——这条路可行，不需要让 wrapped sink 再注册一次。

**真正冲突**：`WireBlockAllocationPort.allocateAndWriteRealBlock(upstreamIndex, build)` 的合同是 owner 在 serializer 内“分配并写 already-remapped frames”。而 `reconcileLiveFrame` 对首个真实 start 可能返回 `[anchor_stop, remapped_start]`；anchor stop 必须走 `writeAnchor` 标 synthetic，real start 必须走普通 write。当前 build 只返回 `ReadonlyArray<ClientFrame>`，没有 provenance，owner 无法区分两帧该调用哪个底层 port。若装饰器先单独写 stop 再调 allocation port 写 start，又把 close-off 与 allocation 拆成两个 serializer operations，心跳可插入；若 build 内先调用纯 reconcile，它还需要“已经分配后的 mapping”，形成分配→reconcile→按不同 provenance 写出的事务。

**建议**：把 owner API 改成 transaction callback，而非“build 纯 frames”：例如 `withAllocatedRealBlock(upstreamIndex, ({wireIndex, remap}) => ReadonlyArray<DeliveryFrame>)`，callback 返回带 `syntheticKind` 的 `DeliveryFrame`，同一个 enqueue operation 按 provenance 写出 anchor stop + real start；或者提供专门 `allocateAndWriteReconciledRealBlock({upstreamIndex, closeAnchorIndex, realFrames})`。P3.3 必须写出如何取得 `getDownstreamDeliverySession(inner)`／allocation port，并有真实 live production-sink 测试证明 stop marker、frontier、delta/stop mapping 全正确。当前“若拿不到则停”不是可执行计划，S3 是冻结必做范围，需在开工前定型。



### [blocker] P3 的 red-first／mutation 场景依赖 P5 才会存在的 gap anchor，形成循环依赖；按当前 DAG 无法把三处 `+1` mutation 打红

**问题**：P3.1 明令“多 anchor 状态必须由真实 gap 静默驱动，禁止手工推进 allocator”；P3.2 同样要求“retreat 发生在 gap anchor 已开过一次之后”；S3 也要求 live 多 anchor。可是 P3 执行时 P5 尚未落地：`semanticBlockCount===0` 门仍在，per-gap latch 与 `makeGapAnchorInjector` 都不存在。生产 heartbeat 在首个真实块后只能 ping，**不可能**产生第二个 gap anchor，offset 永远最多是旧语义的 `+1`。

因此：

- 把 S1/S2/S3 resolver mutation 回硬编码 `1`，在 P3 可达的 pre-content-only 场景下结果完全相同，mutation 不会红；
- 计划要求“真实 gap 驱动”与相位硬链 `P3→P5` 互相否定；
- 若为让测试红而提前删 P5 的门，就会进入计划自己禁止的半坏态：gap anchor 已占 wire@2，但尚有 remap 站点仍算 `+1`。

这是实施计划不可执行的循环，不只是测试薄弱，故为 blocker。

**修复建议**：保留 `P3→P5`，但把 P3 的测试构造改为经 **P2 production owner API** 显式提交 anchor block（不是手工推进 allocator，也不依赖 heartbeat gate）：测试先经 `allocateAndWriteAnchor` 写 pre-anchor／第二 anchor，再驱动对应 S1/S2/S3 的真实 start/delta/stop，从而让 offset>1；另由 P5/O-3 单独证明 heartbeat 会调用同一 owner。这样 mutation 能在 P3 红，同时不提前开放 gap feature。若 owner API 无法作为测试 seam 驱动三腿，则必须把 P3 remap 三站点 + P5 gap 开门合成一个原子 commit，并在提交前一次性通过全部 oracle，不能维持当前分相。

### [major] P5.3 仍直接调用低阶 `allocateAnchor()`，与 C5/C9 和 P2 架构守卫正面冲突

P2 冻结“生产路径只能经 owner API，低阶 `allocateAnchor` 测试专用”，架构守卫也禁止 `delivery/session.ts`／injector 外调用裸分配；但 P5.3 的实现步骤仍写：`makeGapAnchorInjector`: `allocateAnchor() → writeAnchor() → writeKeepalive()`。这正是 P2 用整节否决的“队列外分配 + 两个 operation”，并且 write 第二帧失败时会留下已推进 frontier。

**建议**：P5.3 必须只调用 `WireBlockAllocationPort.allocateAndWriteAnchor`，由 callback 生成 start+delta 且带 provenance；成功后再以同一 transaction 的结果更新 `openAnchorIndex`。将“直接 allocate”加入架构守卫 mutation，防止计划后半自己绕过 P2。

### [major] `WireBlockAllocationPort.beginLeg()` 不在 serializer 内，且 C9 没定义并发／失败时 leg 切换的原子性

接口注释称全部 owner 操作绑定 serializer，但 `beginLeg(): void` 是同步裸方法。continuation dispatch 完成时 driver 可调用它，与已排队的 heartbeat anchor operation／前一 leg 最后一批 write 的相对顺序没有合同。若 `beginLeg` 先切 current mapping、前一 leg 的排队 delta/stop 随后查询 mapping，就可能查到新腿；若 anchor operation先入队但后执行，leg base 与预期也可能漂移。

**建议**：`beginLeg` 也必须是 serializer command（`Promise<void>`），并在前一 leg 所有成功 wire writes 之后、下一 leg 任一分配之前建立 fence。最好让 owner API 不暴露可变“current leg”全局查询，而让每次 allocation 返回不可变 `BlockMapping`／leg token，delta/stop 按 token 查，消除跨 await 的 ambient current-leg 状态。增加让 continuation leg 切换与在飞 heartbeat／前腿 stop 交错的时序 oracle。

### O-2／O-7／O-9 抽验结论

- **O-2：已闭合。** 新 `assertBlockProtocolState` 明确检查 delta／stop 必须指向当前唯一 open index、stop 后清空、终局无悬挂；`start@1 + delta@0`、`start@1 + stop@0` 等独立负样本正好能咬住第一轮指出的坏实现。重复 stop 也覆盖。
- **O-7：原 oracle 假绿判断成立，新设计基本闭合。** 仓库 `anthropic-cli.e2e.test.ts` 的确把 `num_turns>1` 作为 stall 签名。新 oracle 用固定 tool_use id、匹配 tool_result、上游命中恰为 2、最终 marker 非空／无第三轮，能区分正常工具回合与空转重问；绕过 sanitize + 400 mutation 能证明空块泄漏会红。它诚实限定为 mock 上游，不冒充真 GHC 接受性，后者登记 backlog，合理。
- **O-9：已闭合。** 修订要求同一条“主腿 gap + 续写腿 gap + index 重启”测试分别对删除 `beginLeg` 与删除 latch re-arm 以可辨识不同原因失败，并保留 P4.1／P5.1 单侧 controls；这比“同一文件任一测试红”有实质提升。

### [minor] P1 的“三个 commit”收口与单独 bridge commit 仍不一致

P1 定义 U1/U2/U3 三个 commit，但 bridge 小节又单列 `test(anchor): bridge invariant…` 提交；收口却要求“恰好三个 commit”。按文字执行会得到四个 commit，或把 bridge 偷塞进某个已定义单元。

**建议**：明确 bridge 属于 U2（最自然：它验证 U2 的 pre-content allocation 接线），删独立提交；或把收口改为四个 commit。commit invariant 不应靠执行者猜。

### [minor] P1.1 仍把 `anchorsOpened` 命名／提交描述成“short-circuit predicate”，与修订后的 C3 相反

P1.1 测试名是 `anchorsOpened is the structural short-circuit predicate`，旧的 Step 5 commit 也写 `expose anchorsOpened as ... short-circuit predicate`，虽 U1 最终提交描述已改为 counter。此残留会误导实现者与未来读者，甚至违反新增架构守卫的意图。

**建议**：统一改成 diagnostic counter，删除全部“short-circuit predicate”残留。

### [major] spec 状态同步被放在 P8，但计划自己要求“plan 合并／开工之前”完成，时序仍不可执行

P8.4b 正确识别 spec 状态“待用户裁决”与计划“已冻结选 A”矛盾，也明确写必须在 plan 合并／开工前闭合；但 task 仍位于实施末尾 P8，DAG 没有 preflight 节点。执行到 P8 才改已经太晚。

**建议**：把状态同步移到计划定稿提交本身或 P0.0 的第一步，并作为开工硬门；P8.6 只负责“已实施 commit”注解。ADR 8.4 的写前停点与 P7.2 β 停点则已正确前移／补齐。

### [minor] P8 验收记录标签仍保留旧 oracle 名，可能诱导按弱判据收口

P8.8 已改为 O-1～O-9，但表中仍写 `O-2 maxOpen===1` 与 `O-7 真 CC numTurns>=2`。这与已升级的完整协议状态机及 exact tool-use oracle冲突。

**建议**：标签同步为 `O-2 块协议状态完整性`、`O-7 exact tool-use/tool_result 两轮回传`。同理 README Mermaid 的 P1 节点仍写 `anchorsOpened 结构性短路`，应改为 mapping-identity short circuit。



### 其余第一轮发现闭合抽验

- **DAG**：`P6→P2`、`P2→P3`、主链全串行已补；P2.2b 覆盖 P6 让 heartbeat 复活后新增的可达竞态，闭合到位。但 P3↔P5 的测试构造循环形成了本轮新 blocker。
- **P6 Responses HTTP**：6.3b 仍保留端点专属回归锁；CC 正常响应结构性幸免的措辞已限缩，闭合。
- **P1 U1/U2/U3**：原类型／owner 次序矛盾已大体消除，U2 把 allocator 挂 state 与 injector 取 index合并；仅剩 bridge commit 计数与命名残留两项 minor。
- **AnchorState**：删除 `anchorClosed` + `anchorBlockOpen`，由 `openAnchorIndex` 单一承担当前 anchor 与 close exactly-once，并要求终局调用者组合测试，方向闭合。若以后确需 terminal flag，计划要求另命名并补写者／读者，合理。
- **ADR 与 β 停点**：ADR 写文件前停、未获批不得文档收口；P7.2 α 可执行、β 改 carrier 必须回用户裁决，均闭合。
- **Q5 文档后果**：已从字面零 grep 改为宽 pattern + 历史／规范性分类审计，且要求同步正文表／公式／示例，闭合。
- **C8**：改为 implementation base 的 pre-change bytes，历史 SHA 只作 provenance，并保留 raw bytes 用 `cmp`；闭合。

### 第二轮总体 verdict

**存在 blocker，当前仍不可开工实施；需先修订。**

- blocker：**1**
- major：**6**
- minor：**4**
- nit：**0**

本轮 blocker 是 P3 测试构造依赖 P5 才开放的 gap anchor，导致 `P3→P5` DAG 下 red-first 与 6 格 mutation 矩阵不可执行。第一轮的 zero-anchor continuation blocker本身已按正确方向修复，但 recovery transaction 与 live decorator owner API 仍有 major。

**开工前最小必改集**：

1. 用 P2 production owner API 在 P3 测试中显式写第二 anchor，或把 P3+P5 合成原子提交，消除循环依赖。
2. 将 `WireBlockAllocationPort` 改成能在一个 serializer transaction 内输出带 provenance 的 close-off + real start，并明确 `makeReconcilingSink` 如何取得 port。
3. 冻结 recovery／write-failure 的 transaction mapping rollback，`beginLeg` 也进入 serializer fence或改用不可变 leg token。
4. P5.3 禁止裸 `allocateAnchor()`，只走 owner API。
5. 修正 spec 状态同步的时序，随后清理四项 minor。

修订后可继续第三轮复审；在上述 blocker 未闭合前，不建议启动实现。


## 第三轮复审（commit `5f82fa33`）

### 复审范围与证据

- 对照第二轮 1 blocker + 6 major + 4 minor，读取 `5f82fa33` 对 README、P0–P5、P8、kickoff 的修订。
- 独立下钻当前生产实现：`delivery/session.ts` 的 serializer／`writeToSink`／私有 envelope builders，`frame-envelope.ts` 的 `DeliveryFrame` 必填元数据，`makeDeliverySseSink` 的 session 归属，`makeReconcilingSink` 的双帧 close-off，以及 driver 的 buffered／recovery 控制流。
- 未启动服务器，未触碰 4141。

### [blocker] C9 要求“多帧写失败则全量回滚、frontier 不推进”在真实 wire 上不可实现，会在部分写成功时复用已可见 index

**位置**：README C9；P2 Interfaces:47-81、Task 2.2c。

**问题**：`allocateAndWriteAnchor` 一次 transaction 写 `start + delta`；S3 的 `withAllocatedRealBlock` 可能写 `anchor_stop + real_start`。serializer 只能保证**不交错**，不能让两次底层 SSE write 具有数据库式原子性。当前 `writeToSink` 对数组中的帧仍会逐个 `await`：第一帧可能已成功到达客户端，第二帧才抛错。

失败例：

1. owner 预留 wire@2；
2. `anchor_start@2` 写成功，客户端已看到 open block@2；
3. `keepalive_delta@2` 写失败；
4. C9 要求回滚 frontier、anchor count、mapping、`openAnchorIndex`；
5. 若请求仍有后续动作，下次分配会复用 wire@2，和客户端已见的 start 撞车。即使客户端已断开，也不能声称“nothing was written”。

S3 同理：`anchor_stop` 成功、real start 失败时，close-off 已不可撤销。回滚内存状态不能撤销 wire。计划把“单 serializer operation”误写成“写出要么全部发生、要么全部不发生”，这是物理上不成立的合同。

**修复建议**：按外部副作用的 commit point 重写 C9：

- session 在 operation 开始前拒绝时，不分配；
- reservation 对其它操作不可见；
- **第一帧开始写出前**提交／永久消费 index；一旦任一 wire write 被尝试或成功，失败时绝不回滚到可复用状态，而是终止该 delivery，保留 consumed frontier 与能反映已尝试输出的状态；
- 多帧 operation 的后续帧失败属于 partial delivery，必须返回 `write-error/client-abort` 并禁止继续分配，不能承诺无洞；
- rollback 只允许发生在 callback/build 抛错或 session 拒绝等**尚未产生任何外部 write**的阶段。

测试需覆盖“build 失败前零副作用”“第一帧 write 失败”“第一帧成功、第二帧失败”三档，并断言后两档 delivery 终止且 index 永不复用。C1 的“永不跳号”应限定为成功交付的健康流；失败终止流不能拿复用 index 来伪造连续。

### [blocker] P3 用 owner API 造第二 anchor 仍依赖 P5 才会落地的多-anchor close 状态机；在 P3 阶段第二 anchor 无法由生产 close-before-real 正确关闭

**位置**：P3:11-37、Task 3.1–3.3；P5 AnchorState 状态机与 Task 5.2。

**问题**：改为直接调用生产 `allocateAndWriteAnchor`，确实解决了“谁触发 anchor”不必等待 heartbeat 的一半循环，而且 anchor 绕 buffer 本身与生产语义一致，不会单纯因为 driver buffer 存在就冲突。但它没有解决**第二个 anchor 如何关闭**：

- P3 的合法序列要求 `anchor@0 → real@1 → anchor@2 → real@3`，每个 anchor 都 start→stop，才能满足 O-2。
- 当前代码的 `anchorClosed` 是 generation 一次性 guard；第一个 anchor 在 real@1 前关闭后变 true，第二个 anchor 到来时生产 close-before-real 会短路。
- 删除 `anchorClosed/anchorBlockOpen`、改成可重复 `openAnchorIndex: undefined→index→undefined` 的状态机明确排在 **P5 Task 5.2**。
- P2 文档虽在 C9 中提到回滚 `openAnchorIndex`，但没有把 AnchorState 字段迁移列入 P2 files／tasks；P5 仍声明自己才新增该字段、删除旧字段。

所以 P3 测试若不手工关第二 anchor，O-2 会在 remap 前就因 coexist／悬挂而红；若测试手工写 stop，又替 P5 的生产 close 实现完成了承重动作，重新引入假绿。P3 的 6 格 mutation 无法获得干净、可归因的红绿门。

**修复建议**：把 `openAnchorIndex` 状态机迁移与通用 close transaction 前移到 P2 owner（它本就是 anchor allocation 的 owner），P3 只消费已具备多-anchor生命周期的 port；P5 仅负责 heartbeat 门与 per-gap latch。或者按计划退路将 P3+P5 合成原子 commit并停下回报。当前“不切相位，只换测试触发”仍未闭合第二轮 blocker。



### [major] `DeliveryFrame` 在 S3 装饰器侧类型上可构造，但拿不到权威 metadata；让装饰器伪造 envelope 会把 provenance 责任放错层

**位置**：P2 `withAllocatedRealBlock`；P3 S3 专节。

独立核验结果：`DeliveryFrame` 是 `ClientFrameEnvelope`，必填 `sequence`、`observedAtMonotonic`、`provenance`。公开的 `createClientFrameEnvelope` 能在类型上构造它，所以不是“完全不可构造”；但当前真实构造逻辑 `makeEnvelope`／`asDeliveryFrame` 都是 `delivery/session.ts` 私有函数。`makeReconcilingSink` 当前只收到裸 `ClientFrame`，没有 candidate id、dispatch id、sequence，也不拥有 delivery 的 `monotonicNow`。

若装饰器自己填 `sequence:0`、`observedAtMonotonic:0/performance.now()`、`candidateId:'legacy'`，虽然模仿当前 `asDeliveryFrame` 能跑，却违反 richest-data-flow：owner 本来拥有 monotonic clock与 envelope 路由，装饰器不该伪造元数据。尤其 synthetic anchor stop 与 real start 的 provenance 必须正确区分。

**建议**：callback 不返回完整 `DeliveryFrame`，改返回窄的、由 owner 定义的 discriminated write spec，例如 `{ frame, kind: 'real'|'anchor'|'keepalive' }`；delivery session 在内部用私有 builder补 `observedAtMonotonic`／provenance并写出。或者 port 向 callback 暴露 `envelope.real(frame)`／`envelope.synthetic(kind, frame)` factory，metadata仍由 owner生成。P3 S3 的测试要断言 forwarded synthetic marker与 generation envelope provenance，而不只看 wire bytes。

### [major] delivery session 被指定为唯一 allocator owner，但计划没有说明同一个 `GenerationWireIndexAllocator`／`openAnchorIndex` 如何注入 session

P1 把 allocator 放在 handler-owned `AnchorState`，要求 driver、injector、live reconcile共享同一实例。P2 又让 `createDownstreamDeliverySession` 的 port成为唯一分配 owner，但当前 session construction options只有 raw sink、clock、heartbeat；`makeDeliverySseSink` 建 session 时没有 allocator／AnchorState。冻结 port 方法也不收 allocator参数。

C9甚至要求 session transaction回滚 `openAnchorIndex`，但该字段属于 P5 才定义的 `AnchorState`，session 当前不可见它。没有显式 wiring，实施者只能新建第二 allocator、闭包偷取 handler state、或扩大 ambient singleton，都会破坏 generation 唯一权威。

**建议**：在 P1/P2 接口图中冻结 dependency injection：`makeDeliverySseSink` 接收一个 generation wire-state owner（allocator + openAnchor 状态），传给 `createDownstreamDeliverySession`；handler只创建一次，AnchorState和delivery port引用同一对象。相应补 files：`client-sink.ts`、`handler-v4.ts`、delivery options types；identity oracle必须断言 session port、driver与live decorator读的是同一 allocator/state引用。若把 `openAnchorIndex` 前移到 P2，这个 wire-state owner也自然成为其SSOT。

### 已闭合项抽验

- **recovery**：所有 upstream round统一走 serialized `beginLeg(kind)`，两支 recovery oracle覆盖“无 anchor→wire0恒等”和“anchor@0已写→wire1 remap”，并增加仅漏 recovery beginLeg 的 mutation；方向正确。不可变 mapping token比 ambient current-leg查询更稳健。
- **beginLeg fence**：已改为 serializer command并有前腿排队帧／heartbeat两种交错 oracle，闭合第二轮对应 major。
- **P5.3 裸分配**：正文已改成只调 port，并有改回裸 `allocateAnchor` 的架构守卫 mutation；闭合。
- **spec 状态**：已前移 P0.0 Step A 作为开工硬门；闭合。
- **四项 minor**：U2吸收 bridge commit、`anchorsOpened` 统一为诊断 counter、README/P8 oracle标签、Mermaid命名均已修订，未重开。

### P3 直接 owner-trigger anchor 的论证裁决

“测试只建立前置 wire 状态，真实块 allocation+remap 仍走生产路径”这一分层原则**本身成立**，不是手工篡改 allocator，也能让硬编码 `+1` mutation有理论红点。anchor绕 buffer，若调用发生在 boundary flush之后、下一块到来之前，driver buffer为空，owner operation与driver flush共享serializer，因此**不会天然与 buffer 冲突**。

但该方案只有在 **P2 已同时提供可重复 anchor 的 open/close状态机** 时才可执行。当前状态机仍在P5，导致第二anchor无法生产关闭，故本轮 blocker不是触发方式思想错误，而是前置能力相位放置不完整。

### 第三轮总体 verdict

**存在 blocker，当前不可开工实施；需先修订。**

- blocker：**2**
- major：**2**
- minor：**0**
- nit：**0**

开工前必须：

1. 重写C9为符合不可逆wire副作用的commit语义，禁止部分写失败后回滚并复用index。
2. 将`openAnchorIndex`与通用多-anchor close transaction前移到P2 owner，或执行已记录的P3+P5原子合并停点。
3. 冻结handler→delivery session的同一allocator/state注入路径。
4. 让S3 callback返回owner可封装的write spec/factory，而不是由装饰器伪造`DeliveryFrame` metadata。

上述闭合后，P3 owner-trigger测试法可保留；本轮其余修订无需重开。


## 第四轮复审（commit `d7638fd1`）

### 复审范围与证据

- 对照第三轮 2 blocker + 2 major，读取 `d7638fd1` 对 README、P2、P3M、原 P4/P5 子计划、kickoff 的完整修订。
- 独立核验当前代码的 `writeToSink` 多帧逐个 await、`streamSSE` 两处 sink 构造时点、8 个 handler close 调用与 driver 内部 close、`DeliveryFrame` 私有 builder、`deliveryBySink` 可达路径。
- 未启动服务器，未触碰 4141。

### [blocker] M1 没有可执行的 owner close API；“终局站点改经 owner 关闭”只写在结论里，接口与 task 均缺失

**位置**：P3M M1；P5 AnchorState/Task 5.2；P2 `WireBlockAllocationPort`。

planner 点名的可达性问题经代码复核后，结论分两部分：

1. **所有现有 handler close 调用都发生在 sink 已构造之后**。两条 stream 路径都先 `makeAnchoredSseSink`，随后闭包／pump 内调用 `closeAnchorIfOpen`；driver 的内部 close 也持有 sink。故“某些分支 sink 尚未构造”这一担忧没有坐实。
2. **但持有 sink 不等于计划已提供 owner close 能力**。冻结的 `WireBlockAllocationPort` 只有 `allocateAndWriteAnchor`、`withAllocatedRealBlock`、`beginLeg`，没有 `closeOpenAnchor`／terminal-close method。M1 只在表格中写“通用多-anchor close transaction前移进 owner”，P5 Task 5.2 仍要求各站点直接读写 `openAnchorIndex` 并调用旧 `closeAnchorIfOpen`，没有说明如何从 sink 取 port、如何在 serializer 内原子做 `openAnchorIndex→undefined + write anchor stop`、以及 terminal close 与 P6 heartbeat永久停止如何排序。

这会让实现者只能：继续在 owner 外直接写 stop（破坏唯一 owner／serializer合同），或临时发明新 API。M1 是 M2 测试可满足的硬前提，接口缺失意味着 P3M 仍不可执行。

**修复建议**：在 P2 interface正式加入例如：

```ts
closeOpenAnchor(buildStop: (index: number, envelope: WireEnvelopeFactory) => WireWriteSpec, mode: "before-real" | "terminal"): Promise<"closed" | "none" | "write-error">
```

由 session serializer 内读取同一个 `GenerationWireState.openAnchorIndex`、生成正确 index 的 stop、按 anchor provenance 写出、在 commit point后永久消费状态，并提供幂等 exactly-once。`terminal` 模式还要与 P6 的永久 heartbeat stop 合成一个 owner command，避免 stop 与新 tick 交错。P5 Task 5.2 应改成逐站点“取得 port→调用 close API”，并增加架构守卫禁止生产代码在 owner 外写 `openAnchorIndex`。既然 sink 已构造，各 handler site 可通过 `getDownstreamDeliverySession(sink)` 取得 port；driver内部直接持 port即可。

### [major] C9 两段边界基本正确，但“write 已入队、尚未执行/await”与 abort 中途状态必须由 serializer command 的开始点明确归类

C9 从不可实现的“多帧全原子回滚”改成“首次外部 write 前可回滚，之后永久消费并终止”，方向正确，三档 oracle和双向 mutation也能咬住主要反例。

仍需精确化两个状态：

- **operation 已 enqueue，但尚未开始执行**：此时还没有 reservation，若 session 在排队期间进入 terminating/closed，operation开始时应重新检查并按“session拒绝、零分配”处理；不能在 enqueue调用时先 reserve。
- **operation执行中收到 abort**：若 abort 在首个底层 write调用前被观察，属于pre-commit全回滚；若底层 write已调用但promise尚未settle，按计划的“已尝试”应视为post-commit，index永久消费。即 commit flag必须在调用 `writeToSink` **之前同步置位**，不是 await成功之后。

建议在Task 2.2c补两条时序oracle：queued operation等待期间session terminate；首帧write返回pending promise期间触发abort。分别断言前者零分配、后者永久消费+delivery终止。否则“两段”定义虽对，执行边界仍可能被写错。



### [blocker] M1 删除旧状态字段后，M2–M4 尚未迁移的 `+1` 分支没有可编译／等价的 bridge，“半坏窗口为空”证明缺少前提

**位置**：P3M:36-53；P5 M1 状态机。

P3M 证明假设 M2–M4 期间“未迁移腿仍走旧硬编码分支：有 anchor→+1，无 anchor→+0”，所以与 frontier数值等价。但 M1 明确先删除 `anchorBlockOpen` 与 `anchorClosed`，而现有 S1/S2/S3 的旧门分别直接读取这些字段：

- driver S1/S2：`injected && anchor && anchorBlockOpen ? anchor.remap(...,1) : frame`；
- live reconcile：`if (!state.anchorBlockOpen) return [frame]`，之后 `!state.anchorClosed` 控 close。

M1 后 S2/S3 还没到 M3/M4，却已经失去旧分支的判据；按“类型系统逼出全站点”会立即编译红。若为了编译顺手把 S2/S3 改成新状态／resolver，就提前做了M3/M4；若只改成 `openAnchorIndex !== undefined`，在pre-anchor已关闭后该值是undefined，却真实块仍须永久整体+1，数值不等价。`openAnchorIndex`只表示当前open，不表示历史保留的wire shift。

因此“半坏窗口为空”并非错误地估算了值，而是**M1→M4之间缺少一个明确的兼容判据**。M1本身的typecheck/test:fast门不可满足，八commit序列不可执行。

**修复建议**：M1必须同时引入一个只服务迁移期、可证明等价的 bridge，例如旧站点在未迁移前用 `wireState.allocator.anchorsOpened() > 0 ? remap(frame,1) : frame`（生产开门前anchor count∈{0,1}），且 close用owner `closeOpenAnchor`；每迁完一腿立即删除该腿bridge，M4后全仓bridge零命中。把bridge写入M1内容、架构守卫、每commit grep和O-6。更干净的选择是M1+M2–M4合成一个原子commit；不能保持当前“删字段但旧站点继续读”的描述。

### [major] P2.2 的旧测试断言仍与新C9冲突

Task 2.2仍保留测试名“a write failure does NOT advance the frontier”，注释要求“下一次分配拿到同一个index、wire无空洞”。新C9明确第一帧write失败已经跨commit point，index必须永久消费并终止delivery。这条旧测试会要求与2.2c档2完全相反的结果，计划执行必红。

**建议**：删除或改写为两个精确测试：session/build拒绝前不推进；首次write尝试失败后永久消费且拒绝后续分配。P2收口的“C9有测试：write失败不推进frontier”也要同步改成两段语义。

### [major] P3M M2/M3 的“mapping token供delta/stop查询”没有定义存放位置，S1/S2逐帧路径可能无法找到正确block token

计划正确规定delta/stop不分配、按不可变`WireBlockMapping` token remap，但当前三腿输入只有frame上的upstream index，接口没有说明成功start后mapping存在哪里、如何在同腿后续delta/stop按upstream index取token、stop后何时释放。若只是把mapping放回allocator的ambient current-leg map，就退回前轮明确否决的全局查询；若存driver局部Map，retreat前后与buffered→live切换必须共享；live decorator也需自己的active mappings。

这在parallel/coexist upstream indices尤其承重：不能只保存“current mapping”单槽。建议冻结generation wire state中的`Map<LegToken, Map<upstreamIndex, WireBlockMapping>>`或每腿active map，start成功commit后登记、delta/stop精确查询、stop成功后删除；retreat沿用同一leg map。补两块并存／交错delta的测试，以及missing mapping必须显式报错而非原样透传。否则M2–M4虽能处理start，后续帧仍可能留旧index。

### WireWriteSpec／唯一wireState抽验

- `WireWriteSpec`让caller只给`real|anchor|keepalive`，owner内部铸造`DeliveryFrame`，正确解决了装饰器拿不到sequence/time/provenance的问题；方向闭合。
- handler唯一创建`GenerationWireState`并同时注入AnchorState与delivery session，配四处引用identity oracle及唯一factory调用守卫，闭合第三轮注入空洞。
- 但owner给`real`铸造candidate/dispatch provenance时仍需沿用当前生产语义；若只能填legacy，至少应明确这是既有行为而非伪称保留了未知id。此项不阻断本计划。



### 已闭合项与第四轮结论

- **C9 根本方向**：commit point前后两段语义正确，三档oracle + 双向mutation覆盖主干；只需补queued/abort边界并清掉旧相反测试。
- **P3M合并决策**：把三腿、continuation、anchor生命周期放同一相位是正确的；M6晚于M2–M4也确实是多-anchor生产开门的硬序。但M1删除旧字段后的bridge缺失，使当前八commit序列仍不可执行。
- **终局port可达性**：handler现有8个close调用与driver内部close均在sink构造后，port可通过sink/session取得；“早期分支拿不到sink”未坐实。真正缺的是正式close owner API和逐站点接线task。
- **WireWriteSpec / wireState注入**：两项第三轮major已实质闭合。
- 前三轮已确认的recovery、serialized beginLeg、P5 owner-only、spec硬门、O-2/O-7/O-9不重开。

### 第四轮总体 verdict

**存在 blocker，当前不可开工实施；需先修订。**

- blocker：**2**
- major：**4**
- minor：**0**
- nit：**0**

开工前必改：

1. 为owner正式定义并测试`closeOpenAnchor`／terminal close API，逐个迁移handler与driver终局站点。
2. 给M1→M4增加可编译且数值等价的迁移bridge，或合并M1+M2–M4原子commit。
3. 完善C9 queued/abort边界，删掉P2.2与新语义相反的旧测试／收口文案。
4. 冻结mapping token的登记、按leg+upstream index查询、stop释放及retreat共享策略。

上述闭合后，P3M的整体分相与M6硬序可保留；无需推翻已确认的oracle与文档后果。


## 第五轮复审（commit `f15b161c`）

### 复审范围与证据

- 对照第四轮 2 blocker + 4 major，读取 `f15b161c` 对 README、P2、P3M、P5、kickoff 的完整修订。
- 独立核验 bridge 引用的现有字段语义、`empty_text`／`enveloped_ping` injector 状态转移、8 个 handler + 2 个 driver terminal close 站点、winner delivery candidate context、retreat 的 leg 连续性。
- 未启动服务器，未触碰 4141。

### M1 bridge 穷尽性裁决

在**健康生产流、M6 尚未开门**的限定下，planner 列的三类等价关系基本穷尽：

1. 从未开 content anchor：`anchorsOpened=0`，旧门 false，均 `+0`；这包含普通 ping、尚未触发 idle、以及虽构建 hooks 但未注入的请求。
2. 真 empty-text anchor 曾开过：`anchorsOpened=1`；现有 `anchorBlockOpen` 的契约是“一旦置 true，anchor close 后仍保持 true，index 0 永久保留”，所以即使处于“anchor 已 close”的窗口，旧 remap 门仍 true，bridge仍 `+1`。这就是调用方要求核的“第四种窗口”，它没有推翻等价性，但必须在双写契约中明确保留这种**历史标志**语义。
3. `enveloped_ping`：`injected=true`、`anchorBlockOpen=false`、没有 content anchor allocation，故 count0／旧门false，均`+0`。

其它组合如 `injected=false && anchorBlockOpen=true` 在现有正常 injector中不可达；若发生只能是写失败／状态撕裂，应由C9终止delivery，不属于继续生产的健康流。故bridge算法本身可接受，我也认同用短生命周期bridge保留逐腿mutation可归因性，优于把M1+M2–M4压成一个巨型commit。

### [major] M1“owner双写旧字段”的精确状态转移与唯一写者守卫仍未冻结，存在bridge与旧门分岔的现实入口

**位置**：P3M M1 bridge；P1/P2 injector迁移。

计划只写owner在open/close时“一并维护”`anchorBlockOpen/anchorClosed`，但没有把兼容语义写成表：

- 第一次/后续anchor open：`anchorBlockOpen=true`，且为了让旧close guard可重复工作，`anchorClosed`必须重置为false；
- close：`anchorClosed=true`，但`anchorBlockOpen`必须继续保持true（历史shift标志），不能随`openAnchorIndex`清成false；
- envelope-only：两字段都不得被content owner点亮。

更关键的是，当前`makeSyntheticAnchorInjector`会在首个await前直接写`injected/anchorBlockOpen`。P2虽说injector改调owner API，却没有架构守卫禁止它或其它旧站点继续写这两个legacy字段。若injector先置`anchorBlockOpen=true`而owner reservation在pre-commit失败回滚，bridge看`anchorsOpened=0`给+0，旧S1门看legacy true给+1，正好产生迁移期分岔。

**建议**：M1增加明确双写转移表和唯一写者守卫：除delivery owner外，生产代码不得赋值`anchorBlockOpen/anchorClosed`；injector只管理message-envelope状态，content-anchor历史字段由owner在commit point同步维护。补mutation：在owner外提前置legacy true后让build失败，断言bridge与旧门不会分岔；后续anchor reopen必须把`anchorClosed`重置、close后`anchorBlockOpen`仍true。M5再统一删除。

### owner close API 抽验

`closeOpenAnchor`的形状已闭合第四轮blocker：serializer内读SSOT index、按真实index生成anchor stop、幂等返回`none`，terminal模式与永久heartbeat stop同command。10个terminal站点逐一列出，flush/retreat/live close-before-real另列，且现码确认所有handler调用均在sink构造之后，port可达。

仍应注意：terminal stop的write一旦进入commit point后失败，按C9必须保留index consumed并终止；不能先清`openAnchorIndex`后将write失败误报为成功closed。该行为可由已有C9+exactly-once测试组合覆盖，不另列发现。



### C9／C10 抽验

- **C9 queued／pending约束可实现且闭合**：reservation延迟到serializer operation真正执行，执行时重查session；在调用`writeToSink`前同步置commit flag，promise pending期间abort自然属于post-commit。新增两条时序oracle能分别咬住错误边界。P2.2旧冲突测试也已拆成pre/post两条。
- **C10四点自洽**：generation-owned `Map<LegToken, Map<upstreamIndex, Mapping>>`支持同腿并存块；start成功commit后登记、stop成功后释放；retreat不换leg，S1登记的token可供S2继续查；missing mapping显式报错避免静默旧index透传。该模型与parallel tool calls／retreat共享需求匹配。

### [major] C10只有数据结构合同，没有冻结非-start帧通过owner查询／写出／释放的API，容易绕开serializer与candidate provenance

当前port只定义“start时分配并写”与close anchor，没有诸如`writeMappedBlockFrame(leg, frame)`。P3仍写“非start帧走普通write路径，按mapping查”，但谁查Map、谁调用`mapping.remap`、stop成功后谁删除条目并未落到接口。若driver／decorator直接读取`GenerationWireState.blockMappings`，就破坏owner唯一写者与serializer内释放；若先remap再`sink.write`，stop write失败时mapping是否释放也容易写反。

**建议**：把C10落实为owner API，例如：

```ts
writeMappedBlockFrame(leg: LegToken, upstreamIndex: number, frame: ClientFrame): Promise<"written"|"write-error">
```

owner在serializer内查token、显式missing报错、remap、按real provenance写出；仅在stop成功后删除mapping，失败则按C9终止且保留诊断状态。S1/S2/S3全部调用同一接口；架构守卫禁止owner外读写blockMappings。增加同腿两块交错delta/stop、retreat跨阶段、stop失败不提前释放三组测试。

### provenance核验

当前driver**有现成真实上下文**：`generation.bindings.get(current)`可得`CoordinatedCandidate`，其`candidate`与`dispatch`均真实存在；`CandidateResponseSession`也公开这两个handle。现有`delivery.writeWinnerFrame(String(candidate), frame)`只传candidate，`asDeliveryFrame`才退化成`candidateId:"legacy", dispatchId:"legacy"`——这是既有兼容路径，不代表真实id不可得。

因此，照旧填legacy是“保持当前退化行为”，诚实但不是richest-data-flow最优。既然此次正在重做所有real block写入owner，且项目要求最丰富数据流，推荐`WireWriteSpec.real`携可选/必填candidate+dispatch context，由driver S1/S2从当前binding传入，S3从candidate response session或装饰器构造时注入的context取得；确实仅兼容helper无binding时才标`legacy`并显式synthetic/compat来源。计划当前只说owner铸造provenance，却没规定输入真实id来源，属于major而非阻断。

### 第五轮总体 verdict

**未发现 blocker；修复 major 后可开工实施。**

- blocker：**0**
- major：**3**
- minor：**0**
- nit：**0**

三项major：

1. M1 bridge迁移期双写缺精确状态转移表与legacy字段唯一写者守卫。
2. C10缺owner-owned非start mapped-write／stop释放API。
3. real provenance已有真实candidate/dispatch来源，计划尚未接入，不能只笼统“owner铸造”或无条件沿用legacy。

owner close API、M1 bridge算法本身、C9边界、C10数据模型及逐站点迁移均已闭合前轮blocker。上述三项属于接口完整性修订，不再要求推翻P3M或合并M1–M4；修订后计划可进入实施。
