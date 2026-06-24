---
name: project-audit-rfcs-data-model-pruning
description: 审计已执行（2026-06-24）：12 个优先 RFC 全清、无 richest-data-flow 裁剪违规，lesson 已内化；剩低信号 RFC + observability sinks 未审
metadata:
  type: project
---

operator 指出（2026-06-22）：history-http-header-capture RFC 暴露的"用无消费者/重复裁剪数据模型"错误（见 [[feedback-richest-data-flow-store-complete-no-pruning]]）**可能在其他 RFC/已落地设计里也存在**，需按 richest-data-flow"后端存储必须完整、前端选择性展示"重新评估补齐。

**审计已执行（2026-06-24，4 个并行 subagent + 主线对照代码核验）**：12 个优先 RFC（observability-rewrite、response-pipeline/{design,finalize-stream-redesign,stage-a/b-plan}、activity-detail-main-outline、upstream-stream-truncation-detection、streaming-upstream-rst-buffered-retry(+HANDOFF)、anthropic-rewrite-reorg、pre-response-abort-handling、stale-reaper-cancellation(+HANDOFF)、history-storage-and-file-logging、history-http-header-capture、pipeline-dry-run-inspector、test-env-isolation）**全清——零裁剪违规**。结论：header-capture 翻车后这条原则已被内化——response-pipeline/truncation/rst-retry RFC 都**主动点名并拒绝**了"只留最终尝试/null 化残缺内容/砍腿"的裁剪（per-attempt sseEvents+responseHeaders、PartialResponseInfo.content 通道、4-leg header 全部实证落地，types.ts:95/124/126/196-201/232-234）。所有"删/砍/无消费者/YAGNI"信号词命中均为**收敛捕获机制/删冗余 UI 代码/删派生判别 label/删纯本地无 relay 的 count_tokens**，非裁剪真实可观测阶段的数据腿——即 richest-data-flow 允许的那一类。

**3 个 SHOULD-BUILD 已全部实现（2026-06-24，operator 指示"都做"）**：① 非流式语义残缺检测（各非流式 handler 缺协议终止符→`ctx.fail` 非静默 complete，保守只 gate 终止符缺失、不误判 legit refusal）；② 顶层 `failureReason` 投影（`HistoryEntryData`/`HistoryEntry` 加字段，toHistoryEntry 从 `outboundResponse.error ?? 末尝试 error` 投影 + `EntrySummary.responseError` 回填 + reaper/重启恢复给 interrupted 行 `error_message` COALESCE 兜底）；③ HTTP/2 响应 trailers 捕获（探针实证 Bun node:http2 emit `trailers` 事件→`onTrailers` 回调链→`httpHeaders.outboundResponseTrailers` 第 5 腿，capture-when-present 非投机）。各带测试 + 对抗 subagent audit（2 MEDIUM 修：CC/Gemini 空 choices 崩→`.at(0)` 走 fail；interrupted SQL-only→backfill error_message）。commit `feat(pipeline)…非流式截断` / `0284935` / `6fd6d4d` / `e30ca33`。**判据复用**：字段/腿/per-attempt 描述真实可观测阶段即须完整存（前端可不展示）；"无数据源"先探针验证 transport 是否真观测到（trailers 即"没接线"非"真无源"）。

**未审（低信号、未来可续）**：非优先 RFC（p2.6/upstream-http2/tool-call-text-recovery 等）、observability **sinks 的 filter 逻辑**、dry-run `fidelity.caveats`（subagent 判为诚实文档非裁剪，但可复核）。判据不变：字段/腿/per-attempt 记录描述**真实可观测阶段**即须完整存（前端可不展示）；区分"裁剪数据模型"（禁止）vs"收敛捕获机制/单一 owner"（允许）。
