# ui-v4 Plan 05 — Sessions + Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。Steps 用 checkbox (`- [ ]`)。

**Goal:** 填上最后一个 nav 死页 Sessions——新增后端 session 聚合端点 + agentId 过滤接线，前端 Sessions 列表页 + Session 详情（agent 泳道时间线）。完成后 ui-v4 nav 5 项全是真页。

**Architecture:** 后端**新增只读** `GET /history/api/sessions`（entries_v2 GROUP BY session_id 聚合，照 `stats.ts` 模式）+ 补 `handleGetEntries` 的 `agentId`/`mainAgentOnly` 接线（spec review 缺口）。`SessionSummary` 类型在后端 `store.ts` barrel 定义、前端 `~backend/*` re-export（single-source）。前端：SessionsPage（列表）+ SessionDetailPage（按 `/entries?sessionId=` 拉 session 内请求，按 agentId 分泳道时间线）。**agent 语义名 header 无**（只有不透明 agentId，main=null）——泳道按短 agentId 标识，main 行聚合 agentId IS NULL 的请求。

**Tech Stack:** 续前（React 18 / TS strict / TanStack Query / Tailwind v4 / bun+vitest）+ 后端（Hono / bun:sqlite，照 `src/lib/history/sqlite/*` 模式）。

参照：spec [../DESIGN.md](../DESIGN.md) §5；后端 `src/lib/history/sqlite/{stats.ts,read.ts}`（聚合 SQL 模式 + queryEntries）、`src/lib/history/store.ts`（barrel 类型导出）、`src/routes/history/{handler.ts,route.ts}`（端点注册 + agentId 缺口）、`src/lib/history/sessions.ts`（getSessionEntries/deleteSession）；前端 Plan 02 的 `@/components/requests/RequestRow`、`@/hooks/useEntry`、`@/lib/format`。

**全局命令**（仓库根）：后端测试 `bun run test:backend`；前端 typecheck/test/build `bun run --filter copilot-api-ui-v4 <script>`。

## 后端契约（实证，勿猜）

- `entries_v2` 列（`src/lib/history/sqlite/schema.ts`）：`id, session_id, agent_id, started_at, ended_at, duration_ms, model, endpoint, status, input_tokens, output_tokens, ...`。
- 聚合可行：`GROUP BY session_id` 算 COUNT(*)=#req、COUNT(DISTINCT agent_id)=#agents、SUM(input/output_tokens)、MIN/MAX(started_at)=时间跨度、SUM(CASE status)=状态分布。照 `stats.ts:computeStats` 的 SQL 写法。**client 维度**来自 entry blob 的 user-agent（非列）——本计划 SessionSummary **不含 client**（避免逐 entry 解压；spec 已记 client 需新列、暂缓）。**cost 暂缓**（spec 已定成本持久化非本轮）。
- `handleGetEntries`（`handler.ts:17-40`）当前 options 只读 `sessionId`,**未读 `agentId`/`mainAgentOnly`**——底层 `read.ts:applyWhere` 已支持（`agent_id = ?` / `agent_id IS NULL`）,只需 handler 补读 query param。
- `/entries?sessionId=X` 已可拉某 session 全部请求（复用,前端 SessionDetail 用）。

---

## 文件结构（本计划新建/修改）

```
src/lib/history/
├── types.ts                       # 新增 SessionSummary interface
├── store.ts                       # barrel 导出 SessionSummary(single-source)
├── sqlite/sessions-agg.ts         # 新增:querySessionSummaries() 聚合 SQL
└── (test) tests/history/sessions-agg.it.test.ts
src/routes/history/
├── handler.ts                     # 新增 handleGetSessions + 补 agentId 接线
└── route.ts                       # 注册 GET /api/sessions
ui-v4/src/
├── types/index.ts                 # re-export SessionSummary
├── hooks/
│   ├── useSessions.ts             # GET /history/api/sessions
│   └── useSessionEntries.ts       # GET /history/api/entries?sessionId=
├── components/sessions/
│   ├── SessionsPage.tsx           # session 列表(聚合行)
│   ├── SessionRow.tsx
│   ├── SessionDetailPage.tsx      # agent 泳道时间线
│   └── AgentLane.tsx
└── App.tsx                        # /sessions + /sessions/:id 接真页
tests/(后端) + ui-v4/tests/(前端)
```

---

## Task 1: 后端 SessionSummary 类型 + querySessionSummaries 聚合（TDD）

**Files:** Modify `src/lib/history/types.ts`（加 `SessionSummary`）, `src/lib/history/store.ts`（barrel 导出）; Create `src/lib/history/sqlite/sessions-agg.ts`; Test `tests/history/sessions-agg.it.test.ts`。

- [ ] **Step 1: deep-read** `src/lib/history/sqlite/stats.ts`（computeStats 的 SQL + db 取法 `getDb()`/`historyState.db`）、`schema.ts`（列名）、`read.ts`（EntryRow 形状）。确认 db 句柄获取方式 + 列名。

- [ ] **Step 2: 加 `SessionSummary` 到 `src/lib/history/types.ts`**

```ts
export interface SessionSummary {
  sessionId: string
  requestCount: number
  agentCount: number
  inputTokens: number
  outputTokens: number
  firstStartedAt: number
  lastStartedAt: number
  completed: number
  failed: number
  /** 该 session 用到的不同 model(去重,展示用) */
  models: Array<string>
}
```
并在 `src/lib/history/store.ts` 的 `export type {...}` barrel 加 `SessionSummary`。

- [ ] **Step 3: 写 failing test `tests/history/sessions-agg.it.test.ts`**（用 isolated runtime + 插入几条带 session_id/agent_id 的 entry,断言聚合）

参照现有 `tests/history/*.it.test.ts` 的 fixture（`useIsolatedRuntime` + 插入 entry helper）。断言:两个 session、各自 requestCount/agentCount/token SUM/状态分布正确。**按现有 history 测试的插入 helper 写**（deep-read `tests/helpers/` 与现有 history it 测试）。

- [ ] **Step 4: 写 `src/lib/history/sqlite/sessions-agg.ts`**

```ts
import { getHistoryDb } from "./driver" // 按 deep-read 的真实 db 取法调整

import type { SessionSummary } from "../types"

/** entries_v2 GROUP BY session_id 聚合(照 stats.ts 模式)。仅非 active 行。 */
export function querySessionSummaries(limit = 200): Array<SessionSummary> {
  const db = getHistoryDb()
  const rows = db
    .prepare(
      `SELECT session_id AS sessionId,
              COUNT(*) AS requestCount,
              COUNT(DISTINCT agent_id) AS agentCount,
              COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              MIN(started_at) AS firstStartedAt,
              MAX(started_at) AS lastStartedAt,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM entries_v2
        WHERE session_id IS NOT NULL AND active = 0
        GROUP BY session_id
        ORDER BY lastStartedAt DESC
        LIMIT ?`,
    )
    .all(limit) as Array<Omit<SessionSummary, "models">>
  return rows.map((r) => ({ ...r, models: querySessionModels(db, r.sessionId) }))
}
```
> **按 deep-read 调整**:db 取法（`getHistoryDb`/`historyState.db`/`getDb`——用 stats.ts 同款）、`active` 列名/类型（stats.ts 用 `NOT_ACTIVE` 常量,复用它）、`agent_id` NULL 在 COUNT DISTINCT 的语义（NULL 不计入 DISTINCT,故 main-only session 的 agentCount=0——可接受,或额外加 main 标志）。`querySessionModels` 为子查询取该 session 的 distinct model 列表（小函数,或 GROUP_CONCAT）。**复用 stats.ts 的 NOT_ACTIVE/db helper,别新造**。

- [ ] **Step 5: 跑 pass + 后端 typecheck**

`bun run test:backend`（新测试 pass,无回归——注:并发会话可能有 request-telemetry 失败,区分本任务无关）；`bun run typecheck`。

- [ ] **Step 6: Commit**

```bash
git add -- src/lib/history/types.ts src/lib/history/store.ts src/lib/history/sqlite/sessions-agg.ts tests/history/sessions-agg.it.test.ts
git commit -m "feat(history): SessionSummary + querySessionSummaries 聚合(GROUP BY session_id)"
```

---

## Task 2: 后端 handleGetSessions + agentId 接线 + 路由注册（TDD）

**Files:** Modify `src/routes/history/handler.ts`（加 `handleGetSessions` + 补 agentId/mainAgentOnly 进 `handleGetEntries`）, `src/routes/history/route.ts`（注册 `GET /api/sessions`）; Test `tests/history/sessions-route.http.test.ts`。

- [ ] **Step 1: 写 failing test**（http test:起 app,GET /history/api/sessions 返回聚合数组;GET /history/api/entries?agentId=X 过滤生效）。参照现有 `tests/history/*.http.test.ts`。

- [ ] **Step 2: handler.ts**

```ts
export function handleGetSessions(c: Context) {
  if (!isHistoryEnabled()) return c.json({ error: "History recording is not enabled" }, 400)
  const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit") as string, 10) : undefined
  return c.json({ sessions: querySessionSummaries(limit) })
}
```
并在 `handleGetEntries` 的 options 补（`handler.ts:30-40` 附近,sessionId 之后）：
```ts
    agentId: query.agentId || undefined,
    mainAgentOnly: query.mainAgentOnly === "true" ? true : undefined,
```
> 确认 `QueryOptions` 有 `agentId`/`mainAgentOnly`（read.ts 已用,应已在类型里）。import `querySessionSummaries`。

- [ ] **Step 3: route.ts 注册**

```ts
historyRoutes.get("/api/sessions", handleGetSessions)
```
（在 `/api/stats` 附近）。同步 `openapi-compat.ts` 的 drift guard 若枚举该路由（参照 Plan 01 Task 3 的 /ui-v4 drift 处理——若 `/history/api/*` 已整体豁免则无需改;运行 openapi drift test 确认）。

- [ ] **Step 4: 跑 pass + typecheck + 全后端测试**

`bun run test:backend`（新 http test pass + drift guard 不红 + 无回归）；`bun run typecheck`。

- [ ] **Step 5: Commit**

```bash
git add -- src/routes/history/handler.ts src/routes/history/route.ts tests/history/sessions-route.http.test.ts
git commit -m "feat(history): GET /api/sessions 端点 + handleGetEntries 补 agentId/mainAgentOnly 接线"
```

---

## Task 3: 前端类型 re-export + hooks

**Files:** Modify `ui-v4/src/types/index.ts`（re-export SessionSummary）; Create `ui-v4/src/hooks/useSessions.ts`, `ui-v4/src/hooks/useSessionEntries.ts`。

- [ ] **Step 1: types/index.ts 加** `SessionSummary` 到 `~backend/lib/history/store` 的 re-export 列表。

- [ ] **Step 2: useSessions.ts**

```ts
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { SessionSummary } from "@/types"

export function useSessions() {
  return useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.get<{ sessions: Array<SessionSummary> }>("/history/api/sessions"),
  })
}
```

- [ ] **Step 3: useSessionEntries.ts**（拉某 session 全部请求,复用 /entries?sessionId=）

```ts
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { SummaryResult } from "@/types"

export function useSessionEntries(sessionId: string | undefined) {
  return useQuery({
    queryKey: ["session-entries", sessionId],
    queryFn: () => api.get<SummaryResult>(`/history/api/entries?sessionId=${String(sessionId)}&limit=1000`),
    enabled: Boolean(sessionId),
  })
}
```

- [ ] **Step 4: typecheck + commit**

```bash
git add -- ui-v4/src/types/index.ts ui-v4/src/hooks/useSessions.ts ui-v4/src/hooks/useSessionEntries.ts
git commit -m "feat(ui-v4): SessionSummary re-export + useSessions/useSessionEntries hooks"
```

---

## Task 4: SessionRow + SessionsPage（列表）

**Files:** Create `ui-v4/src/components/sessions/SessionRow.tsx`, `ui-v4/src/components/sessions/SessionsPage.tsx`; Test `ui-v4/tests/SessionsPage.vitest.test.tsx`。

- [ ] **Step 1: SessionRow.tsx**（一行:sessionId 短 + #req + #agents + tokens + 时间跨度 + 状态分布;点击→ /sessions/:id）

```tsx
import { useNavigate } from "react-router-dom"

import { formatDuration } from "@/lib/format"
import type { SessionSummary } from "@/types"

export function SessionRow({ s }: { s: SessionSummary }) {
  const navigate = useNavigate()
  const span = s.lastStartedAt - s.firstStartedAt
  return (
    <button type="button" onClick={() => navigate(`/sessions/${s.sessionId}`)} className="mono flex w-full items-center gap-3 border-b border-[#222] px-2 py-1.5 text-left text-[13px] text-[#aaa] hover:bg-[#1a1a1f]">
      <span className="text-[var(--color-primary)]">{s.sessionId.slice(0, 12)}…</span>
      <span>{s.requestCount} req</span>
      <span className="text-[#888]">{s.agentCount} agents</span>
      <span className="text-[#888]">↑{s.inputTokens} ↓{s.outputTokens}</span>
      {s.failed > 0 ? <span className="text-[var(--color-fail)]">{s.failed} fail</span> : null}
      <span className="ml-auto text-[#888]">{formatDuration(span)}</span>
    </button>
  )
}
```

- [ ] **Step 2: SessionsPage.tsx**（useSessions → SessionRow 列表 + 空/loading 态）

- [ ] **Step 3: 测试**（mock useSessions 返回 2 session,断言渲染 sessionId 短 + req 数 + 点击导航）→ pass + typecheck。

- [ ] **Step 4: Commit** `feat(ui-v4): SessionsPage 列表(聚合行) + SessionRow`

---

## Task 5: AgentLane + SessionDetailPage（agent 泳道时间线）

**Files:** Create `ui-v4/src/components/sessions/AgentLane.tsx`, `ui-v4/src/components/sessions/SessionDetailPage.tsx`; Test `ui-v4/tests/SessionDetailPage.vitest.test.tsx`。

- [ ] **Step 1: 数据整形**（SessionDetailPage 内）：useSessionEntries(id) → entries（EntrySummary[]，有 `agentId?`/`startedAt`/`state`/`id`）。按 `agentId ?? "main"` 分组成泳道；每泳道按 startedAt 排序的请求块。

- [ ] **Step 2: AgentLane.tsx**（一行 agent:名(main / subagent 短 id) + 请求块行,块=RequestRow 精简或彩色块,点块→ /requests/:id 深链）

```tsx
import { useNavigate } from "react-router-dom"

import { statusSignal, type Signal } from "@/lib/format"
import type { EntrySummary } from "@/types"

const SIGNAL_COLOR: Record<Signal, string> = { ok: "var(--color-ok)", fail: "var(--color-fail)", warn: "var(--color-warn)", live: "var(--color-ok)", muted: "var(--color-muted)" }

export function AgentLane({ name, entries }: { name: string; entries: Array<EntrySummary> }) {
  const navigate = useNavigate()
  return (
    <div className="mono flex items-center gap-2 border-b border-[#1e1e24] py-1.5 text-[12px]">
      <span className="w-[140px] shrink-0 text-[var(--color-primary)]">{name}</span>
      <div className="flex flex-wrap gap-1">
        {entries.map((e) => (
          <button key={e.id} type="button" onClick={() => navigate(`/requests/${e.id}`)} title={e.state} className="h-3 w-6" style={{ background: SIGNAL_COLOR[statusSignal(e.state ?? "")] }} />
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: SessionDetailPage.tsx**（顶部 session 摘要 + main 泳道 + subagent 泳道们；`useParams` id;返回 Sessions 链接）。main 泳道 = `agentId` 为空的 entries，subagent 泳道 = 各 distinct agentId。**诚实标注**:subagent 名只有短 agentId（无种类名,spec §5）。

- [ ] **Step 4: 测试**（mock useSessionEntries 返回带不同 agentId 的 entries,断言 main 泳道 + subagent 泳道渲染 + 块点击导航）→ pass + typecheck。

- [ ] **Step 5: Commit** `feat(ui-v4): SessionDetailPage agent 泳道时间线(main+subagent 按 agentId) + AgentLane`

---

## Task 6: 路由接线 + 现状回填

**Files:** Modify `ui-v4/src/App.tsx`（`/sessions` + `/sessions/:id` 接真页）; Modify `ui-v4/README.md`。

- [ ] **Step 1: App.tsx** import SessionsPage/SessionDetailPage,加路由（requests 之后、catch-all 之前）：
```tsx
      { path: "sessions", element: <SessionsPage /> },
      { path: "sessions/:id", element: <SessionDetailPage /> },
```
保留 errorElement/catch-all/index/其余路由。catch-all 现在只兜真未知路径（nav 5 项全接线）。

- [ ] **Step 2: typecheck + 全测试 + build** → 全绿 + dist。

- [ ] **Step 3: 回填 README** 现状（Sessions 接线,nav 5 项全真页;Group-by 工作台/client/cost → 后续）。

- [ ] **Step 4: Commit** `feat(ui-v4): 路由接 Sessions 列表+详情真页(nav 5 项全接线)` + `docs(ui-v4): README 回填 Plan 05`（分两 commit:代码 + 文档）。

---

## Task 7: 手动验证 + 后端整体 review

- [ ] **Step 1: 手动验证（交用户）**:点 Sessions → session 列表（聚合行）→ 点一个 → agent 泳道时间线（main + subagent 们,块点击深链到 /requests/:id）。
- [ ] **Step 2:** 派 subagent 整体 review（后端聚合 SQL 正确性 + agentId 接线 + 前端 coherence + 无 overbuild + git 卫生,显式裁判轴）。

---

## 验收标准

- 后端:`bun run test:backend` 绿（sessions-agg it + sessions-route http + 无回归）;`bun run typecheck` 绿。
- 前端:typecheck/test/build 绿;零 binding.gyp。
- 手动:Sessions 列表聚合正确、详情 agent 泳道、块深链。nav 5 项全真页。

## 交给后续 Plan（本计划刻意不做）

- SessionSummary 加 **client / cost**（需 entries_v2 新列或 blob 解压 + multiplier 持久化）→ 成本轮 / Plan 05b
- 工作台「Group by: None/Session/Agent」开关 → Plan 05b
- subagent **种类名**（从 Task payload 的 subagent_type 推断）→ Plan 05b
- 独立 Agents 顶级页（跨 session）→ 视需要
- 详情 diff → Plan 03b;请求内搜索 → Plan 04;视觉打磨+响应式 → Plan 07;Config 结构化表单 → Plan 06b
