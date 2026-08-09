# A3 合并态复评 — Claude 侧报告（转录件）

**这是转录件**：该 reviewer（`reviewer`，Claude 驱动）的工具集里没有 `Write`，报告经由回话正文返回，由主会话逐字转录。转录未改动其措辞与行号；我自己的复核结论**不写在这里**，在 `2026-08-08-a3-merged-state-review-dispositions.md`。

**评审对象**：`master@9fad0bdf` 的 A3 六条 finding 合并态。派活简报见 `2026-08-08-a3-merged-state-review-brief.md`。

**分段说明**：本轮按派活要求先只报 blocker（结论：**0 blocker**），major 由第二条消息取回。取 major 时我向它同步了 GPT 侧的 5 条，它据此撤下了自己清单里与之重合的两条（GPT 的 (1) transient/persisted 窗口、(3) `openai-embeddings` 400），改给三条独立发现——**即两个异模型独立撞到了同样这两条**。它明确声明：GPT 的 (2)(4)(5) 未经它独立复核，不表态。

---

## 事实性发现

**[major] `native/history-search/src/lib.rs:491-492`** — Tantivy QueryParser 语法错误直接冒泡成 503，普通搜索输入被误拒（false-red）

- 证据（实跑探针，临时索引单文档）：query=`-` / `foo:` / `(x` / `a AND` / 未闭合引号 → `Syntax Error`；`hello world` / `C++` / `50%` / `a OR b` 正常。
- 链路：`lib.rs:492` `parse_query(...)?` → `daemon.ts:594` `index.listSearch` 抛出 → `queries.ts:416-422` 归入兜底分支 `HistorySearchUnavailableError` → `handler.ts:128` 返回 503。
- 失败场景：ui-v4 搜索框是自由文本（`request-filters.ts:50` 原样透传），用户输入 `error:` 或以 `-` 开头的词，整个 `/api/entries` 变 503（不只是搜索为空），in-flight 那一路的结果也一并丢失。
- 修复建议：把「查询串语法非法」与「sidecar 不可用」分成两类——native 侧回一个可辨识的 parse-error 码，主进程转 400（或按 §6-1 的「不得静默」精神回 200 ＋显式标记），而不是复用 503；另可考虑对无语法意图的输入走 fallback 到 phrase/term 查询。

**[major] `src/routes/history/handler.ts:40` + `native/history-search/src/lib.rs:336-351`** — 空串 `endpoint=` 在 JS 侧是「无过滤」、在 native 侧是「匹配不到任何值」，persisted 结果被静默清空（false-red）

- 证据（同一探针）：`endpoint=""` → total=0；无过滤 → total=1（`sessionId=""`、`agentId=""` 同形，但它们在 `handler.ts:44-45` 被 `|| undefined` 归一，唯独 endpoint 没有）。
- 链路：`?endpoint=` → `handler.ts:40` 得 `""` → 通过 `rejectsInvalidListQuery`（`handler.ts:85` 空值跳过，且注释 `:69-70` 明写「空值即无过滤」）→ `queries.ts:394` 上线 → `daemon.ts:597` → `lib.rs:344` `term_ord("")` 无命中 → 允许集为空 → 全部文档被 `ord_allowed` 拒掉。
- 失败场景：`GET /api/entries?search=x&endpoint=` 只剩 in-flight 结果，persisted 恒空且无任何提示；同一 URL 去掉 `search=` 走 SQL 路（`summary-store.ts:54` `if (options.endpoint)`）却正常返回——两条 persisted 路径对同一查询给出不同答案。
- 修复建议：`handler.ts:40` 补 `|| undefined` 与其余 10 维对齐（治标不彻底），并在 `lib.rs` 的 `resolve_equals`/`resolve_any_of` 把空串统一按「无过滤」处理，使 native 与 `equals_query`（`:466-472` 已对空串不下推）的语义一致——否则下一个直接调 native 的消费者还会再踩。

**[major] `src/lib/history/queries.ts:168-174` vs `src/lib/history/v3/projection.ts:107-117`** — 同一个合并页里存在两套「命中 search」的定义，语料范围不同

- 证据：in-flight/recent 一路用 `extractInboundSearchText(entry.clientRequest.messages)` 做小写子串匹配（`queries.ts:172-173`，**仅入站**）；persisted 一路索引的是 `projectSearchableText` = 入站 request + `egress.client` 响应 + 响应帧（`projection.ts:110-115`），且是 tokenized 全文。
- 失败场景 A（漏结果）：搜一个只出现在模型回答里的词，某 operation 在「已 terminal、尚未 commit ＋索引」的窗口里只存在于 recent bus，被 `queries.ts:373` 的 `inFlightMatchesSearch` 判为不匹配而整条缺席；落盘并被 sidecar 索引后又凭空出现。
- 失败场景 B（正确 cursor 被误拒 400）：`queries.ts:239-243` 对命中 recent 缓存的 cursor 强制走 `inFlightMatchesSearch`，同一个 response-only 词的翻页请求会抛 `InvalidSummaryCursorError` → `handler.ts:127` 返回 400，而该 cursor 在 persisted 语义下完全合法。
- 修复建议：让 in-flight/recent 一路复用与索引同源的投影（对 recent 记录直接用 `projectSearchableText(record)` 而非入站文本），并把匹配判定抽成两侧共用的一个 primitive；tokenize 与子串的差异若决定保留，需在 spec 里写成显式契约，而不是留在两个函数里各自定义。
