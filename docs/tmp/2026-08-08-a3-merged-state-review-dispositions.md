# A3 合并态复评 — 发现处置表

**评审对象**：`master@9fad0bdf` 的 A3 六条 finding 合并态。派活简报见 `2026-08-08-a3-merged-state-review-brief.md`。

**两份独立报告**：
- GPT 侧（`gpt-souls:reviewer`）：0 blocker、5 major → `2026-08-08-a3-merged-state-review-gpt.md`。
- Claude 侧（`reviewer`）：0 blocker、3 major（分段取回中）。

**复核纪律**：下表每条的「我的复核」都是我自己跑命令 / 打开被引用行得到的，不采信 reviewer 的转述。级别按 `adopting-agent-findings` 的 A/B/C/D 表。

## GPT 侧五条

| # | 发现 | 我的复核 | 处置 |
|---|---|---|---|
| G1 | `queries.ts:371-380` 的 overlay 归属在 `await` **前**采样，`:449` 的 `hasPersistedSummaryMatching` 在 `await` **后**读 live DB；窗口内落盘的 recent row 不在冻结 target 里（故不计入 `persistedTotal`），又已 persisted（故不计入 `transientCount`） | **成立**。读 `queries.ts:361-460`：371 取 overlay、380 冻结 target、390 `await`、449 读 live db。两个时点的不对称是真的，正是 C1 声称已消灭的 `entries` 含该行而 `total` 不含它的形态 | 采纳（C）·本轮修 |
| G2 | `v3/summary-store.ts:398-408` 的 stats CASE 是 lifecycle 契约的**第二份且更弱**的实现：把任意非 terminal state 按 `response_success` 计入 success/failure | **成立**。`lifecycle-state.ts:67-70` 规定 pending/executing/streaming 一律 `none`、仅 `state===undefined` 才 fallback 到 `responseSuccess`；SQL 第 400/406 行却对所有非 terminal state 做该 fallback。同一条 streaming summary 在 overlay 与 persisted stats 中分桶不同。引入于 `29b05f34`（2026-08-06） | 采纳（C）·本轮修 |
| G3 | `EndpointType` 漏 `openai-embeddings`，`/api/entries?endpoint=openai-embeddings` 误拒 400 | **成立，且比报告更重**：冻结 spec `docs/spec/2026-07-28-history-read-path-core.md:325` 把补齐该值明写为本 enum gate 的**前置修复**，理由正是「否则合法 embeddings record 会被判 poison」。producer 见 `routes/embeddings/route.ts:58`，落列见 `v3/projection.ts:381`（`as` 强转，正是它让不完整隐身） | 采纳（C）·本轮修。我上线枚举校验时漏了冻结 spec 已写明的前置 |
| G4 | 校验用 `Number(raw)`（`handler.ts:92,97-98`）而消费用 `Number.parseInt(raw,10)`（`:41,42,47,119`），两套语义 | **成立**。实跑 `bun -e`：`"1e2"` → `Number`=100 / `parseInt`=1；`"0x10"` → 16 / 0；`"3.9"` → 3.9 / 3。故 `limit=1e2` 校验成 100、消费成 1；`from=10&to=1e2` 通过 `from<=to` 后实际是 10>1 | 采纳（C）·本轮修 |
| G5 | C7 的「alive_bitset 分支实测不可达」前提被推翻 | **成立，且是我的错**。复跑 `supersede-probe.ts` 6 次：**5 次产生 tombstone**（`num_deleted_docs:1`），仅 run 2 没有——那次被 supersede 的文档恰好独占一个单文档 segment、整段被丢弃。我此前拿一次运行的「没观察到」写成了「不可能发生」，观察到的还是少数情形 | 采纳（C）·本轮修：保留分支 + 补可达覆盖 + 更正 `lib.rs` 注释、测试 docstring 与 exp README |

## Claude 侧三条

报告转录件见 `2026-08-08-a3-merged-state-review-claude.md`。三条与 GPT 的五条**完全不重合**；它自述原清单里有两条与 G1、G3 撞车后让位——**两个异模型独立撞到同样两条**，对 G1/G3 构成交叉佐证。它明确声明未复核 G2/G4/G5，不表态。

| # | 发现 | 我的复核 | 处置 |
|---|---|---|---|
| K1 | `lib.rs:491-492` QueryParser 语法错误冒泡成 503，`error:`、`-foo` 这类普通输入把整个 `/api/entries` 打成 503（连 in-flight 那一路结果也丢） | **成立**。`lib.rs:492` `parse_query(...).map_err(native_error)?` 与「sidecar 不可用」共用同一条错误通道，主进程 `queries.ts:416-422` 只能归入兜底的 `HistorySearchUnavailableError` → `handler.ts:128` 503。搜索框是自由文本，用户没有语法意图 | 采纳（C）·本轮修：native 侧回可辨识的 parse-error，主进程转 400 |
| K2 | `?endpoint=` 空串在 JS 侧是「无过滤」、在 native 侧是「精确匹配空值」→ persisted 恒空 | **成立，且根因在两处**。`handler.ts:38` 是 11 个 filter 维里**唯一**没有 `\|\| undefined` 的（对比 `:37,40,43,44,45`）；`lib.rs:336-351` 的 `resolve_equals` 把 `Some("")` 当成要精确匹配的值。同一 `?endpoint=` 走 SQL 路（`summary-store.ts:55` 的 `if (options.endpoint)`）正常、走 sidecar 路恒空——两条 persisted 路径对同一查询给不同答案 | 采纳（C）·本轮修：**两处都修**。只修 handler 是治标，下一个直接调 native 的消费者还会踩（`fix-at-the-shared-base-not-where-you-noticed`） |
| K3 | in-flight/recent 与 persisted 两套「命中 search」定义：前者仅入站消息 + 小写子串（`queries.ts:168-174`），后者入站 + 响应载荷 + 响应帧 + tokenized（`projection.ts:107-117`） | **成立**。附带发现：`queries.ts:163-166` 的注释明写「使用与持久化索引**相同**的归一化投影」——这个断言不成立，是撒谎注释。失败场景 B（response-only 词的 cursor 被 `queries.ts:239-243` 判无效 → 400）尤其隐蔽 | 采纳（C）·本轮修：recent 一路改用 `projectSearchableText`，抽共用 primitive；tokenize vs 子串的残余差异写进 spec 而非留在两个函数里 |

## 待办

- [x] 收齐两侧共 8 条并逐条复核（全部成立）
- [ ] 实施 8 条
- [ ] 复评到 0 blocker / 0 major
