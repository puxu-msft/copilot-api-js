---
name: reference-parallel-test-total-count-unstable
description: bun run test:backend 报的测试总数在同树同 commit 连跑之间会变，只有 0 fail 可引用为证据
metadata:
  type: reference
---

`bun run test:backend`（`bun scripts/parallel-test.ts unit it http`）末行的 `N tests · N pass` **总数不稳定**：2026-08-08 在同一 worktree、同一 commit（`e397720a`）连跑两次得 **4032** 与 **3756**；同期另一 agent 在自己的 worktree 报 **6681**。三个数字不构成「范围不同」的矛盾证据——是 16 分片聚合计数本身不可靠。

**Why:** 把它当稳定口径会制造假差异，诱导人去追「是不是少跑了 2600 个测试」这种不存在的问题，或反过来把两处不一致当成对方没跑全的证据。

**How to apply:** 引用全后端档位结果时只写 `0 fail`，**绝不把总数当作可复现的口径数字**写进交付物、评审报告或交接件。看到两处总数对不上时，先在同一棵树连跑两次确认是计数抖动，再谈范围差异。需要可引用的稳定计数就用单进程 focused 档（十文件 focused gate 稳定给出 `197 pass / 687 expect`）。

相关：[[feedback-pass-null-clean-not-self-validating]]（数字必须带口径）、[[reference-bun-test-parallel-breaks-single-process-superlinear-degradation]]（分片与 LPT 均衡的由来）。
