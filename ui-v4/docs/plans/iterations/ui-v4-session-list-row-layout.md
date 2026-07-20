# ui-v4 会话列表行信息重排

> **实施状态：已完成**
> **落地**：72f8214
> **现状锚点**：`ui-v4/src/components/sessions/SessionRow.tsx` + `src/lib/history/sqlite/sessions-agg.ts`（firstPreview）
> **备注**：后端 firstPreview 首/末 user 预览 + 前端行信息重排全落地

## Context
ui-v4 session list 每行（[SessionRow.tsx](ui-v4/src/components/sessions/SessionRow.tsx)）当前显示：状态块 / sessionId 前 12 字符 / `N req` / `N agents` / ↑↓tokens / fail / preview / span。实测发现几处误导与浪费：`agentCount` 纯 main 恒显 `0 agents`（COUNT DISTINCT 忽略 NULL）；`preview` 取末条 entry 的最后一条消息，多是 `[tool_result: …]`/系统提醒，看不出在聊什么；只显总 span、不显起止时刻；completed/failed 未单独展示。用户确认改法：保留 sessionId 前缀、agentCount 显示 `main+N`、preview 同时显首条+末条 user、显起止请求时刻、completed/failed 单独显示。

## 后端：SessionSummary 增「首条 user 预览」
现有字段已够用：`firstStartedAt`/`lastStartedAt`/`completed`/`failed` 都在 [types.ts:405](src/lib/history/types.ts#L405)。但「首条 user / 末条 user」都需 user 文本：现 `preview` 是末条 entry 最后一条消息（常为 tool_result，非 user），不合用。

- types.ts SessionSummary 加 `firstPreview: string`（首条 entry 首个 user 文本）；`preview` 改取末条 entry **最后一条 user 文本**（仍叫 preview）。
- [sessions-agg.ts](src/lib/history/sqlite/sessions-agg.ts)：取 MIN/MAX(started_at) 两条 entry，`assembleFullEntry` 解 inboundRequest，正向扫首条 user 文本、反向扫末条 user 文本，过滤 tool_result/system-reminder。复用 `summarizeMessage`（[in-flight.ts:66](src/lib/history/in-flight.ts#L66)）但只取 user-role text 块；首条 entry 多含 SessionStart hook，须剥 `<system-reminder>` 头取真问题。仅 2 条/session 解压，200 session 可接受。
- ui-v4 `src/types` 经 `~backend` re-export 自动带新字段。

## 前端：SessionRow 重排
- 状态块：保留，title 显 `completed/failed`。
- sessionId 前缀：保留。
- `N req`、↑↓tokens：保留。
- agentCount → `main` 或 `main+N`（N=agentCount，0 时仅 `main`）。
- completed/failed：`✓44 ✗1`（fail>0 红），替代当前仅 fail。
- 起止时刻：`formatTime(firstStartedAt)→formatTime(lastStartedAt)`，新增 [format.ts](ui-v4/src/lib/format.ts) 的 `formatTime`。
- preview：`首条… ⟶ 末条…` 两段（firstPreview + preview），占剩余宽度。
- span 保留右侧。

## Verification
`bun run typecheck` + `bun run typecheck:ui`；`bun run test:backend`（sessions-agg 加 first-preview 用例）；起服务看 /sessions 行：纯 main session 显 `main`、首末 user 文本均非 tool_result、起止时刻正确。
