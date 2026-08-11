# History Worker Batch 2b —— 收尾报告（2026-08-10）

**读者**：想知道「Batch 2b 到底交付了什么、证据在哪、还剩什么」的下一个人。不必读会话记录。

**一句话**：Batch 2b（semantic 写连接迁入 Worker 线程）已完成并合入本地 `master`（合并提交 `b2444a17`）；**未推送**。本次收尾在它之上又修掉了 5 处陈旧活文档、补齐了一份变异台账、并记录了一条被独立审计证伪的目录绑定规则。

---

## 1. 交付内容与落点

| 内容 | 落点 |
|---|---|
| Batch 2b 生产改动（Worker 独占 semantic 写连接、主线程只读句柄、启动 deadline、生命周期串行队列 + 事务式 bring-up） | 已在 `master`，合并提交 `b2444a17` |
| Batch 2b 进度真相源（剩余项、在途意图、已作废路线、四轮评审处置、**变异台账**） | [docs/history-persistence-worker/2026-08-09-history-worker-progress-impl-2b.md](2026-08-09-history-worker-progress-impl-2b.md) |
| 两份独立评审报告 | [2026-08-09-batch2b-review-gpt.md](2026-08-09-batch2b-review-gpt.md)、[2026-08-09-batch2b-review-testing.md](2026-08-09-batch2b-review-testing.md) |
| 活的架构现状（当前活路径的权威） | [docs/DESIGN.md](../DESIGN.md) 的 `src/lib/history/` 行 |
| 模块契约（写路径 / drain-before-close / DB 维护 / 迁移） | [docs/history.md](../history.md) |
| 关机顺序 | [docs/lifecycle.md](../lifecycle.md) |
| 暂缓项（pin/unpin 503 窗口、`backend: "legacy"` 上报、守卫按拼写匹配、5 条既有 `it` 失败） | [docs/todo/deferred-backlog.md](../todo/deferred-backlog.md) |

### 本次收尾产生的提交（全部在 `master` 上，均未推送）

**重算它们的命令**（比下表的哈希活得久——本文档所在分支反复 rebase 过，哈希会变）。这两份文档已于 2026-08-11 从 `docs/tmp/` 迁入 `docs/history-persistence-worker/`，**新旧路径都列上**，否则会漏掉改名之前或之后的那一半历史：

```
git log --oneline master -- docs/DESIGN.md docs/history.md docs/lifecycle.md \
  docs/memory \
  docs/tmp/2026-08-09-history-worker-progress-impl-2b.md docs/tmp/2026-08-10-batch2b-closeout.md \
  docs/history-persistence-worker/2026-08-09-history-worker-progress-impl-2b.md \
  docs/history-persistence-worker/2026-08-10-batch2b-closeout.md
```

| 提交 | 内容 |
|---|---|
| `eb714fdf` | DESIGN.md 请求流程第 8 条 + history.md 四段：写路径 / drain-before-close / DB 维护 / 迁移 runner 的线程归属订正 |
| `5bb8e436` | lifecycle.md 关机第 3 步仍在排空「主线程 V3 writer」 |
| `51927a0d` | 记忆：全套件红的第四类——一次 runtime 崩溃整体抬高失败计数 |
| `cafa89a6` | 进度文档新增「收尾对账补录」：变异台账、被证伪的归因、范围/解析错误、标定值、能力探针 |
| `760ffbcb` | 按第二轮对账修正上一条里我自己的四处过强/错误断言 |
| `40c8bf77` | 记忆：变异的第四种「没变红」解释；并收窄 summary-backfill 那条的范围 |

**前四条以原哈希 fast-forward 进入 `master`；后两条随分支 rebase 后进入，哈希已变**（终审核对：`760ffbcb` 的 patch-id 与原 `b8c257e6` 相同，`40c8bf77` 与原 `f7741bd0` 相同）。本报告自身也在 `master` 上，是这批之后的一条提交。

`~/.claude` 侧（**这次交付横跨两个仓**）：两份 skill 自验记录提交为 `19efdea`，用显式 pathspec 只提自己那两份，未触碰该树里并发会话的未提交改动。

---

## 2. 验证证据

**口径**：按 CLAUDE.md「同一交付合并后不因『刚合并』主动重跑全量测试」，Batch 2b 的全量证据**沿用**合并前那次；本次收尾**只改文档与记忆**（六个提交的 `--stat` 全部落在 `docs/` 下，无 `src/`、无 `tests/`），故另跑针对文档的守卫。沿用类证据一律写成**三元组**：commit + 原始记录在哪 + 复现命令。

| 项 | 复现命令 | 结果 | 来源 |
|---|---|---|---|
| 全后端门禁 | `env -u RUN_PERF_TESTS bun run test:backend` | **0 fail** | **沿用**，测于 **`42bdc6aa`**；原始记录=该提交 message 末行（`git log -1 --format=%B 42bdc6aa`） |
| 构建 | `bun run build:backend` | exit 0 | **沿用**，同上 |
| 类型 | `bun run typecheck` | 绿 | **沿用**，同上 |
| 文档树 L1 守卫 + Worker 边界守卫 | `env -u RUN_PERF_TESTS bun test tests/infra/design-doc-tree.unit.test.ts tests/architecture/history-worker-boundaries.unit.test.ts` | **14 pass / 0 fail** | **本轮新跑**，在合并后的主检出、`64a0c81f` |
| 包边界守卫（靶向补跑，见下） | `env -u RUN_PERF_TESTS bun test tests/architecture/package-boundaries.unit.test.ts` | **24 pass / 0 fail** | **本轮新跑**，`64a0c81f` |

⚠️ **锚点更正（终审查出，值得单独说）**：这三行原先写「测于 `b2444a17`」——**错**。那次全档运行的唯一原始记录是合并提交 `42bdc6aa` 的 message；`b2444a17` 是其后 29 秒的第二次合并，又并入了 14 个提交，**其中 `880dbdcd` 改了 `tests/architecture/package-boundaries.unit.test.ts` 11 行**。也就是说合并态确实变过，且变的正是测试基建。按 `moving-shared-head-is-not-failure`，这不需要重跑整档，但**需要靶向复验那个被改的文件**——已跑，24 pass / 0 fail（上表最后一行）。教训：**沿用证据时，「哪个 commit」必须回到取值的那次运行，不能顺手写成后来那个更眼熟的合并提交。**

**总数不可引用**：同树同 commit 连跑 `test:backend` 的测试总数会变（见 CLAUDE.md），只有 `0 fail` 是判据。要复现请在仓库根跑上表命令，不要引用任何历史快照数字。

---

## 3. 分支 / worktree / 发布状态（两个仓）

### copilot-api-js

- **未发布。** 全程没有 `git push`、没有建 PR、没有发布产物。`git status --short --branch` 显示本地 `master` 远超 `origin/master`（具体条数请自行跑该命令，不要引用快照）。
- **分支**：`history-worker-batch-2a`、`docsync-batch2b` 是否已被 `master` 包含，**用命令判定而不是读这句话**——`git branch --merged master | rg 'history-worker-batch-2a|docsync-batch2b'`。（本报告初稿把「自身已合并」写成了既成事实，而写下的那一刻它还没合并；改成判定命令是为了不再复发。）
- **worktree**：`.worktrees/history-worker-batch-2a`、`.worktrees/docsync-batch2b`。移除前提请自行核：`git -C <路径> status --short` 为空，且其 HEAD 可从 `master` 达。**是否移除留给用户**（见第 7 节）。
- **同伴 WIP 未受影响**：主检出里有若干条属于并发会话的未提交改动，本次全部合并均为 fast-forward，逐次核对过它们没有被卷入。收尾期间 `master` 被同伴推进过多次，每次都用 rebase + `--ff-only` 重新对齐。**有一次合并被同伴对 `docs/memory/MEMORY.md` 的未提交改动挡住**——行级并不冲突（它改索引前段、本轮改 86 行区），但没有为自己的合并时机去回退同伴 WIP，而是等其落地后再合。**这一条是本会话的自述，仓库里没有留下可核对的产物**（未提交改动本就不会留痕）；终审能独立佐证的只有「某个时刻该文件为 `M`、之后变 clean」这一侧面，故按自述记录，不作已验证事实。

### `~/.claude`

- 两份 skill 自验记录（`proving-where-a-command-ran`、`closing-a-development-session` 的 `verification-log.md`）已提交为 `19efdea`，显式 pathspec，未触碰该树里其他并发会话的未提交改动。**未推送。**
- 这一节是终审补出来的：本次交付实际横跨两个仓，而初稿只对 copilot-api-js 做了对账，V4 的证伪记录当时还只活在一棵脏工作树的未提交改动里。

---

## 4. 临时状态处置

- **判据（这段唯一活得久的东西）**：`fd` 默认遵守 `.gitignore`，而这类 job tmp 目录里绝大多数是被忽略的测试日志——**照着「优先用 fd」的偏好而漏掉 `-I`，就会拿约三分之一的样本去做处置决定**，且漏掉的恰恰是没人复核过的那些行。枚举必须用 `find`，或 `fd -H -I`，并用第二种方法交叉核对总数。
- **一次观测（测于 `cafa89a6` 那一刻，之后会漂）**：`find . \( -type f -o -type l \)` = 174，`fd -H -I` 交叉核对同为 174，而 `fd -H` 不带 `-I` 只报 64。
- **清单**：[2026-08-10-batch2b-closeout-tmp-manifest.md](2026-08-10-batch2b-closeout-tmp-manifest.md)（原件在 job tmp，已复制进仓库——job 目录会到期回收，留在那里的引用会悬空），**175 条表格行**（文件 183 行，另含标题与说明）；表格里包含它自己那一行——`find` 在 shell 创建空输出文件之后才枚举。
- **零删除**：每一行的长期价值都已有**已提交的**载体，删除时机毁不掉唯一副本；目录留给 harness 到期回收。载体是逐个打开确认的，不是靠 `git status` 干净推断的。
- 唯一需要长期保存的探针结论（只读连接上的 DDL 行为）已在进度文档正文，脚本本身可弃。

---

## 5. 独立评审结论

评审报告原件（均已复制进仓库，job tmp 会到期回收）：
- 非文件教训双向对账（三轮）→ [2026-08-10-batch2b-closeout-review-reconciliation.md](2026-08-10-batch2b-closeout-review-reconciliation.md)
- 目录绑定 V4/V5 审计 → [2026-08-10-batch2b-closeout-review-cwd-audit.md](2026-08-10-batch2b-closeout-review-cwd-audit.md)

| 评审 | 轮次 | 结论 |
|---|---|---|
| Batch 2b 代码/测试（两位独立评审） | 4 轮 | 0 blocker / 0 major（合并前已闭合） |
| 收尾的非文件教训双向对账 | 3 轮 | 第三轮 **未闭合 0 条**；其指出的 1 处新引入过强断言已在 `40c8bf77` 修正 |
| 目录绑定 V4/V5 独立审计 | 1 轮 | **V4 证伪**（153 条违规）；**V5 未观察到** |
| 本报告终审（异视角，双方向查 false-green / false-red） | 1 轮 | **0 blocker / 3 major / 4 minor**，全部已修（见下） |

**终审查出的 3 条 major 都在本报告自身**，且都是「读者按报告去核验会扑空」型，值得留在这里而不是悄悄改掉：

1. 提交表里 6 个哈希有 2 个**在任何 ref 上都不可达**——分支被 rebase 过，哈希改写了。已换成 master 上的真实哈希，并加了重算命令。
2. 三行沿用证据锚在 `b2444a17`，而那次全档运行的原始记录在 **`42bdc6aa`**；`b2444a17` 又并入 14 个提交，其中改了 `package-boundaries.unit.test.ts`。已改锚点 + 靶向补跑。
3. 两份 skill 自验记录被列进「已实施」，实际当时**尚未提交**、只活在脏工作树里。已提交（`19efdea`）并补出 `~/.claude` 侧对账。

反方向（false-red）终审逐条核后**未发现**：没有把已做到的事写成未做。

**对账过程本身产出了两条值得记的东西**：

1. **作者自查清单漏了 17 条**（15 列 vs 独立枚举后补 17）。漏的集中在变异记录的**粒度**——原文写「六份都能变红」，读起来像证据，却重建不了任何一条。
2. **评审的否定性断言不能照单全收。** 第一轮判「作者声称的 `erasableSyntaxOnly` 事件查无此事」，我据此删掉了记录；第二轮它自己找到了出处（JSONL 2775 的 TS1294）并推翻前判。判据已写进进度文档：**否定性断言（「查无此事」「无消费者」）的证据是「我没找到」，而搜索范围是它自己选的**，与它的肯定性发现不是一个档次。

---

## 6. 可复用资产

### 已实施

| 资产 | 类型 | 内容 |
|---|---|---|
| `methodology-full-suite-red-classify-before-pollution-playbook` | 记忆（扩充） | 第四类：一次 runtime 崩溃整体抬高档位失败计数；动作前移为「先读失败名单、别读失败计数」 |
| `methodology-verify-the-mutation-actually-applied` | 记忆（扩充） | 第四种「没变红」：变异顺手拆掉了断言依赖的负载，于是**更容易绿**；相对判据须给被比较那一侧独立正控 |
| `closing-a-development-session/verification-log.md` | skill 自验记录 | V9、`discover_nonfile_candidates` 第三次实战、doc-sync 检查的确认票，及一条 heredoc 触发命令护栏的摩擦记录 |
| `proving-where-a-command-ran/verification-log.md` | skill 自验记录 | V4 证伪记录 + tally 重算（同一次编辑内完成，符合该日志要求） |

两份自验记录已提交为 `~/.claude` 的 `19efdea`。

### 建议、未实施（需用户裁决）

- **V4 被证伪后的既定后果是「升级为 harness／hook 级机械约束」**，且该协议明写**不是**往规则里加字。这会改动用户的全局配置，属用户决定，故只记录不实施。相关证据全在 `proving-where-a-command-ran/verification-log.md` 的 2026-08-10 条目。

---

## 7. 剩余事项

**没有阻塞项。** 以下都是可选的：

1. **两棵已合并的 worktree 是否移除** —— `.worktrees/history-worker-batch-2a`、`.worktrees/docsync-batch2b`。**移除前请自己跑这两条判定，别读本句的断言**（本文档第 3 节同理；写下时为真的状态声明会过期，而读到这里的人正要据它决定要不要删目录）：

   ```
   git -C <worktree 路径> status --short          # 必须为空
   git branch --merged master | rg 'history-worker-batch-2a|docsync-batch2b'
   ```

   两条都满足时，移除不会丢任何 git 救不回的东西。
2. **V4 的既定后果是否执行**（见第 6 节）。
3. **已登记的暂缓项**（不属本批范围，都在 `docs/todo/deferred-backlog.md`）：`/api/status` 与 metrics 仍上报 `backend: "legacy"`；semantic-write 架构守卫按**拼写**而非能力匹配；`test:it` 的 5 条既有失败（`durability-overlay`、`history-api` ×3、`clearHistory`），已用只读基线 worktree 确认与本批无关。
