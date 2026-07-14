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
- **同格式跨模型**（gpt-5.5→gpt-6 都 @openai-responses）前缀检测抓不到 → 必须配置声明。config `model_translation`（key=ingress format、value=match `model@format` 规则列表、`features:['strip-thinking-signature']`）。配 `model_overrides`→`model_mapping` 重命名（留旧键别名）。

**五条红线防怪味**（§9）：R-EXPLICIT（全显式桥表不挖洞）｜R-NO-INTERNAL-ADAPT（byte-equivalence **仅指客户端 wire 边界**、绝不为适配旧内部模块扭曲结构）｜R-GOLDEN-TWO-ZONE（等价区用旧 golden、**改进区绝不用旧有损 golden 当目标**）｜R-DIRECTION-ASYMMETRY（真 signature 转发 vs 哨兵合成两路径不共享）｜R-NO-REVIVE（server tool **请求侧**走工具声明映射;**响应侧结果回显永远降级**、不复活退役合成双跳）。

**方法论实例**：用户「一旦设计出现妥协/怪味立即警告」→ 本会话主动标记并处置 3 处潜在怪味（串联 if 挖洞→全显式桥表、旧 golden 焊死改进区→双区划线、合成 thinking 不分真伪→两路径）。extract-not-rewrite：提取纯块映射 helper、全新最佳实现、旧 CC-via 降为事后 regression oracle（用户「原文全部重写、旧方案只用于事后验证无 regression」）。相关 [[feedback-existing-code-has-no-authority-dont-accommodate]]、[[feedback-byte-equivalence-is-proxy-calibrate-by-consumer]]、[[project-reasoning-passthrough-synthetic-thinking]]、[[feedback-never-propose-short-term-mitigation]]。

**权威**：[RFC 2026-07-14](../rfc/2026-07-14-anthropic-responses-direct-bridge.md)（v2，§9 红线 + §7 P0 探针 + §11 OQ）。

**两轮异模型对抗审查裁决（全部亲手核实 file:line → v2 订正 commit a0e2c2e7；round-2 定向复审中）**：
- **GPT BLOCKER（我未预见、被静态证伪）**：server-tool 结果回显「与 reasoning 同构可 round-trip」**错**——`ResponsesOutputItem` union（openai-responses.ts:204）只有 message/function_call/reasoning、**无 web_search item、搜索结果不带 encrypted_content**。回显须**合成**密文=撞退役双跳死墙。→ 分水岭**只对 reasoning 成立**（真密文）、server-tool 结果**不成立**（无密文）;诚实边界=请求侧透传无损 + **结果回显永远降级 tool_use/text 绝不合成**（物理约束非妥协）。
- **Claude MAJOR**：①前向请求腿**非 hub-内部**跨 translateOut+prepareWire(leg:119)+retry-baseline(cc-family:38)**三点**（产 Responses body 会双翻译）②`model_overrides` 是**顶层键**（schema:982）非 `model.` 段;兼容归 compat:159 renameLeaf、漏 config.schema.json 重生成 ③反向 round-trip synthetic-reasoning **单向须新建 primitive**、未 P0 探针。
- **GPT MAJOR**：①reasoning encrypted_content `added`≠`.done`（1632→1744，同族 [[reference-ghc-responses-item-id-reencrypted-per-event]]）现只捕 added→P0 须验权威版 ②extract **三分类**（可提取 tool-id/text｜须重设计 CC-特有 multi-choices+tool_call index｜须重推导 usage 三方 cache token 不同构）。

方向核心两 reviewer 一致成立。下一步：round-2 复审确认 → 用户审 RFC → writing-plans。
