# Responses buffered 块级语义压缩 + 终结对账（buffered block merge）

- 状态：spec 定稿（brainstorming → 四方跨模型对抗审查 → live-GHC 实测 gating → **2026-07-19 对 master +523 提交 / generation runtime / History V3 重接地修订**）；待 plan 修订 + 复核后执行
- 日期：2026-07-14（重接地 2026-07-19）
- 归属：`docs/spec/`。关联 ADR [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)、[block-level-buffered-retry](../decisions/2026-07-11-block-level-buffered-retry.md)；DESIGN.md「活的架构现状」buffered 行。
- 前置探针：[tests/e2e-client/responses-nodelta.probe.it.test.ts](../../tests/e2e-client/responses-nodelta.probe.it.test.ts)（客户端容忍，8 用例）+ 本文 §9 live-GHC 实测。

## 1. 问题与动机

Responses buffered-retry 路径（opt-in、默认 OFF）把渲染帧 buffer 到 commit 边界（`response.output_item.done`）才 flush 给客户端。一旦 buffered，**块内的 per-`*.delta` 帧对客户端零增量价值**——客户端在 commit 前什么都收不到，然后一次性 burst 收到整串 delta，其中每个 `function_call_arguments.delta` 还各携一个巨长 `item_id`，纯属字节 + 解析开销。

本特性在 buffered flush 边界把块内容**语义压缩**（省略冗余增量帧），并在终结快照缺陷时**对账修复**，使客户端拿到最小的、协议合法的、语义等价的帧序。

**这不是「丢 delta 器」，而是「协议规范化器」**：给定一个终结态，发出最小的协议合法客户端等价帧序列——drop-delta / repair / item-summary 都是这一框架的实例，生成态的合法性由构造保证（含顺带修复上游畸形序列，如缺 `content_part.added` 的地雷）。

## 2. 作用范围

- **仅 Responses 格式**的全部 buffered 子路径：直连块级 commit flush + 直连终结尾巴 flush + WS 终结 flush。
- 注入缝**格式无关**（复用现有 `RunBufferedOpts` 钩子模式，未来 CC/Anthropic drop-in）；归并**逻辑 Responses-only**（不抽统一事件模型——三格式帧分类学差异过大，通用版是有漏洞的过度抽象）。
- CC / Anthropic 归并 → `docs/todo/deferred-backlog.md`（同一注入缝、各供自己的 reducer）。

## 3. 配置：两个正交旋钮

现有单枚举把两个正交维度揉死。拆成：

```yaml
responses:
  buffered_merge:
    event_compaction: verbatim | drop-delta | item-summary   # 默认 drop-delta
    completed_output: upstream | repair-if-incomplete | rebuild  # 默认 repair-if-incomplete
```

**`event_compaction`（减法轴——丢多少增量帧）**：
- `verbatim`：逐帧原样（现状字节等价，逃生阀）。
- `drop-delta`（默认）：丢「有绝对值 `.done` 重设」的文本/参数类 `*.delta`，保留全部生命周期帧（`output_item.added` / `content_part.added` / 各 `.done` / `content_part.done` / `output_item.done`）。全保真、无损。
- `item-summary`（原 full-resynthesize 改名，显式高级）：每块只保留 `output_item.added` + `output_item.done`（**均原样转发上游帧**——上游 `output_item.done` 已自带完整 item），丢弃中间的 content_part 分片与所有 `*.delta`/`.done`。wire 最小，但改变生命周期事件集合、兼容面更大。**仍是减法**（转发上游自足帧、不生成），故无需标记。

**减法轴三档全是 subtractive**（只过滤帧、保留上游权威生命周期帧 verbatim、不生成内容），故 `event_compaction` 任何档都**无需合成标记**（见 §6）。`drop-delta` 的 flush 帧过滤无跨块状态；`item-summary` 同理。

**`completed_output`（生成轴——终结快照来源）**：
- `upstream`：原样转发 GHC 的 `response.completed`。
- `repair-if-incomplete`（默认）：仅当 `isTerminalSnapshotComplete()` 判定 GHC completed **缺陷**（output 为空 / item 数不覆盖 / id 不匹配 / args 缺失 / 与此前 `output_item.done` 冲突）才用 reducer 重建替换其 output；完整则原样保留（不夺上游权威）。
- `rebuild`：无条件用 reducer 重建替换 completed.output（预留，正常态是冗余等价替换 + 合成标记噪声，非默认）。

**正交性收益**：可表达现 4 枚举缺失的组合（`verbatim + repair-if-incomplete` = 保留完整事件流只修坏 completed；`item-summary + upstream` 等）。未来加 CC/Anthropic 时 `event_compaction` 天然泛化（各格式都有 delta 概念）、`completed_output` 各格式各自定义「完整」判据。

**capability 约束**：codec 声明支持的策略，配置解析拒绝无意义组合（某格式无终结快照 → 不接受 `completed_output != upstream`）。

**默认值的实证依据**（§9）：live-GHC 实测 GHC 直连 completed **携带完整 output**，故正常态 `drop-delta` 已足够、`repair` 不触发。repair 是罕见缺陷的安全网，非承重。

## 4. 落点：reducer 托管进 candidate-response-session，transformFlush 由 driver 咽喉调用

> **[2026-07-19 重接地修订]** master 前进 523 提交、引入 generation runtime（候选竞速/对冲）+ History V3。原设计把 reducer 挂顶层 `RunBufferedOpts.bufferedMerge` + `resetAttempt` 与新的候选会话运行时**阻抗失配**（每次 recovery 换全新候选+新 acc → 顶层持久 reducer 会带陈旧状态、`resetAttempt` 是为此打的补丁）。据只读勘探（B6）改为**托管进 candidate-response-session**——这更忠实于原意「codec 拥有的有状态 reducer」，且对未来 buffered/hedge 融合（driver.ts P7-T3）更稳。

**托管点 = candidate-response-session 的候选本地状态**（[candidate-response-session.ts](../../src/lib/pipeline/generation/candidate-response-session.ts)，Responses 工厂在 [routes/responses/candidate-response-session.ts](../../src/routes/responses/candidate-response-session.ts)）。Responses 每候选 `state = { acc, diag, ... }`，reducer 状态（收集槽）与 `acc` **并列**同址：
- `observe(frame)` = 现成的候选 `onRenderedFrame(state, frame)` 回调（正是 `accumulateResponsesStreamEvent(event, state.acc)` 被喂的同一回调）→ **「observe 先于 drop」自动满足、无需另接线**。
- **无 `resetAttempt`**：每次 retry/recovery 经 coordinator 拿全新候选 → 全新 session → 全新 acc + 全新收集槽，per-attempt **天生 fresh**。删掉原设计的 `resetAttempt`（它是顶层持久 reducer 的补丁、现在多余）。

**transformFlush 作候选 responseOpt、由 driver 咽喉调用**（与既有 `commitBoundaries` 完全同构——后者也是候选 responseOpt、driver 在 buffered loop 消费）：

```ts
// 挂 CandidateResponseSessionOptions（与 commitBoundaries 并列）：
transformBufferedFlush?(frames: readonly ClientFrame[], ctx: BufferedFlushContext): readonly ClientFrame[]

interface BufferedFlushContext {
  cause: "boundary" | "terminal-drain" | "retreat"
  boundaryFrame?: ClientFrame   // 区分 output_item.done / completed / failed / error
}
```

- driver 在 `flushBufferedFrames` 咽喉（现 [driver.ts:1060](../../src/lib/pipeline/driver.ts)，三 flush 点 retreat@1155 / 块级@1193 / 终结@1250）经 `currentCandidateResponseOpts` 调 `candidateOpts.transformBufferedFlush?.(frames, ctx)`；未提供即逐帧原样、CC/Anthropic 零影响。
- **`cause` 须另传**：`flushBufferedFrames` 现第二参是 `isTerminalFlush: boolean`（gate anchor 收尾、与 `cause` 语义**正交**，不可复用）——在三调用点各自另传 `cause`（retreat / boundary / terminal-drain）。
- 咽喉施加在 anchor close-off/write 循环之前。理由（原 BLOCKER 仍成立）：`response.completed` 在 commit 边界集（[commit-boundaries.ts:20](../../src/lib/codec/openai-responses/commit-boundaries.ts)），HTTP 直连它在**块级 flush**就送走、终结尾巴 buffer 为空——变换须每次 flush 都跑、不能只挂终结。

**rebuild 源同址取得**：repair/rebuild 要读的终结快照，就是候选本地 `acc` 收集的各块 `output_item.done` 的 `item`（不是 `acc` 的拼接纯文本——它丢 message 多 part/reasoning/refusal/annotations）。reducer 在候选 state 里新增 `Array<ResponsesOutputItem>` 收集槽、与 `acc` 并列。

**[HIGH] rebuild 源 = 收集到的各块 `output_item.done` 的 `item` 对象**（每个自带该块完整内容），**不是**现有 [responses-stream-accumulator.ts](../../src/lib/openai/responses-stream-accumulator.ts)（它只存拼接纯文本 + function_call，丢 message 多 part / reasoning / refusal / annotations，用它 rebuild 会把好数据降级）。reducer 新建一个 `Array<ResponsesOutputItem>` 收集槽。

**状态用量分层**：`event_compaction`（减法）是**无状态的 per-flush 帧过滤**，不用收集槽；跨块 `Array<ResponsesOutputItem>` 收集槽**只**服务于 `completed_output` 的 `repair-if-incomplete`/`rebuild`（终结 completed 的生成对账，须跨多次块级 flush 累积全部 item）。`completed_output: upstream` 时收集槽可惰性不启用。

## 5. 承重不变量（协议合法性）

1. **地雷不变量（泛化到「任何依赖 `content[contentIndex]` 已存在的事件」，不止 `.done`）**：openai SDK accumulator 中 `output_text.done` / `refusal.done` / `reasoning_text.done` / `reasoning_summary_text.done` **以及 `output_text.annotation.added`** 都走 `getContent(content_index)`，缺对应 `.added`（`content_part.added` / `reasoning_summary_part.added`）会**流式中途抛 `missing content`**（早于 completed、救不回）。仅 `function_call_arguments.done` 不走 getContent。故判据是**「任何依赖 content part 已存在的事件（含各 `.done` 与 `annotation.added`），其 `.added` 必须保留」**；`item-summary` 塌缩到纯 item 级时必须**一并丢弃 `output_text.annotation.added`**（否则它成孤儿引用、客户端抛 `missing content`——annotation 已完整落在 `output_item.done` 的 `item.content[].annotations`，丢流式 annotation 与丢 content_part.done 是同一等价性）。计划复核（GPT）发现：真实 gpt-5.5 `web_search_preview` 原生透传 citation annotation，此路径真实存在、当前项目类型 union 未建模 `output_text.annotation.added` → 须补建模。
2. **drop-delta 只丢有绝对值 `.done` 重设的 delta**：`output_text.delta`（done 是 `=` 绝对值）、`function_call_arguments.delta`、`refusal.delta`、`reasoning_text.delta`、`reasoning_summary_text.delta` 可证安全丢。**绝不丢 payload 型 delta**（`response.audio.delta` / `image_generation_call.partial_image`）——其 `.done` 在 accumulator 是 no-op、completed.output 不含，丢了不可恢复。
3. **retreat + 失败/不完整终结 + 未知事件 → 一律 verbatim**（硬不变量，不是某模式的偶然实现）：
   - `cause: "retreat"`（driver.ts buffer-cap 退避）→ `transformFlush` no-op 原样 flush（否则「前缀归并 + 后缀 live delta」混合 wire 造成客户端不可恢复的内容缺口）。
   - `error` / `response.failed` / `response.incomplete` 终结且当前 item 未形成完整 snapshot → 保留 delta（richest-data-flow：失败不是丢 partial 诊断信息的理由）。
   - 未知/新增事件类型 → 默认原样保留、禁止半归并。
4. **[2026-07-19 重接地新增] buffered ⊥ hedge 互斥 + winner-only 交付**：generation runtime 的对冲在 buffered 路径**被短路禁用**（[driver.ts:768](../../src/lib/pipeline/driver.ts)：`if (outerOpts && "retryCap" in outerOpts) return undefined`——buffered 永远传 `retryCap`）。故 reducer **永不**与并发多候选共存；竞速也只交付**单一 winner** 的帧（`writeWinnerFrames`），每候选持隔离 acc + 隔离收集槽。per-candidate reducer 模型因此不仅成立、反被强化。**须显式声明为不变量 + 加守卫测试**（若未来 P7-T3 融合 buffered/hedge 打破此互斥，候选本地托管仍是正确形状，而顶层 reducer 会崩——这也是 §4 选候选托管的理由之一）。

## 6. History 双轨 + 合成标记（仅生成帧）

- **upstream 轨**（`response`/`sseEvents`/per-attempt `_sseEvents`）：永远原样保留全部 delta（richest-data-flow 铁律）。归并在咽喉点作用于 client 帧、在 upstream 快照点之后，天然不污染。
- **forwarded 轨**（`clientResponse.sseEvents`）：记客户端真收到的归并后 wire。
- **[承重] 合成标记只打在生成帧上**：`drop-delta`（减法）**不需要标记**——丢 delta 是「帧的缺席」，上游轨保 verbatim delta、forwarded 轨省略它们，**两轨 diff 本身即归并记录**、可完整重建。给原样透传的幸存帧（output_item.added/done 逐字节未改）打标记会与 [frame-origin.ts](../../src/lib/pipeline/frame-origin.ts)「只有被改写/注入的帧属于 synthetic」契约冲突。**只有 `repair`/`rebuild` 重建的 completed** 才标（forwarded 内容 ≠ 上游内容）。
- 复用**单一** `SseEventRecord.synthetic` 字段，新增值 `"buffered-terminal-repair"`（generative completed）。**[2026-07-19 重接地修订]** 打标机制：repair 后的 `response.completed` 帧经 `flushBufferedFrames → sink.write → sampleForwarded(frame, readSyntheticKind(frame))` 落库，故用 `tagFrameSynthetic`（[frame-origin.ts:32](../../src/lib/pipeline/frame-origin.ts)）。当前实际须改的站点（**非原稿的 4 文件**——History V3 已把 union 集中）：
  1. `SyntheticOriginKind` @ [frame-origin.ts:29](../../src/lib/pipeline/frame-origin.ts)（让 tagFrameSynthetic/readSyntheticKind 接受）
  2. `OperationSyntheticKind` @ [model-operation-record.ts:28](../../src/lib/context/model-operation-record.ts)（记录层超集，`SseEventRecord.synthetic` 现 import 它、不再自建 union）
  3. `sampleForwarded` 参数 union @ [client-sink.ts:194](../../src/lib/pipeline/client-sink.ts)（HTTP）
  4. `sampleForwarded` 参数 union @ [client-sink.ts:588](../../src/lib/pipeline/client-sink.ts)（WS）
  - `history/types.ts` 自建 union **已消失**（改 import `OperationSyntheticKind`）；ui-v4 **疑似无穷尽 Record**（`SseEventsSegment.tsx` 只用泛化 `f.n` 标志渲染、不 switch over kinds）→ 大概率无需改 ui-v4，但**须读码坐实**（残余项）。
- **聚合诊断入 `pipelineInfo`**：mode、dropped event count/bytes、dropped event types、repaired item count、repair reason（`empty-output | missing-item | inconsistent-item`）、flush cause、reducer fallback-to-verbatim 原因。

## 7. 配置纪律（配置不享代码的「无向后兼容负担」）

- `buffered_retry` OFF 时本键**惰性无效**（无 buffer 可归并，不报错不警告）。
- 非法枚举值 → 警告并回落默认（`drop-delta` / `repair-if-incomplete`），**绝不因配置问题杀进程**（对齐 [[feedback-config-philosophy-separate-compat-and-warn-continue]]）。
- 热重载：`applyConfigToState` 读入即生效。
- **整体加性、不翻转任何现有默认**：本特性骑在 `buffered_retry`（默认 OFF）上；即便机制完整落地，默认路径行为不变。

## 8. 测试策略（每类型唯一真相域）

1. **reducer 变换纯函数 unit**：逐 `event_compaction × completed_output` 组合 × 块型（**function_call / message 多 part / refusal / reasoning + summary**——细节评审指出原设计漏 refusal/reasoning）。**地雷不变量专测**：`item-summary` 的 message/refusal/reasoning 块不得含无 `.added` 的 `.done`；payload delta 不被丢。**次序不变量专测**：observe 早于 drop。
2. **客户端容忍 e2e（异模型双 SDK + 真实消费者）**——细节/形状评审共同修正「官方 SDK 只做基线」：
   - `openai` 官方 SDK：抓「**流式迭代中途抛 `missing content`**」（它正是缺 `.added` 会抛的消费者），覆盖 message 多 part / refusal / function_call / reasoning / 空满 completed。
   - `@ai-sdk/openai`（新装 dev 依赖）：delta 敏感消费者（当初逼出 stream-id-sync），主导模式矩阵。
   - **真实 Codex / 裸 SSE oracle**：buffered /responses 的真实消费者是 Codex CLI，两个 JS SDK 都不建模它（[[methodology-client-source-grep-not-rest-capability-probe-endpoint]]：client 子集 ≠ 真实容忍）；复用 `exp/cli-e2e-stall` harness 或裸 SSE 结构 oracle。
3. **driver flush + History 双轨（http/golden）**：`buffered_retry` ON，断言 forwarded 轨 = 归并 wire + 仅生成帧带 `buffered-terminal-repair` 标记；**upstream 轨 = 原始全 delta**（双轨分离铁证）；覆盖 HTTP 块级 / WS 终结 / retry reset / retreat / partial-degrade。
4. **变异纪律**：每条新绿测试须有牙——`event_compaction=verbatim` → 归并断言变红且只红对应条（示范 MUTANT）。

## 9. live-GHC 实测 gating 结论（已完成，2026-07-14）

隔离测试服务器（新码 + 真 GHC，gpt-5.4-mini）实测：

- **function_call 帧序**：`created → in_progress → output_item.added → function_call_arguments.delta×5 → .done → output_item.done → completed`；**completed.output len=1、携完整 function_call item + 完整 arguments**。
- **message 帧序**：`output_item.added → content_part.added → output_text.delta×7 → output_text.done → content_part.done → output_item.done → completed`；**completed.output 携完整 message + output_text**；**content_part.added 确实先于 delta**（地雷可规避）。
- **决定性结论**：**GHC 直连 completed 携带完整 output → backfill 是防御性、非承重**。默认 `drop-delta + repair-if-incomplete` 得实证支撑：正常态 repair 不触发、drop-delta 足够安全。

**残余未知（记入 backlog，不阻塞）**：
- reasoning 块未能诱发出独立 output item（gpt-5.4-mini 内部 reasoning 走 ping、未作为 output 帧发出）；协议规范化器「保留所有 `.added`、只丢有绝对值 `.done` 的 delta」对 reasoning 是**构造性安全**、无需实测覆盖，仅测试 fixture 真实性受影响。若后续观测到 reasoning output item 再补 fixture。
- Codex 对无-delta wire 的真实容忍度 → §8.2 真实消费者 oracle 覆盖。

## 10. 四方跨模型对抗审查（已完成）

GPT×Claude × 细节×形状 四份评审，高度收敛。采纳要点：正交旋钮（替 4 枚举）、默认 drop-delta+repair-if-incomplete（替无条件 backfill）、reducer 咽喉落点（修 BLOCKER：completed 在块级 flush）、rebuild 源用 output_item.done item 收集（非文本 acc）、地雷不变量泛化到 refusal/reasoning、drop-delta 不丢 payload delta、retreat/失败 verbatim、标记仅生成帧、双 SDK + Codex oracle。

**不采纳记录**：
- 无条件 backfill 默认——夺上游权威、synthetic 噪声、协议演进丢信息面大（实测 GHC 发满 completed，无条件回填正常态是冗余等价替换）。
- 抽统一跨格式事件模型——三格式生命周期不同构，过度抽象；只抽共享 reducer 生命周期缝。
- item_id 单独缩短为主方案——治标（drop-delta 已消灭 buffered 路径的重复 id 开销）、live 路径改写 id 引入跨事件关联风险；record-not-adopted，标「需实测 live 路径是否有真实带宽痛点」。
- 归并下沉 codec render 层让 live 也受益——live delta 有真实增量价值，buffered-ness 是使归并无损的正确性前置条件；应用点必须门控 buffered flush。

## 11. 实现阶段（交 writing-plans 细化）

- Phase 0：装 `@ai-sdk/openai` dev 依赖 + 前置探针转正（现有 openai 探针扩块型）+ 类型缺口修正（`annotation.added` + `reasoning_text` 建模）。
- Phase 1：transformBufferedFlush 候选 responseOpt + driver 咽喉调用（**候选托管**，非顶层 `bufferedMerge`）+ cause 三点另传 + buffered⊥hedge 守卫。
- Phase 2：Responses 候选 reducer（收集槽与 acc 并列 + drop-delta + item-summary + isTerminalSnapshotComplete + repair/rebuild）。
- Phase 3：History synthetic 标记（4 站点：frame-origin + model-operation-record + client-sink×2）+ pipelineInfo 诊断。
- Phase 4：配置两旋钮 + capability 约束 + 校验回落。
- Phase 5：测试三层 + 变异纪律 + Codex oracle。

## 12. 2026-07-19 重接地：漂移处置与残余核实

对 master +523 提交（generation runtime + History V3）只读勘探后：

**实质修订（已入 §4/§5.4/§6）**：① reducer 从顶层 `RunBufferedOpts.bufferedMerge` 迁到 **candidate-response-session 候选托管**（observe=onRenderedFrame、per-attempt 天生 fresh、删 `resetAttempt`）；② `transformBufferedFlush` 作候选 responseOpt、driver 咽喉调用（与 `commitBoundaries` 同构）；③ `cause` 须在三 flush 点另传（`flushBufferedFrames` 第二参 `isTerminalFlush` 与 cause 正交）；④ synthetic 标记站点更新（4 处：frame-origin:29 + model-operation-record:28 + client-sink:194/588，history/types 自建 union 已消失）；⑤ 新增 buffered⊥hedge 互斥不变量。

**机械重定位（交 plan）**：全部行号、`runResponseBufferedSink(deps,…,generation?)` 签名、flush 三点行号。

**不变（勘探坐实仍成立）**：commit-boundaries、History V3 双轨分离、pipelineInfo 仍是聚合诊断通道、类型缺口 Phase 0 原样、地雷不变量、默认值 live-GHC 依据。

**残余核实项（plan 执行前坐实）**：① ui-v4 对 `f.n`/synthetic 的渲染是否真无穷尽 Record（大概率无需改 ui-v4）；② `makeBufferedHarness` 现签名与测试的契合；③ winner-only 聚合诊断只覆盖交付候选是否合 §6 意图。
