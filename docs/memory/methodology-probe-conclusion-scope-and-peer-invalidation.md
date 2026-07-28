---
name: methodology-probe-conclusion-scope-and-peer-invalidation
description: 探针本身跑对了，结论仍可能错的三种失效——查的是投影不是事实、量的是被 peer 刚改过的代码、配置决定了它只证明了一个子集
metadata:
  type: feedback
---

**探针跑通、数字真实，不等于结论成立。** 三种失效各自独立，2026-07-27 一轮里连踩三个。实质与防法在 skill `empirical-verification` §「探针的三个失效模式」，这里只留触发钩子：

1. **查的是投影，不是事实** —— 「零个带 `synthetic` 标记」其实是那条 History 投影**根本不含该字段**。用查询路径下否定结论前，先拿已知一定命中的样本证明**这条路径能带出它**。是 [[feedback-pass-null-clean-not-self-validating]] 在视图/投影上的特例。
2. **量的是此刻的代码，而此刻的代码可能刚被 peer 改过** —— 实测「空 delta 能到 wire」→ 下结论「丢失不在我方」→ **错**：并发会话早 6 小时的 `883e0533` 刚修好真正的丢失层，探针量的是修复后行为。下「缺陷不在我方」这类结论前先 `git log --oneline -20` + `git log -S<符号>`。比 [[feedback-verify-deferred-task-not-already-landed-before-designing]] 更狠：那条讲功能可能已落地，这条讲**根因结论会被 peer 的修复悄悄作废**。
3. **配置决定了它只证明了一个子集** —— buffered 配置下验 keepalive 升级，客户端视角其实是 pre-content 窗口，验到的只是 pre-content 路径。**探针产物必须连「它没有证明什么」一起写**（范式见 `exp/keepalive-escalation-wire/README.md`）。

**Why:** 三者的共性是**把"我观测到的"当成"事实就是"**，而观测链上有三层可以骗人：投影裁掉了字段、代码版本已经变了、配置只激活了一条路径。

**How to apply:** 下结论前问三句——这条查询路径**能**带出我要找的东西吗（正样本对照）？这块代码最近**有没有人动过**（git log）？我这次跑的配置**激活的是哪条路径**（把范围写进产物）？
