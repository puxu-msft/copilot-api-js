# 指令文本评审：SKILL.md §3b（job tmp 逐文件对账）+ V19

对象：`.claude/skills/session-closeout/SKILL.md` §3b（45-63行）与 V19（208行）。
分支 tip：b4a4ac25（commit `docs: reconcile job tmp artifacts before cleanup`）。
方法：假装是未来收尾会话，对每个动作实地核验仓库；每条按 5 问逐一核验。

（逐条追加中）

## 发现 1（阻断级）：master 主线已独立演化出更成熟的 §3b/V19，本分支版本是平行分叉，合并时会产生冲突且本分支版本更弱

- 核验：`git log --oneline --all -- .claude/skills/session-closeout/SKILL.md` 显示 master 侧独立有 `0947b2f0`（18:21）→`24528e0d`（19:25）→`afbf6fd5`（19:35）三次演进，本分支 `b4a4ac25`（20:11）晚于三者但**不是**它们的后代（`git merge-base --is-ancestor` 双向均为 no）——两条历史真分叉，不是先后关系。
- master 最终版本（`git show master:.claude/skills/session-closeout/SKILL.md`）比本分支版本**多两处关键加固**：① 触发时机从「先提交载体与清单，验证进了主线，再按精确路径逐项删」升级为「枚举 → 逐项 disposition → 持久化／提炼 → 提交并验证接收载体 → **清单本身过独立评审** → 清理精确路径 → **重新枚举**」，并明写「清单必须先经独立评审达到 0 blocker／0 major 才可执行删除」；② 补上本分支版本没有的自愈条款：「清理前复扫发现的新文件必须先补 disposition，**并且使先前那次评审结论作废**：更新后的完整清单要重新达到 0 blocker／0 major 才能继续删除」。本分支版本（45-63行）**没有**这条"新文件使旧评审失效"的机制，也没有"重新枚举"这一步。
- **接手方会做的错误动作**：这条分支迟早要合回 master（KICKOFF 类文档已把它当"本轮交付"处理）。合并时 `.claude/skills/session-closeout/SKILL.md` 的 §3b/V19 段会产生**语义冲突**（同一小节标题、不同内容），接手方要么盲目选一边（多半选本分支版本因为它是"当前改动"）从而**丢失 master 已加固的"清单评审失效重触发"安全机制**，要么手工三方合并却不知道 master 那条修复是为了堵一个真实漏洞（"清理前新增的一行最容易被自己判成可删"）。这不是"文档措辞冲突"的普通合并 noise，是**同名安全机制两个版本谁赢的实质裁决**，且本分支版本本身没有对账过 master 的这两次加固——它是在 master 未同步的旧基线上写的。

## 发现 2（Major）：本分支 §3b 步骤 1 的枚举命令，在当前运行时的字面形态下无法照抄执行

- HANDOVER 式动作 1 写：`find "$CLAUDE_JOB_DIR/tmp" -maxdepth 2 -printf '%y %10s %TY-%Tm-%Td %p\n' | sort -k4`。
- 实测：把 `$CLAUDE_JOB_DIR` 变量展开与管道组合成一条命令时，Bash 工具报「worktree-isolated session ... too complex to verify that it stays inside the worktree」并拒绝执行；把路径写成字面绝对路径（`/home/xp/.claude/jobs/14d4ecd1/tmp`）则可正常跑通并输出全部 46 项（含 3 个一次性 git 仓库）。
- **接手方会做的错误动作**：接手方在隔离 worktree 里（本 skill §3b 的典型运行环境）照抄这条命令会被工具拒绝，若不知道"变量展开+管道"是触发点，会误以为 `$CLAUDE_JOB_DIR` 未设置或目录不存在，转而去调查环境变量配置——而真实原因只是命令形态需要拆成"先 `echo $CLAUDE_JOB_DIR` 拿到字面路径，再用字面路径跑 find|sort"。文档没有提示这一步在隔离 worktree 会话里可能需要拆分命令。

## 发现 3（Minor）：V19「连续 3 次零保留」是提示句而非可判定门槛，且与 V19 判据本身矛盾

- V19 证伪列写：「长期连续判定『全部可清理』——**可能是真的，但连续 3 次零保留就要检查是不是把探针/脚本一律当临时文件**」。
- 这句话结构上是"观察到长期零保留，请人工複核"，不是"满足 N 次即证伪"的机械门槛——它自己承认"可能是真的"，所以连续 3 次零保留本身**不构成**判据命中，只是触发复核的提示。这与 V19 前两项证伪形态（①未枚举 ②清理发生在提交/可达之前）是**清晰的红/绿二元判据**不同类。
- 本次实测（本 job `14d4ecd1`）恰是一个反例：`docs/tmp/2026-08-08-header-deadline-job-tmp-reconciliation.md` 里的判定是 5 项保留 + 22 项可清理，不是全零保留，所以此次不会误触发这条提示——但文档没说清楚「零保留连续 3 次」时下一步该做什么（重新审查全部三次的判定书？还是只审最近一次？），执行动作未定义。

## 与既有 §3（exp/ 归档）、V7（闭环提交时点）的重复/冲突核查

- 三处都讲"`cp` 进 `exp/` 因 gitignore 被判定为已归档"的假绿，且都指向同一条 `.gitignore:27` 的 `exp/`：§3 第 63 行、V7（197行）、本次 `job-tmp-reconciliation.md` 第 19 行的附带发现。核对内容：三处**表述不同但结论一致**，没有互相矛盾。§3 讲的是「归档动作本身要不要 `-f`」，V7 讲的是「闭环提交时点的机械核验三件套」，本次新增文档只是复用同一个已确认的坑作为脚注——是**同一裁决在三个语境下的合理复述**，不构成需要合并的重复（按 `one-authority-allows-contextual-restatement`），也没有互相矛盾。
- §3b 与 §3、V7 在"目标对象"上不重叠：§3 管 plan/exp 产物本身要不要迁移，V7 管"迁移+闭环提交"这一动作的机械核验，§3b 管一个新对象（`$CLAUDE_JOB_DIR/tmp`）的对账流程——三者互补不冲突。

## 结论

1. §3b 四步「可照做」，但步骤 1 的字面命令在当前隔离 worktree 运行时需要拆分才能跑（发现 2）；「保留/可清理」二选一本身写了明确反例条款（"我觉得没用"不是依据、"不可变替代证据"+"可重新生成"两项都要），没有留"看起来没用就删"的口子——这条设计得当。
2. §3b 步骤 4 的顺序门本身**可机械判定**（`git cat-file -e master:<路径>` 是客观二元结果），但**判官是自评的**——是否已提交、是否可达由执行者自己跑命令自己看，没有外部见证；master 演进版已经补上"清单先过独立评审、评审后新增内容使结论失效"这道外部裁决门，本分支版本还停在自评阶段（详见发现 1）。
3. V19 三项观测中前两项可判、第三项（连续 3 次零保留）是提示句非判据，会不会 false-red 取决于读者是否把它误当成硬性阈值——本次实测数据（5 保留/22 可清理）不落在该提示的触发条件里。
4. 新增段与既有 §3/V7 不重复不冲突，是合理的语境复述。
5. **最大的问题不是措辞把个案写成普遍规律，而是本分支版本本身已经是被 master 追平并超越的旧稿**——先合并/对账 master 的三次加固，再谈这份分支文档是否还有必要独立存在，是本发现清单里最先要做的事（发现 1）。

---

## 整改与处置（2026-08-08 补记，作者方记录）

⚠️ **先说这份补记为什么存在**：上面三条发现在会话内被整改后，我派了复评、复评在返回正文里给了 PASS，**但那次复评结论从未落盘**。于是磁盘上唯一的持久记录仍是「1 阻断级 + 1 Major + 1 Minor」，而我却在 `docs/tmp/2026-08-08-header-deadline-job-tmp-reconciliation.md` 与 `verification-log.md` 的 V19 里写成了「两份独立评审均判 0 blocker／0 major」。**该断言当时没有任何持久证据支撑，已由终审 reviewer 证伪并在两处更正。**

**可核事实只到这条失效链为止**：复评结论未落盘 → 磁盘上唯一持久记录仍是 1 阻断级 + 1 Major → 两处出现了无持久证据支撑的通过性断言。这条链命中了项目既有教训「结论一律落盘绝不只活在对话里」（→ `docs/memory/feedback-conclusions-must-land-in-docs-not-chat.md`）。**但「命中某条教训」不等于「已证明这是唯一根因」**——认知层面为什么会写下那句话，没有产生点标签，不作断言（→ `docs/memory/methodology-abort-provenance-tag-at-source-not-guess-at-boundary.md`：没有 source tag 就只写已排除什么，不写真因是什么）。

下面只记**我的处置 + 此刻可独立核验的证据**，不复述那次未落盘的复评正文。

⚠️ **2026-08-08 晚些时候的后续事实——下表三处 `SKILL.md:<行号>` 引用已需改锚**：`e7a9cadb` 按**用户裁决**（「不保留两个收尾入口」）退役了项目 skill `session-closeout`，`.claude/skills/session-closeout/SKILL.md` 已从主线删除。本分支在合并该退役时**接受了删除**（不复活被用户裁掉的入口）。因此下表的行号要按删除前的最后一个包含它的提交读：

```
git show 553985f4:.claude/skills/session-closeout/SKILL.md
```

三处内容当前的归宿（逐条核过）：

| 原引用 | 内容 | 现在在哪 |
|---|---|---|
| `SKILL.md:49` | 枚举 → disposition → 持久化 → 提交并验证载体 → 清单过独立评审 → 清理 → 重新枚举；清单须 0 blocker/major；复扫新文件使旧评审作废；禁通配 | **已泛化进全局 skill** `closing-a-development-session/SKILL.md`（`:137`／`:205`／`:209`），且比原版更完备（枚举扩到文件+符号链接、两个 temp 根取并集、事后复列） |
| `SKILL.md:51` 前半 | 隔离 worktree 里**变量展开 + 管道**被工具判为 `too complex` 而拒绝执行 | ⚠️ **无归宿**：两个全局 skill 均零命中。见下方「未安置项」 |
| `SKILL.md:51` 后半 | `-maxdepth 2` 与顶层项数不是同一个量 | V19 正文，随 log 迁入 `docs/archive/2026-08-08-session-closeout-verification-log.md`（写全了 42／48／49 三口径） |
| `SKILL.md:205` | V19 行本身 | 同上，已迁入该 archive |
| （§3 的 `exp/` gitignore 假绿） | `cp` 进 `exp/` 后 `git status` 仍干净 | 机械判据在全局 `writing-handover-docs/SKILL.md:227`（H10 三谓词）；本项目实例在 `docs/tmp/2026-08-08-header-deadline-job-tmp-reconciliation.md:19` |

**未安置项（提请裁决，未自行处置）**：「隔离 worktree 会话里，`Bash` 对**变量展开 + 管道**的组合会拒绝执行并报 too complex；换字面绝对路径即可跑通，别误读成环境变量没设」——这是 harness 事实，本会话实测撞到两次。它的自然归属是 user-level skill `proving-where-a-command-ran`（该 skill owns Bash 工具在隔离树下的行为），但那是用户的全局配置且属指令文本，需评审，故**不自行写入**，在此登记。

| 发现 | 处置 | 此刻可核验的证据 |
|---|---|---|
| **发现 1（阻断级）** 本分支 §3b/V19 是被 master 追平并超越的旧稿 | 按发现建议做**并集合并**（不是二选一）：master 的顺序门与两条安全机制全部采纳，本分支独有的三个实测坑保留 | `.claude/skills/session-closeout/SKILL.md:49` 含 master 的「枚举 → 逐项 disposition → 持久化 → 提交并验证载体 → 清单过独立评审 → 清理 → 重新枚举」全序，以及「清单须 0 blocker/major 才可删」「复扫新文件使先前评审作废」「禁通配/自动清理绕过」。**第三方佐证**：终审 reviewer 在 `2026-08-08-header-deadline-final-merge-review.md` 的 C5 独立比对后确认「merge 增加 master 的独立评审／复扫失效门，同时保留 feature 的枚举坑」，并以 `git show --remerge-diff` 确认无手工吞改 |
| **发现 2（Major）** §3b 步骤 1 的枚举命令在当前运行时无法照抄 | 采纳，写进正文 | `SKILL.md:51` 明写「隔离 worktree 会话里**变量展开 + 管道**的组合会被工具判为 too complex 而拒绝执行，换字面绝对路径即可」，并警告别误读成环境变量没设。（另有一条**作者动作自述、不作为复评证据**：本会话两条复合命令被守卫拒绝过——无持久输出，事后不可独立核验） |
| **发现 3（Minor）** V19「连续 3 次零保留」是提示句非判据 | 随 V19 采用 master 版本措辞而消解 | `SKILL.md:205` 的 V19 行已无该措辞；`grep '零保留' SKILL.md` 零命中 |

**仍然成立的边界**：本文件记录的是**指令文本强度**的评审，它的发现不针对本次 job tmp 清理的**判定正确性**——后者由事实视角评审（0 blocker／0 major／3 minor，minor 已于 `548e3cf2` 修正）授权。这两件事此前被我合并成一句「均 0／0」，是错的；现在分开陈述。

## 更正：commit `7af27044` 的提交信息含一处错误断言

该提交的消息末尾写了「baseline 的 `runner_git_blob` 仍 pin `66d215f2`，而 runner 已被改成 `9998d99d`，producer 门在此之前就会 fail(4)」。**这句是错的**，由第二轮复评证伪、我已独立复核：

- `scripts/capture-entry-evidence.ts:264` 明确定义 `runnerBlob = git rev-parse <entrySha>:scripts/parallel-test.ts`——**pin 指的是 `scripts/parallel-test.ts`，不是 `exp/inter-block-anchor-allocator/baseline-runs.sh`**（后者是 `:280` 的 `wrapper`，另一个对象）。
- 实测 `git rev-parse HEAD:scripts/parallel-test.ts` = `66d215f2…`，**与 pin 完全一致**，pin 没有陈旧。

我的错误形态：看到 `:280` 附近的 `wrapper` 变量就认定它是「runner」，没有回读 `:264` 那行定义——**从邻近的符号名推断，而不是打开定义**。

**更正后的状态**：① 「producer 门因陈旧 pin 而硬红」这一说法作废；② 我**没有**跑过 producer，因此也**不声称**它是绿的——`fail(4)` 是否发生取决于 `parallel-test.ts` blob 与 files discovery 的实际比较结果，应在最终 merge 态直接运行、以实际 rc 裁决；③ 「不代改 peer 在飞的 gate 文件」这一处置**仍然恰当**，但理由改为「master 仍在前进、同批 evidence 文件持续变化、没有冻结的目标终态」，不再是那个错误的陈旧-pin 理由。

commit 消息属已落地历史，共享分支不 amend（见 CLAUDE.md 并发会话纪律）；本节即该错误断言的更正记录。

**未闭合项**：这份处置由作者自记，尚未经独立 reviewer 复核。
