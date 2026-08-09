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

## 实施记录

八条全部采纳、全部实施，无一条驳回。提交（分支 `nghttp2-cancel-a3-next`）：

| commit | 覆盖 | 说明 |
|---|---|---|
| `3fa8be16` | G3 | `EndpointType` 补 `openai-embeddings`；类型系统逼出三处映射，各自作出诚实决定（dry-run 无对应管线 → 显式 400 而非退到邻近格式；request ctx 无 codec cell → `clientFormat` 保持 undefined） |
| `367cf0b9` | G3·G4·K2(JS)·K1(400 映射) | 同一个 handler 上的四条，形态相同：校验方与消费方对同一个值理解不一致。G4 的根治是**共用同一个解析函数**而非两处各改一遍 |
| `93dfba86` | G2 | stats 的 SQL CASE 严格派生自 `requestBucket` 契约 |
| `8df7a6d2` | G1·K3 | overlay 归属冻结进 pre-await 快照；recent 记录改用 `projectSearchableText`。同步删掉那句「使用与索引相同的投影」的假注释 |
| `0fef1143` | K1(native+wire)·K2(native) | parse 错误走 `Status::InvalidArg` → `invalid-query` 线码 → 400；空串在两个 resolver 里按无过滤处理（**修在共用基座**，只改 handler 会把坑留给下一个直调 native 的消费者） |
| `d71276c7` | G5 | tombstone 回归 + 探针 + README 更正 |

**验证**：`typecheck` 绿；`bun test tests/history/`（579 pass / 0 fail）、`tests/routes`（162 pass / 0 fail）、`tests/history/search/daemon.it.test.ts`（20 pass / 0 fail）；改动文件 eslint 干净。

**全后端 `bun run test:backend`**：3610 tests · **3609 pass · 1 fail**。唯一失败是 `tests/history/v3/store-performance.it.test.ts` 的 “CAS live physical bytes…” 报 `TimeoutError`（18.2s）。判为**既有的负载敏感 flake、与本次改动无关**，依据两条：①该文件不在本分支改动的 20 个文件内（`git diff --name-only master...HEAD`）；②隔离复跑 3 pass / 0 fail、耗时 8.63s，而 16 分片并发下超时。合并前的验收轮里同一个文件也出现过同形失败。

**实测证据**（非文档推断）：
- napi 把 `Status` 暴露为 JS 错误的 `code`：`Status::InvalidArg` → `code:"InvalidArg"`（`parse-error-probe.ts`）。
- 空串修复的正负对照：`endpoint=""` 返回原本被藏起来的行，而真实不存在的 endpoint 仍返回 0——没有把过滤放松过头。
- G5 变异对照：注释掉 alive 检查后新测试报 `total=220`（应为 200），失败正来自被取代文档复活这一目标机制，不是旁路断言。还原用重新编辑、非 `git checkout`，事后 `git status` 确认 `lib.rs` 无残留。

## 待办

- [x] 收齐两侧共 8 条并逐条复核（全部成立）
- [x] 实施 8 条
- [x] 全后端 `test:backend`（3609/3610，唯一失败为既有 flake，见上）
- [x] round 2 复评：GPT 0 blocker/1 major、Claude 0 blocker/3 major（去重后 3 条），全部复核成立并修复
- [x] round 3 复评：GPT 0 blocker/1 major、Claude 0 blocker/2 major（去重后 3 条），全部复核成立并修复
- [ ] round 4 复评到 0 blocker / 0 major

## Round 3 复评（第三次「新缺陷长在上一轮修复上」）

报告：`2026-08-08-a3-merged-state-review-gpt-round3.md`；Claude 侧转录进 `2026-08-08-a3-merged-state-review-claude-round3.md`。

**两位再次独立收敛**：target 与 ownership 仍是两次独立的 live read。GPT 用「把 commit 精确放在两次读取之间」的注入探针实证（`{"injected":true,"ids":[],"total":0}`，行消失）；我在等待期间顺着 `durability` 也独立查到同一处。三方独立到达。

| # | 发现 | 我的复核 | 处置 |
|---|---|---|---|
| S1 | `target` 与 ownership 分两次读 live DB，窗口内落盘的行既不在冻结 target（不计入 total）又被判 index-owned（移出 overlay）→ 静默消失 | **成立**。`freezeHistorySearchTarget` 读 `v3_operations`、`hasPersistedSummaryMatching` 读 `v3_operation_summaries`，两条独立语句无事务包裹 | 采纳（C）·`751bbd9c`：合成 `freezeHistorySearchOwnership`，单个 deferred transaction 内取一份快照并**一起返回**——调用方连「配错快照」这个动作都不存在 |
| S2 | 我 round-2 写的注释「overlay 只会过度匹配、绝不反向」是假断言；ownership 改动使 overlay 成为未索引行的**唯一**显示路径，于是该方向的漏配变成用户可见的洞 | **成立**。探针实测语料 `please fix the hello-world bug in src/lib/foo.ts`：`hello world` → 索引命中、子串**不命中**；`src lib foo` 同形；反向 `orld` → 子串命中、索引不命中 | 采纳（C）·`751bbd9c`：多词 needle 按非字母数字切分、逐 term 匹配（对齐索引分词）；单 token 保留子串（该方向是早显示、不藏行），注释改成与代码一致 |
| S3 | 新 ownership 的守卫只钉住「丢得太少」；把 `overlaySummaries` 恒定改成 `[]`（overlay 彻底失效）14 条测试全绿，而 overlay 在本轮后**只剩这一项职责** | **成立，我亲手做了该变异确认** | 采纳（C）·`38593892`：补对称正样本——未落盘 recent 行必须既出现在 `entries` 又计入 `total`，并覆盖多词查询；另补 S1 的注入式对照 |

**Round 3 验证**：`typecheck` 绿、eslint 干净；`tests/history/` 585 pass/0 fail。

**三条变异对照**（逐条实跑，非预测）：去掉事务 → 归属被后落盘的写夺走（红）；`overlaySummaries=[]` → 未索引行消失（红）；退回纯子串 → 多词查询漏结果（红）。

**全后端**：四次运行里 executed 恒为 7331。其中一次真红**由我引起**——新增测试文件未登记进 L1 孤儿守卫基线（`entry-test-discovery-baseline.json`），已补（`e7acfddc`）。其余每次的唯一失败都是**计时型 perf 断言且每次换一条**（round 1 与 round 4 是 `store-performance` 的 CAS 用例、round 3 是 `summary-query-performance`），隔离复跑均绿（分别 9.31s vs 并发下 17.3s）；路径上也对不上——本轮改动只作用于带 `search` 的异步路径，而这些测试走无 search 的同步路径。判为既有的负载敏感 flake。

## Round 2 复评（两侧独立收敛到同一条）

报告：`2026-08-08-a3-merged-state-review-gpt-round2.md`；Claude 侧无 Write 工具，其正文转录进 `2026-08-08-a3-merged-state-review-claude-round2.md`。

**两位独立指向同一条**：substring/tokenized 双语义可再造 `entries.length=1,total=0`。GPT 说「可再次制造」，Claude 进一步证明它**已不需要竞态**——这对该条构成交叉佐证。

| # | 发现 | 我的复核 | 处置 |
|---|---|---|---|
| R1 | `code === "InvalidArg"` 判据过宽：napi 用同一状态报「字段缺失/类型不符」，基础设施故障被误报成 400 | **成立，且是我 round 1 新引入的缺陷**。探针实测：`foo:` → `InvalidArg`，`limit: undefined` → **同样** `InvalidArg`（`Missing field \`limit\``）。两者不可区分，「不完整就 fail-loud」的 503 契约被假 400 绕过 | 采纳（C）·`14f7c6d4`：改用 native 已有的 `invalid_cursor` **返回值**范式，新增 `invalid_query: bool`；不再从传输层状态反推语义 |
| R2 | overlay 子串 vs 索引分词，`entries` 有行而 `total` 不计；且我 round 1 的注释声称「已排除该形态」 | **成立**。探针实测同一 corpus `hello world cartoon`：`orld`/`art` → tantivy total=0 而 JS 子串 true。`hasPersistedSummaryMatching` 走的 `compileSummaryWhere` **不含 search 项**，故归属判据答非所问 | 采纳（C）·`f2c4ba09`：不调和两套语义（那要在 JS 重实现分词并保持同步），而是**消灭「两套」**——索引已能看见的行归索引裁决与计数，overlay 只保留索引还看不见的部分。连带修正 `requireMatch` 与 cursor 解析的同一处不一致 |
| R3 | 三条行为修复零回归测试；400/503 跨四模块任一环退化都不会变红 | **成立**。`rg 'invalid-query\|InvalidSearchQueryError'` 在 `tests/` 零命中 | 采纳（C）·`852f9b92`：补三条，各带正负对照 |

**Round 2 验证**：`typecheck` 绿、eslint 干净；`bun test tests/history/` 583 pass/0 fail（较 round 1 的 579 正好 +4）；**全后端 5594 pass / 0 fail**（executed 7329，较 round 1 的 7325 +4，与新增回归数一致；round 1 那条 `store-performance` 超时未复现）。

**变异对照**（三条新测试逐条打）：
- 400 映射：注释掉 `result.invalidQuery` 分支 → HTTP 返回 200 而非 400，变红。
- overlay 归属：把 `overlaySummaries` 改回包含索引已拥有的行 → `entries` 列出 1 行而 `total=0`，正是 bug 的准确形态。
- **第一次变异没变红，值得记**：不是修复无效，而是 fixture 里的 `sessionId` 过滤在 search 判定之前就丢掉了 overlay 行——测试通过但什么都没测到。这是「mutation 没变红」的第三解（fixture 造不出被测状态），去掉该过滤后才真正获得判别力。
