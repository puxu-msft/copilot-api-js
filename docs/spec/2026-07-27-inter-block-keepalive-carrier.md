# Inter-block >300s keepalive carrier 对比设计

- 状态：设计候选，待异模型评审与用户裁决
- 日期：2026-07-27
- 关联根因：[client↔proxy keepalive 300s](../todo/2026-07-22-client-proxy-keepalive-300s.md)
- 关联 ADR：[续写重试 + 顺序输出](../decisions/2026-07-22-continuation-retry-sequential-anchor.md)
- 前置事实：commit `131ea3b2` 已修空 `text_delta` 吞帧；commit `faaa37e7` 已修同族空 `input_json_delta` 吞帧并建立按需 content-idle 计时，但其 inter-block anchor 仍有重复 index blocker，不能合并。

## 1. 判据与已冻结前提

本设计按以下轴裁决，不能用 ROI/YAGNI 把完整方案降格：

1. **长远正确 + 完整**：要覆盖 pre-content、block 内、inter-block 三种合法静默，不以“少见”代替协议正确。
2. **本项目基于块级 buffered、已放弃流式**：block 完成是客户端递送与重试窗口的真实边界；方案必须与此架构一致。
3. **架构健康 > 回归风险**：若正确方案需要完成既有未接线原语，应如实评估，不因改动面大而否决。
4. **暂缓项必须完整文档化**：若选 C，须在 `docs/todo/deferred-backlog.md` 记录根因、当前行为、理想架构、暂缓原因和恢复实施清单。
5. **wire 用独立 oracle 裁决**：自洽 encoder/decoder 不足；至少要有 producer 全序、真实 `@anthropic-ai/sdk` 累积和真 Claude Code >300s 三条腿。

## 2. 已确证事实与未证假设

### 2.1 已实测

- Claude Code 2.1.220 的 300s event-idle watchdog：ping 不重置，空 `text_delta`/`thinking_delta`/`input_json_delta` 可重置。
- `recoverToolCallText` 与 `tool-input-decode` 曾分别吞掉空 text/input-json delta；共享空-delta primitive 旁路后，相关 mutation 会使测试转红。
- 默认 `ping + 200s 按需升级` 的**已有 open block**路径有效：200s 时在原 index 发空 delta；真 CC 两次约 315.5s PASS，最终文本无保活痕迹。
- 短请求 `stream_keepalive_escalate_sec:0` 与 `200`：1675 bytes，SHA-256 均为 `8691db71ca3b692468ae91dfc2df108871c8f5f684acc73f3832975d60f2a6a0`，`cmp` 相同。
- 第二轮 reviewer 的独立 SDK probe：`real block@0 → synthetic anchor@0 → real block@1` 会被 SDK 累积为 `first, second, empty-anchor`，重复 completed index 不可接受。
- 真 History 只读抽样的 100 条最近记录中有 2 条 Anthropic 请求超过 300s：
  - `req_1785177552554_5463`：320.024s，pre-response，upstream 0 帧，只有 ping；属于 C 也覆盖的 pre-content。
  - `req_1785177872790_5500`：309.014s，先完成 text block@0，再打开 text block@1，随后约 300.039s 无 content delta；属于**已 open block 内静默**，无需 inter-block carrier，现有原-index空 delta可覆盖。
- 已有 G2 harness `exp/block-level-anchor-sequential/idle-hook.ts` 可稳定构造 >310s inter-block gap；它证明该协议状态可达，但不是生产频率统计。

### 2.2 静态推导，尚未做行为 PoC

- **方案 B 全部可行性判断目前是静态推导**。尚未写“扣 stop”探针，也未用真实 SDK/CC 测量 tool_use 执行延迟。
- 最近 100 条 History 抽样**没有观察到 closed block 与下一个 block_start 之间 >300s 的真实生产样本**；这只能说明抽样未命中，不能证明暴露面为零。
- thinking/tool_use 的大生成通常是“block 已 open 后内部 delta 静默或持续生成”，由原-index空 delta覆盖；真正 inter-block >300s 需要上一个 block 已 stop、下一个 block 尚未 start，是更窄但协议合法的状态。

## 3. 方案 A：接线 `createAnchorIndexAllocator`

### 3.1 机制

每个 synthetic anchor 和真实 block 都从同一个 generation-scoped 单调 allocator 取得 wire index。典型 wire：

```text
pre-anchor@0 → real@1 → gap-anchor@2 → real@3 → ...
```

任一时刻只允许一个 block open。gap anchor 到期时占用 `nextAnchorIndex()`；下一真实 block 到达前先关闭 anchor，再用 `realBlockOffset(upstreamIndex)` 将真实 block 的 start/delta/stop 全部 remap 到下一未用 wire index。普通 ping cadence 与 200s content deadline不变。

### 3.2 改动面

必须作为一个协议原子改动完成，不能只改 injector：

- `src/lib/anthropic/keepalive-anchor.ts`
  - 复用已存在、已有 3 个测试的 `createAnchorIndexAllocator`。
  - `anchorStartFrame/anchorDeltaFrame/anchorStopFrame` 从固定 index 0 改为按分配 index 构造，或由 hooks 改成 index→frame factory。
  - pre-content injector 与 gap injector 分离；gap injector不再发 message_start。
- `src/lib/pipeline/types.ts`
  - allocator 挂入 `AnchorState`，使 handler、delivery、driver、live-reconcile共享同一状态。
  - `AnchorHooks` 的固定三帧改为按 index 构造的接口。
- `src/lib/pipeline/delivery/session.ts` / `delivery/types.ts`
  - 将“pre-content scaffold”和“per-gap content scaffold”分成独立 latch；gap 结束后可重新武装。
  - delivery 只通过合法 scaffold API 写顺序 anchor，不能任意直写固定 index。
- `src/lib/pipeline/client-sink.ts`
  - 把 allocator ledger 传给 content scaffold/frame provider；真实/synthetic block 写出时更新 allocator。
- `src/lib/pipeline/driver.ts`
  - buffered `flushBufferedFrames` 的固定 `remap(frame, 1)` 改为 runtime offset。
  - retreat 分支同样改为 runtime offset。
  - 每个真实 `content_block_start` 只调用一次 `onRealBlockOpen()`；恢复/continuation 腿不能重复记账。
- `src/lib/anthropic/live-reconcile.ts`
  - 固定 `remap(frame, 1)` 改为 allocator offset；gap anchor 在下一真实帧前关闭。
- `src/routes/messages/handler-v4.ts`
  - 创建并线程化 allocator；普通 envelope latch 与 content-anchor latch 分离。

### 3.3 既有设计复用程度

姊妹 plan `docs/plan/2026-07-22-continuation-retry-sequential-anchor/plan-1-sequential-anchor.md` Task 1.1–1.3 **大部分可直接复用**：

- Task 1.1 allocator 已 landed、API 与目标序列正好对应本方案。
- Task 1.2 已定义单块 open、gap 新 anchor、per-gap latch。
- Task 1.3 已枚举 driver buffered flush、retreat、live-reconcile 三个 remap 站点。
- G1 producer oracle 已定义目标全序 `anchor@0, real@1, gap-anchor@2, real@3`。

不能照抄的部分：当前代码已新增 generation-owned delivery session、continuation wire 计数和按需 deadline；设计须把 allocator 放到新的 delivery owner，而不是旧 `makeSseSink` 私有栈，并验证 continuation offset 与 anchor offset不双加。

### 3.4 协议风险

- 任一 remap 站点漏改会产生 start/delta/stop index 不一致或重复 index。
- allocator 更新必须与实际成功 wire write 同步；写失败或被抑制的 frame 不应推进计数。
- buffered recovery、retreat、live 三路径可能对同一真实 start 重复 `onRealBlockOpen()`。
- continuation 当前用 `wireDeliveredBlocks` 接续 index；多 anchor加入后，“真实块数”不等于“下一个 wire index”，必须统一成 allocator frontier，否则 continuation 会撞 synthetic index。
- anchor frame factory、close-off和终态平衡必须使用同一个 allocated index。

### 3.5 客户端可观测影响

- 只有逼近 content deadline 的极长 gap 才多一个空 text block；正常短请求逐字节不变。
- empty anchor 是合法顺序 block，最终 SDK content 会多一个空 text block。UI 通常不可见，但结构可观测；History 以 `synthetic:"anchor"` 标记。
- 不推迟已完成真实 block，tool_use 可按原 block 边界及时交给客户端。

### 3.6 测试与 oracle

- allocator unit：多轮 `anchor@0 → real@1 → anchor@2 → real@3`。
- producer 全序：所有 start/delta/stop index单调，`maxOpen===1`。
- buffered flush、retreat、live 三路径分别 mutation 控制 runtime offset。
- continuation组合：多 anchor 后 continuation 从 allocator frontier开始，不与任一 synthetic/real index重复。
- 重捕的 golden 至少包括：
  - `c0-live-anchored-direct-stream-golden.http.test.ts`
  - `buffered-anchor-golden.it.test.ts`
  - `live-post-commit-anchor-closeoff.http.test.ts`
  - `live-pump-terminal-anchor-closeoff.http.test.ts`
  - `keepalive-e2e.http.test.ts` / `keepalive-buffered-anchor-e2e.http.test.ts`
  - `anchor-multiblock-lifecycle.it.test.ts`
- 真实 `@anthropic-ai/sdk`：断 content 顺序与 wire 一致，anchor不重排到末尾。
- 真 CC：inter-block >300s 连跑，多块内容与最终文本无痕。
- 短请求 escalation 0/200 SHA-256 对照。

### 3.7 失效条件

- 存在绕过 allocator 的任意 content block producer。
- recovery/continuation 重建了新的 allocator而非延续同一 generation frontier。
- 客户端不接受合法但额外的空 text block；当前 sequential PoC 只证明真 CC 接受短序列，仍须重跑长墙与 SDK完整累积。

## 4. 方案 B：延迟 `content_block_stop`

### 4.1 机制

块内容到达后，不立即把该块的 `content_block_stop` 写给客户端；将 stop 单独扣留，使这个块在客户端 wire 上保持 open。若随后出现长 gap，按需空 delta直接写入这个仍 open 的 block，零新 index、零 remap。下一真实 `content_block_start` 或终局 `message_delta/message_stop/error` 到达前，先补发被扣 stop，再继续原帧。

### 4.2 在 buffered 块级 flush 中的可行性

**静态推导：技术上可做，但不是局部改一行 predicate。** 当前 `anthropicCommitBoundaries` 以 `content_block_stop` 触发，driver 在 boundary时把 buffer **连 stop 一起 flush**，并立即 `committedAny=true`、喂 continuation ledger。实现 B 需把 flush拆成：

1. start+deltas 先写 wire；
2. stop 存为 generation-owned pending stop；
3. 下一 block_start/终局前由 delivery serializer先写 pending stop；
4. committed ledger何时认为 block 已提交需重新定义。

文件级改动：

- `src/lib/codec/anthropic/commit-boundaries.ts`：边界仍由 stop 识别，但需要告诉 driver“commit body, hold terminator”，不能只返回 boolean。
- `src/lib/pipeline/driver.ts`：`flushBufferedFrames` 支持剥离最后 stop；boundary commit、retreat、terminal drain、error与continuation分支都必须 flush pending stop。
- `src/lib/pipeline/delivery/session.ts` / `types.ts`：generation-owned pending block-stop；所有后续真实 block_start和终局命令前自动 fence。
- `src/routes/messages/handler-v4.ts`：terminal error合成前必须经同一 fence，不能绕过 pending stop。
- continuation ledger/extractor：若 stop 未上线，已提交 assistant前缀是否可包含该块要重新裁决。

### 4.3 text 与 tool_use 的差异

- **text block**：延迟 stop 不改变已流出的可见文字；仅块完成事件变晚。若下一块很快出现，延迟极短；若真的静默 300s，客户端一直认为 text block open，但空 text delta 合法。
- **thinking block**：类似 text，空 thinking delta合法；signature通常在 stop 前已由 `signature_delta` 到达，仍需真 SDK验证长期 open thinking不影响签名/显示。
- **tool_use block**：代价真实且严重。Anthropic SDK 在 `content_block_stop` 才完成 block accumulator；Claude Code 的工具执行发生在完整 assistant turn/`stop_reason:tool_use` 后，而 `message_delta/message_stop` 又必须在 pending stop 后，所以延迟 stop会把工具可执行时机推迟到下一帧或终局。若 gap 本身发生在 tool_use stop后、message_delta前，客户端会整段等待；若代理为了保活主动保持 tool_use open，可能把本可立即执行的工具推迟接近 200–300s。

仅对 text/thinking启用可以避免工具执行延迟，但此时 tool_use 后的 inter-block/terminal gap没有 content carrier。已有 first-party arm J 证明空 `input_json_delta` 可保活，所以放弃 tool_use 覆盖会留下一个明确协议缺口；History incident `req_484` 又证明大 tool_use生成是重要真实场景，不能按 YAGNI忽略。

### 4.4 终局与顺序不变量

- `message_delta`、`message_stop`、`error`、client-visible continuation 切换前必须先补 pending stop。
- 任一时刻仍至多一个 block open；B天然不增加 index，也不需要 remap。
- 严格顺序可保持，但前提是所有终局和新 block入口都统一走 delivery fence；任何 handler out-of-band `writeSynthetic` 绕过 fence都会产生 open block直达 error/terminal。

### 4.5 客户端可观测影响

- 块完成时刻从上游 stop到“下一 block/终局到达”之间延迟。
- 在全面 buffered 下，start+deltas本来也要等 block闭合后才首次 flush；若只扣 stop，客户端会在 boundary时一次收到完整内容但看不到完成。相较现状，内容到达时间不再更晚，**block completion** 与 tool execution会更晚。
- 多数 text-only轮次的 stop后紧接 message_delta/message_stop，增量可能只有毫秒；真正需要本方案的 >300s gap正是最坏增量，代价不能用平均值淡化。

### 4.6 测试与 oracle

- driver producer：boundary flush不含 stop；下一 start/terminal前 stop恰好一次且先于后帧。
- text、thinking、tool_use三类 pending stop；error、abort、retreat、recovery、continuation组合。
- 真 SDK：长期 open block + 空 delta + stop，content/signature/tool input完整。
- 真 Claude Code tool oracle：测 tool实际执行时间，不能只断最终响应。比较现状与 B 的 time-to-tool-execution。
- >300s text inter-block和 tool_use inter-block真 CC；短请求 wire必然不再逐字节等价，因为 stop递送时序/字节位置改变，即使总字节相同。

### 4.7 失效条件

- 任一终局或新 block路径绕过 pending-stop fence。
- 产品不能接受 tool执行延迟；仅对 text启用又不能满足“完整覆盖”判据。
- continuation ledger需要已关闭块，而客户端 wire上的块仍 open，导致“已提交”定义分裂。

## 5. 方案 C：只覆盖 pre-content，暂缓 inter-block

### 5.1 机制

保留单 pre-content anchor + 固定 +1 remap：只有从未完成真实 block时允许 synthetic anchor。真实 block已完成后的 inter-block content deadline不注入 anchor；若没有 block open，就继续 ping并接受 CC 300s断流。

### 5.2 暴露面

在全面 buffered下，以下长静默**不是** C 的缺口：

- pre-response/首块前纯静默：单 anchor覆盖。
- thinking/text/tool_use block已 open 后内部静默：在原 index发空 delta覆盖。
- 大 tool_use input生成：只要 tool_use block仍 open，即使 300s无非空 delta也可发空 `input_json_delta`；真实 req_484 是首块 tool_use内部截断，不是 inter-block。

C 唯一缺口是：至少一个真实 block已完成且 stop已上线，当前没有 block open，下一 block_start/终局超过300s才到。现有证据：

- G2 harness可确定性构造该状态并让旧实现失败，证明它协议可达。
- 最近100条真 History抽样的2条 >300s Anthropic请求中，0条是该状态：一条 pre-response，另一条是 block@1已 open后的静默。
- 因此暴露面比“所有长 thinking/大 tool_use”窄得多，但样本不足以给出生产概率上界；不能声称不存在。

### 5.3 改动面

- `src/lib/pipeline/delivery/session.ts`：content scaffold门加“尚未完成任何真实 block”；已有 `semanticBlockCount` 可作为保守门。
- `src/routes/messages/handler-v4.ts`：分离 envelope/content latch，保证 enveloped_ping仍可在pre-content升级。
- 不接 allocator、不改 driver/live remap、不重捕多-anchor golden。

### 5.4 协议风险与客户端影响

- 单 pre-content anchor模型已有测试和真 CC证据，风险最低。
- 短请求可保持逐字节不变。
- 缺口发生时不是优雅降级，而是客户端约300s断流，违反“完整覆盖”目标；这是方案 C 的核心长期不完整性。

### 5.5 测试与 oracle

- producer：真实 block完成后200s不得再注入 anchor@0。
- enveloped_ping：普通 envelope latch与content latch分离，pre-content 200s能升级。
- pre-content >300s真 CC多次、短请求SHA对照。
- 反向测试明确记录 inter-block >300s仍失败，防止文档谎称完整。

### 5.6 若暂缓，backlog必须写什么

建议在 `docs/todo/deferred-backlog.md` 新增“Anthropic inter-block >300s content-idle carrier”条目：

- **根因**：ping不重置 CC 300s event watchdog；固定 anchor@0在真实 block完成后复用index会破坏SDK累积。
- **当前行为**：pre-content与open-block静默受保护；closed-block后的无-open gap只ping，>300s会断。
- **理想架构**：generation-scoped单调 wire-index allocator，多 anchor与后续真实/continuation块共享frontier，单块open。
- **为何暂缓**：需原子接线 driver buffered flush、retreat、live reconcile、delivery与continuation offset；局部补丁必损协议。
- **若做需改什么**：直接引用方案A文件清单、golden清单和三层oracle。

### 5.7 失效条件

任何真实 inter-block gap超过300s即失败；未来模型更常在block之间做长规划时暴露面会扩大。

## 6. 横向对比

| 维度 | A. 单调 allocator + gap anchor | B. 延迟 stop | C. 仅 pre-content |
|---|---|---|---|
| 完整覆盖 pre/open/inter-block | 是 | 理论上是；tool_use代价可能不可接受 | 否 |
| 新 index/remap | 需要，动态 | 不需要 | 不需要 |
| 与块级 buffered 架构 | 一致：wire frontier是generation状态 | 有张力：边界已识别但stop不递送，“已提交”定义分裂 | 一致但不完整 |
| 日常短请求字节等价 | 可保持（按需才变） | 不能保证，stop位置改变 | 可保持 |
| tool执行延迟 | 不增加 | 可能增加到整个gap；核心风险 | 不增加 |
| 协议风险 | 高但边界清晰：漏一个remap站点即损坏 | 高且跨终局/ledger：漏一个fence即损坏 | 低 |
| 现有设计复用 | 高：allocator与Task 1.1–1.3已存在 | 低：净新pending-stop语义 | 高：单anchor现状 |
| 需重捕 golden | 多 | 多，因stop顺序变化 | 少 |
| 长远正确 + 完整 | 最符合 | 取决于tool延迟能否接受，当前未证 | 不符合完整性，只能暂缓 |
| 当前证据等级 | allocator unit +短 sequential CC PoC；全接线未实测 | 静态推导，未实测 | 单anchor实测 + History暴露面抽样 |

## 7. 推荐

**推荐 A：完成既有 `createAnchorIndexAllocator` 的generation-scoped全链接线。**

理由不是“已有代码所以便宜”，而是：

1. A 是唯一同时覆盖三类静默、保持及时tool执行、又不改变普通短请求wire的方案。
2. 它把“下一个client wire index”提升为单一generation frontier，能统一 synthetic anchor、真实块和continuation；这是长远可扩展的协议所有权，而非keepalive局部特判。
3. 姊妹plan已经识别并设计了同一原子改造，allocator也已落地测试；主要工作是把它接到新的delivery owner并重验所有remap站点。
4. B看似零remap，但把复杂度转移到“pending stop + terminal fence + committed ledger语义”，并对tool执行引入最坏300s的真实用户可见延迟。除非PoC证明Claude Code在stop前就可安全执行tool（现有SDK/agent-loop结构不支持这一预期），不推荐。
5. C的生产暴露面目前看较窄，但它明确不完整。按本项目判据，只适合作为经用户明确接受的暂缓状态，不能称门闭合。

## 8. 设计评审后下一步

若用户选择 A，先把本设计转成独立TDD plan，沿姊妹Task 1.1–1.3执行，但必须补两项新集成：generation delivery owner与continuation frontier。若选择B，必须先做一次隔离PoC，测真实SDK block累积和真CC time-to-tool-execution，再决定是否值得写实现计划。若选择C，先修重复index与enveloped_ping latch，只闭pre-content，并在同一提交完整写入deferred backlog，文档不得再宣称inter-block门已闭合。
