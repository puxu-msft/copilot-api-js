# Task 37 收尾终报草稿 —— 接手方第一人称走查评审

- **评审对象**：`/home/xp/src/copilot-api-js/.claude/worktrees/encapsulated-kindling-forest/docs/tmp/2026-08-10-task37-closeout-terminal-report.md`
- **评审视角**：假装我明天接手、完全没见过这轮工作。对报告让我做的每一个动作，实地去仓库查那个承载者是否存在、长什么样。
- **每条发现都带「接手方会因此做出什么错误动作」栏**；没有这一栏的不计为发现。

## 环境事实（本次评审的锚）

```
$ pwd -P
/home/xp/src/copilot-api-js/.claude/worktrees/encapsulated-kindling-forest

$ git rev-parse HEAD
53efd301846745c139d3497668f2538533fd3258

$ git rev-parse --abbrev-ref HEAD
worktree-encapsulated-kindling-forest

$ git rev-parse master
d2f66fa99b27b219cca4204465e86c477a075374
```

与派活说明一致：HEAD = `53efd301`，master = `d2f66fa9`（与报告第 4 行的核验基线相符）。

> 方法说明：本会话受 worktree 隔离护栏限制，不能用 `git -C /home/xp/src/copilot-api-js` 直接访问共享检出。对 master 的核验全部改用同一 object database 的 `git show master:<path>` / `git ls-tree -r master`——等价且更严格（读的是 master 的提交树，而不是共享工作区里可能带 peer WIP 的文件）。

---

## 发现

（逐条随证据闭合追加，最严重在前）

### B1 [BLOCKER] 报告自身与它宣称的账本修正都**不在 master**，而报告通篇让接手方以为收尾产物已经落地

**报告怎么说**（第 5–6 行、C4、C13、第 1 节）：

- 第 5 行：「本会话工作树：`.claude/worktrees/task37-closeout`（分支 `worktree-task37-closeout`，**已 ff 合入 master**，目录保留）；本报告在 `.claude/worktrees/encapsulated-kindling-forest` 写就」
- 第 6 行：「发布状态：**全部提交都是本地的、未推送**」——唯一提到的「未落地」维度是「未推送」。
- 第 1 节 22 行：「**已在本轮把账本那句替换成同一条命令**（见第 2 节 C13）」
- C13 取值方式栏：「**新鲜**；同时据此修正了账本第 22 行原先的 "six … and two …"」

**实地核验**：

```
$ git merge-base --is-ancestor 53efd301 master
NOT-IN-MASTER                       # 本报告所在的提交不在 master

$ git ls-tree -r --name-only master | grep '2026-08-10-task37'
（无输出，exit 1）                   # master 树里根本没有这份终报

$ git show master:.superpowers/sdd/progress.md | sed -n '22p' | grep -o 'six accumulator feeds and two translators'
six accumulator feeds and two translators   # 账本的错数字**原样还在 master 里**

$ git show master:.superpowers/sdd/progress.md | grep -c '13 call sites across 12 files'
0                                    # 修正后的措辞在 master 里不存在

$ git show --name-status 53efd301
M	.superpowers/sdd/progress.md
A	docs/tmp/2026-08-10-task37-closeout-terminal-report.md
```

即：`worktree-task37-closeout` 确实 ff 合进了 master（C4 成立，master = `d2f66fa9`），**但报告自己和账本修正是在那之后、在另一棵树 `encapsulated-kindling-forest` 上提交的 `53efd301`，这个提交至今没有合回 master**。报告把「合并已完成」写在第 5 行，把「本报告在另一棵树写就」写成一句括号内的环境说明（理由是「后台隔离护栏不允许直接写共享检出」），**从未说明这一支的合并状态**。

**接手方会因此做出什么错误动作**（三条，各自独立成灾）：

1. **接手方在 master 上找不到这份终报，因而根本不会读到它。** 报告是 Task 4 owner 的唯一入口文档，而 master 的 `docs/tmp/` 里只有 `2026-08-09-*` 那批过程件。接手方按 CLAUDE.md 的收尾约定去 `docs/tmp/` 找终报，会得出「Task 37 没写终报」的结论，进而**重做一次收尾**或**在没有终报的情况下开 Task 4**。
2. **接手方读 master 的账本，会拿到那个已被本轮证伪的错数字。** 账本第 22 行仍写 "six accumulator feeds and two translators"（=8）。接手方在 Task 4 里要判断 `anthropicWireFrameType` 原语的采纳面时，会按 8 个站点去核对，**漏掉 5 处**——这恰好是本轮第 5 节第 4 条「站点枚举漏了 5 处」的同一个坑，原样留给了下一个人。报告第 1 节明确宣告「已在本轮把账本那句替换成同一条命令」，接手方没有任何理由去怀疑 master 的账本还是旧的。
3. **接手方若做「收尾是否完成」的判定，会判成已完成。** 报告第 6 行把发布状态的全部内容归结为「未推送」，暗示除推送外一切已落地。实际还差一次 `merge --ff-only`（或等价合并）。CLAUDE.md 的 `docs-merge-before-execute` 要求定稿文档先合主线再谈执行——这条**当前不满足**，而报告读起来像满足了。

**修复建议**：在报告顶部的状态块里加一行，与「未推送」并列且**同等醒目**：「本报告与账本第 22 行的修正提交在 `worktree-encapsulated-kindling-forest` 的 `53efd301`，**尚未合入 master**；合入前 master 的账本仍带旧数字」。并给出可自证的判定命令（而不是写一个会过期的状态词）：

```bash
git merge-base --is-ancestor 53efd301 master && echo merged || echo NOT-merged
git show master:.superpowers/sdd/progress.md | grep -c '13 call sites across 12 files'   # 期望 1
```

顺带：C4 的措辞「收尾产物分支已 ff 合入 master」应限定为「**代码交付与 2026-08-09 那批收尾产物**已合入」，因为「收尾产物」在读者眼里天然包含终报本身。

### B2 [MAJOR→接近 BLOCKER] `verification-log.md` 欠账被写成一个「读者自己去判」的条件句，而实际答案是**两份都没写**，且报告没给路径

**报告怎么说**（第 79 行）：

> **`verification-log.md` 欠账**：本次收尾结束须给 `closing-a-development-session` 与 `proving-where-a-command-ran` 两份日志各追加可观察到的 claim 行。**报告发出时若尚未写入，此条即未完成。**

**实地核验**：

```
$ ls -la /home/xp/.claude/skills/proving-where-a-command-ran/verification-log.md
-rw-r--r-- 1 xp xp 29996 Aug  7 08:21 …/verification-log.md      # 本轮（8-09/8-10）完全没动过

$ ls -la /home/xp/.claude/skills/closing-a-development-session/verification-log.md
-rw-r--r-- 1 xp xp 17987 Aug 10 05:51 …/verification-log.md

$ grep -n '^## 2026-08-10' /home/xp/.claude/skills/closing-a-development-session/verification-log.md
47:## 2026-08-10 · copilot-api-js shutdown keep-alive 503 closeout (…)
```

`closing-a-development-session` 的最后一段确实是 2026-08-10，但它属于**另一次收尾**（`shutdown keep-alive 503`，条目引用的 commit 是 `bcb9aa39` / `4245d832` / `8492beb2` / `1da12c58`），**没有任何一行属于 Task 37 收尾**；`proving-where-a-command-ran` 的日志则整轮未被触碰。

同时，该 skill 自己把这条写成硬义务：

```
$ grep -n 'verification-log' /home/xp/.claude/skills/closing-a-development-session/SKILL.md
300:… **After every closeout, append one line per claim you were able to observe to `verification-log.md` beside this file.** … **at the end of the closeout you just ran, not "later".**
```

**接手方会因此做出什么错误动作**：

1. **接手方大概率判成「已写」而跳过。** 条件句「若尚未写入，此条即未完成」把判定甩给读者，但报告**没给这两份日志的绝对路径**（它们在 `~/.claude/skills/<skill>/verification-log.md`，不在本仓）。接手方在 `docs/` 与仓库内 grep `verification-log` 会一无所获，最省力的解读是「作者写完报告时应该已经补了」，于是**这笔欠账被永久漏掉**——而它正是这两个 skill 唯一的实战证伪回路，漏掉意味着本轮撞出的 V-*（尤其「reviewer 改了工作树却报告没改」「收尾自身的产物就是污染源」这类新形态）**不会进入任何未来会话的视野**。
2. **反向风险同样存在**：若接手方去看 `closing-a-development-session/verification-log.md`，会看到最后一段确实是 `2026-08-10`，从而**误判欠账已还**——因为报告没说「要找的是 Task 37 那一段」，而当天已经有另一次收尾在同一份日志里留了段落。这是「已闭合/未闭合」判定被同日异事件污染的典型形态。

**修复建议**：把条件句换成**当下事实 + 绝对路径 + 判定命令**：

```
- 欠账（发报时状态：两份均未写入 Task 37 段落）
  - /home/xp/.claude/skills/closing-a-development-session/verification-log.md
    判定：grep -c 'Task 37' <该文件>            # 期望 ≥1，现为 0
    注意：该文件已有一段 2026-08-10，属 shutdown keep-alive 503 收尾，不是本轮
  - /home/xp/.claude/skills/proving-where-a-command-ran/verification-log.md
    判定：grep -c '2026-08-10' <该文件>          # 期望 ≥1，现为 0
```

并把本轮已具备的 claim 行内容（第 5 节 6/7 两条、`discover_nonfile_candidates` 六轮收敛、job-tmp 门的 427 口径）直接列进报告，让接手方**不必重建上下文**就能代写——否则这笔债只有原作者还得起，而原作者已经在写终报了。

---

### B3 [已核实闭合 —— 反方向确认，不是缺陷] 第 4 节的其余四类承载者**全部实地存在**

为了防止接手方重做已完成的工作，逐条正向记录：

| 报告第 4 节的条目 | 实地核验 | 结论 |
|---|---|---|
| backlog 新增 3 条 | `git show master:docs/todo/deferred-backlog.md \| grep -n '^## '` → 第 1428 行 native 产物、第 1438 行 entry-evidence skip 基线、第 1451 行 H2 块中途终态 | **已在 master**，勿重写 |
| gated 探针存在且确为 skip | `git cat-file -e master:tests/pipeline/i9-followup-midblock-error.http.test.ts` → 存在；该文件 `:64` = `describe.skip("[GATED — requires Task 4 owner cutover: the buffered terminal drain must drop frames past the last commit boundary] I9 follow-up probe — H2 error arriving MID-BLOCK …"` | **已在 master 且确为 `describe.skip`** |
| 该 skip 已登记进 entry-evidence 基线 | `git show master:tests/infra/entry-test-discovery-baseline.json \| grep -c 'requires Task 4 owner cutover'` → **2**（与 backlog 第 1408 行「一个 `describe.skip` 套件产出两条 skip identity」自洽） | **已登记**，且计数与文档一致 |
| native 产物过期是环境性、非代码缺陷 | backlog 第 1428 行条目含正样本对照（新构建树 28 pass / 0 fail）与失败用例名逐条对应 | **已闭合为 backlog**，勿当回归去改代码 |

这四条**不需要接手方做任何事**，报告在这一段是准确的。

---

### B4 [MAJOR] 第 6 节「复验配方」里 C5 那条命令**算的不是 C5**，接手方跑出来会看到一个完全不同、大得多的文件集

**报告怎么说**：

- C5（第 36 行）：「该合并的净效果只有 5 个文档文件、零代码改动」，取证方式写的是「合并后于**隔离树内** `git diff --name-status master HEAD`」。
- 第 6 节（第 106–107 行）给接手方的复验命令却是：

  ```bash
  # C5：本次合并的净效果
  git diff --name-status fe8977c0 master -- docs/ | head
  ```

**实地核验**——把配方原样跑一遍：

```
$ git diff --name-status fe8977c0 master -- docs/ | head
M	docs/API.md
M	docs/DESIGN.md
M	docs/coding-conventions.md
M	docs/lifecycle.md
M	docs/memory/feedback-fix-all-comparison-sites.md
M	docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md
M	docs/plan/2026-08-07-history-persistence-worker.md
A	docs/tmp/2026-08-08-entry-preflight-run1-failures.md
A	docs/tmp/2026-08-09-batch2b-review-gpt.md
A	docs/tmp/2026-08-09-batch2b-review-testing.md

$ git diff --name-only fe8977c0 master | wc -l
105          # 去掉 -- docs/ 限定后是 105 个文件，含大量 src/ 与 tests/ 改动
```

真正对应 C5 的口径是「收尾分支相对它自己的 merge-base 的净效果」：

```
$ git merge-base b5acce8f 71dcfb91
6d212286bcf6cbd7cb7c83f760d4ea37cd83ee73

$ git diff --name-status 6d212286 b5acce8f
M	docs/memory/feedback-fix-all-comparison-sites.md
A	docs/tmp/2026-08-09-task37-closeout-evidence-manifest.md
A	docs/tmp/2026-08-09-task37-closeout-review.md
A	docs/tmp/2026-08-09-task37-closeout-tmp-inventory.md
M	docs/todo/deferred-backlog.md
```

**恰好 5 个文档文件、零代码改动——C5 这条断言本身是对的**。问题只出在配方：`fe8977c0..master` 跨越了 **138 个提交**（其中 28 个是本次合并吸收的 peer commit），它测的是「代码交付以来主线发生了什么」，而不是「本次收尾合并带来了什么」。

**接手方会因此做出什么错误动作**：

1. **接手方会判定报告在撒谎，然后不再相信报告的其余部分。** 配方是报告主动交给读者的自证手段；跑出 `docs/API.md`、`docs/DESIGN.md`、`docs/lifecycle.md` 这些与 Task 37 毫无关系的文件，与「只有 5 个文档文件」的落差是数量级的。最省力的结论是「C5 是编的」，而 C5 恰恰是全表里少数几条真正无懈可击的。
2. **更坏的一支：接手方把这 105 个文件当成本次收尾的爆炸半径。** 里面有 `src/lib/history/*` 的十几处改动、一个文件删除（`src/lib/history/worker/legacy-terminal-sink.ts`）、`packages/cli/src/start.ts`。若接手方据此排查「Task 37 收尾为什么改了 History worker」，那是**纯浪费**，且可能反向去 revert 别人的交付。
3. **`| head` 让第 2 支更难自愈**：截断后连「这个集合明显不止 5 个」都看不全，读者更容易停在错误结论上。

**修复建议**：把配方换成能实际重算 C5 的形式，并把 merge-base 写成命令而非硬编码 SHA：

```bash
# C5：本次收尾合并的净效果（相对收尾分支自己的 merge-base）
BASE=$(git merge-base b5acce8f 71dcfb91)   # 6d212286
git diff --name-status "$BASE" b5acce8f    # 期望：恰好 5 行，全部 docs/，零 src/ 零 tests/
```

顺带核实：§3 `resolve_branch` 的「28 个 peer commit」**已复算属实**（`git rev-list --count b5acce8f..71dcfb91` → 28）。

---

### B5 [MAJOR] 报告宣布「Task 4 已解除阻塞」，却没给 Task 4 owner 任何一个可点击的入口——包括那条「只修 `failed` 会当场再犯一次」的警告

**报告怎么说**：

- C2：「Task 4 已解除阻塞」，证据栏只写「同上，账本第 21/23 行」。
- 第 4 节第 1 条：「**H2 块中途终态**仍是缺陷：正确修法要等 Task 4 的 owner cutover。已登记 backlog，探针以 gated skip 断言期望行为。」

**实地核验**——这三样承载者都存在，但**报告一个路径都没给**：

| 接手 Task 4 立刻要用的东西 | 实际位置（我 grep 出来的，不是报告给的） |
|---|---|
| Task 4 的计划正文 | `docs/plan/2026-08-07-mandatory-block-delivery-h2-observability/plan-1-sse-and-delivery-foundation.md:72`（`## Task 4：把现有 DownstreamDeliverySession 升级为 BlockDeliveryOwner`），同目录另有 `KICKOFF.md` |
| 同一 commit 的硬约束 | 同文件 `:67`「Task 4 切换 driver 直接消费 grammar outcomes 的同一 commit 才删除 compatibility projection；禁止出现『旧 projection 已删、新 owner 尚未接管』的中间提交」 |
| gated 探针（去掉 `.skip` 即为验收） | `tests/pipeline/i9-followup-midblock-error.http.test.ts:64` |
| 那条最贵的警告 | `docs/todo/deferred-backlog.md:1417`（master 为 :1451 起的条目）：「⚠️ **做 Task 4 时必须把 `incomplete` 与 `failed` 并列处理**——`adapters/responses.ts:17,:77-78` 显示 `incomplete` 同样是上游的终态决定；**只修 `failed` 会在同一位置再犯一次**」 |
| 为什么补丁式修法必然失败 | 同条目：`discard-open-unit` outcome 在 `src/` 里**零消费者**，grammar 的 `discardOpen()` 够不到 driver 缓冲区 |

**接手方会因此做出什么错误动作**：

1. **接手方只修 `failed`，不修 `incomplete`，在同一个位置把这个 bug 再犯一次。** 这是本轮花了三层试错才买到的结论，写在 backlog 里，而报告——Task 4 owner 最可能读到的那份文档——把它压缩成了「已登记 backlog」五个字。接手方要撞对这条，必须先想到去翻 1400 行的 backlog 并找对是哪一条。**报告没给行号、没给条目标题、没给文件路径。**
2. **接手方重走那条已被实测证否的修法。** 第 4 节只说「正确修法要等 Task 4 的 owner cutover」，没说「让 `acceptTerminal` 对 `semantic === "failed"` 发终态」这条路已经**实现过、A/B 测过、撤回过**。第 1 节第 24 行提到「一次被撤回的修复」，但它与第 4 节第 1 条之间没有互相引用，读者不一定把两处对上号。代价：重做半天，再自己发现半块泄漏。
3. **接手方不知道验收判据已经写好了。** 探针存在且断言的就是正确目标，「去掉 `.skip` 即可验收」这句写在 backlog 第 1419 行，不在报告里。不知道的人会**从零再写一遍验收测试**，而且大概率写得比现成那条弱（现成那条同时断言「不重试」与「不泄漏半块」两个方向）。
4. **反方向的浪费**：接手方会先去找「Task 4 到底有没有计划文档」。有——`docs/plan/2026-08-07-mandatory-block-delivery-h2-observability/`，四份 plan + KICKOFF + 两份 review。报告通篇没出现过这个目录。

**修复建议**：在第 4 节第 1 条下面加一个「Task 4 owner 起步清单」小表，把上面五行原样搬进去（路径 + 行号 + 一句话作用）。**这不是锦上添花**：报告自己把「解除阻塞」当成本轮的核心交付，那么「被解除阻塞的那个人拿到什么」就是这份交付的验收面。现在这一面是空的。

---

### B6 [MAJOR] C6 是全表唯一「新鲜」的测试证据，而它的日志指针用 `$CLAUDE_JOB_DIR` 写成，且报告自己已判该目录交由 harness 回收

**报告怎么说**（C6，第 37 行）：

> `bun run test:fast` … 于 `d2f66fa9`：`16 shards · 5471 tests · 5471 pass · 0 fail · 5471 executed · 3 skipped`，exit 0。**日志 `$CLAUDE_JOB_DIR/tmp/testfast-merged.log`**

而 §3 `clean_temp`（第 60 行）：

> **不删除**。… 理由：skill 允许「每个对象均有 disposition」时**交由 harness 回收 job 目录**

**实地核验**：

```
$ printenv CLAUDE_JOB_DIR
/home/xp/.claude/jobs/a7c2cc1a

$ ls -la /home/xp/.claude/jobs/a7c2cc1a/tmp/testfast-merged.log
-rw-r--r-- 1 xp xp 252 Aug 10 09:16 …/testfast-merged.log      # 当下存在，252 字节

$ grep -c 'CLAUDE_JOB_DIR' docs/tmp/2026-08-09-task37-closeout-evidence-manifest.md
0                                                               # 证据清单里没有这条日志的登记
```

**接手方会因此做出什么错误动作**：

1. **接手方把 `$CLAUDE_JOB_DIR` 展开成自己的 job 目录，在那里找不到文件，于是判「证据不存在」。** 新会话的 `CLAUDE_JOB_DIR` 是另一个 id；这条路径**只在写它的那个 job 里有意义**，而报告是写给别人读的。展开后落空，最省力的结论是「C6 无证据」——进而**重跑一次 `test:fast`**（本身无害，浪费几分钟），或更糟，**连带怀疑 C7 那条复用的全后端证据**并去重跑 `test:backend`（十几分钟起，且 CLAUDE.md 与 `moving-shared-head-is-not-failure` 明确说不该因合并而重跑）。
2. **即使接手方猜对 job id，文件也随时会消失。** 报告自己在 §3 写明该目录交由 harness 回收。一份终报把唯一的新鲜证据锚在一个**它自己安排了销毁的位置**，这是自相矛盾的：C6 的取值方式栏写着「**新鲜**」，但它的可复核期限比报告的阅读期限短。
3. **它没进证据清单。** `2026-08-09-task37-closeout-evidence-manifest.md` 里 `CLAUDE_JOB_DIR` 出现 0 次——所以「持久化证据」那一阶段并没有覆盖 C6 的日志，接手方也无法从清单里反查。

**修复建议**：二选一，都要做到「不依赖 job 生命周期」——① 把 252 字节的 tally 行**直接内联进 C6 的证据栏**（它就一行，没有理由用指针）；② 或把日志归档进仓库内（`exp/` 或 `docs/tmp/`）并给绝对路径。同时在 C6 里保留可重算命令 `bun run test:fast`，让接手方即使不信也能一条命令自证，而不是去追一个会蒸发的文件名。

---

### B7 [MINOR] 「backlog 新增 3 条（含 … 必踩的两条）」的括号让人以为 3 条里有 2 条是基线维护条目

**实地**：master 的 `docs/todo/deferred-backlog.md` 里本轮新增的三个 `##` 条目是——

- `:1428` native 产物「存在即可用」
- `:1438` entry-evidence 的 skip 基线把环境条件性 skip 当成无条件
- `:1451` 上游终态错误发生在块中途时仍被当截断重试四次

报告括号里的「两条」实际是第 2 条**内部的一个 ⚠️ 子项下的两个编号小点**（worktree 树 `:1408–:1411`），不是两个独立条目。

**接手方会因此做出什么错误动作**：去 backlog 里找两个关于「基线维护」的独立条目，只找到一个，怀疑有一条没提交（或怀疑自己找错文件），再花时间做一次全文比对。代价不大但纯属被措辞制造出来的。

**修复建议**：改成「backlog 新增 3 条（其中 entry-evidence 那条内含手工维护必踩的两个子项：…）」，并给条目标题而非只给序数。

---

### B8 [MINOR] `docs/tmp/2026-08-09-task37-closeout-review.md` 在 master 里（28 KB），报告通篇未提

C1 的证据栏列了六份评审报告，但 master 树里还有一份同期的 `docs/tmp/2026-08-09-task37-closeout-review.md`（`git ls-tree -r --name-only master | grep task37` 可见，28377 字节），它是**收尾产物本身**的评审。报告没有引用它。

**接手方会因此做出什么错误动作**：接手方若要判断「这轮收尾产物被谁审过、审出什么」，会以为只有第 1 节说的那四个 agent／六轮（那是**代码接缝**的评审），从而**重新派一轮收尾产物评审**——而那一轮已经跑过并落盘。反方向的浪费。

**修复建议**：在 §3 或 §1 加一行指向它，并说明它评的是收尾产物、不是代码接缝。

---

### B9 [INFO/正向确认] 以下引用逐个可达，接手方可以直接照用

| 报告里的引用 | 核验结果 |
|---|---|
| `.superpowers/sdd/progress.md` 第 22 行 = Task 37 条目 | ✅ 行号精确（`grep -n "Task 37 (Task 1b"` → 22） |
| 同上 第 21/23 行 = Task 3 / Task 4 | ✅ 行号精确（21 = Task 3，23 = Task 4，且 23 行确写 `**unblocked**`） |
| 六份 `docs/tmp/2026-08-09-task37-*.md` 评审报告 | ✅ 六份全部在 master 树内 |
| `src/lib/anthropic/wire-frame-type.ts` | ✅ 在 master 树内 |
| C3 `git merge-base --is-ancestor fe8977c0 master` | ✅ 退出 0；`fe8977c0` = `Merge branch 'master' into worktree-encapsulated-kindling-forest` |
| C4 `master = d2f66fa9` | ✅ `git rev-parse master` 完全一致 |
| C10 `~/.claude` 仓 `eb3ea6f` | ✅ `git -C /home/xp/.claude log --oneline -1 -- skills/positive-control-your-tests/SKILL.md` → `eb3ea6f skills(positive-control): close the other end of the "don't snapshot the diff" rule`；正文对应 §5 第 7 条（工作区 diff 导出补丁对未追踪文件为空） |
| §3「28 个 peer commit」 | ✅ `git rev-list --count b5acce8f..71dcfb91` → 28 |
| §3 清单「427 行」 | ✅ 文件 434 行 = 7 行头部注释 + 427 条路径；头部自声明 `# members: 427`，与正文自洽 |
| §4「N9 建议未实施」 | ✅ `/home/xp/.claude/skills/catching-false-green-tests/SKILL.md` mtime 仍为 8-07，无相关文字——**报告在这一条上诚实**，接手方不必去查 |
| `.claude/worktrees/task37-closeout` 保留且分支已并入 master | ✅ `git worktree list` 显示它在 `d2f66fa9` |
| §3「另有约 200 棵既有 worktree 不属本轮范围」 | ✅ `git worktree list \| wc -l` 量级相符；这句**主动防止**了接手方去做一次危险的批量清理，是报告写得好的地方 |

---

## Verdict

- **BLOCKER：1**（B1）
- **MAJOR：4**（B2、B4、B5、B6）
- **MINOR：2**（B7、B8）
- **正向确认：2 组**（B3、B9）——报告在这些位置准确，接手方不应重做

**总体**：报告的**事实断言质量很高**（C1–C13 逐条复算基本站得住，行号精确、口径分离清楚、`anchor-numbers-to-commits` 执行得比多数收尾报告好）。它的问题**全部集中在「作为接手入口的可操作性」上**——报告自己不在 master、它宣称已修的账本数字不在 master、给读者的自证命令算的不是要证的东西、被它宣布解除阻塞的那个人拿不到任何入口、唯一的新鲜证据锚在一个会蒸发的路径上。

**建议处置**：B1 必须在报告定稿前解决（合并 `53efd301` 到 master，或在报告顶部显式标注未合并状态与判定命令）；B4/B5/B6 的修法都是**在报告里补路径与命令**，不涉及重新取证，成本很低而收益直接落在下一个人身上。

---

## 最终轮（`review_closeout_final`）—— 只判 B1 与 B4 是否闭合

评审锚点：`git rev-parse master` → `50d2221948d6ea0594cc002614cd83aaf6a142b3`（与派活给的值一致）。整改提交 `d73ecb9e docs(closeout): close both draft reviews, and stop pinning a moving ref`。以下命令均在 `/home/xp/src/copilot-api-js/.claude/worktrees/encapsulated-kindling-forest`（同一 object database）跑出，读的是 master 的**提交树**而非工作区。

### B1（原 BLOCKER：终报与账本修正都不在 master）→ ✅ **已闭合**

四项承载者逐个实地核验：

```
$ git cat-file -e master:docs/tmp/2026-08-10-task37-closeout-terminal-report.md
IN-MASTER                                          # 终报本体已在 master

$ git ls-tree -r --name-only master | grep 'draft-review'
docs/tmp/2026-08-10-task37-closeout-draft-review-claims.md
docs/tmp/2026-08-10-task37-closeout-draft-review-successor.md
                                                   # 两份草稿评审均已在 master

$ git show master:.superpowers/sdd/progress.md | grep -c '13 call sites across 12 files'
1                                                  # 账本已带可重算口径的修正措辞

$ git show master:.superpowers/sdd/progress.md | grep -c 'six accumulator feeds and two translators'
1                                                  # ← 这一次命中是引文，不是残留
```

**关于那一次裸关键词命中，我按派活提示做了上下文取证，不靠转述采信**：

```
$ git show master:.superpowers/sdd/progress.md \
    | grep -o 'The earlier wording said "six accumulator feeds and two translators", which is under-counted on either selector'
The earlier wording said "six accumulator feeds and two translators", which is under-counted on either selector
```

命中的整句是**对旧措辞的引用并当场判其偏小**，断言式的原措辞已归零。即：账本上不存在任何一处仍以断言语气给出那个数字。

**接手方现在会做什么**（原三条错误动作全部消失）：在 master 的 `docs/tmp/` 能直接找到终报，不会重做收尾；读账本第 22 行拿到的是重算命令与 13/12 的口径，不会按 8 个站点核对而漏掉 5 处；两份草稿评审也在 master，可以看到这份报告被审过什么、不会重派。

### B4（原 MAJOR：C5 配方算的不是 C5）→ ✅ **已闭合**

把第 7 节给出的配方原样跑一遍：

```
$ git diff --name-status d2f66fa9^2 d2f66fa9
M	docs/memory/feedback-fix-all-comparison-sites.md
A	docs/tmp/2026-08-09-task37-closeout-evidence-manifest.md
A	docs/tmp/2026-08-09-task37-closeout-review.md
A	docs/tmp/2026-08-09-task37-closeout-tmp-inventory.md
M	docs/todo/deferred-backlog.md

$ git diff --name-only d2f66fa9^2 d2f66fa9 | wc -l
5
```

**恰好 5 行、全部落在 `docs/` 下、零 `src/`、零 `tests/`**，与 C5 的断言逐字符相符。`^2` 的方向也复核过：`d2f66fa9` 的父序是 `b5acce8f`（我的收尾分支）、`71dcfb91`（master 侧），所以「这次合并给 master 带去了什么」确实要从第二父出发——报告第 36 行那句「`^2` 不是笔误」的解释成立，不是事后合理化。

原草稿那条 `git diff --name-status fe8977c0 master -- docs/` 跨 138 个提交、返回 105 个文件（其中含 `src/lib/history/*` 十余处改动与一个文件删除），会让接手方把无关的 peer 交付当成本次收尾的爆炸半径——**这个诱因已被移除**。

### 本轮小结（仅限 B1/B4）

| 原发现 | 级别 | 本轮判定 |
|---|---|---|
| B1 终报与账本修正不在 master | BLOCKER | **已闭合**，四项承载者全部实地可达，引文命中已排除 |
| B4 C5 配方算的不是 C5 | MAJOR | **已闭合**，配方实跑返回恰好 5 个 docs 文件、零代码 |

B2 / B5 / B6 / B7 / B8 本轮未复核，留待下一次唤醒。

---

### B5（原 MAJOR：Task 4 无入口）→ ⚠️ **四分之三闭合，第 4 个入口的行号已漂移**

以接手方身份逐个打开报告第 4 节列的四个位置，判据是「那一行的内容是否支持报告对它的描述」，不是「文件是否存在」。

| # | 报告的引用 | master 上那一行的实际内容 | 判定 |
|---|---|---|---|
| 1 | `docs/plan/…/plan-1-sse-and-delivery-foundation.md:72` | `## Task 4：把现有 DownstreamDeliverySession 升级为 BlockDeliveryOwner` | ✅ 精确命中，与报告描述逐字相符 |
| 2 | 同文件 `:67`（同 commit 硬约束） | `- [ ] Task 4 切换 driver 直接消费 grammar outcomes 的同一 commit 才删除 compatibility projection；禁止出现“旧 projection 已删、新 owner 尚未接管”的中间提交。` | ✅ 精确命中，「同 commit 硬约束」的描述成立 |
| 3 | `tests/pipeline/i9-followup-midblock-error.http.test.ts:64` | `describe.skip("[GATED — requires Task 4 owner cutover: the buffered terminal drain must drop frames past the last commit boundary] I9 follow-up probe — H2 error arriving MID-BLOCK …"` | ✅ 精确命中，确为 `describe.skip`，且 skip 理由里确实写着解除条件 |
| 4 | `docs/todo/deferred-backlog.md:1417` | **空行** | ❌ **行号漂移，指向空行** |

第 4 条的取证：

```
$ git show master:docs/todo/deferred-backlog.md | sed -n '1417p' | cat -A
$                                        # 整行只有一个换行，是空行

$ git show master:docs/todo/deferred-backlog.md | sed -n '1410,1416p' | cut -c1-40
  | 9.51s | 某次运行的逐用例之和 …        # ← 这一整段属于 `test-timings.json` 缓存偏差那条 backlog
  | 6.726245s | HEAD `a8b846ce` 的逐用例之和 …
- **根因 / 现状**：**未归因，且差额本身不稳定。** …
- **当前行为**：LPT 按缓存值给该文件配重。…
- **理想架构 / 若做需改什么**：先确认 `bun run test:timings` 的采集口径 …
- **为何暂缓**：今天无红；只影响分片均衡度 …
- **发现方**：C3 裁决期间的邻域实测（`reviewer`，2026-08-09）…

$ git show master:docs/todo/deferred-backlog.md | grep -n '^## 上游终态错误发生在块中途时'
1451:## 上游终态错误发生在块中途时，仍被当截断重试四次；直接修会泄漏半块（…）

$ git show master:docs/todo/deferred-backlog.md | grep -n '只修 `failed` 会在同一位置再犯一次'
1456:- **理想架构 / 若做需改什么**：终态排空必须知道**最后一个 commit 边界在哪** …
```

**真实位置是 master 的 1451（条目标题）／1456（那句警告），报告写的 1417 差了 39 行。**

**成因不是笔误，是结构性的**——写的时候它是对的：

```
$ git show d2f66fa9:docs/todo/deferred-backlog.md | grep -n '只修 `failed` 会在同一位置再犯一次' → 1417
$ git show d73ecb9e:docs/todo/deferred-backlog.md | grep -n '只修 `failed` 会在同一位置再犯一次' → 1417
```

即：整改提交 `d73ecb9e` 落地那一刻 1417 还准确，是此后 peer 会话往 `deferred-backlog.md` 里追加条目把它推下去的。`deferred-backlog.md` 是本仓**并发写入最频繁**的文件之一（多个会话各自 append 条目），把一个长期驻留在 master 的报告用**裸行号**指进它，寿命以小时计。

**接手方会因此做出什么错误动作**：

1. **最贵的那条警告落空。** 报告自己把它标为「⚠️ 最贵的一条警告」，接手方跳到 1417 看到空行、往上看到的是 `test-timings.json` 分片配重那条完全无关的条目，最省力的结论是「这份报告的指针过期了」——进而**连带不信任前三条（其实全对）**，或者干脆放弃查证直接开工。
2. **但危害有天花板**：报告在同一行里已经把警告内容**内联复述**了（「必须把 `incomplete` 与 `failed` **并列**处理」「只修 `failed` 会在同一位置再犯一次」，并给了 `adapters/responses.ts:77-78` 作为佐证）。所以即使指针死了，**接手方仍拿得到这条知识**，不会真的只修 `failed`。这是本条判 MAJOR 而不是 BLOCKER 的理由，也说明报告「指针 + 内联复述」的写法本身是对的。

**修复建议（只改一处，不必重新取证）**：把 `docs/todo/deferred-backlog.md:1417` 换成**不随邻居漂移的定位符**——条目标题或一条 grep：

```
docs/todo/deferred-backlog.md 的「## 上游终态错误发生在块中途时，仍被当截断重试四次」条目
定位：rg -n '^## 上游终态错误发生在块中途时' docs/todo/deferred-backlog.md
```

**同一处顺带核实的旁证**：`src/lib/pipeline/delivery/adapters/responses.ts` 的 `:77`/`:78` 确为 `case "response.incomplete": {` / `semantic = "incomplete"`，**支持**「`incomplete` 同样是上游的终态决定」的论断；`:17` 是 `const deliveryMode = transport === "http" ? "unit" : "response-terminal"`，与 `incomplete` 无直接关系——但这处引用是从 backlog 条目里原样继承的，不是本轮整改新引入，且报告未给它的完整路径（实际在 `src/lib/pipeline/delivery/adapters/`），一并建议补齐。

### B6（原 MAJOR：C6 证据锚在会蒸发的路径上）→ ✅ **已闭合**

整改后的 C6（报告第 37 行）读作：

> ⚠️ **原始日志写在 job 临时目录里，会随 job 过期消失，不要去找它**——上面这行汇总就是本报告保存的全部，要更强的证据请按第 6 节配方重跑

逐条对照我原来点名的三个错误动作：

| 原风险 | 现在还成立吗 |
|---|---|
| 接手方把 `$CLAUDE_JOB_DIR` 展开成自己的 job 目录、找不到文件、判「证据不存在」 | ❌ 不成立。`$CLAUDE_JOB_DIR/tmp/testfast-merged.log` 这个路径**已从报告中整条移除**，改为「不要去找它」的显式指令，接手方不会去追一个不存在的路径 |
| 因判「无证据」而重跑 `test:fast`，甚至连带重跑 `test:backend` | ❌ 不成立。汇总行（`16 shards · 5471 tests · 5471 pass · 0 fail · 3 skipped`，exit 0）已**内联**进 C6，本身就是证据；C6 边界段与 C7 又明写两档口径不可比、且按 `moving-shared-head-is-not-failure` 不触发全量复跑。想要更强证据的人被导向第 7 节的 `bun run test:fast`，那是**正确的档位**，不会误导去跑 `test:backend` |
| 它没进 evidence-manifest，接手方无法反查 | ❌ 不再是缺陷。报告不再声称该日志被持久化，反而明说「上面这行汇总就是本报告保存的全部」——**声明与事实一致**，这正是原发现要求的 |

**额外正向确认**：第 7 节的 `bun run test:fast` 那条**没有写死期望数字**（只写了 `env | grep -c RUN_PERF_TESTS # 期望 0` 这个环境前提）。这很重要——master 自 `d2f66fa9` 起已前进 59 个提交，若配方里焊死「期望 5471 pass」，接手方今天跑出来必然对不上而判 false-red。报告避开了这个坑。

**残留（不构成发现，仅记）**：C6 的 5471 与 C7 的 7651 都是快照值，报告已分别锚到 `d2f66fa9` 与 2026-08-09 闭门时刻并标注不可比，符合 `every-number-carries-scope`。

### 本轮小结（B5 / B6）

| 原发现 | 级别 | 本轮判定 |
|---|---|---|
| B5 Task 4 无入口 | MAJOR | **部分闭合**：入口 1/2/3 精确命中；入口 4 的裸行号 `deferred-backlog.md:1417` 已漂移 39 行（真实位置 1451/1456），指向空行。因警告内容已内联复述，危害限于浪费时间与侵蚀信任，仍判 MAJOR，建议改用条目标题/grep 定位 |
| B6 C6 证据锚在会蒸发路径 | MAJOR | **已闭合**：易失路径整条移除、汇总行内联、导向正确档位的复验配方，且配方未焊死数字 |

B2 / B7 / B8 本轮未复核，留待下一次唤醒。
