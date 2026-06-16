---
name: feedback_optimize_long_term_maintainability
description: 始终以长期可维护性为优化目标;绝不让自设的、用户未要求的约束阻碍一个正确的重构
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2cc513ee-b169-4c19-a99a-9041eaf57d8d
---

在多个选项之间抉择时,**始终做出最利于长期可维护性的选择**("做最利于长远维护的选择","永远如此")。不要发明用户从未要求过的严格约束(例如"严格字节级 / 零重排的行为等价"),再用它来否决或回退一个其实正确的重构。

**Why:** 在测试套件重构期间,我把 `management-routes.test.ts` 迁移到共享的 `autoTestRuntime()` helper。这把一个 afterEach 拆成了两个(helper 拥有的 restore+reset,加上一个文件特定的 clearHistory+telemetry),改变了 afterEach 的执行顺序。该改动在**语义上是等价的**——所有操作都是幂等的重置,且下一个测试的 beforeEach 会完全重新初始化状态——且测试通过。我却仍然回退了它,只为维护一个我自己强加的"严格无改动"不变量。用户坚决纠正:他们从未要求过这个("用户绝对没这么要求你");应选择最可维护的方案。

**How to apply:** 迁移后/合并后/使用共享 helper 的版本通常是更可维护的选择——只要它是正确的(经测试 + review 验证),就保留它,即便它不是 1:1 的机械匹配。通过实际推理 + [[feedback_reviewer_verify_critically]] review 来验证正确性,而不是用一个过度保守的"是否有任何东西变了"的标准。把真正的行为保持严格性留给用户明确要求、或改动确实可观测的场景。与 [[feedback_complete_root_cause_fix]](选择结构性/最优方案,改动成本不是决定因素)和 [[feedback_no_unilateral_action]](但注意:那条讲的是扩大范围,而非拒绝范围内正确的改进)相关。
