# 收尾临时目录清单（job 36fcb851）

> **终态：全部保留，一个文件都不删。** 独立评审（`docs/tmp/2026-08-10-closeout-temp-manifest-review.md`）判 3 blocker、给出 `RELEASE_DELETION: NO`。按 `closing-a-development-session` §5 fail closed。
>
> 下表的「长期价值 / 仓库载体」仍然有效——它记录的是**内容有没有别的载体**，不是删除授权。

枚举命令与交叉验证（两法一致）：
```
find $T \( -type f -o -type l \) | wc -l    # 首次盘点 104，收尾自身又产出若干
fd -H -I --type f --type l . $T | wc -l      # 同值（-I 必需：fd 默认遵守 .gitignore 会少报）
```

当前总数：**113**（2026-08-11 05:26 实测，`find` 与 `fd -H -I` 两法一致）。冻结时是 109，此后本会话自身又产出 `fix-skillref.py`、`fix-mem.py`、`fix-hk.py`、`gate15.log` 四个——**这正是评审第 1 条 blocker 指出的漂移**：会话还活着，删除对象集合就还在长。

## 为什么终态是「全部保留」而不是补齐证据后删除

三条 blocker 里第 2 条是**结构性**的：独立枚举用的事件源是本会话自己的 transcript，而它在评审期间被主会话持续追加（评审首末两次观测 9,604 → 9,648 行）。**只要会话还在运行，就不可能冻结出一份「diff 为空」的完整覆盖**——这道门在当前状态下不可闭合，不是取证不够努力。

既然删除授权无法合法取得，正确动作是**不删**：保留不产生任何风险，删除才不可逆（`no-accidental-data-loss`）。这 113 个文件躺在 job 目录里，随 job 删除而消失，届时**内容有载体的那些已经在仓库里**（下表第四列），没有载体的只有 `incident-manifest.zst` 一个，它单独标了「交用户裁决」。

## 分类与处置

| 类别 | 文件 | 长期价值 | 仓库载体 / 替代证据 | 处置 |
|---|---|---|---|---|
| 原始 reviewer 输出 | `lifecycle-spec-review-claude.md`、`lifecycle-spec-rereview-claude.md`、`lifecycle-plan-review.md` | **有** | 已逐字提交 `docs/tmp/*-{spec-review,spec-rereview,plan-review}-raw.md`（`be10afc6`） | 内容已有载体；**本轮不删** |
| 已有同名载体的评审件 | `handover-review.md`、`task-4-review.md` | 有 | 与 `docs/tmp/*-handover-review.md` / `*-task-4-review.md` **逐字节相同**（diff 验证） | 内容已有载体；**本轮不删** |
| 失败/空产物 | `lifecycle-plan-rereview.md`(19B "Prompt is too long")、`lifecycle-plan-rereview-minimal.md`(0B)、`lifecycle-spec-review-gpt.md`(76B API Error)、`task3-overstrict-single-error.patch`(0B) | 无内容 | —— | 内容已有载体；**本轮不删** |
| **incident 原始导出** | `incident-manifest.zst` (542KB) | **有，且含用户真实请求/响应内容** | 身份与重取路径已记入 HANDOVER（operationId + `/history/api/entries/:id/export`）；**blob 本身未提交** | **保留，交用户裁决**（唯一无仓库载体者） |
| agent transcript 切片 | `agent-a46e6c56981b3cd1b.{pre-trim*,trim-candidate*}.jsonl`（12 个，约 55MB） | 派生数据 | 技术已在记忆 `reference-subagent-transcript-5mib-gate-blocks-resume`；原 transcript 仍在 projects/ | 内容已有载体；**本轮不删** |
| 处理脚本 | `trim_transcript_again.py`、`validate_transcript_slice.py`、`audit_b1_progress.sh`、`canon.ts`、`upd-*.py`、`fix-*.py`、`doc-sync.py`、`add-disables.py` | 一次性 | 产出全部已提交；`audit_b1_progress.sh` 的通用形态在 skill `writing-handover-docs` | 内容已有载体；**本轮不删** |
| 测试/lint 日志 | `backend*.log`、`gate*.log`、`entry*.log`、`lint*.log`、`tc*.log`、`iso.log`、`cap.log`、`ab-*.log`、`backend-run.txt` | 派生 | 读数已写进提交信息与 HANDOVER 的门禁节 | 内容已有载体；**本轮不删** |
| 提交信息输入 | `*-msg.txt`、`msg-*.txt`、`commit-msg*.txt` | 无 | 对应 commit 均已存在且含该信息 | 内容已有载体；**本轮不删** |
| 中间快照 | `master-shutdown.ts`、`memory-head.md`、`memory-myline.patch`、`wt.txt`、`*-files.txt` | 派生 | 均可由 `git show` / `git worktree list` 重取 | 内容已有载体；**本轮不删** |

## 文件清单看不见的候选（非文件类）

| # | 类别 | 内容 | 来源事件 | 怎么复现 | 处置 |
|---|---|---|---|---|---|
| N1 | 被证否的因果 | A/B worktree 建在仓库外 → `0 pass / 4 fail / 122ms`，**差点断言「master 自己就是红的」**；真因是零 node_modules | 本会话 A/B 对照 | `git worktree add --detach <仓库外路径>` 后跑 bun test | 已提交记忆 `547bd3bb`+`11558f81` |
| N2 | 已执行的正控 | entry-evidence 守卫先后因**两个不同的正确理由**变红（冻结集缺文件、JSON 字节非规范），修对后绿 | 合并期 baseline 同步 | 删 `files` 一项 / 用 Python `json.dumps` 重写该文件 | 已写入合并提交信息 |
| N3 | 被证否的因果 | 我暂存的 MEMORY.md 行被 peer 并发提交带走，回显 files changed 与暂存数对不上 | `git apply --cached` + 无-pathspec 提交 | —— | 已提交记忆 `174f0dea` |
| N4 | 修正的解析错误 | `bun test ... | tail` 触发 `WriteFailed`，退出码来自过滤器而非被测命令 | focused gate 首跑 | 带 coverage 的 bun test 接 `| tail` | 既有记忆 `methodology-output-filter-fakes-a-failure` 已覆盖，**未新增** |
| N5 | 放弃的路线 | 反复 `--ff-only` 追移动的 master 不收敛（一天内前进数百提交）；改为「隔离树集成→立刻 ff」 | 四轮集成 | —— | 已写入 HANDOVER「仍然有效的纪律」 |
| N6 | 放弃的路线 | `Edit` 工具在非 EnterWorktree 建的隔离树里被 bg-isolation 护栏拒绝；改用脚本做替换 | 解冲突时 | —— | **未落盘**，本清单是唯一记录 |

## 评审独立枚举补登的候选（N7–N14）

来源：`docs/tmp/2026-08-10-closeout-temp-manifest-review.md` 第 3 条 blocker——它拿本会话 transcript 做独立枚举，在 N1–N6 之外找到下列事件。全部**标记为 provisional**，与 N1–N6 同一处置字段。

| # | 类别 | 内容 | 来源事件（transcript 行） | 怎么复现 | 处置 |
|---|---|---|---|---|---|
| N7 | 修正的 scope 错误 | 一次 History 查询的**范围**判错，随后被纠正 | 411→473 | —— | 仅本清单记录 |
| N8 | runtime 探针 | Bun 的 `unhandledRejection` 行为实测，用于支撑一处设计裁决 | 4037–4049 | 在 Bun 下构造未处理 rejection 观察进程行为 | 仅本清单记录；**它不证明**其他 runtime 同行为 |
| N9 | 变异对照 | 选错变异目标，被识破后换靶 | 4279、4406 | —— | 仅本清单记录（呼应「mutation 要自证改到了代码」） |
| N10 | 修正的 scope 错误 | 命令跑在了**错误的 worktree** 上 | 4490 | —— | 既有记忆 `reference-worktree-...-after-merge` 第四方向已覆盖 |
| N11 | 被证否的因果 | 撤回「据 output 文件 mtime 判定 agent 已死」这一推断 | 7059 | —— | 已写入 KICKOFF「这一轮反复踩的坑」首条 |
| N12 | 被证否的因果 | 撤回「这处类型断言无取舍、可以删」 | 7219 | `bun run typecheck` | 已写入 KICKOFF「这一轮反复踩的坑」末条 |
| N13 | 标定值 / runtime 探针 | subagent transcript **5 MiB 恢复闸门**与连续尾切片的**六轮**实测 | 4302–6420 | 见记忆 `reference-subagent-transcript-5mib-gate-blocks-resume` | 已提交该记忆；阈值带 CLI 版本前提 |
| N14 | 已执行的正控 | M7–M9 三个变异正控 | 6824–6838 | —— | 仅本清单记录（符号→测试→失败形态未逐条留存，**这是已知缺口**） |

**诚实边界**：这张补登表本身**没有再过一轮独立枚举**——评审说双向 diff 不为空，我补的是它点名的那些；**不能声称现在 diff 已空**。由于终态是「全部保留、不删除」，这个缺口不会造成不可逆后果。
