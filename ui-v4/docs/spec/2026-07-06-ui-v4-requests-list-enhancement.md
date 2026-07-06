# ui-v4 请求列表页全面增强 — 设计规格

> 日期：2026-07-06
> 范围：`ui-v4/src/components/requests/*` 及其数据 hook / store / 纯逻辑模块子树
> 类型：前端特性 + **后端一处小改**（scoped delete —— 见 §9；筛选感知删除所需，现后端仅支持 clear-all + delete-by-session）。其余筛选维度与游标分页后端现成。
> 状态：设计已定稿，待拆实施计划
> 库选型 ADR：[2026-07-06-requests-list-libraries.md](../decisions/2026-07-06-requests-list-libraries.md)（react-virtuoso + react-day-picker + TanStack Table）
> 缺口来源：[TODO.md「Activity」节](../TODO.md)（3 subagent 逐功能对账 `ui/`↔`ui-v4`）

本规格把 Requests 列表页从「Live 泳道 + tail/缓冲 + 富行 + `?at=` 定位」升级到**功能对等且超越**老 `ui/` Activity：补齐**七维筛选 + URL 深链 + 错误/空态 + paused 行内更新 + 键盘导航 + 清空历史**，同时**保留** v4 已有的真增强（Live 泳道 WS、tail/缓冲、`?at=` 定位、富行）。

设计经用户四轮定夺：范围=闭合全部 Activity 缺口；tail 为主、筛选叠加；列表引擎=react-virtuoso + TanStack Table；时间筛选=react-day-picker。

---

## 1. 目标与非目标

### 目标

- **七维 server-side 筛选**：search（preview 快筛）/ model / endpoint / state / pid / sessionId / 时间范围（from-to），全部经查询参数打到 `/history/api/entries`（后端已支持，见 §2）。
- **URL-as-SSOT 深链**：筛选状态活在 URL query，刷新/分享/回退天然保留；与既有 `?at=` 定位参数正交共存。
- **活动筛选 chips + 单个清除 + Clear all**。
- **列表引擎升级**：TanStack Table 列模型 + 列可见性开关；react-virtuoso 虚拟渲染长 History 列表（`endReached` 加载旧页、`scrollToIndex` 定位）。
- **错误 / 空 / 加载三态**（现仅 loading）。
- **paused 行内 WS 更新**：暂停浏览时，已在列表内的条目其 `entry_updated` 无条件原地更新（修 TODO.md🟡）。
- **列表键盘导航**：↑/↓ 移动选中、Enter 进详情、Esc 清焦点。
- **清空历史**：筛选感知删除 + 二次确认（复用 `shared/Modal`）。
- 视觉对齐既有 Terminal Amber（amber / rounded:0 / mono / 高密度）。

### 非目标（record-not-adopted，均记原因）

- **不加双向 Newer/Older 双游标翻页**。按用户定夺「tail 为主」，「回最新」由 tail + 缓冲横幅提供；单向 `direction=older` 无限滚动 + tail 覆盖两个方向。老 `ui/` 的 prev+next 双游标不移植（有意取舍）。
- **列表 search 是轻量 preview 快筛**（后端 `preview_text LIKE`，见 §2），**不是**内容寻址全文搜索。全文 Search 是**独立的 out-of-scope 页**（老 `ui/` VSearchPage / 后端 `/history/api/search` + `search_index`；ui-v4 未建，属 TODO.md 另一缺口 Plan 07）。二者刻意分离。
- **model 筛选不做 cmdk combobox 自动补全**：先用普通防抖 input（镜像老 `ui/` Activity）；combobox 留给全局 Search 的 cmdk 落地阶段（ADR 决策四）。
- **不改后端筛选/分页**：全部筛选维度、游标分页、`terminalOnly` 后端现成（§2 已核验）。**唯一后端改动**是 scoped delete（§9，筛选感知删除所需）。
- **agentId / mainAgentOnly 维度本次不做 UI**：后端支持，但属 Sessions 钻取语境，非 Activity 六维核心；留待需要时补（不阻塞）。

---

## 2. 现状基线（改动锚点 + 后端能力核验）

### 前端现状

| 文件 | 现状 |
|---|---|
| [RequestsListPage.tsx](../../src/components/requests/RequestsListPage.tsx) | 编排：`<LiveLane/>` + `<HistoryList/>`，挂 `useLiveRequests()`。**无 filter bar / chips** |
| [HistoryList.tsx](../../src/components/requests/HistoryList.tsx) | 游标分页 + 缓冲横幅 + tail 暂停 + `?at=` 定位（`findRow` DOM query + `scrollIntoView` + load-until-found，cap 20 页）。**无 error/empty 态、无键盘、无列可见性** |
| [LiveLane.tsx](../../src/components/requests/LiveLane.tsx) | 常驻固定高（max-h 150）、内部滚动、空态、永不分页 |
| [RequestRow.tsx](../../src/components/requests/RequestRow.tsx) | History 富行（手搓固定像素宽 `<span>`）+ Live 紧凑行。信号色 / tokens / bytes / ×N / 预览 / 失败摘要 |
| [useHistoryInfinite.ts](../../src/hooks/useHistoryInfinite.ts) | `useInfiniteQuery`，**写死 `limit=50&terminalOnly=true`，无任何筛选参数**；WS `entry_added/updated` 仅终态合入、仅 `tailOn` 时 invalidate。**不暴露 isError** |
| [list-store.ts](../../src/stores/list-store.ts) | zustand reducer：`tailOn` + `bufferedIds`（incoming/flush/resume/locate/scroll-up/reset）。**无 filter 字段** |
| [activity-row.ts](../../src/lib/activity-row.ts) | 富行纯域逻辑（requestState/modelName/endpointLabel/tokenIn/Out/failureSummary/rowAnomaly 等，从老 UI 逐字移植） |

### 后端能力（已核验，无需改）

`handleGetEntries`（[src/routes/history/handler.ts](../../../src/routes/history/handler.ts):22-)已解析全部查询参数：
`cursor / limit / direction(older|newer) / model / endpoint / success / state / terminalOnly / from / to / search / sessionId / agentId / mainAgentOnly / pid`。

关键语义（[src/lib/history/queries.ts](../../../src/lib/history/queries.ts)）：`search` 走 **`preview_text LIKE`**（持久列表路径的 SQL 过滤；in-flight 侧对 preview 单独匹配）——即列表 search 是**轻量 preview 快筛**，区别于内容寻址全文 `/history/api/search`。返回 `{ entries, total, nextCursor }`。

### 既有可复用范式

- Radix `Select` 下拉：[ModelsFilterBar.tsx](../../src/components/models/ModelsFilterBar.tsx) 的 `FilterSelect`（sentinel `__all__` 映射 null）——抽到 shared 复用。
- 列可见性菜单：[ModelsColumnMenu.tsx](../../src/components/models/ModelsColumnMenu.tsx) 范式。
- 确认 Modal：[shared/Modal.tsx](../../src/components/shared/Modal.tsx)（Radix Dialog，含 focus-trap/scroll-lock/Esc/portal）。
- 终态门控：`isTerminalSummary`（[activity-row.ts](../../src/lib/activity-row.ts)），镜像后端 `isInFlightSummary`。

---

## 3. 数据流架构（URL-as-SSOT）

```
URL query (?search & model & endpoint & state & pid & sessionId & from & to  |  正交: ?at=)
   │  useRequestFilters() : parseFilters(searchParams) → RequestFilters (typed)
   ▼
useHistoryInfinite(filters)          filters 并入 queryKey → 变则 react-query 自动 refetch
   │  queryFn: `/history/api/entries?limit=50&terminalOnly=true&` + toQueryString(filters) + 游标
   ▼
TanStack Table  (getCoreRowModel + VisibilityState;filter/sort 引擎不用——server-side)
   │  columns = request-columns.ts;rows = table.getRowModel().rows
   ▼
<TableVirtuoso>  data=rows  itemContent=渲染单元格
   │  endReached → fetchNextPage(older)     scrollToIndex → ?at= 定位     tail → invalidate 整页(§10.2)
   ▼
WS entry_added/updated  →  门控:先「id 已在列表内→原地更新」,再「isTerminalSummary(s) && matchesGating(s,filters)」(不含 search)
                            命中: tailOn?invalidate : buffer   |   已在列表内的 updated: 无条件原地更新
```

**为何 URL-as-SSOT**（对比状态放 store）：v4 已把 `?at=`（列表定位）和 `/requests/:id`（详情选中）作为 URL 真值（list-store 注释明说「选中/定位真值由 URL 承载」）。筛选顺理成章同源 → 深链/刷新/分享**零额外代码**白拿。老 `ui/` 因真值源是 Pinia，才需 onMounted hydrate + watch→replace + onActivated resync 一整套同步 dance；URL-as-SSOT **消灭**这套逻辑。

**正交性**：`setFilter` 改筛选参数时**保留** `?at=`，反之定位/`goLive` 改 `?at=` 时**保留**筛选参数（二者是 URL 上互不干扰的 query 键）。

---

## 4. 新增 / 修改文件

### 新增纯逻辑模块（bun test）

**[lib/request-filters.ts](../../src/lib/request-filters.ts)**
```ts
export interface RequestFilters {
  search: string          // "" = 无
  model: string           // "" = 无
  endpoint: string | null // EndpointType | null
  state: string | null    // lifecycle state | null
  pid: number | null
  sessionId: string | null
  from: number | null     // epoch ms
  to: number | null       // epoch ms
}
export const EMPTY_FILTERS: RequestFilters
export function parseFilters(sp: URLSearchParams): RequestFilters
export function serializeFilters(f: RequestFilters): URLSearchParams  // 空值省略键
export function toQueryString(f: RequestFilters): string              // 供 queryFn 拼接
export function activeChips(f: RequestFilters): Array<{ key: keyof RequestFilters; label: string }>
export function hasAnyFilter(f: RequestFilters): boolean
export function matchesGating(e: EntrySummary, f: RequestFilters): boolean  // WS 门控 + at 归属判定
```
- **`matchesGating` 前端同构后端 [`summaryMatchesFilters`](../../../src/lib/history/queries.ts)（非 `matchesFilters`——那是 full-entry 路径，缺 pid/state）**：逐维判 sessionId/endpoint/from/to/model/state/pid。
- **search 维刻意不参与门控**（镜像后端 `summaryMatchesFilters` 的 `// search NOT matched here` 设计）：后端 search 对**持久条目**是 `preview_text LIKE`、对 **in-flight** 是**规范化全文**（`inFlightMatchesSearch`，与索引同投影）——preview 只是全文截断前缀，二者语义不同。若前端拿 preview 子串当 search 门控，会与后端 in-flight 全文命中**分歧**（正文含 needle 但 preview 不含 → 前端误判丢弃，refetch 却出现 → 不自洽）。**故 search 过滤只发生在 refetch 的 SQL/全文层**，WS 门控与 `?at=` 归属判定都**不含 search 维**。此为已定语义（C1）。
- parse/serialize **round-trip 幂等**（bun test 断言）。

**[lib/request-columns.ts](../../src/lib/request-columns.ts)**
- TanStack `ColumnDef<EntrySummary>[]`：status / time / dur / model / (multiplier) / endpoint / bytes / tokens / attempts / preview。`accessorFn` 复用 activity-row.ts 域逻辑（modelName/endpointLabel/tokenIn…）。
- `DEFAULT_COLUMN_VISIBILITY: VisibilityState`（默认全显；用户可切）。
- 渲染层（单元格 JSX + 信号色 + tooltip）从现 RequestRow 平移。

### 新增 hook / 组件

- **[hooks/useRequestFilters.ts](../../src/hooks/useRequestFilters.ts)**：`{ filters, setFilter, clearFilter, clearAll }`。内部 `useSearchParams` + `navigate({ search }, { replace: true })`，**保留正交的 `?at=`**（合并现有 searchParams，只改筛选键）。
- **[hooks/useDebouncedCallback.ts](../../src/hooks/useDebouncedCallback.ts)**：~10 行（`useRef<timer>` + `useEffect` 清理）。文本维（search/model/pid）输入 300ms 防抖后推 URL；无库覆盖此原语，不值引库（ADR 决策四同判断）。
- **[components/requests/RequestsFilterBar.tsx](../../src/components/requests/RequestsFilterBar.tsx)**：
  - search / model 防抖 input；pid 防抖 number input。
  - endpoint / state：shared `FilterSelect`（Radix Select）。endpoint = 4 端点枚举。**state 只列终态枚举**（`completed`/`failed`/`aborted`/`interrupted` —— 以 `RequestLifecycleState` 定义为准）：列表写死 `terminalOnly=true`，选非终态 state（pending/executing/streaming）会被 `terminalOnly` 全滤成空（那些属 Live 泳道职责），故 UI 不暴露非终态 state（H5）。`success` 维不单列（后端被 `state` 吸收、有 state-wins 规则），记为有意取舍。
  - 时间范围：Radix `Popover` 触发 react-day-picker range mode → 写 from/to（epoch ms）。**日界语义**：`from` = 选中首日 `00:00:00.000`、`to` = 选中末日 `23:59:59.999`（后端 `started_at >= from && <= to`，不含日界会漏掉末日当天请求，M1）。
  - 列可见性：ModelsColumnMenu 范式，驱动 TanStack `VisibilityState`（列显隐持久化到 localStorage，key `ui-v4:requests:columns`，与 Models 列显隐持久化同机制）。**读回时与 `DEFAULT_COLUMN_VISIBILITY` 对账**（未知列忽略、新增列取默认可见）——避免加列后老 localStorage 值吞掉新列（M1）。
  - 本地态镜像 URL（防抖 input 需本地即时反馈），URL 清空时同步回填（`useEffect` watch filters）。
- **[components/requests/RequestFilterChips.tsx](../../src/components/requests/RequestFilterChips.tsx)**：`activeChips(filters)` → 可关闭 chip（× 调 `clearFilter(key)`）+ 「Clear all」（`clearAll()`）。放 filter bar 与 History header 间；无激活维度时不渲染。
- **抽取 [components/shared/FilterSelect.tsx](../../src/components/shared/FilterSelect.tsx)**：从 ModelsFilterBar 内联的 `FilterSelect` 提为 shared，Models 与 Requests 共用（消重复）。

### 修改

- **[hooks/useHistoryInfinite.ts](../../src/hooks/useHistoryInfinite.ts)**：
  - 入参 `filters: RequestFilters`；`queryKey = ["history-infinite", toQueryString(filters)]`；`queryFn` 拼接筛选参数。
  - WS 门控加 `matchesGating(s, filters)`（**不含 search 维**，见 §4 C1）：仅终态**且** gating 命中才 `incoming`/invalidate。
  - **门控判定顺序（互斥，H4）**：先判「目标 id 已在当前 `entries` 内」→ 无条件 `setQueryData` 原地替换该行、**`return`**；**再**判「新终态 && matchesGating」→ `incoming`。杜绝一条已完成条目的 late update（如 usage 回填）既原地更新又误进 buffer（横幅计数虚高）。原地更新不受 tailOn 门控——修🟡 paused 浏览时进行中→完成的状态变化也反映。
  - 暴露 `isError` / `error` / `refetch`；`total`（后端**筛选后**计数，`getHistorySummaries` 的 `visible.length`）继续取 `pages[0].total`，供清空确认的 N（§9）。
- **[components/requests/HistoryList.tsx](../../src/components/requests/HistoryList.tsx)**：
  - `<TableVirtuoso>` 重写渲染；`components={{ Table, TableHead, TableRow… }}` 套 Terminal Amber。
  - **定位**：`?at=` → 计算 index，`virtuosoRef.current.scrollToIndex({ index, align: 'center' })` + 瞬态 flash（传 `flashId` 给 itemContent，命中行加 `toc-flash` 类 FLASH_MS）。**替** `findRow` DOM query（虚拟化后离屏行不在 DOM）。**at × 筛选（H3，见 §10）**：定位前先判目标是否属当前筛选集，不属则提示而非盲翻页；属而未在已加载集才 load-until-found（cap 保留）。
  - **三态**：loading（现有）/ **error**（图标 + message + retry 按钮，调 `refetch`）/ **empty**（「无匹配请求」+ 有筛选时给「清除筛选」按钮 → `clearAll`）。
  - **键盘**：容器 `onKeyDown`，↑/↓ 移选中高亮（维护 `focusedIndex` + `scrollToIndex` 跟随）、Enter → `selectRow`、Esc 清焦点。`isTyping` 守卫（复用 detail 页思路）避免输入框内触发。
  - **清空历史**：header 加「清空」入口 → `shared/Modal` 确认（文案「删除当前筛选命中的 N 条？」/ 无筛选时「清空全部 N 条？」）→ `api.delete('/history/api/entries?' + toQueryString(filters))` → invalidate。**依赖 §9 后端 scoped delete**（现 `handleDeleteEntries` 忽略参数、恒 clear-all）。
  - tail/缓冲/resume/flush 语义**不动**（list-store 保留）。
- **[components/requests/RequestsListPage.tsx](../../src/components/requests/RequestsListPage.tsx)**：挂 `useRequestFilters()`，渲染 `<RequestsFilterBar/>` + `<RequestFilterChips/>` + `<LiveLane/>` + `<HistoryList filters=…/>`。
- **[components/requests/RequestRow.tsx](../../src/components/requests/RequestRow.tsx)**：History 富行渲染逻辑迁入 request-columns.ts 的 itemContent；Live 紧凑行保留（Live 泳道非虚拟、非 TanStack Table，短列表直接 map）。**列宽单一真值源（M4）**：`request-columns.ts` export 列宽常量，Live map **import 同常量**对齐——不再各自硬编码 `<span>` 宽（否则改 ColumnDef 宽 Live 泳道不跟随、视觉错位，正是 ADR 要消除的双真值源）。
- **依赖**：`ui-v4/package.json` 加 `react-virtuoso`、`react-day-picker`；`@tanstack/react-table` 已装。

---

## 5. tail × 筛选 × WS 交互（核心正确性）

| 场景 | 行为 |
|---|---|
| 改任一筛选维 | URL 变 → queryKey 变 → react-query refetch 首页（筛选后结果集）。tail 状态不变 |
| **任意态** + WS `entry_updated` 且 id **已在列表内** | **优先规则**：无条件原地更新该行、`return`（修🟡；不受 tailOn 门控）——**先于**下面的终态门控判定（H4 互斥顺序） |
| tail-on + WS 新终态条目 **gating 命中**（`matchesGating`，不含 search） | `incoming`（tail-on 靠 invalidate 揭示） |
| tail-on + WS 新终态条目 **gating 不命中** | 忽略（不污染筛选视图） |
| paused + WS 新终态条目 gating 命中 | 进 `bufferedIds` → 缓冲横幅 |
| paused + WS 新终态条目 gating 不命中 | 忽略 |
| `?at=` 定位命中 | 暂停 tail（现有语义）；筛选参数保留 |
| `?at=` 目标**不在当前筛选集**（H3） | 见 §10：定位前判归属，不匹配则提示「该条目不在当前筛选内 · [清除筛选定位]」，**不**盲目 load-until-found（避免千条无谓拉取） |
| 缓冲横幅 flush / resume | 恢复 tail + 清 buffer；清 `?at=`（现有 `goLive`）；**筛选参数保留** |

> **search 维为何不进门控**：见 §4 C1——search 对 in-flight 是全文、对持久是 preview_text LIKE，preview 子串门控会与后端分歧。search 过滤只在 refetch 的 SQL/全文层发生。

**双向翻页缺口**按「tail 为主」定夺**有意不补**：tail + 缓冲提供「回最新」，`endReached` 单向加载旧页。记为取舍（§1 非目标）。

---

## 6. 组件边界与隔离

每个新单元单一职责、可独立测试：

- `request-filters.ts` —— 纯函数（parse/serialize/chips/matches），无 React 依赖。**独立可测**（bun）。
- `request-columns.ts` —— 列定义 + 可见性默认，纯数据 + 渲染函数。
- `useRequestFilters` —— URL ⇄ RequestFilters 唯一桥，其余组件只消费 `{ filters, setFilter… }`，不各自碰 searchParams。
- `RequestsFilterBar` / `RequestFilterChips` —— 纯受控（props in、回调 out），无数据获取。
- `useHistoryInfinite` —— 唯一数据获取 + WS 门控点。
- `HistoryList` —— 渲染 + 滚动/定位/键盘编排，数据全来自 hook。

---

## 7. 测试计划

### bun test（纯逻辑）
- `request-filters`：parseFilters/serializeFilters **round-trip 幂等**；空值省略键；`activeChips` 各维标签；`hasAnyFilter`；`matchesGating` 逐维（model / endpoint / state / pid / sessionId / from-to 边界，**不含 search 维**——search 只在 SQL/全文层，见 C1）+ 与后端 `summaryMatchesFilters` 对齐的正样本证。
- `request-columns`：accessorFn 取值正确、DEFAULT_COLUMN_VISIBILITY 全显。

### vitest（jsdom + @testing-library/react）
- `RequestsFilterBar`：改一维 → `setFilter` 被调 / URL 变；防抖（fake timers）；day-picker 选范围 → from/to；列可见性切换 → VisibilityState。
- `RequestFilterChips`：chip × → `clearFilter(key)`；Clear all → `clearAll`；无维度不渲染。
- `HistoryList`：error 态（refetch 按钮）；empty 态（有筛选给 Clear）；TableVirtuoso 行渲染 + 列可见性隐藏列不出现；`?at=` → `scrollToIndex` 调用（mock virtuosoRef）；键盘 ↑/↓/Enter/Esc；清空确认 Modal 流程。
- `useHistoryInfinite`：filters 进 queryKey；WS 不匹配条目**不**入列表（门控）；paused `entry_updated` 已在列表内 → 原地更新。

> 注意 jsdom 坑（见 skill `debugging-frontend-tests`）：react-virtuoso 依赖 `ResizeObserver` / `scrollTo` / 元素尺寸——jsdom 需 stub（Virtuoso 在 jsdom 下渲染需喂 mock 尺寸或用其测试模式）；createPortal（Radix Popover/Dialog/Select）内容落 `document.body`；否定断言须配正样本证正向能力。

### 门禁
- `typecheck` + `eslint`（无缓存核验）+ bun/vitest 全绿。
- `build:ui-v4` 验 bundle 前后对照 → **入提交信息**（ADR 门禁纪律）；`~backend` 纯（type-only import）。

---

## 8. 落地阶段（供 writing-plans 细化）

1. **基座**：装依赖 + `request-filters.ts`（+ bun test）+ `useRequestFilters` + `FilterSelect` 抽取。URL ⇄ filters 跑通，`useHistoryInfinite` 接 filters 进 queryKey（先不动渲染）。
2. **筛选 UI**：`RequestsFilterBar`（含 day-picker + 列菜单）+ `RequestFilterChips` + 挂进 Page。七维筛选可用。
3. **列表引擎**（**前置 PoC gate，§10.3**）：`request-columns.ts` + TanStack Table + `TableVirtuoso` 重写 HistoryList 渲染；`?at=` 定位改 `scrollToIndex`（+ §10.1 归属判定）；列可见性接通。
4. **态与交互**：error/empty 三态 + paused 行内更新（§4 H4 顺序）+ 键盘导航 + 清空历史确认（依赖阶段 0 或并行的后端 §9 scoped delete）。
5. **收尾**：subagent audit（显式裁判轴：长远正确 + 完整 + 与 ADR/spec 一致）+ doc-sync（DESIGN「活的架构现状」+ TODO.md「Activity」标对等达成）+ 细粒度提交。

后端 §9 scoped delete 可作阶段 0（独立小改，前端阶段 4 消费）或与阶段 4 并行。每阶段 typecheck 绿 + 对应测试，subagent review 后提交。

---

## 9. 后端 scoped delete（唯一后端改动）

**现状**（已核验）：[handleDeleteEntries](../../../src/routes/history/handler.ts):156 **忽略全部查询参数**，恒调 `clearHistory()` → `clearAllEntries()`（[sqlite/write.ts](../../../src/lib/history/sqlite/write.ts):222 清全表）。store 另有 `deleteSession(id)`（按 session 范围删），但**无按任意筛选删**的原语。

**筛选感知删除**（用户定夺项）因此需一处后端补齐：

- **[sqlite/write.ts](../../../src/lib/history/sqlite/write.ts)** 新增 `deleteEntries(filters: QueryOptions): number`，**严格照 `deleteSession`（write.ts:205）模式，绝不照 `clearAllEntries` 模式**：
  - `clearAllEntries` 做的是**无 WHERE** 的 `DELETE FROM req_aux` / `DELETE FROM msg_blob` 全表清——套到 scoped delete 会**误删未被筛选命中的其他请求的 index 行（灾难性数据丢失）**。已核验（write.ts:222）。
  - 正确写法：`SELECT COUNT(*)` head 行数 before（`entry_stages`/`req_msg`/`req_aux` 皆 `ON DELETE CASCADE`，`.changes` 含级联行不可作 entry 计数——schema.ts:77/103/116 已核验）→ `DELETE FROM entries_v2 WHERE <filter clause>`（复用 [read.ts](../../../src/lib/history/sqlite/read.ts) 的 `applyWhere` SQL 构造，与列表查询**同源**避免「删的集」≠「看到的集」）→ CASCADE 自动清 stage/req_msg/req_aux → `if (deleted>0) GC_ORPHAN_MSG_BLOB_SQL`（仅 `msg_blob` 无 FK、需 orphan 回收）→ 处理 `response_sessions` 孤儿映射。返回删除行数。
  - **删除范围语义**（H2）：带 `terminalOnly` 等价条件（`status NOT IN ('pending','executing','streaming')`），**不删** in-flight persisted head（否则删正在 finalize 的行 → `insertCompletedEntry` 的 `ON CONFLICT DO UPDATE` 会「删了又回来」+ finalize 竞态）。**不豁免 pinned**（沿用 clear-all「deliberate delete 不挡 pin」语义，pin 只挡 reaper）。
- **[handler.ts](../../../src/routes/history/handler.ts) `handleDeleteEntries`**：解析与 `handleGetEntries` **同款**查询参数 → 有任一筛选则 `deleteEntries(filters)`、无筛选则维持 `clearHistory()`。返回 `{ success, deleted: N }`。
- **前端**：确认文案的 **N = `useHistoryInfinite().total`**（后端筛选后计数，即 `getHistorySummaries` 的 `visible.length`，已核验语义）。因 N 是 `terminalOnly` 计数、而 `deleteEntries` 也带 terminalOnly 语义，二者应一致；删除后以后端返回的 `deleted` 回填 UI 消解任何残差。**落地前 grep 全 `ui-v4/src` 确认无其他 `DELETE /history/api/entries` 调用点**（TODO.md🟢「需确认是否迁往他处」的闭环，M5）。
- **测试**（bun，后端）：`deleteEntries` 按各维删对应子集、无筛选全清、返回计数、**search_index 无孤儿 + 其他请求 index 行不被误删**（H1 回归）、不删 in-flight head、与 `querySummaries` 同 filters 的「删后列表为空」自洽。

**为何加而非退回 clear-all**：用户明确选「筛选感知删除」；且 richest-data-flow / against-yagni —— 后端本就该支持 scoped delete（「无原语常是没接线该建非删」），clear-all-only 是能力缺失。若用户改选零后端改动，退回「clear-all + 确认」即可（去掉本节 + §1 相应非目标改回「不改后端」）。**此点入 §用户复核提请确认**。

---

## 10. 边界规则与 PoC gate（对抗评审补齐项）

### 10.1 `?at=` × 筛选 语义（H3）
`?at=` 与筛选参数在 URL **键层面正交**，但**语义非正交**：定位目标可能不满足当前 filters（永不出现在任何页 → 盲 load-until-found 会翻到 cap 做千条无谓拉取）。规则：
1. `?at=` 落地时，若已加载集含该 id → 直接 `scrollToIndex`。
2. 否则先 `GET /history/api/entries/:id` 拿 summary → 本地 `matchesGating(summary, filters)`（复用 §4，不含 search 维；search 维单独判 preview 包含或直接放行——因 search 门控已知有偏差，此处从宽放行避免误拒）。
3. 不满足 → **不翻页**，行内提示「该条目不在当前筛选内 · [清除筛选并定位]」（点击 `clearAll()` 保留 `?at=`）。满足而未在已加载集 → load-until-found（cap 保留）。

### 10.2 tail 实现 = invalidate 整页替换（M3，与 ADR 对齐）
tail 揭示新条目沿用现 `invalidateQueries` **整页 refetch 首页**（[useHistoryInfinite.ts](../../src/hooks/useHistoryInfinite.ts) 现行），**不改增量 prepend**。故 ADR 决策一列的 `firstItemIndex` 稳定 prepend **本期不启用**——它是 Virtuoso 未来若改增量 prepend 时的能力，现降级为 record-not-adopted（ADR 已同步更新）。虚拟化 + invalidate 整页替换下的滚动锚点/闪烁在 PoC gate 验。

### 10.3 三库组合 PoC gate（poc-first，M1）
进阶段 3（列表引擎重写）**前**先做最小 PoC（放 `exp/requests-virtuoso-poc/`）：`TableVirtuoso` + `@tanstack/react-table`（`flexRender` itemContent）+ jsdom vitest 三者跑通，含 `ResizeObserver` + 元素尺寸 stub（`offsetHeight=0` 会致 Virtuoso 渲染 0 行）、sticky header、`scrollToIndex` 可断言。PoC 绿 + 结论文档后再进全量重写。react-day-picker range→epoch + 日界（10.1 语义）一并小验。**把「白送」证成「实测可行」，不默认可行。**

