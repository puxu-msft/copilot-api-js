---
name: methodology-fix-one-constraint-violates-sibling-constraint
description: 修一条上游约束的改写可能自造另一条约束的违规——同一对象上的约束要一起当输出不变量断言
metadata:
  type: feedback
---

对同一个对象（一条 assistant 消息、一个 payload 字段组）做**改写型修复**时，只针对被修的那条约束写测试，会让修复自造**兄弟约束**的违规。实例：L1 de-stack 为满足「两 thinking 不得相邻」（C1），把唯一的非 thinking 块 tool_use 挪到两 thinking 中间，产出 `[T,tool,T]` → 末块成 thinking，撞上「assistant 消息末块不得是 thinking」（C2），生产每轮必败 400 且当时 L2 matcher 认不出新措辞、零兜底。

**Why:** 约束集合是**对象级**的，改写只要动了块的排列，就同时对该对象的**所有**约束负责；而测试往往只锁"这次修的那条"，绿灯给了假保证。上游 400 措辞还会误导（本例 C3「tool_use 之后有块」报的是 `does not support assistant message prefill`），照字面查会追错方向。

**How to apply:**
- 修改写逻辑前，先把该对象**已知约束全列出**，输出侧逐条断言（不只断言被修的那条）；发现新约束就回头补测已有修复。
- 约束靠**真实完整 payload 重放**实测确立，别信最小构造的阴性结果：本例 `[T,tool,T]` 在最小对话里 200、在生产 30 消息 payload 里 400，最小构造根本复现不出 C2。
- 反应式兜底的 matcher 要按**补救手段**归类（同一补救 = 同一谓词的并集），而不是按某一句错误措辞；否则新措辞出现时静默无兜底。
- 上游报的数组索引可能与我方口径差 1（内联 system 折叠），**按形状定位违规对象，别按索引**。

权威：spec `docs/spec/2026-07-26-thinking-terminal-block-layout.md`、skill `ghc-anthropic-upstream`（三约束表 + 合法形态表）、探针 `exp/thinking-terminal-block/`。相关 [[feedback-fix-all-comparison-sites]]、[[feedback-pass-null-clean-not-self-validating]]、[[methodology-new-strategy-shadowed-by-broader-first-match]]。
