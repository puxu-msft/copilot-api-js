---
name: feedback-give-user-decision-data-not-pitch
description: "当用户必须做范围/架构权衡时，给出 3-4 个带量化影响的 OPTIONS（LOC、文件、对架构意图的偏离）——而不是单一推荐路径配一句「你觉得呢？」。让他们基于数据来选。"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

用户明确纠正（2026-06-14）：「等等，你再问用户一次，给出详细的参考，给用户决策支持」——「wait, ask the user again, give detailed reference, give the user decision support」。

我给了一个 2 选项的 AskUserQuestion（「post-finalize」对「create-and-take-over」中间件模式），却没有摆出每个选项的架构成本。用户回怼：别给我 yes/no，给我用来选择的数据。

**Why:** 架构范围决策是用户的领地（按原则4 / [[feedback_no_unilateral_action]]）。但只有当你做好功课，用户才能做出真正的选择：读过相关代码、找出约束（例如已有注释「routing validation BEFORE ctx creation prevents dangling history entries」）、量化每个选项的 LOC + 文件数 + 对现有架构的违反。「A 还是 B？」不是一个决策——「A 是 100 LOC 且遵循现有约束，B 是 400 LOC 且违反 messages/handler.ts:163，C 推迟到 commit 4」才是一个决策。

**Pattern that worked（commit 3e 中间件范围）：**
1. grep 出触及该区域的每个调用者、约束、注释
2. 仔细读每条约束——浮现出现有的架构意图
3. 找出 3-4 个具体选项
4. 对每个选项，填入：
   - **Scope**：哪些文件改动，大致 LOC
   - **Constraint compatibility**：遵循 / 违反现有意图
   - **Subagent risk**：已知回归或未解答的问题
5. 推荐其中一个，但把推荐与其他选项的数据并列展示
6. AskUserQuestion，把全部 4 个作为选项

**Example of the difference:**

❌ 差：「中间件我该用 post-finalize 还是 create-mode？」

✓ 好（取自实际 session）：
- 「**Post-finalize**：handler 仍然调用 manager.create + c.set('requestContext', ctx)。中间件在 next 之后读 c.get，调用 failIfNotFinalized/completeFromHttpStatus。**保留 messages/handler.ts:163 意图**（routing validation BEFORE ctx creation，避免悬空 history entry）。范围：~6 个 route + 新中间件。估计 100-150 LOC。」
- 「**Create-mode**：中间件根据 path 推断 endpoint 来创建 ctx。handler 不再调用 manager.create。**违反 messages/handler.ts:163 意图**——任何 routing/payload 校验错误都会留下悬空 history entry。范围：~6 个 route 重构 + path-to-endpoint map。~300-400 LOC。」
- 「**Defer**：只加 SYNTHETIC_PATHS skip，把 failIfNotFinalized 推到 commit 4。~30 LOC，但 RFC 承诺过 break-quiet。」

**How to apply:**
- 每当用户对一个 yes/no 回怼，就把它当作你没摆出足够数据的信号
- 在为任何范围决策做 AskUserQuestion 之前，花 5-15 分钟 grep 来填入真实数字
- 始终包含约束引用——如果它们以注释形式存在就给 file:line
- 推荐其中一个，但按架构契合度排序选项，而非仅按改动小排序

Related: [[feedback_no_unilateral_action]]（范围/决策是用户的）, [[feedback-architecture-health-is-user-need]]（别偏向「小」——偏向「契合意图」）, [[methodology-commit-invariants]], [[feedback-dont-stop-when-direction-clear]]（架构上等价的选项 → 别停下来问；只有非等价的才走这条记忆）。
