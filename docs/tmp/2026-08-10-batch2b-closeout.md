# History Worker Batch 2b —— 收尾报告（2026-08-10）

**读者**：想知道「Batch 2b 到底交付了什么、证据在哪、还剩什么」的下一个人。不必读会话记录。

**一句话**：Batch 2b（semantic 写连接迁入 Worker 线程）已完成并合入本地 `master`（合并提交 `b2444a17`）；**未推送**。本次收尾在它之上又修掉了 5 处陈旧活文档、补齐了一份变异台账、并记录了一条被独立审计证伪的目录绑定规则。

---

## 1. 交付内容与落点

| 内容 | 落点 |
|---|---|
| Batch 2b 生产改动（Worker 独占 semantic 写连接、主线程只读句柄、启动 deadline、生命周期串行队列 + 事务式 bring-up） | 已在 `master`，合并提交 `b2444a17` |
| Batch 2b 进度真相源（剩余项、在途意图、已作废路线、四轮评审处置、**变异台账**） | [docs/tmp/2026-08-09-history-worker-progress-impl-2b.md](2026-08-09-history-worker-progress-impl-2b.md) |
| 两份独立评审报告 | [2026-08-09-batch2b-review-gpt.md](2026-08-09-batch2b-review-gpt.md)、[2026-08-09-batch2b-review-testing.md](2026-08-09-batch2b-review-testing.md) |
| 活的架构现状（当前活路径的权威） | [docs/DESIGN.md](../DESIGN.md) 的 `src/lib/history/` 行 |
| 模块契约（写路径 / drain-before-close / DB 维护 / 迁移） | [docs/history.md](../history.md) |
| 关机顺序 | [docs/lifecycle.md](../lifecycle.md) |
| 暂缓项（pin/unpin 503 窗口、`backend: "legacy"` 上报、守卫按拼写匹配、5 条既有 `it` 失败） | [docs/todo/deferred-backlog.md](../todo/deferred-backlog.md) |

### 本次收尾产生的提交（均已 fast-forward 进 `master`，均未推送）

| 提交 | 内容 |
|---|---|
| `eb714fdf` | DESIGN.md 请求流程第 8 条 + history.md 四段：写路径 / drain-before-close / DB 维护 / 迁移 runner 的线程归属订正 |
| `5bb8e436` | lifecycle.md 关机第 3 步仍在排空「主线程 V3 writer」 |
| `51927a0d` | 记忆：全套件红的第四类——一次 runtime 崩溃整体抬高失败计数 |
| `cafa89a6` | 进度文档新增「收尾对账补录」：变异台账、被证伪的归因、范围/解析错误、标定值、能力探针 |
| `b8c257e6` | 按第二轮对账修正上一条里我自己的四处过强/错误断言 |
| `f7741bd0` | 记忆：变异的第四种「没变红」解释；并收窄 summary-backfill 那条的范围 |

---

## 2. 验证证据

**口径**：按 CLAUDE.md「同一交付合并后不因『刚合并』主动重跑全量测试」，Batch 2b 的全量证据**沿用**合并态那次；本次收尾**只改文档与记忆**，故另跑针对文档的守卫。每项都标明是沿用还是本轮新跑。

| 项 | 命令 | 结果 | 来源 |
|---|---|---|---|
| 全后端门禁 | `env -u RUN_PERF_TESTS bun run test:backend` | 合并态 **0 fail** | **沿用**，测于 `b2444a17` |
| 构建 | `bun run build:backend` | exit 0 | **沿用**，测于 `b2444a17` |
| 类型 | `bun run typecheck` | 绿 | **沿用**，测于 `b2444a17` |
| 文档树 L1 守卫 + Worker 边界守卫 | `env -u RUN_PERF_TESTS bun test tests/infra/design-doc-tree.unit.test.ts tests/architecture/history-worker-boundaries.unit.test.ts` | **14 pass / 0 fail** | **本轮新跑**，在合并后的主检出上、`51927a0d` |

**总数不可引用**：同树同 commit 连跑 `test:backend` 的测试总数会变（见 CLAUDE.md），只有 `0 fail` 是判据。要复现请在仓库根跑上表命令，不要引用任何历史快照数字。

---

## 3. 分支 / worktree / 发布状态

- **未发布。** 全程没有 `git push`、没有建 PR、没有发布产物。`git status --short --branch` 显示本地 `master` 远超 `origin/master`（具体条数请自行跑该命令，不要引用快照）。
- **分支**：`history-worker-batch-2a`（`b2444a17`）与 `docsync-batch2b` 均已被 `master` 包含，`git branch --merged master` 可验证。
- **worktree**：`.worktrees/history-worker-batch-2a`、`.worktrees/docsync-batch2b` 均 `git status --short` 干净、HEAD 均可从 `master` 达。满足移除前提，**是否移除留给用户**（见第 7 节）。
- **同伴 WIP 未受影响**：主检出里有若干条属于并发会话的未提交改动，本次全部合并均为 fast-forward，逐次核对过它们没有被卷入。收尾期间 `master` 被同伴推进过多次，每次都用 rebase + `--ff-only` 重新对齐，未产生合并噪音。

---

## 4. 临时状态处置

- **枚举**：`find <job tmp> \( -type f -o -type l \)` = **174**，`fd -H -I --type f --type l` 交叉核对同为 174。**`fd -H` 不带 `-I` 只报 64**——`fd` 默认遵守 `.gitignore`，该目录里约 130 个测试日志几乎全被吞掉；照着「优先用 fd」的偏好而漏掉 `-I`，就会拿 37% 的样本去做处置决定。
- **清单**：`<job tmp>/manifest.md`，175 行（`find` 在 shell 创建空输出文件之后枚举，故比 174 多它自己一行）。
- **零删除**：每一行的长期价值都已有**已提交的**载体，删除时机毁不掉唯一副本；目录留给 harness 到期回收。载体是逐个打开确认的，不是靠 `git status` 干净推断的。
- 唯一需要长期保存的探针结论（只读连接上的 DDL 行为）已在进度文档正文，脚本本身可弃。

---

## 5. 独立评审结论

| 评审 | 轮次 | 结论 |
|---|---|---|
| Batch 2b 代码/测试（两位独立评审） | 4 轮 | 0 blocker / 0 major（合并前已闭合） |
| 收尾的非文件教训双向对账 | 3 轮 | 第三轮 **未闭合 0 条**；其指出的 1 处新引入过强断言已在 `f7741bd0` 修正 |
| 目录绑定 V4/V5 独立审计 | 1 轮 | **V4 证伪**（153 条违规）；**V5 未观察到** |

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

### 建议、未实施（需用户裁决）

- **V4 被证伪后的既定后果是「升级为 harness／hook 级机械约束」**，且该协议明写**不是**往规则里加字。这会改动用户的全局配置，属用户决定，故只记录不实施。相关证据全在 `proving-where-a-command-ran/verification-log.md` 的 2026-08-10 条目。

---

## 7. 剩余事项

**没有阻塞项。** 以下都是可选的：

1. **两棵已合并的 worktree 是否移除** —— `.worktrees/history-worker-batch-2a`、`.worktrees/docsync-batch2b`。两者都干净、HEAD 都在 `master` 里，移除不会丢任何 git 救不回的东西。
2. **V4 的既定后果是否执行**（见第 6 节）。
3. **已登记的暂缓项**（不属本批范围，都在 `docs/todo/deferred-backlog.md`）：`/api/status` 与 metrics 仍上报 `backend: "legacy"`；semantic-write 架构守卫按**拼写**而非能力匹配；`test:it` 的 5 条既有失败（`durability-overlay`、`history-api` ×3、`clearHistory`），已用只读基线 worktree 确认与本批无关。
