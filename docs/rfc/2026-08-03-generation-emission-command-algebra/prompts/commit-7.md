# Kick-off：Commit 7 —— Golden/oracle 纯审计与旧 fixture 清理

<!-- prompt-task-ids: T7.1 T7.2 T7.3 -->

## 背景 + 为什么

Commit 7 不改 production、不首次 recapture。它审 Commit 4 的 golden 是否有 Q5 diff 与独立 oracle 证据，删除确被取代的 fixture/helper。byte fixture O-6 永不重捕。

## 必读

- `../design.md`：§6.3、§7.10、§10.2 R-12。
- `../cutover-plan.md`：Commit 7、§0.4a production 判据、§0.4b 收口趟。
- `../traceability.md`：R-12、T7.*。
- `README.md` 与进度文件。

## 前置/停点

Commit 6 已收口。任何要删的 fixture 先记录它守的 invariant、依据、为何新 oracle 接管；答不上不删。

## 改动锚点

以 plan Commit 7 的 Q5/golden 审计清单为准。production 判据使用 plan §0.4a 的 tracked-minus-exclusions wrapper，不自己列路径，也不只扫 `src/`。

## 本 phase task 集合（唯一归属）

<!-- prompt-task-ids: T7.1 T7.2 T7.3 -->

| Task | TDD/审计顺序 |
|---|---|
| `T7.1` | 每份 C4 golden 指回 Q5 diff 条目 + O-1/O-2/SDK 独立 oracle；缺证据标红。 |
| `T7.2` | 删除 fixture/helper 前先落盘其不变量，确认新 oracle 真承载；全套仍绿。 |
| `T7.3` | production 无改动：按 §0.4a wrapper；production/ops mutation 红，tests/fixtures/timings 合法清理绿。 |

## 验收 gate

R-12 C7 auxiliary、R-11/O-6 和共同门。Commit invariant：production 零改动、O-1/O-2/SDK/golden/O-6 全绿、fixture 不重捕。

## 提交指引

精确 pathspec；审计表、fixture 清理、进度一起提交；Conventional Commit、无署名、绝不 push。

## 红线

见 `README.md`。不以新 golden 自证、不 recapture O-6、不误把 `scripts/test-timings.json`/test baseline 当 production、不碰 4141。