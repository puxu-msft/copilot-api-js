# Phase 2 (Frontend): ui-v4「Learned」页面（查看 / 导出 / 编辑）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 executing-plans。先读 [README.md](./README.md)（Global Constraints / 冻结契约）。**前置：Phase 1（backend.md）已落地**，`/api/negotiation` 契约冻结。

**Goal:** 新增 `/learned` 页面：按 10 个功能分组查看反应式学习记录、整体导出 v2 JSON、每行四个编辑动作（续约 / 立即失效 / pin·unpin / 删除）。

**测试运行**：`bun run test:ui`（vitest）；**交付前必跑** `bun run build:ui`（rollup，暴露 `~backend/*` 纯度问题 —— vitest+typecheck 会双假绿，见 skill `debugging-frontend-tests`）。

---

## 文件结构

- Modify `ui-v4/src/lib/api.ts` — 补 `post` 方法。
- Modify `ui-v4/src/types/index.ts` — re-export 后端 `LearnedSnapshot` / `LearnedEntryView` + `NegotiationCategory` / `EntryStatus`。
- Create `ui-v4/src/hooks/useLearned.ts` — react-query GET + 四 mutation。
- Create `ui-v4/src/lib/learned.ts` — 分类中文名映射 + 相对时间 + 导出 blob 构造（纯函数，可单测）。
- Create `ui-v4/src/components/learned/LearnedPage.tsx` — 页面（分组 + 筛选 + 导出）。
- Create `ui-v4/src/components/learned/LearnedRow.tsx` — 单行（值 + 徽章 + 时间 + 四动作）。
- Create `ui-v4/src/components/learned/StatusBadge.tsx` — 徽章（active/已过期/已固定）。
- Modify `ui-v4/src/components/shell/NavRail.tsx` — 加 `{ to: "/learned", label: "Learned" }`。
- Modify `ui-v4/src/App.tsx` — 加路由 `{ path: "learned", element: <LearnedPage /> }`。
- Tests: `ui-v4/tests/useLearned.vitest.test.tsx`、`ui-v4/tests/LearnedPage.vitest.test.tsx`、`ui-v4/tests/learned.vitest.test.ts`。

---

## Task F1: api.post + 类型 re-export + useLearned hook

**Files:**
- Modify: `ui-v4/src/lib/api.ts`
- Modify: `ui-v4/src/types/index.ts`
- Create: `ui-v4/src/hooks/useLearned.ts`
- Test: `ui-v4/tests/useLearned.vitest.test.tsx`

**Interfaces:**
- Consumes（B5/B7）：`GET /api/negotiation` → `LearnedSnapshot`；四 POST（见 README 冻结契约）。
- Produces：`useLearned()` → `{ query, renew, expire, setPin, remove }`（四个 `useMutation`）。

- [ ] **Step 1: api.post**（`ui-v4/src/lib/api.ts`，`put` 之后加）:
```ts
    post: <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) }),
```

- [ ] **Step 2: 类型 re-export**（`ui-v4/src/types/index.ts`，仿既有 barrel）:
```ts
// 反应式学习记录（SSOT：后端 feature-negotiation.ts + negotiation-lifecycle.ts）
export type { LearnedEntryView, LearnedSnapshot } from "~backend/lib/anthropic/feature-negotiation"
export type { EntryStatus, NegotiationCategory } from "~backend/lib/anthropic/negotiation-lifecycle"
```
> 依赖 backend.md B5/B1 已 `export` 这些 interface/type。若 `feature-negotiation.ts` 未导出 `LearnedEntryView`/`LearnedSnapshot`，回 B5 加 `export`。

- [ ] **Step 3: 写失败测试**（`ui-v4/tests/useLearned.vitest.test.tsx`，mock api）:
```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

const get = vi.fn().mockResolvedValue({ categories: [] })
const post = vi.fn().mockResolvedValue({ ok: true })
vi.mock("@/lib/api", () => ({ api: { get, post } }))

const { useLearned } = await import("@/hooks/useLearned")

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

describe("useLearned", () => {
  it("fetches snapshot and exposes mutations", async () => {
    const { result } = renderHook(() => useLearned(), { wrapper })
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledWith("/api/negotiation")
    result.current.renew.mutate({ category: "features", key: "k", value: "v" })
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/negotiation/renew", { category: "features", key: "k", value: "v" }))
  })
})
```

- [ ] **Step 4: 跑红** — Run: `bun run test:ui -- useLearned`. Expected: FAIL（hook 缺）。

- [ ] **Step 5: 实现**（`ui-v4/src/hooks/useLearned.ts`）:
```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import type { LearnedSnapshot, NegotiationCategory } from "@/types"

import { api } from "@/lib/api"

export interface EntryRef {
  category: NegotiationCategory
  key: string
  value: string
}

export function useLearned() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ["learned"], queryFn: () => api.get<LearnedSnapshot>("/api/negotiation") })
  const invalidate = () => qc.invalidateQueries({ queryKey: ["learned"] })

  const renew = useMutation({ mutationFn: (r: EntryRef) => api.post("/api/negotiation/renew", r), onSuccess: invalidate })
  const expire = useMutation({ mutationFn: (r: EntryRef) => api.post("/api/negotiation/expire", r), onSuccess: invalidate })
  const setPin = useMutation({
    mutationFn: (r: EntryRef & { pinned: boolean }) => api.post("/api/negotiation/pin", r),
    onSuccess: invalidate,
  })
  const remove = useMutation({ mutationFn: (r: EntryRef) => api.post("/api/negotiation/entry/delete", r), onSuccess: invalidate })

  return { query, renew, expire, setPin, remove }
}
```

- [ ] **Step 6: 跑绿 + 提交**

Run: `bun run test:ui -- useLearned`
```bash
git add -- ui-v4/src/lib/api.ts ui-v4/src/types/index.ts ui-v4/src/hooks/useLearned.ts ui-v4/tests/useLearned.vitest.test.tsx
git commit -F - -- ui-v4/src/lib/api.ts ui-v4/src/types/index.ts ui-v4/src/hooks/useLearned.ts ui-v4/tests/useLearned.vitest.test.tsx <<'EOF'
feat(ui): useLearned hook + api.post + negotiation type re-exports
EOF
```

---

## Task F2: learned.ts 纯函数（分类名 / 相对时间 / 导出 blob）

**Files:**
- Create: `ui-v4/src/lib/learned.ts`
- Test: `ui-v4/tests/learned.vitest.test.ts`

**Interfaces:**
- Produces：
  - `const CATEGORY_LABELS: Record<NegotiationCategory, string>`（中文名）
  - `function relativeTime(ms: number, now?: number): string`（如「3 天前」「刚刚」）
  - `function badgeKind(status: EntryStatus): "active" | "expired" | "pinned"`（合并 expired+manually_expired → "expired"）
  - `function snapshotToJsonBlob(snap: LearnedSnapshot): Blob`（导出用；也可导出后端 /export 原样，见 F4 决策）

- [ ] **Step 1: 写失败测试**（`ui-v4/tests/learned.vitest.test.ts`）:
```ts
import { describe, expect, it } from "vitest"

import { badgeKind, CATEGORY_LABELS, relativeTime } from "@/lib/learned"

describe("learned lib", () => {
  it("has a label for every category", () => {
    expect(CATEGORY_LABELS.features).toBeTruthy()
    expect(CATEGORY_LABELS.toolFields).toBeTruthy()
    expect(Object.keys(CATEGORY_LABELS).length).toBe(10)
  })
  it("merges manually_expired into expired badge", () => {
    expect(badgeKind("expired")).toBe("expired")
    expect(badgeKind("manually_expired")).toBe("expired")
    expect(badgeKind("pinned")).toBe("pinned")
    expect(badgeKind("active")).toBe("active")
  })
  it("relativeTime formats past", () => {
    const now = 10 * 86_400_000
    expect(relativeTime(9 * 86_400_000, now)).toContain("天前")
    expect(relativeTime(now, now)).toBe("刚刚")
  })
})
```

- [ ] **Step 2: 跑红** — Run: `bun run test:ui -- learned.vitest`. Expected: FAIL。

- [ ] **Step 3: 实现**（`ui-v4/src/lib/learned.ts`）:
```ts
import type { EntryStatus, LearnedSnapshot, NegotiationCategory } from "@/types"

/** 10 个功能分组的中文名（面向用户）。 */
export const CATEGORY_LABELS: Record<NegotiationCategory, string> = {
  features: "请求体字段（Extra inputs）",
  betas: "anthropic-beta 头",
  efforts: "reasoning effort 白名单",
  effortUnsupported: "不支持 effort 的模型",
  deferredTools: "强制不 defer 的工具",
  serverTools: "不支持的原生 server tool",
  partnerFeatures: "被禁的 partner 特性",
  systemRejectModels: "拒 role:system 的模型",
  serverToolDowngrade: "需降级 prior-turn server-tool 的模型",
  toolFields: "不支持的 custom-tool 字段（endpoint 级）",
}

/** 合并 expired 与 manually_expired 为同一「已过期」徽章（后端仍区分四态）。 */
export function badgeKind(status: EntryStatus): "active" | "expired" | "pinned" {
  if (status === "pinned") return "pinned"
  if (status === "active") return "active"
  return "expired" // expired | manually_expired
}

export function relativeTime(ms: number, now: number = Date.now()): string {
  const diff = now - ms
  if (diff < 60_000) return "刚刚"
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

/** 客户端 JSON blob（若改用后端 /export 则不需要 —— 见 F4）。 */
export function snapshotToJsonBlob(snap: LearnedSnapshot): Blob {
  return new Blob([JSON.stringify(snap, null, 2)], { type: "application/json" })
}
```

- [ ] **Step 4: 跑绿 + 提交**

Run: `bun run test:ui -- learned.vitest`
```bash
git add -- ui-v4/src/lib/learned.ts ui-v4/tests/learned.vitest.test.ts
git commit -F - -- ui-v4/src/lib/learned.ts ui-v4/tests/learned.vitest.test.ts <<'EOF'
feat(ui): learned lib (category labels, relative time, badge merge)
EOF
```

---

## Task F3: StatusBadge + LearnedRow

**Files:**
- Create: `ui-v4/src/components/learned/StatusBadge.tsx`
- Create: `ui-v4/src/components/learned/LearnedRow.tsx`
- Test: `ui-v4/tests/LearnedPage.vitest.test.tsx`（F4 一并覆盖行动作）

**样式约定**（沿用 ui-v4：mono、`var(--color-*)` token、边框 chip 而非填充 pill —— 见 [DetailParts.tsx Chip](../../../ui-v4/src/components/models/detail-tabs/DetailParts.tsx#L40-L43)、信号色 [RequestRow](../../../ui-v4/src/components/requests/RequestRow.tsx#L101-L106)）。

- [ ] **Step 1: StatusBadge**（`ui-v4/src/components/learned/StatusBadge.tsx`）:
```tsx
import type { EntryStatus } from "@/types"

import { badgeKind } from "@/lib/learned"

const STYLE: Record<"active" | "expired" | "pinned", { label: string; color: string }> = {
  active: { label: "● 活跃", color: "var(--color-ok)" },
  expired: { label: "● 已过期", color: "var(--color-muted)" },
  pinned: { label: "◆ 已固定", color: "var(--color-primary)" },
}

export function StatusBadge({ status }: { status: EntryStatus }) {
  const s = STYLE[badgeKind(status)]
  return (
    <span
      className="mono inline-block text-[11px]"
      style={{ color: s.color }}
      title={status}
    >
      {s.label}
    </span>
  )
}
```

- [ ] **Step 2: LearnedRow**（`ui-v4/src/components/learned/LearnedRow.tsx`）—— 值 + 徽章 + 时间 + 四动作:
```tsx
import type { LearnedEntryView } from "@/types"

import type { useLearned } from "@/hooks/useLearned"

import { relativeTime } from "@/lib/learned"
import { StatusBadge } from "@/components/learned/StatusBadge"

const BTN = "border px-1.5 py-0.5 text-[11px] disabled:opacity-40"

export function LearnedRow({ entry, actions }: { entry: LearnedEntryView; actions: ReturnType<typeof useLearned> }) {
  const ref = { category: entry.category, key: entry.key, value: entry.value }
  const busy = actions.renew.isPending || actions.expire.isPending || actions.setPin.isPending || actions.remove.isPending
  return (
    <div className="mono flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-2 py-1 text-[12px]">
      <span className="text-[#cdb]">{entry.value}</span>
      {entry.key ? <span className="text-[var(--color-muted)]">[{entry.key}]</span> : null}
      <StatusBadge status={entry.status} />
      {entry.migrated ? <span className="text-[10px] text-[var(--color-muted)]" title="迁移记录，首次学到时间未知">迁移</span> : null}
      <span className="text-[10px] text-[var(--color-muted)]">
        学于 {relativeTime(entry.firstLearnedAt)} · 确认 {relativeTime(entry.lastConfirmedAt)}
        {entry.expiresAt != null ? ` · 过期 ${new Date(entry.expiresAt).toLocaleString()}` : " · 永不过期"}
      </span>
      <span className="ml-auto flex gap-1">
        <button type="button" className={`${BTN} border-[var(--color-ok)] text-[var(--color-ok)]`} disabled={busy}
          onClick={() => actions.renew.mutate(ref)}>续约</button>
        <button type="button" className={`${BTN} border-[var(--color-muted)] text-[var(--color-muted)]`} disabled={busy}
          onClick={() => actions.expire.mutate(ref)}>立即失效</button>
        <button type="button" className={`${BTN} border-[var(--color-primary)] text-[var(--color-primary)]`} disabled={busy}
          onClick={() => actions.setPin.mutate({ ...ref, pinned: !entry.pinned })}>{entry.pinned ? "取消固定" : "固定"}</button>
        <button type="button" className={`${BTN} border-[var(--color-fail)] text-[var(--color-fail)]`} disabled={busy}
          onClick={() => { if (confirm(`删除该记录？\n${entry.category} / ${entry.value}`)) actions.remove.mutate(ref) }}>删除</button>
      </span>
    </div>
  )
}
```
> `confirm()` 在 jsdom 需 stub（F4 测试里 `vi.stubGlobal("confirm", () => true)`）。

- [ ] **Step 3: typecheck + lint + 提交**

Run: `cd ui-v4 && bun run typecheck` （或根 `bun run typecheck`）+ `bunx eslint ui-v4/src/components/learned/StatusBadge.tsx ui-v4/src/components/learned/LearnedRow.tsx`
```bash
git add -- ui-v4/src/components/learned/StatusBadge.tsx ui-v4/src/components/learned/LearnedRow.tsx
git commit -F - -- ui-v4/src/components/learned/StatusBadge.tsx ui-v4/src/components/learned/LearnedRow.tsx <<'EOF'
feat(ui): StatusBadge + LearnedRow (value/badge/time + 4 actions)
EOF
```

---

## Task F4: LearnedPage + nav + route + 导出 + 测试

**Files:**
- Create: `ui-v4/src/components/learned/LearnedPage.tsx`
- Modify: `ui-v4/src/components/shell/NavRail.tsx`、`ui-v4/src/App.tsx`
- Test: `ui-v4/tests/LearnedPage.vitest.test.tsx`

**Interfaces:** Consumes F1 `useLearned`、F2 `CATEGORY_LABELS`、F3 `LearnedRow`。导出复用 [triggerDownload](../../../ui-v4/src/lib/export-entry.ts#L14-L22) + 后端 `GET /api/negotiation/export`（`api.getBlob`）。

**导出决策**：用**后端 `/export`**（`api.getBlob('/api/negotiation/export')` → `triggerDownload`），得完整 v2 数据集（含未在快照展示的原始形状）；不用客户端 `snapshotToJsonBlob`（快照是 view 投影，非 v2 原始）。`snapshotToJsonBlob`（F2）保留作兜底/测试。

- [ ] **Step 1: 写失败测试**（`ui-v4/tests/LearnedPage.vitest.test.tsx`，mock useLearned）:
```tsx
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

const renewMutate = vi.fn()
const removeMutate = vi.fn()
const snapshot = {
  categories: [
    { category: "features", ttlMs: 2_592_000_000, entries: [
      { category: "features", key: "url|opus", value: "context_management", firstLearnedAt: 0, lastConfirmedAt: 0, expiresAt: 2_592_000_000, status: "active", pinned: false, migrated: false },
    ] },
    { category: "betas", ttlMs: 2_592_000_000, entries: [] },
  ],
}
vi.mock("@/hooks/useLearned", () => ({
  useLearned: () => ({
    query: { data: snapshot, isLoading: false },
    renew: { mutate: renewMutate, isPending: false },
    expire: { mutate: vi.fn(), isPending: false },
    setPin: { mutate: vi.fn(), isPending: false },
    remove: { mutate: removeMutate, isPending: false },
  }),
}))
vi.stubGlobal("confirm", () => true)

const { LearnedPage } = await import("@/components/learned/LearnedPage")

describe("LearnedPage", () => {
  it("renders grouped entries and hides empty groups", () => {
    render(<LearnedPage />)
    expect(screen.getByText("context_management")).toBeDefined()
    // empty 'betas' group hidden
    expect(screen.queryByText("anthropic-beta 头")).toBeNull()
  })
  it("renew action calls mutation", () => {
    render(<LearnedPage />)
    fireEvent.click(screen.getByText("续约"))
    expect(renewMutate).toHaveBeenCalledWith({ category: "features", key: "url|opus", value: "context_management" })
  })
  it("delete action calls mutation after confirm", () => {
    render(<LearnedPage />)
    fireEvent.click(screen.getByText("删除"))
    expect(removeMutate).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑红** — Run: `bun run test:ui -- LearnedPage`. Expected: FAIL（page 缺）。

- [ ] **Step 3: 实现 LearnedPage**（`ui-v4/src/components/learned/LearnedPage.tsx`）:
```tsx
import { useState } from "react"

import type { EntryStatus } from "@/types"

import { api } from "@/lib/api"
import { triggerDownload } from "@/lib/export-entry"
import { CATEGORY_LABELS, badgeKind } from "@/lib/learned"
import { useLearned } from "@/hooks/useLearned"
import { LearnedRow } from "@/components/learned/LearnedRow"

type Filter = "all" | "active" | "expired" | "pinned"

function matches(filter: Filter, status: EntryStatus): boolean {
  if (filter === "all") return true
  return badgeKind(status) === filter
}

export function LearnedPage() {
  const actions = useLearned()
  const [filter, setFilter] = useState<Filter>("all")
  const [exporting, setExporting] = useState(false)

  async function onExport() {
    if (exporting) return
    setExporting(true)
    try {
      const blob = await api.getBlob("/api/negotiation/export")
      triggerDownload(blob, "negotiation-states.json")
    } finally {
      setExporting(false)
    }
  }

  if (actions.query.isLoading) return <div className="mono p-4 text-[#888]">loading…</div>
  const snap = actions.query.data
  const groups = (snap?.categories ?? [])
    .map((g) => ({ ...g, entries: g.entries.filter((e) => matches(filter, e.status)) }))
    .filter((g) => g.entries.length > 0)

  return (
    <div className="mono flex h-full flex-col gap-2 overflow-auto p-2 text-[13px]">
      <div className="flex items-center gap-2">
        <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">反应式学习记录</div>
        <div className="ml-auto flex items-center gap-1">
          {(["all", "active", "expired", "pinned"] as const).map((f) => (
            <button key={f} type="button"
              className={`border px-2 py-0.5 text-[11px] ${filter === f ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-[var(--color-border)] text-[var(--color-muted)]"}`}
              onClick={() => setFilter(f)}>{f}</button>
          ))}
          <button type="button" className="border border-[var(--color-primary)] px-2 py-0.5 text-[11px] text-[var(--color-primary)] disabled:opacity-50"
            onClick={() => void onExport()} disabled={exporting}>{exporting ? "导出中…" : "整体导出"}</button>
        </div>
      </div>
      {groups.length === 0 ? <div className="text-[12px] text-[var(--color-muted)]">无记录</div> : null}
      {groups.map((g) => (
        <section key={g.category} className="border border-[var(--color-border)]">
          <div className="flex items-center gap-2 bg-[#15151a] px-2 py-1 text-[12px]">
            <span className="text-[var(--color-primary)]">{CATEGORY_LABELS[g.category]}</span>
            <span className="text-[10px] text-[var(--color-muted)]">
              {g.entries.length} 条 · TTL {g.ttlMs == null ? "永不" : `${Math.round(g.ttlMs / 86_400_000)}d`}
            </span>
          </div>
          {g.entries.map((e) => <LearnedRow key={`${e.key}|${e.value}`} entry={e} actions={actions} />)}
        </section>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: nav + route**
  - `ui-v4/src/components/shell/NavRail.tsx` 的 `ITEMS` 加 `{ to: "/learned", label: "Learned" },`（放 Config 后）。
  - `ui-v4/src/App.tsx`：import `LearnedPage`，children 加 `{ path: "learned", element: <LearnedPage /> }`。

- [ ] **Step 5: 跑绿** — Run: `bun run test:ui -- LearnedPage`. Expected: PASS。

- [ ] **Step 6: build:ui（关键闸门）+ lint**

Run: `bun run build:ui`
Expected: rollup 成功（验 `~backend/*` re-export 纯度 —— 若 `feature-negotiation.ts` / `negotiation-lifecycle.ts` 传递 import 了 `~/lib/state` 等非纯模块，type-only re-export 应被 `import type` 擦除；若 build 报把后端运行时拉进前端 bundle，改用 `export type { … }`（已是 type-only）并确认 barrel 只 re-export 类型）。
Run: `bunx eslint ui-v4/src/components/learned/LearnedPage.tsx ui-v4/src/App.tsx ui-v4/src/components/shell/NavRail.tsx`

- [ ] **Step 7: 提交**
```bash
git add -- ui-v4/src/components/learned/LearnedPage.tsx ui-v4/src/components/shell/NavRail.tsx ui-v4/src/App.tsx ui-v4/tests/LearnedPage.vitest.test.tsx
git commit -F - -- ui-v4/src/components/learned/LearnedPage.tsx ui-v4/src/components/shell/NavRail.tsx ui-v4/src/App.tsx ui-v4/tests/LearnedPage.vitest.test.tsx <<'EOF'
feat(ui): Learned page (grouped view, filter, export, edit actions) + nav/route
EOF
```

---

## Phase 2 自查（对照 spec AC7）

- 10 分组分节、空组隐藏、节头 TTL + 条目数 → Step 3 ✓
- 每行 value/key、状态徽章（合并已过期）、firstLearnedAt/lastConfirmedAt 相对时间、过期时间、migrated 提示 → F3 ✓
- 四动作续约/立即失效/pin·unpin/删除（删除二次确认）→ F3 ✓
- 整体导出（后端 /export v2 JSON 下载）→ F4 ✓
- 状态筛选 all/active/expired/pinned → F4 ✓
- SSOT 类型经 `~backend` re-export → F1 ✓
- **build:ui 必过** → F4 Step-6 ✓

## 收尾（session-closeout，Phase 2 后）

见 [README.md](./README.md) 收尾节：① subagent 交付审计（react-reviewer + typescript-reviewer，裁判轴长远正确+完整）② doc-sync：`docs/DESIGN.md` 活的架构现状加 negotiation-lifecycle 行 + 配置节加 `negotiation_learning`；README 用户功能列表加「Learned 页面」③ 归档本 plan（头部实施状态注解）④ 记忆库提炼 ⑤ 阶段提交。
