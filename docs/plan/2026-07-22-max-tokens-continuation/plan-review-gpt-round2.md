# max_tokens 续传实施计划第二轮聚焦确认（GPT 异模型对抗审）

## 评审范围

仅复核上一轮报告 `/home/xp/src/copilot-api-js/docs/plan/2026-07-22-max-tokens-continuation/plan-review-gpt.md` 的 1 个 blocker、7 个 major、2 个 minor，核对修订提交 `84598f74` 后的计划是否真闭合；未重新质疑冻结 spec 的需求取舍。

## 已读取／执行的证据

- 已读取并逐项对照修订计划：`README.md`、`plan-G-gates.md`、`plan-0-classifier-and-observability.md`、`plan-1-anthropic-continuation.md`、`plan-2-visibility-and-budget.md`、`plan-3-cc-responses.md`、`plan-M-terminal-ownership-matrix.md`、`plan-provenance-prerequisite.md`、`plan-Q5-three-way-overlap.md`、`plan-4-closeout.md`。
- 独立复核 master 代码：`src/lib/pipeline/driver.ts:1016-1033, 1136-1150, 1336-1454`、`src/routes/messages/handler-v4.ts:227-275, 1203-1231, 1442`、`src/routes/chat-completions/handler-v4.ts:289-365, 628-657`、`src/routes/responses/candidate-response-session.ts:104-165`、`src/routes/responses/handler-v4.ts:576-645`、`src/lib/openai/responses-stream-accumulator.ts:23-129`、`src/lib/context/model-operation-record.ts:28-40`、`src/lib/context/types.ts:62-69`、`src/lib/history/types.ts:416-425`。
- 复用上一轮已执行的底座验证：`bun test --parallel tests/pipeline/continuation-flow.it.test.ts tests/pipeline/generation-coordinator.it.test.ts`，11 pass、0 fail。它不替代本轮对计划可执行性的核验。

## 总体 verdict

**需先修订，不可开工实施。**

**blocker 数量：1。**

修订确实关闭了多项原问题：不再把 ledger 当分型来源；P1 的 settle oracle 已拆成 driver 与 handler 两层；组合校验前移；marker 的“抑制＋注记”契约已统一；Gate B 已改为可重复的采样方法；Responses `incomplete_details.reason` 已移到 P0；全 leg 枚举、provenance 前置任务、Q5 具名任务均已出现。

但独立复核发现 P0 的“per-format observer + 真实生产接线”仍只对 Anthropic 给出了实际任务，CC／Responses 缺少 observer 构造、更新、状态传递和 terminal 调用点的可执行设计。它不能实现计划声称的三格式 P0 观测，也无法为 P3 提供可靠的 B 类状态。这保留了上轮 blocker 的核心后果。

## 事实性发现

[blocker] `plan-0-classifier-and-observability.md:10-52, 56-103, 225-272` — 独立 observer 的原则已修正，但 P0 只有 Anthropic observer 的实现／反例测试，CC 与 Responses 仍是未接线的接口草图，故“三格式真实 terminal 分型观测”尚不可执行。证据：Task 0.1 只定义并测试 `updateAnthropicTerminalObserver`；`updateCcTerminalObserver` 与 `updateResponsesTerminalObserver` 只出现在接口 `:40-43`，没有对应 Task、状态更新位置、反例测试或 commit。Task 0.5 `:250` 却要求三个 handler 在 terminal 分支读取 observer 并写 history。master 的实际状态也证明这不能凭空接线：CC 的 parsed `finishReason`／`toolCallMap` 在 `src/routes/chat-completions/handler-v4.ts:339-353` 的 candidate `onRenderedFrame` 内更新；Responses 的 `status`／`toolCallMap`／`output_item.done` 在 `src/routes/responses/candidate-response-session.ts:118-145` 内更新；二者都需要把 per-candidate observer 放入 `createState`、纳入 snapshot 或提供 candidate accessor，才能由 handler terminal 分支读取。当前 `TerminalObserverState` 不含 per-block index／open-item identity，`updateCcTerminalObserver` 只拿整体 `toolCallMapSnapshot + lastKind`，`updateResponsesTerminalObserver` 只拿单一 `outputItemDone + lastKind`，也没有定义如何从多项 map／事件次序得出“最后块”的 closed 状态。失败场景：P0 无法实现 CC／Responses 的 `recordMaxTokensTruncation`，或实现者改用最后一个已 finalized tool call／当前 accumulator 的粗略状态，重新引入 B 与 B-closed 混淆；P3 的 Gate E 结论也没有可消费的状态承载点。建议：在 P0 增加 0.1b CC observer、0.1c Responses observer、0.1d observer-to-snapshot／handler terminal wiring 四个具名 TDD task；每个都明确 candidate `createState` 字段、更新事件、最后项选择和 close 规则。至少覆盖 CC text→open tool_call、multiple tool calls、`finish_reason=length`；Responses text→function_call、`function_call_arguments.done` 与 `output_item.done` 的不同先后、`response.incomplete`。Task 0.5 应逐格式真实 HTTP／WS producer oracle 验证 history 与 telemetry，而不只保留 Anthropic 两条测试。

[major] `plan-0-classifier-and-observability.md:186-223`；`plan-1-anthropic-continuation.md:68-128, 172-196`；`README.md:23, 81-82` — 非法组合虽已在 P0 建 effective config、P1 消费，但“显式记录 `strategy-prevented-stitch`”仍没有真实生产落盘／telemetry task。证据：`resolveEffectiveMaxTokensContinuation` 只返回 `diagnostics: string[]`；P1 Task 1.2 只断言 driver 不续写，Task 1.5 只断言传入 effective config；`MaxTokensContinuationDiag` 在 Task 0.5 `:250` 的字段列举中也没有 `strategyPreventedStitch`，且没有调用 `recordFeature`／telemetry counter 的步骤。README 冻结契约 `:82` 已声称该字段存在，和实际 task 不一致。建议：在 P0/P1 首个 consumer commit 增加 request-level诊断接线：effective config 的 diagnostics 进入 `pipelineInfo.maxTokensContinuation.strategyPreventedStitch` 和明确的 telemetry outcome／counter，并以真实请求 readback 断言。这样才同时满足“禁止协议错误”与 spec 的“绝不静默吞配置”。

[major] `plan-Q5-three-way-overlap.md:29-37, 56-68` — Q5 已成为具名任务，但其当前 index 账把 anchor 计入 `wireDeliveredBlocks` 的结论与 master 实现不符，会引导实现者错误修改 offset。证据：`src/lib/pipeline/driver.ts:1145-1149` 只在真实 frame 满足 `continuation.isContentBlockStart(frame)` 后递增 `wireDeliveredBlocks`；anchor 通过 `sink.writeAnchor`／`anchor.stopFrame` 写出，不走该计数器。当前顺序是先 `anchor.remap(frame, 1)`、再 `continuation.remap(..., continuationOffset)`（`:1145-1146`）；在 anchor@0、首个真实块 upstream@0→wire@1 后，counter 为 1，续写块 upstream@0 先 remap 为 1、再加 offset 1，正确到 wire@2。Q5 `:34` 却要求 continuation offset “含 anchor 占位块”，若照此把 offset 改成 2，续写块会变成 @3，制造空洞。建议：修正时序图为“anchor 的 index 偏移由内层 `anchor.remap` 负责；`wireDeliveredBlocks` 只计真实 content block start，绝不计 anchor；两次 remap 的组合而非单一计数器承担 anchor 空位”。Q5 producer oracle 应断言确切序列 `anchor@0 → primary real@1 → continuation real@2`，并禁止以“counter 含 anchor”为实现策略。修正后 Q5 才能作为 P1／P4 的可靠对账基线。

[minor] `plan-provenance-prerequisite.md:52-75` — provenance 从“顺手项”升级为具名前置任务，这一轮已实质改善，但 P.3 尚把关键记录端口设计留为实施时决策，计划仍非完全可执行。证据：现有 `OperationSyntheticKind` 确实没有 `continuation`（`src/lib/context/model-operation-record.ts:28-40`），`UpstreamRequestLeg` 也没有 `synthetic`（`src/lib/history/types.ts:416-425`），而 dispatch wire sample 在 `src/lib/pipeline/driver.ts:615-624` 的 `beginDispatch` 时发生；届时 continuation 身份必须已随 env／dispatch metadata 传入。P.3 `:66-69` 同时列出两种不同方案，并让实施者再决定，未指定 extension 如何由 `contEnv` 传至 `beginDispatch`、也未指定 cut-path 与 success-path 共用的唯一 producer。建议：在开工前冻结一个方案和签名。例如在 `RequestEnvelope` 加内部 provenance hint，`createDriverRecordingPort.beginDispatch` 读取该 hint 并在 sample 后用一个专门的 `markGenerationDispatchSynthetic(dispatch, kind)` port 写入记录；随后明确 V3 projection 的字段路径。保留“不可污染真实 wire body”约束。此项不再阻断计划结构，但应在 provenance 实现前消除分叉。

[minor] `plan-M-terminal-ownership-matrix.md:120-151`；`plan-3-cc-responses.md:124-130` — 原“只列四个 direct 格”的 major 已关闭为全 leg 枚举并给出不支持 leg 的 producer oracle，且本次复核确认 Responses reverse 是 `runResponseSink`，不是 buffered：`src/routes/responses/handler-v4.ts:576-645` 的 `:585`。因此 M.1 的该格不应仍保持“待核实”，应在计划中现在就归类为“本版本不支持、强制透传”，并把 `plan-3` 的“若走 buffered 则回补 Task 3.12”分支删除或改为已关闭事实。建议：更新 M `:120-135`、M.1 `:146`、M 验收 `:151` 与 P3 收口 `:128`，并加入已可确定的 Responses reverse 透传 producer oracle。这是陈旧待核实项，不改变全 leg 修订的正确方向。

## 上轮发现逐项确认

| 上轮发现 | 第二轮结论 | 依据 |
|---|---|---|
| blocker：ledger 误作分型源 | **未完全闭合，保留 blocker** | Anthropic 已改为独立 observer；CC／Responses observer 和生产接线缺 task，见首项 blocker。 |
| major：P0 无真实观测路径 | **部分闭合** | Anthropic 已有真实 history／telemetry oracle；CC／Responses 仍缺可执行生产路径。 |
| major：settle 测试 oracle 错层 | **已闭合** | P1 Task 1.1a 明确只断 driver；1.1b 走 handler/in-process，断 terminal 一次与 parent=`continued`／final=`committed`。 |
| major：组合校验延后 | **部分闭合** | 校验已前移到 P0，并由 P1 首个可启用 commit 消费；但 `strategy-prevented-stitch` 的 history／telemetry 诊断未落 task。 |
| major：marker 契约冲突 | **已闭合** | Gate D、P2、README 均统一为“抑制首轮 terminator＋格式合法 marker”；P2 还写明 content、usage、provenance、CC／Responses 映射。 |
| major：matrix 只列 direct | **已基本闭合** | 全 leg 已枚举，并为 unsupported leg 设置 producer oracle；Responses reverse 已在 master 可确定为 non-buffered，应清理陈旧“待核实”。 |
| major：synthetic provenance 无具名任务 | **已基本闭合** | 已有前置文件、真实 persistence oracle 和 P1 显式依赖；但 P.3 的记录端口方案尚未冻结。 |
| major：Q5 无具名任务 | **未完全闭合** | 已有时序图、前置与 oracle，但 index 账对 anchor 的计数假设与现码不符。 |
| minor：Gate B 样本／等价规则不足 | **已闭合** | 固定 prompts/schema/采样参数、每场景 ≥20、可重复 verdict、只输出分布并交用户裁决。 |
| minor：Responses incomplete reason 放错 phase | **已闭合** | P0 Task 0.2b 已成为前置，P3 仅确认消费。 |

## 可否开工实施

**不可开工，需先修订。**

先完成三个必要修订：① 补全 CC／Responses independent terminal observer 与其真实 production terminal wiring；② 将 effective-config downgrade 的 `strategy-prevented-stitch` 真实落盘并进入 telemetry；③ 改正 Q5 对 anchor 与 `wireDeliveredBlocks` 的 index 账，并把 oracle 固化为 `@0 → @1 → @2`。随后再清理 Responses reverse 的已可核实矩阵陈旧项、冻结 provenance recording port，即可进入 gate-first 与 P0 实施。
