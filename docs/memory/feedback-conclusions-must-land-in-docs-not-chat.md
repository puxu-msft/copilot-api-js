---
name: feedback-conclusions-must-land-in-docs-not-chat
description: 我和 subagent 的结论一律先落成文件（草案/评审报告放 docs/tmp/），绝不只活在对话或 agent 返回值里
metadata:
  node_type: memory
  type: feedback
---

**任何结论都必须落成文档，不能只存在于对话消息或 subagent 返回值中。** 覆盖面：**提议、spec、plan、review 报告、investigation 结论、交接文档草稿等——一旦内容规模足够就值得落盘**（用户 2026-08-02 补充）。未定稿的草案、评审报告、调研结论等临时产物放 `docs/tmp/`；定稿后再按项目 doc 路由迁到 `docs/spec/` / `docs/plan/` / `docs/decisions/`。用户原话：「这很危险，以后每次你/agent都要把结论落成文档，可以放到某个 docs/tmp/ 这样的临时文档区域」。

**Why:** 只活在对话里的结论会随上下文压缩、会话结束、后台 agent 结果 surfacing 失败而**不可恢复地丢失**——[[methodology-background-agent-result-surfacing-failure]] 就是 agent 正文空且救不回的实例。落成文件后结论可被引用、可被下一轮评审对照、可跨会话接手。同时 `docs/tmp/` 与正式区分离，避免未定稿草案混进 `docs/spec/` 被当成权威。

**How to apply:**
- 派 subagent 时在 prompt 里**明确要求把报告写到 `docs/tmp/<topic>-review-<role>.md`**，返回值只作摘要；不要只让它在返回值里讲结论。
- 我自己在对话里给出的设计/裁决/调研结论，同步写文件，别只贴在回复里。
- 草案与评审报告默认进 `docs/tmp/`；定稿才进正式区（→ CLAUDE.md「文档路由」与 `docs-merge-before-execute`）。

**Related:** [[feedback-subagent-review-before-any-user-facing-proposal]] [[methodology-background-agent-result-surfacing-failure]] [[session-closeout-and-handover]]
