---
name: reference-config-yaml-overwrites-setstatefortests-per-request
description: 事故证据 stub：全应用测试里 setStateForTests 钉 config-managed 键被 applyConfigToState 覆盖，mode 类 mutation 因此永不咬；当前操作合同在 skill test-isolation
metadata: 
  node_type: memory
  type: reference
  originSessionId: f78d8768-7d1e-4aa7-96b2-06ebd19dbb63
  modified: 2026-08-08T00:00:00.000Z
---

**当前操作合同（canonical）= skill `test-isolation` 的「config 隔离与 state 隔离是两根正交的轴」节。** 判据、调用点表、注入/还原步骤一律以那里为准。本条只保留 2026-07-28 那次的**事故证据与识别指纹**。

`createFullTestApp` 级别的测试里，用 `setStateForTests({ <config-managed 键> })` 钉住一个值**可能是空操作**：请求路径上会调 `applyConfigToState()`，把生效 config 里显式写着的键重新写回 state——而这个覆盖发生在请求级 policy 冻结**之前**。

> **口径订正（2026-08-08）**：本条初版写的是「**路由每请求调** `applyConfigToState()`」。**那个全称说法是错的**，别再据它判断。实际调用点分两类（route-level 直接调、经 system-prompt override 间接调），各 vendor 路径与 payload 形状都不一样，且有的路径会早退不调。**完整的两步判据在 skill `test-isolation`**，不在这里。

**2026-07-28 实测证据**（在 `request.ts` 的 `refusalPolicy` 冻结点插桩）：`config.yaml` 写着 `refusal_sse_rewrite: end_turn`，于是 `setStateForTests({refusalSseRewrite:"refusal"})` 被覆盖，测试实际全程跑在 `end_turn` 下；同一次冻结里 `refusalEndTurnText` 却保留了测试值——因为 `config.yaml` 没写那个键。

**识别指纹（本条最值得记住的东西）**：**同一个 policy 对象里一半字段听测试、一半字段听配置文件。** 看到这种不对称，就是它。

后果不只是测试描述失真：拿「翻状态」当 mutation control 会**永远不变红**，被误读成「测试没咬住」（见 [[methodology-verify-the-mutation-actually-applied]] 的两种相反解释）。

现场注释实例：`tests/routes/reverse-refusal-default-wire.it.test.ts` 头注释、`tests/routes/reverse-contentless-refusal.it.test.ts` 的 `setStateForTests` 处。
