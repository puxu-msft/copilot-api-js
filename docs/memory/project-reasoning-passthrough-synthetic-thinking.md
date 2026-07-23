---
name: project-reasoning-passthrough-synthetic-thinking
description: GPT reasoning→Anthropic thinking 透传特性（全链路 landed master，含请求 summary:auto+F-1 修复、响应桥接、标签封装签名）——推翻「丢 reasoning 是可接受协议约束」的旧分类。权威看 DESIGN.md 通用翻译矩阵行 ④ + exp/synthetic-reasoning-* FINDINGS
metadata: 
  node_type: memory
  type: project
  originSessionId: 9a3b80e1-11ef-499d-bb09-d2e2006f8b82
---

**GPT reasoning → Anthropic thinking 块透传**（2026-07-14 全链路 landed master，5 commit `cb87ed65`→`f8989b08`）。源起用户裁决「reasoning 被丢是错误行为、要包装好透传」，**推翻了评审+我先前把「丢 reasoning」归为「可接受协议约束」的分类**——按 richest-data-flow，GPT 可见推理有价值、该透传。

> ⚠️ **架构注记（2026-07-14）**：本实现走 **CC 中转 side-channel**（`reasoning_encrypted_content` 私挂 CC delta/message + cast 偷运），是「保住窄 CC hub、往上焊旁路」的 **accommodation，不是终态**——正撞评审 #7「CC-as-hub 类型太窄」病根。用户已决定给 (anthropic↔responses) 做**直连映射**取代它，见 [anthropic-responses-direct-mapping-handoff.md](../../todo/anthropic-responses-direct-mapping-handoff.md)。直连落地后 CC 旁路即死码，仅 `synthetic-reasoning.ts` 封装 primitive 复用保留。**教训 [[feedback-existing-code-has-no-authority-dont-accommodate]]**：我明知是 #7 病根仍焊旁路 landed，把「hack now/转正 later」当默认——用户豁免仪式（探针/测试时序）≠ 豁免最佳方案。



**三条实测背书（探针，权威 exp/synthetic-reasoning-* FINDINGS.md，force-tracked）**：
- **①SDK 接受**：真 @anthropic-ai/sdk **接受**哨兵签名 thinking 块（不校验 signature、正样本对照证乱序会 reject）——故用原生 thinking 块不回退 text。
- **②主路径休眠**：gpt-5.x Responses 主路径**不吐明文 reasoning**（只 `encrypted_content` 加密 + **空 summary**，因没请求）；CC 腿连 `delta.reasoning` 都没有。→ 催生请求侧改动。
- **③summary 事件形状**：请求 `reasoning.summary:"auto"` 后，**medium+ effort** 才吐 `response.reasoning_summary_text.delta`（明文增量）；**low effort 即使请求也可能无 summary**——桥接须容缺、不产空 thinking 块。

**实现（全链路）**：
- **请求侧** `cc-to-responses.ts`：CC `reasoning_effort`→Responses `reasoning.effort`（**顺带修评审 F-1 二跳丢失**）+ 请求 `summary:"auto"`。
- **响应侧桥接** `responses-to-cc-stream.ts`：`reasoning_summary_text.delta`→CC `delta.reasoning`、reasoning item `encrypted_content`→CC `delta.reasoning_encrypted_content`（新 `buildReasoningChunk`）；非流式 `responses-to-cc.ts` 同理。
- **渲染** `cc-to-anthropic-stream.ts`/`cc-to-anthropic.ts`：reasoning→thinking 块（thinking-first index 0）。
- **标签封装签名** `lib/anthropic/synthetic-reasoning.ts`：`copilot-api:synthetic-reasoning:v1:<base64url(encrypted_content)>`——**前缀无歧义标记我方**（防毒化）+ **载荷藏 encrypted 供跨轮 round-trip**。
- **防毒化红线** `sanitize/{index,content-blocks}.ts` 的 `stripSyntheticReasoningBlocks`：echo 回来**无条件剥离**（不受 `thinkingBlockSanitizeCheck` 门控）——不可伪造签名永不触达真 Claude 直连腿（否则撞「cannot be modified」400，见 skill `ghc-anthropic-upstream`）。

**承重不变量**：前向合成哨兵 thinking（靠剥离守卫兜底）与 ⑤反向「绝不合成 thinking」**是不同方向的不同契约、不冲突**（DESIGN.md 已注明）。

**方法论实例**：类型定义会误导（探针②证「类型说有 summary、实测空」）——桥接契约**必须建在实测事件形状上**（[[methodology-client-source-grep-not-rest-capability-probe-endpoint]] 同族）；SDK 接受性/上游形状这类经验未知**必须探针**，不凭推理（用户虽指示先实现后探针，但探针最终揭示主路径休眠→倒逼请求侧改动）。相关 [[feedback-richest-data-flow-store-complete-no-pruning]]、[[feedback-synthetic-data-must-be-distinguishable-from-real]]。

**遗留**（backlog）：流式交错并行 tool-call 非法 block 序列（评审#1，`test.todo` 已复现，正确修法=累加器重渲染大改）；low-effort 无 summary 时 encrypted reasoning 跨轮丢失（LOW 边角）。
