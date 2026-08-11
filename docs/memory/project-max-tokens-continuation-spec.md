---
name: project-max-tokens-continuation-spec
description: max_tokens 续传 + keepalive 缺陷链的进度指针；接手先读仓库内交接文档
metadata: 
  node_type: memory
  type: project
  originSessionId: 815e2277-ca6c-4d88-925c-52a9a7704e9f
  modified: 2026-07-27T21:13:54.587Z
---

**⚠️ 接手先读**：`docs/plan/2026-07-27-handover-max-tokens-and-keepalive.md`（仓库内交接文档，含**严格执行顺序** + 已 landed 清单 + 承重发现 + 用户已裁决项 + 须停下问用户的分叉）。本记忆只做触发指针。

**`max_tokens` 续传 + keepalive 缺陷链**（2026-07-27 状态）：spec/plan/**P0 已 landed master**（`3bb1262a`）；P1 三前置（门 D+A `afc54196`、provenance `3150b219`、M 矩阵+Q5 `69ed3a06`）全部 landed；推进 P1 时挖出**保活缺陷链**并修了根因（`0b9d450d`）。**P1 本身未开工、但不被阻塞**；**块级默认翻转的硬前置 = inter-block 保活方案 A**（plan 已写、审查中，分支 `feat/anchor-allocator-plan`）。

**权威归属（勿在记忆重复详情）：** spec `docs/spec/2026-07-22-max-tokens-continuation.md` + 审查报告（同目录 `-review-*`/`-rereview-*`/`-confirm-*`）；plan `docs/plan/2026-07-22-max-tokens-continuation/`（README/kickoff/plan-G/plan-0..4/plan-M/plan-provenance-prerequisite/plan-Q5-three-way-overlap + `plan-review-gpt-round{1,2,3}`）。

**承重要点（stub）：**
- **实测取证**（4141 History，近 1200 条 5 例 ~0.4%）：全 sonnet-5 流式 completed，`output_tokens` 精确=客户端自设 `max_tokens=32000`（模型 cap 64000）。**三分型**：A=截断在 text（已闭合可续）、B=tool_use input（悬挂非法块 start 无 stop、发散 hazard）、C=thinking-only（0 可见答案、thinking_tokens≈32000、最贵最不可续）。
- **与续写 spec 正交**：续写 spec 处理**错误路径**（NGHTTP2_CANCEL、`committedAny` 门 `driver.ts:1366`）；max_tokens 是**成功路径**（terminal drain `driver.ts:1336`）、需新 post-success 截获分支。A 类**复用**续写 spec §4 ledger+builder+`runContinuation`+`continued` verdict——**该底座已 landed master**（起草期在分支、并发会话合并入 master + 移除 worktree）。
- **用户裁决（2026-07-23）**：**Q1 客户端可见性 = transparent 缝合默认**（能藏就藏[抑制首轮 max_tokens terminator 接续写块]、藏不掉才透传；多策略可配 transparent/passthrough/marker，marker 也抑制终止符只多注标记）；用户不在乎双计费/下游预算。**关键约束：透明只对客户端、后端 history/telemetry 忠实完整**（§9 记 perRoundStopReason 含被藏的 max_tokens + clientVisibleStopReason 并存）→ 对齐 [[feedback-richest-data-flow-store-complete-no-pruning]]。**Q2 C 类 = 多策略可配**（passthrough 默认/retry_with_budget 抬预算；无 continue——thinking 被 ledger 排除、ADR D3）。
- **spec-review 教训（三轮）**：两 reviewer 独立同时命中 `ln` 虚构（根因=起草误用 `rg -r ln` 替换 flag 把 `committedAny` 显示成 ln）；及「续写底座仅在分支/master 尚无」被证伪——**并发会话在起草后 landed 到 master + 移除 worktree、ground truth 在脚下变了**、我复用早期 grep 快照。教训=**并发仓库修订期须 re-verify landed state**（→ [[methodology-verify-running-server-has-fix-before-diagnosing-from-log]] [[methodology-remerge-stale-feature-across-subsystem-rewrite]]）。
- **plan-review 教训（三轮）**：round-1 抓真 blocker——我 spec §11「P0 复用 continuation ledger 判分型」错，`CanonicalBlock` 只 text|tool_use、丢 thinking、只记已闭合块，会把 thinking 截断误判成 text 违反 ADR D3 → 分型须独立 per-format terminal observer、ledger 只保留「可回放前缀」；round-2 reviewer 实测抓 Q5 index bug（anchor 走 `writeAnchor()` 不进 `wireDeliveredBlocks`）；分档诚实（P0 Anthropic-only，实测 5 例全 Anthropic，CC/Responses observer 随 P3）。**教训**：复用已 landed 原语前须核实「它装什么」非只核「它在不在」→ [[methodology-full-primitive-not-partial-else-silent-field-drop]]。

**Related:** [[project-continuation-retry-sequential-anchor]]（姊妹底座）[[project-synthetic-frame-forwarded-track-completeness-spec]]
