---
name: project-transport-config-three-axis-reorg
description: 上游 transport 配置三轴归位（timeouts 看门狗 / upstream_transport egress / server.responses_ws ingress）P1-P5 全 landed master
metadata:
  type: project
---

上游 transport 配置从散在 `timeouts.*`/`openai_responses.*` 的混杂态，按**三条职责轴**归位：① `timeouts.*` 请求生命周期看门狗（transport 无关）② `upstream_transport.*` 拨出去的连接/会话/池（`tcp_keepalive_probe_delay` / `http2.{ping_interval,session_connect_timeout}` / `websocket.{pooled_connection_idle_timeout,soft_max_connections}`）③ `server.responses_ws.*` 客户端 ingress。**全 5 相位 landed master**（merge `2c19c7cf`）。

**承重决策**（权威 ADR `docs/decisions/2026-07-14-transport-config-three-axis-organization.md` + spec `docs/spec/2026-07-14-upstream-transport-config-reorg.md`）：
- `0` 语义统一：absence=项目默认 / `0`=禁用 / 正数=值。**SOCKS 诚实例外**——`session_connect_timeout:0` 在 SOCKS 下无法真禁用（socks 库地板 30s），validation 拒绝为 0（fail-fast 不冒充）。
- `connect_timeout` 留 h2 段 `session_connect_timeout`（per-stage 非总 deadline、proxy 路最坏 2×）。
- WS **无 keepalive 键**（跨 runtime 无有效 primitive，capability 经诊断暴露不伪装成 config）。
- 热重载 **generation-based retire-and-replace**（非 drain-then-replace）+ per-session active-stream exactly-once + retiring PING 存活至 drain。

**每相位都被 TDD/审查逼出真实 bug**（非纸面完成）：P2 `proxy-connect` `setTimeout(fn,0)` 假禁用;P3 disk-only 迁移损坏 `model_overrides` 集合字段（→ scoped sparse patch）;P4 **Bun pre-header bare-close 致 `http2Fetch` 永久挂起**（→ close backstop，属 [[bun-node-runtime-gotchas]]）+ WS never-throw 半实现;P5→P4 时序接线断层（`getUpstreamWsReconcileStatus` dead export，整合态审查才逮）。

流程：spec+ADR → 5 相位 plan（两轮 GPT 评审）→ 隔离 worktree subagent-driven 执行（每相位合并态审查 + 最终整合审查）→ 落 master。落地时**退让并发 history-v3/tantivy 会话**（[[feedback-merger-yields-but-merge-must-happen]]）。权威现状看 DESIGN.md「活的架构现状」+ API.md `/api/status` `transport` 字段。

遗留 backlog：`getSession` `for(;;)` 无迭代上限（nit，理论饥饿、被建连延迟自然限流）→ `docs/todo/deferred-backlog.md`。继承的 master 债（非本特性）：`typecheck:ui-v4` 的 pino-roll 缺声明（并发 diagnostic 会话）。
