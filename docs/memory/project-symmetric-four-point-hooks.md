---
name: project-symmetric-four-point-hooks
description: 对称四点 hook 架构重构（client/upstream × inbound/outbound）+ 统一翻译进 driver，起于剥 TodoWrite 块需求
metadata: 
  node_type: memory
  type: project
  originSessionId: f117b90e-e29e-4aed-8ed8-5dcb1f5b3c04
---

**大项目现状（2026-07-14→15，已实施于 worktree `feat/hook-symmetric-4point`，待合并 master）**。起点是用户要「剥离 messages 里客户端注入的 TodoWrite `role:system` 块」，一路演化为 hook 机制的架构重构。**7 phase 全绿落地**（提交 e4e01b76→a05436a9 + doc-sync 73ab12a7），零新增测试失败（base 上 7 个预存失败属并发会话 WIP）。

**关键转折链**：
1. 需求方否决 config+regex 声明式引擎，要求全面接入**编程 hook**。
2. 发现 hook 中间件机制**早已实施合并 master（`118a9c33`）、但无人使用**——我最初误当 greenfield（信了 spec 状态行 + 记忆 stub 没核实代码），被 reviewer 逮到。教训：动大工程前先核实命名目标是否已实现（[[feedback-verify-named-target-resolves-before-large-work]]）。
3. 用户提出**对称四点模型**：① client.inbound（客户端原生格式）② upstream.outbound（上游格式）③ upstream.inbound（上游格式）④ client.outbound（客户端格式）——每点由数据在生命周期的**格式位置**定义。这暴露 reviewer 说的「gemini 只有 CC 形状」不是约束、是 **gemini 把入站翻译放 route 层**的症状。
4. 用户选「统一翻译进 driver + 四点全做」（长远正确），把 v3 从「重命名迁移」升级为**架构变更**。

**根因**：gemini 入站翻译在 route 层，因 `codec.parse` 同步、而 gemini 翻译后跟一个 async 非幂等的 `processOpenAIMessages`（首步 `await applyConfigToState()`，[override.ts:131](../../src/lib/system-prompt/override.ts#L131)）。

**PoC 已验证结论**（`exp/hook-symmetric-4point/{async-translate-in.poc.ts,FINDINGS.md}`）：推荐**同步 native parse + 独立 async `translateInbound?(env):Promise<env>` 阶段**（不改 parse 为 async——会破坏同步 `inspectRequest` [types.ts:618](../../src/lib/pipeline/types.ts#L618)）。driver 新序 `S1a parse→client.inbound→S1b translateInbound→S2 translateOut→...`。gemini codec 重排 + route 收缩为 lifecycle owner。核心改动面 ≥6 生产文件。

**产物地图**：
- 权威 spec（hook 机制细节 + v3 命名重构 + §3.4/§3.5 provenance 不变量）：`docs/spec/2026-07-12-upstream-hook-middleware.md`（v3，含 §12 迁移面）。
- 重命名迁移 plan（现为大 RFC 的子集/一个 phase）：`docs/plan/2026-07-14-upstream-hook-v3-rename-migration.md`。
- PoC + FINDINGS：`exp/hook-symmetric-4point/`。
- shipped v2 ADR：`docs/decisions/2026-07-12-driver-orchestrated-upstream-hooks.md`。

**命名体系（定稿）**：`export const hooks = { client:{inbound,outbound}, upstream:{inbound,outbound}, exchange }`；`client|upstream`=body 形状、`inbound|outbound`=相对 proxy 方向；`on*` 前缀丢弃、`return undefined`=observe；旧 `onRequest→upstream.outbound`/`onExchange→exchange`/`rewriteUpstreamFrame→upstream.inbound`。

**下一步**：verifier 验收中 → 合并 worktree 回 master。RFC/spec/DESIGN/skill doc 已同步。

**实施期两条承重实测教训**：
- **loader data-URL 不解析 `~/` 别名**（实测证伪 spec 声称）：带 toolkit import 的 hook 静默丢导出（「exports none of」）。修=转译后写项目内唯一文件再 import（绕 Bun path-keyed ESM 缓存 **且** 经 tsconfig paths 解析别名）。cli-refusal-hook 陷阱注释是对的、spec 错。
- **parse 依赖 config 态时 config-freshness 须在 parse 前**（承重红线 2 泛化，非只 model）：cc 的 `buildChatCompletionsToolNameMapper` 读 `state.sanitizeToolNames`,下沉后 config reload 移到 parse 后→tool 名不 sanitize(tool-name-restore 测证伪)。分治:旧流程无条件调 applyConfigToState 的格式(cc)route 补无条件 reload;条件调的(anthropic `if(system)`)route 补条件 reload;不读 config 态的(responses/gemini)不加(加了会重置测试设的 state、打爆 call-id-normalization/WS 测)。

**评审逼出的承重修正（RFC v2 已纳）**：
- **HIGH-1（主会话 grep + reviewer 双证）**：async system-prompt 注入**非 gemini 独有、四格式都在 route 层早于 parse**（cc [chat-completions:157](../../src/routes/chat-completions/handler-v4.ts#L157)、responses [:141](../../src/routes/responses/handler-v4.ts#L141)、anthropic processAnthropicSystem、gemini [:152](../../src/routes/gemini/handler-v4.ts#L152)）。故 client.inbound 对**任何格式**都是 post-injection、非纯 native；配了 systemPromptOverride 命中 TodoWrite 会被 applyOverrides 抢先改写→剥块失效（核心用途缺陷）。修：四格式 async 入站处理**统一下沉 driver S1b、置于 client.inbound 之后**。
- **MEDIUM-1**：inspectRequest async 化爆炸半径——`withCapturingManager` 是同步（`fn:()=>T`），inspectRequest 返 Promise 会让隔离窗口在 async 副作用执行前关闭→逃逸；须 withCapturingManager 改 async + inspectRequest→Promise + RequestInspectStage 加 S1b + gemini dry-run parse 输出 CC→native 契约变更（Phase 2 全做非"或"）。
- **MEDIUM-2（需求方已拍板 §10）**：client.outbound **无单一 egress choke point**（sink 合成/心跳帧不经 renderFrames，[renderFrames 注释](../../src/lib/pipeline/driver.ts#L1028)是 load-bearing 约束）。四点**命名/语义首版到位、outbound 逐帧接线放 Phase 6**、前置 sink egress 统一化。
- 承重红线 1/2/3 评审核实**成立**：translateInbound 在 retry loop 外（runExchange 仅 :277/:985、buffered re-exchange 不经 runRequest）、model 解析留 S1a、去 originalBodyForHistory 补偿。

**7 phase**：0 golden 预捕（四格式+带 override 配置）→ 1 命名迁移（原子）→ 2 S1b 阶段+inspectRequest async 全套 → 3 四格式 async 入站下沉（route→S1b，每格式 route-删+codec-加同 commit 原子）→ 4 client.inbound+upstream 两点+exchange 接线+防御性 snapshot+cardinality → 5 剥块 helper+示例 → 6(gated) sink egress 统一化+client.outbound → 7 doc 同步+verifier 审计。

**行为反馈（本会话记忆库已记 [[feedback-never-unilaterally-switch-agent-model-on-flakiness]]）**：GPT reviewer 连挂勿擅换模型家族、resume 原 agent。
