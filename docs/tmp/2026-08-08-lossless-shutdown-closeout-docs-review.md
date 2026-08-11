# 收尾文档与证据独立评审

> 评审者：未卷入本轮工作的独立 reviewer（Claude 驱动），固定 commit `5405056b`，只读。
>
> **落盘说明：** 该 reviewer 的运行环境禁用了 `Write`，它拒绝绕过限制用 shell 写文件，改为把完整报告以正文返回。本文件由主会话逐字转录，未作删改；这一点按 `adopting-agent-findings` 的「agent 写不了文件」故障处置。

**verdict：1 blocker / 2 major。**

## 双视角覆盖证据

- 机械核对：解析 14 个 plan 引用 SHA + 6 个旁证 SHA 并逐条比对 subject；对 7 个关键 SHA 跑 `git branch --contains` 与 `merge-base --is-ancestor`；读 `85642352`／`901ef7d6` 父提交定 merge 方向；`git show master:src/lib/shutdown.ts` 对照实现；实跑 `lint:all`、两次 `test:backend`、一次自有测试集；两份 patch 跑 `git apply --check` 并逐字比对描述；XML 三个数与文中对齐；`git diff --stat 6adf2e56..5405056b` 确认其后仅 docs；CJK 相邻半角标点正则扫描；grep backlog 与 skill 确认缺口载体。
- 第一人称执行：①接手者读状态头→判断是否还需合并；②未来评审者按 dispositions 复跑正控；③后继者按文中命令复跑并逐字段比对数字；④误把历史任务当派活单，逐 Task 读 Step；⑤排查 count_tokens 关机丢请求者从 master 代码读 drain oracle。

## 事实性发现

`[blocker]` `plan:3,352` + `review.md:38` + `dispositions.md:3` —— 三处把「master 被合进本分支」写成「整改已合入 master」，方向相反。证据：`git branch -a --contains 77d6d479 / 954a1bff / a6be256a / 6adf2e56` 均只输出 `worktree-fix-shutdown-review-findings`；`merge-base --is-ancestor HEAD master` 为假；`85642352` 是 "Merge branch 'master' into worktree-…"，第二父 `d47492a6`。对照组 `4c555ef9` 确实含 master，即 Task 1–4 已落地、只有整改没有。失败场景：`master:src/lib/shutdown.ts:304` 仍是 `getActive: () => getRequestContextManager().getTrackedOperations()`，评审判为 MAJOR 的 F7 与 `954a1bff` 的 History reservation 泄漏此刻仍活在 master；读者据「已合入／全部落地／可合并」不会再合并。建议：改写方向表述，并在 plan 状态头与 dispositions 顶部各加当前合并状态（分支名 + 相对 master 差集 + 「待合并」），以 `git branch --contains` 输出为可复跑证据。

`[major]` `plan:352` + `review.md:40,49` —— `test:backend` 的 tests／pass 计数不可复现。同一固定树连跑两次：`5334 tests · 5334 pass` 与 `7287 tests · 7287 pass`，而 `7287 executed · 30 skipped · 0 fail · exit 0` 两次完全稳定且与文中一致；文中 6384 是第三个值。失败场景：「用例总数变化来自 peer 的 header-deadline 批次，非本任务删减」把波动近 2000 的字段当基线做归因。建议：锚到 executed／skipped／exit code／shard 数；6384、6641、3180 若保留须标口径或标「未交叉验证」。

`[major]` `plan:352` + `review.md:41` —— 「12 文件 98 pass」不复现。按其自述选择集实跑得 `Ran 102 tests across 13 files`、`102 pass`、exit 0；`ls tests/shutdown/*.test.ts` = 10（+2 = 12）。口径未写明是否含 `shutdown-signals.pty.test.ts`（7 用例、pty 档、不在 backend 内），102−7=95 也对不上 98，该数字因此不具回归比对能力。建议：写清精确文件清单与档位归属，按实测更新，pty 单列。

## 反方向检查（未发现误标）

C1 全部 SHA 存在且 subject 相符；C3 `lint:all` exit 0，与三份文档一致；C5 两份 patch `--check` 均 0 且内容与描述逐字相符；C6 XML 的 `tests="43"`／`time="45.395"`／最慢 `4.561754` 支持 43／45.4／4.56，且 `validate-entry-evidence.unit.test.ts:43` 确有 `setDefaultTimeout(30_000)`；C7 无现在时／将来时残留，spec 头确为「状态：已实施」；标点扫描零命中；backlog `1208-1212` 与 `SKILL.md:117,140` 分别承载了手工枚举债项与 upstream WS 证据缺口，无「只活在对话里」的暂缓项。

## 备注（未列为 major）

`0732fc76`／`a0ad0f1a`／`bae83f01` 确在 master、lint 结论成立，但 `0732fc76` subject 为 "merge: integrate lossless shutdown changes"、父为 `bae83f01` 与 `44457047`，将其整体归为 peer header-deadline 分支的合入略有偏差。

## 主会话处置

| ID | 级别 | 处置 | 证据 |
|---|---|---|---|
| blocker（合并方向反了） | C | **采纳，已修**。主会话独立复核：`git branch -a --contains 954a1bff` 只输出本分支；`git show master:src/lib/shutdown.ts` 第 304 行确实仍是单 registry。三份文档统一改写为「已把 master 合入本分支；本分支尚未合回 master，待合并」，并在 plan 状态头与 dispositions 顶部给出可复跑的判定命令。 | 见下方修正后的三份文档 |
| major（backend 计数不可复现） | C | **采纳，已修**。`tests`／`pass` 字段在同一树上跨运行不稳定（观测到 5334／6384／7287 三个值），而 `executed=7287`／`skipped=30`／`fail=0`／`exit=0` 在三次运行中一致。全部改锚到稳定字段 + shard 数，不稳定的 `tests` 字段不再作为基线数字写出。 | 三次运行：reviewer 两次 + 主会话一次 |
| major（自有测试 12 文件 98 pass 不复现） | C | **采纳，已修**。原数字取自一个未写明的文件集（含 `shutdown-signals.pty.test.ts`、缺 `model-operation-bypass.http`）。重新定义为 12 个 backend 档文件的显式清单，连跑两次均为 `Ran 100 tests across 12 files`、`exit=0`；pty 单列。 | `$CLAUDE_JOB_DIR/tmp/self-tests-run{1,2}.log`，脚本 `run-self-tests.sh` |
| 备注（`0732fc76` 归属略偏） | D | **采纳，已修**。改为如实描述：`0732fc76` 是把 shutdown 基线 `44457047` 与 peer lint 提交 `bae83f01` 合并到 master 的提交，不是 header-deadline 分支本身。 | `git log -1 --format='%P' 0732fc76` |
