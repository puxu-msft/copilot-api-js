# 无损 shutdown 整改会话临时证据清单

> 会话 job：`149c3057`。临时根：`/home/xp/.claude/jobs/149c3057/tmp`（harness 拥有，job 删除时自动清理）。冻结时间 2026-08-08，冻结 commit `5405056b`。
>
> **本次处置：全部保留，不主动删除。** 所有具长期价值的内容已有仓库载体（见下表「接收方」列）；其余为可由命令重跑的过程输出。harness 自动清理不构成持久化替代，故先完成持久化再允许其清理。收尾前已重新列举一次目录，无新增未分类路径。

盘点口径：`ls -la /home/xp/.claude/jobs/149c3057/tmp/`，35 个常规文件，0 个符号链接，0 个子目录。`$CLAUDE_JOB_DIR/tmp` 是本 harness 暴露的唯一 job 临时根，无第二个 session temp root。

## 有长期价值、已持久化

| 临时路径 | 类型 | 长期价值 | 接收方（仓库内） | 处置 |
|---|---|---|---|---|
| `mutate-shutdown-drop-generation.patch` | 冻结变异 patch | 是——正控可复跑性 | `docs/tmp/2026-08-08-lossless-shutdown-mutation-drop-generation.patch`（`6adf2e56`） | 逐字持久化，保留原件 |
| `mutate-shutdown-drop-lightweight.patch` | 冻结变异 patch | 是——同上 | `docs/tmp/2026-08-08-lossless-shutdown-mutation-drop-lightweight.patch`（`6adf2e56`） | 逐字持久化，保留原件 |
| `validator-timings.xml` | 逐用例耗时原始数据 | 是——支撑 validator 超时预算处置的数字 | `docs/tmp/2026-08-08-validate-entry-evidence-timings.xml`（`6adf2e56`） | 逐字持久化，保留原件 |
| `shutdown-backlog-section.md` | backlog 条目草稿 | 是——结构性待办 | `docs/todo/deferred-backlog.md:1208`「shutdown drain source 仍由协调器手工枚举」 | 已蒸馏落盘，原件为草稿 |
| `master-changed-paths.txt` | master 变更路径清单 | 否——可由 `git diff --name-only` 重取 | 无（结论已进评审记录的合并叙述） | 蒸馏后保留 |

## 过程输出，可由命令重跑

| 临时路径 | 类型 | 重跑命令 | 处置 |
|---|---|---|---|
| `backend-final.log`、`backend-final2.log`、`backend-green-check.log`、`backend-timeout-final.log`、`final-backend-after-review.log`、`merged-backend.log`、`newest-backend.log` | 后端测试输出 | `bun run test:backend` | 保留，结论已锚定 commit 写入 plan 与评审记录 |
| `fast-after-shutdown-fix.log`、`fast-final.log`、`fast-final2.log`、`fast-green-check.log`、`fast-rerun.log`、`fast-root.log`、`merged-fast.log` | fast 档测试输出 | `bun run test:fast` | 同上 |
| `lint-all.log` | 全仓 lint 输出 | `bun run lint:all` | 同上；该文件记录的是**已失效的旧红状态**，结论已在评审记录中显式闭合 |
| `models-driver-classify.log`、`models-driver-identity.log` | driver false-red 诊断探针输出 | 已废——对应判据已被替换 | 保留，教训已进 `docs/memory/methodology-false-red-from-process-global-quantities-not-the-mechanism.md` |
| `base-validator.ts` | 基线文件副本 | `git show <ref>:tests/infra/validate-entry-evidence.unit.test.ts` | 保留；git 已是权威副本 |
| `merge-preview.txt` | `git merge-tree` 预览输出 | `git merge-tree --write-tree master HEAD` | 保留 |

## 一次性脚本与输入

| 临时路径 | 类型 | 处置 |
|---|---|---|
| `extract-agent-id-events.py`、`extract-review-results.py`、`extract-reviewers.py` | 从 transcript 抽取 agent 结果的一次性脚本 | 保留，无长期价值；不值得升为项目脚本（transcript 结构非稳定契约） |
| `msg.txt` ～ `msg6.txt` | commit message 输入 | 保留；对应 commit 均已存在且 message 一致（`b6f1f5e0`、`b7e2cdec`、`6adf2e56`、`93de46b9`、`51d705cf`、`5405056b`） |

## 测试服务器副产物

| 临时路径 | 类型 | 处置 |
|---|---|---|
| `copilot-api-1786187008118-3388019.2026-08-08.1.ndjson` | 本会话自启测试服务器的 History sidecar | 保留。owner PID 3388019 已确认不在运行（`ps -p 3388019` 无输出），无进程仍在写入 |
| `copilot-api-1786187008118-3388019.owner.json` | 同上的 owner 元数据 | 同上 |

**未触及**：用户 4141 主服务器的任何数据、其他会话的临时路径、共享缓存、已归档证据。本会话自启的测试服务器实例已退出。
