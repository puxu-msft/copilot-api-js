---
name: feedback-rfc-then-implement-for-large-refactors
description: "对于数千行级的重构，先写 RFC 并熬过 ≥3 轮 subagent 对抗式 review 再动手实现——不要从一句「我们说好了」就开始写代码"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

用户偏好（2026-06-13）：在提供「一次性大重写 / 先出设计 RFC 再动手 / 仅做最高价值 70%」时，他们为一个估计 ~2500 行的可观测性重写选了 RFC-first。

**Why:** 从一句口头「我们说好了」就开始的大重构，常常事后发现存在：
- 设计没考虑到的遗漏事件源（本 session：subagent v1 review 抓出 4 个被漏掉的 broadcast 命名空间——history.stats_changed、history.cleared、system.shutdown_phase_changed、system.rate_limit_state——若实现时没有它们会导致前端回归）
- 倒置的假设（本 session：原本要删掉中间件 finalization；subagent 抓到那会把错误可见性延迟从毫秒级膨胀到 200 秒）
- 跨章节相互冲突的决策（本 session：count-tokens-via-fake-completed（决策 A）会让隔离目标（决策 B）失效）

每一次抓住都省下真实的实现返工。通过 3 轮 subagent 对抗式 review 达到「稳定 RFC」大概花 30-60 分钟，却能避免在实际代码上大得多的返工。

**How to apply（流程）：**
1. **先 brainstorm/审计**：拿到一份具体的债务清单（file:line 证据）——别从「感觉坏了」开始设计
2. **写 RFC** 到 `docs/rfc/<topic>.md`：问题陈述、架构、依赖方向、type union、sinks/模块、cutover 计划（commit，NOT phase）、范围外、给用户的开放问题、验证
3. **subagent 对抗式 review**，用明确的 prompt：「找遗漏的事件源、跨章节矛盾、虚假的自我主张、潜伏的 bug」。不要用泛泛的「review this RFC」prompt。
4. **查验 subagent 的发现**，按 [[feedback_reviewer_verify_critically]]
5. **重复**直到 subagent 报告零 FAIL/WARN（通常 2-4 轮）
6. **请用户**在写代码前解答 §6 里的开放问题
7. **实现**，带 commit invariants，按 [[methodology-commit-invariants]]

**哪怕一轮都别跳过。** 本 session：v1 RFC 有 4 个 FAIL + 8 个 WARN，v2 有 3 个 red + 4 个 yellow，v3 有 3 个文本自洽性问题。每一轮都实打实地改进了设计——没有一轮是多余的。

交付物组织（当 RFC 要分派给一组独立实现者并行做时，文档拆 design/plan/prompts 三层 + per-phase self-contained kick-off）见 [[methodology-rfc-multi-phase-doc-structure]]——本条记流程，那条记产物结构。

Related: [[feedback-architecture-health-is-user-need]], [[methodology-commit-invariants]], [[feedback_reviewer_verify_critically]], [[methodology-rfc-multi-phase-doc-structure]]。
