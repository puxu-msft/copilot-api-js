# 探针实测结论：OQ1 (thinking 保真) / OQ3 (tool_use.id 格式)

实测时间：2026-07-11｜方式：经运行中的 4141 实例直打 OpenAI 端点，model 用真实 GHC 上游｜原始响应留存同目录 `probe*.json`。
用途：为 [anthropic-via-openai-translation](../../docs/spec/anthropic-via-openai-translation.md) 的 §6/§7 翻译映射 + OQ1/OQ3 提供实测裁决（`empirical-verification`：实测 > 文档推断）。

## Probe 1：cc 腿 (claude-opus-4.8) 非流式 + tool + reasoning_effort:high

请求：`POST /v1/chat/completions`，model=claude-opus-4.8，带 get_weather tool，tool_choice=auto，reasoning_effort=high，stream=false。

**关键发现**：
1. **OQ3（cc 腿 tool id）✅**：`tool_calls[0].id` = **`toolu_01SRN1APL8hGsyTjJdpi7dAT`** —— **`toolu_` 前缀**，不是 OpenAI 的 `call_`。因为底层仍是 Claude，GHC 的 cc 腿对 Claude 模型**保留 Anthropic 原生 tool id**。→ **claude-via-cc 路径 tool id 原样透传即往返自洽，无需改写**。
2. **反常结构**：GHC 把 text 和 tool_use 拆成**两个独立 choices**（choices[0] 只 content 文本、choices[1] 只 tool_calls），都 `finish_reason:"tool_calls"`。→ Anthropic→CC 请求翻译 + CC→Anthropic 响应翻译的状态机**必须处理多 choices 分裂**，不能假设单 choice。
3. **OQ1（cc 腿非流式 reasoning）**：message 里**无 `reasoning`/`reasoning_content` 字段**（即便 reasoning_effort:high）。→ 非流式 cc 腿不回传 reasoning 内容。
4. id 形态：顶层 `id":"msg_011Ccvw..."`（Anthropic msg_ 前缀）、usage 是 CC 形（prompt_tokens/completion_tokens/prompt_tokens_details.cached_tokens）。

## Probe 2：responses 腿 (gpt-5.5) 非流式 + tool + reasoning:high

请求：`POST /v1/responses`，model=gpt-5.5，带 get_weather tool，reasoning.effort=high，stream=false。

**关键发现**：
1. **OQ3（responses 腿 tool id）✅**：`output[0].call_id` = **`call_KQVd6lUDoCA1lU05sv1lOrjm`** —— **`call_` 前缀**（OpenAI 原生）；另有 `output[0].id` = 一大段 **加密 blob**（`LRAqnojI3...` base64 密文，responses 腿的 item id 是加密的）。→ responses 腿（gpt-5.5 等 OpenAI vendor）tool id 是 `call_*`，与 Anthropic `toolu_*` **不同前缀**。
2. **OQ1（responses 腿 reasoning）**：`reasoning: {context:"current_turn", effort:"high", summary:null}` —— reasoning **summary 为 null**，无实际 reasoning 内容回传（非流式）。
3. 结构：responses 是 `output[]` 数组、`type:"function_call"`、无 CC choices 概念。

## 对 spec 的直接结论

| 问题 | 实测裁决 | 对 §6/§7 的影响 |
|---|---|---|
| OQ3 cc 腿 (claude) tool id | `toolu_*`（Anthropic 原生）| 原样透传即往返自洽，claude-via-cc **无需 id 改写** |
| OQ3 responses 腿 (gpt) tool id | `call_*` + 加密 item id | 若客户端下一轮回传，Anthropic SDK 可能校验 `toolu_` 前缀 → **responses 腿需评估 id 归一**（留 Phase 2/3 校准，且 responses item id 加密不可伪造，透传即可）|
| OQ1 非流式 reasoning | cc 腿无字段 / responses 腿 summary:null | 支持 spec 的 **best-effort 丢弃/占位默认**；**流式侧未测**（reasoning 常在流式帧，留实现阶段 Phase 3/4 探针）|
| 多 choices 分裂（新增发现）| cc 腿 text/tool 拆两 choices | 翻译状态机**必须处理多 choices**，非单 choice 假设 |

## Probe 3：W2 门控——GHC Anthropic 腿是否接受非 `toolu_` 入站 tool_use.id（2026-07-12，Phase 5 前置）

实测时间：2026-07-12｜方式：经运行中的 4141 实例直打 `/v1/messages`（`claude-haiku-4.5`，max_tokens=64，非流式），构造含 `assistant.tool_use` + `user.tool_result`（id 两端匹配）的多轮对话强制 GHC 校验入站 tool_use.id 前缀｜脚本 `/tmp/w2-probe.py`（对照三组）。

**背景**：Phase 2 `cc-to-anthropic-request.ts` 反向请求侧把 CC `tool_call.id` **verbatim 透传**成 Anthropic `tool_use.id`（WARN-E ②）。探针只测过 **outbound**（GHC 返回 `toolu_`/`call_`），**未测 GHC Anthropic 腿是否接受 `call_*` 作入站 request tool id**。反向腿（cc/responses/gemini→messages）接上游前必须实测（`verifying-authoritative-claims`：别继承 Phase 2 注释当已验证事实）。

**关键发现（W2 CLEARED）**：

| 组 | 入站 tool_use.id | 结果 |
|---|---|---|
| CONTROL | `toolu_01ABCDEFGHIJKLMNOPQRSTUV`（Anthropic 原生）| HTTP 200，`stop=end_turn`，正确用 tool_result 内容回答（18°C sunny）|
| TEST | `call_ABC123def456GHI789jkl`（OpenAI 原生）| **HTTP 200**，正确关联 tool_result 回答 |
| TEST2 | `fc_0a1b2c3d4e5f6g7h8i9j`（任意前缀）| **HTTP 200**，正确关联 tool_result 回答 |

**裁决**：GHC 的 Anthropic `/v1/messages` 腿**接受任意前缀的入站 tool_use.id**（不强制 `toolu_`），且正确按 id 关联 `tool_use`↔`tool_result`。→ **反向腿 `call_*`/`fc_*` verbatim 透传设计成立，无需 id 归一/改写**（WARN-E ② 收口：透传是唯一且正确的选择）。

## 未测（留实现阶段）
- **反向流式帧形态**（§8.2 反向状态机的真实输入）：上游 Anthropic `/v1/messages` 的 SSE 帧序列（message_start/content_block_*/message_delta/message_stop/ping/error），已由 `src/lib/anthropic/stream-accumulator.ts:156-334` 完整锚定真实帧集（Phase 5 逐帧 golden 依据）。
- ~~**流式帧形态**（§7.2 状态机的真实输入，F1 最难 phase 依据）：cc 腿 + responses 腿的 SSE delta 序列~~ —— Phase 4 已用 golden 预捕获实测（正向 CC/Responses→Anthropic 流式已 landed）。
