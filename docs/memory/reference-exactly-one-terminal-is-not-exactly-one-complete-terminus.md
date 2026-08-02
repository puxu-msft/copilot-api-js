---
name: reference-exactly-one-terminal-is-not-exactly-one-complete-terminus
description: 「只发一个终态」不等于「发了一个完整终止符」——合成 end_turn 不补 message_stop，真 SDK 直接抛
metadata:
  type: reference
---

改写流式响应、自己合成终态时，「保证只产出**一个**终态」这个不变量**不够**——必须是「一个**完整**的终止符」。

2026-07-28 refusal 抑制：改写层在 refusal 处合成 `content_block_*` + `message_delta{stop_reason:end_turn}`，然后**指望上游随后的 `message_stop`** 收尾。但 contentless refusal **不保证**后面跟 `message_stop`。缺了它，真实 `@anthropic-ai/sdk` 会挂到流结束然后抛：

```
AnthropicError: stream ended without producing a Message with role=assistant
```

——正是抑制本身要防的那种「轮次被打断」。修法：**无条件发自己的 `message_stop`**（打 synthetic 标记），上游那个到了就当重复丢弃。

配套的第二个坑（同一批）：driver 的提交门只认 `message_stop` / 上游 error 帧为终态，缺终止符的 refusal 会被判成**截断**→ 去重试或续写一个**客户端已经拿到完整终止符**的轮次。所以自造终态时还要把该形态注册进 driver 的终态判据（`sawContentlessRefusal`）。

**Why:** 「终态」是我方视角的状态机概念；「终止符」是客户端 SDK 解析器的协议契约。两者不是一回事——状态机可以认为自己结束了，而 SDK 还在等它的收尾帧。

**How to apply:** 任何合成/改写终态的地方，验收 oracle 必须是**真实客户端 SDK**（`tests/e2e-client/anthropic-sdk.it.test.ts` 那种 `.finalMessage()`），而不是只断言自己发出的帧序。且构造「上游**没有**发终止符」的 fixture 单独测一条。mutation control 会直接复现上面那条错误串。权威：[docs/refusal-recovery.md](../refusal-recovery.md)「exactly-one-COMPLETE-terminus」节；相关：[[reference-anthropic-sdk-drops-eventless-sse-frames]]（合成帧必带 `event:` 行）、[[reference-exactly-one-message-start-both-forward-legs]]。
