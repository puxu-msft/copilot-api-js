---
name: project-synthetic-frame-forwarded-track-completeness-spec
description: 合成/改写帧 forwarded 轨完整性（Unit2/3 全量 + Unit1 缩减，landed master 2026-07-20）
metadata: 
  node_type: memory
  type: project
  originSessionId: c200e804-07ad-4890-a36e-e297fac6f25d
  modified: 2026-07-20T12:12:24.692Z
---

三单元合并 **spec + TDD plan 均定稿、待执行**（2026-07-20），取代已 SUPERSEDED 的 `docs/spec/2026-07-14-streaming-history-track-completeness.md`（其 file:line 与前提随三轮大重构全失效）。权威：spec [docs/spec/2026-07-20-synthetic-frame-forwarded-track-completeness.md](../../../src/copilot-api-js/docs/spec/2026-07-20-synthetic-frame-forwarded-track-completeness.md) + plan `docs/plan/2026-07-20-synthetic-frame-forwarded-track-completeness.md`（含 kick-off，探针已实测收敛 Unit2 单点）。

主题：到达客户端的 proxy 合成/改写帧须**也**进 history forwarded 轨且可辨识（richest-data-flow）。三单元逻辑独立、非大重构，分别并入 backlog 三条同族条目：

- **Unit 1**（缩减版 landed `301e63b2`）**原前提被实测推翻**：「POST-COMMIT error 帧+锚点 stop@0 永不进 history clientResponse.sseEvents」在 History V3（landed 2026-07-18）下为假——durable projection（`v3/projection.ts:383` clientTrack via generation recorder）在 ctx.fail 后仍捕获 writeSynthetic 帧（seal 延迟）。getHistory 已完整。**缩减修复**仅治瞬态 request.failed 快照（toHistoryEntry 读 _forwardedResponse）：抽 writeTerminalThenSettle（closeAnchor→writeSynthetic→setForwarded→fail + finally 兜底）；reaper 腿仍缺（需两阶段协议，backlog）。教训=**实施前实测核前提，History V2→V3 大迭代可令旧 spec 前提失效**。
- **Unit 2** Responses `responseFrame`（`candidate-response-session.ts:190-197`）重建字面量丢 hook-rewrite Symbol tag+id/retry；修=`...frame` 展开。gatekeeper 经核实 WS 走 `makeDeliveryWsSink`→default 分支→`makeWsSink.write`（已读 `readSyntheticKind`）→大概率单点改覆盖 HTTP+WS。
- **Unit 3** `shapeRawStreamErrorFrame`→`buildCanonicalErrorFrame` 未 tag + 无遥测；根因=`writeSynthetic`（`client-sink.ts:302`）采样 forwarded 轨恒 `synthetic=undefined`、不读帧 tag（≠`write()`:291）。修=writeSynthetic 读 tag + shapeRaw 打 `error-shaping-canonical` + 新 FeatureKind `error-shaping-raw-canonical`。证伪 backlog「仍打 error-shaping-canonical」错误前提。

两轮异模型对抗评审（Claude 完整性 + GPT 代码级证伪，各 0 blocker，GPT 唯一 MAJOR=gatekeeper 靶点已修）。landed commit `a9211d75`。同族暂缓：gemini/CC/responses raw 终点也未打标（无 canonical 概念、本轮不做）。相关 [[feedback-pass-null-clean-not-self-validating]]（doc-vs-code 不自证）。
