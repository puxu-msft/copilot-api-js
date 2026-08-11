# A3 合并态独立复评 round 2

- **评审范围**：`371d4409..008e1a313da6ff9f028863b69785e77ba32f8b3b`，重点复核八条修复自身及 G1／G5 的闭合性。
- **已读取／执行的证据**：读取处置表、全部修复 diff 与最终代码；实跑 summary＋HTTP 40 pass／0 fail、G5 tombstone 回归连续 10 次 10 pass／0 fail；另以两条独立 Bun 探针分别复现 G1 原竞态和 substring／tokenized 分歧。
- **总体 verdict**：**修复 major 后可进入下一阶段**。
- **blocker 数量**：0。另有 1 条 major。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.worktree/nghttp2-cancel-5/src/lib/history/queries.ts:180-191,205-214,426-430,497-508` — K3 修复引入的 substring／tokenized 双语义可再次制造 `entries.length=1,total=0`。
证据／失败场景：注释承认 overlay 用 substring、native 用 token；实跑 native 对 corpus `cartoon` 搜 `art` 得 total=0，而同一 recent record 已在 frozen target、sidecar 回空时，facade 返回 `{"ids":["recent-cartoon"],"total":0}`。`overlayPersistedAtFreeze` 将它视为已由 sidecar total 计数，但 sidecar 根本不命中。
修复建议：overlay membership 必须使用与 Tantivy 同一查询语义，或把任何 overlay-only 命中按冻结归属之外的独立集合计数；补该 persisted-recent 反例及 cursor／terminalOnly／两方向分页双控。

## G1／G5 闭合判据

- **G1 原失败场景已闭合，但尚未固化为测试**：独立探针在 `listSearch` 内提交 pre-await recent row，当前返回 `ids=["recent-cartoon"],total=1`；同一形态在旧实现会是 total=0。应把该 deferred-persist 探针纳入 `tests/history/v3/summary-query.it.test.ts` 并做 mutation 对照。
- **G5 已闭合**：`tests/history/search/daemon.it.test.ts:278-330` 先证 `meta.json` 存在 tombstone，再证总数与 old/new state；本轮 `--rerun-each 10` 为 10 pass／0 fail，且处置记录的去掉 alive 检查会得到 total=220，判别力成立。

## 其余检查

- `target===null` 时没有 sidecar total，visible overlay 全按 pre-await 集合计 transient；`terminalOnly` 在计数前过滤；cursor 的 page-side 只影响 entries、不应影响 exact total。除上述 token 语义交缝外，未发现 blocker／major。
- `parseIntegerParam` 没把严格校验扩到 `/api/search` 或 `/api/sessions`：两者遇非法值都回退默认 limit，不返回 400；这与裁决作用域一致。建议后续补显式 API 正控，但不升 major。
- `recentMatchesSearch` 最坏扫描 256 条、每条 corpus 截到 128 KiB；合成上界探针约 267–412 ms／请求。缺真实基线，不能断言性能缺陷；若该路径进入高频交互，建议交 `perf-engineer` 建真实语料基线。
