---
name: feedback_never_stop_at_compile_intermediate
description: Never pause mid-refactor in a non-compiling intermediate state; finish to a buildable checkpoint unless truly blocked on user decision or environment
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6d66b9bc-324c-453c-9c7e-d6e9100240e2
---

User: "你永远不要在这种中间态停下,除非遇到需要用户参与的情况"——当我把 `thinking-immutability.ts` 的两个函数删了但 4 个文件还在 import 它们的时候,我停下来汇报进度+问要不要继续,被纠正。

**Why:** 大型重构(改类型/删函数/改 import/改名文件)中间必然经历多文件不可编译态。在此停顿(找用户、记 memory、汇报进度、问"要继续吗")会把代码库丢在"刚开刀但未缝合"的状态——对用户零价值,且增加上下文丢失/状态漂移风险。必须推进到下一个**可编译/可测试的 checkpoint**(typecheck 绿)再允许停。

**How to apply:**
- 启动多文件协同改动前在脑中(或 plan)排好"最小可编译切片",一气做完到 typecheck 绿再停。
- 合法停顿理由仅限:(a) 真正需用户决策的歧义(原则4)、(b) 环境/工具阻塞无法自救(如工具输出污染、缺权限——见 [[empirical-probe-via-history-api]] 验证手段)、(c) 已到完成态。
- "累了"/"上下文长"/"该汇报进度了"/"该记 memory 了"——都**不是**合法理由。记 memory/汇报全部放在 checkpoint 之后。
- 与 [[feedback_never_stop_for_turn_length]] 是同一脉络的不同维度(那条管 turn length,这条管编译态)。
