# Spec：请求列表增加响应内容预览

- 日期：2026-07-08
- 状态：已落地（master, commits 3ddcecb6..582b34d7；opus 全分支终审 MERGE-READY）
- 归属：History Web UI（`ui-v4/`）+ History 持久化层（`src/lib/history/`）
- 相关：`docs/DESIGN.md`（类型架构、活的架构现状）、`src/lib/history/in-flight.ts`（`extractPreviewText` 请求预览）、`ui-v4/src/lib/content/accumulate-forwarded.ts`（SSE→content 组装器）
- Review：本文档 §11 记录两份对抗审查的采纳/未采纳。

## 1. 目标与动机（What & Why）

Requests 列表现有的 `Preview` 列只显示**请求**内容（`previewText`，取自 `clientRequest.messages` 最后一条消息的摘要）。诊断一次请求"发生了什么"时，只看请求不够 —— 尤其响应里带 `tool_use`（如 `AskUserQuestion`、`Bash`）时，无法在列表行内一眼看出"这轮模型调了什么工具 / 回了什么"，必须逐条展开详情页。

本 spec 增加一列**响应内容预览**，让响应侧诊断也能在列表行内完成，与既有请求预览对称。

### 验收标准

- 每个**终态**（completed / failed / aborted / interrupted）History 行，在列表里可见一列响应预览。
- **completed**：展示最终响应的语义摘要（工具优先，见 §5）。
- **failed / aborted / interrupted**：优先展示已捕获的响应内容（部分流 / 错误体），无内容时回退为紧凑错误摘要（`failureReason` / `rawBody`），不留空（§5.3）。
- 响应含 `tool_use` 时以 `[ToolA, ToolB] text...` 形式呈现（工具名方括号在前、逗号连接，其后接首个文本；§5）。
- 覆盖 4 种客户端方言（Anthropic Messages / OpenAI Chat-Completions / OpenAI Responses / Gemini），流式与非流式均可，含工具抽取（§4 需扩展 Responses/Gemini 组装器，见 H1 决策）。
- 历史旧行经一次性回填后同样可见（§6）。
- 在途（in-flight / Live 泳道）请求响应预览为空 —— **可接受**，天然满足（§5.4）。

## 2. 非目标（Non-goals）

- 不改变详情页 Response tab 的既有渲染流程（仅把底层组装器下沉共享 + 扩展其 Responses/Gemini 工具抽取，见 §4）。
- 不引入新的响应内容**存储**形态（响应 body / sseEvents 已按 richest-data-flow 完整存储；本 spec 只增派生**汇总列** + 派生**摘要展示**）。

## 3. 数据来源与"响应内容"定义

后端在 settle 时通过 `finalUpstreamResponse(entry)`（`src/lib/history/entry-view.ts:34`）拿到最终 attempt 的 `upstreamResponse`。响应内容取值：

1. **非流式** → `finalUpstream.body`（4 端点 settle 时均已归一为 `MessageContent`：Anthropic `content:[blocks]`；CC/Responses/Gemini `content:string(|null) + tool_calls[]`）→ 直接摘要。
2. **流式** → `accumulateForwardedContent(entry.clientResponse?.sseEvents, entry.endpoint)`（§4）→ 摘要。
3. 皆无（如失败 attempt 只有合成 verdict）→ 走 §5.3 错误回退。

> **关键更正（review C1）**：流式源必须是 **`clientResponse.sseEvents`（forwarded / 客户端方言轨）**，**不是** `finalUpstream.sseEvents`（上游轨）。因为 `accumulateForwardedContent` 按**客户端 endpoint** 分派解析器且被设计为消费 forwarded 帧（函数 doc `accumulate-forwarded.ts:151-156`）；而 gemini / openai-responses 走 CC 上游再转译，其 `finalUpstream.sseEvents` 是 CC 方言帧，用客户端方言解析器解析必得空。model / usage 是方言无关标量（可同源 finalUpstream），content 是方言成形的（必须取与 endpoint 分派匹配的客户端轨）。

## 4. 共享 SSE 组装器（SSOT 去重 + 补全工具抽取）

4 方言的 SSE→content 组装逻辑已存在于前端 `ui-v4/src/lib/content/accumulate-forwarded.ts`（`accumulateForwardedContent(frames, endpoint)`，**已实测确认纯**：只 import backend-owned 类型 + `JSON.parse`，无副作用依赖；唯一消费者是详情页 `ResponseSegment.tsx`）。

**决策：下沉共享，不新写第二个解析器。**

- 组装器移动为 backend-owned 纯模块（`src/lib/history/accumulate-response.ts`）。
- 前端 `accumulate-forwarded.ts` 保留同名 re-export shim（经 `~backend/*`），详情页消费点零改动。backend→frontend 运行时代码 re-export 是既有模式（实证：`resolveResponseModel` / `normalizeModelId` / `deriveCapabilities` 已如此）。

**补全（review H1，in-scope）**：现有 `accumulateResponses` / `accumulateGemini` 是**纯文本累加器**，从不产出 `tool_use`。扩展二者：
- `accumulateResponses`：解析 Responses 的 `response.output_item.*` / `function_call` 输出项 → 产出 `tool_use` 块。
- `accumulateGemini`：解析 `candidates[].content.parts[].functionCall` → 产出 `tool_use` 块。

此扩展同时修复**详情页 Response tab 对这两个端点流式工具调用的既有盲区**（richest-data-flow / complete）。Anthropic（`accumulateAnthropic` 已产 tool_use）与 CC（`accumulateOpenAICC` 已产 tool_calls）无需改。

> **记录未采纳（review 冲突项）**：① 后端另写轻量扫描器（制造两份 4-方言解析、必漂移，违背 SSOT）。② 流式 Responses/Gemini 工具抽取"接受缺失、推迟到 backlog"——因用户核心诉求即跨方言的工具可见性、且此为详情页既有盲区，按 against-yagni 不砍，纳入本 spec。

## 5. 后端响应摘要函数

新增 `extractResponsePreviewText(entry)` 与 `summarizeResponseMessage(msg)`，置于 **`src/lib/history/entry-view.ts`**（就近 `finalUpstreamResponse`；被 serialize + 回填 + in-flight `toEntrySummary` 三处 import）。

```
extractResponsePreviewText(entry):
  assembled = finalUpstream.body（若为 MessageContent）
            ?? accumulateForwardedContent(entry.clientResponse?.sseEvents, entry.endpoint)
  summary = assembled ? summarizeResponseMessage(assembled) : ""
  return summary || errorFallback(entry)   // §5.3
```

### 5.1 `summarizeResponseMessage(msg)` 规则（工具在前 + 文本在后）

覆盖 **string content 与 array content 两种形态**（review M1：CC/Responses/Gemini 的 `body.content` 是 string+`tool_calls[]`，仅 Anthropic 是 `[blocks]`；镜像请求侧 `summarizeMessage` 对 `typeof content === "string"` 的显式处理）：

1. 收集工具名 `tools`（有序）：
   - array content 里的 `tool_use` / `server_tool_use` 的 `name`；
   - `msg.tool_calls[].function.name`（OpenAI 形态）。
2. 取首个非空 text：
   - `typeof content === "string" && content` → 该串；
   - 否则 array content 里首个非空 `text` 块。
3. 组合：`tools` 非空 + text 非空 → `[A, B] text`；仅 tools → `[A, B]`；仅 text → `text`；皆无 → `""`。
4. 整体截断 ~100 字（与 `summarizeMessage` 上限一致）。

### 5.2 与请求侧的关系

与 text-优先的请求侧 `summarizeMessage` 是**不同函数**（优先级相反、格式不同、面向 assistant 响应），不复用。

### 5.3 失败态错误回退（review M2）

失败 / aborted / interrupted 常 `body:null` 且无 forwarded 帧 → `assembled` 为空。此时 `errorFallback(entry)` 返回紧凑错误摘要：优先 `resolveResponseError(entry)` / `entry._index?.derived?.failureReason`，回退 `finalUpstream?.rawBody` 首行，截断 ~100 字。保证"completed 或 failed 都填充"、且承接 richest-data-flow（已在库的上游错误体不被丢弃）。

### 5.4 填充时机（review H2 —— 消除原 §5/§6 矛盾）

`extractResponsePreviewText` 由 **`toEntrySummary`（in-flight.ts）与 serialize 两条腿共同调用同一函数**：
- **in-flight / 非终态**：`finalUpstream` 无内容、无 forwarded 帧、entry 未失败 → 返回 `""`。天然满足"在途留空"。
- **终态**：finalize 广播经 `toEntrySummary`（`entries.ts:239/275` → `in-flight.ts:146`）时即算出真值 → **WS 推送与 DB 列一致**，终态行迁入 History 列表时立即有响应预览（不必等刷新）。
- 结果经 `getCachedSummaryText` 的 WeakMap 记忆（缓存形状扩为 `{preview, responsePreview}`，`in-flight.ts:31-38`）避免重复计算。

## 6. 存储 + 回填

### 6.1 列（派生汇总列，非顶层字段 —— review M3）

`response_preview_text` 是 serialize 时的**派生汇总列**（与 `preview_text` 同类、同机制），**不是** HistoryEntry 顶层字段，**不走** `toHistoryEntry` / `updateEntry` allowlist 合并链（`preview_text` 亦不在 allowlist，每次 serialize 重算）。**不加** `_index.aux.responsePreviewText`（review M2：`aux.previewText` 经 grep 确认为从未读写的死字段，镜像它是 cargo-cult）。

### 6.2 全部落地站点（review H1 —— 用 grep 全清单替换原"三处"）

**写侧：**
- `src/lib/history/sqlite/schema.ts:33` 附近 SCHEMA_SQL 增 `response_preview_text TEXT`（fresh DB）。
- `src/lib/history/sqlite/connection.ts` `migrateEntriesColumns` 的 `wanted[]` 增 `{ name: "response_preview_text", type: "TEXT" }`（已部署库幂等 ALTER；与 `preview_text` 双写 SCHEMA_SQL + wanted 一致）。
- `src/lib/history/sqlite/serialize.ts`：`EntryRow` 类型（:122 附近）+ row builder（:398 附近 `response_preview_text: extractResponsePreviewText(entry)`）。
- `src/lib/history/sqlite/write.ts` **4 个子站点**：INSERT 列清单（:43）、VALUES 占位符 +1（:47）、`ON CONFLICT DO UPDATE SET response_preview_text = excluded.response_preview_text`（:57，**漏此则 re-upsert 静默丢弃/永不刷新**）、`runHeadInsert` 绑定顺序（:92 `row.response_preview_text` 插对位置）。

**读侧：**
- `src/lib/history/sqlite/read.ts` **两个显式列 SELECT**：`querySummaries`（:119-125）与 `loadSummariesByIds`（:185-191，服务 `/api/search` 结果路径；漏此则搜索结果行恒空）。
- `rowToSummary`（:137-172，两 SELECT 共用）映射 `responsePreviewText: r.response_preview_text ?? ""`（1 处）。
- （可选，对称）`applyWhere`（:88）的快速文本过滤 `preview_text LIKE ?` 追加 `OR response_preview_text LIKE ?`，让搜索框也匹配响应内容（richest / 对称；采纳）。

**类型：**
- `src/lib/history/types.ts`：`EntrySummary` 增 `responsePreviewText: string`（前端经 `~backend/*` 自动到位；WS 无 allowlist，`broadcast.ts` 整个 summary 下发，自动带上 —— review 确认）。
- `EntryRow`（serialize.ts）增 `response_preview_text: string | null`。

### 6.3 回填全部历史行（独立回填 + 靶向解压）

新建 `src/lib/history/sqlite/response-preview-backfill.ts`，按 `history-backfill` skill 范式：`history_meta` flag 守卫、`(started_at,id)` keyset 续跑、协作 stop（匹配 shutdown phase）、非阻塞分批、never-throw、per-row 跳过（`response_preview_text IS NULL` 谓词，避免续跑重解边界前缀）。

**靶向解压（review 冲突裁决 + L1）**：只解压 `upstream_response` stage（取 `body`）与 `client_response` stage（取 forwarded `sseEvents`），**不** `assembleFullEntry` 全解（`methodology-derived-column-backfill-targeted-and-nonblocking`：4.2G 库 `SELECT *` 曾卡 3m53s）。

`state.ts` 接线（与 `runSearchIndexBackfill` / `runUsageNormalizeBackfill` 并列 import + start/stop 对，:30-47）。

> **记录未采纳（review 冲突项）**：搭 `search-index-backfill` 同趟车（在其 `processBatch` 加 UPDATE）。因该回填带**自身 meta-flag、已在部署库跑完**，加字段不会重跑；强制重跑须 bump `search_index_version` = **重建整个搜索索引**（比独立靶向回填更贵）。故独立回填正确。

## 7. 前端呈现（新增独立 Response 列）

- `EntrySummary.responsePreviewText` 经 `~backend/*` 自动到位。
- `ui-v4/src/lib/request-columns.ts`：
  - 现有 `preview` 列 `header` 标签 `Preview` → `Request`（**列 id 保持 `preview`**，实测确认可见性按 id 持久化、header 独立，不破坏 localStorage）。
  - 新增 `response` 列：`completed` 显示 `responsePreviewText`（工具优先格式后端已算好，前端截断 + title 全文）；非 `completed` 沿用 `responsePreviewText`（已含 §5.3 错误回退），与现有 `preview` 列的 completed/failed 分支呼应。
  - 增 `COLUMN_WIDTHS.response`（review L2：既有测试强制每列必有宽度项）；`Request` 与 `Response` 两列如何分配 `flex-1` 剩余宽度需给定（建议二者各 `min-w-0 flex-1` 平分）。
  - 默认可见 + 列菜单经 `REQUEST_COLUMNS` / retain-on-absence 自动带出。
- `ui-v4/src/components/requests/RequestRow.tsx` 的 `HistoryRow`（AgentLane 泳道复用）同步加响应预览段。
- `ui-v4/src/lib/activity-row.ts`：加 `truncResponsePreview(entry)`（镜像 `truncPreview`）。

## 8. 测试

- 后端单测：
  - `summarizeResponseMessage` —— array content（Anthropic tool_use + text）、**string content + tool_calls**（CC/Responses/Gemini）、仅工具、仅文本、空、截断。
  - `extractResponsePreviewText` —— 非流式 body（4 端点形态）、流式 `clientResponse.sseEvents`（4 方言，**含 Responses/Gemini 扩展后的工具抽取**）、失败态错误回退（§5.3）。
  - 扩展后的 `accumulateResponses` / `accumulateGemini` 工具抽取单测。
- 回填单测：幂等重跑不变、keyset 续跑、`response_preview_text IS NULL` 跳过、meta-flag 守卫、never-throw、靶向 stage 解压等价性。
- 前端：
  - `response` 列渲染 + `request-columns.bun.test.ts` **有序 id 断言更新**（末尾加 `"response"`，review L3）+ `COLUMN_WIDTHS.response` 存在守卫。
  - 组装器下沉 + shim 后 `bun run build:ui`（rollup 才暴露 `~backend` 纯度问题；typecheck + vitest 会双假绿 —— 记忆 `feedback-verify-ui-with-build-not-just-typecheck`）。

## 9. 涉及文件清单

后端：
- `src/lib/history/accumulate-response.ts`（新，从前端下沉 + 扩展 Responses/Gemini 工具抽取）
- `src/lib/history/entry-view.ts`（`extractResponsePreviewText` + `summarizeResponseMessage` + `errorFallback`）
- `src/lib/history/in-flight.ts`（`toEntrySummary` 挂 `responsePreviewText`；`getCachedSummaryText` 缓存扩为 `{preview, responsePreview}`）
- `src/lib/history/types.ts`（`EntrySummary.responsePreviewText`）
- `src/lib/history/sqlite/schema.ts`（SCHEMA_SQL 增列）
- `src/lib/history/sqlite/connection.ts`（`migrateEntriesColumns` `wanted[]` 增列）
- `src/lib/history/sqlite/serialize.ts`（`EntryRow` 类型 + row builder）
- `src/lib/history/sqlite/write.ts`（INSERT 列 / 占位符 / `ON CONFLICT excluded` / 绑定 —— 4 处）
- `src/lib/history/sqlite/read.ts`（两个 SELECT + `rowToSummary` + 可选 `applyWhere` OR）
- `src/lib/history/sqlite/response-preview-backfill.ts`（新，独立靶向回填）
- `src/lib/history/state.ts`（回填接线）

前端：
- `ui-v4/src/lib/content/accumulate-forwarded.ts`（改为 re-export 后端 shim）
- `ui-v4/src/lib/request-columns.ts`（`preview` 改标签 + 新 `response` 列 + `COLUMN_WIDTHS.response`）
- `ui-v4/src/components/requests/RequestRow.tsx`（`HistoryRow` 加响应段）
- `ui-v4/src/lib/activity-row.ts`（`truncResponsePreview`）
- `ui-v4/src/lib/request-columns.bun.test.ts`（有序 id 断言 + 宽度守卫）

## 10. 实施顺序建议（供 writing-plans 细化）

1. 组装器下沉 + shim + 扩展 Responses/Gemini 工具抽取（§4）→ `build:ui` 验证详情页不 break。
2. 后端摘要函数 + 错误回退（§5）+ 单测。
3. 列全站点接线（§6.1/6.2）+ 类型 + WS（自动）。
4. `toEntrySummary` 挂字段（§5.4）。
5. 独立靶向回填（§6.3）+ state 接线 + 单测。
6. 前端列（§7）+ 测试更新（§8）。

## 11. Review 采纳记录

两轮对抗 subagent review（架构可行性 + 行为/完整性）。采纳：C1（流式源方言更正）、H1-behavior（扩展 Responses/Gemini 工具抽取，in-scope）、H2（`toEntrySummary` 同算消矛盾）、H1-arch（SQL 全站点枚举）、M1-arch（string content 分支）、M2-arch（弃死字段 `_index.aux`）、M3-arch（明确派生列非顶层字段）、M2-behavior（失败态错误回退）、L1-arch（靶向 stage 解压）、L2/L3（宽度 + 测试断言）、L4（置于 entry-view.ts）、可选的 `applyWhere` OR（对称可搜索）。冲突裁决：回填**独立 + 靶向**（非搭车），依据 search-index-backfill 已跑完 + bump version 会重建整个索引。

## 12. 运行期待验证（no-auto-server，留给用户）

代码已落地，唯一未在本会话验证的是回填的运行期效果（本项目 no-auto-server 纪律，需用户启动服务器后确认）：跑服务器后查 `history_meta(response_preview_version)=1` + 抽查旧行 `entries_v2.response_preview_text` 非 NULL。
