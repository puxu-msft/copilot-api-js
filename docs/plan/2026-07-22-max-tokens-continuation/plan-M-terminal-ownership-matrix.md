# Plan-M: terminal ownership matrix（两轮审查共同点名的 plan 首要交付物）

> **地位：** 这不是一个可选文档任务——两位异模型 reviewer 独立收敛认定：没有这张矩阵，CC/Responses/WS 的 wire 拦截点无法唯一确定，P3 不能只靠 per-format PoC 蒙混过关（spec §5.3）。**P1 只需要 Anthropic 一格即可开工**（下表已给出，基于本次 planning 期亲自读码的结果，P1 实施时应先核对本表未变再动手）；**P3 开工前，CC / Responses(HTTP) / Responses(WS) 三格必须补全**，因为这三格目前的信息来自 planning 期调研，尚未被本特性的实现者亲自验证。

> 依赖：无代码依赖，但**信息依赖 P0 的分型判定器**（矩阵第②③要素要精确到「哪个判据触发拦截」，需要 `TruncationClass`/per-format 检测函数已定稿）。

## 矩阵定义（spec §5.3 四要素，逐 leg 一行）

对每个 `(inbound format × outbound client format × leg: direct/translate/fallback/WS)` 组合，明确：
- **①accumulatorSite** —— upstream completion 信号在哪一层被 accumulator 记录（哪个文件/字段）。
- **②terminatorConstructor** —— client-visible terminator 由哪个 codec/translator/handler 构造（哪个文件/函数）。
- **③interceptSite** —— transparent 分支必须在该构造**之前**在哪一层截获（哪个文件/位置，须早于②）。
- **④finalCompletionOwner** —— continuation 最终完成时**谁且只谁**发出唯一终局（避免双终局/漏终局）。

---

## Anthropic direct（`clientFormat=anthropic, targetEndpoint=/v1/messages`，bypass-direct leg）

**状态：本 planning 期已亲自读码确认，P1 直接可用。**

| 要素 | 内容 |
|---|---|
| ①accumulatorSite | `src/lib/anthropic/stream-accumulator.ts` `AnthropicStreamAccumulator.stopReason`（由 `message_delta.delta.stop_reason` 填充，`handleMessageDelta` 处理），`sawMessageStop` 标记 `message_stop` 已到达 |
| ②terminatorConstructor | 无需构造——Anthropic 是 bypass-direct（translate/render=identity），上游帧逐字透传。driver 的 terminal drain（`src/lib/pipeline/driver.ts:1336` `if (drained && (candidateOpts.sawMessageStop?.() \|\| candidateOpts.sawUpstreamError?.()))`）把缓冲的 `message_delta`+`message_stop` flush 给客户端（`:1348` `flushBufferedFrames(buffer, true, {cause:"terminal-drain"}, ...)`） |
| ③interceptSite | **在 `driver.ts:1336` 判断为真、`:1348` flush 之前**——即 terminal drain 分支内部，flush 调用前插入检测：`stopReason==="max_tokens"` + 分型可续（读 ledger 最后块）+ 预算未耗 → 不走这条 flush，转走续写触发（构造续写请求 → `coordinator.runContinuation` → 新 exchange 输出帧接续 index 写同一 buffer/sink，不 flush 首轮的 `message_delta`/`message_stop`） |
| ④finalCompletionOwner | 续写链最终轮再次抵达 `driver.ts:1336` 判断点，此时若其 `stopReason` 不是 `max_tokens`（或预算已耗尽被迫透传），走正常 flush——**这次 flush 就是唯一终局**，由同一段 driver 代码发出。若续写多轮都撞 `max_tokens` 且预算耗尽，藏不掉兜底：走正常 flush 透传最后一次真实 `max_tokens` 终止（诚实兜底，无需额外唯一性保证——正常 R1 路径本就只 flush 一次） |

**P1 实现要点（承重，spec §5.1 settle/finalize 时序契约必须先定，见 README Global Constraints）：** 这是**新增的成功终止截获**，master 现有续写触发点（`driver.ts:1401-1453`，cut path）不覆盖这里——`committedAny` 在这里的语义不同：cut path 触发于 `!drained`（异常抛出或截断），本特性触发于 `drained && sawMessageStop()` 为真之后（干净终止）。**不能复用 cut path 的 `canContinue` 门**（其判据含 `thrown ? classifyStreamError(thrown)==="other" : true`——本特性场景 `thrown` 恒为 `undefined` 且是正常 drain，此表达式在无 throw 时求值为 `true`，看似可通过，但**触发点必须挪到 terminal drain 分支内部**，而非复用 `retryable`/`canContinue` 所在的失败分支——两者是 driver `for(;;)` 循环内**互斥的不同代码路径**）。

---

## CC direct（`clientFormat=openai-cc, targetEndpoint=/chat/completions`）

**状态：本表基于 planning 期调研，P3 实施前须实施者亲自复核（矩阵完整性对 P3 是硬性前置条件）。**

| 要素 | 内容（planning 期调研结果，标注核实来源） |
|---|---|
| ①accumulatorSite | CC 是原生格式，无 translate；累积器 = CC 自身的 finish_reason 字段（driver 侧 `RunBufferedOpts.sawMessageStop`/`sawUpstreamError` 由 handler 提供的 accumulator 读取函数，`src/routes/chat-completions/handler-v4.ts:355-357` `sawMessageStop: (state) => state.acc.finishReason !== ""`） |
| ②terminatorConstructor | CC 无独立"构造终止帧"步骤——`finish_reason=length` 本就是上游原生帧字段，直接透传；客户端可见的流终止符是 `data: [DONE]`，由 `src/routes/chat-completions/handler-v4.ts` 的**post-loop 合成**（`[DONE]` synthesis，handler 在 driver outcome resolve 之后补写，非 driver 内部产出） |
| ③interceptSite | `commitBoundaries: (_state, frame) => ccCommitBoundaries(frame)`（`handler-v4.ts:357`）已使 CC 走块级缓冲（`ccCommitBoundaries` 目前只把上游 `error` 帧当边界，§P3 若要块级提交仍需姊妹 P5 的块边界扩展，本特性只需**成功终止**（`finish_reason` 非空的那一帧）截获——driver 的等价 terminal drain 判断点（`sawMessageStop`真）触发时插入检测，**但 `[DONE]` 由 handler 事后合成、不在 driver 内**，故截获点必须同时确保 handler 侧的 `[DONE]` 合成逻辑知道"这次不该发 `[DONE]`，因为还有续写轮" |
| ④finalCompletionOwner | **待核实（P3 前置）**：`[DONE]` 合成点在 handler post-loop（`src/routes/chat-completions/handler-v4.ts:628-654` 附近），driver 完成 outcome resolve 之后才跑——续写多轮时，只有**最后一轮**resolve 后 handler 才应合成 `[DONE]`。需要 handler 知道"driver 内部还在续写中、尚未到达最终 resolve" |

**P3 前置动作：** 实施者必须先读 `src/routes/chat-completions/handler-v4.ts` 的 `[DONE]` 合成完整逻辑（当前 planning 期只读到调用点附近，未完整追踪 driver outcome 与 handler post-loop 的时序契约），补全④要素，并写一个 producer-oracle 测试断言"续写进行中 `[DONE]` 不提前发出、只在真正最终 resolve 后发一次"。

---

## Responses HTTP direct（`clientFormat=openai-responses, targetEndpoint=/responses`）

**状态：本表基于 planning 期调研，P3 实施前须实施者亲自复核。**

| 要素 | 内容（标注核实来源） |
|---|---|
| ①accumulatorSite | `src/lib/openai/responses-stream-accumulator.ts` `ResponsesStreamAccumulator.status`（由 `response.incomplete` 事件填充，`accumulateResponsesStreamEvent` 的 `case "response.failed": case "response.incomplete":` 分支，`:126-130`），`incomplete_details.reason==="max_output_tokens"` 需要额外追踪该字段（当前 accumulator **未见**存储 `incomplete_details.reason` 本身，只存 `status`——**P0 Task 0.2 的 `isResponsesMaxTokensTerminal` 需要这个值，须确认 accumulator 是否已捕获或需要新增字段**） |
| ②terminatorConstructor | `src/routes/responses/handler-v4.ts` 直连路径：上游 `response.incomplete` 帧本身即客户端可见终止帧（Responses 是 bypass-direct 或接近——需核实是否 identity 透传还是有 handler 重新组装）。真实构造点标注在 `handler-v4.ts:470-490`附近的 truncation 处理段（当前读到的是"acc.status===''"时的兜底合成，非 `max_tokens` 正常终止路径的构造点——**该正常终止路径的确切构造代码位置待补** |
| ③interceptSite | 类似 Anthropic，须在 driver 的 terminal drain 判断（Responses 走 `sawMessageStop`等价物）触发、frame 真正 flush 给客户端**之前** |
| ④finalCompletionOwner | 待核实——Responses 的终局帧种类多（`response.completed`/`.incomplete`/`.failed`），续写最终轮结束时应发哪一个，需要与 A 类续写的"续到自然终止"语义对齐（自然终止对 Responses 而言是 `response.completed`） |

**P3 前置动作：** 完整读 `src/routes/responses/handler-v4.ts` 的 direct 路径（非 `viaFallback`）+ `responses-stream-accumulator.ts` 补 `incomplete_details.reason` 捕获（如缺失需新增字段，走 P0 Task 0.2 依赖修正）。

---

## Responses WS（`clientFormat=openai-responses, targetEndpoint=ws:/responses`）

**状态：仅骨架，P3-WS 子任务前必须补全（WS 传输时序是独立复杂度，姊妹 spec 的 plan-4-7 Task 6.2 已标注"WS 续写传输时序"是承重实现细节）。**

| 要素 | 内容 |
|---|---||
| ①accumulatorSite | 同 Responses HTTP（共用 `responses-stream-accumulator.ts`），但 WS 路径当前 `commitBoundaries` **故意省略**（`src/routes/responses/ws.ts:376-396`，terminal-only 提交）——本特性若要在 WS 上截获成功终止，只能在"整响应"粒度截获，无块级中间点 |
| ②terminatorConstructor | WS 下行帧的终止信号（`response.completed`/`.incomplete`），构造点待核实（handler `ws.ts` 内） |
| ③interceptSite | 待核实——WS 是长连接，续写在 WS 上的语义可能是"新上游轮重新派发"而非"同连接续写同一 HTTP response"（姊妹 spec plan-4-7 Task 6.2 已有此分析，本特性直接复用其结论：**WS 续写 = 新上游 turn 结果接同一 WS 下行流**，而非试图在同一个 HTTP response 帧序列里缝合） |
| ④finalCompletionOwner | 待核实，且与 WS 的 close-code 时序（`sendErrorAndClose`/1011）对齐——姊妹 spec 已列为"backlog 四点"，本特性若要支持 WS 续写需与姊妹 P6 Task 6.2 的实现协同（若姊妹已实现 WS 块级 + WS cut-path 续写传输时序，本特性直接复用其挂载点；若姊妹尚未实现，本特性的 Responses-WS 续写应**依赖姊妹先行**，不重复造轮子） |

**P3-WS 前置动作：** 核实姊妹 plan-4-7 Task 6.1/6.2 的实施状态（是否已 landed）。若未 landed，本特性的 Responses-WS 续写子任务应**阻塞在姊妹先行完成之后**，不重复设计 WS 传输时序——这是一处明确的跨特性依赖，须在 P3-WS 子任务头部显式标注「依赖姊妹 spec plan-4-7 Task 6.1/6.2 落地状态」。

---

## 矩阵收口任务

### Task M.1: 核实 + 补全 CC/Responses(HTTP)/Responses(WS) 三格

- [ ] 实施者亲自读 `src/routes/chat-completions/handler-v4.ts` 的 `[DONE]` 合成完整时序，补全 CC 行④。
- [ ] 实施者亲自读 `src/routes/responses/handler-v4.ts` direct 路径的 `max_tokens`/`incomplete` 正常终止构造点，补全 Responses HTTP 行②④；核实 `responses-stream-accumulator.ts` 是否已捕获 `incomplete_details.reason`，缺失则登记为 P0 Task 0.2 的前置修正。
- [ ] 实施者核实姊妹 spec Responses-WS 块级 + 续写传输时序的实施状态（`docs/plan/2026-07-22-continuation-retry-sequential-anchor/plan-4-7-remaining.md` Task 6.1/6.2），确认本特性 Responses-WS 续写的依赖边界。
- [ ] 每格核实后，用一个 producer-oracle 单测断言④要素（"唯一终局"不变量）——例如 CC：`test("continuation in progress does not emit [DONE] until the final resolve")`；Responses：`test("continuation stitches to response.completed as the sole final lifecycle event")`。
- [ ] **提交** → `docs(plan): fill terminal ownership matrix M (CC/Responses HTTP/WS verified)`。

**验收标准：** 四个 leg（Anthropic/CC/Responses-HTTP/Responses-WS）的四要素全部落实到具体 file:line + 对应的 producer-oracle 测试骨架（测试可以在 P3 才真正实现，但矩阵阶段必须写出测试的**断言目标**），P3 才能开工。
