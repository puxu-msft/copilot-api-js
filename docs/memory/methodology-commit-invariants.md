---
name: methodology-commit-invariants
description: "对于大型多 commit 重构，在 RFC 中编码\"每个 commit 都以状态 X 结束\"的不变量，并逐 commit 验证——防止中间态破坏"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

做多 commit 结构性重构时（如本会话 8-commit 的可观测性重写），把 **commit 级不变量** 写进 RFC，并在每个 commit 后验证它们。

**Why:** 那种"commit 1 搭脚手架、commit 4 才让它工作"的大型重构，有发布一个系统处于半破碎中间 commit 的风险。日后 bisect 落到那个 commit 上就毫无用处。有了显式不变量，每个 commit 都发布一个可工作的系统。

**Example from this session（可观测性重写 RFC §4）：**

> 不变量：**从 commit 2 起，每个 commit 都以全部 4 个 sink 都挂接到 bus 上结束；系统在整个切换过程中保持端到端可观测。**

这迫使 commit 2 **把 sink 挂接为空闲观察者**，而非等到 commit 3b。仅 commit 2：sink 收到零事件（bus 为空），legacy 路径仍在 emit；系统两边都可观测。Commit 3b：生产者原子切换；sink 在 consumers.ts 被删除的同一个 commit 成为权威。**commit 2 到 3e 之间没有任何一个 commit 让可观测性处于半破碎状态。**

**How to apply:**
- 在任何 ≥3 commit 的 RFC 里，在切换章节写 1–3 个显式不变量。它们是可测试的陈述，如"测试套件通过""所有 sink 已挂接""新旧路径之间无双写"。
- 每个 commit，验证步骤（typecheck + 测试 + 人工检查）**必须**显式包含这些不变量。若某个 commit 无法满足它们，就重构 commit 顺序。
- 当用户说"逐 commit、每步等我确认"时，严格遵守：每个 commit 在请求签字前都做 subagent-audit；绝不打包多个 commit。
- 外观性回归（如双重 consola hijack 导致的 TTY footer 闪烁——本会话被 subagent 抓到）即使不违反字面也违反精神；提供一个 flag/option，把回归推迟到一个干净的切换点。

**Anti-pattern caught this session:** commit 2 最初的计划是"挂接 sink、hijack consola、完事"。Subagent 抓到 ConsoleSink + legacy ConsoleRenderer 双双 hijack 会互相遮蔽 → 修复是一个 `hijackConsola: false` 选项，用于 commit 2-3a，从 commit 4+ 起默认为 true。

Related: [[feedback_complete_root_cause_fix]]，[[feedback_reviewer_verify_critically]]，[[feedback-architecture-health-is-user-need]]。
