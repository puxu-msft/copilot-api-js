---
name: feedback-self-consistent-needs-independent-oracle
description: 自己两端共享的假设不能当判据；wire/格式正确性要用独立 oracle 裁决
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bb26a9bc-bbda-45b1-94b3-4fffbd4bccdc
---

判断一个 wire 格式 / 协议交互是否正确时，**不能用"我自己构造、我自己解析、两端自洽"作为判据**——如果编码端和解码端共享同一个错误假设，它们会完美自洽却同时是错的。正确性必须用一个**独立的 oracle** 裁决：协议规范语义、参考实现、或真实对端的实际行为。

本项目尤其高发：Anthropic / OpenAI / Gemini 三套兼容层互转。"我转出去的 JSON 我自己能转回来"不证明上游会接受；只有真实上游（GHC）、官方 SDK 解析、或协议文档才是 oracle。

**Why:** 自洽测试只验证了"我的编解码互逆"，对"我对协议的理解是否正确"完全沉默。耦合的双端会把同一个误解放大成"看起来全绿"。

**How to apply:** 校验格式/协议时引入项目外参照：用 [[empirical-probe-via-history-api]] 拉真实请求/响应、对真上游打探针、对照 [[thinking-signature-self-contained]] 这类实测结论或 ghc-api-reference skill 的官方实现。reviewer 给的"修复建议"在照搬前同样要用独立 oracle 自验，别因为它说得自洽就信。呼应 [[feedback_reviewer_verify_critically]]。

**具体失败模式（mock 上游比真上游宽松）：** fetch-mock / mock 上游**接受任何 wire**，故"协议有效性"bug 会过绿测却在生产 400。2026-06 实证：L2 escalation force-inject `context_management` body（mode=off 时）漏配套的 `context-management-2025-06-27` beta header——GHC 要求 body 与 beta 成对，缺则 400。我的 buffered http 测试用 mock 上游、只断言 `wire.context_management` 存在，没校验 beta header，故假绿；是亲自核 reviewer 的 M2 时顺藤摸到的。**教训**：mock 上游的绿测只证"我的接线自洽"，不证"GHC 会接受"。修法二选一——① 测试里显式断言 wire 的协议不变量（必需 header/字段成对关系），把隐性协议要求钉成显式断言；② 用 ghc-api-reference 官方实现作 oracle 核对 body↔header↔beta 的配对规则。是 [[methodology-probe-harness-must-match-prod]] 的姊妹（那条管"harness 缺中间件"，本条管"mock 对端太宽松"）。
