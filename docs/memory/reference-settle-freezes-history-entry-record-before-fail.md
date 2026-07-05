---
name: reference-settle-freezes-history-entry-record-before-fail
description: ctx.fail/complete 同步冻结 history entry 快照——client-facing 数据须在 settle 前 record，且新顶层字段须同时进 onTerminal 投影 + updateEntry allowlist
metadata: 
  node_type: memory
  type: reference
  originSessionId: 4ad9bb44-beba-431c-89a7-8ac65c1fe9d1
---

History 持久化时点陷阱（2026-07-04 修 ui-v4 Response 错位时踩，实证真实 entry `req_1783070660245_128`）：

**`ctx.fail()` / `ctx.complete()` 在 `toHistoryEntry()` 里同步读快照并发 `request.failed/completed` 事件**（`src/lib/context/request.ts`），history sink `onTerminal` 持久化的是**那个冻结的 `event.entry`**，`finalizeEntry` 只压缩内存 entry、**不再回读 ctx**。故 **settle 之后**对 ctx 的任何 `setForwardedResponse`/其它 mutation 对持久化**不可见**——trailing `finally { recordForwarded() }` 太晚。凡要把 client 实收数据（合成 error 帧等）记进 `inboundResponse`，顺序必须 `write(采样进 forwardedSseEvents) → recordForwarded() → ctx.fail/complete`（合成写 best-effort `.catch` 保 settle 恒跑）。这是"忘了记录合成帧"类 bug 的根因，不是 sink 采样与否的问题（见 [[feedback-richest-data-flow-store-complete-no-pruning]]、[[methodology-record-signals-at-committed-outcome-not-per-attempt]]）。

**新增顶层 HistoryEntry 字段的两处必改**（漏一处则静默永不持久化）：① `toHistoryEntry()` 里算出该字段；② history sink `onTerminal` 的**显式字段投影**（`src/lib/observability/sinks/history.ts` 的 `updateEntry({...})`）把它从 `entryData` 带过去；③ `updateEntry` 的 `Pick<HistoryEntry, ...>` allowlist（`src/lib/history/entries.ts`）加该键（否则靠 object-spread 的 excess-property 漏检"能跑但不类型安全"）。`failureReason` 曾长期"投影了但从没持久化"（所有真实 failed entry 读回都 `failureReason: undefined`）正是因为漏了 ②——RFC 加了 ① 却没加 ②/③。校验：round-trip 手测（`extractHeadMetaPayload`→`deserializeEntry`）会**假绿**（手动挂字段的 entry 能过），必须用真实 http 流程 + `getHistory()` 读**持久化 entry** 才暴露（[[feedback-pass-null-clean-not-self-validating]]）。
