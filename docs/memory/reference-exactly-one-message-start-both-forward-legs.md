---
name: reference-exactly-one-message-start-both-forward-legs
description: keepalive 注入器的 exactly-one-message_start 不变量须覆盖两条转发腿（buffered 捕获 + live 早转发），否则早 message_start + 静默触发双 message_start
metadata: 
  node_type: memory
  type: reference
  originSessionId: a8a11501-9b0b-48ec-8e76-6169bab3cf27
---

Anthropic keepalive-anchor 注入器的 **exactly-one-message_start** 不变量必须覆盖**两条**转发 message_start 的路径，缺一就双发：

1. **buffered 捕获腿**——driver 缓冲期把首个 message_start 存进 `capturedMessageStart`，idle tick 时注入器转发它并置 `messageStartForwarded=true`。
2. **live 早转发腿**——上游 message_start 在首个 idle tick **之前**就经 live pump 转发（`injected=false` → `reconcileLiveFrame` passthrough）。

**踩坑**：spec §10.1.5 C1 的事故是**纯 pre-response 静默**（连 message_start 都没有），注入器只在「无 message_start 可捕获」时合成。翻译型 **/responses** 上游破坏该心智模型：`response.created` 在 t≈0 翻成真实 message_start 早转发，随后**整段 reasoning 静默**（reasoning 帧非客户端 content）→ idle tick 触发时注入器只看 `state.injected`（仍 false）+ `capturedMessageStart`（undefined，仅 buffered 写）→ **合成第二个 message_start**。客户端收到两个 message_start（History `req_1784035548020_524`/`_564`/`_719`，全长 reasoning gpt-5.6-sol；History 详情页 Upstream+Forwarded 两 leg 各渲一个放大观感）。

**修**：`reconcileLiveFrame` not-injected passthrough 时对真实 message_start 置 `messageStartForwarded=true`（wire 逐字节不变，仅翻 flag）；两注入器（`empty_text` + `enveloped_ping`）**先查 `messageStartForwarded`**、已转发则不再发 message_start（`empty_text` 只开锚点 block+空 delta）。commit `0d55d229`，权威 spec §10.10。

**方法论**：client-facing wire 缺陷用 **producer-oracle** 断完整帧序（真 driver + reconciling sink，早 message_start + 静默 + resume → wire 恰一个 message_start），并做正样本对照（fix stash 后测试转红证其抓得住）。参见 [[methodology-reasoned-safe-not-tested-producer-wire-oracle]]。与 [[reference-ghc-responses-item-id-reencrypted-per-event]] 同批 gpt-5.6-sol 长 reasoning turn 暴露。
