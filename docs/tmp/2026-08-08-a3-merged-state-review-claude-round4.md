# A3 合并态复评 round 4 — Claude 侧报告（转录件）

**这是转录件**：该 reviewer 无 `Write` 工具，报告经回话正文返回，由主会话逐字转录。我的复核结论在 `2026-08-08-a3-merged-state-review-dispositions.md`。

**verdict**：无 blocker；**2 条 major**。我怀疑的两处，结论**一处成立、一处不成立**：`corpusMatchesSearch` 确实还有一个「隐藏行」方向的反例，但**不在** CJK/Unicode 上（那一维实测是对的）；`db.transaction()` 未发现新失败模式。另外我新加的那条「负控」把与索引相反的语义钉死了。

**双视角覆盖**（它自述）：机械核对＝读四个 commit 的 diff、按 `connection.ts` 核 WAL/busy_timeout、核事务体是否跨 await、读新测试的断言 oracle；第一人称执行＝用**从 `queries.ts:204-214` 逐字复制**的 matcher 与真实 Tantivy 索引做 9 组对照，并跑 `bun test --parallel`（单文件 `--rerun-each 20` → 380/380；四文件同跑 → 48/48）。

---

## 事实性发现

**[major] `src/lib/history/queries.ts:213`** — overlay 用 AND，而 Tantivy QueryParser 默认是 OR，多词查询仍会隐藏未索引的行

- 证据（探针，真索引 vs 逐字复制的 matcher）：corpus=`please fix the hello-world bug` ／ q=`fix the parser bug` → index=true, overlay=false；q=`hello zzzabsent` 同形；corpus=`retry after a 429 response` ／ q=`429 rate limit` → index=true, overlay=false；corpus=`修复 错误 in the parser` ／ q=`错误 timeout` → index=true, overlay=false。
- 单独坐实默认是 OR：q=`bug zzzabsent qqqabsent` → index total=1；q=`zzzabsent1 zzzabsent2` → 0。
- 失败场景：刚 terminal、尚未索引的行只有 overlay 能显示；只要用户多词查询里**有一个词不在该行语料中**，该行就消失，直到 sidecar 追上才出现。这正是 round-3 要消灭的方向，只是触发条件从「跨 token」换成了「有词缺失」——而后者常见得多。
- 修复建议：`terms.every((t) => tokens.has(t))` → `terms.some((t) => haystack.includes(t))`（保留 `\p{L}\p{N}` 切分）。我对上面 9 组逐一验过：索引命中的每一组它都命中，UNDER 归零，且仍只朝 over-match 方向偏。若你更希望索引也变 AND，那要在 native 侧 `set_conjunction_by_default()`，但那会改变所有已索引行的搜索语义，属产品决策，请你裁决而不是我替你选。

**[major] `tests/history/v3/summary-query.it.test.ts:329`** — 新增的「负控」oracle 与索引相反，正确修复会让它变红

- 断言：`getHistorySummariesAsync({ search: "hello absent" })` 必须返回 `{ entries: [], total: 0 }`，语料是 `please fix the hello-world bug`。
- 证据：同一对 (corpus, query) 在真索引上**是命中的**（上面 `hello zzzabsent` 那一行，index=true）。所以这条守的不是「不得乱拉行」，而是「overlay 必须比索引更严」——恰好是 major 1 的缺陷本身。
- 失败场景：按 major 1 改成 `some` 之后这条必红，而下一个执行者最省力的动作是改实现去迁就它（`red-tests-may-be-guarding-something` 的反向形态：测试守着一个错的不变量）。
- 修复建议：改成真负控——needle 的**所有** term 都不在语料里（如 `zzzabsent qqqabsent`），此时索引与 overlay 都应为空；同时把「缺一个 term 仍应命中」补成正控，把 major 1 的方向钉住。

## ② `db.transaction()`：未发现新失败模式

- **BUSY**：`connection.ts:73-75` 无条件 `PRAGMA journal_mode=WAL` + `busy_timeout`；WAL 下 deferred 读事务既不阻塞写者也不被写者阻塞，两条 SELECT 不会引入新的 BUSY。
- **长事务**：`freezeHistorySearchOwnership`（`summary-store.ts:127-136`）事务体**全同步、无 await**，物理上不可能跨事件循环持有快照；持有时长 = 2 条查询 + 每个 overlay id 一条点查（recent bus 上限 256 且已被 filters+search 预筛）。嵌套走 SAVEPOINT，安全。
- **一条相邻风险（不是发现）**：`connection.ts:263-264` 记着一次真实事故——「long-lived readers 饿死 checkpoint，WAL 涨到 400 MB」。这是读路径上的第一个 `BEGIN`，虽短但随每次 `?search=` 去抖触发；若将来 in-flight 规模上去，建议把 `hasPersistedSummaryMatching` 的逐 id `db.prepare` 改成一条 `IN (SELECT value FROM json_each(?))` 批量查，事务体就只剩两条语句。

## Round-3 两条的闭合判据（可复跑）

- **R3-1（假注释＋双向分歧）→ 机制部分闭合，断言再次不成立。** 跑探针：`hello world`／`错误 修复`／`fix 错误`／`changelog md` 四组已由 UNDER 变 agree，跨 token 那一类确实修掉了。但 `queries.ts:193-195` 又写下「A single-token needle keeps the substring test, which still over-matches ... That direction is deliberate」，仍在暗示剩余分歧是单向的——被 major 1 的四组样本证伪。**这是连续第三轮同一形态。** 建议这轮别再写方向断言，改成写一条可检验的性质（overlay ⊇ index），并配一条**以真索引为 oracle** 的对照测试，让这个断言以后由机器判。
- **R3-2（守卫只钉一个方向）→ 闭合。** 正控已就位，`overlaySummaries = []` 变异会变红。复跑：`--rerun-each 20` → **380/380 pass，4.00s**；四个相关文件同跑 48/48 pass。
- **顺带纠正我自己**：我第一版探针按主会话消息里写的 `[^a-z0-9]+` 建镜像，据此得出「CJK 词序反转会隐藏行」的结论；读到 `:209` 才发现代码用的是 `/[^\p{L}\p{N}]+/u`。**那条结论作废**——`\p{L}\p{N}` 与 Tantivy 的 `SimpleTokenizer` 在我试的 CJK、中英混排、数字、`.`／`_`／`-` 上全部一致。

## perf flake 判定：**站不住**（按主会话给的三条依据）

- **依据 (c) 事实错误。** `corpusMatchesSearch` 是共用原语，同步路径 `getHistorySummaries` → `listHistoryOverlaySummaries` → `inFlightMatchesSearch`／`recentMatchesSearch`（`queries.ts:225`、`:236`）同样经过它。更要紧的是 `recentMatchesSearch`（`:222-224`）**无条件先求值** `projectSearchableText(record)`，`needle === undefined` 时也算——即每次**不带 search** 的列表请求，都要对 recent bus 里最多 256 条记录各做一次全量 JSON 序列化。这是本系列引入的、落在同步路径上的确定性开销，是「负载敏感 perf 测试变红」的一个可信竞争解释。
- **依据 (a)+(b) 只能证明「不是确定性回归」**，分不开「负载敏感」与「判据挂在进程全局量上／污染」——本仓两类事故的签名完全相同（单跑绿、全量红）。而 `summary-query-performance.it.test.ts:162-163` 的判据是 `elapsedMs < Math.max(50, small.elapsedMs * 5)`：比值部分稳健，`50` 这个**绝对地板**在高负载下正是「把进程全局量当通过条件」。
- **我这边的反例（削弱 leg (a)）**：在**没有任何 perf 文件参与**的情况下，`tests/history/v3/summary-query.it.test.ts` 在我同时跑第二个 `bun test` 进程时出现 2 fail、四文件同跑时出现 4 fail；单独跑 20 次全绿。**我没抓到失败文本**，因此不主张它与 perf 那条同因；但它足以说明「会红的只有 perf 文件」不成立。
- **最小判别动作**：① 记下每次红的**测试名与断言**，不要只记文件名；② 问那条断言「通过条件里有没有 wall-clock 绝对值」——有就直接改 oracle，这类红会永久消失；③ 若断言里没有 wall-clock，那它就不是负载敏感，按污染 playbook 查。

修掉上面 2 条 major 即可收口；其余只剩 minor（`recentMatchesSearch` 的 eager 求值、事务体的逐 id 查询，两者都已在正文点名）。
