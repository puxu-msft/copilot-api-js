# 修复 ui-v4 Response 标签页信息错位 + 后端 proxy→client 数据缺失/错位

> **实施状态：已完成**
> **落地**：7302854
> **现状锚点**：DESIGN「响应腿数据模型」段；`src/lib/context/request.ts` fail(upstreamSucceeded)/_failureReason + client-sink writeSynthetic
> **备注**：Phase 1（forwarded 忠实记录合成帧）+ Phase 2（outboundResponse 数据模型修）均落地

## Context（为什么做）

ui-v4 请求详情页 **Response** 标签页在失败请求（典型：AskUserQuestion 的 tool input 无法修复 → `unrepairable malformed tool_use input`）上信息组织错位：代理产生的失败结论被埋进 / 混淆进 "Upstream → Proxy" 腿，且**流式响应根本不渲染 "Proxy → Client" 节**。用户要求：加 proxy→client 节、正确组织所有信息；并全面检查后端内容缺失/错位并**重构修复**。

已用实测（活实例 4141 + 真实 entry `req_1783070660245_128`）+ 两轮对抗 subagent review 逐行确认根因，并经用户裁决取**源头修**方案：

- **后端错位（用户已确认修数据模型）**：`ctx.fail()` 把**代理引入的失败结论**（如 `unrepairable`）写进了 `outboundResponse.error` 且置 `success:false`——而上游腿实际返回 **200 完整流**（`entry.sseEvents` 止于 `message_stop`）。这正是用户看到的"错误结构体显示在 upstream→proxy 节"的根因。
- **后端缺失（用户已确认记录）**：客户端**实际收到**的合成终止 error 帧（`sink.writeSynthetic`）**不进** `inboundResponse.sseEvents`。真实 entry forwarded 轨 95 帧止于 `message_stop`、**无 error 帧**。
- **前端**：`hasForwarded` 只认非流式 `.content`，流式 `.sseEvents` 永不渲染 forwarded 节；失败结论未突出呈现。

## 已验证的关键事实（两轮 review 逐行确认）

- **快照时点（BLOCKING）**：`ctx.fail()`（`src/lib/context/request.ts:492-537`）在 `:529` 同步调 `toHistoryEntry()` 读 `_forwardedResponse`（`:611-613`）→ 发 `request.failed`（冻结 entry）；history sink `onTerminal`（`src/lib/observability/sinks/history.ts:236-286`）持久化 `event.entry.inboundResponse`（`:254`）+ `finalizeEntry` 只压缩内存 entry、**不再读 ctx**。故 **`ctx.fail()` 之后**的任何 `setForwardedResponse` 对持久化不可见——这解释了为何 messages handler 已有 `finally{recordForwarded()}`（`:1092`）仍丢帧（真实 entry 实证）。→ **`finally` 方案无效**，合成帧必须在 `ctx.fail/complete` **之前**记进 forwarded 快照。
- **`recordForwarded` 早于 `writeSynthetic`（BLOCKING）**：CC `handler-v4.ts:376/380`+`394/399`、responses `315/319`+`352/357`、gemini `294/304`+`330/335`、WS `ws.ts:337→342`+`369→374`；messages 用 `finally`。全部错序。
- **`outboundResponse.status` 仅 HTTPError 才设**（`request.ts:514`）→ 流式成功/代理失败均 `status===undefined`。故"按 status 判 ok/fail"会把成功流误标 fail（P8 弃用）。
- **WS**：`makeWsSink`（`client-sink.ts:208-221`）无 `writeSynthetic`，error 经 `sendErrorAndClose`→`ws.send`（`ws.ts:125-141`，send 在 `close(1011)` 前，best-effort try/catch）绕过 sink。
- **web_search 旁路**：`web-search-handler.ts` 失败分支 `fail`（:185）后写 error 帧（:187），且**失败分支从不调 `setForwardedResponse`**（仅成功 :248）→ 失败请求 forwarded 轨全丢（含 pings）。
- **仅 2 个 Anthropic 分支是"上游成功、代理拒绝"**：`unrepairable`（`handler-v4.ts:1046-1062`）、refusal-error（`:1023-1045`）+ 各自非流式对偶（`renderNonStreamingV4` `:702-725`）。truncation/H3/H2/HTTP-error 的 `success:false` 是**诚实的**（上游真失败），**不改**。
- **sink 采样是 enqueue 前同步**（`write`:152、ping:180），"recorded == attempted-to-send"。合成帧采样须同款（不引入 post-ack 一次性规则）。
- 无关不变量安全：`streaming-l2-baseline.http.test.ts` 读 SSE **wire**（非 history）不受影响；heartbeat/`runResponseBufferedSink` 不动。

## 计划

### Phase 1 — 后端：forwarded 轨忠实记录合成终止帧（root-cause，全格式一致）

1. **`client-sink.ts`**：`makeSseSink.writeSynthetic`（`:158`）改为 `sampleForwarded(frame); return writeSse(frame)`（与 `write` 同款、enqueue 前同步采样）。`makeWsSink`（`:208`）加 `writeSynthetic`（= `write` 同款采样 + `ws.send`）。更新顶部"采样非对称/B0-c"注释为"合成终止帧属 proxy→client，一并采样"。
2. **各 handler 分支重排为 `writeSynthetic → recordForwarded → settle`**（合成帧必须在 `ctx.fail/complete` 前进快照）：CC / responses / gemini / messages 的 stream-error + truncation 分支、messages 的 unrepairable + refusal-error 分支。合成写 best-effort（`.catch(()=>{})`，采样已在 enqueue 前发生，故 settle 恒执行）。保留既有 `finally{recordForwarded()}` 作安全网（fail 后再快照无害）。
3. **WS**（`ws.ts`）：`sendErrorAndClose` 内把该帧 push 进 `forwardedSseEvents`（或经新 `makeWsSink.writeSynthetic`）；各 error 分支重排为 send-error → `recordForwarded` → `ctx.fail`。
4. **web_search 旁路**（`web-search-handler.ts`）：失败分支补 `setForwardedResponse({sseEvents: forwarded})`（含合成 error 帧 + 前缀 pings），修"失败请求零 forwarded 轨"。

### Phase 2 — 后端：数据模型修（源头修 outboundResponse 错位，用户已定）

目标：`outboundResponse` 忠实反映**上游腿**；代理判定的失败结论只进 `state` + `failureReason`。

1. **`request.ts` `fail()`**：加选项参数 `opts?: { upstreamSucceeded?: boolean }`。为真时：`_response = { success:true, model, usage, content: partial.content, stop_reason }`（**无 error 字段**、诚实上游腿），并置新私有 `_failureReason = getErrorMessage(error)`；为假/缺省时保持现状（真上游失败仍 `success:false`+error）。
2. **failureReason 投影**（`request.ts:602-609`）：改为 `_failureReason ?? _response?.error ?? _attempts.at(-1)?.error?.message`。`request.failed` 事件 error（`:534`）同源改读该投影。
3. **调用点**：messages 的 unrepairable + refusal-error 两分支（及非流式对偶 `renderNonStreamingV4` refusal-error）传 `{ upstreamSucceeded: true }`，`partial` 用 `buildAnthropicResponseData(acc,model)`（上游 content/usage/stop_reason）。
4. **消费端核验**（多数已回退 failureReason，无需改）：`serialize.ts:231` error_message（`outboundResponse?.error ?? failureReason`）✓、`in-flight.ts:159` ✓、`debug/route.ts:91`（error undefined → token-limit 解析返 null）✓、reaper 分桶按 `status` 列=state（仍 failed）✓。**核验**：console sink 状态行与任何按 `outboundResponse.success` 计成功的遥测/指标不把这 2 类误计成功（用 state 驱动）。
5. **非流式 refusal-error forwarded 错位**（MEDIUM-2）：`renderNonStreamingV4` 现 `setForwardedResponse({content: 上游 content})`（`:708`）但客户端实收 500 error body（`:710`）→ 改为记录**客户端实收的 error body** 进 `inboundResponse.content`（与流式一致，忠实 proxy→client）。

### Phase 3 — 前端：ResponseSegment 重组 + DiagnosticBar

`ui-v4/src/components/detail/segments/ResponseSegment.tsx`：
1. **Outcome 结论**（新，非成功终止态）：突出 `entry.failureReason ?? outboundResponse?.error` + `state`，`statusSignal` 配色。
2. **Upstream → Proxy**：数据模型修后 `outboundResponse.success/status` 已诚实反映上游腿——直接按 `success`/`status` 显示（成功流 → ok），无需前端反推。content→`MessageBlock`，否则 `rawBody ?? responseText ?? error`。
3. **Proxy → Client**（补齐）：`hasForwarded = content !== undefined || (sseEvents?.length ?? 0) > 0`，按存在字段分支：非流式→`MessageBlock(content)`；流式→扫 forwarded `sseEvents` 找终止 error 帧展示 + 摘要（帧数/末帧 type）+ 提示"完整帧见 SSE 标签页"。**跨格式错误谓词（P6/HIGH-3）**：`f.type === "error"`（Anthropic/CC/Responses 合成帧解析出 `type:"error"`）**或** Gemini 结构化（`type==="generateContent"` 且 `raw` parse 出 `error.code`）——**不用裸子串** `/"error":{/`（会误伤讨论 error 的正文帧）。
4. **DiagnosticBar**（`DiagnosticBar.tsx`）：非成功态追加 `failureReason` 段（fail 配色），使结论跨标签页恒可见。

### Phase 4 — 测试（断言持久化 entry，非活数组）

- **后端**：`tests/pipeline/client-sink.unit.test.ts:172` → 断言 `writeSynthetic` **DOES** sample；`tests/anthropic/anthropic-v4.http.test.ts:441-458` → H3 断言 forwarded **含** error 帧（`getHistory(...).entries[0].inboundResponse.sseEvents`——**持久化 entry 是暴露错序的 oracle**）。审计并补跨格式 H3/截断套件（`tests/chat-completions/*`、`tests/responses/{responses-v4,responses-ws}.http.test.ts`、`tests/gemini/gemini-v4.http.test.ts`、`tests/anthropic/{stream-truncation,tool-input-repair-fail}.http.test.ts`）。新增：unrepairable/refusal http 用例断言合成 error 帧落进持久化 `inboundResponse.sseEvents`（正样本证明触达）**且** `outboundResponse.success===true`+`failureReason` 有值（数据模型修的正样本）。
- **前端**：`ui-v4/tests/ResponseSegment.vitest.test.tsx` 增流式失败用例（Proxy→Client 节 + Outcome 结论 + 上游成功态）、更新既有 `withResponse`（已带 `inboundResponse.sseEvents`，现在渲染 forwarded 节）；`DiagnosticBar.vitest.test.tsx` 增 failureReason 断言。

## 关键文件

- 后端：`src/lib/pipeline/client-sink.ts`、`src/lib/context/request.ts`、`src/routes/{chat-completions,responses,gemini,messages}/handler-v4.ts`、`src/routes/responses/ws.ts`、`src/routes/messages/web-search-handler.ts`
- 前端：`ui-v4/src/components/detail/segments/ResponseSegment.tsx`、`ui-v4/src/components/detail/DiagnosticBar.tsx`
- 文档：`docs/DESIGN.md`（owns-sink 采样措辞 + `outboundResponse` 语义"忠实上游腿、结论进 failureReason"）；相关 memory 回填

## 验证

- `bun run typecheck` + `bun run typecheck:ui-v4`（**非** `typecheck:ui`——那是另一个 ui workspace）。
- 后端 `bun run test:backend`（重点 `tests/pipeline`/`anthropic`/`responses`/`gemini`/`chat-completions`）；前端 `bun run test:ui-v4`。
- 端到端实证（活实例）：对 AskUserQuestion 失败 entry 走 `/history/api/entries/:id`，确认 `inboundResponse.sseEvents` 末含合成 error 帧、`outboundResponse.success===true`、`failureReason` 有值；ui-v4 Response 标签页显示 Outcome 结论 + 上游"ok" + Proxy→Client 节含 error。
- `bun run lint`（eslint --fix，勿直接 prettier）。
- 收尾派 subagent review（显式裁判轴：长远正确 + 完整 + richest-data-flow），复核采样/reorder 一致性、数据模型消费端无回归、前端跨格式谓词；按 phase 细粒度提交（`fix:`/`refactor:`/`test:`），`git add -p`/精确 pathspec，避开并发会话的无关改动。
