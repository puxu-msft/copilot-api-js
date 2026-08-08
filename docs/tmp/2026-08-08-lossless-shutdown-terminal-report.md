# 首信号无损排空——会话终态报告

> 冻结时间 2026-08-08。分支 `worktree-fix-shutdown-review-findings`，worktree 位于 `.claude/worktrees/fix-shutdown-review-findings`。
>
> **一句话状态：整改全部完成、全门绿、五轮独立评审的发现全部处置并复评闭合，并已由 `ad8128ad` 合入 master。** 用户于 2026-08-08 执行合并；本会话未推送任何内容，发布仍是用户的决定。
>
> **各轮的真实计数（不要压缩成一句「0/0」）：** 实施阶段三轮闭合于 0 blocker / 0 major；收尾阶段的指令类文本评审报 0 blocker / 3 major（已由未卷入第三方逐条复评 FIXED）、文档与证据评审报 1 blocker / 2 major、终态报告终审报 1 blocker / 2 major（已由原终审 reviewer 复评 FIXED，属 C 级、按分级可由其收口）。所有发现均已处置，无未闭合项。

## 1. 交付内容

原始问题：graceful shutdown 在首个终止信号后，等待 `shutdown.graceful_wait` 到期便以进程级 `AbortSignal` 中止所有剩余 operation，把仍在正常工作的长请求改写成 `Server is shutting down`。2026-08-07 的 incident 中三个 `/v1/messages` 在同一秒因此失败。

用户裁决（2026-08-07）：**始终等请求终态**。首信号只封闭 ingress；已接纳 operation 保有全部能力（token、rate limiter、上游 WS／h2、History、Telemetry、Diagnostic）；shutdown 不持有任何请求级 deadline，永不产出 `Server is shutting down` 这一请求终态；第二个信号立即强退。

落地形态：

- 「已接纳」的机械边界 = `RequestContextManager.getTrackedOperations()` 与 lightweight in-flight registry 的**并集**。后者覆盖 count_tokens／embeddings——它们不建 `RequestContext`，第一版整改漏了这条旁路，由代码评审抓出。
- drain 为无 deadline 的 condition wait；两个 registry 均清零后才按序关闭 token runtime → 上游 WS／h2 → History → Telemetry → Diagnostic → 发布 `finalized` → 观察者 WS → `stopped`。
- 删除 process-global shutdown abort、529 改写、`aborting`／`forcing` 阶段与两个 shutdown 时间旋钮；旧 Vue 配置表面同步删除。
- systemd handoff 改为 SIGUSR2 后等待旧槽自行退出（原实现立即 `systemctl stop`，会让随后的 SIGTERM 成为第二终止信号而强退在途请求）；PM2 两槽配置 `stop_exit_codes: [0]`。

## 2. 提交谱系

| commit | 内容 |
|---|---|
| `04e6ecb1` | Task 1：无 deadline operation drain |
| `d254d8ae` | Task 2：删除 process-global shutdown cancellation 与 529 改写 |
| `c6a5f72c` | Task 3：删除两个 shutdown deadline 配置、state 字段与阶段类型 |
| `4c555ef9` | Task 4：live docs、skill、supervisor 样例同步 |
| `77d6d479` | 评审整改：lightweight registry、真实 HTTP 交叉测试、systemd／PM2、旧 Vue、discovery baseline |
| `f1cb3cc5` | 评审处置记录 |
| `954a1bff` | 合并态发现：lightweight pre-terminal capture 抛错时未释放 History reservation |
| `a6be256a` | entry evidence validator 文件级超时预算 |
| `6adf2e56`／`93de46b9`／`51d705cf`／`5405056b`／`e5ad10ea`／`73928cef`／`2c248536` | 收尾：证据归档、plan 终态化、skill 复跑协议、记忆条目、临时清单、两轮收尾评审处置 |

**`04e6ecb1`～`4c555ef9` 先随 peer 的 `0732fc76` 进入 master；`77d6d479` 起的整改由 `ad8128ad` 合入 master。** 本表所列全部提交现均在 master 上——`git merge-base --is-ancestor 954a1bff master` 退出 0。唯一例外是本次收尾在合并之后追加的文档更新，见第 9 节。

## 3. 验证（均在本分支最终状态执行）

| 项 | 结果 | 命令 | 新跑／复用 |
|---|---|---|---|
| 后端全档 | 16 shards，`executed=7295`、`skipped=31`、`fail=0`、退出码 0 | `bun run test:backend` | 新跑（合入 `master@475bed45` 之后） |
| 本任务自有测试（12 个 backend 档文件） | `Ran 100 tests across 12 files`、退出码 0，连跑两次一致 | 见 plan「实施结果」的显式文件清单 | 新跑两次 |
| 类型 | 通过 | `bun run typecheck` | 新跑 |
| 全仓 lint | 通过（仅剩与代码无关的 `baseline-browser-mapping` 数据过期提示） | `bun run lint:all` | 新跑 |
| 架构与 discovery guards | 17 文件、178 pass、0 fail、退出码 0 | `bun test tests/architecture/ tests/infra/test-discovery-matrix.unit.test.ts` | 新跑 |
| PTY | 19 pass，0 fail | `bun run test:pty` | 复用（合入 `master@d47492a6` 前执行，此后无 pty 路径改动） |
| 旧 Vue | Bun 249、Vitest 78、vue-tsc、Vite build 均通过 | `bun run test:ui` 等 | 复用（同上，此后无前端路径改动） |

**计数口径警告：** parallel runner 打印的 `N tests · N pass` 字段在同一棵树上跨运行不稳定——四次运行观测到 5334／6044／6384／7287，而 `executed=7287`／`skipped=30` 四次完全一致。任何以该字段做增减归因的说法都不成立。

**一次已排除的 false-red：** 与 reviewer 同树并发跑测试时 `tests/history/v3/store-performance.it.test.ts` 的耗时比值断言失败一次；单跑 3/3 绿、无并发的完整 backend 0 fail，且本任务未触碰 History V3 store。

**正控：** generation registry 与 lightweight registry 两处 omission mutation，冻结 exact patch 已归档到 `docs/tmp/`，`git apply --check` 在当前 HEAD 仍通过；复跑序列与目标测试命令写在 skill `process-lifecycle-shutdown` 的「鉴别力正控」节。

## 4. 独立评审

| 轮次 | 评审者 | 结论 |
|---|---|---|
| 首轮 | 测试／文档 reviewer（异模型） | 2 blocker / 4 major，全部整改并复评 PASS |
| 首轮 | 生命周期代码 reviewer | 0 blocker / 2 major，整改后复评又发现 1 条合并态 MAJOR（`954a1bff` 修复），再复评 PASS |
| 首轮 | 未卷入第三方 instruction reviewer | 0 blocker / 0 major |
| 收尾 | 指令类文本 reviewer（异模型） | 0 blocker / 3 major → 处置后由**未卷入的第三方**逐条复评，M1／M2／M3 全 FIXED，0 blocker / 0 major |
| 收尾 | 文档与证据 reviewer | **1 blocker / 2 major**，见下 |
| 终审 | 未卷入的终态报告 reviewer（异模型） | **1 blocker / 2 major**，见下 |

收尾文档评审的 blocker 值得单独点名，因为它抓的是我自己写的错：三份文档把「把 master 合进本分支」写成了「整改已合入 master」，**方向反了**。我独立复核确认它对（`git branch -a --contains 954a1bff` 只输出本分支；`git show master:src/lib/shutdown.ts` 第 304 行至今仍是单 registry）。若不改，接手者会读到「已合入、可合并」而不再合并，而 master 上此刻仍带着评审判为 MAJOR 的 F7 与 History reservation 泄漏。

两条 major 同样成立并已处置：backend 计数字段不可复现（改锚稳定字段）、自有测试「12 文件 98 pass」取自未写明的文件集（重定义为显式 12 文件清单，实测 100 tests）。

评审报告落盘在 `docs/tmp/2026-08-08-lossless-shutdown-closeout-instruction-review.md`、`docs/tmp/2026-08-08-lossless-shutdown-closeout-docs-review.md`（该 reviewer 运行环境禁用 `Write`，报告由主会话逐字转录，已在文件开头标明）与 `docs/tmp/2026-08-08-closeout-final-review.md`。

> **文件名撞车的处置：** 前两份报告原名 `2026-08-08-closeout-{instruction,docs}-review.md`，与另一并发会话在 master 上创建的同名文件冲突（`git merge-tree` 报 add/add）。已加任务前缀重命名避开；对方文件内容与本任务无关，未做任何改动。

### 终审发现与处置

终审在我提交终态报告之后、其自身运行期间，master 又前进了，因而抓到三条：

1. **blocker：报告钉死的 master tip 已过期，且对当时的 master 存在真实合并冲突。** 成立，且比它看到的更值得记：这个仓库里 master 由多个并发会话推进，本会话观察窗口内它走过 `d47492a6 → d1011fe7 → b936a8e9 → 475bed45`。处置分两步——① 把「钉死 tip + 断言无冲突」改为「合并前就地跑命令复核」，写死快照值在这里必然过时；② 把当前 master 实际合入本分支并解掉两处冲突：`docs/tmp/2026-08-08-closeout-instruction-review.md` 的文件名撞车（重命名避开，`1ec645f9`）与 `docs/todo/deferred-backlog.md` 的追加点冲突（两边条目并列保留，`616baffc`）。合入后 typecheck 通过、backend `executed=7295`／`fail=0`。
2. **major：「四路独立评审 0 blocker / 0 major」把结论说得比实际好。** 成立。已改写本报告开头与本节：实施三轮闭合于 0/0，收尾两轮各报 1 blocker / 2 major，且处置由我自评。
3. **major：「架构与 discovery guards 34/34」不可复现。** 成立。实测为 17 文件、178 pass、0 fail，命令已写出；`34/34` 无可复现 selector，已从本报告、`-review.md` 与 plan 三处一并更正。

**复评状态：已闭合。** 上述三条的处置由**原终审 reviewer** 复评，逐条判 FIXED，总体 0 blocker / 0 major，并实跑复核了两项：`git merge-tree --write-tree master HEAD` 退出 0、guards 复现 17 文件 178 pass。

> **措辞更正（由该 reviewer 自己指出）：** 这一轮是「原终审 reviewer 复评」，**不是**「未卷入方复评」——它正是这三条的提出者。按 `adopting-agent-findings` 的分级，这三条属 C 级（落进产物但可逆的文档修订），交回原评审者明确表态即可；若其中任何一条被升格为 B 级（改变模型收到的指令或加载行为），则须另派未卷入的第三方。本轮三条均不改变指令加载行为，故按 C 级收口。

## 5. 分支与 worktree 状态

- 分支 `worktree-fix-shutdown-review-findings`，worktree 干净，HEAD 全部已提交。
- **已合入 master**：用户于 2026-08-08 执行 `git merge --no-ff`，产生 `ad8128ad`。核实命令：`git branch -a --contains 954a1bff` 同时列出 `master`；`git show master:src/lib/shutdown.ts | grep -n 'getActive: ()'` 显示两个 registry 的并集。
- **未推送**，也不会推送——发布是用户的决定。合并只落在本地 master。
- 合并前本分支已把 `master@475bed45` 合入自身（`616baffc`，解掉两处冲突）。**master 在本会话期间由多个并发会话持续前进**（观察窗口内 `d47492a6 → d1011fe7 → b936a8e9 → 475bed45 → eea7a646`），故本报告不钉死 tip。
- **已知的两个复发冲突点**（下次从这条分支或类似长跑分支合并时仍会遇到）：`docs/todo/deferred-backlog.md`（各会话都在文末追加条目，解法恒为「两边并列保留」）与 `docs/tmp/` 下按日期命名的评审报告（易撞名，解法为加任务前缀）。两者都不涉及代码语义。
- **worktree 与分支保留**——本次收尾又在其上追加了合并后的文档更新（见第 9 节），需要再合一次；这些提交是那批更新的唯一持有者。
- 主检出树（`/home/xp/src/copilot-api-js`）本会话全程未由本会话直接操作；其它会话的未提交工作未受影响。

## 6. 文档与证据落点

- 冻结规格：`docs/spec/2026-08-07-lossless-graceful-shutdown-drain.md`（状态：已实施）。
- 实施计划：`docs/plan/2026-08-07-lossless-graceful-shutdown-drain.md`，已转终态记录，状态头给出「整改已合入 master」的正向判定命令。
- live docs：`docs/DESIGN.md`、`docs/lifecycle.md` 已反映两个 registry 的并集边界与资源关闭顺序。
- 操作性知识：skill `process-lifecycle-shutdown`（含证据边界与正控复跑协议）。
- 评审与证据：`docs/tmp/2026-08-08-lossless-shutdown-review{,-dispositions}.md`、两份变异 patch、`-timings.xml`、`-shard-timeouts.md`、三份收尾评审报告（`-closeout-instruction-review.md`、`-closeout-docs-review.md`、`-closeout-final-review.md`）。
- 结构性待办：`docs/todo/deferred-backlog.md:1208`「shutdown drain source 仍由协调器手工枚举」——长期形状是统一的 accepted-operation registry，本轮不夹带架构重写。
- 临时证据清单：`docs/tmp/2026-08-08-lossless-shutdown-temp-manifest.md`（53 个文件逐条处置，有长期价值的四项已持久化进仓库，未删除任何临时文件）。
- 自有测试集的可复跑口径：`docs/tmp/2026-08-08-lossless-shutdown-self-tests.sh`（自解析仓库根，实跑复现 100 tests / 12 files；这是「12 文件 100 pass」的唯一精确口径，先前那版 98 pass 正是因为文件集没写明才对不上）。
- 记忆：`docs/memory/methodology-false-red-from-process-global-quantities-not-the-mechanism.md` + `MEMORY.md` 索引行。

## 7. 可复用资产

| 候选 | 类型 | 处置 |
|---|---|---|
| shutdown 生命周期契约与证据边界 | 项目 skill | **已实现**——`process-lifecycle-shutdown` 本轮更新（两个 registry、正控复跑协议、证据边界的诚实边界声明） |
| 「随机 false-red 挂在进程全局量上」 | 记忆条目 | **已实现**——与既有污染 playbook 并列而非取代它；判据侧与污染侧两条假设并行推进 |
| 统一 accepted-operation registry | 项目重构 | **仅记录**——已进 backlog，触发条件为出现第三类 operation 旁路或再次修改 `ShutdownActiveOperation` |
| 「shutdown 协调器手工枚举 producer」这一结构怪味的通用形态 | 规则／skill | **不提议**——已有 `fix-at-the-shared-base-not-where-you-noticed` 覆盖，再造一个同义条款只会稀释触发 |

## 8. 未做的事（显式声明）

- **未推送任何东西。** 所有提交都在本地，包括用户执行的那次 master 合并。
- **本次收尾追加的文档更新，其合并状态不在本文断言范围内。** 见第 9 节的判定命令——静态文本不适合充当动态状态源，故本报告不写它自己合没合。
- **未删除任何临时文件。** 见临时清单。
- **未 cherry-pick peer 分支 `worktree-nghttp2-header-deadline`。** 该判断经复测成立——它自己合进 master 后 `lint:all` 即转绿。
- **首信号后新建 upstream WS 仍无 shutdown 交叉测试直接覆盖。** 这一点在 skill 里显式标为证据边界，未扩大声称；已建 context 的 token refresh、新建 h2 与 pre-content recovery 三条均有直接证据。
- **一处曾写出的不可复现数字已更正，记在这里以免被当成从未发生：** 本报告初版写「架构与 discovery guards 34/34」，该数字无可复现 selector，由终审抓出；实测为 17 文件 178 pass。同类风险已在验证表里用「命令」列固定住——每一行都要能被单独复跑。
- **收尾三轮评审的处置已复评闭合。** 指令类文本三条由未卷入的第三方复评 FIXED；终审三条由原终审 reviewer 复评 FIXED（C 级，按分级可由其收口）。文档评审的三条由我自评后，其结论被终审独立重查并进一步收紧（正是终审抓出「四路 0/0」的夸大与「34/34」不可复现）。

## 9. 合并落地之后的更新

用户于 2026-08-08 执行合并、产生 `ad8128ad` 之后，本报告在内的多份文档里「尚未合回 master、待合并」的断言**当场变成了陈旧状态**。这是收尾阶段最容易留下的一类错误：文档写于合并之前，而它描述的正是合并这件事本身。修正这批后又合了第二次（`142923d3`）。

> **本节不再断言自己的合并状态，请自行判定：**
>
> ```
> git -C /home/xp/src/copilot-api-js merge-base --is-ancestor worktree-fix-shutdown-review-findings master && echo merged || echo pending
> ```
>
> **为什么改成这个形状：** 上一版这里写的是「本批仍待合并」，合并落地后它变假。**准确的问题形状是**：一句不带时间锚点的当前状态断言无法跨合并前后都为真——静态文本不适合充当动态状态源，而判定命令会自我更正。
>
> **一处已被独立评审证否的表述，留在这里当反例：** 我起初把理由写成「自指断言存在无穷回归、改不完、唯一出口是判定命令」。那是错的——写「已合并」只在合并落地前短暂为假、之后永久为真且不再需要新提交，**只要求最终 master 上的文本正确，一轮就收敛**。结论（该用命令）对，理由（无穷回归）错；错误的理由会把一条本可精确的判据撑成过强的全称命题。收窄后的判据见 `docs/memory/methodology-closeout-doc-goes-stale-the-moment-the-merge-lands.md`：**无时间锚点**的自身状态改给命令，确需留历史事实则锚定 commit 与观测时间。

本批更新内容：

- `docs/plan/2026-08-07-lossless-graceful-shutdown-drain.md`：状态头由「尚未合回 master」改为「已合入 master（`ad8128ad`）」，判定命令同步改为「应同时列出 `master`」的正向形态；实施结果的验证数字重锚。
- `docs/tmp/2026-08-08-lossless-shutdown-review{,-dispositions}.md`：合并状态同上更正。
- 本报告：第 1 行状态、第 5 节、第 8 节三处更正，并新增本节。
- `docs/tmp/2026-08-08-lossless-shutdown-temp-manifest.md`：第二次冻结（53 个文件），补入收尾后半程新增文件的分类；14 个 commit-message 输入逐条与已落地 commit 的 subject 比对，14/14 相等。
- 新增 `docs/tmp/2026-08-08-lossless-shutdown-self-tests.sh`：把自有测试集的精确文件清单从 job 临时目录提炼进仓库（原件写死 worktree 路径、收尾后失效；归档版自解析仓库根并加存在性校验），实跑退出 0、复现 100 tests / 12 files。
- 新增记忆 `docs/memory/methodology-closeout-doc-goes-stale-the-moment-the-merge-lands.md` + `MEMORY.md` 索引行。
- **更正四份他人文档的陈旧合并状态**：`docs/memory/project-{history-search-out-of-process,responses-buffered-merge-landed,symmetric-four-point-hooks}.md` 与 `docs/plan/monorepo-split/plan-telemetry-package.md` 仍称「待合并 master」，而其提交（`30a483df`／`8e0376d4`／`2a77bf7c`／`bd3aafe0`）早已在 master。逐个用 `git merge-base --is-ancestor` 复核后更正。**越界与否已交独立评审裁定**：机械更新一个可由 `merge-base` 判定的状态事实不越界、无需原作者裁决；若涉及结论或取舍则不适用此结论。

**本批也经过独立评审**：合并后收尾产物评审报 0 blocker / 4 major——终态报告提交谱系表第十处陈旧断言（不含任何我扫过的关键词）、上述四组他人文档、记忆判据可被三种说法绕过且「当场登记」无载体、临时清单把 job 目录外已不可复核的事写成无条件「已核验」。四条全部处置并经复评 FIXED，0 blocker / 0 major。报告见 `docs/tmp/2026-08-08-lossless-shutdown-postmerge-review.md`。

**因此需要再合一次**：

**若上面的判定命令输出 `pending`，合并方式**：

```
git -C /home/xp/src/copilot-api-js merge --no-ff worktree-fix-shutdown-review-findings
```

下列内容全是 `docs/` 下的文档、记忆条目与一个归档脚本，无代码改动。**「本批」在本节里不指某个冻结的 commit 集**——它随本报告继续被修订而增长，因此本节不对它断言合并状态；**分支与 worktree 的回收时机以上面那条判定命令的输出为准**，回收前再跑一次，不要依据本文任何一处叙述。
