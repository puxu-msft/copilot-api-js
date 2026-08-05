# generation emission command algebra —— 第三层 kick-off 导航

> 本目录是 skill `large-refactor` §5 的第三层：`docs/rfc/2026-08-03-generation-emission-command-algebra/design.md` 冻结 WHY + 契约，`docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md` 冻结 HOW + 锚点与 task，本文与同目录 prompt 是面向独立执行者的派发件。**所有路径均从仓库根解析**，不按 prompt 文件所在目录解析。
>
> **Task 人口 SSOT 是 cutover plan 的 task 定义表集合，不是本文的数字。** 当前 checker 派生多少就必须分派多少；新增 task 时 prompts 随集合增长，绝不为凑旧数字排除 `T0.0d`／`T0.0f` 或其他已放行 task。

## 必读顺序

1. `docs/rfc/2026-08-03-generation-emission-command-algebra/design.md`——冻结的架构合同、RFC §7 commit 边界、§9.3 调查缝、§9.4 停点、§10.2 验收 oracle。
2. `docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md`——第二层任务 TDD、factory/锚点表、共同门、Commit -1／post-merge preflight 的因果图、已知边界。
3. `docs/rfc/2026-08-03-generation-emission-command-algebra/traceability.md`——R/O 归属、调查缝、停点与 plan task 反向追溯。
4. `docs/tmp/2026-08-05-command-algebra-progress-prompts.md`——第三层文档的进度；执行阶段另建一 agent 一文件的进度文件。
5. 本文件的红线与对应 phase prompt。

## Phase 导航与依赖

| Phase prompt | 负责的 task 集合 | 前置 | 后继 | 串行性 |
|---|---|---|---|---|
| `commit-minus-1.md` | Commit -1 的 runner oracle 与 versioned evidence validator | 已放行 plan | 合 master 得 A | 严格串行起点 |
| `post-merge-preflight.md` | T0.0f 生成真实 15-run/manifest/P；T0.0d 消费验证 | Commit -1 合 master得 A；从 A 建执行树 | Commit 0 | 严格串行；不产生 cutover commit |
| `commit-0.md` | legacy baseline / characterization / oracle 分型 | post-merge preflight 全绿 | Commit 1 | byte-critical 串行链起点 |
| `commit-1.md` | capability types / profile registry | Commit 0 | Commit 2 | 严格串行 |
| `commit-2.md` | owner state / serializer primitives | Commit 1；§11 #5/#6 已裁 | Commit 3 | 严格串行 |
| `commit-3.md` | builders / LegHandle / publish harness | Commit 2 | Commit 4 | 严格串行 |
| `commit-4.md` | atomic authority publish | Commit 3；§11 #6 已裁；本 phase 先补 §9.3 slots 与 T4.1 Q5 diff，**T4.2 前停门** | Commit 5 | **唯一 authority publish，绝对不可拆** |
| `commit-5.md` | telemetry + History detail | Commit 4；**Q1 内容首次裁决 + `PHASE=post` gate** | Commit 6 | 严格串行 |
| `commit-6.md` | legacy deletion / audits | Commit 5 | Commit 7 | 严格串行 |
| `commit-7.md` | golden/oracle audit | Commit 6 | Commit 8 | 严格串行；production 零改动 |
| `commit-8.md` | docs sync / merged-state closeout | Commit 7；Q2；continuation ADR D2 的 P8 待办不得删除 | 执行结束 | 严格串行 |

### 依赖 DAG

```mermaid
flowchart LR
  M1[Commit -1] --> P[Post-merge preflight]
  P --> C0[Commit 0]
  C0 --> C1[Commit 1]
  C1 --> C2[Commit 2]
  C2 --> C3[Commit 3]
  C3 --> C4[Commit 4 atomic publish]
  C4 --> C5[Commit 5 Q1 gate]
  C5 --> C6[Commit 6]
  C6 --> C7[Commit 7]
  C7 --> C8[Commit 8]
```

**没有可并行的 implementation phase。** Commit -1、post-merge preflight、Commit 0～8 共享 `scripts/parallel-test.ts`、delivery/session/types/client-sink、route roots、architecture tests、live docs 与同一 byte-critical wire 链。准备代码看似独立也不能并行发布：Commit 1～3 的 invariant 是旧能力 population 与 Commit 0 机械相等，Commit 4 必须一次切完所有 producer。

## 共享文件与合并顺序

| 范围 | 共享承重文件 | 顺序纪律 |
|---|---|---|
| Commit -1 | `scripts/parallel-test.ts`、其 validator 与 tests | 先独立收口并合 master，才生成 A；不可与 Commit 0 混提交 |
| Commit 0 | inventory/oracle tests、architecture tests、`docs/tmp` evidence | 只冻结 legacy，不接新 owner |
| Commit 1～3 | `src/lib/pipeline/{types,client-sink,driver}.ts`、`delivery/**`、Anthropic helpers、测试 adapters | 同一链严格串行；准备期不切 production call site |
| Commit 4 | route handlers、WS、driver、delivery、client-sink、History、tests/goldens | 一个 semantic commit；不拆 authority、producer、terminal、WS control、lookup 收口 |
| Commit 5 | `packages/telemetry/**`、`src/lib/observability/**`、History、`ui-v4/` re-export/tests | Q1 前不可动；先明确 schema/查询裁决 |
| Commit 6～8 | legacy surfaces、architecture guards、goldens、README/DESIGN/plan/ADR references | 先删定义再审 golden，最后同步文档；不要倒序 |

## 红线（集中）

1. **只执行已放行的 plan。** 不新增签名、不重开**已裁事项**、不把已知边界伪装成机械闭合；截至派发时仍未裁的 Q1/Q2/#5/#6，**只在各自 plan 触发点取得首次裁决，裁后不得重裁**。签名三问答不上就按 plan 停门，交付已完成部分与具体缺口。
2. **Commit -1 与 post-merge preflight 不得因果倒置。** `T0.0a/b/c/e` 在 Commit -1 生产 runner oracle/validator；`T0.0d` 只在 P 后消费真实 A/P/15 artifacts。
3. **入口图固定。** Commit -1 合 master得 A；执行树必须显式从 `ENTRY_SHA=A` 建；P 是状态 pointer，不合回执行分支重定义 A。
4. **共同门按 `docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md` §0.3/§0.4b 跑。** O-6/entry evidence 必须显式 `EVIDENCE_TIMING=dev|closeout`；收口趟才判 `head`/`tree`；自指产物落树外。
5. **变异只走同一 plan 的 §0.4e。** 在含真实实现的第二隔离树/`/tmp` repo，或用冻结 exact patch；先证 hunk 真变、读目标 FAIL；共享树不得整文件恢复；reverse check 失败即停。
6. **生产变更判据只走 plan §0.4a 的 tracked-minus-exclusions wrapper。** 临时 exclusion 只开发趟，收口前独立裁决；收口拒绝残余豁免。
7. **不碰 4141。** O-6/测试服务器仅用非 4141 端口；只精确清理自己启动的 PID，绝不 `pkill`/`killall`。
8. **提交纪律。** 显式 pathspec、Conventional Commit、无 `Co-authored-by`、绝不 `git push`；每个 semantic commit 完成后更新自身 progress 文件并一起提交。
9. **测试红不等于过时。** 改/删 guard 前记录它守的 invariant 与依据，独立 reviewer 或用户裁后才放宽。
10. **byte-critical 链不可用新 golden 自证。** O-1/O-2/SDK oracle 先绿；Q5 diff 批准范围内才改 golden；O-6 fixture 永不重捕。

## Prompt task-population checker 契约

`exp/inter-block-anchor-allocator/prompt-task-check.py` 是本层的机械 checker，已随 prompts 落盘。运行：

```bash
cd /home/xp/src/copilot-api-js && python3 exp/inter-block-anchor-allocator/prompt-task-check.py
```

- 从 cutover plan 各 Commit「逐 task」表第一列的结构化 task definition 解析完整 grammar `T\d+\.\d+[a-z]?`，**不扫描全文历史 mention／交叉引用**；
- 从 `prompts/commit-minus-1.md`、`post-merge-preflight.md`、`commit-0.md`…`commit-8.md` 的「本 phase task 集合」双 marker 解析 task 集合；marker 两份不一致也红，但每 prompt 只计一份归属；
- 要求集合精确相等、每个 task 在 prompts 恰出现一次、无孤儿 prompt task，且**prompt owner 与 plan 的父级 phase 一致**（把 T2.8 搬到 Commit 3 表必须报 wrong-phase）；
- 输出 `plan tasks: N`、`prompt tasks: N`、`duplicates: none`、`orphans: none`、`unassigned: none`、`wrong-phase: none`；N 从 plan 派生，**不得硬编码**；
- 支持 `PLAN=`／`PROMPTS=` 覆盖路径，在副本上跑 mutation；
- 已实跑字母后缀正控：`T4.0d→T4.0z` 报 `orphan prompt tasks: ['T4.0z']` + `unassigned plan tasks: ['T4.0d']`；删除 `T0.0e` 报 `unassigned plan tasks: ['T0.0e']`；未变异正确集合绿。

不许用「人工数过」冒充通过。
