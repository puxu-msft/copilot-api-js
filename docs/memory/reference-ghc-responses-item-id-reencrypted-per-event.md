---
name: reference-ghc-responses-item-id-reencrypted-per-event
description: GHC Responses 流的 item.id 每事件重加密、跨事件关联只能用 output_index/call_id；曾致 tool_call 恒 2× 翻倍
metadata: 
  node_type: memory
  type: reference
  originSessionId: a8a11501-9b0b-48ec-8e76-6169bab3cf27
---

GHC 的 Responses 流对同一逻辑 output item 的不透明 `item.id` **每个事件都重新加密**——`output_item.added` / `function_call_arguments.done`（`item_id` 字段）/ `output_item.done` 各带一个**不同**的 id；只有 `output_index`（整数）和 `call_id` 跨事件稳定。**任何跨事件关联/去重必须用 `output_index` 或 `call_id`，绝不用 `item.id`**。

**踩坑实例**：`responses-stream-accumulator.ts` 的双终结守卫（function_call 会被 `arguments.done` 和 `output_item.done` 两个事件各终结一次，本应二选一）用 `find(tc => tc.id === event.item.id)` 判重——item.id 每事件变 → 永不命中 → 每个 tool_call 被 push 两次，恒 **2×**。History 实测 22/22 gpt-5.6-sol 工具响应全中招；还经 `conversation-rebuild.ts` 读 `upstreamResponse.body.tool_calls` 传播进重建对话。修复=引入 `finalizedOutputIndexes: Set<number>` 作三处判重的统一稳定键（commit `16a10615`）。

**方法论延伸**：原有回归测试用**相同** `fc_5` id 喂 added + done（合成 fixture 不反映 GHC per-event 重加密现实），所以绿着而生产翻倍——典型「测试与实现同源盲区」，fixture 须用 per-event 不同 id 才能坐死不变量。参见 [[methodology-reasoned-safe-not-tested-producer-wire-oracle]]、[[feedback-pass-null-clean-not-self-validating]]。

权威归属：skill `ghc-api-reference`（「GHC Responses 流 wire 陷阱」节）。相邻症状排查 skill `ghc-anthropic-upstream`。
