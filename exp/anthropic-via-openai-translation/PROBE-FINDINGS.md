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

## 未测（留实现阶段）
- **流式帧形态**（§7.2 状态机的真实输入，F1 最难 phase 依据）：cc 腿 + responses 腿的 SSE delta 序列、reasoning 是否在流式帧回传、tool_call 流式 index 形态。省配额，留 Phase 3/4 用 golden 预捕获时实测。
