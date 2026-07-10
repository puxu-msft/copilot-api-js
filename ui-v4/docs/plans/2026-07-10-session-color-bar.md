# Session 色带 + 多选对比高亮 + 可切换色板 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ui-v4 Requests 列表左侧加 session 稳定色带（subagent 缩进+色深），默认按会话淡底纹分组，点色带/按 `f` 多选会话对比高亮（选中强背景、其余变灰），4 套可切换色板持久化；全局时序不动、后端零改动。

**Architecture:** 一个纯函数 leaf（`session-color.ts`：hash + 色板注册表 + tint + run 边界）承载全部配色逻辑并 bun 单测；`HistoryList` 的 `itemContent` 对 session 列**特判**（绕过 TanStack flexRender，用 Virtuoso `context` 第三参取 runs），`TableRow` 按单值背景优先级算 tint/dim；theme.css 加圆角破例类。选择态/色板态为 HistoryList 本地 `useState`。

**Tech Stack:** React 18 + TypeScript + @tanstack/react-table + react-virtuoso + Tailwind v4 + Radix Select；bun test（纯逻辑）+ vitest/jsdom + @testing-library/react（组件）。

**权威 spec：** [ui-v4/docs/spec/2026-07-10-ui-v4-session-color-bar.md](../spec/2026-07-10-ui-v4-session-color-bar.md)（本计划是其落地；概念/取舍/审查纪要看 spec，本计划只讲怎么做）。

## Global Constraints

- **后端零改动**：只碰 `ui-v4/src/**` 与 `ui-v4/src/styles/theme.css`。
- **全局时序不动**：不重排、不过滤删行——只叠视觉层（色带/背景/dim）。
- **色列取数走 itemContent 第三参 context，绝不走 `ColumnDef.cell`**（flexRender 的 `cell.getContext()` 拿不到 Virtuoso RowContext，审查已证伪）。
- **session td 破例统一外壳**：session 列的 `<td>` 用 `p-0 relative`，**不套** `overflow-hidden px-2 py-1`（否则 `w-[10px]` 被 `px-2` 吃穿、色块断裂）。
- **圆角走破例类 + `!important`**：全局有 `*{border-radius:0!important}`（theme.css:29），段帽圆角必须用类选择器 + `!important` 压过（照 `.livedock-island` 先例），裸 `rounded-*` 无效。
- **dim 只用 `opacity-40`**：不叠 muted 文字类（与 `selectionClass` 文字色同权重冲突）。
- **subagent 缩进落在 status 单元格内容左 padding**（`pl-3`），不改列宽（table-fixed 下整行缩进不可行）。
- **默认色板 `terminal-neon`**；色板选择 localStorage 键 `ui-v4:requests:session-palette`，未知名回退默认。
- **色值逐字取自 spec §4 色板注册表具体值**（4 套、hex 精确）；CVD 校验为附带记录、非约束（用户群无色盲）。
- **门禁**：每任务 `bunx tsc --noEmit`（或项目 `typecheck:ui-v4`）+ 无缓存 `bunx eslint <改动文件>` + 对应测试全绿后提交；显式 pathspec commit。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `ui-v4/src/lib/session-color.ts` | 纯配色 leaf：`SessionPalette` 类型、`SESSION_PALETTES` 注册表、`DEFAULT_PALETTE_NAME`、`hashString`、`sessionColor`、`sessionTint`、`computeSessionRuns`、`PALETTE_STORAGE_KEY` | 新建 |
| `ui-v4/src/lib/session-color.bun.test.ts` | 上述纯函数 + 注册表自校验 | 新建 |
| `ui-v4/src/styles/theme.css` | `.session-cap-top` / `.session-cap-bottom` 圆角破例类 | 改 |
| `ui-v4/src/lib/request-columns.ts` | `COLUMN_WIDTHS.session` + `REQUEST_COLUMNS` 头部 display 列 `session` | 改 |
| `ui-v4/src/components/requests/SessionPaletteSelect.tsx` | 色板下拉（Radix Select，无 ALL 哨兵） | 新建 |
| `ui-v4/src/components/requests/HistoryList.tsx` | runs memo、选择态、色板态+持久化、itemContent 首列特判、TableRow 背景优先级+dim、`f`/Esc 键盘、挂选择器 | 改 |
| `ui-v4/tests/HistoryList.vitest.test.tsx` | 扩展：色列渲染、多选交互、键盘、默认态、切色板、正交 | 改 |
| `ui-v4/tests/SessionPaletteSelect.vitest.test.tsx` | 选择器渲染+切换回调 | 新建 |

---

## Task 1: session-color.ts 纯配色 leaf

**Files:**
- Create: `ui-v4/src/lib/session-color.ts`
- Test: `ui-v4/src/lib/session-color.bun.test.ts`

**Interfaces:**
- Produces:
  - `interface SessionPalette { name: string; label: string; colors: ReadonlyArray<{ base: string; shade: string }>; faintAlpha: number; strongAlpha: number }`
  - `const SESSION_PALETTES: ReadonlyArray<SessionPalette>`；`const DEFAULT_PALETTE_NAME: string`
  - `const PALETTE_STORAGE_KEY: string`
  - `function sessionColor(sessionId: string | undefined, palette: SessionPalette): { base: string; shade: string } | null`
  - `function sessionTint(baseColor: string, alpha: number): string`（`"rgba(r, g, b, a)"`）
  - `interface RunInfo { color: string; shade: string; indent: boolean; isRunStart: boolean; isRunEnd: boolean; faintTint: string; strongTint: string }`
  - `function computeSessionRuns(rows: ReadonlyArray<{ id: string; sessionId?: string; agentId?: string }>, palette: SessionPalette): Map<string, RunInfo>`

- [ ] **Step 1: 写失败测试**

Create `ui-v4/src/lib/session-color.bun.test.ts`:

```ts
import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  computeSessionRuns,
  DEFAULT_PALETTE_NAME,
  SESSION_PALETTES,
  sessionColor,
  sessionTint,
} from "@/lib/session-color"

const SEMANTIC = ["#d4a04a", "#7fd99a", "#e08a8a"] // primary/warn, ok, fail
const P = SESSION_PALETTES.find((p) => p.name === DEFAULT_PALETTE_NAME)!

describe("SESSION_PALETTES 注册表", () => {
  test("默认色板在注册表内", () => {
    expect(P).toBeDefined()
    expect(SESSION_PALETTES.length).toBeGreaterThanOrEqual(4)
  })
  test("每色是合法 6 位 hex、shade 较 base 更深", () => {
    const hex = /^#[0-9a-f]{6}$/
    for (const pal of SESSION_PALETTES) {
      expect(pal.colors.length).toBeGreaterThanOrEqual(8)
      for (const { base, shade } of pal.colors) {
        expect(base).toMatch(hex)
        expect(shade).toMatch(hex)
        // shade 明度更低：sRGB 亮度近似 (r+g+b) 之和更小
        const sum = (h: string) => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16)
        expect(sum(shade)).toBeLessThan(sum(base))
      }
    }
  })
  test("无 base/shade 撞语义信号色", () => {
    for (const pal of SESSION_PALETTES) {
      for (const { base, shade } of pal.colors) {
        expect(SEMANTIC).not.toContain(base)
        expect(SEMANTIC).not.toContain(shade)
      }
    }
  })
  test("alpha 档位：0<faint<strong<=1", () => {
    for (const pal of SESSION_PALETTES) {
      expect(pal.faintAlpha).toBeGreaterThan(0)
      expect(pal.faintAlpha).toBeLessThan(pal.strongAlpha)
      expect(pal.strongAlpha).toBeLessThanOrEqual(1)
    }
  })
})

describe("sessionColor", () => {
  test("undefined → null", () => {
    expect(sessionColor(undefined, P)).toBeNull()
    expect(sessionColor("", P)).toBeNull()
  })
  test("同 id 稳定同色", () => {
    expect(sessionColor("sess-abc", P)).toEqual(sessionColor("sess-abc", P))
  })
  test("不同 id 抽样落多个槽", () => {
    const idxs = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(sessionColor(`s${i}`, P))))
    expect(idxs.size).toBeGreaterThan(3)
  })
})

describe("sessionTint", () => {
  test("hex → rgba", () => {
    expect(sessionTint("#2f9af2", 0.14)).toBe("rgba(47, 154, 242, 0.14)")
  })
})

describe("computeSessionRuns", () => {
  const rows = [
    { id: "a", sessionId: "S1", agentId: undefined },
    { id: "b", sessionId: "S1", agentId: "ag1" }, // subagent
    { id: "c", sessionId: "S2", agentId: undefined }, // 打断 S1
    { id: "d", sessionId: "S1", agentId: undefined }, // S1 第二段
    { id: "e", sessionId: undefined, agentId: undefined }, // 无会话
  ]
  const runs = computeSessionRuns(rows, P)

  test("无 sessionId 行不入 map", () => {
    expect(runs.has("e")).toBe(false)
  })
  test("段首/段尾边界正确（S1 被 S2 打断成两段）", () => {
    expect(runs.get("a")!.isRunStart).toBe(true)
    expect(runs.get("b")!.isRunEnd).toBe(true) // 下一行 c 是 S2
    expect(runs.get("d")!.isRunStart).toBe(true) // 上一行 c 是 S2
    expect(runs.get("d")!.isRunEnd).toBe(true) // 下一行 e 非 S1
  })
  test("subagent 行 indent=true 且色带用 shade", () => {
    expect(runs.get("b")!.indent).toBe(true)
    expect(runs.get("b")!.shade).not.toBe(runs.get("b")!.color)
    expect(runs.get("a")!.indent).toBe(false)
  })
  test("同 id 的 a 与 d 同 color（同 S1）", () => {
    expect(runs.get("a")!.color).toBe(runs.get("d")!.color)
  })
  test("末行 isRunEnd=true（分页前沿暂定）", () => {
    const r2 = computeSessionRuns([{ id: "x", sessionId: "S9" }], P)
    expect(r2.get("x")!.isRunStart).toBe(true)
    expect(r2.get("x")!.isRunEnd).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ui-v4 && bun test src/lib/session-color.bun.test.ts`
Expected: FAIL — `Cannot find module "@/lib/session-color"`。

- [ ] **Step 3: 写实现**

Create `ui-v4/src/lib/session-color.ts`（`SESSION_PALETTES` 色值逐字取自 spec §4）：

```ts
/** 一套分类色板：name（kebab）+ 中文风格 label + N 个 {base,shade} 配对 + 淡/强 tint alpha。 */
export interface SessionPalette {
  name: string
  label: string
  colors: ReadonlyArray<{ base: string; shade: string }>
  faintAlpha: number
  strongAlpha: number
}

/** 每行的 run 元信息（color/shade 已按当前色板解析；faint/strong tint 预算好供背景优先级取用）。 */
export interface RunInfo {
  color: string
  shade: string
  indent: boolean
  isRunStart: boolean
  isRunEnd: boolean
  faintTint: string
  strongTint: string
}

/** localStorage 键 —— 所选 session 色板名。 */
export const PALETTE_STORAGE_KEY = "ui-v4:requests:session-palette"

/**
 * 4 套精选分类色板（配色 subagent invoke dataviz skill 产出、官方 validator 实测）。
 * 全部锁冷色弧、与语义信号色（琥珀/绿/红粉）色相距 ≥33°、#141210 上可辨。
 * shade = OKLCH(L−0.10)，用于 subagent 从属色带。色值逐字取自 spec §4。
 */
export const SESSION_PALETTES: ReadonlyArray<SessionPalette> = [
  {
    name: "terminal-neon",
    label: "冷调霓虹（高饱和·分离度最佳·默认）",
    faintAlpha: 0.14,
    strongAlpha: 0.2,
    colors: [
      { base: "#00a39a", shade: "#00847c" },
      { base: "#009fb2", shade: "#008093" },
      { base: "#009bce", shade: "#007cad" },
      { base: "#2f9af2", shade: "#007bd0" },
      { base: "#4a78f9", shade: "#2f58d6" },
      { base: "#6f48f3", shade: "#561ed0" },
      { base: "#953cd1", shade: "#7710af" },
      { base: "#a442a8", shade: "#842089" },
      { base: "#ab448e", shade: "#8a2470" },
    ],
  },
  {
    name: "oceanic-jewel",
    label: "冷色宝石（深浓通透·与 amber 最和谐）",
    faintAlpha: 0.12,
    strongAlpha: 0.18,
    colors: [
      { base: "#00968b", shade: "#00786e" },
      { base: "#0093a5", shade: "#007586" },
      { base: "#008dc3", shade: "#006fa3" },
      { base: "#2569a8", shade: "#004c88" },
      { base: "#5874ea", shade: "#3e55c8" },
      { base: "#7746e0", shade: "#5c1fbe" },
      { base: "#a43ecf", shade: "#8513ae" },
      { base: "#b321a2", shade: "#910083" },
    ],
  },
  {
    name: "pastel-cool",
    label: "冷柔和（浅·低饱和·克制）",
    faintAlpha: 0.14,
    strongAlpha: 0.18,
    colors: [
      { base: "#28a6a0", shade: "#008782" },
      { base: "#2ea6ba", shade: "#00879b" },
      { base: "#449dc7", shade: "#1e7ea7" },
      { base: "#5d95d7", shade: "#3f76b6" },
      { base: "#7080dd", shade: "#5462bc" },
      { base: "#7f66b8", shade: "#634998" },
      { base: "#9360a3", shade: "#754384" },
      { base: "#a25b90", shade: "#823e72" },
    ],
  },
  {
    name: "slate-muted",
    label: "冷板岩柔和（低饱和·沉稳）",
    faintAlpha: 0.16,
    strongAlpha: 0.18,
    colors: [
      { base: "#27a6a3", shade: "#008785" },
      { base: "#2ca2b9", shade: "#00839a" },
      { base: "#2e83b0", shade: "#006591" },
      { base: "#3262a9", shade: "#154589" },
      { base: "#6c6fc8", shade: "#5151a7" },
      { base: "#9d81ce", shade: "#7f63ad" },
      { base: "#8c5798", shade: "#6e3b79" },
      { base: "#955584", shade: "#763967" },
    ],
  },
]

export const DEFAULT_PALETTE_NAME = "terminal-neon"

/** FNV-1a 32-bit（纯函数、无依赖）；稳定把 sessionId 映到色板槽。 */
function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 稳定 hash(sessionId) → 给定色板里索引一个 {base,shade}；无 sessionId → null。 */
export function sessionColor(sessionId: string | undefined, palette: SessionPalette): { base: string; shade: string } | null {
  if (!sessionId) return null
  const idx = hashString(sessionId) % palette.colors.length
  return palette.colors[idx]
}

/** 会话色 hex + alpha → rgba 背景串。 */
export function sessionTint(baseColor: string, alpha: number): string {
  const hex = baseColor.replace("#", "")
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * 相邻 run 边界预扫。跑在已加载全部页拼接的 rows 上（非虚拟化窗口），故不截断。
 * 无 sessionId 的行不入 map（调用方据此不铺色带/背景）。分页前沿末行 isRunEnd 暂定 true，
 * 翻页后 rows 变、本函数经 memo 重算收敛。
 */
export function computeSessionRuns(
  rows: ReadonlyArray<{ id: string; sessionId?: string; agentId?: string }>,
  palette: SessionPalette,
): Map<string, RunInfo> {
  const map = new Map<string, RunInfo>()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const pair = sessionColor(row.sessionId, palette)
    if (!pair) continue
    const prev = rows[i - 1]
    const next = rows[i + 1]
    map.set(row.id, {
      color: pair.base,
      shade: pair.shade,
      indent: row.agentId !== undefined,
      isRunStart: !prev || prev.sessionId !== row.sessionId,
      isRunEnd: !next || next.sessionId !== row.sessionId,
      faintTint: sessionTint(pair.base, palette.faintAlpha),
      strongTint: sessionTint(pair.base, palette.strongAlpha),
    })
  }
  return map
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ui-v4 && bun test src/lib/session-color.bun.test.ts`
Expected: PASS（全部 case 绿）。

- [ ] **Step 5: typecheck + lint**

Run: `cd ui-v4 && bunx tsc --noEmit && bunx eslint src/lib/session-color.ts src/lib/session-color.bun.test.ts`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add -- ui-v4/src/lib/session-color.ts ui-v4/src/lib/session-color.bun.test.ts
git commit -m "feat(ui-v4): session-color leaf — palette registry + hash + tint + run boundaries"
```

---

## Task 2: 色列渲染 + 段帽 + subagent 缩进 + 默认淡背景（无交互）

**Files:**
- Modify: `ui-v4/src/styles/theme.css`（加破例圆角类）
- Modify: `ui-v4/src/lib/request-columns.ts:123-135`（`COLUMN_WIDTHS.session`）+ `REQUEST_COLUMNS` 头部加 display 列
- Modify: `ui-v4/src/components/requests/HistoryList.tsx`（runs memo、RowContext 扩展、itemContent 首列特判、TableRow 默认淡背景）
- Modify: `ui-v4/tests/HistoryList.vitest.test.tsx`（色列渲染 + 默认淡背景 + subagent 缩进）

**Interfaces:**
- Consumes: Task 1 的 `computeSessionRuns` / `RunInfo` / `SESSION_PALETTES` / `DEFAULT_PALETTE_NAME`。
- Produces: `RowContext` 增字段 `runs: Map<string, RunInfo>`（Task 3 再加 `selectedSessions` / `onToggleSession`）。session 列 `id === "session"`。

- [ ] **Step 1: 写失败测试**（追加到 `ui-v4/tests/HistoryList.vitest.test.tsx` 末尾）

**必须先读该文件顶部（:42-153）**：真实 render helper 是 `renderList(initialEntries: Array<string> = ["/requests"], filters?, onClearFilters?)`（第一参是 router URL 数组，**非** entries）；entries 经模块级 `mockHistory = { ...mockHistory, entries: [...], total: N }` 在渲染前设；`entry(id)` helper（:105）返回 `as unknown as EntrySummary`（cast 绕过必填字段，故 spread override 加 `sessionId`/`agentId` 即可，天然满足 `responsePreviewText` 等必填）；导航断言用内联 `<LocationProbe/>` 查 `getByTestId("loc").textContent`。**别用 `renderHistoryList`（不存在）。**

```tsx
import { SESSION_PALETTES } from "@/lib/session-color"

describe("HistoryList — session 色带（Task 2 默认态）", () => {
  const withSessions = () => {
    mockHistory = {
      ...mockHistory,
      entries: [
        { ...entry("a"), sessionId: "S1" }, // main
        { ...entry("b"), sessionId: "S1", agentId: "ag1" }, // subagent
        { ...entry("c") }, // 无 session（entry() 默认无 sessionId）
      ],
      total: 3,
    }
  }

  it("带 session 行渲染色带按钮；无 session 行无（=2）", () => {
    withSessions()
    renderList(["/requests"])
    const bars = document.querySelectorAll('button[aria-label="toggle session highlight"]')
    expect(bars.length).toBe(2)
  })

  it("默认态：带 session 行有淡背景 rgba style", () => {
    withSessions()
    renderList(["/requests"])
    const rowA = document.querySelector('[data-entry-id="a"]') as HTMLElement
    expect(rowA.style.backgroundColor).toMatch(/^rgba\(/)
    const rowC = document.querySelector('[data-entry-id="c"]') as HTMLElement
    expect(rowC.style.backgroundColor).toBe("") // 无 session → 无背景
  })

  it("subagent 行 status 单元格缩进（pl-3），main 行不缩进", () => {
    withSessions()
    renderList(["/requests"])
    const rowB = document.querySelector('[data-entry-id="b"]') as HTMLElement
    const rowA = document.querySelector('[data-entry-id="a"]') as HTMLElement
    // tds[0]=session 色列, tds[1]=status
    expect(rowB.querySelectorAll("td")[1].className).toContain("pl-3")
    expect(rowA.querySelectorAll("td")[1].className).not.toContain("pl-3")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ui-v4 && bunx vitest run tests/HistoryList.vitest.test.tsx -t "session 色带"`
Expected: FAIL（无色带按钮 / 无背景 / 无 pl-3）。

- [ ] **Step 3-pre-a: 修 fake Virtuoso mock 传第三参 context（C1，否则打爆全部现有用例）**

`ui-v4/tests/HistoryList.vitest.test.tsx` 的 fake mock（:58 与 :72）现只给 itemContent 传 2 参，session 列特判会读 `context.runs` → `context` 为 `undefined` 崩溃、连累所有现有用例。改两处：

`:58`：
```ts
const itemContent = props.itemContent as (index: number, row: unknown, context: unknown) => React.ReactNode
```
`:72`（`<Row>` 的 children）：
```tsx
{itemContent(i, row, context)}
```

- [ ] **Step 3-pre-b: 更新列序断言 + 纳入门禁（C2）**

`ui-v4/src/lib/request-columns.bun.test.ts:43` 的 `toEqual([...])` 精确列序断言首项加 `"session"`：
```ts
expect(REQUEST_COLUMNS.map((c) => c.id as string)).toEqual([
  "session",
  "status",
  "time",
  "dur",
  "model",
  "multiplier",
  "endpoint",
  "bytes",
  "tokens",
  "attempts",
  "preview",
  "response",
])
```
（`REQUEST_COLUMN_IDS === map` 自洽断言、`DEFAULT_COLUMN_VISIBILITY` keys、`COLUMN_WIDTHS` per-id 断言都因 session 同步进两处而自动仍过。）**本 bun 测试纳入 Step 5 门禁。**

- [ ] **Step 3a: theme.css 加破例圆角类**

在 `ui-v4/src/styles/theme.css` 的 `.livedock-island` 那条后追加：

```css
/* session 色带段帽破例:全局 `*{border-radius:0!important}` 抹平圆角,段首/段尾用极小 2px 软化。
 * 类选择器(0,1,0)+ !important 压过全局通配符,照 .livedock-island 先例。 */
.session-cap-top { border-top-left-radius: 2px !important; border-top-right-radius: 2px !important; }
.session-cap-bottom { border-bottom-left-radius: 2px !important; border-bottom-right-radius: 2px !important; }
```

- [ ] **Step 3b: request-columns.ts 加 session 列 + 列宽**

`COLUMN_WIDTHS`（:123-135）加一项：

```ts
export const COLUMN_WIDTHS: Record<string, string> = {
  session: "w-[10px]",
  status: "w-[92px]",
  // …其余不变
```

`REQUEST_COLUMNS`（:142）数组**头部**插入 display 列（实际渲染在 itemContent 特判，cell 仅占位）：

```ts
export const REQUEST_COLUMNS: Array<ColumnDef<EntrySummary>> = [
  {
    id: "session",
    header: "",
    cell: () => null, // 实际色块在 HistoryList itemContent 首列特判渲染(审查:ColumnDef.cell 拿不到 runs)
    meta: { width: COLUMN_WIDTHS.session },
  },
  {
    id: "status",
    // …其余列不变
```

- [ ] **Step 3c: HistoryList.tsx —— runs memo + RowContext + itemContent 特判 + TableRow 淡背景**

① 顶部 import：
```ts
import { computeSessionRuns, DEFAULT_PALETTE_NAME, SESSION_PALETTES, type RunInfo } from "@/lib/session-color"
```

② `RowContext` 接口（:70-78）加字段：
```ts
interface RowContext {
  at: string | null
  flashId: string | null
  focusedId: string | null
  tabStopId: string | null
  onSelect: (id: string) => void
  /** 每行 run 元信息(色带色/段帽/缩进/tint);无 sessionId 行不在 map。 */
  runs: Map<string, RunInfo>
}
```

③ `HistoryList` 组件体内，`entries` 拿到后加（Task 3 会把 `DEFAULT_PALETTE_NAME` 换成色板态）：
```ts
const activePalette = SESSION_PALETTES.find((p) => p.name === DEFAULT_PALETTE_NAME) ?? SESSION_PALETTES[0]
const runs = useMemo(() => computeSessionRuns(entries, activePalette), [entries, activePalette])
```

④ `rowContext` useMemo（:366-373）把 `runs` 并入返回对象 + deps：
```ts
const rowContext = useMemo<RowContext>(() => {
  const focused = focusedIndex >= 0 && focusedIndex < rows.length ? rows[focusedIndex] : undefined
  const focusedId = focused ? focused.original.id : null
  const firstId = rows.length > 0 ? rows[0].original.id : null
  const tabStopId = focusedId ?? firstId
  return { at, flashId, focusedId, tabStopId, onSelect: selectRow, runs }
}, [at, flashId, focusedIndex, rows, selectRow, runs])
```

⑤ `TableRow`（:130-160）—— 默认淡背景（Task 3 补选择态优先级）。改签名接 `context.runs`，算背景：
```tsx
const TableRow: NonNullable<TableComponents<HistoryRowModel, RowContext>["TableRow"]> = ({ item, context, ...props }) => {
  const id = item.original.id
  const selected = id === context.at
  const flashing = id === context.flashId
  const focused = id === context.focusedId
  const isTabStop = id === context.tabStopId
  const info = context.runs.get(id)
  // 背景优先级(Task 2 只有:选中→类背景;默认淡 tint)。Task 3 插入选择态强 tint / dim。
  const bg = selected ? undefined : info?.faintTint
  return (
    <tr
      {...props}
      data-entry-id={id}
      data-focused={focused ? "true" : undefined}
      role="button"
      tabIndex={isTabStop ? 0 : -1}
      aria-current={selected ? "true" : undefined}
      style={bg ? { backgroundColor: bg } : undefined}
      onClick={() => context.onSelect(id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          e.stopPropagation()
          context.onSelect(id)
        }
      }}
      className={`${ROW_CLASS} ${selectionClass(selected)}${flashing ? " toc-flash" : ""}${focusClass(focused)}`}
    />
  )
}
```

⑥ `itemContent`（:507-516）—— 接第三参 `context`，对 session 列特判：
```tsx
itemContent={(_index, row, context) =>
  row.getVisibleCells().map((cell) => {
    if (cell.column.id === "session") {
      const info = context.runs.get(row.original.id)
      return (
        <td key={cell.id} className="relative w-[10px] p-0">
          {info && (
            <div
              className={`absolute inset-0 -bottom-px${info.isRunStart ? " session-cap-top" : ""}${info.isRunEnd ? " session-cap-bottom" : ""}`}
              style={{ backgroundColor: info.indent ? info.shade : info.color }}
            />
          )}
        </td>
      )
    }
    const indented = cell.column.id === "status" && context.runs.get(row.original.id)?.indent
    // status 缩进用 `pr-2 pl-3`(而非 `px-2`+`pl-3` 叠同属性,避免依赖 Tailwind 生成序);其余列 `px-2`。
    const padX = indented ? "pr-2 pl-3" : "px-2"
    return (
      <td
        key={cell.id}
        className={`${cell.column.columnDef.meta?.width ?? ""} overflow-hidden ${padX} py-1 align-middle`}
      >
        {flexRender(cell.column.columnDef.cell, cell.getContext())}
      </td>
    )
  })
}
```

> 注：Task 2 色块用 `<div>`（无点击）；Task 3 换成带 `onClick`+`stopPropagation` 的 `<button aria-label="toggle session highlight">`。测试 Step 1 已按 button 断言 → Task 2 此步先用 button 壳但不挂 onClick，保证测试可过（见下微调）。

为让 Task 2 的「色带按钮」测试通过，Step 3c ⑥ 的 session 色块直接用 `<button>` 占位（Task 3 再补 onClick）：
```tsx
<button type="button" aria-label="toggle session highlight" tabIndex={-1}
  className={`absolute inset-0 -bottom-px${info.isRunStart ? " session-cap-top" : ""}${info.isRunEnd ? " session-cap-bottom" : ""}`}
  style={{ backgroundColor: info.indent ? info.shade : info.color }} />
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ui-v4 && bunx vitest run tests/HistoryList.vitest.test.tsx -t "session 色带"`
Expected: PASS。再跑全量确保未回归：`bunx vitest run tests/HistoryList.vitest.test.tsx`

- [ ] **Step 5: typecheck + lint + bun 测试（含被动改的列序断言）**

Run: `cd ui-v4 && bunx tsc --noEmit && bunx eslint src/lib/request-columns.ts src/components/requests/HistoryList.tsx && bun test src/lib/request-columns.bun.test.ts`
Expected: 无错误、列序断言绿。

- [ ] **Step 6: 提交**

```bash
git add -- ui-v4/src/styles/theme.css ui-v4/src/lib/request-columns.ts ui-v4/src/lib/request-columns.bun.test.ts ui-v4/src/components/requests/HistoryList.tsx ui-v4/tests/HistoryList.vitest.test.tsx
git commit -m "feat(ui-v4): render session color-bar + default faint tint + subagent indent"
```

---

## Task 3: 多选对比交互 + 键盘 + 色板切换持久化

**Files:**
- Create: `ui-v4/src/components/requests/SessionPaletteSelect.tsx`
- Create: `ui-v4/tests/SessionPaletteSelect.vitest.test.tsx`
- Modify: `ui-v4/src/components/requests/HistoryList.tsx`（选择态 + 色板态+持久化 + 背景优先级 + `f`/Esc + 挂选择器 + 色带 onClick）
- Modify: `ui-v4/tests/HistoryList.vitest.test.tsx`（多选 / 键盘 / 切色板 / 正交）

**Interfaces:**
- Consumes: Task 1 `SESSION_PALETTES` / `DEFAULT_PALETTE_NAME` / `PALETTE_STORAGE_KEY` / `sessionTint`；Task 2 `runs` / `RunInfo`。
- Produces: `RowContext` 再加 `selectedSessions: Set<string>` / `onToggleSession: (sid: string | undefined) => void`。`SessionPaletteSelect` props `{ value: string; onChange: (name: string) => void }`。

- [ ] **Step 1: 写 SessionPaletteSelect 失败测试**

Create `ui-v4/tests/SessionPaletteSelect.vitest.test.tsx`（Radix Select 的 jsdom 测法对齐 `RequestsFilterBar.vitest.test.tsx`：`getByRole("combobox")` 开、`getByRole("option", { name })` 选；`setup.ts` 已 stub ResizeObserver/pointer/scrollIntoView）：

```tsx
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { SessionPaletteSelect } from "@/components/requests/SessionPaletteSelect"
import { SESSION_PALETTES } from "@/lib/session-color"

describe("SessionPaletteSelect", () => {
  it("显示当前色板、切换调 onChange(name)", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<SessionPaletteSelect value="terminal-neon" onChange={onChange} />)
    await user.click(screen.getByRole("combobox"))
    const second = SESSION_PALETTES[1] // oceanic-jewel
    await user.click(screen.getByRole("option", { name: second.label }))
    expect(onChange).toHaveBeenCalledWith(second.name)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ui-v4 && bunx vitest run tests/SessionPaletteSelect.vitest.test.tsx`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写 SessionPaletteSelect**

Create `ui-v4/src/components/requests/SessionPaletteSelect.tsx`（复用 FilterSelect 的 Radix 样式常量、但无 ALL 哨兵）：

```tsx
import { Select } from "radix-ui"

import { ITEM_CLASS, TRIGGER_CLASS } from "@/components/shared/FilterSelect"
import { SESSION_PALETTES } from "@/lib/session-color"

/** Session 色板选择器 —— Radix Select，选项 = SESSION_PALETTES（无 all 哨兵）。纯本地设置。 */
export function SessionPaletteSelect({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  return (
    <Select.Root
      value={value}
      onValueChange={onChange}
    >
      <Select.Trigger
        aria-label="session 色板"
        className={TRIGGER_CLASS}
      >
        <Select.Value />
        <Select.Icon>▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="mono z-50 border border-[var(--color-border)] bg-[var(--color-surface)]"
        >
          <Select.Viewport>
            {SESSION_PALETTES.map((p) => (
              <Select.Item
                key={p.name}
                value={p.name}
                className={ITEM_CLASS}
              >
                <Select.ItemText>{p.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ui-v4 && bunx vitest run tests/SessionPaletteSelect.vitest.test.tsx`
Expected: PASS。

- [ ] **Step 5: 写 HistoryList 交互失败测试**（追加到 `tests/HistoryList.vitest.test.tsx`）

用真实 harness：`renderList(["/requests"])` + 渲染前设 `mockHistory`；色带用 `entry(id)` spread override 加 sessionId；键盘用 `row.focus()` + `fireEvent.keyDown`（scroller div 不可聚焦，`userEvent.type` 打不到 onListKeyDown）；「点色带不导航」用内联 `<LocationProbe/>` 断言 location 未变。

```tsx
import { PALETTE_STORAGE_KEY } from "@/lib/session-color"

describe("HistoryList — 多选对比 + 键盘 + 色板（Task 3）", () => {
  const twoSessions = () => {
    mockHistory = {
      ...mockHistory,
      entries: [
        { ...entry("a"), sessionId: "S1" },
        { ...entry("b"), sessionId: "S2" },
      ],
      total: 2,
    }
  }
  const bar = (id: string) => document.querySelector(`[data-entry-id="${id}"] button[aria-label="toggle session highlight"]`) as HTMLElement

  it("点色带 → 该会话行强背景、非选中行变灰", async () => {
    const user = userEvent.setup()
    twoSessions()
    renderList(["/requests"])
    await user.click(bar("a"))
    const rowA = document.querySelector('[data-entry-id="a"]') as HTMLElement
    const rowB = document.querySelector('[data-entry-id="b"]') as HTMLElement
    expect(rowA.style.backgroundColor).toMatch(/^rgba\(/) // A 强背景
    expect(rowB.className).toContain("opacity-40") // B 变灰
  })

  it("点色带 stopPropagation：不导航到 /requests/:id", async () => {
    const user = userEvent.setup()
    twoSessions()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/requests"]}>
          <HistoryList filters={EMPTY_FILTERS} />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await user.click(bar("a"))
    expect(screen.getByTestId("loc").textContent).toBe("/requests") // 未变 /requests/a
  })

  it("多选：再点 B → A、B 各自强背景、无行变灰", async () => {
    const user = userEvent.setup()
    twoSessions()
    renderList(["/requests"])
    await user.click(bar("a"))
    await user.click(bar("b"))
    const rowA = document.querySelector('[data-entry-id="a"]') as HTMLElement
    const rowB = document.querySelector('[data-entry-id="b"]') as HTMLElement
    expect(rowA.className).not.toContain("opacity-40")
    expect(rowB.className).not.toContain("opacity-40")
    expect(rowA.style.backgroundColor).toMatch(/^rgba\(/)
    expect(rowB.style.backgroundColor).toMatch(/^rgba\(/)
  })

  it("再点已选 A → 移出；集空回默认（无变灰）", async () => {
    const user = userEvent.setup()
    twoSessions()
    renderList(["/requests"])
    await user.click(bar("a"))
    await user.click(bar("a"))
    const rowB = document.querySelector('[data-entry-id="b"]') as HTMLElement
    expect(rowB.className).not.toContain("opacity-40")
  })

  it("键盘 f 聚焦光标行会话；Esc 清空选择集", async () => {
    twoSessions()
    const { container } = renderList(["/requests"])
    const rowA = container.querySelector<HTMLElement>('[data-entry-id="a"]')
    rowA?.focus()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "f" }) // 光标在 index 0=a(S1)
    expect((container.querySelector('[data-entry-id="b"]') as HTMLElement).className).toContain("opacity-40")
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" })
    expect((container.querySelector('[data-entry-id="b"]') as HTMLElement).className).not.toContain("opacity-40")
  })

  it("切色板 → 行色带色变 + localStorage 持久化", async () => {
    const user = userEvent.setup()
    twoSessions()
    renderList(["/requests"])
    const before = bar("a").style.backgroundColor
    await user.click(screen.getByRole("combobox", { name: /色板/ }))
    await user.click(screen.getByRole("option", { name: SESSION_PALETTES[1].label }))
    expect(bar("a").style.backgroundColor).not.toBe(before)
    expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBe("oceanic-jewel")
  })
})
```

> `userEvent` / `fireEvent` / `QueryClientProvider` / `MemoryRouter` / `EMPTY_FILTERS` / `SESSION_PALETTES` 均已在文件顶部 import（`userEvent` 若无则加 `import userEvent from "@testing-library/user-event"`）。localStorage 在 jsdom 可用；用例间 `beforeEach` 若不清 localStorage，切色板用例放最后或加 `localStorage.clear()`。

- [ ] **Step 6: 跑测试确认失败**

Run: `cd ui-v4 && bunx vitest run tests/HistoryList.vitest.test.tsx -t "多选对比"`
Expected: FAIL。

- [ ] **Step 7: HistoryList 实现交互**

① import 补（`useCallback` 已在 :16 import，别重复加；`sessionTint` **不需要**——tint 已在 `RunInfo.faintTint/strongTint` 预算好，引它会触发 `noUnusedLocals` 红）：
```ts
import { PALETTE_STORAGE_KEY } from "@/lib/session-color"
import { SessionPaletteSelect } from "@/components/requests/SessionPaletteSelect"
```

② `RowContext` 再加两字段：
```ts
  selectedSessions: Set<string>
  onToggleSession: (sid: string | undefined) => void
```

③ 组件内加选择态 + 色板态（替换 Task 2 的写死 `DEFAULT_PALETTE_NAME`）：
```ts
const [selectedSessions, setSelectedSessions] = useState<Set<string>>(() => new Set())
const [paletteName, setPaletteName] = useState<string>(() => {
  try {
    return localStorage.getItem(PALETTE_STORAGE_KEY) ?? DEFAULT_PALETTE_NAME
  } catch {
    return DEFAULT_PALETTE_NAME
  }
})
const activePalette = SESSION_PALETTES.find((p) => p.name === paletteName) ?? SESSION_PALETTES[0]
const setPalette = useCallback((name: string) => {
  setPaletteName(name)
  try {
    localStorage.setItem(PALETTE_STORAGE_KEY, name)
  } catch {
    // localStorage 不可用(隐私模式/配额)时静默降级:仅本会话生效,不阻塞。
  }
}, [])
const onToggleSession = useCallback((sid: string | undefined) => {
  if (!sid) return // H1:无 sessionId 行 no-op
  setSelectedSessions((prev) => {
    const next = new Set(prev)
    if (next.has(sid)) next.delete(sid)
    else next.add(sid)
    return next
  })
}, [])
```
（`runs` 的 memo 已在 Task 2 用 `activePalette`；此处 `activePalette` 来源从写死改为色板态，memo deps 不变。）

④ `rowContext` useMemo 并入 `selectedSessions` / `onToggleSession` + deps：
```ts
return { at, flashId, focusedId, tabStopId, onSelect: selectRow, runs, selectedSessions, onToggleSession }
}, [at, flashId, focusedIndex, rows, selectRow, runs, selectedSessions, onToggleSession])
```

⑤ `TableRow` 背景优先级替换 Task 2 的 `bg`（§3 单值优先级）：
```tsx
const info = context.runs.get(id)
const sid = item.original.sessionId
const selecting = context.selectedSessions.size > 0
const selectedThisSession = sid !== undefined && context.selectedSessions.has(sid)
const dim = selecting && !selectedThisSession && !selected
// 优先级:选中(at)→类背景(不设 inline);对比态选中会话→强;对比态非选中→无;默认→淡
let bg: string | undefined
if (!selected) {
  if (selecting) bg = selectedThisSession ? info?.strongTint : undefined
  else bg = info?.faintTint
}
```
`<tr>` 的 `style` 用 `bg`，`className` 末尾加 dim：
```tsx
className={`${ROW_CLASS} ${selectionClass(selected)}${flashing ? " toc-flash" : ""}${focusClass(focused)}${dim ? " opacity-40" : ""}`}
```

⑥ itemContent 的 session 色块 `<button>` 挂 onClick（Task 2 的占位补上交互）：
```tsx
<button type="button" aria-label="toggle session highlight" tabIndex={-1}
  onClick={(e) => { e.stopPropagation(); context.onToggleSession(row.original.sessionId) }}
  className={`absolute inset-0 -bottom-px${info.isRunStart ? " session-cap-top" : ""}${info.isRunEnd ? " session-cap-bottom" : ""}`}
  style={{ backgroundColor: info.indent ? info.shade : info.color }} />
```

⑦ 键盘 `onListKeyDown`（:379-417）加 `case "f"`、`Escape` 追加清选择：
```ts
case "f": {
  e.preventDefault()
  const row = rows[focusedIndex]
  if (row) onToggleSession(row.original.sessionId)
  break
}
```
`Escape` 分支末尾加一行：
```ts
setSelectedSessions(new Set())
```
（`onListKeyDown` 的 useCallback deps 补 `onToggleSession`。）

⑧ History header（:422-434 那块 `History · {total} total` 行）挂色板选择器：
```tsx
<span>History · {total} total</span>
<SessionPaletteSelect value={paletteName} onChange={setPalette} />
{/* clear 按钮保持 ml-auto 靠右 */}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `cd ui-v4 && bunx vitest run tests/HistoryList.vitest.test.tsx tests/SessionPaletteSelect.vitest.test.tsx`
Expected: PASS。再跑 `bunx vitest run`（ui-v4 全量）确认无回归。

- [ ] **Step 9: typecheck + lint**

Run: `cd ui-v4 && bunx tsc --noEmit && bunx eslint src/components/requests/HistoryList.tsx src/components/requests/SessionPaletteSelect.tsx tests/HistoryList.vitest.test.tsx tests/SessionPaletteSelect.vitest.test.tsx`
Expected: 无错误。

- [ ] **Step 10: 提交**

```bash
git add -- ui-v4/src/components/requests/HistoryList.tsx ui-v4/src/components/requests/SessionPaletteSelect.tsx ui-v4/tests/HistoryList.vitest.test.tsx ui-v4/tests/SessionPaletteSelect.vitest.test.tsx
git commit -m "feat(ui-v4): multi-select session contrast highlight + keyboard f/Esc + switchable palette"
```

---

## Task 4: 收尾（人工视觉核验 + doc-sync）

**Files:**
- Modify: `ui-v4/docs/spec/2026-07-10-ui-v4-session-color-bar.md`（状态 → 已实施）
- Modify: `docs/DESIGN.md`（「活的架构现状」加/更新 Requests 行）与/或 `ui-v4/docs/DESIGN.md`

- [ ] **Step 1: 全量门禁**

Run: `cd ui-v4 && bunx tsc --noEmit && bunx vitest run && bun test src/lib/session-color.bun.test.ts` 且根 `bun run typecheck:ui-v4`（若存在）。
Expected: 全绿。

- [ ] **Step 2: build:ui-v4（esbuild bundle 通过）**

Run: 项目根 `bun run build:ui-v4`（或 package.json 对应脚本）。
Expected: bundle 成功、无类型/rollup 报错。

- [ ] **Step 3: 人工视觉核验（no-auto-server：由用户起服）**

请用户起前端 dev/预览，逐项核对（jsdom 测不到的布局正确性，spec §7）：
- 色带每段**竖直无缝贯通**（非每行断裂虚线）、段首圆顶段尾圆底、~10px 可见宽。
- subagent 行内容**明显缩进**、色带更深一档。
- 默认态不同会话**淡底纹可辨**、不刺眼、不撞 `row-anomaly` warn 底。
- 点色带 → 强背景高亮、其余变灰；多选两会话各自强背景对比；`f` 键在光标行同效；Esc 清空。
- 切 4 套色板即时换色、刷新保留；`?at=` 选中行叠加时琥珀背景优先、border-l 仍在。
- 强 tint 下 status `●` 信号色仍清晰（H3）。

如发现色/alpha 需微调，改 `session-color.ts` 常量（对应 spec §4）后回归 Task 1 测试。

- [ ] **Step 4: subagent 合并态审查**

派 subagent（显式裁判轴：长远正确 + 完整 + 与 spec 一致）审 Task 1–3 合并态：itemContent 特判是否漏列、背景优先级 5 档是否自洽、Esc/f 与既有 roving 光标无冲突、色板持久化未知名回退。吸收客观事实、亲验其绝对断言。

- [ ] **Step 5: doc-sync + spec 状态**

- spec 头部状态改「已实施（2026-07-…）」。
- `docs/DESIGN.md`「活的架构现状」Requests/History 相关行补一句「session 色带 + 多选对比 + 可切换色板」并指向本 spec/plan。
- 跨文档 grep 验证无悬挂引用。

- [ ] **Step 6: 提交**

```bash
git add -- ui-v4/docs/spec/2026-07-10-ui-v4-session-color-bar.md docs/DESIGN.md
git commit -m "docs(ui-v4): mark session color-bar implemented + sync DESIGN"
```

---

## Self-Review + 计划审查纪要（subagent 对抗审查已纳入）

一轮 subagent 对抗审查（亲读 react-virtuoso 类型、fake mock、真实 harness、列序断言、EntrySummary 必填）挖出 3 CRITICAL + 3 HIGH，**全部已修入本计划**：

| 审查发现 | 级别 | 处置 |
|---|---|---|
| fake Virtuoso mock 只传 2 参、`context` 恒 undefined → session 特判崩、连累全部现有用例 | CRITICAL | **纳入** Task 2 Step 3-pre-a：改 mock :58/:72 传第三参 context |
| `request-columns.bun.test.ts:43` 精确列序断言首项 status，加 session 头列即炸 | CRITICAL | **纳入** Task 2 Step 3-pre-b：断言首项加 `session` + 纳入门禁 |
| 测试 helper 真名 `renderList(URL[])` 非 `renderHistoryList`、entries 走 `mockHistory`、navigate 不可注入 | CRITICAL | **纳入**：Task 2/3 测试全改真实 harness（`renderList` + `mockHistory` + `entry()` spread + `<LocationProbe/>`） |
| `userEvent.type(scroller, "{Escape}")` 打不到 onListKeyDown（div 不可聚焦） | HIGH | **纳入**：Esc/`f` 改 `row.focus()` + `fireEvent.keyDown` |
| `sessionTint` import 未用 → `noUnusedLocals` 红 | HIGH | **纳入**：Task 3 ① 删该 import（tint 已在 RunInfo 预算） |
| 测试字面 entry 缺必填 `responsePreviewText` → tsc 红 | HIGH | **纳入**：改用 `entry()` helper（`as unknown as` cast）spread override |
| Radix Select 用 `getByText` 不如 `getByRole("option")`；label SSOT 漂移 | MED | **纳入**：改 `getByRole("option", { name })`；plan/spec oceanic label 已对齐 |
| status td `px-2`+`pl-3` 同设 padding-left 靠生成序 | MED | **纳入**：改 `pr-2 pl-3`（不叠同属性） |
| itemContent 第三参、display 列 cell:()=>null、selected 类背景 vs inline tint、Radix jsdom 可行 | — 成立 | 生产代码接线确认健全 |

**Spec 覆盖**：§1 全目标 → Task 2/3；§3 单值背景优先级 → Task 3 ⑤；§4 API + 4 套色板 + itemContent 特判 + 破例外壳/圆角/缩进 + 选择器持久化 → Task 1/2/3；§7 测试 → 各 Task；§10 H1 → Task3；H2/H3 视觉 → Task 4 人工核验。**无未覆盖项。**

**类型一致性**：`RunInfo` 字段（color/shade/indent/isRunStart/isRunEnd/faintTint/strongTint）贯穿 Task 1→2→3；`onToggleSession(sid: string | undefined)` 定义与调用一致（H1 内部守卫）；`SessionPaletteSelect` props `{value,onChange}` 一致。
