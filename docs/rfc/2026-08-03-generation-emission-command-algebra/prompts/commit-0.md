# Kick-off：Commit 0 —— Legacy 基线、旧缺陷 characterization 与 oracle 分型

<!-- prompt-task-ids: T0.1 T0.2 T0.3 T0.4 T0.5 T0.6 T0.7 T0.8 T0.9 T0.10 T0.11 -->

## 背景 + 为什么

Commit 0 不改 production。它冻结旧 generation delivery 的完整能力面、O-1/O-2/O-6/现有 goldens、pre-owner 边界，并让旧缺陷以**rc=0 的 defect-present characterization**可重复观察。它必须运行在 post-merge preflight 已绿的 entry A 执行树上。

## 必读

1. `docs/rfc/2026-08-03-generation-emission-command-algebra/design.md`：§7.1/§7.2/§7.3、§10.1/§10.2 R-1/R-3/R-11/R-13。
2. `docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md`：§0.2～§0.4f、Commit 0、Commit -1/post-merge 依赖。
3. `docs/rfc/2026-08-03-generation-emission-command-algebra/traceability.md`：R-1/R-3/R-11/R-13 与 T0.* 反向出处。
4. `docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md`：entry A/P 图、已裁事项。
5. `docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md`：集中红线。

## 前置与停止条件

- T0.0f 已在 A 上生成唯一 15-run evidence/manifest/P；T0.0d post-merge preflight 已消费验证并产出绿 receipt；显式 `ENTRY_SHA=A` 执行树 HEAD=A。
- Commit -1 runner oracle/validator 未交付、T0.0f evidence 未生成或 T0.0d 消费门未过，**不得开始 T0.1**。
- T0.6 的 RFC/plan/matrix exit 语义已对齐：red 描述缺陷仍在，测试自身 rc=0；不要重新引入红测试 vs 全绿的终态冲突。

## 改动锚点

| 对象 | master `file:line` | 用途 |
|---|---|---|
| `ClientSink` | `src/lib/pipeline/types.ts:747` | 双向 capability closure 种子 |
| `OwnerRawSink` | `src/lib/pipeline/delivery/types.ts:12` | closure 种子/raw boundary |
| `DownstreamDeliverySession` | `src/lib/pipeline/delivery/session.ts:57-67` | closure 种子与 B 集 |
| raw SSE/WS emit | `src/lib/pipeline/client-sink.ts:209,645` | T0.3 recorder 探测深度 |
| warmup writes | `src/lib/anthropic/warmup.ts:214,230,243` | T0.4 Q3 A witness |
| AUQ writer | `src/routes/messages/error-shaping-glue.ts:131` | T0.5 pre-owner witness |
| observer seam | `src/lib/pipeline/delivery/session.ts:74` | delivery session observer |

完整 factory/锚点表以 `docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md` Commit 0 为准。

## 本 phase task 集合（唯一归属）

<!-- prompt-task-ids: T0.1 T0.2 T0.3 T0.4 T0.5 T0.6 T0.7 T0.8 T0.9 T0.10 T0.11 -->

| Task | TDD 施工顺序 |
|---|---|
| `T0.1` | **不跑第二批 15-run。** 读取 T0.0d 的 versioned verdict/receipt，确认 receipt 的 `ENTRY_SHA=A` 等于当前执行树 HEAD、tree clean、validator verdict 绿；任一不等在 T0.2 前 fail-closed。 |
| `T0.2` | O-6 未改动树正样本与一字节 mutation 双控；显式 timing，禁止 recapture。 |
| `T0.3` | 先验证零 direct-send 是平凡假绿，再让 recorder 包 composition root 实 handle，test-only direct-send seam 必须被看见。 |
| `T0.4` | warmup fake/drop route：完整字节、upstream 零调用、observer 零 session、一次响应；提前 owner/双写 mutation 红。 |
| `T0.5` | AUQ 与四格式 non-streaming observer 基线；提前 owner mutation 红。 |
| `T0.6` | rc=0 characterization：绿=旧分裂仍在；先反写确认目标红。记录三样头部说明；Commit 4 必须反转，不得 skip/todo。 |
| `T0.7` | 双向不动点 closure：声明 identity 种子、向上/向下、any/unknown unclassified、A/B/C/D 互斥 disposition；只向上 mutation 红。 |
| `T0.8` | 四类 test surface 分档；旧 adversarial seam 仍能造分裂。人口在 A 上重算，不抄旧 inventory 数。 |
| `T0.9` | golden 清单/hash/守护不变量；注入重排先红。 |
| `T0.10` | 建立共同门树向判据：脚本声明的 `repo`/`server_entry`/timing/sha；判据随后每 commit 复跑。 |
| `T0.11` | test-oracle manifest：文件、runtime test names、identity/迁移槽位；默认 runner 删除测试应绿的正样本先证实。 |

## 验收 gate

- R-13、R-1 recorder 自检、R-3 C0 characterization、R-11/O-6；共同门指向 plan §0.3/§0.4b，O-6 byte-critical。
- Commit 0 invariant：production 不变、A/B/C/D 全存活、新 core 不存在、T0.6 绿=缺陷在。
- Gate/命令/树向绑定不在这里复制，按 plan §0.3/§0.4b 执行。

## 提交指引

显式 pathspec、Conventional Commit、无模型署名、绝不 push；进度文件随本 commit 提交。Commit 0 不产生 authority，禁止把任何准备代码接进 live route。

## 红线

集中红线见 `docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md`。特别禁止：在 `$TREE` 做 T0.0 mutation、重捕 O-6、把 pre-owner writer 强塞 owner、碰 4141。
