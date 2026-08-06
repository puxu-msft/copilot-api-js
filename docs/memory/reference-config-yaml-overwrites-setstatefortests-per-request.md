---
name: reference-config-yaml-overwrites-setstatefortests-per-request
description: 全应用测试里 setStateForTests 钉 config-managed 键会被每请求的 applyConfigToState 覆盖，mode 类 mutation 因此永远不咬
metadata: 
  node_type: memory
  type: reference
  originSessionId: f78d8768-7d1e-4aa7-96b2-06ebd19dbb63
  modified: 2026-07-28T22:24:29.286Z
---

`createFullTestApp` 级别的测试里，用 `setStateForTests({ <config-managed 键> })` 钉住一个值**可能是空操作**：路由每请求调 `applyConfigToState()`（`src/routes/chat-completions/handler-v4.ts` 等），把**仓库根 `config.yaml`** 里显式写着的键重新写回 state——而这个覆盖发生在请求级 policy 冻结**之前**。

2026-07-28 实测（在 `request.ts` 的 `refusalPolicy` 冻结点插桩）：`config.yaml` 写着 `refusal_sse_rewrite: end_turn`，于是 `setStateForTests({refusalSseRewrite:"refusal"})` 被覆盖，测试实际全程跑在 `end_turn` 下；同一次冻结里 `refusalEndTurnText` 却保留了测试值——因为 `config.yaml` 没写那个键。**同一个 policy 对象里一半字段听测试、一半字段听配置文件**，这个不对称正是识别本陷阱的指纹。

后果不只是测试描述失真：拿「翻状态」当 mutation control 会**永远不变红**，被误读成「测试没咬住」（见 [[methodology-verify-the-mutation-actually-applied]] 的两种相反解释）。

**How to apply:** 判断某键是否受此影响——`rg -n '<snake_case_key>' config.yaml`，写了就钉不住。想在这一层做 mutation control，**破坏生产代码**（如把某 rewrite 的 `appliesTo` 改成 `() => false`）而不是翻状态；想断言 mode 相关行为，要么退到不经路由的单测层，要么就只刻画**默认值**（默认值恰好是配置文件里那个，所以是这一层唯一可靠的断言对象）。实例见 `tests/routes/reverse-refusal-default-wire.it.test.ts` 头注释与 `tests/routes/reverse-contentless-refusal.it.test.ts` 的 `setStateForTests` 处注释。
