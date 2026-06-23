# ui-v4 Plan 06 — Overview / Models / Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。Steps 用 checkbox (`- [ ]`)。

**Goal:** 把 3 个"即将推出"死页（Overview / Models / Config）做成真页面，填上"全面可用"最大的可见缺口。**无后端改动**（全用现成端点）。

**Architecture:** server-state 用 TanStack Query：Overview ← `/api/status`（轮询）+ live-store（在飞实时）；Models ← `/api/models`；Config ← `GET/PUT /api/config/yaml`。Overview 精简（spec §7：实时健康，深度指标指向 Grafana）。Config 默认 **raw YAML 编辑器**（spec §7；结构化表单留后续）。路由把 `/overview`/`/models`/`/config` 接成真页（脱离 catch-all 占位）。

**Tech Stack:** 续前（React 18 / TS strict / TanStack Query / Tailwind v4 / bun+vitest）。

参照：spec [../DESIGN.md](../DESIGN.md) §7；后端端点 `/api/status`（quota/activeRequests/rateLimiter/requestTelemetry/memory/upstream_ws）、`/api/models`（`{ data: Array<model> }`）、`/api/config/yaml`（GET `ConfigYamlResponse` / PUT 保存）、`/api/stats?dimension=&window=`；现有 Vue 页 `ui/src/pages/vuetify/{VDashboardPage,VModelsPage,VConfigPage}.vue` + `ui/src/api/http.ts`（端点签名参照）。

**全局命令**（仓库根）：typecheck/test:bun/test:vitest/test/build `bun run --filter copilot-api-ui-v4 <script>`。

## 后端契约（实证，勿猜）

> **Task 1 deep-read 已完成,真实形状如下(覆盖本节早先的猜测):**
> - **`/api/status` 顶层键**:`status`/`uptime`/`version`/`auth`/`quota`/`activeRequests:{count}`/`rateLimiter:{enabled,mode?,queueLength?,...}`/`requestTelemetry`/`memory`/`shutdown:{phase}`/`models:{totalCount,availableCount}`/`upstream_ws:{enabled,active_connections,...}`/`protect_streaming`。**rateLimiter.mode** = `"normal"|"rate-limited"|"recovering"`(仅 enabled 时);**quota.status** = `"ok"|"no_data"|"error"`(ok 时 bucket 内有 `percent_remaining`/`plan`/`resetDate`);**memory 无 heap**,只有 `{historyEntryCount,historySuccessLimit,historyFailureLimit,inFlightCount,historyBackend}`。
> - **`/api/config/yaml`**:GET 返回**结构化 JSON 对象**(非 raw YAML string),PUT 接 **partial JSON**(稀疏覆盖)返回 parsed 对象,校验失败 `{error,details}` 400。→ ConfigPage 编辑 **pretty-printed JSON**(JSON.stringify/parse),非 raw text YAML。
> - **`/api/models`**:`{object:"list",data:Model[]}`,Model 顶层 = `id/name/vendor/version/object/preview/capabilities?/billing?/supported_endpoints?/policy?/model_picker_*/is_chat_*`。**扩展字段(context_window/vision/tools/reasoning/family)在嵌套 `capabilities`**,非顶层。ModelsPage 表列用 id/vendor/name/version + raw JSON 兜底(扩展字段从 capabilities 读)。


- `GET /api/status` → 顶层含 `activeRequests: { count }`、`quota`（`{ status, ... }`）、`rateLimiter`（mode 等）、`requestTelemetry`、`memory`、`upstream_ws`、auth、shutdown phase、model counts。**字段松散（多为 `Record<string,unknown>`）**——前端**防御性读取**（缺失优雅省略），实现前 deep-read `src/routes/status/*.ts` 确认实际顶层键。
- `GET /api/models` → `{ data: Array<Record<string, unknown>> }`，每个 model 含 id/vendor/capabilities/context_window 等（字段不一，**防御性读取** + raw 兜底）。
- `GET /api/config/yaml` → `ConfigYamlResponse`（结构化 config 对象）；本计划 raw YAML 编辑：**需要 YAML 文本**。**deep-read** `src/routes/config/*.ts` 确认 GET 是否返回 raw yaml string 字段（如 `{ yaml: string }`）还是结构化对象——若只返回结构化对象，前端用 `JSON.stringify` 或引入轻量 yaml stringify 展示；**实现前先确认**，按真实返回设计编辑器（raw text 优先，结构化对象则 pretty-print 可编辑）。PUT 保存体同 GET 返回结构。

---

## 文件结构（本计划新建/修改）

```
ui-v4/src/
├── lib/api.ts                    # 扩展:getRoot(根路径 /api/*)——或新增 apiRoot
├── types/status.ts               # 防御性 status/model/config 类型(前端专有,松散)
├── hooks/
│   ├── useStatus.ts              # /api/status 轮询
│   ├── useModels.ts              # /api/models
│   └── useConfigYaml.ts          # GET + PUT /api/config/yaml
├── components/
│   ├── overview/
│   │   ├── OverviewPage.tsx
│   │   ├── StatCard.tsx          # 通用指标卡
│   │   └── (其它小卡按需)
│   ├── models/
│   │   └── ModelsPage.tsx        # 目录表 + 过滤 + raw 切换
│   └── config/
│       └── ConfigPage.tsx        # raw YAML 编辑器 + 保存
└── App.tsx                       # /overview /models /config → 真页(脱离 catch-all)
tests/
├── OverviewPage.vitest.test.tsx
├── ModelsPage.vitest.test.tsx
└── ConfigPage.vitest.test.tsx
```

---

## Task 1: API client 扩展（根路径 /api/*）+ 防御性类型

**Files:** Modify `ui-v4/src/lib/api.ts`（加 PUT 方法，client 已能 GET 任意路径——`/api/*` 与 `/history/api/*` 都走同一 `fetchImpl(path)`，故 `api.get("/api/status")` 已可用；只需补 `put`）；Create `ui-v4/src/types/status.ts`; Test 追加 `ui-v4/tests/api.bun.test.ts`。

- [ ] **Step 1: deep-read** `src/routes/status/*.ts`、`src/routes/config/*.ts`、`src/routes/models/internal.ts` 确认 /api/status 顶层键、/api/config/yaml 返回结构（raw string? 结构化?）、/api/models 单 model 字段。记下真实形状。

- [ ] **Step 2: 加 failing test（api.put）**

追加到 `ui-v4/tests/api.bun.test.ts`:
```ts
it("put sends body and parses json", async () => {
  const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  const api = createApi(fetchMock as unknown as typeof fetch)
  const res = await api.put<{ ok: boolean }>("/api/config/yaml", { a: 1 })
  expect(res.ok).toBe(true)
})
```

- [ ] **Step 3: 给 `createApi` 加 `put`**（client 已有 get/delete；加 put 发 JSON body）

```ts
    put: <T,>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
```

- [ ] **Step 4: 写 `ui-v4/src/types/status.ts`**（防御性、松散——前端专有；按 Step 1 deep-read 结果定，至少：）

```ts
export interface ServerStatus {
  activeRequests?: { count?: number }
  quota?: Record<string, unknown>
  rateLimiter?: Record<string, unknown>
  memory?: Record<string, unknown>
  upstream_ws?: Record<string, unknown>
  [key: string]: unknown
}
export interface ModelInfo {
  id?: string
  vendor?: string
  [key: string]: unknown
}
export interface ConfigYaml {
  [key: string]: unknown
}
```
> 若 deep-read 发现 status/config 有更明确结构，收紧；但松散 + `[key: string]: unknown` 兜底保证防御性渲染。理想后端导出这些类型（Plan 待办），本计划前端松散定义。

- [ ] **Step 5: 跑 pass + typecheck + commit**

`cd ui-v4 && bun test tests/api.bun.test.ts`（pass）；typecheck clean。
```bash
git add -- ui-v4/src/lib/api.ts ui-v4/src/types/status.ts ui-v4/tests/api.bun.test.ts
git commit -m "feat(ui-v4): api.put + 防御性 status/model/config 类型"
```

---

## Task 2: hooks useStatus / useModels / useConfigYaml

**Files:** Create `ui-v4/src/hooks/{useStatus,useModels,useConfigYaml}.ts`。（接线 hook，typecheck 验证为主。）

- [ ] **Step 1: useStatus.ts**（轮询 /api/status）

```ts
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { ServerStatus } from "@/types/status"

export function useStatus() {
  return useQuery({
    queryKey: ["status"],
    queryFn: () => api.get<ServerStatus>("/api/status"),
    refetchInterval: 3000,
  })
}
```

- [ ] **Step 2: useModels.ts**

```ts
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { ModelInfo } from "@/types/status"

export function useModels() {
  return useQuery({
    queryKey: ["models"],
    queryFn: () => api.get<{ data: Array<ModelInfo> }>("/api/models"),
  })
}
```

- [ ] **Step 3: useConfigYaml.ts**（GET + PUT mutation）

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { ConfigYaml } from "@/types/status"

export function useConfigYaml() {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ["config-yaml"], queryFn: () => api.get<ConfigYaml>("/api/config/yaml") })
  const save = useMutation({
    mutationFn: (cfg: ConfigYaml) => api.put<ConfigYaml>("/api/config/yaml", cfg),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["config-yaml"] }),
  })
  return { query, save }
}
```

- [ ] **Step 4: typecheck + commit**

```bash
git add -- ui-v4/src/hooks/useStatus.ts ui-v4/src/hooks/useModels.ts ui-v4/src/hooks/useConfigYaml.ts
git commit -m "feat(ui-v4): hooks useStatus(轮询)/useModels/useConfigYaml(GET+PUT)"
```

---

## Task 3: StatCard + OverviewPage（精简,指向 Grafana）

**Files:** Create `ui-v4/src/components/overview/StatCard.tsx`, `ui-v4/src/components/overview/OverviewPage.tsx`; Test `ui-v4/tests/OverviewPage.vitest.test.tsx`。

- [ ] **Step 1: StatCard.tsx**（通用指标卡：label + value + sub）

```tsx
export function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="mono border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">{label}</div>
      <div className="text-[18px] font-bold text-[var(--color-primary)]">{value}</div>
      {sub ? <div className="text-[12px] text-[#888]">{sub}</div> : null}
    </div>
  )
}
```

- [ ] **Step 2: OverviewPage.tsx**（指标带 + Grafana 入口；防御性读 status）

留：In-flight（status.activeRequests.count，或 live-store size 实时）、Rate limiter（status.rateLimiter.mode）、Quota（status.quota.status + 百分比若有）、Upstream/WS（status.upstream_ws 健康）、Memory（status.memory.heap 若有）。底部"深度分析见 Grafana ↗"说明块。各值防御性 `?.`，缺失显 `—`。用 StatCard 网格。

```tsx
import { StatCard } from "@/components/overview/StatCard"
import { useStatus } from "@/hooks/useStatus"
import { useLiveStore } from "@/stores/live-store"

export function OverviewPage() {
  const { data, isLoading } = useStatus()
  const liveCount = useLiveStore((s) => Object.keys(s.byId).length)
  if (isLoading) return <div className="mono p-4 text-[#888]">loading…</div>
  const rl = data?.rateLimiter as { mode?: string } | undefined
  const quota = data?.quota as { status?: string } | undefined
  return (
    <div className="mono flex flex-col gap-4 p-2">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="In-flight" value={liveCount} sub="实时 · WS" />
        <StatCard label="Rate limiter" value={rl?.mode ?? "—"} />
        <StatCard label="Quota" value={quota?.status ?? "—"} />
        <StatCard label="Active (status)" value={(data?.activeRequests?.count ?? "—") as string | number} />
      </div>
      <div className="border border-dashed border-[#2f4a6f] bg-[#10161f] p-3 text-[13px] text-[#7da]">
        <div className="text-[#9ad]">📊 深度分析见 Grafana（消费 /metrics）</div>
        <div className="text-[12px] text-[#5a7a9a]">历史请求量/token/cost 趋势、跨窗口维度 breakdown — copilot_api_*_total 已由 /metrics 暴露。</div>
      </div>
    </div>
  )
}
```
> 按 Task 1 deep-read 的真实 status 字段调整 `rateLimiter.mode`/`quota.status`/`memory` 路径。缺失优雅 `—`。

- [ ] **Step 3: test**（mock useStatus + useLiveStore，断言渲染 In-flight 卡 + Grafana 块）→ pass + typecheck。

- [ ] **Step 4: commit** `feat(ui-v4): OverviewPage 精简(In-flight/limiter/quota + Grafana 入口) + StatCard`

---

## Task 4: ModelsPage（目录表）

**Files:** Create `ui-v4/src/components/models/ModelsPage.tsx`; Test `ui-v4/tests/ModelsPage.vitest.test.tsx`。

- [ ] **Step 1: ModelsPage.tsx**（表：id/vendor + 扩展字段防御性 + raw JSON 切换）

```tsx
import { useState } from "react"

import { useModels } from "@/hooks/useModels"

export function ModelsPage() {
  const { data, isLoading } = useModels()
  const [raw, setRaw] = useState(false)
  if (isLoading) return <div className="mono p-4 text-[#888]">loading…</div>
  const models = data?.data ?? []
  return (
    <div className="mono p-2 text-[13px]">
      <div className="mb-2 flex items-center gap-2">
        <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">Models · {models.length}</div>
        <button type="button" className="ml-auto text-[12px] text-[var(--color-primary)]" onClick={() => setRaw((v) => !v)}>
          {raw ? "table" : "raw JSON"}
        </button>
      </div>
      {raw ?
        <pre className="whitespace-pre-wrap break-all text-[12px] text-[#aaa]">{JSON.stringify(models, null, 2)}</pre>
      : <table className="w-full text-[12px]">
          <thead>
            <tr className="text-[11px] uppercase text-[var(--color-muted)]">
              <th className="px-2 py-1 text-left">id</th>
              <th className="px-2 py-1 text-left">vendor</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m, i) => (
              <tr key={(m.id as string) ?? i} className="border-b border-[#1e1e24]">
                <td className="px-2 py-1 text-[var(--color-primary)]">{(m.id as string) ?? "—"}</td>
                <td className="px-2 py-1 text-[#aaa]">{(m.vendor as string) ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>}
    </div>
  )
}
```
> 按 Task 1 deep-read 的真实 model 字段，**扩展表列**（context_window/vision/tools/reasoning/family 等防御性 `m.xxx`）。raw JSON 兜底保证无论字段如何都能看。

- [ ] **Step 2: test**（mock useModels 返回 2 个 model，断言表渲染 id/vendor + raw 切换）→ pass + typecheck。

- [ ] **Step 3: commit** `feat(ui-v4): ModelsPage 目录表(id/vendor/扩展 + raw 切换)`

---

## Task 5: ConfigPage（raw YAML 编辑器 + 保存）

**Files:** Create `ui-v4/src/components/config/ConfigPage.tsx`; Test `ui-v4/tests/ConfigPage.vitest.test.tsx`。

- [ ] **Step 1: ConfigPage.tsx**

按 Task 1 deep-read 的 `/api/config/yaml` 返回：若返回 raw yaml string → textarea 直接编辑该 string，保存 PUT 回去；若返回结构化对象 → textarea 编辑 `JSON.stringify(obj, null, 2)`，保存时 `JSON.parse` 回对象 PUT（解析失败给错误提示）。textarea + 保存按钮 + 保存状态（pending/success/error）。

```tsx
import { useEffect, useState } from "react"

import { useConfigYaml } from "@/hooks/useConfigYaml"

export function ConfigPage() {
  const { query, save } = useConfigYaml()
  const [text, setText] = useState("")
  const [parseError, setParseError] = useState<string | null>(null)
  useEffect(() => {
    if (query.data) setText(JSON.stringify(query.data, null, 2))
  }, [query.data])

  function onSave() {
    setParseError(null)
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      save.mutate(parsed)
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "parse error")
    }
  }

  if (query.isLoading) return <div className="mono p-4 text-[#888]">loading…</div>
  return (
    <div className="mono flex h-full flex-col gap-2 p-2 text-[13px]">
      <div className="flex items-center gap-2">
        <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">config.yaml</div>
        <button type="button" className="ml-auto border border-[var(--color-primary)] px-3 py-0.5 text-[12px] text-[var(--color-primary)]" onClick={onSave} disabled={save.isPending}>
          {save.isPending ? "saving…" : "save"}
        </button>
      </div>
      {parseError ? <div className="text-[12px] text-[var(--color-fail)]">解析错误:{parseError}</div> : null}
      {save.isError ? <div className="text-[12px] text-[var(--color-fail)]">保存失败:{save.error instanceof Error ? save.error.message : ""}</div> : null}
      {save.isSuccess ? <div className="text-[12px] text-[var(--color-ok)]">已保存</div> : null}
      <textarea className="min-h-0 flex-1 resize-none border border-[var(--color-border)] bg-[#0f0f12] p-2 text-[12px] text-[#cdb]" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
    </div>
  )
}
```
> 若 GET 返回 raw yaml string（非对象），改为直接编辑 string、PUT string（去掉 JSON.parse）。**实现前按 Task 1 deep-read 结果定**。spec §7 默认 raw 编辑——若后端只给结构化对象，pretty-print JSON 编辑是合理的 raw 形态（后端无 yaml-string 端点时）。

- [ ] **Step 2: test**（mock useConfigYaml 返回 query.data + save，断言 textarea 渲染配置 + 点 save 调 mutate）→ pass + typecheck。

- [ ] **Step 3: commit** `feat(ui-v4): ConfigPage raw 编辑器 + 保存(PUT /api/config/yaml)`

---

## Task 6: 路由接线（/overview /models /config → 真页）

**Files:** Modify `ui-v4/src/App.tsx`。

- [ ] **Step 1:** import OverviewPage/ModelsPage/ConfigPage；在 children 加：
```tsx
      { path: "overview", element: <OverviewPage /> },
      { path: "models", element: <ModelsPage /> },
      { path: "config", element: <ConfigPage /> },
```
（放在 requests 路由之后、catch-all `*` 之前。catch-all 保留兜未知路径；errorElement 保留。）Sessions 仍走 catch-all "即将推出"（Plan 05）。

- [ ] **Step 2: typecheck + 全测试 + build** → 全绿 + dist。

- [ ] **Step 3: commit** `feat(ui-v4): 路由接 Overview/Models/Config 真页(Sessions 仍占位待 Plan 05)`

---

## Task 7: 手动验证 + 现状回填

- [ ] **Step 1: 手动验证（交用户）**：点 Overview（指标卡 + Grafana 块）/ Models（表 + raw 切换）/ Config（编辑配置 + 保存）。Sessions 仍"即将推出"。
- [ ] **Step 2: 回填** `ui-v4/README.md` 现状（Overview/Models/Config 已接线；仅 Sessions 待 Plan 05）。
- [ ] **Step 3: commit** `docs(ui-v4): Plan 06 现状回填(Overview/Models/Config 落地)`

---

## 验收标准

- typecheck 绿；test 全绿；build 出 dist；零 binding.gyp。
- 手动:三页渲染真实数据、Config 可保存、nav 仅 Sessions 仍占位。

## 交给后续 Plan（本计划刻意不做）

- Config **结构化分组表单**（左 section 导航 + 字段控件 + 校验）→ Plan 06b（本计划 raw 编辑器优先，spec §7 默认 raw）
- Overview 深度遥测 breakdown → Grafana（已指向）；近期 outcomes 时间线 → 视需要 Plan 06b
- Models 完整扩展列 + 过滤栏 → 按 deep-read 字段在 Task 4 尽量做,复杂过滤留 Plan 06b
- Sessions + Agent + 后端聚合端点 → Plan 05
- 详情 diff → Plan 03b;请求内搜索 → Plan 04;视觉打磨+响应式 → Plan 07
