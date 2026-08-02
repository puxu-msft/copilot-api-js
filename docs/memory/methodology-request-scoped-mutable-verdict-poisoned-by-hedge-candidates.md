---
name: methodology-request-scoped-mutable-verdict-poisoned-by-hedge-candidates
description: ctx 上的共享可变裁决会被落败 hedge candidate 污染（hedge 默认开）；正解是请求级不可变策略 + 各 candidate 自推导
metadata:
  type: project
---

给 ctx 加一个「某层实际做了什么」的可变字段，让下游读它来决定终态——这个模式在本仓库**不安全**，因为 `generationHedgeEnabled` **默认 `true`**（`src/lib/state-defaults.ts`）：primary 与 hedge candidate **各有独立的 ResponseProcessor / rewriter**，但 ctx 是**请求级**的。落败 candidate 写进去的裁决会覆盖胜出者的结果——一个正常成功的请求可能被判成失败。

2026-07-28 refusal 抑制这一轮我踩了：为解决「改写层与 handler 两次独立读热重载全局配置会判反」，我加了 `ctx.recordRefusalObservation()` 让改写层上报**因果信号**。逻辑上比「两层各自重新推导」更强，但作用域错了——对抗评审用 hedge 默认开这一条直接打穿。

**正解是两个东西，不是二选一**（评审的原话：causal observation 与 immutable policy snapshot 不是替代关系）：

- **请求级不可变快照**：策略（mode + 模板）在**首次读取时冻结**、此后不可变（`ctx.refusalPolicy`）。这消掉热重载分歧——两层重新变成「同一不可变输入的纯函数」。
- **candidate 级推导**：各层从**各自的 accumulator** 推导结论，不写任何共享槽位。没有共享写入点，就不存在互相覆盖。

**Why:** 「共享可变槽位」与「并发 candidate」天然冲突；而热重载分歧的根因是**输入可变**，不是「推导了两次」。冻结输入同时解决两者，且不引入跨层耦合。

**How to apply:** 往 `RequestContext` 加**可变**字段前先问「hedge / buffered-retry / continuation 下会有几个写入者？」。请求级只放**不可变**的东西（冻结的配置快照）；per-attempt / per-candidate 的观测放 accumulator 或 rewrite state。既有先例可抄：`unrepairableToolInput` 走 `_repairOutcomes` + `resetRepairOutcomesForAttempt()` 的 per-attempt 语义。权威：[docs/refusal-recovery.md](../refusal-recovery.md)「策略按请求冻结」节。
