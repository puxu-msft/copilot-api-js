# A3 合并态独立复评 round 5

- **评审范围**：`17b33b67..cd80497a605b96335d99404347b5bf6b210d104e`，重点检查 OR 近似、Unicode、早退与 agreement gate。
- **已读取／执行的证据**：读取全部 diff；agreement gate 连跑 10 次为 20 pass／0 fail；summary-query 19 pass／0 fail；另实跑窄 token overmatch 探针。
- **总体 verdict**：**可进入下一阶段**。
- **blocker 数量**：0。blocker／major 均为 0。

## 事实性发现

未发现 blocker 或 major。

## Round-4 finding 闭合判据

- **已闭合**：`corpusMatchesSearch` 改用 Unicode `\p{L}\p{N}`；`tests/history/search/overlay-index-agreement.it.test.ts:70-130` 以真实 native index 校验 `index ⇒ overlay`，覆盖 CJK、Cyrillic、重音 Latin、数字、标点与 OR。当前 gate 连跑 10 次全部通过；回退 AND 会报 4 条不一致的 mutation 记录与目标机制一致。
- Agreement gate 的轴选择正确：overlay-only 行尚无 index oracle，false-red 会让正确结果暂时消失；适度 false-positive 只会提前显示 recent/in-flight 行，并在持久化后交由 sidecar 收敛。

## 新改动检查

- `some + includes` 确实可宽匹配：实跑 `cartoon` 对 `a zzzabsent` 为 native total=0、overlay 命中。但 recent/in-flight 上限有限、ownership 会在持久化后移交 sidecar，未形成 total/cursor 自相矛盾或持久错误，故不升 major。若产品要求 overlay 精确一致，应把 tokenizer/query evaluator 下沉为 native 共用能力，而不是继续扩手写近似。
- `inFlightMatchesSearch`／`recentMatchesSearch` 的新早退只作用于 `needle` 为空；有 needle 时仍走原 corpus 构造与同一 matcher。它修复普通列表无条件序列化，不改变搜索行为。
- Agreement 样本尚未覆盖 emoji-only、组合附加符号、超长 term、查询语法操作符与 JSON 转义 corpus；这些是后续扩充 gate 的 minor 建议，不影响本轮收口。

## 结构怪味扫描

- 范围：`queries.ts` matcher、native oracle agreement、ownership handoff。怪味：JS 手写近似 tokenizer 与 Tantivy QueryParser 双实现；处置：已由单向真实-index gate 约束，当前保留并记录长期应下沉共用能力，未发现新的 major。
