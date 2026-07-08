# Spec：请求列表增加响应内容预览

- 日期：2026-07-08
- 状态：draft（待实施）
- 归属：History Web UI（`ui-v4/`）+ History 持久化层（`src/lib/history/`）
- 相关：`docs/DESIGN.md`（类型架构、活的架构现状）、`src/lib/history/in-flight.ts`（`extractPreviewText` 请求预览）、`ui-v4/src/lib/content/accumulate-forwarded.ts`（SSE→content 组装器）

## 1. 目标与动机（What & Why）

Requests 列表现有的 `Preview` 列只显示**请求**内容（`previewText`，取自 `clientRequest.messages` 最后一条消息的摘要）。诊断一次请求"发生了什么"时，只看请求不够 —— 尤其是响应里带 `tool_use`（如 `AskUserQuestion`、`Bash`）时，无法在列表行内一眼看出"这轮模型调了什么工具 / 回了什么"，必须逐条展开详情页。

本 spec 增加一列**响应内容预览**，让响应侧诊断也能在列表行内完成，与既有请求预览对称。

### 验收标准

- 每个**终态**（completed / failed / aborted / interrupted）History 行，在列表里可见一列响应预览，展示该请求最终响应的语义摘要。
- 响应含 `tool_use` 时，工具名以 `[ToolA, ToolB] text...` 形式呈现（工具名在前、方括号逗号连接，其后接首个文本块）。
- 覆盖 4 种上游方言（Anthropic Messages / OpenAI Chat-Completions / OpenAI Responses / Gemini），流式与非流式均可。
- 历史旧行经一次性回填后同样可见响应预览。
- 在途（in-flight / Live 泳道）请求的响应预览为空 —— **可接受**，不视为缺陷。

## 2. 非目标（Non-goals）

- 不改变详情页 Response tab 的完整渲染行为（仅把其底层组装器下沉共享，见 §4）。
- 不引入新的响应内容存储形态（响应原始 body / sseEvents 已按 richest-data-flow 完整存储；本 spec 只增加一个派生摘要列）。

## 3. 数据来源与"响应内容"定义

后端在 settle 时（`src/lib/history/sqlite/serialize.ts`）已通过 `finalUpstreamResponse(entry)`（`entry-view.ts`）拿到**最终 attempt 的 `upstreamResponse`** —— 这是行内 `responseModel` / `usage` / `stopReason` 的同一来源，响应预览沿用它保持一致。

响应内容取值优先级：

1. **非流式**：`finalUpstream.body`（已是组装好的 `MessageContent`，含 content blocks）→ 直接摘要。
2. **流式**：`finalUpstream.sseEvents`（回退 `entry.clientResponse?.sseEvents`）→ 组装成 `MessageContent` → 摘要。
3. 皆无（如失败 attempt 只有合成 verdict、无内容）→ `""`。

## 4. 共享 SSE 组装器（SSOT 去重）

4 种方言的 SSE→content 组装逻辑**已存在**于前端 `ui-v4/src/lib/content/accumulate-forwarded.ts`（`accumulateForwardedContent(frames, endpoint)`，纯函数，只依赖 backend-owned 的 `MessageContent` / `ContentBlock` 类型）。后端摘要流式响应需要同一套解析。

**决策：下沉共享，不新写第二个解析器。**

- 把组装器移动为 backend-owned 纯模块（`src/lib/history/accumulate-response.ts`）。
- 前端 `accumulate-forwarded.ts` 改为经 `~backend/*` re-export 该函数（backend→frontend 运行时代码共享是既有模式：`resolveResponseModel` / `deriveCapabilities` / `normalizeModelId` 已如此）。
- 组装器保持纯（只 `JSON.parse` + 类型，无 `~/lib/state` 等副作用依赖），确保 `~backend/*` re-export 后前端 rollup build 通过。

> **记录未采纳**：后端另写一个"轻量 tool_use/text 扫描器"。省一次模块移动，但制造两份 4-方言 SSE 解析、必然漂移，违背项目 no-duplication / SSOT。

## 5. 后端响应摘要函数

新增 `extractResponsePreviewText(entry)`，与 `extractPreviewText` 并置于 `src/lib/history/in-flight.ts`（或就近 entry-view）：

```
assembled = finalUpstream.body（若为 MessageContent）
          ?? accumulateForwardedContent(finalUpstream.sseEvents ?? clientResponse.sseEvents, endpoint)
return summarizeResponseMessage(assembled)
```

`summarizeResponseMessage(msg)` 规则（**tool 名在前 + 文本在后**）：

1. 按出现顺序收集 `tool_use` / `server_tool_use` 的 `name`（含 OpenAI `tool_calls[].function.name`）→ `tools`。
2. 取首个非空 `text` 块 → `text`。
3. 组合：
   - `tools` 非空 + `text` 非空 → `[A, B] text`
   - 仅 `tools` → `[A, B]`
   - 仅 `text` → `text`
   - 皆无 → `""`
4. 整体截断 ~100 字（与 `summarizeMessage` 一致的上限）。

与请求侧 text-优先的 `summarizeMessage` 是**不同函数**（优先级相反、格式不同），不复用。

### 填充时机

- 只在 settle（`serialize.ts`，仅终态持久化时跑）与回填（§6）计算。
- Live 泳道的 `toEntrySummary`（in-flight.ts）**不计算**响应预览，字段留空 `""`。满足"在途无响应预览可接受"。

## 6. 存储 + 回填

### 列与投影

- **新列**：`entries_v2.response_preview_text TEXT`，经 `connection.ts` 的 `migrateEntriesColumns` 幂等加列（与 `preview_text` 同法，非 Umzug 迁移）。
- **投影字段**：`_index.aux.responsePreviewText`（IndexProjection.aux）。
- `serialize.ts` 写列（`response_preview_text: extractResponsePreviewText(entry)`）+ INSERT_ENTRY_SQL 增列。
- `read.ts` 读列 → `EntrySummary.responsePreviewText`。
- `EntrySummary` 增字段 `responsePreviewText: string`（types.ts；前端经 `~backend/*` 自动到位）。
- `toEntrySummary`（in-flight.ts）终态路径挂上；Live 路径留空。

### 回填全部历史行

新建专用 `src/lib/history/sqlite/response-preview-backfill.ts`，按 `history-backfill` skill 范式：

- `history_meta` flag 守卫（跑过即跳过）。
- `(started_at, id)` keyset 续跑。
- 协作 stop（匹配 shutdown phase）。
- 非阻塞分批（不阻塞请求）。
- never-throw。
- 解码全 entry（`assembleFullEntry`）→ 算响应预览 → `UPDATE entries_v2 SET response_preview_text = ? WHERE id = ?`（仅当与现值不同才写，幂等）。

state.ts 接线（与 `runSearchIndexBackfill` / `runUsageNormalizeBackfill` 并列 import + start/stop）。

## 7. 前端呈现（新增独立 Response 列）

- `EntrySummary.responsePreviewText` 已经 `~backend/*` re-export，字段自动到位。
- `ui-v4/src/lib/request-columns.ts`：
  - 现有 `preview` 列 header 标签 `Preview` → `Request`（**列 id 保持 `preview`**，不破坏 localStorage 持久化可见性）。
  - 新增 `response` 列：展示 `responsePreviewText`（tool 优先格式已由后端算好，前端直接截断展示 + title 全文）。
  - 加 `COLUMN_WIDTHS.response`、默认可见（`DEFAULT_COLUMN_VISIBILITY` 自动含）、列菜单自动带出（`REQUEST_COLUMNS` 派生）。
- `ui-v4/src/components/requests/RequestRow.tsx` 的 `HistoryRow`（AgentLane 泳道复用）同步加响应预览段（与请求预览段并列）。
- `ui-v4/src/lib/activity-row.ts`：加 `truncResponsePreview(entry)` helper（镜像 `truncPreview`）。

## 8. 测试

- 后端单测：`summarizeResponseMessage`（4 情形：工具+文本 / 仅工具 / 仅文本 / 空）、`extractResponsePreviewText`（非流式 body、4 方言流式 sseEvents、失败 attempt 空响应）。
- 回填单测：幂等（重跑不变）、keyset 续跑、meta-flag 守卫跳过、never-throw。
- 前端：`response` 列渲染测试；组装器下沉后 `bun run build:ui`（rollup 才暴露 `~backend` 纯度问题，typecheck + vitest 会双假绿 —— 见记忆 `feedback-verify-ui-with-build-not-just-typecheck`）。

## 9. 涉及文件清单

后端：
- `src/lib/history/accumulate-response.ts`（新，从前端下沉）
- `src/lib/history/in-flight.ts`（`extractResponsePreviewText` + `summarizeResponseMessage`；`toEntrySummary` 挂字段）
- `src/lib/history/types.ts`（`EntrySummary.responsePreviewText`、`IndexProjection.aux.responsePreviewText`）
- `src/lib/history/sqlite/serialize.ts`（写列）
- `src/lib/history/sqlite/read.ts`（读列）
- `src/lib/history/sqlite/connection.ts`（`migrateEntriesColumns` 增列）
- `src/lib/history/sqlite/write.ts` / INSERT_ENTRY_SQL（增列）
- `src/lib/history/sqlite/response-preview-backfill.ts`（新，回填）
- `src/lib/history/state.ts`（回填接线）

前端：
- `ui-v4/src/lib/content/accumulate-forwarded.ts`（改为 re-export 后端）
- `ui-v4/src/lib/request-columns.ts`（`preview` 改标签 + 新 `response` 列 + `COLUMN_WIDTHS.response`）
- `ui-v4/src/components/requests/RequestRow.tsx`（`HistoryRow` 加响应段）
- `ui-v4/src/lib/activity-row.ts`（`truncResponsePreview`）
