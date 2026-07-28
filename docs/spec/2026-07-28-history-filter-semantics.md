# Spec B：History 过滤语义收敛与 model 过滤可索引化

- 状态：草案，待用户裁决 §6 后冻结
- 日期：2026-07-28
- 依赖：[Spec A：History 读路径性能核心重构](2026-07-28-history-read-path-core.md) 的派生列与索引基础设施。**B 依赖 A，但 A 不依赖 B**——A 只下推语义已一致的过滤维，`model` / `search` / `success` 三维留给本 spec。
- 姊妹文档：[待办 C：任意 filter 组合的 exact total](../todo/history-filtered-exact-total.md)

## 1. 问题：三份平行过滤实现，语义互不相同

同一套过滤语义现存三份实现，**对同一查询参数给出不同答案**。这是既有缺陷，不是本次改造引入的：

| 条件 | `matchesFilters`（`queries.ts:37`） | `summaryMatchesFilters`（`queries.ts:64`） | `recordMatchesQuery`（`projection.ts:448`） |
|---|---|---|---|
| `success=false` | `state === "failed"`（aborted 不算） | `responseSuccess === false` | `state !== "completed"`（aborted 算） |
| `model` 来源 | client request model + `resolveResponseModel(最终响应)` | `requestModel` / `responseModel` | `routing.requestedModel` / `routing.resolvedModel` |
| `endpoint` 来源 | `entry.endpoint` | `summary.endpoint` | `record.ingress.format` |
| `search` | in-flight 走全文 `extractInboundSearchText` | **根本不过滤** | 不过滤 |
| `state` / `agentId` / `mainAgentOnly` / `pid` | **全缺** | 有 | 有 |

附带缺陷：

- `summaryMatchesFilters` 内 `state` 与 `pid` 各**重复出现两次**（`queries.ts:78-84`）。
- `QueryOptions` 注释声称「state wins」（`types.ts:580-586`），但三份实现都**同时**应用 `success` 与 `state`，冲突组合返回空集——注释与实现不符。
- `EndpointType`（`types.ts:32-34`）**不含 `openai-embeddings`**，而 embeddings producer 写该 format（`routes/embeddings/route.ts:47-52`）。`operationKind=embeddings` 与 endpoint 过滤的契约有缺口，SQL 与内存路径都会出现不可表达值。

### 1.1 `search` 参数实际上不生效

`queries.ts:84-88` 的注释写着「persisted list path filters `search` in SQL (`preview_text LIKE`)」，但当前 persisted 路径是 `visitV3Summaries`，SQL 里**没有 LIKE**。该注释指向的是已退役的 V2 SQL 路径。

**实际行为：`?search=` 只对 in-flight 生效，对 persisted 结果完全不过滤。** 陈旧注释掩盖了一个真实的行为缺陷。

### 1.2 `model` 过滤无法靠 B-tree 索引

`model` 是**大小写不敏感 substring** 匹配（`queries.ts:70-74`），且语义是「`requestModel` 或 `responseModel` 任一包含」。B-tree 无法优化前导 `%`。

Spec 早期草案提出用一张 `v3_models(model PK)` 维度表——substring 只在几十行的维度表上做，再用 `IN (...)` 走大表索引。**评审证伪了这个方案的完整性**，实测：

```sql
SELECT * FROM o
WHERE request_model IN ('a','b') OR response_model IN ('a','b')
ORDER BY created DESC, id DESC LIMIT 50
```

```
MULTI-INDEX OR
  INDEX 1 → SEARCH o USING INDEX irq (request_model=?)
  INDEX 2 → SEARCH o USING INDEX irs (response_model=?)
USE TEMP B-TREE FOR ORDER BY          ← 违反 Spec A §6 的判据
```

`OR` 跨两个索引会退化成 `MULTI-INDEX OR` 并重新引入临时排序。而且纯 model 名集合只有加法语义：将来 delete / repair 后无法知道某 model 是否仍被引用，正确移除需要引用计数或成员关系。

## 2. 设计

### 2.1 operation-level model membership（**设计待重做，见 §2.1.1**）

取代 `v3_models(model PK)` 的方向是对的——需要一张按 model 索引、可有序取 operation 的成员表。但**下面这版 DDL 已被 round 4 评审实测证伪，不可直接实施**：

```sql
-- ❌ 已证伪，仅作记录
CREATE TABLE v3_operation_models (
  normalized_model TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (normalized_model, created_at DESC, operation_id DESC, source)
);
```

实测（Bun SQLite 3.53）：

```sql
SELECT operation_id, created_at FROM m
WHERE normalized_model IN ('claude-opus','claude-sonnet')
ORDER BY created_at DESC, operation_id DESC
```

```
SEARCH m USING COVERING INDEX sqlite_autoindex_m_1 (normalized_model=?)
USE TEMP B-TREE FOR ORDER BY          ← 跨 model 仍需重排
```

两个缺陷：

1. **主键只保证单个 `normalized_model` 分区内有序**。needle 匹配多个 model 时跨分区仍要重新排序——与 §3.2 的验收判据直接冲突。
2. **同一 operation 会重复出现**。文档原称「相同则去重」，但主键含 `source`，同一 model 的 request/response 两行并不冲突。加 `DISTINCT` 后计划变成 `USE TEMP B-TREE FOR DISTINCT` + `USE TEMP B-TREE FOR ORDER BY`，更糟。动态 `UNION ALL` 能产生 `MERGE` 但仍返回重复 operation；`UNION` 能去重但去重本身需要额外机制，且 cursor 与 exact total 都还没定义。

#### 2.1.1 重做时必须同时满足的约束

- 一个 operation 在查询结果中**最多出现一次**
- 多个匹配 model 的结果**有序归并**，无 temp B-tree
- keyset cursor **不因重复 membership 而跳过或重复** operation
- exact total 按 **operation** 计数，不是 membership 行数
- request / response 的 `source` 仍可用于诊断与重建

候选形状（plan 阶段 PoC 择优，本 spec 不预先钦定）：

- operation 级一行保存规范化 model 集合，另建 model → operation 倒排成员
- 动态 SQL merge 后按 operation ID 做**可证明正确**的去重 frontier
- bitmap / 倒排结构直接提供 operation 集合

**在此设计重做并经 PoC 实测前，§3.2 的「无 temp B-tree」与 §3.5 的重建等价不可验收。**

**DDL 完整性约束**（无论最终形状如何，下列不得遗漏）：

```sql
CHECK(source IN ('request','response'))
UNIQUE(operation_id, source)          -- 一个 operation 每个 source 至多一个 model
```

是否使用 SQL 外键需与 V3 当前的 logical-reference 策略一致；若不用 FK，必须写明完整性由 contribution producer、`clearV3Store` 与重建 oracle 共同维护。**「request 与 response 是同一 model 时是否跨 source 去重」必须成为明确契约**，不能留给实现决定。

**大小写语义**：SQLite `LIKE` 默认只对 ASCII 大小写不敏感，与 JS `toLowerCase().includes` 不等价；`%` / `_` 需转义。由于匹配只发生在几十行的 distinct 集合上，两种实现都不触及大表——存小写形式，或在应用侧对 distinct 集合做 JS 匹配。plan 阶段择一并锁定语义等价测试。

### 2.2 收紧 `requestBucket` 后再复用为公开 filter 原语

`requestBucket`（`stats.ts:54`）是项目里已有的、单返回值、互斥分桶的正确原语，其注释记录了它修掉的真实 bug（`state==="completed" || responseSuccess===true` 双条件让一个请求同时进 success 与 failure，两者之和超过 total）。**它的分桶设计应当复用，但不能未经收紧就直接当作公开 `success` filter 的语义。**

问题在它的 fallback：

```ts
export function requestBucket(summary: { state?: string; responseSuccess?: boolean }): RequestBucket
// default 分支：responseSuccess === true → success；=== false → failure
```

- 参数类型是宽松的 `state?: string`，而真实 lifecycle 是 `RequestLifecycleState = "pending" | "executing" | "streaming" | "completed" | "failed" | "aborted" | "interrupted"`（`types.ts:46`，本 spec 作者核实）。
- 该 fallback 是为「没有 terminal verdict 的旧/临时 summary」设计的。persisted operations 全是 terminal，不需要它；只有内存源会遇到 active 状态。
- 后果：一个 `streaming` 且带 `responseSuccess` 的 entry 会匹配公开的 `success=true`，与 `terminalOnly` / state filter 未必一致。

**收紧方案**：

- 参数类型改为 `RequestLifecycleState | undefined`
- 仅 `state === undefined` 时才允许 `responseSuccess` fallback
- `pending` / `executing` / `streaming` 固定返回 `none`
- stats 继续使用同一基础分类器，但「未知状态 fallback」不成为公开过滤语义

### 2.3 单一 SQL 谓词权威

persisted 一路的过滤收敛为**单一 SQL 谓词定义**；`recordMatchesQuery`（保留给 in-flight / terminal-bus 内存对象）必须与之逐条对齐，并配双向验证守卫。`matchesFilters` 与 `summaryMatchesFilters` 合并消灭。

同时修正：

- 删除 `summaryMatchesFilters` 里 `state` / `pid` 的重复判断
- 修正 `QueryOptions` 的「state wins」注释——实际语义是 `success` 与 `state` 同时应用（AND），冲突组合返回空集

> `EndpointType` 补齐 `openai-embeddings` 的修复**已移入 Spec A** §5.7.4——它是 canonical producer 的事实校正，且 A 的 migration gate 直接依赖它（否则合法 embeddings record 会被判 poison）。本 spec 只负责 endpoint 谓词的统一实现。

## 3. 验收判据

1. SQL 谓词与收紧后的 `recordMatchesQuery` 对同一组样本给出**逐条相同**的结果，覆盖 `success` × `state` 冲突组合、aborted / interrupted / active、`agent_id IS NULL` 的 `mainAgentOnly`。
2. `model` 过滤查询的 `EXPLAIN QUERY PLAN` **无 `MULTI-INDEX OR`、无 `USE TEMP B-TREE`**。
3. `model` 过滤结果与既有 JS substring 语义逐条一致（含大小写、`%`/`_` 字面量、Unicode）。
4. `search` 参数的行为与 §6-1 的裁决一致，且不再有与实现不符的注释。
5. `v3_operation_models` 可从 canonical operations 完整重建，且与增量维护结果逐行相等。

## 4. 测试策略

- **过滤语义收敛**（it）：单一样本集喂 SQL 谓词与 `recordMatchesQuery`，逐条比对。
- **分桶收紧**（unit）：`pending`/`executing`/`streaming` 恒返回 `none`；`state === undefined` 时才走 `responseSuccess` fallback；覆盖 `state=failed && responseSuccess=true`。
- **model 查询计划守卫**（unit）：断言无 `MULTI-INDEX OR` / 无 temp B-tree，**配正样本对照**（先用 `OR` 双索引形状证明守卫会红）。
- **model 语义等价**（it）：随机 model 名 + 随机 needle，SQL 结果与 JS `toLowerCase().includes` 逐条比对。
- **membership 重建等价**（it）：增量维护 vs 全量重建。
- **membership 生命周期**（it）：`clearV3Store` 一并清空；同一 operation 重复提交不产生重复行。

## 5. 未采纳方案

**`v3_models(model PK)` 纯名字集合。** 实测会在外层产生 `MULTI-INDEX OR` + temp B-tree（§1.2），且只有加法语义、无法正确处理删除。membership 表是它的严格超集。

**为 persisted `search` 下推 `preview_text LIKE`。** 会与 in-flight 的 normalized 全文语义制造第二套定义，且 B-tree 优化不了前导 `%`。

**直接复用未收紧的 `requestBucket` 作为公开 filter 原语。** 会把面向 stats 的宽松 fallback 扩散成产品过滤契约（§2.2）。

## 6. 裁决记录

用户 2026-07-28 裁决如下，本 spec 据此冻结（§2.1 的 membership 设计除外——它需要先做 PoC，见 §2.1.1）。

**6-1 `search` 的归属：保留参数，带 `search` 时 persisted 部分返回空；扩展 sidecar 记入 backlog。**

现状是最糟的形态：`?search=` 对 persisted **完全不过滤**，于是返回**未经过滤的全部结果**冒充搜索结果（§1.1）。用户裁决的形状比「移除参数」破坏性小（不改 API 形状、不动两个 UI 的调用），比现状诚实（不再拿未过滤结果冒充命中）。

精确语义（实现必须照此，不得自行放宽）：

- 请求带 `search` 时，**persisted 一路返回空集**，`total` 只计 in-flight 侧的匹配数
- **in-flight 一路仍按 `extractInboundSearchText` 全文匹配**（现状行为，`queries.ts:104-110`），不受影响
- 响应中应有可被前端识别的标记，说明 persisted 全文搜索未在此端点提供、请改用 `/history/api/search`——具体字段名在 plan 阶段定，但**不得静默**
- 同时删除 `queries.ts:84-88` 那条声称「persisted list path filters search in SQL (`preview_text LIKE`)」的陈旧注释（它指向已退役的 V2 路径）

**扩展 Tantivy sidecar 以真正支持列表端点的 `search`** 记入 backlog 独立立项 → [待办：让列表端点的 search 真正生效](../todo/history-list-search-sidecar.md)。评审已证明现有 sidecar 撑不起列表契约：只有 top-N score 查询，没有 stable keyset、exact total、列表 filters、双向分页，且空 hits 与 sidecar 不可达无法区分（`search.ts:20-24,59-73`、`uds-client.ts:132-145`）。

**6-2 `success` 的语义边界**：采纳收紧后的 `requestBucket`（§2.2）——`success=true` ⇔ bucket = `success`，`success=false` ⇔ bucket = `failure`，**aborted / interrupted 两边都不匹配**。「被中断」与「失败」在诊断时意义完全不同，合并会丢信息。

**6-3 `success` 与 `state` 的求值顺序**：**保持 AND 语义**（冲突组合返回空集）。三份现有实现都是这么做的；`QueryOptions` 注释里那句「state wins」是**注释错误**，改注释而非改行为。
