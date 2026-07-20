---
name: reference-settle-freezes-history-entry-record-before-fail
description: ctx.fail/complete 同步冻结 history entry 快照已归入 skill persistence-async-invariants §2；见那里
metadata:
  node_type: memory
  type: reference
---

**已归入 skill `persistence-async-invariants` §2（settle 冻结 history entry 快照）。** 钩子：`ctx.fail/complete` 在 `toHistoryEntry()` 同步冻结快照，settle 后 mutation 不可见→client-facing 数据须 settle 前 record（`write→recordForwarded()→ctx.fail/complete`）；新顶层字段三处必改（`toHistoryEntry` + sink `onTerminal` 投影 `sinks/history.ts` + `updateEntry` allowlist `entries.ts`），`failureReason` 曾长期漏 ②。相关 [[feedback-richest-data-flow-store-complete-no-pruning]]。
