# Phase 4 Kickoff：流式响应两向 + handler 缝合（最难 byte-critical）

> self-contained kickoff。假设你零项目上下文。先读【必读】再动手。**Phase 0（router）+ 1（路由骨架+二维门控）+ 2（hub+请求翻译）+ 3（非流式响应两向）已 landed master**，你建其上。

## 背景与为什么
copilot-api-js 正建通用「入站×出站」翻译矩阵。Phase 3 接上了**非流式**响应翻译（`renderResponseNonStreaming` 委托 hub），`anthropic→cc` 非流式请求已端到端可用。但**流式响应仍 fail-fast**（`renderResponse` 逐帧对翻译腿 throw）。

**Phase 4 接上流式响应翻译——翻译矩阵前向腿全通（非流式 Phase 3 + 流式 Phase 4）**：这是整个特性**最难的 byte-critical 部分**——逐帧 SSE 状态机（CC→Anthropic）+ handler 心跳/anchor/reconcile 三方缝合。反向格子接线仍是 Phase 5。

## ⚠️ 为什么这是最难的 phase（4 个硬约束，任一违反都挂客户端）
1. **byte-critical**：转发给客户端的 Anthropic SSE 被 Claude Code 的 @anthropic-ai/sdk 苛刻解析。帧顺序、content_block index 连续、event 行、signature 都有硬期待。语义等价但字节不同的帧流能直接挂客户端。
2. **event-line 契约（N1，最易静默失败）**：所有合成 Anthropic SSE 帧**必须经 `src/lib/anthropic/sse-frame.ts` 的 `anthropicSseFrame`**（event 行 = 帧 type）。**纯 `data:` 帧（无 event 行）会被 SDK 的 SSEDecoder 按 event 名分发时静默丢弃**——测试可能过、客户端丢帧。skill `debugging-claude-client-connection`。
3. **心跳缝合（非镜像 gemini）**：翻译路径客户端仍是 Claude Code（**300s no-real-content 断连**，reasoning 模型 pre-content 静默最易撞）。出站给客户端是 Anthropic SSE，**必须复用 Anthropic 的 `makeAnchoredSseSink` + keepalive + delayed-commit + prelude**（[handler-v4.ts:446-463](../../../src/routes/messages/handler-v4.ts#L446)）。gemini handler [无心跳](../../../src/routes/gemini/handler-v4.ts#L271)，**别镜像它**。
4. **三方 message_start reconcile**：翻译分支的 message_start 有三个来源——prelude 合成（delayed-commit 期 [:883](../../../src/routes/messages/handler-v4.ts#L883)）× translator W3 首帧（CC 首帧到达）× `makeReconcilingSink` drop（[:997](../../../src/routes/messages/handler-v4.ts#L997)）。现状 reconcile 作用于**渲染后 client frame** 用 `isMessageStart` 判 type（Phase 2/3 review NIT-H 核实：translator 产出的 message_start 天然命中、**无需改识别逻辑**），但三者交互须 golden 锁双 message_start 不出现。

## 必读
- [RFC](../../rfc/2026-07-11-anthropic-via-openai-translation.md) **§7.2（心跳/reconcile 三方）、§8.1（正向 CC→Anthropic 流式状态机）**。
- [spec §7.2](../../spec/anthropic-via-openai-translation.md)（流式状态机映射）。
- [master plan Phase 4](../plan.md#phase-4流式两向-translator--handler-缝合最难-byte-critical)（T4.1-T4.4 + Phase 3 排入的 createResponseAccumulator 按腿分派）+ Phase 0/1/2/3 实施记录。
- [探针 PROBE-FINDINGS](../../../exp/anthropic-via-openai-translation/PROBE-FINDINGS.md)（cc 腿多 choices、toolu_ 透传；**流式帧形态未测——本 phase 用 golden 预捕获时探针实测 OQ1 流式 reasoning**）。
- skill `debugging-claude-client-connection`（300s 断连、event 行契约）、`ghc-anthropic-upstream`（thinking signature）、`large-refactor`（§4 golden-fixture 预捕获、§7 byte-critical 校准）、`empirical-verification`。
- 现有 **`src/lib/gemini/convert-stream.ts`**（`createGeminiStreamTranslator` 的 `renderFrame`/`flush`/`getMeta` 结构模板——**只借状态机结构，不借无心跳的 handler**）+ `src/lib/anthropic/sse-frame.ts`（anthropicSseFrame）+ `src/lib/anthropic/keepalive-anchor.ts`/`keepalive-frame.ts`。

## 目标
接上流式响应翻译，**现状 direct 流式逐字节零回归 + anthropic→cc 流式端到端打通 + 反向流式仍 Phase 5**：
1. CC→Anthropic 流式 translator（正向，renderFrame/flush/getMeta 自供）。
2. anthropic 入站 handler 缝合（心跳复用 + reconcile 三方 + 截断）。
3. cc 腿单跳 vs responses 腿二跳。
4. createResponseAccumulator 按腿分派（Phase 3 推来）。
5. 流式 reasoning 实测（OQ1 剩余）。

## Task（每个一 commit，每 commit 现状零回归 + 反向流式仍 fail-fast + 新单测过）

### T4.0 golden 预捕获（改动前，最关键）
- 写 direct anthropic 流式的 golden（改动前 HEAD 锁现状逐帧输出：message_start/content_block_*/message_delta/message_stop + 心跳帧 + anchor），确认**改动后逐字节不变**。这是 byte-critical 零回归的唯一硬证。

### T4.1 CC→Anthropic 流式 translator（正向）
- 建 `src/lib/openai/translate/cc-to-anthropic-stream.ts`（`createCcToAnthropicStreamTranslator`：`renderFrame`/`flush`/`getMeta`，结构抄 `gemini/convert-stream.ts`）。
- **getStreamMeta/flushResponse 本 translator 自供**（不委托 cc codec，WARN-C）。信号链：cc 内部翻译→CC 帧(带 finish_reason)→本 translator 累积→getMeta。
- **多 choices 折叠**（探针 cc 腿 text/tool 拆 choices）。
- **W1 block-index 分配器**：CC `tool_calls[].index`（0 基独立）→ Anthropic 单调递增单 index；前导 text 则 tool#0 落 index 1。**无 gemini 先例（gemini 一帧一 call 无 index 空间），off-by-one 源**，golden：text-then-多 tool。
- **W2 thinking-first**：开块逻辑 reasoning-aware，thinking 块排最前（即便 OQ1 暂不透传 reasoning 内容，reasoning delta 先到时须 thinking-first 否则错序）。
- **W3 message_start usage 占位**：CC 首帧无 usage → 首帧发 `input_tokens:0` 占位，message_delta 补正终值。**usage 净值约定**（复用 netInputTokens，Phase 3 B1 教训别重犯）。
- **N1 event-line**：所有合成帧经 `anthropicSseFrame`，golden `assertEventLineInvariant` 扫**全合成点**（message_start/content_block_*/message_delta/message_stop/error）+ **独立 Anthropic SDK oracle**（用真 @anthropic-ai/sdk 解析合成帧、验证可幸存——自洽 golden 抓不到 event-less 帧丢弃）。

### T4.2 anthropic 入站 handler 缝合
- 翻译分支：入站 CC acc（`onRenderedFrame` render 后帧累积，上游名进 complete）+ 出站 **Anthropic 心跳复用**（`makeAnchoredSseSink` + `resolveBufferedAndHeartbeat` + delayed-commit + prelude）+ 截断读 `getStreamMeta().finishReason`（F2，CC 源流末必带 finish_reason；未见→截断→writeSynthetic error→recordForwarded→ctx.fail，顺序 load-bearing）。
- **createResponseAccumulator 按腿分派**（Phase 3 推来 + RFC §4.1）：翻译腿上游是 CC 形，恢复 `createResponseAccumulator(env)` 签名、按 targetEndpoint 返 CC acc；审所有 pump 构造点。
- **reconcile 三方**（NIT-H）：现状 reconcile 作用渲染后帧、translator 产出 message_start 天然命中，无需改识别，但 golden 锁双 message_start 不出现。
- 重试栈类型（原写死 createAnthropicCodec）按腿泛化。

### T4.3 cc 腿单跳 vs responses 腿二跳
- cc 腿 = 单跳（上游 CC→cc-to-anthropic-stream）；responses 腿 = 二跳（上游 Responses→responses-to-cc-stream 现有→cc-to-anthropic-stream），getStreamMeta 信号链在 responses 腿是「Responses翻译→CC帧→累积」。

### T4.4 流式 reasoning 实测（OQ1 剩余）
- golden 预捕获时用探针实测 cc/responses 腿流式 reasoning 帧形态（是否流式回传 reasoning、形态），据此定 reasoning→thinking 映射（当前 best-effort，别强造无 signature 的 thinking 块）。

## 验收 gate
- 每 commit：`bun run typecheck` 绿 + `bun test` 全套件通过（预存在 UI 404 除外）+ **direct 流式 golden 逐字节全过**（T4.0 锁的现状）+ **Phase 0 router golden 52 全过**。
- 正向流式 translator：block-index 分配器（text-then-多 tool golden）、thinking-first、message_start usage、event-line 全合成点、多 choices。
- **独立 Anthropic SDK oracle**：真 SDK 解析合成流、验证 message/content_block/tool_use 可幸存（非自洽 golden）。
- 心跳缝合：翻译腿流式挂 Anthropic 心跳（reasoning 静默不撞 300s）。
- 反向流式仍 fail-fast（Phase 5 接）。

## 提交指引
`git commit -F <msgfile> -- <精确路径>`，conventional commits（feat/test），无模型署名。每 task 一 commit（T4.1/T4.2 大可再拆）。

## 红线（见 [README](README.md)）
- **byte-critical 死磕逐字节**：direct 流式 golden 逐字节等价是硬 gate，任何差异都是回归。
- **event-line 契约**：所有合成帧经 anthropicSseFrame，否则 SDK 静默丢帧——独立 SDK oracle 验证。
- **心跳复用 Anthropic 那套,不镜像 gemini 无心跳**（300s 断连）。
- **usage 净值**（复用 netInputTokens，别重犯 Phase 3 B1 的 hand-rolled 双计）。
- **反向流式仍 fail-fast**（Phase 5 接）——只解锁正向流式。
- no-auto-server；empirical-verification（流式 reasoning 探针实测、flaky 连跑 10-25 次确认时序确定性）。

## 若撞硬阻塞（这是最难的 phase，别硬编）
① block-index 分配器 off-by-one 无法在 golden 下收敛 ② 心跳缝合与 translator 的 message_start 三方交互产生双帧/anchor 悬挂 ③ 独立 SDK oracle 揭示合成帧被 SDK 丢弃且无法定位 ④ createResponseAccumulator 按腿分派牵连比预期广的接口 ⑤ responses 腿二跳 getStreamMeta 信号链断——**停下报告**，附具体 golden diff / SDK oracle 失败 / 帧序列，别自行改设计或放宽 byte-critical。
