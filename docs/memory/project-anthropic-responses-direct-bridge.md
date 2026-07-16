---
name: project-anthropic-responses-direct-bridge
description: anthropic↔responses 直接桥 + hub-translate 重塑为 per-pair 桥选择器（RFC 定稿、审查中、未实现）——推翻 CC-as-canonical 前提。权威 docs/rfc/2026-07-14-anthropic-responses-direct-bridge.md
metadata: 
  node_type: memory
  type: project
  originSessionId: 6d3ca528-62fc-4185-bcfb-7992d9022f37
---

**anthropic↔responses 直接桥**（2026-07-14 RFC 定稿、两 reviewer 审查中、未实现）。源起用户裁决「non-CC↔non-CC 经 CC 中转有损违背 richest-data-flow」，接手 [handoff](../todo/anthropic-responses-direct-mapping-handoff.md)（两轮对抗审查硬发现）。

**四个中心分叉的用户裁决**（brainstorming 收敛）：
1. **hub 形状** → 重塑 hub-translate 为 **per-pair `(source,target)` 桥选择器**（全面显式桥表、漏对=编译错），非「保住 CC-hub 挖洞」。用户明确「全面显式桥接」。**关键校正**：cell-assembly C0-C6 后出站层**已是 `(cf×te)` 穷尽笛卡尔积**，托管结构已存在，本 RFC 只重塑 hub-translate **内部**翻译原语选择、不动 cell-assembly/driver。
2. **桥范围** → 前向 `(anthropic→responses)` + 反向 `(openai-responses→messages)` **一次做完**（同一对称对、同类债务）。
3. **reasoning** → **全链路 round-trip、决不妥协**（用户强指令「全链接是最优方案，决不妥协」）。复用 `synthetic-reasoning.ts` 哨兵签名封装**真·上游签发密文**跨轮回喂。
4. **server tool** → 归入**通用 server-tool 透传策略**（web_search 为其一 case、不特例化）。

**真伪密文分水岭（承重洞见）**：退役 web_search 双跳撞 `encrypted-content-400` 死墙是因**伪造**空密文；直接桥回传的是**上游真实签发真密文** → 物理上可 round-trip。机制不同（原生透传 vs 合成双跳）→ 不复活退役死坑、不与退役 ADR 冲突。

**两场景 · 代理无法自动判定 → per-pair 配置**（§4.3，用户提出）：
- **场景 A** 稳定模型（anthropic-messages 入口始终访问同一 responses 模型）：signature↔encrypted_content + 文本全互填，完整 round-trip。
- **场景 B** 中途切模型：旧密文跨模型失效 → 剥 signature/encrypted、**仅文本互填**保上下文。
- **同格式跨模型**（gpt-5.5→gpt-6 都 @openai-responses）前缀检测抓不到 → 必须配置声明。config `model_translation`（key=ingress format、value=match `model@format` 规则列表、`features:['strip-thinking-signature']`）。配 `model_overrides`→`model_mappings`（复数，实施时用户裁决订正 RFC 原文单数拼写）重命名（留旧键别名）。

**五条红线防怪味**（§9）：R-EXPLICIT（全显式桥表不挖洞）｜R-NO-INTERNAL-ADAPT（byte-equivalence **仅指客户端 wire 边界**、绝不为适配旧内部模块扭曲结构）｜R-GOLDEN-TWO-ZONE（等价区用旧 golden、**改进区绝不用旧有损 golden 当目标**）｜R-DIRECTION-ASYMMETRY（真 signature 转发 vs 哨兵合成两路径不共享）｜R-NO-REVIVE（server tool **请求侧**走工具声明映射;**响应侧结果回显永远降级**、不复活退役合成双跳）。

**方法论实例**：用户「一旦设计出现妥协/怪味立即警告」→ 本会话主动标记并处置 3 处潜在怪味（串联 if 挖洞→全显式桥表、旧 golden 焊死改进区→双区划线、合成 thinking 不分真伪→两路径）。extract-not-rewrite：提取纯块映射 helper、全新最佳实现、旧 CC-via 降为事后 regression oracle（用户「原文全部重写、旧方案只用于事后验证无 regression」）。相关 [[feedback-existing-code-has-no-authority-dont-accommodate]]、[[feedback-byte-equivalence-is-proxy-calibrate-by-consumer]]、[[project-reasoning-passthrough-synthetic-thinking]]、[[feedback-never-propose-short-term-mitigation]]。

**权威**：[RFC 2026-07-14](../rfc/2026-07-14-anthropic-responses-direct-bridge.md)（v2，§9 红线 + §7 P0 探针 + §11 OQ）。

**两轮异模型对抗审查裁决（全部亲手核实 file:line → v2 订正 commit a0e2c2e7；round-2 定向复审中）**：
- **GPT BLOCKER（我未预见、被静态证伪）**：server-tool 结果回显「与 reasoning 同构可 round-trip」**错**——`ResponsesOutputItem` union（openai-responses.ts:204）只有 message/function_call/reasoning、**无 web_search item、搜索结果不带 encrypted_content**。回显须**合成**密文=撞退役双跳死墙。→ 分水岭**只对 reasoning 成立**（真密文）、server-tool 结果**不成立**（无密文）;诚实边界=请求侧透传无损 + **结果回显永远降级 tool_use/text 绝不合成**（物理约束非妥协）。
- **Claude MAJOR**：①前向请求腿**非 hub-内部**跨 translateOut+prepareWire(leg:119)+retry-baseline(cc-family:38)**三点**（产 Responses body 会双翻译）②`model_overrides` 是**顶层键**（schema:982）非 `model.` 段;兼容归 compat:159 renameLeaf、漏 config.schema.json 重生成 ③反向 round-trip synthetic-reasoning **单向须新建 primitive**、未 P0 探针。
- **GPT MAJOR**：①reasoning encrypted_content `added`≠`.done`（1632→1744，同族 [[reference-ghc-responses-item-id-reencrypted-per-event]]）现只捕 added→P0 须验权威版 ②extract **三分类**（可提取 tool-id/text｜须重设计 CC-特有 multi-choices+tool_call index｜须重推导 usage 三方 cache token 不同构）。

方向核心两 reviewer 一致成立。下一步：round-2 复审确认 → 用户审 RFC → writing-plans。

**实施进度（plan `docs/plan/2026-07-14-anthropic-responses-direct-bridge/`）**：
- **Phase 0 ✅ landed**（探针，commit 6dbc8418）：reasoning round-trip 物理可行（added 1600≠done 1684；回喂 done/added/空全 200 → Responses reasoning 端点**不 gate** encrypted_content、非 400 墙）；server-tool 请求侧透传可行但 web_search_call 无 enc 字段→anthropic-facing 渲染须降级；反向路由工作、端到端留 Phase 4/5 复验。权威 [FINDINGS](../../exp/anthropic-responses-direct/FINDINGS.md)。分水岭精化：端点差异（Anthropic search_result gate / Responses reasoning 不 gate）非真伪差异。
- **Phase 1 ✅ landed**（hub-translate 四分发器重塑穷尽 `satisfies Record` 桥表，commit 1fc15bb8/001e1c96/ce426190/45c264e3）：`(anthropic,chat)` 与 `(anthropic,responses)` 拆独立表项（都仍产 CC、字节等价、无新桥——Phase 3 只换 responses 一格）；golden 60 pass/0 fail 独立核验；只碰 hub-translate.ts、未碰 cell-assembly/driver/cells。
- **Phase 2-6 待做，Phase 7 ✅ landed**：Phase 2 extract 三分类 helper → Phase 3/4 前向/反向直接桥 → Phase 5 reasoning round-trip（前向捕 done 版）→ Phase 6 server-tool。Phase 7（配置 `model_mappings` 重命名 + `model_translation`）已实施：字段拼写实施时被订正为**复数** `model_mappings`（同伴并发会话已手改 bundled `config.yaml` 为复数、用户随后明确裁决以复数为准，RFC/plan 正文已同步订正）；compat renameLeaf 迁移测试 + `model_translation` 解析/match 测试均绿；`tests/config tests/models` 全绿（既有基线失败 `Coverage completeness`/`responses-to-cc-stream` 与本改动无关，已核实）。
- **Phase 2 ✅ landed**（三分类审计蓝图 ebe76484）：物理提取折进 Phase 3 JIT（避免为投机提取扭曲 byte-critical 交织流式代码）；stop_reason/usage 外层组装③、item 折叠③ 纳入 Phase 3/4；陷阱记死。权威 [phase-2-audit](../plan/2026-07-14-anthropic-responses-direct-bridge/phase-2-audit.md)。
- **Phase 3 ✅ landed（前向直接桥，合并态审查完成+全修）**：A 请求腿（69b82024，三点一致改）+ 怪味修复（9f0203a9 `bodyIsResponsesShaped` 分离「wire 形状」与「translateOut 跳过翻译」两概念、删与 direct 逐字节重复的 anthropic 旁路）+ B 响应非流式（cd1a5be6，单跳 stop_reason/usage）+ content_filter 修复（eff3db9c）+ C 响应流式（0fd3fbbf，自持终端 meta、reasoning **只在 output_item.done 捕获**、Anthropic 单调 index 不引用 CC tc.index）+ 审查修复（43fd6f5e）。**合并态审查（Claude 交叉审 GPT 实现）逮 1 MAJOR：流式/非流式 mapUsage 用小原语 `netInputTokens` 丢 `reasoning_tokens`（richest-data-flow 回归 + false-green，无测试）——改用完整 `usageFromTotalInput` 透传、false-green 先红后绿证据 + mutation-test 验证负样本有效**；2 minor（流式 contentFiltered marker 接线、stop_reason 前瞻脆弱）+ nit 全修。1946 pass 核验。教训=用小原语而非完整 usage 原语是保真隐形回归、合并态审+亲手核实才逮到 [[feedback-byte-equivalence-is-proxy-calibrate-by-consumer]]。
- **Phase 4 ✅ landed（反向直接桥 D+E+F，合并态审查完成+全处理）**：D 反向请求腿 + item 折叠状态机（9d6fc30e，Responses flat items→Anthropic 一轮一条、并行 function_call 折一条 assistant 多 tool_use、text 排 tool_use 前；WARN-E reasoning 绝不合成 dropped）+ E 反向非流式（4888edd4，usage 反向 gross-up + reasoning_tokens 透传+false-green 测试**吸取 Phase 3 教训**；pause_turn/refusal→诚实新 reason 字符串、reviewer 赞同**不重犯 content_filter 混淆**）+ F 反向流式（2d78a3d8，自持终端 meta、真 Claude 签名**明文渲染但绝不泄漏**测试锁死、载体留 Phase 5、output_index 自持）+ 审查 MAJOR-1 修复（94c53a3d）。**合并态审查（Claude 交叉审）逮 1 MAJOR-1：流式反向 message_start 只读 model 不采 usage→客户端 usage null（Phase 3 同类复发 false-green）——修=message_start seed terminalUsage、false-green 撤 seed 行则红实测闭环**；MAJOR-2（mid-conv system 折独立 user turn→相邻同角色）**探针 (d) 定级：GHC 接受相邻同角色 200→降级为语义差异非 wire 回归、当前行为 wire-safe+保位置无需修**（FINDINGS 探针 d）；reasoning 项 stream/nonstream 一致性 2 minor **留 Phase 5 统一 per-block**；pause_turn/refusal doc 记录待收尾。独立 2659 pass 核验。
  - **Phase 5 ✅ landed（reasoning 全链路 round-trip 两向 + 两场景，合并态审查完成 0 blocker/0 major）**：载体 primitive `claude-signature-carrier.ts`（3770bc73，前缀 `copilot-api:claude-signature:v1:` ≠ 前向哨兵 `synthetic-reasoning` 前缀、两路径独立函数无共享调用点 = R-DIRECTION-ASYMMETRY wire 层）+ 前向回传腿（039521b0，客户端回传哨兵 thinking→提取 done 密文→重建 Responses reasoning item）+ 反向 F 真签名载体+per-block（cbecc96a）+ 反向 D 重建裸真签名 thinking 回喂 Claude（6e40e892，测试证经 stripSyntheticReasoningBlocks 原样存活、`isSyntheticReasoningSignature`===false）+ 两场景 features（6874027d，strip-thinking-signature 场景 B 剥签名保文本、消费 resolveTranslationFeatures）+ backlog（98bef8ee）。**探针 (e) 实测坐实反向物理可行**（真签名 byte-exact 回喂 200、篡改 400、明文改不影响、signature_delta 只发一次无 added/done 陷阱）。byte-exact oracle `extractClaudeSignature(build(sig))===sig`。独立 1122 pass 核验。合并态审查（Claude 交叉审）0 blocker/0 major，仅 2 minor（modelIdFor 零消费者→4 site 统一用、缺端到端 F→D byte-exact oracle→补 26b1dcd3）+ 2 nit（reconstructThinkingBlock 空 content 回退 summary、docstring 同步单跳）全修（5f9a7d81/26b1dcd3/f0eab5c2），1943 pass；三相里最干净（agent 跨相学习+checkpoint 前置红线守住）。

→ **anthropic↔responses 双向结构桥全部落地+审查（前向 Phase 3 + 反向 Phase 4），CC 中转在这一对上完全绕开**。剩 Phase 5（reasoning 全链路 round-trip 两向：渲染升级为可回喂续接 + per-block 统一 + 反向 primitive）+ Phase 6（server-tool）。注：实现 agent transcript 跨进程边界丢失、resume 不可用，Phase 5 须 fresh agent 带上下文（Phase 3/4 代码作 pattern）。

**两个 checkpoint 裁决教训（本会话，orchestrator 亲手核实 file:line 非橡皮图章）**：
- **怪味「已 direct 塞进 via 路径」**：agent 把已 Responses 形的 anthropic 塞进 `prepareViaResponsesWire` 加一个与 `prepareResponsesDirectWire` 逐字节重复的旁路。根因=`isDirect` 一个谓词混了「wire 形状」与「跳过翻译」两概念。修=拆两谓词、anthropic 走 direct 路径。
- **审计意见过度应用（content_filter→refusal）**：agent 采纳审计「别继承 CC 退化」但**过度**——审计对 Anthropic 真有的值（refusal/pause_turn，CC 丢了）成立，但 content_filter 是 Anthropic **客观无对应 stop_reason** 的情况（cc-to-anthropic.ts:27-28 记载），且 Responses 自身把 content_filter（审核过滤）与 refusal（模型拒答）区分为两概念（responses-to-anthropic.ts:119-121）。裁决=沿用既有 N3（end_turn + contentFiltered marker）。教训：「别继承退化」的正确适用范围是「目标格式真有对应值」，目标无对应值时保守映射+marker 才保真。相关 [[methodology-broken-reference-supply-vs-delete]]、[[feedback-never-paper-over-smells-warn-loudly]]。
