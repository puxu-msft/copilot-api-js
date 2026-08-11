# 收尾临时目录清单（job 36fcb851）

> 供独立评审用。**删除尚未执行**——按 `closing-a-development-session` §5，删除需评审给出正向回执。

枚举命令与交叉验证（两法一致）：
```
find $T \( -type f -o -type l \) | wc -l    # 首次盘点 104，收尾自身又产出若干
fd -H -I --type f --type l . $T | wc -l      # 同值（-I 必需：fd 默认遵守 .gitignore 会少报）
```

当前总数：**109**（收尾期间新增的提交信息文件与日志已计入）

## 分类与处置

| 类别 | 文件 | 长期价值 | 仓库载体 / 替代证据 | 处置 |
|---|---|---|---|---|
| 原始 reviewer 输出 | `lifecycle-spec-review-claude.md`、`lifecycle-spec-rereview-claude.md`、`lifecycle-plan-review.md` | **有** | 已逐字提交 `docs/tmp/*-{spec-review,spec-rereview,plan-review}-raw.md`（`be10afc6`） | 可删 |
| 已有同名载体的评审件 | `handover-review.md`、`task-4-review.md` | 有 | 与 `docs/tmp/*-handover-review.md` / `*-task-4-review.md` **逐字节相同**（diff 验证） | 可删 |
| 失败/空产物 | `lifecycle-plan-rereview.md`(19B "Prompt is too long")、`lifecycle-plan-rereview-minimal.md`(0B)、`lifecycle-spec-review-gpt.md`(76B API Error)、`task3-overstrict-single-error.patch`(0B) | 无内容 | —— | 可删 |
| **incident 原始导出** | `incident-manifest.zst` (542KB) | **有，且含用户真实请求/响应内容** | 身份与重取路径已记入 HANDOVER（operationId + `/history/api/entries/:id/export`）；**blob 本身未提交** | **保留，交用户裁决** |
| agent transcript 切片 | `agent-a46e6c56981b3cd1b.{pre-trim*,trim-candidate*}.jsonl`（12 个，约 55MB） | 派生数据 | 技术已在记忆 `reference-subagent-transcript-5mib-gate-blocks-resume`；原 transcript 仍在 projects/ | 可删 |
| 处理脚本 | `trim_transcript_again.py`、`validate_transcript_slice.py`、`audit_b1_progress.sh`、`canon.ts`、`upd-*.py`、`fix-*.py`、`doc-sync.py`、`add-disables.py` | 一次性 | 产出全部已提交；`audit_b1_progress.sh` 的通用形态在 skill `writing-handover-docs` | 可删 |
| 测试/lint 日志 | `backend*.log`、`gate*.log`、`entry*.log`、`lint*.log`、`tc*.log`、`iso.log`、`cap.log`、`ab-*.log`、`backend-run.txt` | 派生 | 读数已写进提交信息与 HANDOVER 的门禁节 | 可删 |
| 提交信息输入 | `*-msg.txt`、`msg-*.txt`、`commit-msg*.txt` | 无 | 对应 commit 均已存在且含该信息 | 可删 |
| 中间快照 | `master-shutdown.ts`、`memory-head.md`、`memory-myline.patch`、`wt.txt`、`*-files.txt` | 派生 | 均可由 `git show` / `git worktree list` 重取 | 可删 |

## 文件清单看不见的候选（非文件类）

| # | 类别 | 内容 | 来源事件 | 怎么复现 | 处置 |
|---|---|---|---|---|---|
| N1 | 被证否的因果 | A/B worktree 建在仓库外 → `0 pass / 4 fail / 122ms`，**差点断言「master 自己就是红的」**；真因是零 node_modules | 本会话 A/B 对照 | `git worktree add --detach <仓库外路径>` 后跑 bun test | 已提交记忆 `547bd3bb`+`11558f81` |
| N2 | 已执行的正控 | entry-evidence 守卫先后因**两个不同的正确理由**变红（冻结集缺文件、JSON 字节非规范），修对后绿 | 合并期 baseline 同步 | 删 `files` 一项 / 用 Python `json.dumps` 重写该文件 | 已写入合并提交信息 |
| N3 | 被证否的因果 | 我暂存的 MEMORY.md 行被 peer 并发提交带走，回显 files changed 与暂存数对不上 | `git apply --cached` + 无-pathspec 提交 | —— | 已提交记忆 `174f0dea` |
| N4 | 修正的解析错误 | `bun test ... | tail` 触发 `WriteFailed`，退出码来自过滤器而非被测命令 | focused gate 首跑 | 带 coverage 的 bun test 接 `| tail` | 既有记忆 `methodology-output-filter-fakes-a-failure` 已覆盖，**未新增** |
| N5 | 放弃的路线 | 反复 `--ff-only` 追移动的 master 不收敛（一天内前进数百提交）；改为「隔离树集成→立刻 ff」 | 四轮集成 | —— | 已写入 HANDOVER「仍然有效的纪律」 |
| N6 | 放弃的路线 | `Edit` 工具在非 EnterWorktree 建的隔离树里被 bg-isolation 护栏拒绝；改用脚本做替换 | 解冲突时 | —— | **未落盘**，本清单是唯一记录 |
