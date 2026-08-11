# 收尾临时目录清单独立评审

- **评审范围**：`/home/xp/src/copilot-api-js/docs/tmp/2026-08-10-long-resident-closeout-temp-manifest.md`（commit `e120a49c`）及其删除前置证据。
- **独立事件源**：`/home/xp/.claude/projects/-home-xp-src-copilot-api-js/36fcb851-149c-488b-bf29-77e9906892ea.jsonl`；共 9,604 行、21,205,288 字节，后续按全量结构化查询与定点片段复核。
- **总体 verdict**：存在 blocker；当前不得删除。
- **blocker 数量**：1（随逐条核验更新，最终汇总在文末）。

## 事实性发现

[blocker] `/home/xp/src/copilot-api-js/docs/tmp/2026-08-10-long-resident-closeout-temp-manifest.md:11` — 清单冻结的“当前总数 109”已失效，删除对象集合发生 manifest-review 之前的漂移 — 2026-08-11 实跑 `find /home/xp/.claude/jobs/36fcb851/tmp \( -type f -o -type l \) -printf '.\n' | wc -l` 与 `fd -H -I --type f --type l . /home/xp/.claude/jobs/36fcb851/tmp | wc -l` 均为 110；按 `closing-a-development-session`，任何新增路径都必须重新分类并使旧 verdict 失效 — 修复建议：定位第 110 个路径，补入 manifest 并重走独立评审；在此之前 fail closed，保留全部文件。

[blocker] `/home/xp/.claude/projects/-home-xp-src-copilot-api-js/36fcb851-149c-488b-bf29-77e9906892ea.jsonl` — 作为独立枚举 oracle 的 transcript 在评审期间仍由主会话追加，无法形成“完整且 diff 为空”的冻结覆盖范围 — 首次 `wc` 为 9,604 行／21,205,288 字节，稍后为 9,625 行／21,235,665 字节；新增事件包括 2026-08-11T05:15:56.196Z 创建 `/home/xp/.claude/jobs/36fcb851/tmp/fix-skillref.py`，该文件 mtime 为 05:15:56，而 manifest commit `e120a49c` 时间为 05:12:43 — 修复建议：停止向该 session/job 写入，重新冻结 transcript 行数或内容 digest、重新枚举 temp root、更新 manifest 后再评；本轮不得释放删除。

[blocker] `/home/xp/src/copilot-api-js/docs/tmp/2026-08-10-long-resident-closeout-temp-manifest.md:27-36` — 非文件候选列表不是 transcript 事件全集，独立枚举在 N1–N6 之外找到多类应登记事件，因此双向 diff 不为空 — transcript 行 411→473 记录一次 History 查询范围误判后被纠正；4037–4049 是用于设计裁决的 Bun `unhandledRejection` runtime probe；4279/4406 是错误 mutation 目标被识破，4490 是命令跑错 worktree 的 scope error，7059 撤回基于 mtime 的 agent 死亡推断，7219 撤回“类型断言无取舍可删”，4302–6420 则是 5 MiB 恢复闸门及连续尾切片的六轮实测；另有 6824–6838 的 M7–M9 正控 — 修复建议：按 abandoned/falsified/scope/calibration/mutation/runtime-probe 六类把这些事件逐项登记，给出已有 carrier 或新增 receiver，再重新双向 diff 到空。

## 已核验而未构成反驳的处置

- `diff --` 输出：`handover-review.md` 与 `docs/tmp/2026-08-08-long-resident-operation-lifecycle-handover-review.md` 相同；`task-4-review.md` 与对应 `docs/tmp` 文件相同。
- `git cat-file -e HEAD:<path>`：三份 `spec-review-raw.md`、`spec-rereview-raw.md`、`plan-review-raw.md` 均存在于 `HEAD`。
- `reference-subagent-transcript-5mib-gate-blocks-resume.md:11-39` 记录版本边界、5 MiB 机制、两种相邻故障与恢复/接力边界；其所指的 `writing-handover-docs` §容量终态给出连续尾切片操作。12 个切片的“技术可重建”理由成立，但不弥补本轮新增、未清单化的 transcript 事件。
- `HANDOVER.md:41-43` 记录 `req_1786064856101_137` 及可重取 URL；`API.md:127` 记录 `/history/api/entries/:id/export`。保留 `incident-manifest.zst`、交用户裁决的处置成立。
- `methodology-output-filter-fakes-a-failure.md:8-27` 明确涵盖 N4 的 `bun test | tail`／过滤器改写退出码形态，故“既有记忆已覆盖”成立。

## 删除回执

- **事件源身份与覆盖范围**：独立事件源为 `/home/xp/.claude/projects/-home-xp-src-copilot-api-js/36fcb851-149c-488b-bf29-77e9906892ea.jsonl`。以 JSONL 全量结构扫描记录类型、全部 assistant tool_use、全部 human prompt、全段候选关键词与定点片段；最后观测为 9,648 行、21,274,501 字节。它在评审期间由主会话继续追加，故不是可供放行的冻结快照。
- **独立枚举**：已完成，先从 transcript 归纳临时产物、6 次 5 MiB 尾切片恢复、M7–M9 与 entry-evidence 正控、A/B worktree 与过滤器误判、错误 worktree scope、mtime 误判和类型断言误判等事件，再与 N1–N6 比较。
- **双向 diff**：清单声称的 N1–N6 均能在 transcript 找到；反向发现的事件不为空，且 manifest 后新增 `fix-skillref.py` 使文件集合由 109 变为 110。

RELEASE_DELETION: NO


## 终态“全部保留”改写复核（2026-08-11）

[major] `/home/xp/src/copilot-api-js/docs/tmp/2026-08-10-long-resident-closeout-temp-manifest.md:20-28` — “内容已有载体”被作为每一行（含处理脚本、日志、中间快照、提交信息输入）的处置结论，但本轮与上轮只实证核验了三份 raw review、两份逐字相同 review、5 MiB 技术记忆、incident 重取端点和 N4；没有逐项核验其余类别的“产出全部已提交”“读数已写入”“均可重取”“对应 commit 均存在”等断言 — 全部保留不需要以这些未核验断言作为理由，当前表述会把未审计 carrier 顺带洗白 — 修复建议：处置统一改为“本轮不删；载体断言仅按第四列记录，未逐项复核”，或逐条给 carrier 证据后再保留强断言。

[核验通过] `/home/xp/src/copilot-api-js/docs/tmp/2026-08-10-long-resident-closeout-temp-manifest.md:49-64` — N7–N14 补登没有把 reviewer 列出的事件伪称为完整枚举：它标记为 provisional，明确说只是补了评审点名项、没有第二轮独立枚举、不能声称 diff 已空；并限定 N8 的 runtime 结论不外推、N14 明示未逐条保留失败形态。该边界足以避免“已补齐”或“diff 为空”的过度声称。

[major] `/home/xp/src/copilot-api-js/docs/tmp/2026-08-10-long-resident-closeout-temp-manifest.md:13` — 文件数“113（05:26 实测）”已再次漂移；本次独立重枚举 `find` 与 `fd -H -I` 均为 **118** — 最近新增可见 `fix-manifest.py`、`m1.txt`、`m2.txt`、`m3.txt`、`m4.txt`；这再次实证 transcript/job 仍有活写入者。由于终态是不删除，漂移不造成数据丢失，但任何“当前总数”或“仅 incident 无载体”的全称快照都应删去或锚为过往测量。

### 本轮结论

终态“全部保留”本身：**YES**。但其文档表述目前：**NO（需修复上列 2 项 major）**；缺少的是对未核验 carrier 的诚实降级，以及把 113 改为“05:26 的历史测量”或停止写入后重取、而非冒充当前盘点。
