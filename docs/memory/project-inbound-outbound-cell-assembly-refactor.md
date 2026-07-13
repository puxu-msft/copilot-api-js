---
name: project-inbound-outbound-cell-assembly-refactor
description: 大重构（在飞,设计定稿→新会话实现）——codec 对象模型沿两轴拆:集中化 (clientFormat×targetEndpoint) cell 装配,消灭 Phase 7 暴露的出站关切散布。权威看 RFC 2026-07-13 §0.1/§11/§11.9 + plan
metadata:
  type: project
---

**codec 对象模型重构（cell-assembly）**——源起 Phase 7 前向腿生产 500 bug 暴露的**结构性轴错配**:通用翻译矩阵的两轴（clientFormat 入站 × targetEndpoint 出站）只活在数据层（env 两字段）,对象层只有一根轴（`FormatCodec` by clientFormat）,出站关切被打散进 `{strategy-registry 供料袋 + 4 handler 供料工厂 + codec 跨格 delegate + codec 内 isForwardTranslateLeg 分叉}`——漏填一腿供料 = 深埋 handler 静默 500,每加一格复发。用户授权全拆分、长远正确、评审委托 agents。

**状态：设计定稿并 landed master（RFC + 三层 plan,3 commit `7fe6973a`/`820e5332`/`80eca340` + plan `273b1fb7`）;byte-critical 实现（C0-C6）交新会话从 kickoff T4 开始。**

**权威文档**（同一事实只写一处,深层看这些）:
- [RFC 2026-07-13](../rfc/2026-07-13-inbound-codec-outbound-leg-split.md)——**§0.1 三轮首轮裁决 + §11 定稿设计 + §11.9 v3 修订为权威**（§2-§10 是被证伪的 v1 ⊥ 正交,存档对照）。
- 三层 plan [docs/plan/inbound-outbound-split/](../plan/inbound-outbound-split/)（plan.md:C0-C6 factory 锚点表 + 12-cell 真实策略栈 + R1-R5 红线;prompts/README:严格串行 DAG）。
- [交接 kickoff](../rfc/inbound-outbound-split-kickoff.md)（T1-T3 已完成、新会话从 T4 起）。

**定稿设计（v2/v3）**:不是"两正交对象族"（被证伪）,而是**集中化 2D cell 装配**——`resolveCellAssembly(cf,te)` = `OUTBOUND_LEGS[te]`（wire,穷尽 Record）× `RETRY_SEMANTICS[cf](env)`（策略语义,穷尽 Record,**读 env.targetEndpoint**）,笛卡尔积覆盖全 cell 空间 → 漏=编译错（消灭 Phase 7 静态 throw）;跨轴态用显式载体（`env.requestState` readonly 字段 + ctx + per-request exchange scratch）非 codec 闭包 accessor;codec 不 import codec、delegate 全删。

**RFC-first 承重教训（本次最大价值,`large-refactor` §1 实证）**:
- **⊥ 干净正交在对象层不可达**——两轴**纠缠**:①策略装配是 2D（同 `/chat/completions` 腿,CC direct 有 auto-truncate、Responses fallback 没有）②供料从 parse 流向 strategy（truncateBaseline/resanitize 是 parse 捕获态,retry 已变异 env.body 不可复原）③exchange 态跨轴共享（responseId/itemId 出站 prepareWire+入站 render 都消费）。原翻译矩阵 RFC §3.1 本就叫它"**缝合模型**二维门控",v1 反而过度正交化。
- **auto-truncate 不是 clientFormat 标量（照字面即 BLOCK 行为 bug）**——`(openai-responses, /v1/messages)` 反向腿 auto-truncate **ON**、其 direct 腿 **OFF**;任一轴单独都拆不开。→ 红线 R1:`RETRY_SEMANTICS[cf](env)` 读两轴,该 corner cell 必补 auto-truncate-在栈 golden。第二轮 reviewer 核 12 cell 真实策略栈才逮到。
- **稳定态不入 replace-semantics prepareHints**（R2）——PrepareHints 每次 retry 完整覆盖 + attempt 0 清空,请求生命周期稳定态（truncateBaseline/betaProbe 句柄/anthropic-beta 种子）塞进去会被首次带 hint 的 retry 清空 → 住 `env.requestState`。
- **betaProbe 惰性引用读非 eager 快照**（R3,重造 Phase-7 隐蔽 bug）。
- **测试用 strategies:[]/dry-run 绕过真生产接缝 = 绿而不能用**（R4,Phase 7 根因 [[project-universal-translation-matrix]]）——根因修复必配"真驱动装配器 + 负样本对照"的 IT。→ [[feedback-pass-null-clean-not-self-validating]] 验证簇。
- **过程**:RFC v1 → 首轮 3 并行对抗视角（遗漏关切/cutover/接口契约,证伪 ⊥ 正交,3 BLOCK）→ v2 转向 → 次轮 1 深度（核 12 cell,2 HIGH,判"核心 RESOLVED 可进 plan"）→ v3 钉红线。主会话对每个 BLOCK/HIGH **亲手复核 file:line**（`verifying-authoritative-claims`）,不信 reviewer 自证。两轮挡下 v1 两处会致上千行返工的过度简化。

**关键 file:line**（新会话实现锚点,§0.1/plan 已列全）:driver 5 构造点（messages:419/chat:151/responses:140/gemini:113/ws:232）+ 出站单槽派发（driver.ts:202 strategies 先于 :309 prepareWire）;betaProbe 惰性读 anthropic/strategies.ts:126;auto-truncate corner responses/handler-v4.ts:157(反向 ON) vs :168(direct OFF);PrepareHints replace-semantics pipeline.ts:244;factory 锚点表见 plan.md。
