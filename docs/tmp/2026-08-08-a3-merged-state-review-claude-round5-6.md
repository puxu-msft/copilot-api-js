# A3 合并态复评 round 5–6 — Claude 侧报告（转录件）

**这是转录件**：该 reviewer 无 `Write` 工具，报告经回话正文返回，由主会话逐字转录。我的复核结论在 `2026-08-08-a3-merged-state-review-dispositions.md`。

---

## Round 5

**verdict**：无 blocker；**2 条 major**。第一条**源头是它 round-4 的建议**——当时只验证了「不再 UNDER」这一个方向，没有给 over-match 定上界，主会话照做，结果宽度失控。它主动认领了这一点并给出经实测的收敛改法。

**它的取证方式（关键差异）**：用**从 `queries.ts` 逐字复制**的 matcher，对 **JSON 形态的真实语料**跑真索引对照（7 组）。此前我与 GPT 侧都用裸散文串，因而都判「过宽无害」。

**[major] `src/lib/history/queries.ts:214`** — `terms.some((t) => haystack.includes(t))` 的 over-match 没有上界，短 term 会让几乎每一条未索引行命中

- 证据（语料取 `projectSearchableText` 的真实形状 `{"messages":[{"role":"user","content":"commit the editor change, request id 5f1429ab, waiting for upstream"}]}`）：`a bug` → index=false／overlay=true；`fix it` → true（`it` ⊂ `waiting`）；`429 error` → true（`429` ⊂ 请求 id `5f1429ab`）；`e f` → true。对照组 `commit editor` 两侧 true、`no such thing` 两侧 false。
- 失败场景（false-green，UI 可观察）：overlay 行是**最新的**，`entries` 按新→旧排序后切 `limit`。任何含 ≤3 字符 term 的多词查询，都会让 in-flight + recent bus（上限 256）里的无关行**霸占第一页**；`total` 同时被 `transientCount` 抬高；这些行还会被 `resolveSummaryCursor` 当作合法游标接受。语料是 JSON（键名、引号、请求 id、hash），短 term 几乎必然撞上。
- 修复建议（已实测）：多词分支改回 token 相等——`terms.some((t) => tokens.has(t))`。这**正是索引的语义**（OR of tokens），⊇ 方向依然成立：跑过 agreement 的全部 10 组，零 UNDER；跑 7 组对抗样本，7/7 与索引一致。单 term 分支保持 `includes`。

**[major] `tests/history/search/overlay-index-agreement.it.test.ts:120`** — 该 oracle 只断言一个方向，而本轮恰好使「另一个方向无害」这个前提失效；且它没覆盖真正相关的那条 lane

- 证据：断言只有 `if (indexed && !overlay)`，over-match 结构性不可见——major 1 的四组反例在它下面全绿。
- 第二个缺口：只用 `putInFlight`，即只走 **in-flight lane**。真正会被索引的是 **recent-bus lane**（`projectSearchableText`，request+response 的 JSON）——`rg publishModelOperationTerminal` 在该文件零命中。10 组样本也全是裸散文串。
- 修复建议：补第二个上界（索引说 no 时 overlay 也必须 no，允许少量有意豁免的单 term 行），至少含一组 JSON 形态语料 + 一个短 term 查询；并把 PAIRS 同时喂给 recent-bus lane。

---

## Round 6

**verdict**：**无 blocker、无 major——可以收口。** 按点名的三个方向（`RemoveLongFilter`、大小写折叠、token 内标点）各自构造反例，外加另外 8 个漂移维度；`tokens.has` 这次**结构上是对的**：11 组里 9 组与索引完全一致。

**为什么这次结构上是对的（不是「没找到就算了」）**：`tokens.has` 用的是与索引同一条规则的 OR-over-tokens，而 **needle 与语料经过同一个 JS 切分器**。因此只要某个 query token 在语料里逐字出现，它在两侧被切成的碎片序列必然相同 → overlay 必命中。这就是为什么天城文（`ा`/`ी` 是 Mc，Rust 视为 alphanumeric、JS `\p{L}\p{N}` 不视为）、阿拉伯 harakat、emoji 分隔这些「Rust 合并、JS 切开」的情形**全部 agree**：切分差异被自一致性吃掉了。UNDER 只可能来自**两侧对同一原文产生不同小写结果**，而不是来自切分。

两个边缘，都判 **minor**：

- **希腊末位 sigma（UNDER 方向，但不可达）**：JS 对整串 `toLowerCase()` 会应用词末 sigma 规则（`ΟΔΟΣ` → `οδος`），而 Tantivy 的 `LowerCaser` 是**逐字符** `to_lowercase`（→ `οδοσ`）。要触发必须同时满足：语料含大写希腊词、该词是查询与语料**唯一**的共享词、且用户用 `σ` 而非 `ς` 输入。**不建议为它加代码**。
- **`RemoveLongFilter(40)`（OVER 方向，样本表缺这一维）**：索引侧永远查不到 64 位 hex 摘要这类长 token；overlay 没有这个过滤，于是「长 token + 另一个词」会 over-match。建议**只加样本、不改代码**：补一行 `{ content: "digest " + "9f".repeat(32), needle: "9f".repeat(32) + " zzzabsent" }`，然后二选一——把 >40 字节 term 列进逐条豁免（推荐），或在 matcher 里同样丢弃。顺带一提，这也意味着**按摘要/长 id 搜索对已落盘行永远无结果**，那是索引自身的既有性质。

**单 term 豁免的作用域是对的**：`singleTerm` 只出现在 over-match 一侧，UNDER 方向对单 term 样本照样会红。唯一加固点（minor）：它是**手写标注**而非从同一条切分规则推导，误标注会静默豁免。

**两条 lane 的语料**（minor，已知取舍）：in-flight lane 把原始 content 喂给索引，而生产中该行落盘后索引到的是 `projectSearchableText`。这不构成缺陷（in-flight 行按定义还没被索引），且 recent-bus lane 已补上这个盲区。

**收口意见**：从 round 1 到现在，每一轮都能找出「注释/测试断言的性质被探针证伪」——这一轮第一次不成立，且原因可解释（自一致的切分 + 与索引同源的 OR 语义），不是「这次没想到反例」。

---

## Round 6 收尾追加（对主会话处置的复核）

主会话选择改代码而非豁免后，它复核并指出**一处实质问题**：

**单 term 分支未受字节限制，「搜摘要」这个动机案例仍然跨边界变化**。`corpusMatchesSearch` 的早退判断用的是**未过滤的 `rawTerms`**，于是只有多词 needle 走新逻辑。实测：`single 64-hex needle` → index=false、overlay=true。「用户搜一个 64 位摘要，最自然的动作是把它单独粘进去」，那正好落进单 term 分支。

三点安全性论证（它已写全）：不会造成 UNDER（该 term 在索引两侧都被丢掉）；不影响 type-ahead 豁免（`orld` 只有 4 字节）；不动 `rawTerms.length === 0`（纯标点 needle）那一支。

**另一条既有 false-red（不阻塞）**：needle 的全部 term 都 ≥40 字节时，native 返回 `invalid_query: true` → 400「Unsupported search query」。但 `<摘要A> <摘要B>` 语法完全合法，只是被长度过滤器滤空。诚实的答案是 200 + persisted 为空。**改动早于本轮**，建议记 backlog。

其余处置它复核**全部成立**：`Buffer.byteLength` 用字节而非 UTF-16 长度、`< 40` 与 `RemoveLongFilter::limit(40)` 的 `len < limit` 一致、needle 与语料两侧都施加过滤、`isSingleTerm` 改成推导消除了误标注静默豁免、希腊 sigma 与 in-flight 语料按不改处理是对的、给 agreement 测试加显式预算做对了。
