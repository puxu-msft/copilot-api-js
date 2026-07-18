# Phase 2 三分类审计报告（Phase 3 直接桥蓝图）

> 只读审计产物（feature-dev:code-explorer，2026-07-14），主会话已核实承重断言（usage-normalize 格式无关 ✓、两 parseToolArguments 不一致 ✓）。裁判轴：长远正确 + 完整，归类保守（误归①代价大于漏归①）。

## 核心结构发现

**流式翻译文件可劈「写手半 / 读手半」**：写手半（如何拼合法目标格式帧序、index 正确）几乎全①可复用；读手半（从 CC `choices[]`/`delta.tool_calls[].index` 读）是②须替换为直接读 Anthropic/Responses 原生事件。唯二例外：`responses-to-cc-stream.ts` 读手（读 Responses 原生）+ `cc-to-anthropic-stream.ts` 写手（写 Anthropic 原生）本就非 CC 形状、可整体复用。**但写手/读手在同一状态机函数体内交织，物理提取须内部重构**（风险#4）。

**usage 精化**：`src/lib/request/usage-normalize.ts` 的 `netInputTokens`/`usageFromTotalInput` 已是格式无关纯原语，直接桥零重写调用。RFC「usage 须重推导」精化为：**核心算术已①、只外层字段名读取/组装须③重推**。

## 三分类清单（摘要，全文见下）

### ① 可提取（真跨格式通用）
纯原语（已存在、Phase 3 直接 import，无需提取）：`netInputTokens`/`usageFromTotalInput`（usage-normalize.ts）、`buildSyntheticReasoningSignature`族（synthetic-reasoning.ts）、`repairToolInput`级联（tool-input-repair）。
须新提取的纯 helper：
- `extractAnthropicToolUseFields`（anthropic-to-cc-request.ts:256-266 + anthropic-to-cc.ts:115-124，两处重复）
- `functionCallFieldsToToolUseBlock`（cc-to-anthropic-request.ts:205-223 bare 版 vs cc-to-anthropic.ts:175-197 repair 版**不一致**，统一取 repair 版）
- `anthropicSystemToInstructions`（= 现 `anthropicSystemToText` anthropic-to-cc-request.ts:137-142，复用给 Responses instructions）
- image data-url 双向（anthropic-to-cc-request.ts:299-307 解码 / cc-to-anthropic-request.ts:226-247 `parseDataUrl`）
- tool_result 文本提取（anthropic-to-cc-request.ts:275-297）/ tool output→result block 含 W3 守卫（cc-to-anthropic-request.ts:153-163）
- tool_choice 词汇映射（anthropic-to-cc-request.ts:337-358 / cc-to-anthropic-request.ts:286-302）
- `translateThinkingToEffort`/`budgetToEffort`（anthropic-to-cc-request.ts:369-398，复用给 Responses reasoning.effort + 补 summary:auto）
- Anthropic 流式发射工具组 `emitMessageStart`/`closeOpenBlock`/单调 index 分配（cc-to-anthropic-stream.ts:107-177，**须内部重构才能物理剥离**，风险#4）
- Responses 流式事件写手组（responses-to-cc-request.ts createCCToResponsesStreamTranslator ~L248-469）
- Responses 事件识别 switch 骨架（responses-to-cc-stream.ts:42-144 不含 buildChunk）

### ② CC-canonical 特有、须重新设计（直接桥不遇到）
- Multi-choices FOLD（anthropic-to-cc-request.ts:156-214 translateAssistantBlocks）/ SPLIT 读手（cc-to-anthropic.ts:117-142 + cc-to-anthropic-stream.ts renderFrame ~L182-291）
- CC 流式 tool_call index 分配/重映射（**风险#1 陷阱确诊**：cc-to-anthropic-stream.ts:253-254 `const ccIdx = tc.index` 读 CC 专有索引空间，表面①实则②）
- CC chunk 构建（anthropic-to-cc-stream.ts:121-141）
- CC-intermediate reasoning 走私（`delta.reasoning_encrypted_content` 等，cc-to-anthropic-stream.ts ~L207-225 / responses-to-cc-stream.ts:58-66,88-95,209-215）—— 直接桥 reasoning 直接从 Responses 事件流向 Anthropic thinking，跳过走私（下游写 thinking + 签名仍①）
- server tool「检测+丢弃」动作（anthropic-to-cc-request.ts:317-334，检测 `isApiDefinedToolType` 可复用识别①、丢弃动作换③映射，**风险#6**）
- `aggregateStopReason` 多 choice 聚合（cc-to-anthropic.ts:203-212）

### ③ 须重新推导（直接桥需要、不能拼接现有）
- **stop_reason/status 三方不同构**（Anthropic 6值 vs CC 4值 vs Responses 4值+incomplete_reason 2值）：**RFC 只点名 usage、审计发现 stop_reason 同性质**（经 CC 中转 `refusal`/`pause_turn` 退化为 `end_turn`，直接桥不应继承退化）。分散在 anthropic-to-cc.ts:150-167 / cc-to-anthropic.ts:208-212 / responses-to-cc.ts:84-106 / responses-to-cc-request.ts:503-525。**建议与 usage 同优先级③**。
- **usage 外层字段组装**（内部调已确认①算术）：responses-to-cc.ts:108-124 与 responses-to-cc-stream.ts:217-243 **重复未去重**（风险#7，提取时顺带去重）。Responses `reasoning_tokens` 在 Anthropic 侧无对应字段、须决定丢弃 or extension。
- **Responses flat items → Anthropic 折叠消息**（反向请求侧）：**审计发现现有 Responses→CC 跳本身不折叠**（translateInputItemToMessages responses-to-cc-request.ts:580-621 拆多条独立 CC assistant 消息），直接桥 Responses→Anthropic 须新写「识别连续同轮 items 折叠进一条 MessageParam content[]」状态机。**RFC 未提、审计新增、需裁决**（风险#3）。
- **Anthropic 真签名 thinking → Responses reasoning item 反向 round-trip primitive**：当前零代码基础，全新（RFC §4.2 已标待新建，工作量最大/不确定性最高，建议 Phase 3 单独立项）。
- **reasoning encrypted_content 捕获时机**：现 responses-to-cc-stream.ts:58-66 在 `.added` 捕获 = **真实缺陷**（Phase 0 探针证 added≠done、done 权威）。直接桥须从零设计「暂存最新、仅 done 提交」缓冲，**绝不以此文件为模板**。
- Anthropic server tool → Responses `web_search_preview` 名称/schema 映射表（零参考实现，RFC §5.1 非零工作）。

## 主会话裁决（2026-07-14）

1. **Phase 2 收敛为「审计蓝图 + 已存在纯原语确认」，物理提取折叠进 Phase 3 just-in-time**：已存在的纯原语（usage-normalize/synthetic-reasoning/tool-input-repair）Phase 3 直接 import 无需提取；须新提取的 helper 在 Phase 3 写直接桥时**就地提取**（old+new 同指、golden 兜底），不做独立投机提取相。**理由**：① 流式写手/读手交织、物理提取须重构 byte-critical golden 锁定的流式代码，为边际物理复用churn 高风险大（风险#4）；② 独立提取相的 helper 签名是投机的，Phase 3 才知确切需求；③ 强行物理提取交织代码 = R-NO-INTERNAL-ADAPT 禁止的「为适配旧内部模块扭曲结构」。Phase 3 复用「知识/算法」而非强行物理 import。
2. **两处 RFC 未点名的 scope 纳入 Phase 3**（against-yagni、审计完整性）：stop_reason/status ③（与 usage 同优先级）；Responses→Anthropic item 折叠状态机 ③（反向请求侧）。
3. **陷阱/缺陷记死**：cc-to-anthropic-stream.ts:253-254 CC index 陷阱（勿误提取）；responses-to-cc-stream.ts:58-66 capture-timing 缺陷（勿继承、Phase 3 从零设计 done 捕获）。
