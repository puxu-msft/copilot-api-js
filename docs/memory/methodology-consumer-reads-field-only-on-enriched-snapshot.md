---
name: methodology-consumer-reads-field-only-on-enriched-snapshot
description: 消费者读 entry.ctx 的某字段，但高频事件用轻量 snapshot 覆盖它、该字段只在富 snapshot 变体上 → 字段静默 undefined、功能死而单测假绿；须真实-bus 集成测试守卫
metadata:
  type: reference
---

一个共享快照对象有**两个变体**（如富变体 `snapshotWithSummary` 带 `summary`，轻量变体 `snapshot()` 不带），生命周期里被**多种事件**发布、消费者只持有「最后一个事件携带的那份」。当**高频事件**（如 `stream_progress`）用**轻量变体**覆盖 `entry.ctx` 时，消费者读一个**只在富变体上**的字段会恒 `undefined` → 功能静默失效。致命处：**单测直接注入该字段构造 ctx，永远绿**，而真实 bus 路径拿不到 → 典型「测绿生产死」。

本项目实例（BLOCK-1，`docs/spec/retry-duration-display.md` 的 BLOCK-plan 节）：footer/panel 想读当前 attempt 起始时间做 `last/total(N)`，初稿读 `entry.ctx.summary?.currentAttemptStartedAt`。但 `entry.ctx` 被高频 `stream_progress` 的**无 summary** 轻量 `snapshot()`（[request.ts snapshot()](../../src/lib/context/request.ts)）每帧覆盖 → `.summary` 恒 undefined → triplet 永不出现，恰在最需要它的长请求上。修复=把标量提到**轻量 snapshot 顶层**（每事件都带），消费者读顶层而非 `.summary`。

**Why:** 快照有多变体 + 消费者持最后一帧 + 高频事件用最省的变体，三者叠加使「字段只在某个变体上」成为静默陷阱；injection-based 单测对数据源断链是盲的。

**How to apply:** ① 加消费者读某快照字段前，先确认**实际高频生产者发的那个变体**是否携带该字段（别只看富变体）；能被高频事件覆盖的共享快照，字段要放在**所有变体都填**的位置（顶层标量优先于富子对象）。② 必配一条**驱动真实 bus + 真实高频事件**（如 `beginAttempt` → `recordStreamProgress`）的集成测试，断言该事件的 ctx 携带字段——injection 单测不算数。③ 同族陷阱见 [[methodology-one-shot-connected-snapshot-needs-root-subscriber]]（快照消费者挂载时机）；验证纪律见 [[feedback-pass-null-clean-not-self-validating]]（否定/通过结论不自证，用正样本+独立 oracle）。
