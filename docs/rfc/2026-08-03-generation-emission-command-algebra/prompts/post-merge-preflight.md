# Kick-off：post-merge entry-evidence preflight —— P 后、Commit 0 前

<!-- prompt-task-ids: T0.0d -->

## 背景 + 为什么

T0.0d 不是 Commit -1 的收口 task，也不是 cutover commit。它消费 Commit -1 的 `T0.0e` 已交付 validator，对真实 A/P/树外 15-run evidence 做 fail-closed 预检。

因果图已裁：Commit -1 合 master得 A → 从 A 建执行树 → 树外跑 15 次/manifest → master 提交 pointer P → **本 phase** → 执行树开始 T0.1/Commit 0。不能用未来 A/15/P 验过去 Commit -1；也不能从当前 master/P 起执行以重定义 A。

## 必读

1. `../design.md`：RFC §7.1 entry 前稳定基线。
2. `../cutover-plan.md`：§0.2、§0.3、§0.4b、§0.4f、Commit -1 收口与 post-merge preflight。
3. `../traceability.md`：§6 `T0.0d` 的 post-merge 归属。
4. `docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md`：已裁 Commit -1 图与 entry-evidence pointer 状态行。
5. `README.md`：集中红线。

## 前置与停止条件

必须已经存在：Commit -1 合 master的 entry A、树外 15-run manifest、master pointer P、Commit -1 版本化 validator。

缺 pointer/manifest/任何 log/JUnit/字段/hash，或 Git 图不成立，**立即 fail-closed**，不得把 HANDOVER pointer 当「曾经通过」的自述继续 Commit 0。

## 改动锚点

| 对象 | master `file:line` | 用途 |
|---|---|---|
| `baseline-runs.sh` OUT 分支 | `exp/inter-block-anchor-allocator/baseline-runs.sh:105-107` | 15-run 原始证据必须用 `$TREE` 外绝对 `OUT` |
| baseline structured log fields | `exp/inter-block-anchor-allocator/baseline-runs.sh:134-148` | 每 run 的 `evidence_timing`/`measured_sha`/`claims_current_head` 原始格式 |
| HANDOVER 已裁图 | `docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md`「用户已裁决」表 | pointer P 的唯一状态线 |

完整十行 validator 条件/EV mapping 的唯一事实源是 `../cutover-plan.md` §0.4f。

## 本 phase task 集合（唯一归属）

<!-- prompt-task-ids: T0.0d -->

| Task | TDD 施工顺序 |
|---|---|
| `T0.0d` | **不实现 validator、不重跑合成 EV mutation。** 传入完整 `ENTRY_SHA=A` 与 `POINTER_SHA=P`，消费 T0.0e 版本化 validator。对真实 A/P/manifest/15 logs/JUnit 跑正样本；validator 从原始 artifact 重算 identity、skipped multiset/executed、canonical command/intent/verdict、artifact hashes，再比 manifest。任何缺失/不等即停。 |

## 验收 gate

1. 显式从 A 建执行树：`git -C "$TREE" rev-parse HEAD == ENTRY_SHA`。
2. `POINTER_SHA` 可由当前 master 到达；`git show "$POINTER_SHA":HANDOVER` 含唯一 versioned pointer block；A 是 P 祖先。
3. 树外 manifest 存在且 hash 与 pointer 一致；恰 15 原始 logs/JUnit；所有结构化字段为 closeout/40 位 A/current-head true；每 run 的原始重算与 manifest 一致。
4. validator 绿后才可进入 `commit-0.md`。本 phase 不产生 cutover semantic commit。
5. 需要重新验证 validator 本体时，回 Commit -1 的合成 fixture，**不在真实 A/P 上现场改 validator**。

## 提交指引

本 phase 的真实 evidence 产物含当前 SHA，必须落 `$TREE` 外；HANDOVER pointer P 只定位它们，不反向定义 A。若要归档，归档是副本且不合回执行分支。显式 pathspec、Conventional Commit、无署名、绝不 push 的红线见 README。

## 红线

集中红线见 `README.md`。尤其禁止：从当前 master/P 建执行树；把 P 合回执行分支；用 manifest 内部自洽代替原始 artifact 重算；碰 4141。
