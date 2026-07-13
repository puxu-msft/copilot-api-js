# Phase 2 Task 2.2 续做笔记（backfill leaf）

> 本笔记是给续做 Task 2.2 的会话，把已追踪到的存储事实固化，避免重推。截至 commit `cd8ec789`（Task 2.1 完成）。

## 已完成（feat/ghc-usage-details 分支）
- Phase 0：净公式 = **子集**（`exp` 探测无样本，见 [poc-conclusion.md](poc-conclusion.md)）。
- Phase 1：fix-forward 全 8 task，8 commits，全套件 4381 pass、typecheck 绿。
- Phase 2 Task 2.1：`cache_write_backfilled` 标记列（schema + connection wedge + write + serialize），born 行=1，legacy-migration 行=0。

## Task 2.2 待做：`src/lib/history/sqlite/cache-write-backfill.ts`

**承重红线（C2）**：绝不对已存 `input_tokens` 做增量减（usage-normalize-backfill.ts:181 已把历史行净化过）。**只从上游原始帧整份重算**。先写 golden 测试证「重算正确 + 对已净化行不二次减 + 幂等 + 跳过非流式」，再实现。

### 已追踪的存储事实（省去重推）
- **上游原始 sseEvents 存在 `sse_events` stage**，`attempt_index = -1`（`LEG_ATTEMPT_INDEX`，serialize.ts）为最终/成功帧；blob 解压后**直接是 `Array<SseEventRecord>`**（每个 `{ offsetMs, type, raw, synthetic? }`，`raw` 是逐字上游 `data:` 串）。
  - 读：`SELECT blob_gz FROM entry_stages WHERE entry_id=? AND stage='sse_events' AND attempt_index=-1`，`decompress()` → 数组。
  - pre-driver 布局：forwarded 帧在 `inbound_response` stage 或 legacy 单 blob 的 `sseEvents`/`inboundResponse.sseEvents`——**backfill 要上游原始轨（sse_events），非 forwarded 轨**（M4）。复用 `usage-normalize-backfill.ts:91-125` 的 `hasSseEvents`/`isGeminiAlreadyNet` 探测样式判断「有无源」。
- **usage blob 在哪**：新布局 usage 在 `upstream_response` stage 的 `upstreamResponse.usage`（`STAGE` 见 serialize.ts:188）；legacy 单 blob 在 head blob 的 `outboundResponse.usage` + `attempts[].response.usage`。patch 要仿 `usage-normalize-backfill.ts` 的 `prepareBlobRewrites`（stage 行 vs legacy 单 blob 双路径），但 stage 名从 `outbound_response` 换成新的 `upstream_response`（**先核实 STAGE.upstreamResponse 的字面值 + 该 stage blob 的 usage 路径**）。
- **column 写**：`input_tokens` / `cache_read` / `cache_creation`（serialize buildHeadRow 列名）。

### 算法
1. 扫 `WHERE cache_write_backfilled=0 AND endpoint IN ('openai-chat-completions','openai-responses','gemini-generate-content')`，`(started_at,id)` keyset，LIMIT 批。
2. 读 sse_events 源。无源（非流式/无帧）→ `markStmt`（backfilled=1），不改数据。
3. **扫全帧**取最后一个 `JSON.parse(raw)` 成功且含 `usage` 对象的帧（M2，guard parse；跳过 `[DONE]`/keepalive）。**分 endpoint**（M3）：chat/gemini 读 `usage.prompt_tokens` + `prompt_tokens_details.{cached_tokens,cache_write_tokens}`；responses 读 `usage.input_tokens` + `input_tokens_details.{cached_tokens,cache_write_tokens}`。
4. cache_write 缺/0 → 标记跳过（无可 backfill）。
5. cache_write>0 → 整份重算：`cache_read=raw_cached`、`cache_creation=raw_cw`、`input=max(0, raw_prompt-raw_cached-raw_cw)`。**Oracle**：子集 `input+cache_read+cache_creation==raw_prompt`；不符 → `errors++`、不标记（留复查）。双写 column + blob（upstream_response stage + head/legacy）。
6. 骨架仿 `usage-normalize-backfill.ts`：module-global `running`/`stopRequested`、keyset 游标 + meta version 守卫（新 meta key `cache_write_backfill_version`）、per-entry tx、off-tx 解压压缩、never-throw、`resetCacheWriteBackfillForTests` 注册 RESETTERS。

### 导出（对齐 usage-normalize-backfill）
`runCacheWriteBackfill(db): Promise<void>`、`stopCacheWriteBackfill()`、`resetCacheWriteBackfillForTests()`。

## Task 2.3：串行接线
`src/lib/history/state.ts` 的 `startHistoryBackfills` 链：usage-normalize → legacy-stage → **cache-write** → search-index → preview。cache-write 须在 usage-normalize + legacy-stage **之后**（需新 stage 布局 + C2 顺序）。teardown 加 `stopCacheWriteBackfill()`（state.ts:127 附近）。

## Phase 3：见 [plan-3-forward-docs.md](plan-3-forward-docs.md)（转发 + 文档 + 收尾）。收尾记得记录 G6 偏离（Task 1.8 用 JSON.stringify 局部方案而非 transport 透传原始字节，见该 commit）。
