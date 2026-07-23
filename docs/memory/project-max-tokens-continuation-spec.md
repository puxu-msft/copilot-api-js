---
name: project-max-tokens-continuation-spec
description: max_tokens 续传 spec（A/B/C 截断分型 + 客户端可见性契约）草案进度指针，两轮异模型审已消化，Q1/Q2 待用户裁决
metadata: 
  node_type: memory
  type: project
  originSessionId: 815e2277-ca6c-4d88-925c-52a9a7704e9f
  modified: 2026-07-22T23:37:28.016Z
---

**`max_tokens` 续传 spec**（`stop_reason=max_tokens` 的 proxy 侧续传）——**草案 landed master `9de1e221`**，两轮异模型对抗审已消化，进 plan 前 Q1/Q2 待用户裁决。

**权威归属（勿在记忆重复详情）：** spec `docs/spec/2026-07-22-max-tokens-continuation.md` + 审查报告 `-review-gpt.md`/`-review-claude-a.md`（同目录）。

**承重要点（stub）：**
- **实测取证**（4141 History，近 1200 条 5 例 ~0.4%）：全 sonnet-5 流式 completed，`output_tokens` 精确=客户端自设 `max_tokens=32000`（模型 cap 64000）。**三分型**：A=截断在 text（已闭合可续）、B=tool_use input（悬挂非法块 start 无 stop、发散 hazard）、C=thinking-only（0 可见答案、thinking_tokens≈32000、最贵最不可续）。
- **与续写 spec 正交**：续写 spec 处理**错误路径**（NGHTTP2_CANCEL、`committedAny` 门 `driver.ts:1283`）；max_tokens 是**成功路径**、需新 post-success driver 分支。A 类**复用**续写 spec §4 ledger+builder+合成轮（`feat/continuation-retry` 分支基建、master 尚无）→ 硬依赖。
- **承重用户裁决门**：**Q1 客户端可见性契约**（续写缝合藏掉 max_tokens 信号→双计费同意；P1 透明/P2 marker/P3 sidecar，倾向 P2 但 marker 会污染下游 agent context）；**Q2 C 类策略**（纯透传/opt-in retry-with-budget/拒绝介入）。默认全关 `enabled:false` 零变更透传。
- **审查收敛教训**：两 reviewer 独立同时命中 `ln` 虚构（根因=起草误用 `rg -r ln` 替换 flag 把 `committedAny` 显示成 ln）+ settle-freeze 张力；GPT 引用的 HANDOFF.md 在 master 不存在（仅分支 worktree），亲自核 `exp/continuation-shape/FINDINGS.md` 确认 G3 PASS 才更正 §3.2 → [[feedback-pass-null-clean-not-self-validating]]。

**Related:** [[project-continuation-retry-sequential-anchor]]（姊妹底座）[[project-synthetic-frame-forwarded-track-completeness-spec]]
