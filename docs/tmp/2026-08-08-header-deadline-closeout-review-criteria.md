# 收尾产物评审（视角：判据证伪）

- **评审对象**：`9daad677`（活文档 doc-sync）、`1af8f17a`（plan/spec 状态注解）、`30dfa68a`（新记忆 + 索引）、`f0cb1f1e`（HANDOVER + KICKOFF）。分支 tip `f0cb1f1e`。
- **总体 verdict**：**无 blocker、无 major；4 条 minor**。否定性断言与正控均亲手复跑、结论成立；问题集中在「数字锚到哪个树」与「一条待办缺鉴别力正控」。

## 1. sha 与数字核验

| 断言 | 出处 | 命令 | 输出 | 结论 |
|---|---|---|---|---|
| 本地 `master` = `d1011fe7…` | HANDOVER:5 | `git rev-parse master` | `d1011fe7eb1f26c0c646b667164ddb0e4dd80bf0` | ✅ |
| 阶段 1 终点 `bea1dfa3` 已进 master | HANDOVER:5,7 | `git merge-base --is-ancestor bea1dfa3 d1011fe7` | rc=0 | ✅ |
| spec 状态提交 `d47492a6` 已进 master | HANDOVER:5 | `git merge-base --is-ancestor d47492a6 d1011fe7` | rc=0 | ✅ |
| 本批次未进 master（「全部提交都在本地」） | HANDOVER:5 | `git merge-base --is-ancestor f0cb1f1e d1011fe7` | rc=1 | ✅ |
| `7279 executed / 30 skipped / 0 fail` | HANDOVER:11、plan 注解 | 在 `bea1dfa3` 实跑 `bun run test:backend` | `7279 executed · 30 skipped · 0 fail`（artifacts `/tmp/parallel-test-RdYXqH`） | ✅（锚点见 minor-2） |
| baseline `7279 / 712 文件 / 30 skips` | spec `d47492a6`、plan 注解 | `git show d1011fe7:tests/infra/entry-test-discovery-baseline.json`、`git show bea1dfa3:…` 解析 | 两侧同为 `minimum_executed=7279`、`files=712`、`allowed_skipped=30`、`runner_git_blob=66d215f2…` | ✅ |

### [minor-1] plan 注解把 `master` 写成 `bea1dfa3`，与同批 HANDOVER 的 `d1011fe7` 冲突

- **位置**：`docs/plan/2026-08-06-http2-cancel-provenance-and-header-deadline.md` 顶部注解首行「核验于 2026-08-08，`master` = `bea1dfa3…`」，以及阶段 2 条目末尾「核验于同一 `master`」。
- **证据**：`git rev-parse master` → `d1011fe7…`；`git merge-base --is-ancestor bea1dfa3 d1011fe7` rc=0，说明 `bea1dfa3` 是 master 的祖先而非 master 本身。同批 `HANDOVER.md:5` 写的是 `d1011fe7`。
- **影响**：两份活文档对「核验基线是哪个 master」给出互斥答案；接手者照 plan 的 sha 复跑 grep 会锚在一个不是 master 的提交上，且不会有任何报错提示锚错了。
- **不升级为 major**：我已在真 master `d1011fe7` 上复跑该注解全部断言（见第 2 节），结论本身成立，属锚点错误而非结论错误。
- **建议**：改成 `d1011fe7`，或显式区分「阶段 1 代码终点 `bea1dfa3`」与「核验基线 master `d1011fe7`」两个角色。

### [minor-2] `7279/30/0` 的实测锚点是 `bea1dfa3`，KICKOFF 却挂在 `master = d1011fe7` 名下

- **位置**：`KICKOFF.md:32`「测试门禁现状（核验于 2026-08-08，`master` = `d1011fe7`）：…`test:backend`（`7279 executed / 30 skipped / 0 fail`）均可正常跑」。
- **证据**：该三元组由我在 `bea1dfa3` 树实跑得到；`d1011fe7` 相对 `bea1dfa3` 另有 History worker Batch 1b 的测试增删（`git diff --stat master..f0cb1f1e` 显示 `tests/history/worker/protocol.unit.test.ts` 在 master 侧多 39 行等）。我没有在 `d1011fe7` 上跑过 `test:backend`。
- **缓解事实**：`d1011fe7` 与 `bea1dfa3` 的 baseline 逐字段相同，且 master 侧是净增测试，floor 不会被击穿——但这是我推出来的，不是 KICKOFF 交出来的证据。
- **对比**：HANDOVER:11 的写法正确（显式「阶段 1 合并态，锚定 `bea1dfa3`」）；KICKOFF 应照抄该锚定方式。

## 2. 否定性断言的集合边界与正样本对照（HANDOVER:27、plan 注解）

我在**真 master `d1011fe7`** 上逐条复跑（用 `git grep <rev>` 而非工作树，避免锚到本分支的 docs-only 提交）：

| 判据 | 命令 | 输出 | 结论 |
|---|---|---|---|
| 阶段 2 类型零命中 | `git grep -c -E 'TransportTerminationEvidence\|TransportTerminationObservation' d1011fe7 -- src tests packages` | 无输出，rc=1 | ✅ 零命中 |
| 阶段 3 投影零命中 | `git grep -c 'transportTermination' d1011fe7 -- src tests packages` | 无输出，rc=1 | ✅ 零命中 |
| **正样本对照** | `git grep -c 'TransportErrorReason' d1011fe7 -- src packages` | `packages/foundation/src/error/classify.ts:3`、`packages/foundation/src/error/transport-reason.ts:7`，rc=0 | ✅ grep 确实触达该树，零命中不是「路径写错」 |
| 旧 helper 已退役 | `git grep -c 'createResponseHeaderTimeoutSignal' d1011fe7 -- src` | 无输出，rc=1 | ✅ |
| 阶段 3 canonical 字段不存在 | `git grep -n -E '\.termination\b\|termination\?:' d1011fe7 -- src/lib/context/model-operation-record.ts src/lib/context/types.ts src/lib/history/types.ts src/lib/history/v3/projection.ts` | 无输出 | ✅ 与「`ModelOperationDispatch.termination` 与 `attempts[].transportTermination` 均不存在」一致 |

**判据鉴别力评估**：正样本对照是**同族符号**（`TransportErrorReason` 与被查的 `TransportTermination*` 同在 `packages/foundation/src/error/` 下），因此它同时证明了 ① 路径参数覆盖到 `packages/`、② 该 rev 下 grep 正常工作。这比用一个随便的高频词（如 `import`）做正控更有判别力——后者在 `src` 命中即可通过，证明不了 `packages` 腿也被覆盖。

**排除项声明属实且必要**：HANDOVER:27 明写「未查 `ui-v4/`、未查 `docs/`」。我确认这两个排除是**诚实**而非漏查——`docs/` 里必然有这些词（规格本身），把它算进命中会让否定性断言永远不成立；`ui-v4/` 则是阶段 3 的消费端，此刻未接线。**残留缺口（nit 级，不单列）**：排除项没说明「阶段 3 开工后 `ui-v4/` 必须纳入同一 grep 口径」，接手者可能沿用这份排除清单而漏掉前端腿。

## 3. 待办 T1–T4 的三件套（验收判据 / 证伪方式 / 鉴别力正控）

| 待办 | 验收判据 | 证伪方式 | 鉴别力正控 | 判定 |
|---|---|---|---|---|
| T1（foundation 类型与 primitive） | ✅ 六 kind + 三字段 + `package-boundaries` 绿 | ✅ core 里另抄同名类型 → 边界守卫变红 | ✅ 删 union 一个 member → 消费端穷尽检查编译失败 | **齐全**，且正控打的是**类型系统**这一独立机制，不与验收判据同源 |
| T2（`http2-client` 产生点追加 evidence） | ✅ 六类 evidence 在 `req.close()` 前追加；自然 end 不产生 failure observation | ✅ 六种相邻状态各自 attribution 必须分别为 local/peer/session/ambiguous/unknown/无 | ✅ first-writer 吞掉后到 evidence → `ambiguous` 用例变红 | **齐全**；正控精确对准 spec §3.3 的核心不变量（append-only），不是泛泛「改点东西看看红不红」 |
| T3（`classifyError` 与 recovery 消费） | ✅ local/ambiguous/unknown 不得进 upstream-cut；peer/session 在既有门内仍能进 | ✅ **双向**：① 错误状态不能冒充 peer；② 正确 peer/session 不能被压成 unknown | ✅ 把 ambiguous 当 peer → 方向①变红 | **齐全**；双向证伪是本轮唯一显式写出 false-red 侧的待办 |
| T4（阶段 3 三条 settlement 路径） | ✅ 三条路径都写入最终 observation | ✅ 漏接任一条 → 对应投影测试变红 | ❌ **缺失** | **不齐**，见 minor-3 |

### [minor-3] T4 没有鉴别力正控，且它的「证伪方式」与「验收判据」是同一句话的正反面

- **位置**：`HANDOVER.md:53-55`。T1–T3 每条都带一行「鉴别力正控（**待执行期跑**）」，T4 只有验收判据与证伪方式两行。
- **为什么这不是形式主义**：T4 的证伪方式「漏接任一条路径 → 对应投影测试必须变红」在逻辑上等价于验收判据「三条路径都写入」的否命题——它只能证明「测试确实读了这条路径的输出」，**证明不了测试读的是最终 observation 而不是中途快照**。阶段 3 真正易错的形态（spec §5.3 与 plan Task 9 Step 6 明写）恰恰是「只等第一道 barrier」「从 `errorSnapshot` 读 tag」「logical terminal 当场 settle」——这三种缺陷都会让「三条路径都写了字段」照样成立，测试照绿。
- **也就是说**：T4 现在的两条判据组合起来，挡不住 plan 自己列出的三种 mutation。
- **建议**：补一行正控，直接引用 plan Task 9 Step 8 已冻结的三项 mutation（只等 operation barrier / 从 errorSnapshot 读 tag / logical terminal 当场 settle），要求各自使目标用例变红。
- **顺带确认（非发现）**：T1–T3 的正控都标注「待执行期跑」，这是**诚实**的——它们描述的是尚未存在的代码，此刻不可能有红/绿证据。把意图与证据分开标注是正确做法，不构成「只写意图」。

## 4. 新记忆 `methodology-merge-invalidates-branch-frozen-test-floor` 的技术断言

我用独立脚本重算了上一轮 backend 运行留下的 16 份 shard JUnit（`/tmp/parallel-test-RdYXqH/shard-*.xml`），按两种口径分别求值：

- 命令要点：统计 `<testcase` 出现次数、`<skipped` 出现次数，以及 `<testsuite … tests="N">` 属性求和。
- 输出：`xml files 16`、`testcase leaves 7309`、`skipped 30`、`leaf_executed 7279`、`suite_attr_sum 14541`。

| 记忆断言 | 复核结果 |
|---|---|
| 叶节点口径 `7309 − 30 = 7279`，与 runner 汇总一致 | ✅ **完全复现**（7309/30/7279 三个数字逐一相符） |
| suite 可嵌套、按 `tests=` 属性求和会重复计数 | ✅ **成立**：属性求和 14541 ≈ 叶节点 7309 的两倍，确认父子层重复计数这一机制性解释 |
| 两侧冻结数字都错（feature `7244`、master `7255`，合并态 `7279`） | ✅ 与上一轮实测一致：`7244` 会把地板静默调低 35 |
| `runner_git_blob` 按合并树真实 hash 取，`66d215f2` 而非 master 侧 `201996e1` | ✅ `git rev-parse bea1dfa3:scripts/parallel-test.ts` = `66d215f2…`，与 baseline 字段一致 |

### [minor-4] 记忆里的 `14475` 复现不出来，我实测同一错误口径得 `14541`

- **位置**：记忆正文「本轮首次这么算得 `14475`，是错的口径，被叶节点重算推翻」。
- **证据**：我按同一错误口径（`<testsuite tests=…>` 属性求和）在 `/tmp/parallel-test-RdYXqH` 的 16 份 shard 上得 **14541**，不是 14475。差值 66。
- **成因推测（未证实）**：14475 应来自另一次 backend 运行的 artifact 目录（分片边界不同 → suite 嵌套层数不同 → 属性求和随之漂移），而 7309/30/7279 这一组在两次运行间稳定。这恰恰说明**错误口径的值本身不稳定**。
- **为什么仍算 minor 而非 nit**：记忆的教学价值不依赖这个具体数字，但它是以「我当时算出 X」的实证语气写下的；后人照做得到 14541 会怀疑记忆写错了别的东西。
- **建议**：把 `14475` 改为「≈ 叶节点计数的两倍（本轮两次运行分别得 14475 / 14541，随分片而漂移）」，或直接删掉具体值只留「远大于叶节点数」这一定性判据——**定性判据才是可复现的那部分**。

## 5. DESIGN.md 两行改动与代码现状

`git diff 9daad677^..9daad677` 只改两行表格 + 一行审计文档警示。逐句核对（命令在 master `d1011fe7` 上跑）：

| DESIGN 断言 | 命令 | 输出 | 结论 |
|---|---|---|---|
| HTTP 五个调用点只传标量 `resolveResponseHeaderTimeoutMs(model)` | `rg -n 'responseHeaderTimeoutMs' src` | `transport/send.ts:222`、`anthropic/client.ts:164`（+ 参数 `:62,:81`）、`routes/messages/count-tokens.ts:73`、`models/client.ts:52`、`openai/embeddings.ts:61,:72` | ✅ 五个点逐一对上，无遗漏无多列 |
| `upstreamFetch` 建立可解除 deadline | `rg -n 'responseHeaderTimeoutMs' src/lib/transport/upstream-fetch.ts` | `:52` 入参、`:98-99` 解构与 `<=0` 短路、`:101` `createResponseHeaderDeadline(...)` | ✅ |
| WS first-event 仍用持久 signal | `git grep -c 'createUpstreamFirstEventTimeoutSignal' d1011fe7 -- src` | `fetch-utils.ts:1`、`openai/upstream-ws-attempt.ts:2`（定义 + 使用各一处） | ✅ |
| 旧 `createResponseHeaderTimeoutSignal` 已退役 | `git grep -c 'createResponseHeaderTimeoutSignal' d1011fe7 -- src` | 零命中 | ✅ |
| `timeout-attribution-audit.md` 的更正没有推翻该文既有缺口结论 | 阅读新增警示段 | 明写「归因去向与『⚠️ 有洞』的结论未被该阶段改变（阶段 1 只改时钟作用域与所有权，不动日志归因）」 | ✅ 边界克制、未越界宣称修好了归因 |

**旧文本确实是错的、新文本是对的**：被替换的那句写「经 `createResponseHeaderTimeoutSignal(model)` → `resolveResponseHeaderTimeoutMs`」，而该 helper 在 `d1011fe7` 的 `src` 下已零命中——旧行会把读者引向一个不存在的符号。

## 6. 结论

- **blocker 0 / major 0 / minor 4**（minor-1 plan 的 master sha、minor-2 KICKOFF 的门禁锚点、minor-3 T4 缺鉴别力正控、minor-4 记忆里 14475 复现不出）。
- 四条都不改变任何**结论**的正确性：否定性断言在真 master 上成立、7279/712/30 与 baseline 及 JUnit 叶节点三方自洽、DESIGN 两行与代码逐句相符。
- 唯一有长远代价的是 **minor-3**：它会让阶段 3 的验收在 plan 已经预见到的三种缺陷面前失去判别力，建议在开工前补上。
