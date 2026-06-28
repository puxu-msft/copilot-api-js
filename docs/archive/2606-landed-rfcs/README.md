# 已落地 RFC 归档（2026-06）

> **归档于 2026-06-28。** 本目录是一批**已完整落地、但顶部状态行陈旧（写"草案/draft/设计稿待实现/实现中/Ready to implement"）**的 RFC。其描述的机制均已实现于 `src/`，**活的架构现状以 [docs/DESIGN.md](../../DESIGN.md) 「活的架构现状」表为准**；本目录作历史设计记录。

## 为何归档

经两轮独立 subagent + 主线 file:line 复核，以下 9 个 RFC 的核心机制全部 ✅ 完整落地，仅顶部 Status 行未同步（多数 RFC 内文已自标"[已落地]+commit"，只是头部状态行落后）。它们不再是"待实现设计稿"，故移出活跃 `docs/rfc/`。

| RFC | 落地证据（代表）|
|---|---|
| `stale-reaper-cancellation.md`(+HANDOFF) | reaper teeth（缺陷④）：`context/request.ts` lifecycleAbort/reapInFlight + `manager.ts:207` + `send.ts:80/109` reaperSignal 折进 fetch + `stream.ts` StreamReaperCancelError（Phase 1+2 全落地）|
| `history-storage-and-file-logging.md` | A: `observability/sinks/file.ts`（copilot-api.log 轮转 sink）；B: `connection.ts` VACUUM + `compression.ts` zstd + `serialize.ts` request_group dedup |
| `streaming-upstream-rst-buffered-retry.md`(+HANDOFF) | `driver.ts:521` runResponseBufferedSink + `state.ts` protectStreaming* 五键（Phase 0-4 全落地）|
| `telemetry-histograms.md` | `request-telemetry.ts` HISTOGRAMS registry + `metrics-exposition.ts` Prometheus histogram buckets |
| `tool-call-text-recovery.md` | `anthropic/recover-tool-call/` + `response-rewrite-adapters.ts:108` order 100 S5 改写 |
| `pipeline-dry-run-inspector.md`(+phase3-prompt) | `routes/debug/dry-run-pipeline.ts` + `driver.ts:190` inspectRequest |
| `observability-rewrite.md` | `observability/bus.ts` createBus + 5 sinks；旧 `lib/tui/` 已删 |
| `p2.6-anthropic-driver-migration.md` | `routes/messages/handler-v4.ts` createPipelineDriver/runRequest（唯一活路径）|
| `response-pipeline/`（子目录）| `driver.ts` runResponseSink + 5 条 ANTHROPIC_RESPONSE_REWRITES；Stage A+B owns-sink 全落地 |

## 仍 live 的开放项（非未实现，已文档化暂缓）

- streaming-rst §12（retry cap 调优、总时长预算闸 Q7）；truncation 检测的 live post-content 透明重试 / web_search 双跳旁路；response-pipeline B4（流末 drain 进 driver S6）**评估后驳回**。这些在各 RFC 正文标注，归档不改变其暂缓性。
