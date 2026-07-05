# 修复：web_search 双跳破坏 thinking 块 + 令每个 Claude-Code 请求付出双跳代价

## 背景

**Bug（经三层运行时诊断 + pid 归因彻底定位）。** copilot-api 代理 Anthropic `/v1/messages`。`web_search` 双跳特性（config `web_search.enabled: true`）拦截任何携带 Claude Code `WebSearch` 工具的请求。Claude Code **每个请求**都声明 `WebSearch`，所以特性开启时**所有请求**都被拦截，绕过正常的 `handleDirectAnthropicCompletion → processOneStreamEvent` 路径——而 thinking-signature shim（`applyThinkingSignatureCompat`）正接在那里。

拦截后总是用 `webSearchResponseToEvents`（[synthesize.ts:120](../../src/lib/anthropic/web-search/synthesize.ts)）把响应重新编码成一次性假 SSE 流。对 thinking 块，`buildStartContentBlock`（[synthesize.ts:170-174](../../src/lib/anthropic/web-search/synthesize.ts)）没有 `thinking` 分支 → 把 `{thinking, signature}` 直接嵌进 `content_block_start`，且**不发 `signature_delta`**。标准客户端忽略 start 上的嵌入签名、丢弃它、回传 `{thinking:"", signature:""}`——这就是堆积的双空块，触发 `[Sanitizer:Anthropic] Removed N corrupt thinking`。

**经 live history.db 实测确认：** thinking 块只出现在 **pass-through**（模型选择**不**搜索 → block 序列 `thinking,text,tool_use`、无 search warning）情况。真实搜索路径的 `buildWebSearchResponse` 只组装 `server_tool_use/web_search_tool_result/text`。所以最常见的情况——大多请求不搜索——白白付出双跳 + 假流代价：真实逐 token 流式坍缩、tool_use 流式压扁、thinking 签名损坏。

**目标产出：**（A）不再有 corrupt thinking；（B）非搜索请求不再付假流代价。特性对真实搜索仍正常工作。

## 方案——按 `searched` 分流的双路径设计

### 路径 1 —— pass-through（`searched:false`）：重派原始请求
第一跳返回无 `web_search` tool_use 时（[orchestrator.ts:330](../../src/lib/anthropic/web-search/orchestrator.ts)），**不合成**。把客户端**原始** payload 经 `handleDirectAnthropicCompletion`（[handler.ts:229](../../src/routes/messages/handler.ts)）重新发出，尊重客户端真实 `stream` 标志。一条已正确的路径即交付：真实流式、thinking-signature shim、正确 tool_use 流式、server-tool 过滤、tool-name 还原、重复检测、完整 history。

**为何重派原请求（而非复用第一跳响应）：** 第一跳跑在*替换后*的工具集上（`toFirstHopTools` 把 native/`WebSearch` 换成普通 `web_search(query)` function tool）+ 缩减版 sanitize。其输出无法作为正确的客户端答案。重派则在真实工具、真实 stream 标志、完全正确的管线上作答（原则8 根因、原则7 单一数据源）。

**机制可行（已验证）：** `handleDirectAnthropicCompletion(c, payload, reqCtx, preprocessInfo)`——所有参数在 web_search 分流处都可得；`preprocessInfo` 已在 [handler.ts:203](../../src/routes/messages/handler.ts) 算好。`dispatchAnthropicResponse` 已按 `Symbol.asyncIterator` 分流 stream/non-stream。

### 路径 2 —— 真实搜索（`searched:true`）：保留合成 SSE，但令其正确
合成的 `server_tool_use → web_search_tool_result → text` 块必须到达客户端（这是特性目的）。保留 `webSearchResponseToEvents`，但**在 synthesize.ts 原生加固**，使它收到的任何 thinking 块都产出正确帧（start `{thinking:""}` + `thinking_delta` + `signature_delta`；`redacted_thinking` → start 携带 `data`）。纵深防御。

**单一权威来源：** 合成原生产出正确帧——**不**经 `applyThinkingSignatureCompat` 后过滤，因为该 shim 受 `state.thinkingSignatureCompat` 门控（可为 `false`/`redacted_thinking`），合成的正确性不应依赖客户端兼容开关。shim 留在直连路径——那里的畸形帧来自**上游**（一个真正不同的问题）。

## 改动

1. **[orchestrator.ts](../../src/lib/anthropic/web-search/orchestrator.ts)** —— 把 `orchestrateWebSearch` 拆成 `runFirstHopProbe(args) → {firstResponse, toolUse?, searchCount}`（仅第一跳）和 `completeWebSearch(args, probe) → WebSearchOrchestrationResult`（搜索 + 第二跳 + 合成）。`orchestrateWebSearch` 保留为薄组合，使现有 orchestrator 测试不变即过。

2. **[web-search-handler.ts](../../src/routes/messages/web-search-handler.ts)** —— `handleWebSearchCompletion` 先跑 `runFirstHopProbe`（非流式，尚未欠客户端字节），再分流：
   - pass-through → `return handleDirectAnthropicCompletion(c, originalPayload, reqCtx, preprocessInfo)`
   - searched → 进入 `streamSSE`、发首个 `ping`、跑 `completeWebSearch`、按现状假流合成事件（非流式 searched → 按现状 `c.json`）。

3. **[synthesize.ts](../../src/lib/anthropic/web-search/synthesize.ts)** —— `buildStartContentBlock` 加 `thinking` + `redacted_thinking` 分支；`buildContentBlockDelta` 泛化为返回 `Array<StreamEvent>`（thinking → 可选 `thinking_delta` + `signature_delta`）；更新发射循环（[synthesize.ts:139-146](../../src/lib/anthropic/web-search/synthesize.ts)）。

4. **[handler.ts](../../src/routes/messages/handler.ts)** —— 导出 `handleDirectAnthropicCompletion`；把 `preprocessInfo` 传入 web_search 分流 + `handleWebSearchCompletion` 签名。

## 复用（不写新转发逻辑）
- pass-through 整体复用 `handleDirectAnthropicCompletion`——绝不重新实现转发。
- 复用 orchestrator hop 机制；仅拆 probe/complete。
- 在 synthesize.ts 写原生 thinking 分支；不在那里复用 compat shim。

## 测试（镜像 tests/anthropic/web-search/ + 项目后缀约定）
- **synthesize.unit.test.ts（扩展）：** thinking → start `signature:""` + `thinking_delta` + `signature_delta`；`redacted_thinking` → start 携带 `data`；accumulator round-trip 保住签名。
- **orchestrator.it.test.ts（扩展）：** `runFirstHopProbe` 无搜索 → 无第二跳 / 无 `/responses` 调用；现有测试经组合保持绿。
- **web-search.http.test.ts（扩展——关键）：** mock 区分 probe 调用与 re-dispatch 调用；断言 pass-through 客户端收到 `signature_delta`（证明直连路径 shim 跑了）+ 逐 token deltas，绝不出现畸形嵌签名帧。更新现有无搜索测试的 `messagesHits` 计数（现在 probe + re-dispatch）并加注释。搜索路径测试保持绿。复用 `dataFramesOfType` helper。

## 验证
- `bun run typecheck` + `bun run lint:all` 干净。
- `bun test tests/anthropic/web-search/` + `tests/anthropic/thinking-signature-compat.http.test.ts` 全绿。
- 完整 offline：`bun run test:backend`（0 fail）。
- 手动（用户重启服务器）：一个非搜索 Claude-Code 请求逐 token 流式、不产生 corrupt thinking；一个搜索请求仍返回可见结果。

## 接受的权衡
pass-through 现在花 probe + 真实调用（两次模型调用），与搜索路径对称。这是"让模型决定是否搜索、同时给非搜索请求正确流式"的诚实代价。probe 被强制 `stream:false` + 工具替换，其结果确实无法复用为客户端答案。（用户已确认选此最高质量方案。）

---

## 独立 subagent review 修正（已亲手复核每条）

经 subagent double review + 主线亲手核对代码，方案修正如下（reviewer 报告存于 `imperative-hopping-twilight-agent-a3be8b45772d7e288.md`）：

- **[B 措辞陷阱——必改] 重派传 `anthropicPayload`，绝不用 `originalSnapshot`。** 亲手核对 [handler.ts:221](../../src/routes/messages/handler.ts)：正常直连传的就是 `anthropicPayload`（已过 model 解析 + `processAnthropicSystem` + `preprocessAnthropicMessages`，**未过** `preprocessTools`——后者在 `handleDirectAnthropicCompletion` 内部 [handler.ts:300] 才跑）。重派必须复用同一个 `anthropicPayload` + 已算好的 `preprocessInfo`（[handler.ts:203]），**不要重算** preprocess（否则 double-strip）。probe 只 mutate 副本 `firstHopBase={...payload}`（orchestrator.ts:318），不碰 `anthropicPayload` 本体。

- **[A 死代码裁决——降级] synthesize.ts thinking 分支（原改动3）在新架构下是防御性死代码。** 亲手核对：searched 路径响应来自 `buildWebSearchResponse`（synthesize.ts:78-82，只含 server_tool_use/result/text）；第二跳 thinking 被 `collectText`（orchestrator.ts:214-219，只抽 text）丢弃；pass-through 重派后不走 synthesize。**真正修复 corrupt thinking 的是改动 1+2（重派走直连 shim），改动 3 不触发本 bug 任何场景。** 决定：**改动 3 仍做但诚实标注为防御性加固**（原则9 允许示范价值死代码；synthesis 未来若携带 thinking 即正确）——拆为独立小提交，不与核心修复纠缠。若做，start 必须发 `signature:""`（**不嵌 signature**，否则触发 [stream-accumulator.ts:327] 的"已有 signature 再收 signature_delta" error + 重蹈 bug）；`buildContentBlockDelta` Array 化须保持 text/tool_use/result 现有行为（[synthesize.unit.test.ts:229] round-trip 回归守卫）。

- **[C 测试 BLOCKER——必补] mock 按请求特征区分 probe vs re-dispatch。** 现有 [web-search.http.test.ts:132-147] 用单一 `firstHopDone` 布尔，第二次打 `/v1/messages` 一律返回第二跳 body。重派是"第二次打 `/v1/messages`"会拿错 body。必须改 mock：按 payload 特征区分——probe 的 tools 含降级后的 `web_search` function tool（`toFirstHopTools` 产物），re-dispatch 的 tools 是客户端原始 `WebSearch`；或按 messages 是否含第二跳注入的 tool_result。**不能靠调用序号。**

- **[点7 时序——接受 + 缓解] searched 流式首字节（ping）从"第一跳前"推迟到"第一跳后"。** 这是 probe 必须在 `streamSSE` 外跑（pass-through 才能重派）的必然代价——一旦进 `streamSSE` 就锁定响应、无法重派。裁决：**接受**。理由：(1) pass-through（最常见）反而更快拿到*内容*（真流式 vs 旧的等全部完成）；(2) 仅 cosmetic ping 延迟到一跳后，单跳极少超过 undici 5min idle 超时；(3) searched 路径进 `streamSSE` 后仍立即发 ping（保持 [web-search-handler.ts:78] 时序），只是 streamSSE 进入点本身晚了一个 probe。缓解：probe 用 `clientAbortSignal` 串联，客户端断开即中止。

- **[点8.5 原则3——必补] probe 的 usage 必须记入 history。** probe 走 `requestContext:undefined`，其 token 消耗当前完全不进 history/telemetry——用户为 probe 付费却看不到（违反原则3）。补：把 probe 的 usage 作为结构化 warning（参照 [web-search-handler.ts:146] `recordSearchWarning` 模式）记入外层 reqCtx，或合并进最终计费。

- **[reqCtx 生命周期——VERIFIED 安全] 重派不会状态机错乱/双重 history。** 亲手核对：probe `requestContext:undefined` 全程 `?.` 短路（pipeline.ts:237/255），跑完外层 reqCtx 仍 `{pending, settled:false, attempts:[]}`；重派让 reqCtx 走 `pending→executing→streaming→completed`，与正常直连同构；`complete/fail` 有 `settled` 守卫（request.ts:99/302/329）。方案声称的最大风险点实测可行。

## 测试补充（在原测试计划上增加）
- **pass-through + thinking 端到端（关键，直接证明 bug 消失）：** webSearchEnabled + 请求带 WebSearch tool + probe 不搜索 + **重派的 upstream 返回 embedded-sig thinking 帧**（复用 thinking-signature-compat.http.test.ts 的 `buildEmbeddedSigThinkingFrames`）→ 断言客户端收到 `signature_delta`、无双空块。
- **reqCtx 状态/history 断言：** pass-through 后 `getHistory` 单条 entry、attempts 归属重派、`inboundResponse.sseEvents` 含 shim 后的 signature_delta（证明走了 processOneStreamEvent）。
- **probe 强制非流式：** 断言 probe 用 `stream:false`（即使客户端 `stream:true`），重派才用客户端真实 stream 标志。
- **probe usage 记录：** 断言 probe 的 token 消耗以 warning/合并计费形式可见。
