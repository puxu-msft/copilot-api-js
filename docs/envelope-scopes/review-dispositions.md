# RequestEnvelope 三作用域重构 —— 评审处置表

评审对象：`69bea997`（114 文件重构）及其后续修复。三名评审各占一个角度，互不覆盖：契约（[archive-2026-08-11/round1-review-contracts.md](archive-2026-08-11/round1-review-contracts.md)）、守卫（[round1-review-guards.md](archive-2026-08-11/round1-review-guards.md)）、机械扫掠（[round1-review-sweep.md](archive-2026-08-11/round1-review-sweep.md)）。

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

## 第二轮（合并前对抗评审，三名 GPT 底座，角度互不重叠）

三份报告：[round2-review-doc-code.md](archive-2026-08-11/round2-review-doc-code.md)、[round2-review-guards.md](archive-2026-08-11/round2-review-guards.md)、[round2-review-instruction-text.md](archive-2026-08-11/round2-review-instruction-text.md)。**0 blocker / 6 major，全部采纳**。

| # | 来源 | 级别 | 发现 | 处置 | 证据 |
|---|---|---|---|---|---|
| R2-1 | doc↔code | C · major | `DESIGN.md` hooks 行写着「driver 交防御性 body 克隆，`undefined`=保留原 parsed env，`driver.ts:320`」——三部分全错 | **采纳**。改为 live env + 两种写法都到得了 wire，行号换成符号锚点 | `3f6fd34c`。**同一形态本会话第四次复发**：我对 DESIGN.md 的 grep 又只用了 `requestState` 一个词 |
| R2-2 | doc↔code | C · major | 仓库里**可加载的** `hooks/strip-todowrite.ts` 向作者承诺「Both are immutable (return a new env)」 | **采纳**。示例代码本身仍工作（链式传递恰好正确），但承诺与实际相反，已改 | `3f6fd34c` |
| R2-3 | doc↔code | C · major | `docs/v4/03-spec/envelope-driver.md` 定义的仍是扁平 envelope + `with()` + 不可变约定，而 DESIGN.md **链接它两次** | **采纳**。加取代横幅，指明只有 §1 失效、其余未受影响。同批补完上一轮只做一半的 `spec/2026-07-12` 取代（§3.5 标题、生产示例、差异表、验收项） | `3f6fd34c`。其中那条验收项**仍会通过但已失去判别力**，正是该节第 4 条当初警告的「盲 oracle」，故标注失效并指向现行测试而非删除 |
| R2-4 | 判据判别力 | C · major | `forkEnv` 在**同一行**克隆 `body` 与 `prepareHints`，而本轮守卫只断言了 body。评审把 `prepareHints` 改成共享 → 六文件 92 条测试**全绿** | **采纳**。在真实 hedge 路径补身份 + 行为断言 | `67c84f52`。变异对照：改共享后恰好这一条红、失败落在新增断言行；反向 patch 恢复后 12 pass / 0 fail。**这是最初那个缺陷的复发形态**——修了一半、把同一行的兄弟字段留在外面 |
| R2-5 | 指令文本 | B · major | 新记忆的「称呼表」可被「空类别 + 自认列全」绕过：只要求列四类、分别报数 | **采纳**。收紧为每类须给具体 literal + 旧契约 `file:line`，写「无」须附检索式与命中审阅——把自评换成别人能重跑的检索式 | `f686d2d6`。**并把一条更硬的证据写进正文：这条规则的第一版没拦住它自己要防的错**，写下之后同一会话又复发两次（R2-1、R2-3），两次都是评审逮到而非自查 |
| R2-6 | 指令文本 | C · major | 处置表把环境归因写成「实测坐实的因果」，超出留存证据强度：`.node` 是 gitignored，旧产物 mtime 已不可复核，原始输出未落盘 | **采纳并降级**。把当时命令与计数逐字搬进本文，分栏标明可复核 vs 仅当时观测，明确承认它证明的是**先后与共变**而非因果 | `f686d2d6`，见下节 |

**未采纳：无。** 唯一偏离建议之处仍是 R1 的守卫 blocker（选行为 oracle 而非扩大字符串黑名单）。

**为什么到此收口而不再复评**：用户 2026-08-11 裁决「评审收敛到一个时点，只在合并进主分支之前做一次，不再复评到 0 blocker」（CLAUDE.md「工作节奏」节）。本轮即那一次，已在常规测试通过之后派出。

## 第三轮（三个从未被覆盖过的角度，非复评）

三份报告：[round3-review-value-provenance.md](archive-2026-08-11/round3-review-value-provenance.md)、[round3-review-fixes-of-fixes.md](archive-2026-08-11/round3-review-fixes-of-fixes.md)、[round3-review-merged-state.md](archive-2026-08-11/round3-review-merged-state.md)。**0 blocker / 4 major，全部采纳**。

| # | 来源 | 级别 | 发现 | 处置 | 证据 |
|---|---|---|---|---|---|
| R3-1 | 值来源 | — | **0 发现**。补的是首轮 AST 扫掠自报的盲区（只查键不查值来源）：同名不同源（`request.model` vs `body.model`）、固定基线 vs 每次 retry 被覆写的 `attempt.body`、逐候选与请求级取反 | **确认，无需动作**。它写明了扫描范围与判据，「无发现」与「没扫」可区分，并对两个可疑站点下判定而非只列清单 | 我抽验两条承重结论：`cc-family-strategies.ts` 的 fallback 与改动前结构逐字对应；`request.truncateBaseline` 的写入点确实只有 gemini S1b 那处 |
| R3-2 | 修复本身 | A · major | `spec/2026-07-26-server-tool-provenance-routing.md`（**已定稿、待用户裁决**）的注记不止陈述前提失效，还断言「本条结论未被自动推翻」，并把 `request` 描述成「请求级纯值」——而 `envelope.ts` 明写它跨候选共享且会在 S1b 被再 refine | **采纳，撤回越界表述**。注记只留「两处旧前提已不存在」，明写不作判断、不保留也不推翻原结论 | `c0077495`。**判 A 级**：拟改变待用户裁决文档的实质，不由我裁 |
| R3-3 | 修复本身 | C · major | 同一份 hook spec 的 §4.1「首个生产示例」与 §4.2 helper 表仍在教作者用 `env.clientFormat`/`env.body`、承诺 helper「不可变、返回新 env」——上一轮只改了叙述句 | **采纳**。连同不在取代横幅之下的 gemini 形状警示一并改到当前 API 与 `writeAttempt` 语义 | `c0077495`。这是评审被要求找的第三处「改了内容没改指向它的东西」 |
| R3-4 | 修复本身 | B · major | 称呼表判据**第三次**被判可绕过：v2 要求「每类给具体 literal」，而只列一个 literal 也满足 | **采纳**。改为**候选集合从删除动作机械导出**（标识符取删除 commit 的 `-` 侧、非标识符取被删声明的旧 docstring 用词），逐项处置、差集显形——完整性裁定权从作者转到一条别人能重跑的命令 | `c0077495`。**判 B 级**：改变模型此后每次加载收到的指令。当场自验：导出得到 `requestState`/`RequestState`/`with`/`Immutable`，恰好含 v1 漏掉的两个，并额外查出 `retry-registry.ts:24` 一处三轮清扫与六名评审都没抓到的残留 |
| R3-5 | 合并态 | C · major | **否定了我的 C3**：`test:backend` 0 fail 不等于全绿——`tests/history/v3/migrations-wiring.it.test.ts` 三例单跑必挂 | **采纳**。主检出复现确认（带不带 `--isolate` 都挂）；A/B 证先于本轮存在，登记 backlog 而非顺手改 | `e900a73b`。合并态另确认 C1/C2：peer 期间四次改动 `driver.ts`，无一处把 env 引用当不可变快照——取消 copy-on-write 后最该担心的集成缝是干净的 |

**未采纳：无。**

## 一条环境归因（不是回归）——附原始输出与**明确的可复核边界**

`test:backend` 首轮 21 条红全部落在 History 子系统（`history/{search,worker,v3}`、`diagnostics/durable-writer`）。没有当作「既有失败」挥手放过，逐步取证如下。

**可从仓库独立复核的部分**：

- `src/lib/history/search/daemon.ts` 调用 `options.index.generation()`；该调用由 `7a99a254`（2026-08-08）引入 —— `git log -1 -S"generation()" -- src/lib/history/search/daemon.ts`。
- Rust 侧确实导出该方法：`native/history-search/src/lib.rs` 的 `pub async fn generation(&self)`。
- `native/history-search/*.node` 是 **gitignored 构建产物**（`git check-ignore -v native/history-search/copilot_history_search.node`），因此它不受版本控制、也不随 checkout 更新。

**当时实测的原始输出**（命令与计数逐字摘录，日志本身在 job 临时目录、不随仓库保留）：

| 时刻 | 命令 | 结果 |
|---|---|---|
| 重建前 | `bun test tests/history/search/daemon.it.test.ts` | `10 pass / 12 fail`，失败点 9 次 `TypeError: options.index.generation is not a function. (In 'options.index.generation()', 'options.index.generation' is undefined)` |
| 重建前 | `bun run test:backend` | `7931 tests · 7910 pass · 21 fail` |
| 重建 | `bun run build:history-search` | rc=0 |
| 重建后 | `bun test tests/history/search/daemon.it.test.ts` | `22 pass / 0 fail` |
| 重建后 | `bun run test:backend` | `7931 tests · 7931 pass · 0 fail` |

**不可复核、按未验证标注的部分**（独立评审指出，已采纳）：旧产物的构建时间「2026-08-06 20:08」来自当时的 `ls -la` 观测，而该文件已被重建覆盖且不在版本库中，**此刻无法再独立取证**。因此严格说：上表证明的是「重建产物 → 该批失败消失」这个**时间上的先后与共变**，加上「调用的符号 2026-08-08 才引入、而产物早于源码」这个当时观测；把它称作已坐实的因果，超出了留存证据能支撑的强度。

**与本次重构的关系不受上述削弱影响**：这批失败落在 `src/lib/history/**`，而本轮改动的文件集（`git show --name-only` 逐个 commit）与之不相交，且 `src/lib/history/search/daemon.ts` 从未被本轮触碰。



## 未采纳

无。三份报告的每一条事实性发现都成立并已落地。唯一偏离评审建议之处：守卫 blocker 的建议是「用可解析的 import/call-site oracle，或以行为 oracle」二选一，我选了后者并**明确拒绝了扩大字符串黑名单**——理由写在 `config-snapshot.unit.test.ts` 末尾与新文件的头注里。

## 待办

无。三轮九名评审均已收口：第一轮（契约／守卫／扫掠，8 条）、第二轮（doc↔code／判据判别力／指令文本，6 条）、第三轮（值来源／对修复本身的评审／合并态，4 条），**共 18 条全部采纳落地，零未采纳**。按用户 2026-08-11 的「评审收敛到一个时点」裁决，**不再发起复评轮**；第三轮不是复评，三个角度此前均未被覆盖。
