---
name: feedback-transitional-states-need-explicit-no-harm
description: "在多 commit 重构中,中间状态必须主动无害(ACTIVELY harmless)——而不只是\"很快会被替换\"。用 feature flag / silent 模式来保证与遗留代码没有行为重叠"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

扩展自 [[methodology-commit-invariants]]:"所有 sink 都已挂载"这条不变量是必要但不充分的。一个在 commit N 挂载、而其生产者要到 commit N+2 才切换过来的 sink,会收到零个事件——对读路径而言没问题,但如果遗留代码**也**渲染同一份输出,那么在重叠窗口内**两者都会渲染**。用户会看到重复输出、翻倍的指标、互相冲突的 hijack。

**Why:** 隐式的"无害"假设会静默失效。测试通过是因为每条路径单独工作都正常;只有当两条路径都向同一通道(stdout / WS / DB)发出时,危害才会显现。

**Example from this session (observability rewrite, commits 2-3e):**
- Commit 2 把 `ConsoleSink` 挂到 bus 上。遗留的 `ConsoleRenderer`(经由 `main.ts:initConsolaReporter`)仍然装着。在生产者切换后,两者都会为每个请求渲染 `[ OK ]` 行。
- Commit 3b 原子性地把生产者切换到 bus。突然之间 ConsoleRenderer(经由遗留的 `tuiLogger.finishRequest`)和 ConsoleSink(经由 bus 的 `request.completed`)都画出了 `[ OK ]` 行。
- Subagent 在 commit 3c review 中抓到了它。
- Fix: ConsoleSink 加了 `silent: true` 选项,在 commits 2-3e 期间于 `start.ts` 里硬编码。该 sink 保持订阅(sink-ordering 集成测试依然通过)但不写入 stdout。Commit 4 删除 lib/tui 并把 silent 翻回默认的 false。

**How to apply:**
- 对多 commit 重构中的每个 commit,都要问:"如果遗留代码在这个 commit 窗口期间与新代码并行运行,它们是否都写入同一个输出(stdout、WS、DB)?"
- 如果是,新代码就需要一个**显式的** no-op 模式。不要依赖"现在还没人调用它"——调用可能通过测试、边界情况或未来的 commit 泄漏进来。
- 常见的 no-op 模式:
  - `silent: true` flag(写路径短路)
  - `hijackConsola: false` flag(不安装全局状态变更)
  - 仅订阅(为测试跟踪状态但不发出)
- 在 commit message **和** flag 的 docstring 里都记录该 flag 的生命周期:"在 commits N-N+2 期间设为 true,在 commit N+3 遗留代码被删除时翻回 false。"
- 在每个 commit 边界处做一次手动 UX 检查——typecheck/测试通过,但它们抓不到"stdout 每行都出现了两次"。

**Anti-pattern caught:**
- "反正它会在 commit 4 被删除,何必在意过渡窗口?"——因为其间的每个 commit 都是某个人可能 git-bisect 到的真实机器状态。如果 commits 2-3e 产生了双份输出,把一个真实 bug bisect 到那个区间会让你去追一个幻影。

Related: [[methodology-commit-invariants]]、[[feedback-rfc-then-implement-for-large-refactors]]、[[feedback-mine-the-pass-with-warn]]。
