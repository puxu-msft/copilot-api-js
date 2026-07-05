---
name: feedback-self-consistent-needs-independent-oracle
description: 自己 encode↔decode 两端自洽不能当正确性判据(耦合双端共享同一误解会全绿);wire/格式/协议正确性须独立 oracle 裁决——协议规范/参考实现/真实对端(GHC/官方 SDK);mock 上游太宽松会假绿。本项目三套兼容层互转高发。通用裁决手法见 skill verifying-authoritative-claims
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bb26a9bc-bbda-45b1-94b3-4fffbd4bccdc
---

判断 wire 格式/协议交互是否正确，**不能用"我自己构造、我自己解析、两端自洽"作判据**——编解码端共享同一错误假设会完美自洽却同时错。正确性须独立 oracle：协议规范、参考实现、真实对端实际行为。本项目尤其高发：Anthropic/OpenAI/Gemini 三套兼容层互转，"我转出去的 JSON 我自己转得回来"不证明上游会接受；只有真上游（GHC）、官方 SDK 解析、协议文档是 oracle。

**具体失败模式（mock 上游比真上游宽松）：** fetch-mock 接受任何 wire，故"协议有效性"bug 过绿测却在生产 400。2026-06 实证：L2 escalation force-inject `context_management`（mode=off）漏配套 `context-management-2025-06-27` beta header——GHC 要求 body 与 beta 成对，缺则 400；buffered http 测试用 mock 上游、只断言 `wire.context_management` 存在没校验 beta header → 假绿（亲自核 reviewer 的 M2 时顺藤摸到）。**修法二选一**：① 测试显式断言 wire 协议不变量（必需 header/字段成对关系，把隐性要求钉成显式断言）；② 用 ghc-api-reference 官方实现作 oracle 核对 body↔header↔beta 配对。

通用裁决手法见 skill [[verifying-authoritative-claims]]，always-on 默认在 CLAUDE.md `empirical-verification`；用 [[empirical-probe-via-history-api]] 拉真实请求/响应做 oracle，姊妹 [[methodology-probe-harness-must-match-prod]]（harness 缺中间件），呼应 skill `empirical-verification`。
