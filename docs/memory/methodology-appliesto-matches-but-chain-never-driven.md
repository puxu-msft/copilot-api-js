---
name: methodology-appliesto-matches-but-chain-never-driven
description: 改写/钩子的 appliesTo 命中 ≠ 那条链真的被驱动——先找驱动点的生产调用点再下结论
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f78d8768-7d1e-4aa7-96b2-06ebd19dbb63
  modified: 2026-07-28T22:24:09.472Z
---

看到某个 rewrite / hook 的 `appliesTo`（或等价的适用性谓词）在当前路径上命中，**不能推出它真的跑了**。谓词只说「该不该跑」，驱动点才决定「跑没跑」。

2026-07-28 refusal 抑制：我在交接件里写「reverse `@messages` 六格都没有 wire 抑制」，理由是「reverse codec 先把 Anthropic body 翻成目标协议」。补 oracle 实测后**翻转**——流式三格早就在抑制了（帧在翻译器看到之前就被 per-frame 链改写），缺口只有非流式三格。而非流式的真根因也不是我写的「三套协议呈现逻辑没写」，是**少调了一次**：`transformWhole` 的唯一驱动点是 `driver.runResponseWhole`，它在生产代码里只有一个调用点（直连 Anthropic handler），三条 reverse 非流式路径只调纯 render 的 `runResponseNonStreaming`。因此该链上**四个**钩子（refusal / recover-tool-call / tool-input-decode / server-tool-filter）在那些腿上全部落空，refusal 只是碰巧被观测到的那一个。

**Why:** 「谓词命中」和「链被驱动」是两件事，中间隔着一个可以缺失的调用。只看谓词会同时犯两个错：把已经工作的功能报成缺失（流式），和把缺失的规模说小（只看见 refusal，看不见另外三个钩子）。

**How to apply:** 下「这条路径上 X 没生效」之前，`rg` 出驱动点函数名，数它的**生产**调用点（排除 debug/dry-run/测试），确认当前路径在不在其中；然后补一个直接看**客户端实收字节**的 oracle 再定论。同一条链上有多个钩子时，缺失驱动点意味着**全体**落空——按链而不是按单个钩子估算波及面。相关：[[feedback-pass-null-clean-not-self-validating]]（否定性结论不自证）、[[methodology-diagnostic-log-is-authoritative-voice-verify-against-ground-truth]]。
