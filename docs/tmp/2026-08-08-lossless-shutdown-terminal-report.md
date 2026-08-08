# 首信号无损排空——会话终态报告

> 冻结时间 2026-08-08。分支 `worktree-fix-shutdown-review-findings`，worktree 位于 `.claude/worktrees/fix-shutdown-review-findings`。
>
> **一句话状态：整改全部完成、全门绿、五轮独立评审的发现全部处置并复评闭合。尚未合回 master——合并是本报告后唯一剩下的动作，需要用户决定。**
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

**`04e6ecb1`～`4c555ef9` 已在 master**（由 peer 的 `0732fc76` 带入）。**`77d6d479` 起的整改仍只在本分支**。

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

- 分支 `worktree-fix-shutdown-review-findings`，worktree 干净（`git status --short` 无输出），HEAD 全部已提交。
- **未推送**，也不会推送——发布是用户的决定。
- 已把 `master@475bed45` 合入本分支（`616baffc`，解掉两处冲突：评审报告文件名撞车、`deferred-backlog.md` 追加点）。**master 在本会话期间由多个并发会话持续前进**（观察窗口内 `d47492a6 → d1011fe7 → b936a8e9 → 475bed45`），因此这里不钉死某个 tip——合并前请就地复核，不要引用本报告的快照值：

  ```
  git -C /home/xp/src/copilot-api-js merge-tree --write-tree master worktree-fix-shutdown-review-findings >/dev/null && echo "no conflict"
  ```

  **已知的两个复发冲突点**：`docs/todo/deferred-backlog.md`（各会话都在文末追加条目，解法恒为「两边并列保留」）与 `docs/tmp/` 下按日期命名的评审报告（易撞名，解法为加任务前缀）。两者都不涉及代码语义。
- **worktree 保留，不删除**——它是整改提交的唯一持有者。
- 主检出树（`/home/xp/src/copilot-api-js`）本会话全程未触碰；其它会话的未提交工作未受影响。

**合并本任务需要用户在主检出树执行**（本会话被 worktree 隔离守卫限制，无法操作共享检出，这也是本报告不代为合并的原因）：

```
git -C /home/xp/src/copilot-api-js merge --no-ff worktree-fix-shutdown-review-findings
```

合并前请确认主树工作区状态——该树常有其它并发会话的未提交改动。

## 6. 文档与证据落点

- 冻结规格：`docs/spec/2026-08-07-lossless-graceful-shutdown-drain.md`（状态：已实施）。
- 实施计划：`docs/plan/2026-08-07-lossless-graceful-shutdown-drain.md`，已转终态记录，状态头含「整改待合并」判定命令。
- live docs：`docs/DESIGN.md`、`docs/lifecycle.md` 已反映两个 registry 的并集边界与资源关闭顺序。
- 操作性知识：skill `process-lifecycle-shutdown`（含证据边界与正控复跑协议）。
- 评审与证据：`docs/tmp/2026-08-08-lossless-shutdown-review{,-dispositions}.md`、两份变异 patch、`-timings.xml`、`-shard-timeouts.md`、三份收尾评审报告（`-closeout-instruction-review.md`、`-closeout-docs-review.md`、`-closeout-final-review.md`）。
- 结构性待办：`docs/todo/deferred-backlog.md:1208`「shutdown drain source 仍由协调器手工枚举」——长期形状是统一的 accepted-operation registry，本轮不夹带架构重写。
- 临时证据清单：`docs/tmp/2026-08-08-lossless-shutdown-temp-manifest.md`（35 个文件逐条处置，有长期价值的三项已逐字持久化进仓库，未删除任何临时文件）。
- 记忆：`docs/memory/methodology-false-red-from-process-global-quantities-not-the-mechanism.md` + `MEMORY.md` 索引行。

## 7. 可复用资产

| 候选 | 类型 | 处置 |
|---|---|---|
| shutdown 生命周期契约与证据边界 | 项目 skill | **已实现**——`process-lifecycle-shutdown` 本轮更新（两个 registry、正控复跑协议、证据边界的诚实边界声明） |
| 「随机 false-red 挂在进程全局量上」 | 记忆条目 | **已实现**——与既有污染 playbook 并列而非取代它；判据侧与污染侧两条假设并行推进 |
| 统一 accepted-operation registry | 项目重构 | **仅记录**——已进 backlog，触发条件为出现第三类 operation 旁路或再次修改 `ShutdownActiveOperation` |
| 「shutdown 协调器手工枚举 producer」这一结构怪味的通用形态 | 规则／skill | **不提议**——已有 `fix-at-the-shared-base-not-where-you-noticed` 覆盖，再造一个同义条款只会稀释触发 |

## 8. 未做的事（显式声明）

- **未推送任何东西。** 所有提交都在本地。
- **未合并回 master。** 见第 5 节，需用户执行。
- **未删除任何临时文件。** 见临时清单。
- **未 cherry-pick peer 分支 `worktree-nghttp2-header-deadline`。** 该判断经复测成立——它自己合进 master 后 `lint:all` 即转绿。
- **首信号后新建 upstream WS 仍无 shutdown 交叉测试直接覆盖。** 这一点在 skill 里显式标为证据边界，未扩大声称；已建 context 的 token refresh、新建 h2 与 pre-content recovery 三条均有直接证据。
- **一处曾写出的不可复现数字已更正，记在这里以免被当成从未发生：** 本报告初版写「架构与 discovery guards 34/34」，该数字无可复现 selector，由终审抓出；实测为 17 文件 178 pass。同类风险已在验证表里用「命令」列固定住——每一行都要能被单独复跑。
- **收尾三轮评审的处置已复评闭合。** 指令类文本三条由未卷入的第三方复评 FIXED；终审三条由原终审 reviewer 复评 FIXED（C 级，按分级可由其收口）。文档评审的三条由我自评后，其结论被终审独立重查并进一步收紧（正是终审抓出「四路 0/0」的夸大与「34/34」不可复现）。
