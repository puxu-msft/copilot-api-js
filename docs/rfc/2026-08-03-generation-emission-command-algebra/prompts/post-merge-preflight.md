# Kick-off：post-merge entry-evidence preflight —— P 后、Commit 0 前

<!-- prompt-task-ids: T0.0f T0.0d -->

## 背景 + 为什么

本 phase 不是 Commit -1 的收口，也不是 cutover commit。它包含两个严格串行 task：**T0.0f 是真实 entry evidence 的唯一生产者**；T0.0d 消费 Commit -1 的 `T0.0e` 已交付 validator，对 T0.0f 的 A/P/树外 15-run evidence 做 fail-closed 预检。

因果图已裁：Commit -1 合 master得 A → 从 A 建执行树 → **T0.0f 树外跑 15 次/manifest 并在 master 提交 pointer P** → **T0.0d 验证** → 执行树以 receipt 进入 T0.1/Commit 0。不得把 15-run 归回 T0.1，也不得让 T0.0d 生成自己要验证的 evidence。不能用未来 A/15/P 验过去 Commit -1；也不能从当前 master/P 起执行以重定义 A。

## 必读

1. `docs/rfc/2026-08-03-generation-emission-command-algebra/design.md`：RFC §7.1 entry 前稳定基线。
2. `docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md`：§0.2、§0.3、§0.4b、§0.4f、Commit -1 收口与 post-merge preflight。
3. `docs/rfc/2026-08-03-generation-emission-command-algebra/traceability.md`：§6 `T0.0d` 的 post-merge 归属。
4. `docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md`：已裁 Commit -1 图与 entry-evidence pointer 状态行。
5. `docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md`：集中红线。

## 前置与停止条件

必须已经存在：Commit -1 已合 master、其合入后 master SHA=A、从 `ENTRY_SHA=A` 显式创建且干净的执行树、Commit -1 版本化 validator。**15-run manifest 与 pointer P 此刻尚不存在，它们由本 phase 的 T0.0f 生成。**

T0.0f 任一 run 非绿、identity/skip 集漂移、HEAD/tree 漂移时立即停，**不得生成 P**。T0.0d 时若缺 pointer/manifest/任何 log/JUnit/字段/hash，或 Git 图不成立，**立即 fail-closed**，不得把 HANDOVER pointer 当「曾经通过」的自述继续 Commit 0。

## 改动锚点

| 对象 | master `file:line` | 用途 |
|---|---|---|
| `baseline-runs.sh` OUT 分支 | `exp/inter-block-anchor-allocator/baseline-runs.sh:105-107` | 15-run 原始证据必须用 `$TREE` 外绝对 `OUT` |
| baseline structured log fields | `exp/inter-block-anchor-allocator/baseline-runs.sh:134-148` | 每 run 的 `evidence_timing`/`measured_sha`/`claims_current_head` 原始格式 |
| HANDOVER 已裁图 | `docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md`「用户已裁决」表 | pointer P 的唯一状态线 |

完整十行 validator 条件/EV mapping 的唯一事实源是 `docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md` §0.4f。

## 本 phase task 集合（唯一归属）

<!-- prompt-task-ids: T0.0f T0.0d -->

| Task | TDD 施工顺序 |
|---|---|
| `T0.0f` | 在干净的 `ENTRY_SHA=A` 执行树上，显式 `EVIDENCE_TIMING=closeout`、绝对树外 `OUT` 跑 15 次实际 shards，生成原始 logs/JUnit 与 evidence-manifest v1；任一失败不得写 pointer。全部绿后，在 master HANDOVER 写唯一 pointer block 并提交 P，机械验 A 是 P 祖先、P 不合回执行树。详细 schema/字段只读 plan §0.4f。 |
| `T0.0d` | **不实现 validator、不生成第二批 evidence、不重跑合成 EV mutation。** 传入完整 `ENTRY_SHA=A` 与 `POINTER_SHA=P`，调用 Commit -1 已版本化的 validator：`cd /home/xp/src/copilot-api-js && bun run scripts/validate-entry-evidence.ts --entry-sha "$ENTRY_SHA" --pointer-sha "$POINTER_SHA" --tree "$TREE" --handover docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md`。对 T0.0f 的真实 artifacts 跑正样本；任何缺失/不等即停。 |

## 验收 gate

1. 显式从 A 建执行树：`test "$(git -C "$TREE" rev-parse HEAD)" = "$ENTRY_SHA"`；并要求 tree clean。
2. T0.0f 生成的 `POINTER_SHA` 可由当前 master 到达；`git show "$POINTER_SHA":docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md` 含唯一 versioned pointer block；A 是 P 祖先。
3. 树外 manifest 存在且 hash 与 pointer 一致；恰 15 原始 logs/JUnit；所有结构化字段为 closeout/40 位 A/current-head true；每 run 的原始重算与 manifest 一致。
4. validator CLI rc=0，并产出 versioned verdict/receipt 后才可进入 `commit-0.md`。本 phase 不产生 cutover semantic commit；只有 master pointer P 是状态提交。
5. 需要重新验证 validator 本体时，回 Commit -1 的合成 fixture，**不在真实 A/P 上现场改 validator**。

## 提交指引

本 phase 的真实 evidence 产物含当前 SHA，必须落 `$TREE` 外；HANDOVER pointer P 只定位它们，不反向定义 A。若要归档，归档是副本且不合回执行分支。显式 pathspec、Conventional Commit、无署名、绝不 push 的红线见 README。

## 红线

集中红线见 `docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md`。尤其禁止：从当前 master/P 建执行树；把 P 合回执行分支；用 manifest 内部自洽代替原始 artifact 重算；碰 4141。
