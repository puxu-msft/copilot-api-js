# 无损 shutdown 整改会话临时证据清单

> 会话 job：`149c3057`。临时根：`/home/xp/.claude/jobs/149c3057/tmp`（harness 拥有，job 删除时自动清理）。**本文件经三次冻结**：收尾中段（35 个文件）、master 合并落地后（53 个）、最终复查（68 个），下方为最终口径。
>
> **第三次复查换了方法：不再只按文件名分类，而是实际打开体量最大、此前从未读过内容的几个文件。** 收获两项：①纠正了 ndjson 的错误分类（详见下表——它是测试 fixture 输出，不是服务器实例的 History）；②当时判定新增文件「全部落在既有类别里」——**这个判定本身又是按文件名做的，且是错的**，见下方「第三次冻结的账」。
>
> **教训（两个实例才撑得起）：不是「文件名分类整体不可用」，而是「只看名字不看内容」在两种情形上会错**——①名字**看起来携带来源信息**时（`copilot-api-<bootTime>-<pid>.ndjson` 让我认定它出自某个服务器实例，实际是测试 fixture 的合成输出）；②名字**有规律、可整体略过**时（`msg15`～`msg18` 因为「msg 系列已分类」被跳过，从未落表）。两次都产出了看起来合理、实则错误的结论。
>
> **本次处置：全部保留，不主动删除。** 所有具长期价值的内容已有仓库载体（见下表「接收方」列）；其余为可由命令重跑的过程输出。harness 自动清理不构成持久化替代，故先完成持久化再允许其清理。
>
> **证据分层——哪些能被后来者复核，哪些不能：**
>
> | 断言 | 现在还能不能独立复核 |
> |---|---|
> | 目录清单（文件名、字节数、计数） | **是**。已落盘为 [2026-08-08-lossless-shutdown-job-tmp-inventory.md](2026-08-08-lossless-shutdown-job-tmp-inventory.md)，采集脚本 [2026-08-08-lossless-shutdown-capture-job-tmp.sh](2026-08-08-lossless-shutdown-capture-job-tmp.sh) |
> | `msg*.txt` 的 subject 与已落地 commit 的 `%s` 相等 | **是**。上述 inventory 里 27 个 msg 文件逐条给出匹配到的完整 SHA，**0 个 `NO-MATCH`**；任何人可用其中的 SHA 反查 `git log -1 --format=%s` |
> | 「所有路径都已分类」 | **否，且此前为假**——见下方「第三次冻结的账」。现已补齐 |
> | 未触及 4141 主服务器与其它会话数据 | **否**，属作者当时自报。**可复核的替代证据**：本会话对仓库的全部改动都在 `git log` 里且未推送 |
> | 三份被持久化的证据（两 patch + timings XML）内容 | **是**。已在 `docs/tmp/` 下，可 `git apply --check` 与直接阅读 |
> | 自测脚本复现 100 tests / 12 files | **是**。`bash docs/tmp/2026-08-08-lossless-shutdown-self-tests.sh` |
>
> 这张表由独立评审逼出来，且**被逼了两次**：初版把上面几项写成无条件「已核验」；第二版改标「否·不可复核」之后，评审指出**目录当时还在、这件事那一刻仍做得到**——我把「未做」写成了「不可做」，等于用证据分层表替自己挡住了检查。第三版才真正去采集。**教训：标注「不可复核」之前，先确认它现在是不是真的做不到。**

盘点口径：见 inventory 文件（采集时 71 个常规文件、0 符号链接、0 子目录；该数字随本轮继续写入而增长，故以 inventory 内的清单为准，不以任何单一数字为准）。`$CLAUDE_JOB_DIR/tmp` 是本 harness 暴露的唯一 job 临时根，无第二个 session temp root。

## 第三次冻结的账（评审查出的缺口，已补）

第二次冻结口径为 53 个文件。此后新增 **15 个**：`msg15`～`msg25`（11）、`mp6`～`mp8`（3）、`final-self.log`（1），53 + 15 = 68，与当时的表头数字闭合。

**但第三次冻结只在正文里枚举了其中 11 个，且四张分类表一行未加**——`msg15`～`msg18` 与 `final-self.log` 在整份清单里零命中，表头写 68、表体仍是 53 条的账。评审逐行清点四表发现了这一点。**成因与 ndjson 那次同源：按文件名规律整体略过，没有逐个落表。** 下方各表已补齐；此后新增的 `msg26`、`msg27`、`INVENTORY.txt` 及本轮两份归档件同样计入。

## 有长期价值、已持久化

| 临时路径 | 类型 | 长期价值 | 接收方（仓库内） | 处置 |
|---|---|---|---|---|
| `mutate-shutdown-drop-generation.patch` | 冻结变异 patch | 是——正控可复跑性 | `docs/tmp/2026-08-08-lossless-shutdown-mutation-drop-generation.patch`（`6adf2e56`） | 逐字持久化，保留原件 |
| `mutate-shutdown-drop-lightweight.patch` | 冻结变异 patch | 是——同上 | `docs/tmp/2026-08-08-lossless-shutdown-mutation-drop-lightweight.patch`（`6adf2e56`） | 逐字持久化，保留原件 |
| `validator-timings.xml` | 逐用例耗时原始数据 | 是——支撑 validator 超时预算处置的数字 | `docs/tmp/2026-08-08-validate-entry-evidence-timings.xml`（`6adf2e56`） | 逐字持久化，保留原件 |
| `shutdown-backlog-section.md` | backlog 条目草稿 | 是——结构性待办 | `docs/todo/deferred-backlog.md:1208`「shutdown drain source 仍由协调器手工枚举」 | 已蒸馏落盘，原件为草稿 |
| `master-changed-paths.txt` | master 变更路径清单 | 否——可由 `git diff --name-only` 重取 | 无（结论已进评审记录的合并叙述） | 蒸馏后保留 |
| `run-self-tests.sh` | 自有测试集的精确文件清单 | **是**——它是「100 tests across 12 files」这个数字的唯一精确口径 | `docs/tmp/2026-08-08-lossless-shutdown-self-tests.sh` | **提炼后持久化**：原件写死了 worktree 绝对路径、收尾后即失效；归档版改为 `git rev-parse --show-toplevel` 自解析仓库根，并加了文件存在性前置校验与「pty 不在此集内」的说明。归档后实跑退出 0、复现 100 tests / 12 files |

## 过程输出，可由命令重跑

| 临时路径 | 类型 | 重跑命令 | 处置 |
|---|---|---|---|
| `backend-final.log`、`backend-final2.log`、`backend-green-check.log`、`backend-timeout-final.log`、`final-backend-after-review.log`、`merged-backend.log`、`newest-backend.log` | 后端测试输出 | `bun run test:backend` | 保留，结论已锚定 commit 写入 plan 与评审记录 |
| `fast-after-shutdown-fix.log`、`fast-final.log`、`fast-final2.log`、`fast-green-check.log`、`fast-rerun.log`、`fast-root.log`、`merged-fast.log` | fast 档测试输出 | `bun run test:fast` | 同上 |
| `lint-all.log` | 全仓 lint 输出 | `bun run lint:all` | 同上；该文件记录的是**已失效的旧红状态**，结论已在评审记录中显式闭合 |
| `models-driver-classify.log`、`models-driver-identity.log` | driver false-red 诊断探针输出 | 已废——对应判据已被替换 | 保留，教训已进 `docs/memory/methodology-false-red-from-process-global-quantities-not-the-mechanism.md` |
| `base-validator.ts` | 基线文件副本 | `git show <ref>:tests/infra/validate-entry-evidence.unit.test.ts` | 保留；git 已是权威副本 |
| `merge-preview.txt`、`merge-preview2.txt`、`merge-preview3.txt`、`merge-preview4.txt`、`mp5.txt`、`mp6.txt`、`mp7.txt`、`mp8.txt`（8 个） | `git merge-tree` 预览输出 | `git merge-tree --write-tree master HEAD` | 保留。只含 tree hash 或冲突 stage 行，无长期价值；两次冲突的**结论**（文件名撞车、backlog 追加点）已写进终态报告第 5 节的「已知复发冲突点」 |
| `self-tests-run1.log`、`self-tests-run2.log`、`self-tests-final.log`、`archived-script-run.log`、`final-self.log` | 自有测试集五次运行输出 | `bash docs/tmp/2026-08-08-lossless-shutdown-self-tests.sh` | 保留。五次均为 100 tests / 12 files / exit 0，稳定性结论已进报告；归档脚本使其可重跑 |
| `guards.log` | 架构与 discovery guards 运行输出 | `bun test tests/architecture/ tests/infra/test-discovery-matrix.unit.test.ts` | 保留。它是纠正「34/34」这个错误数字的实测来源，正确值 17 文件 178 pass 已写进报告、评审记录与 plan 三处 |

## 一次性脚本与输入

| 临时路径 | 类型 | 处置 |
|---|---|---|
| `extract-agent-id-events.py`、`extract-review-results.py`、`extract-reviewers.py` | 从 transcript 抽取 agent 结果的一次性脚本 | 保留，无长期价值；不值得升为项目脚本（transcript 结构非稳定契约） |
| `msg.txt` ～ `msg27.txt`（27 个） | commit message 输入 | 保留。**现已可完整复核**：[inventory](2026-08-08-lossless-shutdown-job-tmp-inventory.md) 逐条给出每个 msg 文件首行匹配到的完整 commit SHA，27/27 命中、0 个 `NO-MATCH`。先前清单只写到 `msg14` 且把这项标为「输入侧不可复核」，两处均已更正 |
| `INVENTORY.txt` | 采集过程中间产物（目录清单原始输出） | 保留。其内容已并入落盘的 inventory 文件 |

## 测试服务器副产物

| 临时路径 | 类型 | 处置 |
|---|---|---|
| `copilot-api-1786187008118-3388019.2026-08-08.1.ndjson` | **测试 fixture 的 diagnostic 输出**（4 行，`recordType: diagnostic`/`event: fixture.head`，message 为 `x` 填充） | 保留，无长期价值。**此处更正一处先前的错误分类**：前两次冻结把它写成「本会话自启测试服务器的 History sidecar」，并据此讨论 owner PID 是否退出——实际读取内容后确认它是测试 fixture 写出的合成记录，不是任何真实服务器实例的 History。原分类是**只看文件名没看内容**得出的，属本轮记忆条目 `methodology-closeout-summaries-overstate-their-evidence` 所述形态 |
| `copilot-api-1786187008118-3388019.owner.json` | 同上的 owner 元数据 | 同上 |

**未触及**（作者当时自报，现不可复核——见开头的证据分层表）：用户 4141 主服务器的任何数据、其他会话的临时路径、共享缓存、已归档证据。**可复核的那一半**：本会话对仓库的全部改动都在 `git log` 里，且未推送——谁都能从提交历史独立判断本会话碰过什么。
