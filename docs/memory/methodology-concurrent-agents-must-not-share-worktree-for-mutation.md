---
name: methodology-concurrent-agents-must-not-share-worktree-for-mutation
description: 并发 subagent 共享 worktree 做 mutation probe 会伪造出「成员固定、可复现」的失败簇，被误判成真缺陷
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 815e2277-ca6c-4d88-925c-52a9a7704e9f
  modified: 2026-07-28T11:14:08.707Z
---

**派并发 subagent 时，「就地 mutation + 改回」与「跑权威全量测试档」绝不能落在同一个 worktree**。每个要做 mutation probe 的 agent 必须自建独立 scratch worktree（`git worktree add` 到 `.worktrees/<用途>` 或 `/tmp`），用完 `git worktree remove`。

**Why:** 这是主会话的调度责任，不是 agent 的错——2026-07-28 我把 reviewer 与 verifier 同时派进 `.worktrees/alloc-p1p2`，verifier 的 prompt 写「就地改 src、跑完还原」，reviewer 的 prompt 写「在这里跑 `parallel-test.ts unit it http`」。结果 reviewer 7 轮里 2 轮出现 **17 条成员固定的失败簇**，它据此判定「套件在本分支上不确定、这些是方案唯一的 wire 正确性 oracle，不确定就等于后续每次绿都失去裁决力」并定级 major。实为 verifier 那 67 秒 mutation 窗口的产物。

**为什么特别容易骗过人**：污染态的失败**成员固定、可复现两轮**，看起来完全不像随机 flaky；而且症状里混着一条**语义**不符（marker 从 `synthetic-message-start` 变 `anchor`），「排空不足」解释不通，反而更像真缺陷。源文件恢复也救不回已启动进程——它已导入 mutation 版模块，所以还原后的**下一轮仍然红**，时间线看着更像「持续存在的缺陷」。

**How to apply:**
- 派活时在 prompt 里写死：要做 mutation 就 `git worktree add` 自建隔离树，**不要**在共享分支树里改生产源码。
- 同一 worktree 同期只允许一个写者。要并行审查，就给每个 agent 各自的树，或让只读审查者与 mutation 者**串行**。
- 遇到「成员固定的失败簇」先查**并发写者**再查代码：`stat` 相关源文件 mtime、翻同期 agent 的 JSONL（`~/.claude/projects/<path>/<session>/subagents/agent-<id>.jsonl`）对时间戳，比读代码快得多。
- 裁决方法：独立 worktree 干净源码连跑 N 轮（本次 40 轮 0 次）+ **逐字施加疑似 mutation 复现出同一成员集**——两头夹逼才算定案，单靠「我这儿跑不出来」不足以推翻对方。

**Related:** [[methodology-full-suite-red-classify-before-pollution-playbook]]（全套件红先分类）[[feedback-pass-null-clean-not-self-validating]]（结论不自证）[[reference-bun-test-parallel-breaks-single-process-superlinear-degradation]]（分片/并行档位）
