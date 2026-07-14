---
name: methodology-cross-phase-integration-seam-only-caught-at-merged-state
description: 多 phase subagent-driven 执行里，Phase A 声明的类型/枚举/契约被下游 phase 漏接线的缝，逐 task 审各自看不到、只有终局 whole-branch 合并态审能抓
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1a1428a4-9c8e-4a9d-98f3-08d5bf495030
---

在 error-client-shaping 大特性的 subagent-driven 执行中，Phase 1 声明了 3 个观测枚举（`error-shaping-canonical` SyntheticOriginKind + 两个 FeatureKind），且 `history/types.ts` 明文承诺「Phase 3 wiring 会打此标记」，但 Phase 3/4 实现时**从未接线产出**（只有委派那条真接线）。6 个逐 task review 全部通过、都没发现——因为每个 task-reviewer 只看自己 phase 的 diff，看不到「上游 phase 声明了、我这个 phase 该产出却没产出」。只有**终局 whole-branch review**（审整支合并态）逮住了这 3 个死枚举。

**Why:** 逐 task review 的视野是**单 phase diff**；跨 phase 的「声明—消费」契约缝（A 声明类型/枚举/接口 → B 本该产出/接线却漏了）在任何单个 diff 里都不完整、看不出来。这类缝天然只在**合并态**暴露。本例还叠加了 richest-data-flow ADR 承重点（合成物注入真实流须打可辨识标记 = AC6），漏接线直接违反 spec 明示承诺却编译通过（枚举是「死」的、typecheck 不报）。对齐 user-rule 40 `review-merged-state`「per-item reviewed ≠ merged-state reviewed」。

**How to apply:**
- **subagent-driven 大特性收尾必做终局 whole-branch review**，且其 prompt 显式点它审「跨 phase 集成缝：某 phase 声明的类型/枚举/契约，下游是否真产出/接线；有无死枚举/孤儿导出」——别只让它复述逐 task 已审的东西。
- **死枚举是红旗**：新增 union 成员/FeatureKind/SyntheticOriginKind 后，grep 全仓确认有真产出点（`tagFrameSynthetic`/`recordFeature` 调用），只在类型声明+穷尽 switch 里出现 = 未接线。typecheck 逼出的是「消费端穷尽」不是「产出端存在」。
- **控制器把 carry-forward 写进 durable ledger**：每 phase review 交下游的跨阶段依赖（CF-1/2/3 式）逐条记 ledger、派下游 phase 时显式带进 prompt，否则跨 phase 契约在 fresh subagent 间丢失。
- 修这类缝优先「与承诺对齐」（接线产出）而非「删声明」；确不可达才降级枚举 + backlog，别留死枚举误导后续读者（本例 raw-stream 终点无 ApiError 分类语义 → 那条 decided 维度确不可达 → 记 backlog）。

关联：[[methodology-exhaust-then-choose-over-single-solution]]（同一特性的调研方法论）、richest-data-flow ADR、[[project-upstream-error-client-shaping]]（本特性现状）。承重实例还含 Phase 4 的 Critical wire bug——plan 探查阶段假设 CC AskUserQuestion `options: string[]`、没核 CC 真实 schema（实为 `[{label,description}]` 对象），implementer 忠实消费错契约，靠 reviewer + 亲查 CC 源码 ground truth（app.pretty.js + 本仓库既有 fixture 双证）抓出：**跨系统 wire schema 别凭 plan 假设、查权威 ground truth**（empirical-verification）。
