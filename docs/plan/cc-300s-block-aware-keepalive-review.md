# 对抗性审查报告 — block-状态感知 keepalive plan

审查对象：`/home/xp/.claude/plans/sorted-waddling-thimble.md`
裁判轴：architecture-health-first / best-complete-solution / richest-data-flow（非 ROI/YAGNI）
方法：读码 + REPORT 实测核对，非附和。

---

## 核对已确认为「设计正确」的部分（附证据）

- **keepalive 空 delta 只进 forwarded 轨、不进上游轨** —— 已核实成立。sink 的 heartbeat tick 只调 `sampleForwarded(...)`（`client-sink.ts:192`，写入 `onForwarded` → handler 的 `forwardedSseEvents`），从不进 `onUpstreamFrame`。上游轨 (`acc` / `sseEvents`) 只在 `pumpAnthropicStreamingV4` 的 `onUpstreamFrame` 里累积（`handler-v4.ts:898-910`），driver 的 keepalive 帧根本不经过那条 hook。且 `stream-accumulator.ts:305-308` 的 `handleContentBlockDelta` 只在 `accumulateAnthropicStreamEvent` 被调用时才动 `acc`——keepalive 帧不会触达它。Plan 根因约束③正确。
- **L2 buffered 模式下 openBlock 天然为空 → fallback ping** —— 部分成立但有 CRITICAL 例外，见 [I4]。buffered 路径 `runResponseBufferedSink` 缓冲所有 rendered 帧、不 `sink.write` 到客户端（`driver.ts:551 buffer.push`），故 sink 的 `write` 在 commit 前从不被调用 → openBlock 恒 undefined → fallback ping。这一点对**未 retreat**的 buffered 是对的。

---

## CRITICAL

### [C1] S5 filter 的 index remap 使 sink 观察到的 index 与「客户端块状态机的 index」一致，但 plan 未验证 filter **删块**时 openBlock 会指向已被 suppress 的 index
证据：`src/lib/anthropic/server-tool-filter.ts:91`（"Handles index remapping so block indices remain dense/sequential after filtering"）、`:136-142`（`content_block_start` 命中 filter → `filteredIndices.add(index)`，**该帧仍可能被 suppress**）、`:156-162`（后续 `content_block_delta`/`content_block_stop` 若 `filteredIndices.has(index)` → `return null` 整帧 suppress；否则 `getClientIndex` remap 成 dense client index）。

driver S5 链对 Anthropic 应用了 `ANTHROPIC_RESPONSE_REWRITES`（含 server-tool-filter@300，DESIGN.md 已述），sink 观察的是 rewrite **之后**的帧（`driver.ts:481-483` `onRenderedFrame` 之后 `sink.write(toWrite)`；Anthropic 无 onRenderedFrame，但 S5 filter 在 `runResponse` generator 内部已 apply，故 yield 出来的就是 remap 后帧）。

风险链：
1. filter suppress 掉一个 server_tool block 的 `content_block_start`（`return null`），则 sink 的 `write` **看不到**那个 start → openBlock 不会被设成该块。这是好事（客户端也没收到）。
2. 但 remap 会把**后续保留块**的 index 重编号成 dense。sink 记录的 openBlock.index 来自 remap 后帧的 `content_block.index`（plan Part 1 说读 `index`），这与客户端实收 index 一致 —— **只要 sink 读的确实是 remap 后帧**。plan 说复用 `write` 里现有的 `JSON.parse(frame.data)`，而 `write` 收到的正是 remap 后帧，故此点**成立**。

真正未验证的 CRITICAL 子风险：**filter 在一个 block 的 start 已转发、后续 delta 被 suppress 的场景**不会发生（filter 按整块 filteredIndices 一致 suppress），但 **decode rewrite（@200）缓冲整个 tool_use 块**——它在 `content_block_stop` 处才重新 emit。若 keepalive 在 decode 缓冲 tool_use 期间触发，sink 已看到该 tool_use 的 `content_block_start`（decode 是否透传 start？需读 `decode-tool-input.ts`）。plan 完全未分析 decode/recover rewrite 对 openBlock 时序的影响 —— 这些 rewrite 会 **buffer/delay/replace** 帧，sink 看到的 start/stop 时序可能与「客户端认为的当前 open block」不同步。

判定：plan 声称「状态机由 write 驱动，只反映真实转发帧」是必要但**不充分**——它保证 index 与转发帧一致，但没保证 rewrite 缓冲期间 openBlock 的 type 判断正确。需要一个独立 oracle 实测（喂真实 S5 链 + 各 rewrite 开启的帧序列，断言 keepalive 帧的 index/type）。

### [C2] tool_use 期间 fallback ping 仍会撞 300s —— plan 明确承认却未给缓解，等于「已知不修复」
证据：plan Part 2（`handler-v4.ts` 帧 provider）：`type==="tool_use"` → `ANTHROPIC_PING`（fallback）。REPORT §0/§1：ping **不算 chunk**、300s 必断。

风险：大 Write/Edit 的 tool_use input 流式生成（`input_json_delta`）若在某个 tool_use block open 期间静默 >300s（GHC 生成大 JSON 时的 thinking/stall），fallback 到 ping → **CC 仍 300s 断**。这正是用户原始场景的近邻（opus 生成大工具调用）。

而空 `input_json_delta`（`partial_json:""`）理论上可作为该 block 的无害 keepalive —— 但 plan **完全没考虑** tool_use block 的 keepalive delta，直接退回 ping。这违反 best-complete-solution：修了 thinking/text 却把 tool_use 静默这个**同源同类**的 300s 断连留成 fallback-ping 死路。REPORT §5 也没测 tool_use 场景。

判定：plan 覆盖不完整。要么实测空 `input_json_delta` 对 CC 无害（则应发它而非 ping），要么文档化「tool_use 静默 >300s 仍会断」这一残留缺陷（含根因/为何暂缓/若做需改什么），而不是静默 fallback。

---

## HIGH

### [H1] 空 `text_delta` 未实测（REPORT §5 明示），plan 把它列为默认行为的一部分
证据：REPORT §5「空 text_delta（text block 场景）未单测，仅测了空 thinking_delta」；plan Part 2：`type==="text"` → 空 `text_delta`。

风险：REPORT 只证明了**空 thinking_delta** 被 CC 2.1.201 计为 content chunk 并重置 300s。空 `text_delta`（`text:""`）是否同样被计入 chunk **是推断非实测**。若 CC 对空 text_delta 有不同处理（例如 text block 的 delta 累加逻辑对空串短路、不算 chunk），则 text block 静默场景仍会 300s 断，且此时**不会 fallback**（openBlock.type==="text" 命中空 text_delta 分支），比 ping 更糟——它看似修了却没修。plan 测试章节确实要求补测空 text_delta，但把「默认发空 text_delta」作为已定方案，测试若发现无效就得回退设计。应在实测通过**之前**不将 text 分支设为默认，或保留 text→ping 直到实测确认。

### [H2] 连续多个空 thinking_delta（300s 内 ~15 个）对客户端块状态机的累积影响只测了「一次完整流存活」，未测「无 tail 的纯 keepalive 收尾」的块完整性
证据：REPORT 臂 B：空 thinking_delta 保活 + **上游真 tail（signature_delta + text + message_stop）** 完整收尾。即实测的是「keepalive 期后有真实内容补齐」。

风险：若一个请求在 thinking block open 期间发了 15 个空 thinking_delta 后**上游直接截断/RST**（无 signature_delta、无 message_stop），客户端拿到的是「一个 thinking block，内容全空，无签名，无 content_block_stop」。CC 对这种「被 keepalive 撑着但最终残缺」的 thinking block 如何反应未测。这与截断检测（`sawMessageStop`）交互：handler 会 `ctx.fail` 并 `writeSynthetic` error 帧（`handler-v4.ts` 截断分支），但客户端此时已收到一个畸形 open thinking block + 随后一个 error 帧——两者的组合是否被 CC 干净处理未验证。plan 未分析 keepalive × 截断 × refusal-recovery 的交互。

### [H3] web_search bypass 的 openBlock 跟踪 plan 承认「实现时定夺」——把一个 CRITICAL 判断推给实现期
证据：plan Part 4：「确认 `currentBlockType` 是否可直接复用还是需新增 forwarded-side 跟踪（实现时读 streaming-pump.ts:83-90/151-164 定夺）」。

核对：`StreamPumpState.currentBlockType`（`streaming-pump.ts:87`）是**上游侧 + 无 index**，且在 `recordUpstreamFrame`（`:152-163`）里按**上游原始帧**设置。但 bypass 的 forward 经 `serverToolFilter.rewriteEvent` 做 **index remap**（`forwardToClient`→`server-tool-filter.ts:159-162`）。所以上游侧 `currentBlockType` 的 block 与客户端实收的**同一 block 但不同 index**。若直接复用 `currentBlockType` + 上游 index，keepalive delta 的 index 会**与客户端实收 index 错配** → 违反协议、破坏客户端块状态机。plan Part 4 的根因约束（index 必须匹配 forwarded 块）在 bypass 路径里因 remap 而**必须新增 forwarded-side 跟踪**，不能复用上游侧。plan 把这个已可静态判定的 CRITICAL 决策留成 open question，是 big-feature-pipeline 违规（该在 plan 期定死）。

### [H4] cold-start immediate ping 与 provider fallback 的时序：commit 瞬间 openBlock 为空 → 首帧发 ping，但若上游极快返回首个 content_block_start 后立即静默，第二个 keepalive 才切 content_delta
证据：plan Part 2「冷启动 immediate first ping（:506）→ 保持 ANTHROPIC_PING」。`handler-v4.ts:506` 确实硬发 `ANTHROPIC_PING`。

风险：commit 后立即一个 ping（openBlock 空，合理）。但随后 `pumpAnthropicStreamingV4` 接管，若上游先发 `content_block_start(thinking)` 再静默 280s，heartbeat timer 的下一次 tick 才会用 provider 选 content_delta。这没问题（cadence ≤40s，会在 300s 前发出多个 content_delta）。**但** cold-start 首个 immediate ping 是硬编码 `sink.write(ANTHROPIC_PING)`（`:506`），它经 `sink.write` → 会**更新 openBlock 状态机吗**？`ANTHROPIC_PING` 的 data 是 `{type:"ping"}`，无 `content_block.type`/无 index → 状态机应忽略（既非 start 也非 stop）。需确认 plan Part 1 的状态机对「非 start/stop 帧」是 no-op（读了 index 但只在 start/stop 时改 openBlock）。plan 描述是「仅 content_block_start/stop 改 openBlock」，故 ping 经 write 是 no-op——**成立但 plan 未显式说明 ping 帧经 write 的 no-op 性**，实现者可能误加逻辑。低风险但值得钉死。

---

## MEDIUM

### [M1] `content_block_stop` 后到下一个 `content_block_start` 之间的「无 open block」窗口发 keepalive → fallback ping → 该窗口若 >300s 会断
证据：状态机在 `content_block_stop` 时 `openBlock = undefined`（plan Part 1）。REPORT 未测「块间静默」。

风险：opus 在两个 content block 之间（如 thinking block 结束、text block 尚未开始）静默 >300s，openBlock 为空 → fallback ping → 300s 断。这是真实存在的窗口（message_start 后、首个 content_block_start 前也是同一窗口，plan 用它解释 cold-start ping）。plan 只把「无 block」当 cold-start 一次性场景，没意识到**块间**也是无-block 窗口且可长时间静默。best-complete-solution 要求：块间/pre-first-block 的长静默要么发一个协议合法的 keepalive（如 `message_delta` 空 usage？需实测 CC 是否计入），要么文档化残留缺陷。

### [M2] redacted_thinking / server_tool_use / signature_delta 期间的 openBlock type 归类未定义
证据：`stream-accumulator.ts:46-49`（redacted_thinking）、`:56-61`（server_tool_use）都是合法 block 类型。plan Part 2 只列 thinking/text/tool_use/未知→ping。

风险：
- `redacted_thinking` block open 期间静默：type 非 thinking/text → fallback ping → 若 >300s 断。且 redacted_thinking 是**无 delta 的完整块**（`stream-accumulator.ts:269-272` "Complete at block_start, no subsequent deltas"），对它发任何 delta 都违反协议。故正确行为就是 ping（或它根本不会 open 很久）。plan 把它归入「未知 type→ping」是对的，但**未显式列出**，实现者需知道 redacted_thinking 绝不能发 delta。
- `server_tool_use` block：input_json_delta 累积，与 tool_use 同——同 [C2] 的 tool_use 死路。
- `signature_delta`：不是 block 类型而是 thinking block 内的 delta，openBlock 仍是 thinking——无问题，但 plan 提到「signature_delta 期间」措辞含混。

### [M3] plan 未指明 keepalive delta 的 index 来源在「上游用非 dense/跳跃 index」时的正确性
证据：`stream-accumulator.ts:302` `acc.contentBlocks[index] = newBlock`（按上游 index 存）。sink 读的是 rewrite 后（remap 后 dense）index。

风险：正常情况 remap 保证 dense，openBlock.index 与客户端一致。但如果 filter 全未命中（无 server tool），`getClientIndex` 恒等（`server-tool-filter.ts:150 clientIndex===index`），index 就是上游原始 index。若上游发非常规 index（理论上），sink 直接透传该 index 作 keepalive delta 的 index——与客户端一致（都收同一 index）。此点实际成立，但依赖「sink 读转发后帧 index」这一不变量，plan 应显式声明该不变量并测「有 server tool filter remap 时 keepalive index 跟随 remap」。

---

## LOW

### [L1] history forwarded 轨标签从 `ping` 变 `content_block_delta` —— plan 说「预期」，但会污染依赖 forwarded 轨 type 计数的下游（如 telemetry/UI 的 keepalive 计数）
证据：plan 根因约束③「history forwarded 轨标签会从 ping 变 content_block_delta——预期」。`client-sink.ts:140` `frameType` 会把空 thinking_delta 帧解析出 `type:"content_block_delta"`。

风险：任何按 `forwardedSseEvents[].type==="ping"` 统计 keepalive 的消费者（若存在）会漏计新式 keepalive；按 `content_block_delta` 计内容帧的会多计。是可观测性语义漂移，非正确性 bug，但 richest-data-flow 下 history 保真的代价是下游解读需更新。plan 文档同步章节应提醒检查是否有此类消费者。

### [L2] `nullableEnum(["ping","content_delta"])` 默认 content_delta 是**破坏性默认变更**——所有现有部署一次 reload 即切新行为
证据：plan Part 3 默认 `content_delta`。这符合 compat-fusion（强制迁移旧→新长远正确），但空 text_delta 未实测（[H1]）+ tool_use 死路（[C2]）意味着默认切换时这些未验证/未修的边界立即对所有用户生效。若 [H1]/[C2] 未先解决就上默认，等于把未验证行为设为默认。建议默认切换 gated on [H1] 实测通过。

---

## 结构性总评（不写修复方案）

1. **最严重的结构缺口是覆盖不完整**（[C2] tool_use、[M1] 块间窗口、[M2] redacted_thinking）：plan 只把 keepalive 问题解成「thinking/text 两种 open block」，但 300s 断连的**完整问题域**是「任意 >300s 无-真实-content-chunk 窗口」，而 tool_use input 生成期、块间、pre-first-block、redacted_thinking 期都是该域内的静默窗口，全部 fallback 到会断的 ping。这违反 best-complete-solution/architecture-health-first：修了显眼子集，把同源的其余静默窗口留成 ping 死路，且未文档化为「已知残留 + 根因 + 若做需改什么」。

2. **oracle 缺口**（[C1]/[H1]/[H2]）：plan 的自洽（喂 start→delta→stop 断言 provider 选帧）不能证明协议正确性——需真实 CC 2.1.201 作独立 oracle 喂各类 open-block × keepalive 组合（尤其空 text_delta、tool_use input_json_delta、keepalive+截断收尾），呼应本项目 empirical-verification/self-consistent-needs-independent-oracle。REPORT 只覆盖了一臂（thinking + 真 tail），plan 把单臂实测外推成全域安全。

3. **bypass 路径 open question 应在 plan 期定死**（[H3]）：因 remap，bypass 必须新增 forwarded-side index 跟踪，静态可判，不该留「实现时定夺」。
