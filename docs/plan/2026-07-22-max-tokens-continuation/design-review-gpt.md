# GPT 异模型设计复审：terminal ownership matrix M + Q5 三方叠加

## 总览

- **评审范围**：
  - `/home/xp/src/copilot-api-js/.worktrees/mt-design/docs/plan/2026-07-22-max-tokens-continuation/plan-M-terminal-ownership-matrix.md`
  - `/home/xp/src/copilot-api-js/.worktrees/mt-design/docs/plan/2026-07-22-max-tokens-continuation/plan-Q5-three-way-overlap.md`
  - 对照权威：`/home/xp/src/copilot-api-js/.worktrees/mt-design/docs/spec/2026-07-22-max-tokens-continuation.md` §5.3、§13 Q5，以及同目录 `README.md` Global Constraints。
- **已读取／执行的证据**：独立读取 `router.ts`、四类 handler、Responses WS handler、两类 codec translator、`driver.ts` buffered loop、`AnchorState`、anchor injector、delivery session、Responses commit-boundary 与 accumulator；审计 `anchorState.injected`／`anchorBlockOpen`／`anchorClosed` 的全仓写入与初始化；核对提交 `b8b5e7c2`、`54ecf327`、master 与 `feat/repetition-truncation` 的包含关系及分支 diff；运行 `bun test tests/pipeline/router-golden.it.test.ts tests/responses/responses-stream-accumulator.unit.test.ts`（81 pass，0 fail）和 `bun test tests/responses/ws-buffered.it.test.ts`（5 pass，0 fail）。
- **总体 verdict**：**存在 blocker；两份文档需先修订，不可按当前形态合并入 master。** Q5 的最高风险项——empty-text anchor 已注入后跨 continuation leg 不重置，以及 `wireIndex(i) = i + 1 + continuationOffset`——经独立全仓审计成立；阻断项来自 M 矩阵把独立配置控制的 buffered 路径写成无条件可达，导致默认 Anthropic 配置下即使启用本特性也进不了计划中的截获点。
- **blocker 数量**：1。
- **发现计数**：blocker 1，major 2，minor 1，nit 0。

## 事实性发现

### [blocker] M 矩阵把“条件选择 buffered”写成“该 leg 走 buffered”，但计划没有让 `max_tokens_continuation.enabled` 取得该路径，Anthropic P1 在默认配置下不可用

- **位置**：
  - `/home/xp/src/copilot-api-js/.worktrees/mt-design/docs/plan/2026-07-22-max-tokens-continuation/plan-M-terminal-ownership-matrix.md:22-40,56-67`
  - `/home/xp/src/copilot-api-js/.worktrees/mt-design/docs/plan/2026-07-22-max-tokens-continuation/plan-1-anthropic-continuation.md:12-20,94-129,173-189`
  - 生产代码：`/home/xp/src/copilot-api-js/.worktrees/mt-design/src/routes/messages/handler-v4.ts:1105-1112,1231-1289`
  - 默认值：`/home/xp/src/copilot-api-js/.worktrees/mt-design/src/lib/state-defaults.ts:76-94`
- **问题**：M 矩阵将 Anthropic direct 标成“Buffered？是／可挂载”，CC、Responses direct/fallback 也用同样的无条件措辞。但 handler 实际先读取另一组独立配置，只有 `buffered` 为真才调用 `runResponseBufferedSink`；否则走 `runResponseSink`。Anthropic 的 `protectStreamingGeneration` 默认是 `false`，而 max-tokens 配置只在 buffered opts 内接线，当前计划没有任何任务让启用 `max_tokens_continuation` 同时选择 buffered sink，也没有为 live sink 设计等价截获点。
- **证据或失败场景**：用户只做本特性的正常 opt-in——`max_tokens_continuation.enabled=true`，其余保持 bundled default——`resolveBufferedAndHeartbeat()` 仍返回 `buffered=false`，`pumpAnthropicStreamingV4` 走 `driver.runResponseSink(...)`。P1 计划新增的 `driver.ts` terminal-drain 截获分支只存在于 `runResponseBufferedSink`，因此永远不执行；客户端仍收到原始 `max_tokens` terminal。本特性的主目标在默认独立配置组合下无法使用。CC／Responses 当前 bundled default 恰为 buffered=true，但这只是当前默认掩盖问题；用户单独关闭其 buffered-retry 后，同一个功能也会静默失效。
- **建议**：在 M 中把每格拆成“当前选择条件”和“本特性启用后的唯一挂载契约”，并在 P1/P3 冻结一个明确决定。推荐让**有效配置确实要求同流续写时**强制选择 `runResponseBufferedSink`，即 buffered 选择条件为“原 buffered-retry 配置开启，或 effective max-tokens strategy 需要 stitch”；`enabled:false` 与全部 class 退化为 passthrough 时保持既有路径，守住零行为变更。若不愿复用 buffered sink，则必须为 `runResponseSink` 另设计 terminal withholding/interception seam，不能继续把“代码里存在一个条件调用”当成该 leg 已可挂载。三格式都应有生产 oracle：在原 buffered-retry knob 显式关闭时，仅开启 max-tokens continuation 仍能续写。

### [major] Responses HTTP direct／fallback 的截获点判定错误：terminal 已在 `commitBoundaries` 分支写到客户端，`:1336` terminal drain 来不及抑制

- **位置**：
  - `/home/xp/src/copilot-api-js/.worktrees/mt-design/docs/plan/2026-07-22-max-tokens-continuation/plan-M-terminal-ownership-matrix.md:95-115`
  - 特别是 `plan-M-terminal-ownership-matrix.md:103` 声称 max-tokens 必须只在 `driver.ts:1336` 截获，而不是块级 boundary。
  - 生产代码：
    - `/home/xp/src/copilot-api-js/.worktrees/mt-design/src/lib/codec/openai-responses/commit-boundaries.ts:5-24`
    - `/home/xp/src/copilot-api-js/.worktrees/mt-design/src/routes/responses/candidate-response-session.ts:138-151`
    - `/home/xp/src/copilot-api-js/.worktrees/mt-design/src/lib/pipeline/driver.ts:1240-1301,1327-1358`
- **问题**：Responses HTTP 的 `isResponsesCommitBoundary` 不只认中间 `response.output_item.done`；它明确把 `response.completed`、`response.failed`、`response.incomplete` 三种 lifecycle terminal 都当 boundary。`onRenderedFrame` 已先更新 accumulator，随后 driver 在 `:1240` 命中 boundary 并调用 `flushBufferedFrames`，把 `response.incomplete`（direct）或翻译产生的 terminal lifecycle（fallback）写到 sink；到 `:1336` 时 buffer 已清空。文档把“块级 boundary 只是中间 output_item.done”当作排除截获的理由，与实际 predicate 直接冲突。
- **证据或失败场景**：Responses direct 收到 `response.incomplete{reason:max_output_tokens}` 时，事件先在 candidate session 累积为 `acc.status=incomplete`，然后作为 boundary 在循环内立即 flush。计划若只在 terminal drain 前检查并 `continue`，客户端早已收到合法终局，续写帧再写入同一流会造成“双终局／终局后继续”，违反 transparent-stitch 的核心契约。fallback 中 CC `finish_reason=length` 经 renderer 生成 Responses lifecycle terminal，同样会在 boundary 分支提前写出。
- **建议**：重画 Responses HTTP direct/fallback 的③要素。可行修复是把 max-tokens terminal 判定放到 `commitBoundaries` flush **之前**，在 accumulator 已更新、frame 尚未写 sink 的位置决定“hold/suppress terminal 并启 continuation”；或让 effective max-tokens 模式下的 Responses commit predicate只提交中间 item boundary、把 lifecycle terminal留给 terminal drain。无论选哪种，都要加入 producer oracle，断言在 dispatch 第二轮之前 sink 从未收到首轮 `response.incomplete`／带 incomplete status 的合成 terminal。WS 由于故意不传 `commitBoundaries`，`:1336` 对 WS terminal-only 路径仍成立，不能把 HTTP 与 WS 写成同一个截获点结论。

### [major] 12 个 router 逻辑 cell 基本枚举齐全，但“全部运行时 leg”没有按客户端 transport 穷尽：遗漏 Responses WS fallback，且 WS `@messages` reverse 的现状未归类

- **位置**：
  - `/home/xp/src/copilot-api-js/.worktrees/mt-design/docs/plan/2026-07-22-max-tokens-continuation/plan-M-terminal-ownership-matrix.md:9-42,95-130,142-165`
  - 生产代码：
    - `/home/xp/src/copilot-api-js/.worktrees/mt-design/src/lib/pipeline/router.ts:79-105,111-169,269-309`
    - `/home/xp/src/copilot-api-js/.worktrees/mt-design/src/routes/responses/ws.ts:262-409`
    - `/home/xp/src/copilot-api-js/.worktrees/mt-design/tests/responses/ws-buffered.it.test.ts:487-515`
- **问题**：从 `decideRouteFromInput` 重建，矩阵列出的 4×3=12 个 `(clientFormat × routed targetEndpoint)` 逻辑 cell 是齐的；文档自身的“5 可挂载 + 4 不支持 + 3 不适用”也是 **12 格而非 11 格**。但 spec §5.3 和 README 明确要求 direct/translate/fallback/**WS** 运行时 leg，客户端 Responses WS 是独立 handler，不能只靠同一个 router cell 代表。当前 M 只单列了 Responses WS direct；没有列出运行时真实存在的 WS via-CC fallback。更重要的是，实测现有测试已经锁定“WS fallback stays LIVE”：它不进入 buffered sink。该事实与 M 中 Responses fallback“同一个 buffered 调用、可挂载”的概括不相容。WS 请求也允许模型后缀进入 router；`ws.ts:270-305` 把 `routeOverride` 传给 driver，因此 WS `@messages` reverse 是路由层可选 cell，但当前 WS pump 没有 HTTP handler 的 `reverseMessages` 分派，后续还按 Responses candidate snapshot 读取，至少应标成“路由可达但 handler 未接线／需先修复或明确拒绝”，不能从全 leg 矩阵消失。
- **证据或失败场景**：`tests/responses/ws-buffered.it.test.ts:487-515` 在 `responsesBufferedRetry:true` 下构造仅支持 `/chat/completions` 的模型，WS 请求确实走 fallback，并断言无 buffered telemetry、无重试；本次独立运行该测试文件为 5 pass。若按 M 把 Responses fallback 一律交给 HTTP 的 buffered 截获实现，WS fallback 不会命中，P3 却可能误报全覆盖。
- **建议**：保留 12 个 router cell 表，但再按“客户端 HTTP SSE／客户端 WS”展开 Responses 三个 target 的实际 pump：至少列 `WS direct`、`WS fallback`、`WS reverse @messages`。对 WS fallback据实标“当前 `runResponseSink`，本版本不支持或先补独立 buffered 接线”；对 WS reverse 先用现有集成测试／最小 handler probe确认当前是明确拒绝还是会在 candidate snapshot 处失败，再归入“支持／不支持／现存缺陷”。不要把“router cell 穷尽”与“handler/transport leg 穷尽”混为一件事。

### [minor] Q5 的 anchor 公式成立，但文档把有条件公式写成无条件“通用公式”，应显式限定为 empty-text anchor 已实际注入

- **位置**：`/home/xp/src/copilot-api-js/.worktrees/mt-design/docs/plan/2026-07-22-max-tokens-continuation/plan-Q5-three-way-overlap.md:60-78,93-115`
- **问题**：独立审计确认，在同一次 `runResponseBufferedSink` 调用内，只要 `anchorState.injected && anchor && anchorState.anchorBlockOpen` 已为真，状态不会因 retry、continuation leg 或 `onAttemptReset` 重置；此条件下 `wireIndex(i) = i + 1 + continuationOffset` 正确。但 `stream_keepalive_mode:empty_text` 只允许 idle injector 注入 anchor，不保证每个快速响应都实际注入。未发生 idle 注入时 `injected=false`，公式应为 `i + continuationOffset`；`enveloped_ping` 则 `anchorBlockOpen=false`，同样没有 `+1`。
- **证据或失败场景**：`anchorState` 在 handler `messages/handler-v4.ts:1063` 每个客户端请求构造一次，并在进入 driver 的循环前传入；driver `driver.ts:1049-1050` 只取这一个对象，continuation 分支 `:1440-1454` 只替换 `current/currentEnv` 后 `continue`，不重建 anchor state。全仓生产写入中，`keepalive-anchor.ts:233-258` 只把 `injected`／`anchorBlockOpen` 置为 `true`，没有任何置回 `false`；`driver.ts:1377,1430` 的 `onAttemptReset` 不接触 anchor；关闭动作只把 `anchorClosed` 置为 `true`，而 `AnchorState` 注释明确 `anchorBlockOpen` 在 index 0 被保留后持续为真。因此作者最关心的“隐藏 reset 导致 continuation 少算／多算”没有发生。边界仅是“是否曾实际注入”，不是“续写 leg 会否重置”。
- **建议**：把公式写成分段不变量：
  - `anchorShift = anchorState.injected && anchorState.anchorBlockOpen ? 1 : 0`
  - `wireIndex(i) = i + anchorShift + continuationOffset`
  - 一旦 `anchorShift` 在首轮变为 1，它在本次下游流余生保持 1；continuation/retry 不重置。
  Task Q5.3 的测试应显式制造 idle 注入并断言前置条件确实成立，另加无注入对照组，避免测试因没有真正点亮 anchor 却用错误 oracle。

## 已核实且可背书的作者结论

1. **CC via-responses 的翻译早于 accumulate**：成立。`openai-cc/codec.ts:202-206` 在 renderer 把 Responses frame 翻成 CC frame；candidate session 的 `onRenderedFrame` 随后在 `chat-completions/handler-v4.ts:339-355` 累积翻译后的 `ChatCompletionChunk`。`response.incomplete` 在 `responses-to-cc-stream.ts:127-130` 已映射为 `finish_reason=length/content_filter`。因此触发判据与 CC direct 可共用目标格式 accumulator，不需读取原始 Responses accumulator的额外适配层。
2. **Responses fallback 的翻译早于 accumulate**：成立。`openai-responses/codec.ts:260-265` 先调用 CC→Responses translator，`responses/candidate-response-session.ts:118-138` 再解析并累积 Responses event；`responses-to-cc-request.ts:460-466,507-527` 把 CC `length` 映射成 `status=incomplete + incompleteReason=max_output_tokens`。但“判据同构”不等于“截获点同构”；HTTP boundary 提前 flush 的 major 仍须修。
3. **CC `[DONE]` 天然只跑一次**：对当前和计划中的“driver 内部 `continue`、最终才 `return`”模型成立。`driver.ts:1161-1492` 只有一个外层 `for(;;)`；continuation 成功后在 `:1452-1454` 更新 offset并 `continue`，handler 只有在 `runResponseBufferedSink` resolve 后才执行 `chat-completions/handler-v4.ts:654` 的 `[DONE]` 写入。前提是新的 success-path 分支也保持循环内 `continue`，不得把每轮实现成 handler 多次调用 driver。
4. **最高风险项——anchor 不重置与公式**：在“empty-text anchor 已实际注入”的前提下成立。未发现 `anchorState.injected=false`、`anchorBlockOpen=false` 的运行时重置站点；retry／continuation 都在同一 driver 调用与同一 handler-owned state 上运行；`onAttemptReset` 不重建该对象。`anchorClosed=true` 只防二次 `stop@0`，不取消 index 0 的保留。因此 continuation leg 仍先 `+1`，再加 `continuationOffset`，不会因隐藏 reset 产生空洞或冲突。
5. **`incomplete_details.reason` 已在 P0 落地**：成立。提交 `b8b5e7c2` 在 master 上，新增 `ResponsesStreamAccumulator.incompleteReason` 与 `response.incomplete` 捕获；当前代码为 `responses-stream-accumulator.ts:137-141`，对应 unit test独立运行通过。
6. **重复截断事实更正**：成立。`5be18b83`／`4ec96a94` 均已在 master；`feat/repetition-truncation` 相对 merge-base `48fe9f59` 的 `src/` 唯一新增是 `src/lib/text-repetition/collapse.ts`。`collapseRepetition` 只被该分支的 unit test 导入，生产 `src/` 无消费者；提交 `54ecf327` 的“no consumers yet”自称已由独立 symbol grep证实。因此“spec 在 master、实现未合并且尚未接线”的更正可信。

## 主观建议

[建议] `plan-M-terminal-ownership-matrix.md` 全文 — 把“router cell”“客户端 transport leg”“上游物理 transport”三个维度分栏，不再用“Responses direct，HTTP/WS”一行同时表示不同 handler — 预期影响：避免后续再次把同一 targetEndpoint 下不同 pump 的 buffered/commit-boundary 语义误判成同构 — 推荐做法：先列 12-cell 路由表，再列实际 handler/pump 展开表，最后列上游 HTTP/WS 物理选择为非 ownership 维度。

[建议] `plan-Q5-three-way-overlap.md:68-78` — 保留当前数学推导，但把“代码结构保证”改成明确的前提—结论形式 — 预期影响：实施者更容易写出能咬住真实注入路径的正／负对照 oracle — 推荐做法：先断言 `anchorShift===1`，再断言 `anchor@0→real@1→continuation@2`；同时以 `anchorShift===0` 对照 `real@0→continuation@1`。
