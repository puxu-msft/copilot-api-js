# ui-v4 Requests 列完全可配置（策展 + resize + reorder）— 设计规格

> 日期：2026-07-11
> 范围：`ui-v4/src/lib/request-columns.ts` + `ui-v4/src/components/requests/HistoryList.tsx` + `RequestsListPage.tsx` + `RequestsColumnMenu.tsx` + 新 `lib/activity-row.ts` 的 cache 派生 + `ui-v4/package.json`（加 dnd-kit）。**后端零改动。**
> 类型：纯前端特性（列策展 + 列宽 resize + 列序 reorder，均持久化）。
> 前置基线：[2026-07-06-ui-v4-requests-list-enhancement.md](2026-07-06-ui-v4-requests-list-enhancement.md)（列引擎 = TanStack Table + react-virtuoso，已有列显隐菜单 + localStorage 持久化）、[2026-07-10-ui-v4-session-color-bar.md](2026-07-10-ui-v4-session-color-bar.md)（session gutter 列 + itemContent 首列特判）。
> 相关（**独立后端 spec，不在本范围**）：endpoint 列显示枚举串而非 URL path 的根因 = `rawPath` 从未持久化到终态（entries_v2 无 raw_path 列）；实测证实 active 条目有 `rawPath=/v1/messages`、终态条目 `rawPath=None`。修复 = 后端 schema 迁移 + write + read，单独立项。本 spec 里 endpoint 列**默认隐藏**，不阻塞。
> 状态：**用户已复核批准（2026-07-11）** → 进入 writing-plans（保留 TanStack 原生 + dnd-kit 官方 recipe，已评估全套 grid 库为不划算的引擎替换）

把 Requests 列表的列从「固定列集 + 固定顺序 + 写死宽度 + 仅显隐可调」升级到**完全可配置**：重新策展默认列集/顺序 + 新增 cache 命中列、支持**拖拽调列宽**、支持**拖拽改列序**，三者均持久化 + 可一键复位。

---

## 1. 目标与非目标

### 目标

- **A 策展**：重定默认显示集 + 默认顺序 + 新增 cache 命中列（见 §2）。
- **B 列宽 resize**：把列宽从 Tailwind `w-[Npx]` 类迁到 TanStack `columnSizing`（数值 px + min/max），表头右边界拖拽手柄实时改宽，持久化 + 复位。
- **C 列序 reorder**：TanStack `columnOrder` + dnd-kit 拖表头改序，持久化 + 复位。
- **统一列状态持久化**：`columnVisibility` + `columnSizing` + `columnOrder` 三态各自 localStorage 持久化，一个 Reset 复位三者到默认。
- **session gutter 列豁免**：固定 10px、锁定首位、不可 resize、不可 reorder、不入显隐菜单（它是装饰 gutter 非数据列）。

### 非目标（record-not-adopted，均记原因）

- **不修 endpoint 内容 / rawPath 持久化**：那是独立后端 bug（entries_v2 无 raw_path 列 → 终态丢 rawPath），单独立项修复。本 spec endpoint 默认隐藏，前端 `endpointLabel` 已优先 rawPath、后端修好即自动生效，无需前端改。
- **不做列分组 / 冻结列（frozen/sticky columns）**：横向滚动冻结左列是另一能力，本期列都在可视宽内（preview/response 自适应），不引入。
- **不做每列自定义格式化 / 排序**：列表是 server-side 排序（时间倒序 + tail），列头点击排序不在本期（与 tail/游标分页语义冲突，属另一设计）。
- **不做导出列配置 / 多套预设**：单套持久化配置 + Reset 足够；多 profile 留后续。

---

## 2. 策展：默认列集 / 顺序 / cache 新列

### 默认显示集（9 列）

`session(gutter)` · `status` · `time` · `dur` · `model` · **`cache`(新)** · `bytes` · `preview` · `response`

### 默认隐藏（菜单可开，4 列）

`endpoint`（内容待后端修 rawPath）· `multiplier`（× 倍率，仅 ≠1 有值）· `tokens`（↑in↓out，被 cache 列部分替代）· `attempts`（仅重试>1 有值）

> 用户定夺：这四列低频/占位，默认隐藏使默认视图更简洁、preview/response 更宽。全部仍可在 Columns 菜单开启。

### 默认顺序（含隐藏列，reorder 起点）

`session` → `status` → `time` → `dur` → `model` → `cache` → `bytes` → `preview` → `response` → `endpoint` → `multiplier` → `tokens` → `attempts`

（隐藏列排在可见列之后；既然可拖拽，默认顺序只是起点。session 恒首位、锁定。）

### 新 cache 命中列（纯前端，数据已有）

- **数据源**：直接读 `entry.usage` 的**原始数字**（`cache_read_input_tokens` / `input_tokens` / `cache_creation_input_tokens`），**不**用 `tokenCacheRead`（它返回格式化字符串 `"-"`/`formatNumber`，[activity-row.ts:57](../../src/lib/activity-row.ts)，不能算比）。
- **显示**：cache 命中率 = `cache_read / (input + cache_read + cache_creation)`（如 `85%`）。**分母含 `cache_creation`** 以对齐全站「总计费 input = fresh + cache_read + cache_creation」口径（求和 oracle = `laneSummary` [AgentLane.tsx:20](../../src/components/sessions/AgentLane.tsx) `cache += cache_read + cache_creation`；口径注释 [types.ts:551](../../../src/lib/history/types.ts)）。hover title 显原始 `↺<cache_read> / <总 input>`。无 usage → 空。
- **信号**：命中率高=绿向、低但大 input=warn（复用 `rowAnomaly.cacheMiss` 判据 [activity-row.ts:97](../../src/lib/activity-row.ts)：completed 且 input>20k 且无 cache-read → warn）。
- **列宽**：默认 ~64px，可 resize。
- 新派生纯函数 `cacheHitCell(entry): { text: string; title: string; signal: Signal }` 加进 activity-row.ts（bun 测），供列 `accessorFn`/`cell` 复用。

---

## 3. Resize 模型（列宽从 Tailwind 类迁到 TanStack columnSizing）

### 现状 → 目标

- **现状**：列宽是 `COLUMN_WIDTHS` 的 Tailwind `w-[92px]` 类，套在 th/td 外壳（table-fixed 下首行决定列宽）。无 resize。
- **目标**：固定列宽改为 TanStack `ColumnDef.size`（数值 px）+ `minSize`/`maxSize`；th/td 用 inline `style={{ width: header.getSize() }}` 应用；表头加 resize 手柄。

### 混合弹性模型（用户定夺：preview/response 仍自适应充满）

**核心判据（避免 HIGH-1 陷阱）**：TanStack v8 的 `column.getSize()` **永不返回 undefined**——未设 `size` 时回退 `defaultColumn.size=150`。所以**绝不能**对所有 th/td 无条件 `style={{width: getSize()}}`（那会给 preview/response 钉死 150px、摧毁自适应）。判据：**仅当列 `enableResizing !== false` 时才 emit inline width**（即固定列）；弹性列与 gutter 一律**不设 inline width**。

- **固定 px 列**（status/time/dur/model/cache/bytes/endpoint/×/tokens/attempts）：`ColumnDef.size`（数值）+ `minSize`/`maxSize`，`enableResizing:true`，th/td emit `style={{width: header.getSize()}}`。
- **弹性列**（preview/response）：`enableResizing:false`、**无 inline width**（table-fixed 下无显式宽度的单元格自动均分剩余宽）→ 保留「preview/response 吃满剩余」。columnSizing 不含它们。
- **session gutter**（**MEDIUM-6 统一真值源**）：**沿用 session-color 特性的特判**——th 与 td 均硬编码 `p-0` + `w-[10px]`（[HistoryList.tsx:573/588](../../src/components/requests/HistoryList.tsx)），`enableResizing:false`，**排除出 columnSizing/getSize 路径**（不设 `size`、不 emit inline width）。session 宽度真值源唯一 = 特判 td/th 的 `w-[10px]` 类，不与 TanStack size 双写。

### resize 手柄

- 表头 th 右边界一个 `absolute inset-y-0 right-0 w-1 cursor-col-resize` 手柄，`onMouseDown/onTouchStart = header.getResizeHandler()`。
- **手柄必须同时 `onPointerDown={(e)=>e.stopPropagation()}`（HIGH-2 关键）**：dnd-kit `useSortable` 的拖拽 listener 走 **`pointerdown`**，而 resize handler 走 `mousedown`/`touchstart`——只在 mousedown 上 stopPropagation **挡不住** pointerdown 冒泡到 useSortable，会让「拖边界调宽」误触发「列 reorder 拖拽」。故手柄须显式吞掉 pointerdown。
- `columnResizeMode: "onChange"`（拖拽实时改宽，密行工业风即时反馈）。
- 拖拽中 th 加视觉标记（手柄高亮）。弹性列/gutter 无手柄。
- **min/max**：每固定列设 `minSize`（如 40）避免拖到 0、`maxSize` 防拖爆。

### 与 react-virtuoso 协同

- 列宽由 table-fixed **首行（fixedHeaderContent 的 th）** 决定（刚修的 session 表头 bug 已印证 [HistoryList.tsx:571](../../src/components/requests/HistoryList.tsx)）；th 与 body td 对**同一固定列**须读**同一 `getSize()`** 才不错位。resize 改 `columnSizing` → th/td width 同步 → 虚拟行重渲染即更新，无需碰 Virtuoso。
- **LOW-9 重渲染成本**：`onChange` 模式拖拽时每次 mousemove 改 columnSizing → 所有可见 body td 重渲染。虚拟化下仅 ~20–40 行（`INITIAL_ITEM_COUNT=20`），实测可接受、非零成本但不阻塞。TanStack「performant resize」的 CSS 变量优化本期不做（列数少、行数有界），若日后卡顿再引入。

---

## 4. Reorder 模型（TanStack columnOrder + dnd-kit）

### 依赖

`ui-v4/package.json` 加 `@dnd-kit/core@^6.3.1` + `@dnd-kit/sortable@^10.0.0` + `@dnd-kit/modifiers@^9.0.0`（水平轴限制）。均钉锁最新稳定版。

### 交互

- 表头 th 可拖（`useSortable`），`horizontalListSortingStrategy` + `restrictToHorizontalAxis` modifier。
- **dnd `PointerSensor` 须设 `activationConstraint: { distance: 4 }`**（拖拽激活距离阈值）：否则表头上一次普通点击 / 微动即被判为拖拽，且与 resize 手柄争抢（配合 §3 手柄的 `onPointerDown` stopPropagation 双保险）。
- 拖放改 TanStack `columnOrder` state（`arrayMove`）。
- **session gutter 锁定首位**：不入 SortableContext、不可拖、`columnOrder` 里恒排第一（渲染时强制 session 在最前，dnd 只作用于其余列）。
- 拖拽中被拖列半透明 + drop 指示。

### 与 resize 手柄共存

- th 同时是「拖拽把手（reorder）」与「右边界 resize 手柄」——二者分区：th 主体拖拽 reorder，右边界 1px 手柄 resize（`stopPropagation` 防 resize 触发 drag）。参照 TanStack 官方 dnd 示例的同款分工。

---

## 5. 统一列状态持久化 + Reset

### 版本化统一 storage key（MEDIUM-3：让新策展默认对存量用户生效）

**问题**：现有 `RequestsListPage` 把**完整** 12 键 `columnVisibility` 存进 `ui-v4:requests:columns`（[RequestsListPage.tsx:41](../../src/components/requests/RequestsListPage.tsx)），存量用户里 endpoint/multiplier/tokens/attempts 显式 `=true`。`mergeColumnVisibility` retain-on-absence → 改 `DEFAULT_COLUMN_VISIBILITY` 四列为 false **对存量装机不生效**（仍显示）。cache 新列同理会被 `mergeColumnOrder` 补到末尾而非策展第 6 位。

**决策（符合项目「无向后兼容负担」）**：改用**版本化统一键** `ui-v4:requests:column-state:v1`，存 `{ visibility, sizing, order }` 一个对象。旧键 `ui-v4:requests:columns` **弃用**（加载时若新键不存在则忽略旧键、从新默认 seed）——存量用户的旧显隐定制**一次性重置**到新策展默认（内部工具、且有 Reset 兜底，可接受；避免「策展默认永不生效」）。此后新键内正常 retain-on-absence 演进。

### 三态在统一键内各自 merge

| 状态 | 默认 | merge 语义 |
|---|---|---|
| `visibility` | `DEFAULT_COLUMN_VISIBILITY`（endpoint/×/tokens/attempts=false） | retain-on-absence（`mergeColumnVisibility`，现有） |
| `sizing` | `DEFAULT_COLUMN_SIZING`（各固定列 px） | 持久值覆盖、未知/新列取默认（`mergeColumnSizing`） |
| `order` | `DEFAULT_COLUMN_ORDER`（§2 序） | 持久序为基 + 新列按默认序补位 + 删列忽略 + session 恒置首（`mergeColumnOrder`） |

- 三个 merge 各是纯函数（bun 测），与现有 `mergeColumnVisibility` 同构。
- session 在 `columnOrder` 数组里恒占首位（`mergeColumnOrder` 强制），但**不入 dnd SortableContext**（不可拖）——二者协调：dnd 只 reorder 非 session 列，session 前缀恒定。
- 抽 `useColumnState()` hook 统一持有三态 + 单一持久化 effect（写整个 v1 对象），传给 HistoryList。

### Reset

- Columns 菜单的现有 Reset 扩展为**复位三者**（显隐→默认、序→默认序、宽→默认 size），清 `ui-v4:requests:column-state:v1`。
- 本期**单一 Reset 复位全部**（YAGNI，用户没要求拆分 Reset visibility / layout）。

---

## 6. 新增 / 修改文件

- **[request-columns.ts](../../src/lib/request-columns.ts)**：
  - `REQUEST_COLUMNS` 加 `cache` 列（display，accessorFn/cell 用新 `cacheHitCell`）；各固定列 `ColumnDef` 加 `size`/`minSize`/`maxSize`（数值，取代 `COLUMN_WIDTHS` 的 Tailwind 宽度语义）；preview/response `enableResizing:false` 无 size；session `size:10` `enableResizing:false`。
  - `DEFAULT_COLUMN_VISIBILITY` 改：endpoint/multiplier/tokens/attempts → `false`，其余 true，cache true。
  - 新 `DEFAULT_COLUMN_ORDER: string[]`（§2 顺序）+ `mergeColumnOrder(persisted)`；新 `DEFAULT_COLUMN_SIZING: Record<string,number>` + `mergeColumnSizing(persisted)`。
  - `COLUMN_WIDTHS`（Tailwind 类）**退役**（固定列宽度改由 `size` 驱动 inline width）；session gutter 保留其 `w-[10px]` 特判（§3 MEDIUM-6）。**同时清理陈旧 SSOT 死注释**：[request-columns.ts:5/122](../../src/lib/request-columns.ts) 与 [RequestRow.tsx:22-23](../../src/components/requests/RequestRow.tsx) 宣称「Live 泳道 import 本表对齐」是 aspirational 假话（RequestRow 实为硬编码宽度、从不 import COLUMN_WIDTHS），退役时一并删/改。
- **[activity-row.ts](../../src/lib/activity-row.ts)**：加 `cacheHitCell(entry): { text: string; title: string; signal: Signal }`（纯函数，读原始 usage 数字，bun 测）。
- **[request-columns.bun.test.ts](../../src/lib/request-columns.bun.test.ts)**（MEDIUM-4）：**删/改** `:112-117` 「每列 COLUMN_WIDTHS[id] 非空」断言（COLUMN_WIDTHS 退役）；`:43-56` 列序断言加 `cache`；`:109` visibility all-true 断言改为「四列 false 其余 true」。
- **[HistoryList.tsx](../../src/components/requests/HistoryList.tsx)**：
  - `useReactTable` 加 `state: { columnVisibility, columnSizing, columnOrder }` + `onColumnSizingChange`/`onColumnOrderChange` + `columnResizeMode:"onChange"` + `enableColumnResizing`。
  - th/td 外壳 width：**仅固定列** emit inline `style={{ width: header.getSize() }}`（判据 `enableResizing !== false`，§3 HIGH-1）；弹性列不设 width；session 特判保留 `w-[10px]`。
  - `fixedHeaderContent`：非 session 的 th 包 dnd-kit `useSortable` + 右边界 resize 手柄（`onPointerDown` stopPropagation）；session th 仍 `p-0`（session-color 已修）。
  - itemContent 首列特判（session 色带）保留不变。
- **[RequestsListPage.tsx](../../src/components/requests/RequestsListPage.tsx)**：列状态提升为三态（`useColumnState()`），版本化统一键持久化 effect，包 dnd-kit `DndContext`（`PointerSensor` + `activationConstraint.distance=4` + `restrictToHorizontalAxis`）传 HistoryList。
- **[RequestsColumnMenu.tsx](../../src/components/requests/RequestsColumnMenu.tsx)**：菜单项迭代改用 `columnOrder` 序；session 不列入菜单；Reset 复位三态。
- **package.json**：加 `@dnd-kit/core@^6.3.1` + `@dnd-kit/sortable@^10.0.0` + `@dnd-kit/modifiers@^9.0.0`。

### Live 泳道（AgentLane / RequestRow）不在本期改动范围（MEDIUM-5 决策）

`RequestRow.tsx`（Session 详情的 AgentLane 泳道用，非虚拟、独立组件）**自持硬编码列宽**（[RequestRow.tsx:65-109](../../src/components/requests/RequestRow.tsx)），**不 import COLUMN_WIDTHS** → 退役不破它。**本期决策**：AgentLane 泳道**保持自有固定宽、不跟随 History 的 resize**（两者是不同语境：History 主列表 vs Session 详情泳道，宽度发散可接受），且**不加 cache 列到 RequestRow**（泳道聚焦 per-agent 请求流，cache 列非其核心）。→ 记 defer：若日后要 Live 泳道与主列表列一致，另立项统一 RequestRow 到共享列模型（richest-data-flow 视角倾向补齐，但非本期诉求）。

---

## 7. 测试计划

### bun test（纯逻辑）
- `activity-row`：`cacheHitCell` —— 有 cache-read 算占比 %（分母含 creation，与 laneSummary 口径一致）、无 usage 空、大 input 无 cache → warn signal。
- `request-columns`：`DEFAULT_COLUMN_VISIBILITY` 四列(endpoint/×/tokens/attempts) false 其余 true；`DEFAULT_COLUMN_ORDER` 含全列且 session 首、cache 在第 6 位；`mergeColumnOrder`（持久序 + 新列补位 + 删列忽略 + session 置首）；`mergeColumnSizing`（覆盖 + 未知列默认 + 新列默认）；**列序断言 `:43-56` 加 `cache`**；**删/改 `:112-117` COLUMN_WIDTHS 非空断言**（COLUMN_WIDTHS 退役，MEDIUM-4）；**改 `:109` visibility all-true → 四列 false**。

### vitest（jsdom）
- `HistoryList`：固定列 th/td 有 inline width style；弹性列无 width；resize 手柄存在（固定列）、gutter/弹性列无手柄；`onColumnSizingChange` 经手柄 mousedown+move 触发（或直接 setState 验 width 变）；cache 列渲染 % 文本。
- reorder：dnd-kit 在 jsdom 的坑——用 TanStack `columnOrder` state 直接断言（setState → th 顺序变），拖拽端到端交给人工核验（dnd-kit 的 pointer 传感器 jsdom 难模拟；用 keyboard sensor 或直接测 order state 变更）。
- 持久化：三态写/读 localStorage、未知键回退默认、Reset 清三键回默认。
- 菜单：session 不在菜单项；Reset 复位三态。

> **布局/拖拽正确性依赖人工核验**（jsdom 无 layout + dnd pointer 难模拟）：§8 收尾必含用户起服核对 resize 手感 / reorder 拖拽 / 弹性列充满 / 持久化跨刷新。

### 门禁
- `typecheck` + `typecheck:ui-v4` + 无缓存 eslint + bun/vitest 全绿 + `build:ui-v4` exit 0。

---

## 8. 落地阶段（供 writing-plans 细化）

1. **策展 + cache 列**：`cacheHitCell` + bun 测；`DEFAULT_COLUMN_VISIBILITY` 改默认隐藏集 + cache 列加入 REQUEST_COLUMNS；`DEFAULT_COLUMN_ORDER`。默认视图即变（无 resize/reorder）。
2. **Resize**：列 `size`/min/max + `columnSizing` state + inline width 迁移 + resize 手柄 + 持久化（`mergeColumnSizing`）。弹性列保持自适应。
3. **Reorder**：加 dnd-kit 依赖 + `columnOrder` state + DndContext/useSortable + 水平轴限制 + session 锁首 + 持久化（`mergeColumnOrder`）+ 菜单随序 + Reset 复位三态。
4. **收尾**：subagent 合并态审查 + **人工视觉核验**（resize/reorder/弹性/持久化/cache 列）+ doc-sync（DESIGN §4 更新列体系）+ 细粒度提交。

每阶段 typecheck + 对应测试绿，subagent review 后提交。

---

## 9. 关联独立项（提醒，不在本 spec）

**rawPath 持久化后端修复**（endpoint 列内容根因）：
- 根因（实测）：`rawPath` 在 in-flight 捕获（active 条目有 `/v1/messages`），但 entries_v2 **无 raw_path 列**、write/read 均不含 → 终态条目 `rawPath=None` → 列表（terminalOnly）全回退枚举串。
- 修复：entries_v2 加 `raw_path` 列（Umzug 迁移）+ `insertCompletedEntry` 写入 + `rowToSummary` 读回；老行 rawPath 已永久丢失（从没存过）→ 只能新行生效，老行继续回退直至 reaper 淘汰。
- 属 richest-data-flow 违背（上游有、落盘丢），单独 spec 立项修复。前端 endpoint 列本期默认隐藏、后端修好自动显真路径。

---

## 10. 审查纪要（一轮对抗 subagent，全数纳入）

一轮对抗审查（亲读 request-columns / HistoryList / RequestRow / RequestsListPage / activity-row / types 真实代码）：0 CRITICAL / 2 HIGH / 4 MEDIUM / 3 LOW，**全部纳入**：

| 发现 | 级别 | 处置 |
|---|---|---|
| `getSize()` 对弹性列返 150、会钉死 preview/response；§3 自相矛盾 | HIGH | **纳入**：§3 定判据「仅 `enableResizing!==false` 固定列 emit inline width」，删「都读 getSize」矛盾句 |
| resize 手柄 mousedown stopPropagation 挡不住 dnd pointerdown | HIGH | **纳入**：§3 手柄补 `onPointerDown` stopPropagation；§4 dnd 补 `activationConstraint.distance=4` |
| 存量用户 localStorage 全键=true、策展默认不生效 | MED | **纳入**：§5 改版本化统一键 `column-state:v1`、弃旧键、一次性重 seed 新默认 |
| 退役 COLUMN_WIDTHS 打破 bun 测试 `:112-117`，§7 漏 | MED | **纳入**：§6/§7 显式删改该断言 |
| 陈旧「Live 泳道 import 本表」死注释 + AgentLane 决策未记 | MED | **纳入**：§6 清理死注释 + 明确 AgentLane 保持自有宽/不加 cache（记 defer） |
| session gutter 宽度双真值源、§3/§6 不一致 | MED | **纳入**：§3 统一为特判 `w-[10px]`、排除出 sizing |
| cache 命中率分母漏 cache_creation | LOW | **纳入**：§2 分母含 creation、对齐 laneSummary/stats 口径 |
| cacheHitCell 该读原始数字非 tokenCacheRead（格式化串） | LOW | **纳入**：§2 数据源改原始 usage 数字 |
| `columnResizeMode:onChange` 每帧重渲染成本未评估 | LOW | **纳入**：§3 注记（虚拟化 20–40 行可接受、CSS 变量优化 defer） |
| RequestRow import COLUMN_WIDTHS（审查前提） | — 证伪 | reviewer 纠正：RequestRow 硬编码宽度、不 import → 退役不破编译 |
