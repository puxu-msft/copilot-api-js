---
name: reference-anthropic-sdk-drops-eventless-sse-frames
description: REFERENCE：Anthropic SDK 流解码按 SSE event 名分发，event-less data 帧解码成 event=null 被静默丢弃；合成 Anthropic SSE 帧必须带 event: 行
metadata:
  type: reference
---

REFERENCE（实证，非推断）：`@anthropic-ai/sdk`（Claude Code 所封装）的流解码器 `SSEDecoder` 把 `this.event` 初始化为 `null`、仅从 `event:` 字段行赋值；event-less 的纯 `data:` 帧解码成 `sse.event === null`，**连 SSE 规范的 `"message"` 默认都不应用**。消费循环按 `sse.event` 名分发（`content_block_start`/`message_delta`/… 在 accept-set 才 yield），`null` 匹配不上 → **该帧被静默丢弃**（不报错、不解析 data）。一旦 yield，SDK 再按 parsed `data.type` 累积——故 `event` **不必等于** `type`（只需 ∈ accept-set；thinking-signature-compat 在 `event: content_block_start` 下发 signature_delta 是良性的）。

**结论：任何代理合成的 Anthropic SSE 帧都必须带 `event:` 行（= 帧 JSON 的 `type`）**，否则 SDK 客户端整帧丢失。真实 Anthropic 上游永远发 event 行。本项目曾踩：recover-tool-call 合成 tool_use 帧无 event 行（一直有缺陷、被 SDK 丢）、recover-refusal 合成 text 帧险些同样。落地：`src/lib/anthropic/sse-frame.ts` 的 `anthropicSseFrame(payload)`（`event:=payload.type`）为单一 synth 入口；golden 的 `assertEventLineInvariant` 守卫扫所有 forwarded 帧断言带 accept-set 内的 event 行。

**陷阱（最关键）**：自洽 golden（自己 encode↔decode、`dat()` 锁 event-less 帧）锁的恰恰可能是这个有缺陷的输出，**抓不到**——必须用独立 SDK oracle 裁决（喂合成帧进真 SDK 解码器 `_iterSSEMessages` 看哪些幸存，`exp/refusal-sse-event-verify/`）。呼应 [[feedback-self-consistent-needs-independent-oracle]]、[[reference-claude-code-timeout-and-sse-error-oracle]]、[[methodology-stream-eof-not-completeness]]。
