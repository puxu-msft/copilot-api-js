# 交接件复评 R2（接手方第一人称走查）

评审对象：`docs/plan/2026-08-08-long-resident-operation-lifecycle/{HANDOVER,KICKOFF}.md`、`docs/lifecycle.md` `[wip]` 指针。
本轮范围：**只做 C1–C3**（C4–C7 与主动排查留待下一轮唤醒）。
走查时主树 HEAD：`e120a49c`（`git log --oneline -1`）。

## C1 — 分支/worktree 已不存在、`0e0768ee` 在 master 上：**成立**

- 命题（HANDOVER:8/12、KICKOFF:7）：`fix-long-resident-operations` 与 `merge-long-resident-lifecycle` 均已被取代且不存在；最终 fast-forward 到 `0e0768ee`。
- `git branch -a --list '*fix-long-resident*' '*merge-long-resident*'` → **输出为空**（本地与 remote-tracking 下均无这两个分支）。
- `git worktree list` → 190+ 条中**无** `fix-long-resident-operations`、无 `merge-long-resident-lifecycle`；KICKOFF:7 点名的 `.worktree/fix-long-resident-operations` 路径也不在列表内。
- `git merge-base --is-ancestor 0e0768ee master` → exit 0；`git log --oneline -1 0e0768ee` → `0e0768ee merge: integrate master (16 commits) — entry-gate and load-sensitive-test work`。
- 判定：**成立**（三项断言逐项证实）。
- 接手方错误动作：无。这条按写法执行不会致错。

## C2 — 「本特性要修的缺陷至今仍在」：**成立**

- 命题（HANDOVER:60、待办 2 的证伪判据 HANDOVER:100、`docs/lifecycle.md:43`）：`formatActiveRequestsSummary` 仍直接打印 `request.state`，未经 lifecycle blocker 归一，故 Tasks 5–8 未作废。
- 命令：`git grep -n "request.state" -- src/lib/shutdown.ts` → exit 0，唯一命中：
  `src/lib/shutdown.ts:270:    return \`  ${request.method} ${request.path} ${model} (${request.state}, ${age}s)\``
- 交叉验证（不同原理：读该行所属函数而非只信 grep）：`src/lib/shutdown.ts:262` 即 `export function formatActiveRequestsSummary(...)`，`:296` 是其唯一生产调用点（drain 进度日志），即命中行确实落在交接件点名的那个函数与那条日志路径上。
- 附带命题也成立：HANDOVER:60 说摘要文案已改为 `accepted operation(s)`。实证 `src/lib/shutdown.ts:272` → `Waiting for ${requests.length} accepted operation(s):`，`active request(s)` 全文件已无残留。Task 8 若按旧文案写断言确实会红，交接件的提醒方向正确。
- 判定：**成立**。
- 接手方错误动作：无。这条给的是可重算命令（不是写死行号），复跑即得当前行号，是本交接件里写得最稳的一条。

## C3 — 15 文件 focused gate `236 pass / 0 fail`：**部分成立**（`0 fail` 成立，`236` 与「15 文件可复现」不成立）

- 命令（KICKOFF:38 的十文件 + 未具名的「Task 4 焦点集」3 文件 + `tests/history/worker/admission-shutdown.unit.test.ts` + `tests/infra/entry-evidence-schema.unit.test.ts`）实跑于 HEAD `e120a49c`：
  `239 pass` / `0 fail` / `781 expect() calls` / `Ran 239 tests across 15 files. [2.71s]`，进程 exit 0。
- 判定：**`0 fail` 成立且稳定**（连跑两次均绿，第一次仅在 coverage 写盘阶段报 `WriteFailed`，与测试结果无关）；**`236` 不成立**（实测 239）。
- 下面两条是本轮的正式发现。

### [major] KICKOFF:38 / HANDOVER:14 — 「15 文件」在两份交接件里都不可复现（「Task 4 焦点集」从未列名）

- 证据：`rg -n "焦点集" docs/` 显示 HANDOVER:14/15/34 与 KICKOFF:38 四处都只写「Task 4 焦点集」这个代号，**没有一处列出文件名**。真正的文件名只存在于 `docs/tmp/2026-08-08-long-resident-operation-lifecycle-handover-review.md:27`（转引 plan Task 4 Step 5）：`tests/context/manager-dual-registry.unit.test.ts`、`tests/context/context-manager.it.test.ts`、`tests/shutdown/drain-waits-operation.unit.test.ts`。
- KICKOFF:38 的可复制命令只含 10 个文件，KICKOFF:36 却要求「接手第一件事是复验而非采信」。
- 接手方会做出的错误动作：照 KICKOFF:38 那条唯一可复制的命令跑，得到的是 **10 文件**的读数，拿它去对 `236` 必然对不上；于是要么判成回归去追一轮不存在的缺陷，要么干脆放弃复验、直接采信——而 HANDOVER:34 恰恰把这个 gate 指定为「判断自己是否破坏了东西」的唯一稳定判据，判据不可复现即等于没有判据。
- 修法：把那三个文件名直接并进 KICKOFF:38 的命令行，让全 15 文件成为一条可复制粘贴的命令。

### [major] HANDOVER:14 与 HANDOVER:10 自相矛盾，且 `236` 是写死的易变数字

- HANDOVER:10 声明「合并态断言取证于 master `0e0768ee`」，而 HANDOVER:14 的门禁读数标注为 `3df0e08d`，并加了一句「**这是该引用的那一组**」。
- 实测两者不是同一状态：`git merge-base --is-ancestor 3df0e08d 0e0768ee` → exit 0，`git rev-list --count 3df0e08d..0e0768ee` → **17**。即被指定为「该引用的那一组」的读数取自最终合并态之前 17 个提交，**focused gate 从未在它自称的合并态 `0e0768ee` 上跑过**。
- 数字本身也已过期：当前 master 实测 `239 pass`，与文档的 `236` 差 3（0 fail，非回归；差额未逐条归因，本轮只做 C1–C3）。
- 接手方会做出的错误动作：复验拿到 239、文档写 236，正好落进 HANDOVER:16 自己警告过的「陈旧数被当成回归」陷阱——而这次警告失效，因为陈旧的正是它让你引用的那一组；更坏的一种是反向误判：以为合并态已被门禁覆盖，而实际上最后 17 个提交进来后这道 gate 一次没跑过。
- 修法：按项目「写死易变数字是绝对怪味」的裁决，把 `236` 换成可重算的命令 + `0 fail` 判据（HANDOVER:119 对 `test:backend` 已经这么做了，这里没同步）；同时把 HANDOVER:14 的 commit 锚点与 HANDOVER:10 对齐，或明写「本读数取自 `3df0e08d`，最终合并态未复跑」。
