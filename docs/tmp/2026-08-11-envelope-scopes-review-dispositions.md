# RequestEnvelope 三作用域重构 —— 评审处置表

评审对象：`69bea997`（114 文件重构）及其后续修复。三名评审各占一个角度，互不覆盖：契约（`…-review-contracts.md`）、守卫（`…-review-guards.md`）、机械扫掠（`…-review-sweep.md`）。

**级别口径**见 skill `adopting-agent-findings` 的 A/B/C/D 表——本轮全部落在 **C（落进产物但可逆：代码与测试）**：没有一条改变用户已裁决的取舍、ADR、冻结 spec 或对外契约（非 A），也没有一条是给模型读的指令文本（非 B）。

## 处置

| # | 来源 | 级别 | 发现 | 处置 | 证据 |
|---|---|---|---|---|---|
| 1 | 契约 | C · major | `driver.ts` 的 `forkEnv` 丢弃 `candidateStateFactory.fork()` 返回的 `fork.body`，把 `env.attempt.body` 的**同一引用**交给每个 `forkEnvelope`——primary 与 hedge 共享一个 body 对象 | **采纳**。`forkEnv` 改用 `structuredClone(env.attempt.body)`；补真实 hedge 路径测试 | `5272af0e`。`tests/pipeline/hedged-driver.it.test.ts` 在 `transport.open` 记录 `openedEnvs`，断言两候选 `attempt.body` 身份不同、一侧写入对方不可见、而 `request` **是**同一个对象 |
| 2 | 守卫 | C · blocker | `config-snapshot.unit.test.ts` 那条「codec 不得自建 builder」的**源码文本**守卫只守住一种拼写：本地 `buildEnvelope` 丢掉 `request.translationConfigSnapshot`，类型正确、守卫全绿 | **采纳，且不按建议的「扩大字符串黑名单」修**。守卫追不上合法写法时搬家：改成行为 oracle，真跑四个 codec 的 `parse`，断言 snapshot **身份**不变 + 热重载隔离 | `182ae415`。变异对照：删掉 openai-cc 那处条件展开 → 恰好该 codec 的 2 条红、其余 6 条绿；反向 patch 恢复后 8 pass / 0 fail |
| 3 | 守卫 | C · major | `candidate-state.unit.test.ts` 唯一的源变异发生在**首次 fork 之前**，只证明了 factory 建立时取快照，没有守「产出物与源之间无残留别名」 | **采纳**。补 post-fork 用例：先 fork 出 primary，再改源 body 的嵌套成员（改字段 + push），断言已产出候选不变；再 fork 一个 `late` 断言与 primary 互不相干 | `05809c80` |
| 4 | 扫掠 | C · major | `driver.unit.test.ts` 的 `migratedEnv` 在迁移中丢了 `legSupplyReady`，此后走 legacy 分支，标题声称的「驱动真实 `chatCompletionsLeg`」不成立 | **采纳并扩大**：除补回该字段外，另修掉它**迁移前就存在**的假绿——`resolveExchangeStrategies` 唯一调用点在错误处理内，而该用例是 happy path，`strategyFactoryCalls === 0` 两分支恒真。改成抛错逼到求值点 | `25a24f68`。变异对照：去掉 `legSupplyReady` 后恰好这一条红、失败落在目标断言行；反向 patch 恢复后 55 pass / 0 fail |
| 5 | 守卫 | — | 独立复核 `owns-sink-two-racer` 的假体补 `attempt: {}`：确认 `response-processor.ts:236` 的访问异常被 `:284-285` 包装成 codec-render、非上游流错误，故补齐假体是**正确修复而非掩盖真实的错误分类缺陷** | **确认，无需动作**。此前我自己的归因得到未卷入方独立佐证 | 见守卫报告「已运行的独立证据」节 |

| 5 | 扫掠 R2 | C · major | `docs/DESIGN.md:92` 活架构表仍描述被删掉的机制：`env.requestState` 存在性判别器、「稳定态住 `env.requestState`」、把已删的 `request-state.ts` 列为归属文件。`git show --name-only 69bea997 \| rg '^docs/'` 为空——114 文件的重构**一份文档都没同步** | **采纳**。三处按当前形状改写，并写明判别器为什么换；模块表那行「隔离 requestState」语义写反了（实际隔离 candidate，request 刻意共享）一并修 | `06bc3535`。cell-assembly 的 memory stub 加时效注记，正文保留为当轮教训记录 |
| 6 | 扫掠 R2 | C · minor | src/ 内 31 处注释仍指向已删的 `env.requestState`；其中 `openai-cc-cell.ts:70` 不是注释而是**运行时错误消息**——读的是 `env.candidate.responsesFallbackScratch`，抛的却说 `env.requestState.…`，排障时把人引向不存在的字段 | **采纳**。逐处按值的真实归属改（不是机械替换成同一个词）。`envelope.ts:124` 保留——它就在解释旧判别式是什么、为什么换，是刻意的历史引用 | `30a6d406`（16 文件，全为 docstring + 那条错误消息字符串，无行为变更）；tests/ 内 12 处同批处理，见 `fdf8e06d` |
| 7 | 扫掠 R2 | C · minor | `tests/pipeline/cell-assembly.unit.test.ts:163,217` 两个假体缺 `candidate` 作用域（同文件其余四个都有）。当前走的分支只读 `request.truncateBaseline` 所以绿，但生产侧多处**非可选**读法，任一 cell 日后取用即 TypeError 而非断言失败 | **采纳**。补 `candidate: {}` 与真实 envelope 同形 | `fdf8e06d` |
| 8 | 扫掠 R2 | C · minor | `tests/architecture/circular-deps-baseline.json` 未重冻结：仍把已删的 `request-state.ts` 列为环成员并保留穿过它的环路径。ratchet 只查新增，所以不红，但这两条把该模块与该环路径**永久加进了白名单** | **采纳**。跑 `scripts/update-circular-deps-baseline.ts` 重冻结，**37 环 → 12 环 / 22 文件** | `935ec9ba`。diff 逐行核对：count 之外零新增行——没有把 peer 新引入的环顺手洗白。（该 commit 正文有处笔误漏了箭头，正确值以本行为准；共享树不 amend） |

## 无发现的角度（与「没扫」区分）

扫掠评审第 1 轮 **blocker: 0**，四类目标缺陷均有机械判据且全部跑完无命中：作用域错位（AST 扫全部 114 文件的三作用域对象字面量 + `Object.assign` + 逐点赋值，逐键比对三个 interface 成员集）、条件展开被吞（diff `-` 侧逐条对账 `+` 侧）、顺序语义反转（9 处 spread-after-key 逐处确认键不相交；旧版 28 处 spread-then-override 逐处追踪去向）、简写属性被吞（AST 逐文件比对字面量键计数）。

它自报的**未覆盖形态**（是「没扫」，不是「无发现」）：①类型正确但值取错来源（AST 只查键不查值来源）②假体本就该有却从未有的字段 ③非 envelope 形状对象内部的键丢失 ④断言语义强度变弱（只数了 `expect(` 计数）⑤逐 cell 的运行时字节对照 ⑥`ui/`、`ui-v4/` 与 DESIGN.md 之外的文档。

## 一条本轮实测坐实的环境归因（不是回归）

`test:backend` 首轮 21 条红全部落在 History 子系统（`history/{search,worker,v3}`、`diagnostics/durable-writer`）。**没有当作「既有失败」挥手放过**：单跑同样红（排除并行污染）→ 读实际错误是 `options.index.generation is not a function`（`src/lib/history/search/daemon.ts:561`）→ Rust 侧该方法存在、TS 侧 2026-08-08 引入、Rust 源最后改动 2026-08-09，而磁盘上的 `.node` 构建于 **8 月 6 日 20:08**——预构建 native 产物比源码旧。`bun run build:history-search` 重建后该文件 22 pass / 0 fail。归因是实测转绿，不是结构推断。


## 未采纳

无。三份报告的每一条事实性发现都成立并已落地。唯一偏离评审建议之处：守卫 blocker 的建议是「用可解析的 import/call-site oracle，或以行为 oracle」二选一，我选了后者并**明确拒绝了扩大字符串黑名单**——理由写在 `config-snapshot.unit.test.ts` 末尾与新文件的头注里。

## 待办

无。扫掠评审两轮已收口（R1 blocker 0、R2 无剩余 major/minor 待处理）。
