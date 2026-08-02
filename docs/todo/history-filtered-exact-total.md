# 待办 C：任意 filter 组合的 exact total 与总量解耦

- 状态：**已排期**（用户 2026-07-28 裁决），排在 Spec A / Spec B 之后
- 日期：2026-07-28
- 来源：从 History 读路径性能重构草案中拆出。姊妹文档：[Spec A](../spec/2026-07-28-history-read-path-core.md)、[Spec B](../spec/2026-07-28-history-filter-semantics.md)

## 根因

`GET /history/api/entries` 返回的 `SummaryResult.total`（`types.ts:721-726`）是**精确计数**，且是公开契约——`ui/`（`useHistoryData.ts:119-163`）与 ui-v4 都消费它，`/api/status` 也依赖同一条路径取全局 total。

带过滤的精确计数在关系型存储上是 O(匹配行数)：`COUNT(*) WHERE state='completed'` 必须遍历全部匹配的 index entry。covering index 只降低常数因子，**不改变复杂度**。评审实测的计划：

```
COUNT(*) 无谓词  → SCAN t USING COVERING INDEX ix
COUNT(*) 带谓词  → SEARCH t USING COVERING INDEX ix
```

两者都是正确计划，但都要走遍匹配集合。

## 当前行为（Spec A 落地后）

Spec A 把这条路径从「O(全库) 且 hydrate 2.0 GB BLOB」改善到「O(匹配行数) 且只读 covering index」——量级改善数个数量级，但复杂度类别未变：

| 场景 | Spec A 后 |
|---|---|
| 无过滤 total（`/api/status`） | **O(1)**，读 `v3_stat_counters` |
| 高选择性过滤（`sessionId=X`、`pid=N`） | O(匹配行数)，匹配集很小，实际 < 50 ms |
| 低选择性过滤（`state=completed`、常见 endpoint、很早的 `from`） | O(匹配行数)，仍随历史总量线性增长 |

Spec A §4 已把这一点写入**非目标**并在 §6 验收判据里明确不承诺低选择性组合与总量解耦——不用 covering SEARCH 冒充复杂度已改变。

## 为何排期做（而不是暂缓）

用户 2026-07-28 裁决：**做，排在 Spec A / Spec B 之后。**

**定位要点（避免误读）：整个 History 读路径的性能投入不是为了给 `ui/`（Vue，退役中）续命，而是为之后增强 ui-v4 打基础。** C 同理——它准备的是 ui-v4 将来引入弱筛选、跨会话检索、统计视图时所需的、与历史总量解耦的 exact total 能力，而不是补救退役前端的查询体验。

**必须纠正一个早期草案里的错误判断**：本文档曾写「低选择性过滤的唯一 UI 入口正在退役」并据此主张暂缓——**这个事实判断是错的**。退役的是 ui-v4 的全局请求列表页；`ui/` 的 Activity 页**仍是活代码**，且提供 model / search / pid / endpoint / state 弱筛选与 exact total：

- `ui/src/pages/vuetify/VActivityPage.vue:55-64`（model / search / pid 输入）
- `ui/src/pages/vuetify/VActivityPage.vue:236-244`（endpoint / state 下拉）
- `ui/src/composables/history-store/useHistoryData.ts:119-143`（消费 `total` 与双向游标）

但这条更正**不是**排期做 C 的理由（`ui/` 正在退役，不为它投入）。排期依据是上一段的 ui-v4 前瞻。

**为何仍要排在 A / B 之后**：C 的正确解法是一套可组合的统计结构（见下节），复杂度与风险都与「修复慢查询」不在一个量级；而 Spec A 已把这条路径从「O(全库) 且 hydrate 2.0 GB BLOB」改善到「O(匹配行数) 且只读 covering index」，并把无过滤 total 变成 O(1)。先拿到 A 的量级改善，再在其 `OperationProjectionContribution` 基础设施上做 C，比捆绑推进更稳。

## 理想架构（若做）

需要一套可组合的统计结构，三选一或组合：

- **维度 cube / registry**：为常用离散维组合（`state` × `endpoint` × `operationKind` 等）预聚合计数，增量维护。问题是组合爆炸，需要限定 registry 而非任意组合。
- **时间分桶累计结构**：`from` / `to` 的范围计数用按时间桶的前缀和回答，把范围 count 变成 O(桶数)。
- **bitmap / inverted membership**：每个离散维值维护一个 operation bitmap，任意组合过滤 = bitmap 求交，`cardinality()` 即 exact total。这是唯一能真正支持**任意**组合的形状，代价是 bitmap 的存储与增量维护复杂度。

参考：本项目已有的 `telemetry.db` 三层 rollup + DDSketch（skill `telemetry-architecture`）是同族问题的既有解法，其「registry 三支柱」模式（提取下沉 sink 层、开放 counters bag、聚合后不可重算的因子拆最细）可直接借鉴。

## 若做需改什么

- `persistedSummaryCandidates` / `getHistorySummaries` 的 count 分支改查统计结构而非 `COUNT(*)`
- 新增统计结构的增量维护，接入 Spec A §5.5 的 `OperationProjectionContribution`（**不要另起一套 contribution 拼装**，那正是 Spec A 在消灭的漂移源）
- 全量重建路径与 oracle 测试，判据同 Spec A §7（ground truth 从 canonical fixture 独立声明，不复用 contribution producer 自证）
- `clearV3Store` 一并清空
- 迁移：若在 Spec A 之后做，需要自己的 001+ migration 与 backfill；bitmap 方案的 backfill 成本需先 PoC 实测

## 启动时机（已排期，此节用于确认「该动手了」）

C 排在 Spec A / Spec B 之后。下列任一成立即应开工，且都可探针验证、不靠「感觉慢了」。基准查询集合固定为：`state=completed`（无其它条件）、常见 `endpoint`、跨全历史的 `from`，各自单独一维。

- **ui-v4 增强真正需要它**（主要依据）：ui-v4 引入弱筛选列表、跨会话检索或统计视图，且这些视图消费 exact total。
- **弱筛选路径的实测退化**：生产规模下基准查询集合的 exact total **p50 > 100 ms**，或该请求进行中 `/health` **p99 > 50 ms**。
- **高选择性路径也开始受影响**：`sessionId=X` 限定的查询 p50 > 50 ms（说明 O(匹配行数) 在当前规模已不足）。
- **API 消费者痛点**：外部脚本 / 诊断工具对低选择性 exact total 的实测耗时超出其可接受阈值（需该消费者给出具体数字）。

探针方式与 Spec A 的验收判据一致：生产库只读探针 + `/health` 并发探测，**不外推分页样本**（早期调查中的均值偏倚与非线性双陷阱见 PoC `FINDINGS.md`）。
