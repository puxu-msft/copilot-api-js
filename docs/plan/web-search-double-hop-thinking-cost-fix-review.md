# 独立审查：imperative-hopping-twilight 修复方案

亲手读完方案 + handler.ts / web-search-handler.ts / orchestrator.ts / synthesize.ts /
thinking-signature-compat.ts / stream-accumulator.ts / request.ts / manager.ts /
pipeline.ts(request) / pipeline.ts(anthropic) / message-tools.ts + 4 个测试文件。
以下每条带 file:line 证据。

---

## 最严重的 3 个问题（排在最前）

### A. [VERIFIED 死代码] synthesize.ts 的 thinking 分支在两条路径上都永不触发 —— 是纯防御/文档价值，不修也不会有 corrupt thinking
裁决（点 6 明确）：**searched 路径永远不会让 synthesize 收到 thinking 块。**
- `webSearchResponseToEvents` 的唯一调用者是 web-search-handler.ts:129，且方案改造后**只在 searched 分支调用**（pass-through 重派不再走 synthesize）。
- searched 的响应来自 `buildWebSearchResponse`（synthesize.ts:74-105），其 content 只有 `server_tool_use` / `web_search_tool_result` / 可选 `text`（synthesize.ts:78-82），**结构上没有 thinking**。
- 第二跳的 thinking 也被丢弃：`collectText`（orchestrator.ts:214-219）只抽 `text` 块。
结论：synthesize.ts 的 `buildStartContentBlock` thinking 分支 + `buildContentBlockDelta` 的 Array 化（改动 3）**不解决本 bug 的任何已知触发场景**。真正消除 corrupt thinking 的是改动 1+2（pass-through 重派走 `processOneStreamEvent` 的 shim）。
建议：改动 3 可保留为"具示范价值的死代码"（CLAUDE.md 原则9 允许），但方案必须**诚实标注它是防御性、非 bug 修复路径**，不要把它列为修复的必要部分。`buildContentBlockDelta` 返回类型从 `StreamEvent|undefined` 改成 `Array` 纯为这个死分支服务——若要做就要顺带验证 text/tool_use 回归（见 D）。**强烈建议把改动 3 降级为"可选加固"或拆成独立提交**，避免与核心修复纠缠、避免 reviewer 误以为它在修 bug。

### B. [VERIFIED 可行，但方案措辞错误会导致实现踩坑] 重派必须传 `anthropicPayload`，不是 `originalSnapshot`
方案路径1 反复说"重派**原始** payload"（方案 line 15-18、32），措辞危险。亲手追证据：
- 正常直连路径在 handler.ts:221 传的是 **`anthropicPayload`**（已过 model 解析 + `processAnthropicSystem` + `preprocessAnthropicMessages`，**未过** `preprocessTools`）。
- `preprocessTools` 在 `handleDirectAnthropicCompletion` 内部才跑（handler.ts:300，经 `runInitialSanitizationAndRecord`）。
- web_search 分流点（handler.ts:215-219）传给 `handleWebSearchCompletion` 的就是 `anthropicPayload`；orchestrator 第一跳只 mutate 副本 `firstHopBase={...payload}`（orchestrator.ts:318-322），**不碰 `anthropicPayload` 本体**。
裁决：重派**必须复用同一个 `anthropicPayload`**（与 line 221 完全一致），这样 `preprocessTools` 只跑一次、system 只处理一次、`preprocessAnthropicMessages` 只跑一次。
风险：若实现者按方案字面去传 `originalSnapshot`（handler.ts:137），会**漏掉 `preprocessAnthropicMessages`**（strippedReadTag / dedup）且 system 未经 `processAnthropicSystem` → 行为与正常路径分叉。**方案必须把"原始 payload"改写为"传入 handleWebSearchCompletion 的同一个 anthropicPayload"，并显式说明不要用 originalSnapshot。**

### C. [BLOCKER for 测试，RISK for 实现] 重派让 mock 的 `firstHopDone` 状态机错位 —— 现有 web-search.http.test.ts 会假绿/假红
亲手追 mock（web-search.http.test.ts:132-147）：`/v1/messages` 第一次命中返回 first-hop body 并把 `firstHopDone=true`，**第二次及以后命中返回 `secondHopBody`**。
- pass-through 场景（`firstHopToolUse=false`，line 262-281）：probe 跑第一跳 → `firstHopDone=true` → 重派再打 `/v1/messages` → **mock 返回 `secondHopBody`（"TypeScript 5.9..."），而不是 `directHopBody`（"Direct answer, no search."）**。于是 line 278 的 `expect(body.content).toEqual([{type:"text", text:"Direct answer, no search."}])` 会失败，且 `messagesHits` 从 1 变 2。
- 方案 line 47 已意识到要"mock 区分 probe 调用与 re-dispatch 调用"+"更新 messagesHits 计数"，但**没说怎么区分**。当前 mock 用单一 `firstHopDone` 布尔，无法区分"第二跳"与"重派"——两者都是"第二次打 /v1/messages"。
必须补充：mock 需要按**请求特征**（如 payload.tools 是否含降级后的 `web_search` function tool，或 messages 是否含第二跳注入的 tool_result）区分 probe-vs-redispatch，而非靠调用序号。否则测试无法真正验证"重派路径走了直连 shim"。这是方案测试计划的最大盲区。

---

## 逐条审查

### 点 1 —— 重派 reqCtx 生命周期：[VERIFIED 安全]
追 RequestContext 状态机（request.ts）+ pipeline（pipeline.ts:235-279）：
- web_search 分流发生在 reqCtx **已 create（handler.ts:169）、已 setOriginalRequest（175）、已 setInboundRequestHeaders（184）、已 setToolNameMapper（192）、已 preprocessAnthropicMessages（203）之后**，但 reqCtx 仍是 `pending`、`settled=false`、`_attempts=[]`。
- probe 走 orchestrator → `callMainModel` → `runAnthropicPipeline({requestContext: undefined})`（orchestrator.ts:279）。pipeline 对 `undefined` reqCtx 跳过所有 `beginAttempt`/`transition`/`setAttempt*`（pipeline.ts:237/255/242 全是 `requestContext?.`）。**probe 完全不碰外层 reqCtx**——无 attempt、无 transition、无 settle。
- 重派 `handleDirectAnthropicCompletion(c, anthropicPayload, reqCtx, preprocessInfo)`：pipeline 用 reqCtx 跑，状态序列 `pending → executing（255）→ [streaming（dispatch 392-394）]→ completed`。**与正常直连请求完全同构**（handler.ts:221 那条路径就是这个序列）。
- `complete()/fail()` 由 `settled` 守卫（request.ts:99/302/329）；probe 没 settle，重派首次 settle，无双重记录、无双 history。
裁决：**不会状态机错乱，不会 history 双重记录。** 这是方案声称的最大风险点，实测证明可行。

唯一遗留观察（非 blocker）：probe 期间 reqCtx 停在 `pending` 且不在 `streaming`，stale reaper（manager.ts:140-158）按 `durationMs > maxAge` force-fail 与 state 无关——probe 慢于 `staleRequestMaxAge` 时会被 reaper fail，但这对正常直连同样成立，非重派引入的新问题。

### 点 2 —— probe 的 reqCtx 副作用：[VERIFIED 无污染]
同点 1 证据：`requestContext: undefined`（orchestrator.ts:279）。pipeline.ts:149 `reqCtx?.setAttemptWireRequest`、200 注释、237/242/255 全部 `?.` 短路。probe 跑完外层 reqCtx 仍是 `{state:pending, settled:false, attempts:[]}`。重派时 reqCtx 是干净初始态，handleDirectAnthropicCompletion 当作全新 reqCtx 使用完全成立。

### 点 3 —— original vs 已修改 payload：[RISK——见 B]
裁决见上方 B。补充：`preprocessInfo` 已在 handler.ts:205-208 算好，方案 line 20 称"可得"属实；重派直接复用即可，**不要重算**（重算 `preprocessAnthropicMessages` 会 double-strip）。

### 点 4 —— synthesize thinking 分支的累积器兼容：[VERIFIED 正确，但见 A 死代码]
若真给 synthesize 喂 thinking（实际不会，见 A），round-trip 成立：
- start `{type:thinking, thinking:""}` → `handleContentBlockStart` 播种 `{thinking:"", signature:undefined}`（stream-accumulator.ts:240-244）。
- `thinking_delta` → 追加 thinking（302-309）。
- `signature_delta` 单独发 → `handleContentBlockDelta` 接受（320-331）：block.type==="thinking" 通过，`b.signature = delta.signature`。**空 thinking 只发 signature_delta 是被接受的**（无需先有 thinking_delta）。
- 注意 stream-accumulator.ts:327-328：若 block 已有 signature 再收 signature_delta 会 `consola.error` 并覆盖——synthesize 的 start 必须发 `signature:""`（或不带 signature），否则触发该 error。方案 line 23 写的是"start `{thinking:""}`"未提 signature 字段，实现时**start 不能把 signature 嵌进去**（否则既触发 accumulator error 又重蹈 bug 覆辙）。

### 点 5 —— buildContentBlockDelta 返回类型改动波及：[VERIFIED 范围可控]
grep 确认 `buildContentBlockDelta`/`buildContentBlockStart`/`buildStartContentBlock` 均为 synthesize.ts 私有，唯一调用在 synthesize.ts:142。改 Array 只需改 line 142-143 发射循环。`webSearchResponseToEvents` 唯一外部消费者是 web-search-handler.ts:129。
回归点：text 分支（synthesize.ts:179-182，空 text 返回 undefined→Array 化后要返回 `[]`）、tool_use/server_tool_use 分支（184-189）、result 分支（192 返回 undefined→`[]`）的现有行为必须保持。synthesize.unit.test.ts:229-250 的 round-trip 覆盖 server_tool_use+result+text，是回归守卫——**Array 化后这条测试必须仍绿**。

### 点 6 —— searched 路径是否有 thinking：[VERIFIED 死代码——裁决见 A]
明确：两条路径都不会让 synthesize 收到 thinking。改动 3 是纯防御。

### 点 7 —— ping 时序 / 流式错误处理回归：[RISK——searched 路径需保持，pass-through 路径变化合理]
- searched 流式：方案 line 33 说"进入 streamSSE、发首个 ping、跑 completeWebSearch、按现状假流"。必须保持 web-search-handler.ts:72-101 的时序：`transition("streaming")` → `streamSSE` → `writeSSE(ping)` → orchestrate → 错误则 `error` event。现有断言 web-search.http.test.ts:252-253（ping 在 message_start 前）、328-349（hard fail → error event）必须仍绿。
- **关键风险**：方案要把 `orchestrateWebSearch` 拆成 `runFirstHopProbe` + `completeWebSearch`。**probe 在 streamSSE 之前跑**（line 31 "尚未欠客户端字节"），那么 searched 流式的 ping 现在是在 probe **之后**才发——而原实现 ping 在**整个 orchestrate（含第一跳）之前**发。即：searched 流式下，客户端拿到首字节（ping）的时间从"第一跳前"推迟到"第一跳后"。第一跳是一次完整非流式模型调用（可能数秒~数十秒），**这会显著推迟 headers flush，正是原 ping 设计要避免的（web-search-handler.ts:69-71 注释）**。
  - 这是方案未提及的 searched 路径**时序回归**。pass-through 不受影响（它根本不进 streamSSE，由 handleDirectAnthropicCompletion 真流式）。但 searched 流式会变慢首字节。
  - 缓解选项（方案需补充决策）：searched 流式仍先进 streamSSE 发 ping，再在流内跑 probe+complete；即 probe 只为"分流决策"服务，但分流后若是 searched 就已经发过 ping 了。问题是 pass-through 需要在 streamSSE **之外**重派（才能让 handleDirectAnthropicCompletion 自己接管 streamSSE）——一旦进了 streamSSE 就回不了头。**这是真实的设计张力：probe 必须在 streamSSE 外（为了 pass-through 能重派），但这样 searched 流式就丢了"第一跳前发 ping"。** 方案必须明确接受 searched 流式首字节延迟，或设计两段式（先发探测性 ping 再决策——但 Hono streamSSE 一旦返回就锁定响应）。**列为必须澄清的决策点。**

### 点 8 —— 测试盲区：[多项缺失]
1. **C（mock 无法区分 probe vs redispatch）** 是最大盲区，已详述。
2. **reqCtx 状态机断言缺失**：方案测试计划没有断言"pass-through 重派后 history 只有一条 entry、attempts 来自重派而非 probe、state 序列正确"。应加一条 it 测试：pass-through 后 `getHistory` 返回单条 entry，且 `inboundResponse.sseEvents` 含 shim 后的 signature_delta（证明走了 processOneStreamEvent）。
3. **pass-through + thinking 的端到端**：真正验证 bug 修复，需要一条 http 测试：webSearchEnabled=true + 请求带 WebSearch tool + 第一跳不搜索但**第二次（重派）upstream 返回 embedded-signature thinking 帧**（复用 thinking-signature-compat.http.test.ts 的 `buildEmbeddedSigThinkingFrames`）→ 断言客户端收到 `signature_delta`、无双空块。**这才是直接证明"不再有 corrupt thinking"的测试，方案 line 47 提了但没说要喂 thinking 帧。**
4. **probe 非流式强制**：应断言 pass-through 时 probe 用 `stream:false`（即使客户端 `stream:true`），重派才用客户端真实 stream 标志。
5. **double-billing/usage**：pass-through 现在跑 probe（一次完整模型调用，计费）+ 重派（又一次）。方案 line 55-56 承认这个权衡，但**没有测试断言 usage/history 如何记录这两次调用**——probe 的 token 消耗是否计入？probe `requestContext:undefined` 意味着 probe 的 usage **完全不进 history/telemetry**。这是"诚实代价"被静默吞掉：用户付了 probe 的 token 但 history 只显示重派那次。**原则3（完整记录原始信息）要求至少把 probe 的 usage 作为 warning 记入 reqCtx**，方案未提。**列为必须补充。**

---

## 方案必须补充/修正的点（清单）

1. **[B]** 把"重派原始 payload"改为"重派传入 handleWebSearchCompletion 的同一 `anthropicPayload`"，显式禁止用 `originalSnapshot`；说明 `preprocessTools` 在 handleDirectAnthropicCompletion 内只跑一次。
2. **[C]** mock 区分 probe-vs-redispatch 的**机制**要写明（按 tools/messages 特征，非调用序号），否则现有 http 测试无法移植。
3. **[点7]** 明确接受或解决 searched 流式"首字节延迟到第一跳后"的时序回归——这是 probe 外置的必然代价。
4. **[A]** 把 synthesize.ts thinking 分支（改动 3）诚实标注为防御性死代码，与核心修复解耦；说明它不触发本 bug 任何场景。
5. **[点4]** synthesize thinking start 必须发 `signature:""`（不嵌 signature），否则触发 stream-accumulator.ts:327 的 error + 重蹈 bug。
6. **[点8.5/原则3]** probe 的 usage 必须记入 history（warning 或合并计费），不能因 `requestContext:undefined` 被静默丢弃——用户为 probe 付费却看不到。
7. **[点8.3]** 加端到端 http 测试：pass-through 重派 + upstream 返回 embedded-sig thinking → 客户端收 signature_delta（直接证明 corrupt thinking 消失）。
8. **[点8.2]** 加 reqCtx 状态/history 断言：pass-through 后单条 entry、attempts 归属重派、forwardedResponse 反映 shim。

## 整体裁决
核心思路（pass-through 重派走直连 shim）**架构正确且 reqCtx 生命周期实测安全**（点1/2 VERIFIED）。但方案有：1 个措辞陷阱（B，会导致实现传错 payload）、1 个测试 BLOCKER（C，mock 无法区分两次调用）、1 个未提及的 searched 流式时序回归（点7）、1 个被静默吞掉的 probe 计费可观测性缺口（原则3）、以及把"防御性死代码"误列为修复必要部分（A）。在补齐上述 8 点前不宜进入实现。
