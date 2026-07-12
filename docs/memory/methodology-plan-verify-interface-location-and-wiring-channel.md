---
name: methodology-plan-verify-interface-location-and-wiring-channel
description: 写 plan 引用现有 interface/接线通道时必须亲手核实位置与端到端桥接，别凭名字相似归位
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f5f9f34e-1878-4599-9a2c-e7419e0fc95b
---

写实施 plan（尤其引用现有 interface、hint 通道、诊断 leg）时，**每个「消费现有接线」的落点都要亲手核实**，别凭名字相似就归位：

1. **同名/近义 interface 要核实确切文件位置**：`PrepareHints`（`pipeline.ts:96`，retry 腿返回值受它约束）vs `PrepareAnthropicRequestOptions`（`request-preparation.ts:124`，prepare 入参）是两个不同接口，`excludeToolFields`/`excludeBetas` 在两处都出现——凭「excludeToolFields 旁边」会归错。
2. **per-attempt hint 是端到端多跳通道，逐跳都要接**：retry 腿 `prepareHints:{X}` → `PrepareHints` 加字段 → `codec.ts` 的 `env.prepareHints.X → opts.X` **逐字段显式白名单桥接**（不是 spread 透传，漏一行 hint 恒 undefined、静默死接线）。加新 hint 必改 ≥3 处（PrepareHints 定义 + codec 桥接行 + 消费点）。
3. **history 诊断 leg 不等于 prepare 出参；「可观测」须区分 live 与持久**：leg 来自 `WireRequest` 经 `legFromUpstreamRequest`（`context/request.ts`）**只 copy 固定字段集**（format/model/messages/system/headers/body），`prepareAnthropicRequest` 只 return `{wire,headers}` 丢弃其他 ctx 出参。proactive strip 无 retry，**不能**类比 reactive 的 `RetryAction.meta` 通道。**关键陷阱（合并态审查证伪的错误 plan 前提）**：`recordFeature(kind, detail)` **只到 live TUI/WS 看板，不落盘**——`observability/sinks/history.ts` 对 `request.feature_applied` 是 `case ...: { return }` **显式丢弃**（thinking coercion feature 同样 live-only，别拿它当「已验证进 history」的先例）。要真正**持久化** prepare 阶段诊断（供运维事后审计 history），落点是 **`pipelineInfo`**（`setPipelineInfo` 经 `context_updated` 落盘，与 `sanitization`/`truncation`/`messageMapping` 同类的 prepare 诊断持久容器）：`PipelineInfo` 加字段 → codec prepareWire 上抛（独立函数 return 带出，闭包方法 set latest 缓存 + getter）→ handler `setPipelineInfo` 取 getter 值。想同时要 live 看板就双通道（recordFeature + pipelineInfo）。给跨端点共享的 `WireRequest`/`UpstreamRequestLeg` 加单端点专属字段是 SSOT smell，避免。
4. **config→state 映射是 mandatory 不是「若有」**：`config.ts` 每个 strip 键都显式 `if (a.X!==undefined) setAnthropicBehavior({...: normalizeModelKeyedRecord(...)})`。漏映射则 config 键被 schema 解析却永不流入 state，源失效——而用 `setStateForTests` 直注 state 的测试会假绿掩盖。
5. **新 union 成员打爆的穷尽点跨子项目**：新增 `NegotiationCategory` 除后端 `never` 守卫，还打爆 `ui-v4` 的 `CATEGORY_LABELS: Record<NegotiationCategory,string>`——根 `typecheck` 不覆盖 ui-v4，须显式跑 `typecheck:ui-v4`（见 [[feedback-verify-ui-with-build-not-just-typecheck]]）。还要加进 `clearNegotiationMaps()` 否则测试污染。

**Why:** cache_control 子字段剥离 plan 经 subagent 评审抓出 1 CRITICAL（PrepareHints 归错位 + hint 死接线）+ 3 HIGH（ui-v4 编译门被验证命令绕过、history-leg 全链路缺 5 处且 TDD 假绿、config 映射当「若有」），全属「照 plan 字面执行会编译失败或功能静默不达成、而 plan 自带测试/typecheck 抓不到」。算法与正则（最易错处）反而实测正确——错在「想当然复用现有接线」。

**How to apply:** plan 里凡「消费/接入现有 interface、hint、leg、config 映射、union 穷尽」的落点，写之前先 grep 该机制的兄弟实例（如 `stripBetaHeaders` 全落点、`excludeToolFields` 全跳），逐跳核实、逐子项目核 typecheck 门，别凭名字相似归位。验证命令要覆盖真实功能路径（config 加载走真 config 非 setStateForTests、ui 走 typecheck:ui-v4）。相关 [[feedback-fix-all-comparison-sites]]、[[methodology-shared-mock-contract-change-breaks-sibling-test-files]]。
