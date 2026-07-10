# ui-v4 请求列表 session 色带 + 多选对比高亮 + 可切换色板 — 设计规格

> 日期：2026-07-10
> 范围：`ui-v4/src/components/requests/HistoryList.tsx` + 新 leaf `ui-v4/src/lib/session-color.ts` + `ui-v4/src/styles/theme.css`（圆角破例类）+ 一处本地选择态。**后端零改动。**
> 类型：纯前端特性（视觉分组 + 多选对比交互）。
> 前置基线：[2026-07-06-ui-v4-requests-list-enhancement.md](2026-07-06-ui-v4-requests-list-enhancement.md)（Requests 页已是 react-virtuoso + TanStack Table 引擎、七维筛选、`?at=` 定位、tail/缓冲、键盘 roving 光标）。
> 审查：两轮 subagent 对抗审查已纳入（见 §11 审查纪要）。
> 状态：**用户已复核批准（2026-07-10）** → 进入 writing-plans 拆实施计划

本规格在**已落地**的扁平时序 Requests 列表上，叠加一层**按 `session_id` 的视觉聚合与对比**：

- 每行左侧一条按会话稳定着色的**色带**，相邻同会话连成链；subagent 行内容缩进 + 色带更深，区分 main。
- **默认**（未选任何会话）：所有带 session id 的行按各自会话色铺一层**淡背景**，一眼区分不同会话；无 session 的行素净。
- **多选对比**：点色带 / 按 `f` 把会话加入选择集，选中会话的行铺**更强的会话色背景**、非选中行**变灰**——多个会话可同时高亮、直观对比它们的请求在时间线上如何交错。

全局时间倒序**一字不动**，后端零改动。填补 Requests（纯时序、无聚合）与 Sessions（纯聚合、丢全局时序）之间的空档。

---

## 1. 目标与非目标

### 目标

- **session 色带（首列，零重排）**：每行左侧 ~10px 色列；颜色由 `session_id` 稳定 hash 得出；相邻同会话色块无缝竖直贯通成链，段首圆顶段尾圆底，被打断则断开。全局时间倒序**一字不动**。
- **main vs subagent 区分**：subagent 行（`agentId !== undefined`）**内容缩进**（status 列内容左 padding 右移）+ 色带取同会话色**更深一档**；main 行（`agentId === undefined`）不缩进、用本色。
- **默认会话淡背景**：未选任何会话时，每行按其会话色铺一层**低透明度淡背景**（稍暗），使不同会话默认可辨；无 `sessionId` 的行（如 OpenAI / Gemini 流量）无背景、保持素净。
- **多选对比高亮**：点某行色带 / 光标行按 `f` → 把该会话**加入 / 移出**选择集（`Set`）。选择集非空时：属选中会话的行铺**更强的会话色背景**且全彩，非选中行**变灰**（`opacity` 压暗）。可同时选多个会话对比。
- **清空选择**：`Esc` 清空整个选择集（并清 roving 光标）；点已选会话色带再点一次移出。
- **多套可切换色板**：色板做成**注册表**（多套精选分类色板，各有 name + 风格），列表工具区一个选择器切换；所选色板 `localStorage` 持久化（镜像列可见性持久化机制）。切换即时作用于色带 + 淡/强背景。具体色值经 subagent 配色专家产出并自校验（§4 色板注册表）。
- **色带 / 高亮默认常亮**：色带与默认淡背景本身无显隐开关（区别于「色板选择」这一持久化设置）。
- 视觉对齐既有 Terminal Amber（近黑背景 `#141210`、mono、高密度、锐角）。

### 非目标（record-not-adopted，均记原因）

- **不做「按 session 过滤」（删行 / 改结果集）**：用户要的是「高亮 / 变灰」而非「过滤」——保留全部行与真实时间位置，比过滤更贴合「保留时序」。后端 `sessionId` 过滤能力仍在，属 Sessions 钻取语境，本期不接入列表。
- **不做 hover tooltip 数字合计**：会话数字合计（req 数 / token / 用时 / ✓✗）已由 Sessions 页 + Session 详情泳道（`laneSummary`）提供；列表页定位为**视觉归属 + 对比高亮**，非行内数字。留作低成本后续增强（§8）。
- **不做段首内联组头**：占行高、偏离「零重排」。
- **不做右侧 minimap rail**：宏观占比视图，可后续加，不阻塞本期。
- **不做「按会话聚拢重排」/「组内时序」骨架**：牺牲全局交错时序、且能力≈ Sessions 页，重复。
- **不做色带 / 高亮的显隐开关**：色带默认常亮（**但色板选择是持久化设置** —— 见目标）。

---

## 2. 现状基线（改动锚点）

### 数据侧（已就绪，无需改）

- `EntrySummary`（[types.ts:569-570](../../../src/lib/history/types.ts)）与 `HistoryEntry`（[types.ts:372-373](../../../src/lib/history/types.ts)）顶层均带 `sessionId?: string` 与 `agentId?: string`。前端行数据（`EntrySummary`）**已携带**二字段——无需后端或数据通路改动。
- 来源：`sessionId` = `x-claude-code-session-id`（会话内稳定 UUID）；`agentId` = `x-claude-code-agent-id`（`undefined` 即 main agent）。见 [sessions.ts:36-68](../../../src/lib/history/sessions.ts)。`agentId===undefined` 判 main 与 `groupByAgent`（[SessionDetailPage.tsx:16](../../src/components/sessions/SessionDetailPage.tsx)）/ `laneSummary` 语义一致。
- 现成可复用聚合：`laneSummary`（[AgentLane.tsx:9](../../src/components/sessions/AgentLane.tsx)）、后端 `querySessionSummaries`（[sessions-agg.ts](../../../src/lib/history/sqlite/sessions-agg.ts)）——本期不消费，为后续 tooltip 预留。

### 前端渲染管线现状（改动锚点 —— 审查核对过的真实约束）

| 位置 | 现状（file:line） | 对本特性的约束 |
|---|---|---|
| `TableVirtuoso` 行 | 可见行是连续真实 `<tr>`，`<tr {...props}>` 的 children 即 itemContent 的 `<td>`（[HistoryList.tsx:130-160](../../src/components/requests/HistoryList.tsx)） | td 是 tr 的 DOM 子节点 → 色带 `onClick` 的 `stopPropagation` 能拦住冒泡到 tr 的 navigate（**成立**） |
| 统一 td 外壳 | itemContent 对**所有** cell 套 `overflow-hidden px-2 py-1 align-middle`（[HistoryList.tsx:509-512](../../src/components/requests/HistoryList.tsx)） | session 列**必须破例**脱此外壳，否则 `py-1`(上下各4px)+`overflow-hidden` 使色块断裂、不可贯通 |
| 行边框 | `ROW_CLASS` 含 `border-b border-[#222]` + table `border-collapse`（[HistoryList.tsx:100/124](../../src/components/requests/HistoryList.tsx)） | 行间恒有 1px 线，色块须绝对定位 `-bottom-px` 跨过它桥接 |
| 列宽模型 | `COLUMN_WIDTHS` Tailwind 宽度类、`table-fixed` box-border（[request-columns.ts:123-135](../../src/lib/request-columns.ts)） | `w-[10px]` 含 `px-2` 会被吃穿 → session td 必须无水平 padding |
| 取数路径 | `flexRender(cell.column.columnDef.cell, cell.getContext())`（[HistoryList.tsx:513](../../src/components/requests/HistoryList.tsx)），`cell.getContext()` 是 **TanStack** context，不含 Virtuoso `RowContext` | 色列渲染**不能**走 `ColumnDef.cell` 读 runs；须在 itemContent 对首列特判、用第三参 `context`（见 §4） |
| 全局圆角 reset | `theme.css:29` `*,*::before,*::after{border-radius:0!important}`；破例先例 `.livedock-island{border-radius:2px!important}`（[theme.css:32-34](../../src/styles/theme.css)） | 段帽圆角须用**专属类 + `!important`**，裸 `rounded-*` 会被吞 |
| 行选中态 | `<tr>` 用 `border-l-2 border-l-primary` + `bg-[#3a2f1a]` + `text-[#f0d8a8]`（[HistoryList.tsx:100-104](../../src/components/requests/HistoryList.tsx)） | 会话背景色须与选中背景**单值优先级合并**（§3），border-l 与色列 td 分层不冲突 |
| 键盘 | `onListKeyDown` switch：↑↓/Esc 已用，`default` 仅 break 不 preventDefault（[HistoryList.tsx:379-417](../../src/components/requests/HistoryList.tsx)） | 加 `case "f"` 无冲突；`isTyping` 守卫在 switch 前 return |
| 列可见性 | `REQUEST_COLUMN_IDS` 由 `REQUEST_COLUMNS.map` 派生，`mergeColumnVisibility` retain-on-absence（[request-columns.ts:262-283](../../src/lib/request-columns.ts)） | 加 `session` 列自动纳入默认可见、旧 blob 兼容 |

---

## 3. 状态模型与背景色优先级（核心正确性）

### 选择态

```
selectedSessions: Set<string>   （本地 useState，非 URL / 非 store / 非后端）
  · 空集      = 默认态：所有带 sessionId 行铺「淡会话背景」，无行变灰
  · 非空集    = 对比态：selectedSessions 含该行 sessionId → 「强会话背景」+ 全彩；否则 → 变灰(opacity)
toggleSession(sid): sid ∈ set ? 删 : 加      （undefined/无 sessionId → no-op，见 H1）
点色带 → toggleSession(row.sessionId)
光标行按 f → toggleSession(rows[focusedIndex]?.sessionId)
Esc → 清空 set + 清 roving 光标
```

**为何本地 `useState` 而非 URL / store**：对比高亮是**瞬时浏览辅助**，不改结果集、不触发 refetch、不需深链/分享/跨页存活（对比筛选走 URL-as-SSOT）。放本地态最小内聚；未来需「刷新保留选择」再提升。`toggleSession` 用 `useCallback` 稳定引用（避免额外换引用触发重渲染）。

### 行背景：单值优先级（避免多层背景打架）

每行背景色在一处按优先级算出**单个** `backgroundColor`（+ 是否 dim），杜绝「会话淡背景」与「`?at=` 选中背景」争同一 CSS 属性：

| 优先级 | 条件 | 背景 | 透明度 |
|---|---|---|---|
| 1（最高） | `?at=` 选中行 | 选中琥珀 `#3a2f1a`（现值） | 若同时非选中会话则叠 dim |
| 2 | 对比态 且 `sessionId ∈ selectedSessions` | 会话色 **强** tint（`palette.strongAlpha`，18–20%） | 全彩 |
| 3 | 对比态 且 `sessionId ∉ selectedSessions` | 无 tint（或极淡） | **dim**（`opacity-40`） |
| 4 | 默认态（空选择集）且有 `sessionId` | 会话色 **淡** tint（`palette.faintAlpha`，按套 12–16%，做分组底纹） | 全彩 |
| 5 | 无 `sessionId` | 无背景 | 全彩 |

- **dim 只用 `opacity`**：施于 `<tr>` 整体压暗（含 border-l、文字、色带），**不追加 muted 文字类**（避免与 `selectionClass` 的 `text-*` 同权重 class 顺序冲突，审查 #5）。
- flash（`toc-flash` 类动画）叠在最上层，不受背景优先级影响。
- 选中 `border-l-2` 始终由 `<tr>` 承载，与色列 td、与背景 tint 三者分处不同盒/属性，正交共存。

---

## 4. 新增 / 修改文件

### 新增纯逻辑 leaf（bun test）

**`ui-v4/src/lib/session-color.ts`**
```ts
/** 一套分类色板：name（kebab）+ 风格描述 + N 个 { base, shade } 配对 + 淡/强 tint alpha。 */
export interface SessionPalette {
  name: string
  label: string          // 中文风格描述
  colors: ReadonlyArray<{ base: string; shade: string }>  // base=色带原色, shade=subagent 更深档
  faintAlpha: number     // 默认淡背景 tint alpha
  strongAlpha: number    // 选中会话强背景 tint alpha
}
/** 色板注册表（多套，模块常量，具体色值由配色 subagent 产出并自校验填入）。 */
export const SESSION_PALETTES: ReadonlyArray<SessionPalette>
export const DEFAULT_PALETTE_NAME: string
/** 稳定 hash(sessionId) → 在给定色板里索引一个 { base, shade }；无 sessionId → null。 */
export function sessionColor(sessionId: string | undefined, palette: SessionPalette): { base: string; shade: string } | null
/** 会话色 + alpha → rgba 背景串（淡/强两档取 palette.faintAlpha / strongAlpha）。 */
export function sessionTint(baseColor: string, alpha: number): string
/** 相邻 run 边界预扫：按显示顺序输入，输出每行 run 元信息（color/shade 已按当前色板解析）。 */
export function computeSessionRuns(
  rows: ReadonlyArray<{ id: string; sessionId?: string; agentId?: string }>,
  palette: SessionPalette,
): Map<string, { color: string; shade: string; indent: boolean; isRunStart: boolean; isRunEnd: boolean }>
/** localStorage 键 —— 所选 session 色板名。 */
export const PALETTE_STORAGE_KEY = "ui-v4:requests:session-palette"
```
- **色板注册表**：`SESSION_PALETTES` 含 **4 套**精选分类色板（具体值见下「§4 色板注册表具体值」），各 8–9 色、每色 `base`（~10px 亮色带原色）+ `shade`（subagent 更深档 = `OKLCH(L−0.10)`）。全部锁在**冷色弧**（暖色被语义锚点封死）、与语义信号色（琥珀 `#d4a04a` / 绿 `#7fd99a` / 红粉 `#e08a8a`）色相距 **≥33°**，在近黑 `#141210` 上可辨且相互可区分。经配色 subagent invoke `dataviz` skill 的官方 `validate_palette.js`（Machado-2009 CVD ΔE / OKLCH 明度带 / 色度地板 / WCAG 对比度）**实测校验**，`--pairs all`（任意两会话行可相邻，用全对基准）。
- **默认 `terminal-neon`**：唯一实测通过 CVD 全对最差 ΔE ≥12（其余三套落 8–12 地板带、合法但强依赖 session id 文字次级编码）、9 色槽最多、`#141210` 上最醒目。
- **淡 tint 的诚实定位（H2 关键）**：8% 淡 tint 实测**低于 JND**（相邻同族会话糊）——故**身份主要由 10px 亮色带承担、淡背景 tint 只做「分组底纹」**；各套淡档 alpha 按实测 JND 地板设（neon/pastel 14%、oceanic 12%、slate 16%，见具体值表），强档 18–20%。
- **hash 稳定**：`sessionId` FNV-1a / djb2（纯函数、无依赖）→ `colors.length` 取模索引。同一会话在**任一色板下**都稳定（换色板 → 换整套色，但同色板内同会话恒同色）。哈希碰撞可接受（选择交互 + 断链兜底）。
- **`computeSessionRuns` 纯函数、独立可测**：接受当前 `palette` 解析 color/shade；run 边界只看相邻行 `sessionId` 是否相等。跑在 `useHistoryInfinite` 已加载**全部页拼接**的 `entries` 上（非虚拟化可见窗口），虚拟化不截断计算；**分页前沿行** `isRunEnd` 暂定 `true`，翻页后 memo 重算收敛（自愈抖动，审查 #6）。

#### §4 色板注册表具体值（配色 subagent 产出，官方 validator 实测）

`shade` 推导规则 `OKLCH(L−0.10, C, H)`（保色相/色度、降一档明度，base↔shade ΔE≈12）；下表已逐色配好，可直接写常量。tint 规则：faint = base 转 rgba 叠各套 faintAlpha、strong = 叠 strongAlpha。

```ts
export const SESSION_PALETTES = [
  { name: "terminal-neon", label: "冷调霓虹（高饱和·分离度最佳·默认）", faintAlpha: 0.14, strongAlpha: 0.20, colors: [
    { base: "#00a39a", shade: "#00847c" }, { base: "#009fb2", shade: "#008093" }, { base: "#009bce", shade: "#007cad" },
    { base: "#2f9af2", shade: "#007bd0" }, { base: "#4a78f9", shade: "#2f58d6" }, { base: "#6f48f3", shade: "#561ed0" },
    { base: "#953cd1", shade: "#7710af" }, { base: "#a442a8", shade: "#842089" }, { base: "#ab448e", shade: "#8a2470" },
  ] },
  { name: "oceanic-jewel", label: "冷色宝石（深浓通透·与 amber 最和谐·faint 分离最佳）", faintAlpha: 0.12, strongAlpha: 0.18, colors: [
    { base: "#00968b", shade: "#00786e" }, { base: "#0093a5", shade: "#007586" }, { base: "#008dc3", shade: "#006fa3" },
    { base: "#2569a8", shade: "#004c88" }, { base: "#5874ea", shade: "#3e55c8" }, { base: "#7746e0", shade: "#5c1fbe" },
    { base: "#a43ecf", shade: "#8513ae" }, { base: "#b321a2", shade: "#910083" },
  ] },
  { name: "pastel-cool", label: "冷柔和（浅·低饱和·克制）", faintAlpha: 0.14, strongAlpha: 0.18, colors: [
    { base: "#28a6a0", shade: "#008782" }, { base: "#2ea6ba", shade: "#00879b" }, { base: "#449dc7", shade: "#1e7ea7" },
    { base: "#5d95d7", shade: "#3f76b6" }, { base: "#7080dd", shade: "#5462bc" }, { base: "#7f66b8", shade: "#634998" },
    { base: "#9360a3", shade: "#754384" }, { base: "#a25b90", shade: "#823e72" },
  ] },
  { name: "slate-muted", label: "冷板岩柔和（低饱和·沉稳；替代被语义封死的暖大地色）", faintAlpha: 0.16, strongAlpha: 0.18, colors: [
    { base: "#27a6a3", shade: "#008785" }, { base: "#2ca2b9", shade: "#00839a" }, { base: "#2e83b0", shade: "#006591" },
    { base: "#3262a9", shade: "#154589" }, { base: "#6c6fc8", shade: "#5151a7" }, { base: "#9d81ce", shade: "#7f63ad" },
    { base: "#8c5798", shade: "#6e3b79" }, { base: "#955584", shade: "#763967" },
  ] },
] as const satisfies ReadonlyArray<SessionPalette>
export const DEFAULT_PALETTE_NAME = "terminal-neon"
```

**校验结论**（`validate_palette.js --mode dark --surface "#141210" --pairs all`）：四套明度带 / 色度地板 / 色带对比度（全 ≥3:1）/ 与语义色隔离（≥33°）**均 PASS**；CVD 全对最差 ΔE：neon 12.4（达标）、oceanic 10.3 / slate 9.6 / pastel 9.5（8–12 地板带，靠 session id 文字兜底）；tritan 全 ~2.8–3.0（冷色弧物理下限，无解，靠文字次级编码）。**已知勉强槽位**（供后续微调，不阻塞）：pastel `#5d95d7`↔`#449dc7`（两天蓝，最勉强，可换 `#6b90e0` 拉大明度差）。深端 shade（紫/品红 L≈0.45）对比度 2.0–2.4:1——作紧贴亮父带的从属档可辨，**不宜单独当独立色带**（本设计 shade 只用于 subagent 从属，成立）。

### 修改

- **[request-columns.ts](../../src/lib/request-columns.ts)**：`REQUEST_COLUMNS` 头部插入 `session` 列（`id:"session"`，占位用——保证 header / 列数 / table-fixed 列宽账目一致），`COLUMN_WIDTHS.session = "w-[10px]"`。**该列的实际渲染在 itemContent 特判**（见下），其 `ColumnDef.cell` 仅作占位（不被走到）。列自动纳入 `DEFAULT_COLUMN_VISIBILITY` / `mergeColumnVisibility`。
- **[HistoryList.tsx](../../src/components/requests/HistoryList.tsx)**：
  - `const runs = useMemo(() => computeSessionRuns(entries, activePalette), [entries, activePalette])`。
  - `const [selectedSessions, setSelectedSessions] = useState<Set<string>>(() => new Set())`；`toggleSession = useCallback(...)`（不可变替换 Set）。
  - **色板选择态**：`const [paletteName, setPaletteName] = useState(() => 读 localStorage(PALETTE_STORAGE_KEY) ?? DEFAULT_PALETTE_NAME)`；`activePalette = SESSION_PALETTES.find(p => p.name === paletteName) ?? 默认`（未知名回退默认，镜像 `mergeColumnVisibility` 的 retain-on-absence）。`setPaletteName` 同步写 localStorage。切色板 → `activePalette` 变 → runs 重算 + 背景 tint 重取，即时生效。
  - **色板选择器 UI**：列表工具区（History header 或列可见性菜单旁）放一个小下拉（复用 shared `FilterSelect` 范式），选项 = `SESSION_PALETTES` 的 `{ name, label }`。**纯前端本地设置**，不进 URL、不碰后端。
  - **`RowContext` 扩展**注入 `runs` / `selectedSessions` / `onToggleSession`（Virtuoso `context` prop 送达 `TableRow` + itemContent）。
  - **itemContent 破例首列**（审查 #1/#2 的正确接线）：itemContent 接**第三参 `context`**；`row.getVisibleCells().map` 时对 `cell.column.id === "session"` **特判**——不走标准 `overflow-hidden px-2 py-1` 外壳、不走 flexRender，改渲染专属 `<td class="p-0 relative w-[10px]">`，内含绝对定位色块（见 §渲染）。其余列照旧。
  - **TableRow**：从 `context` 读该行 run/选择态，算 §3 单值背景 + dim（inline `style={{ backgroundColor }}` + 条件 `opacity-40` 类），**选中 `border-l` 逻辑不变**。
  - **subagent 内容缩进**：itemContent 渲染 `status` 列时，若该行 `indent` 为真，给 status 单元格**内容**加左 padding（如 `pl-3`），使 subagent 行首列文字右移——真内容缩进、**不改列宽**（table-fixed 下整行缩进不可行，审查 #3）。
  - **键盘**：`onListKeyDown` 加 `case "f"`（非输入态、有光标行）→ `toggleSession(rows[focusedIndex]?.original.sessionId)`；`case "Escape"` 现有分支追加 `setSelectedSessions(new Set())`。
  - **富数据流**：色列拿完整 run 元信息、背景判定拿完整 `sessionId`，不在上游裁字段。
- **[theme.css](../../src/styles/theme.css)**：加段帽圆角破例类（照 `.livedock-island` 先例），如 `.session-cap-top{border-top-left-radius:2px!important;border-top-right-radius:2px!important}` / `.session-cap-bottom{...bottom...}`——压过全局 `border-radius:0!important`。

### 色块渲染（§1 贯通的具体手法，审查 #1/#1b 结论）

session 列专属 td（脱统一外壳）：
```
<td class="p-0 relative w-[10px]">
  <div
    class="absolute inset-0 -bottom-px [+ isRunStart?session-cap-top] [+ isRunEnd?session-cap-bottom]"
    style={{ backgroundColor: indent ? shade : color }}
  />
</td>
```
- `p-0` 去水平 padding（`w-[10px]` 才可见 ~10px 色带）；`relative` + 色块 `absolute inset-0` 满铺行高。
- `-bottom-px`（`bottom:-1px`）让色块盖过本行 `border-b`、与下一行色块顶端重叠 1px → **无缝贯通**。
- 圆角只在段边界：`isRunStart`→顶帽类、`isRunEnd`→底帽类（走 `!important` 破例类）。
- subagent 用 `shade`（更深）；main 用 `color`。

---

## 5. 交互正确性

| 场景 | 行为 |
|---|---|
| 默认（空选择集） | 每带 sessionId 行铺淡会话背景（优先级4）；色带按会话着色、相邻连链；无行变灰 |
| 点行 A 色带（会话 X，X 不在选择集） | X 入选择集 → X 行铺强背景+全彩，非选中行变灰。**行数/顺序/时间位置全不变** |
| 再点 X 行色带 | X 移出选择集；若集变空 → 回默认态（全部复亮+淡背景） |
| 点行 B 色带（会话 Y，与 X 并存） | Y 也入集 → X、Y 行各自强背景（各自会话色）、其余变灰 → **多会话对比** |
| 光标行按 `f` | toggle 光标行会话（等价点其色带）；光标行无 sessionId → no-op（H1） |
| `Esc` | 清 roving 光标（现有）**且**清空选择集 → 回默认态 |
| 点行非色带区 | 照常进 `/requests/:id`（色带 `stopPropagation`，审查 #4 成立） |
| tail 揭示新行（对比态） | 新行属选中会话→强背景全彩，否则变灰；选择按 `sessionId` 记忆，不因 `entries` 换引用而丢 |
| `?at=` 选中行叠加对比态 | 背景取优先级1（选中琥珀）；若其会话非选中则叠 dim；border-l 仍在（降透明度） |
| 无 sessionId 行 | 无色带背景、无淡 tint；对比态下变灰（不属任何选中会话）；`f` 在其上 no-op（H1） |

---

## 6. 组件边界与隔离

- `session-color.ts` —— 纯函数（hash / 色板 / tint / run 边界），无 React 依赖，**独立可测**（bun）。
- `request-columns.ts` —— 列定义纯数据；session 列仅占位（渲染在 itemContent 特判）。
- `HistoryList.tsx` —— 唯一持有选择态 + run memo 的编排点；渲染 / 滚动 / 键盘 / 背景优先级集中于此，数据仍全来自 `useHistoryInfinite`。

选择态与筛选（URL）/ tail（store）/ 选中（URL `?at=`）**四者正交**：对比高亮是叠在渲染层的本地视觉态，不改数据获取、路由、结果集。

---

## 7. 测试计划

### bun test（`session-color.bun.test.ts`）
- `SESSION_PALETTES` 注册表自校验：每套每个 `base`/`shade` 是合法 hex；每套色**不属**任一语义信号色（正样本证：色板 ∩ {琥珀/绿/红粉} = ∅）；`shade` 较 `base` 更深（可判定亮度下降）；`DEFAULT_PALETTE_NAME` 在注册表内。
- `sessionColor`：给定色板，同 id 稳定同色；不同 id 抽样落多个槽；`undefined`→`null`；换色板 → 同 id 落对应色板的色（同色板内稳定、跨色板可不同）。
- `sessionTint`：给定 alpha 产合法 rgba；淡档 alpha < 强档。
- `computeSessionRuns`：相邻同会话→`isRunStart/End` 正确标段首尾；被打断→断链（同会话两段各成 run）；`agentId` 有值→`indent=true`+`shade`；无 sessionId 行→不与相邻真实会话连链；空/单行/**分页前沿末行 isRunEnd=true** 边界；换色板 → color/shade 随之变。

### vitest（jsdom + @testing-library/react，`HistoryList` 扩展）
- 色列渲染：每行出现色块 div；subagent 行 status 单元格有缩进类、色块用 shade（查 class/style）。
- 选择交互：点行色带 → 该会话行获强背景 style、非选中行获 dim 类；点第二个会话 → 两会话行各带各自背景（**多选**）；再点已选 → 移出；集空 → 回默认淡背景。**否定断言配正样本**（先证强背景确施于目标行，再证他行未施）。
- `stopPropagation`：点色带**不**触发 navigate（mock）；点行其余部分**触发**。
- 键盘：光标行 `f` → toggle 其会话；`Esc` → 光标清空**且**选择集清空。
- 默认态：无选择时带 sessionId 行有淡背景 style、无 sessionId 行无；无行有 dim 类。
- **色板切换**：选色板下拉换选项 → 行色带/背景 style 变为对应色板的色；刷新（重挂载读 localStorage）保留所选；localStorage 存未知名 → 回退默认色板。
- 选中正交：`?at=` 行背景取琥珀（非会话 tint）、border-l 仍在。
- H1：`f` 在无 sessionId 光标行 no-op。

> **布局正确性不在自动化覆盖内（审查 #7）**：jsdom 无 layout，色块「无缝竖直贯通」「~10px 可见宽」「内容缩进像素」本质是布局问题，`toHaveClass`/style 存在性**测不出真实视觉**。故 §8 收尾**必须**含一条人工视觉核验门（受 no-auto-server 约束，由用户起服）。jsdom 坑另见 skill `debugging-frontend-tests`（TableVirtuoso 需 `ResizeObserver`/尺寸 stub，沿用现有 fake Virtuoso）。

### 门禁
- `typecheck` + `typecheck:ui-v4`（根 typecheck 不覆盖 ui-v4 子项目）+ 无缓存 eslint + bun/vitest 全绿。
- `build:ui-v4`（esbuild 不做类型检查，权威门是 `typecheck:ui-v4`）；`~backend` 纯 type-only import。

---

## 8. 落地阶段（供 writing-plans 细化）

1. **配色 leaf**：`session-color.ts`（hash + **色板注册表 `SESSION_PALETTES`（含具体 hex，来自配色 subagent）** + `sessionColor` + `sessionTint` + `computeSessionRuns`）+ bun test。纯函数先行、独立绿。
2. **色列渲染 + 段帽**：theme.css 加破例圆角类；request-columns 加占位 session 列；HistoryList itemContent 首列特判渲染专属 td + 绝对定位色块 + `-bottom-px` 贯通 + 段帽 + subagent shade/缩进。默认淡背景（优先级4/5）接通。**视觉分组可见，无选择交互。**
3. **多选对比交互 + 色板切换**：`selectedSessions` Set 态 + 色带 click（stopPropagation + toggle）+ §3 单值背景优先级（强 tint / dim）+ `f` / Esc 键盘 + 跨 tail 存活；**色板选择器（下拉 + localStorage 持久化 + 未知名回退默认）**。vitest 覆盖多选 / 键盘 / 正交 / 默认态 / 切色板换整套色。
4. **收尾**：subagent audit（裁判轴：长远正确 + 完整 + 与基线 spec/DESIGN 一致）+ **人工视觉核验**（用户起服，核对贯通/缩进/淡背景/多选强背景/变灰/`?at=` 叠加）+ doc-sync（DESIGN「活的架构现状」+ ui-v4 DESIGN/TODO + 本 spec 状态注解）+ 细粒度提交。

每阶段 typecheck 绿 + 对应测试，subagent review 后提交。

### 低成本后续增强（已记，不阻塞）
- hover 色带 → tooltip 会话合计（复用 `laneSummary` / `querySessionSummaries`）。
- 右侧 minimap rail（会话纵向跨度）。
- 选择态提升到 URL（刷新 / 分享保留）。
- 「全选可见会话」/「反选」批量操作。

---

## 9. 与既有页面的分工（避免重复）

| 页面 | 时序 | 聚合 | 本特性关系 |
|---|---|---|---|
| **Requests（本特性增强后）** | 全局倒序**保留** | 色带 + 默认淡背景 + 多选对比高亮 | 就地叠加，不改引擎 |
| Sessions | 丢全局（每会话一行） | 完全折叠数字合计 | 数字合计归属地，本期不重复 |
| Session 详情 | 组内 | 按 agent 分泳道 + `laneSummary` | main/subagent 泳道归属地；本特性在主列表用「缩进+色深」给轻量对应 |

三者形成「宏观合计（Sessions）→ 时序对比（Requests）→ 单会话泳道（详情）」的递进，各司其职、不重叠。

---

## 10. 待确认边界（H 记号）

- **H1 无 sessionId 行的 `f`**：无会话行按 `f` no-op（不建立「聚焦一堆不相关无会话行」的伪会话）。已定。
- **H2 淡背景做分组底纹、身份靠亮色带**：配色 validator 实测 8% 淡 tint 低于 JND（相邻同族会话不可分），故**淡 tint 定位为分组底纹、会话身份主要由 10px 亮色带 + session id 承担**；各套 faintAlpha 已按实测 JND 地板设（12–16%）。落地人工核验时确认不撞 `row-anomaly` warn 底、不刺眼。
- **H3 强 tint 与 status 信号色**：强背景（18–20%）下 status 列 `●` 信号色（ok 绿/fail 红）须仍清晰——核验时确认；必要时该套 strongAlpha 封顶更低。
- **H4 CVD 校验为附带保障、非约束**：用户确认**本页面用户群无色盲**，故 tritan/CVD 地板不构成设计约束。四套色板对**正常视觉**两两清晰可分（亮色带 normal ΔE 12–17）。默认 `terminal-neon` 因正常视觉分离度也最佳而保留。CVD 校验结论仅作附带记录（若未来用户群变化可回看）。

---

## 11. 审查纪要（两轮对抗 subagent，record-not-adopted / 已纳入）

两个独立 subagent（React 实现可行性 + 对抗 spec 审查）**独立亲读代码**，结论高度收敛，均已纳入本版：

| 审查发现 | 严重度 | 处置 |
|---|---|---|
| ColumnDef.cell 拿不到 Virtuoso RowContext/runs（取数路径错） | HIGH 证伪 | **纳入**：改 itemContent 首列特判用第三参 context（§4） |
| 统一 td `px-2 py-1 overflow-hidden` + `w-[10px]` box-border + 行间 border 使色块贯通不可行 | HIGH 证伪 | **纳入**：session td 破例 `p-0 relative` + 绝对定位色块 `-bottom-px` 桥接（§4 渲染节） |
| 全局 `border-radius:0!important` 吞段帽圆角 | HIGH 漏项 | **纳入**：theme.css 加 `.session-cap-*` 破例类 + `!important`（§4） |
| subagent 缩进三处自相矛盾、table-fixed 下整行缩进不可行 | MED 矛盾 | **纳入**：改为 status 列内容左 padding（真内容缩进、列宽不变，§4） |
| dim 叠 muted 文字类与 selection 文字色 className 冲突 | MED 存疑 | **纳入**：dim 只用 `opacity`（§3） |
| jsdom 无 layout，贯通/缩进视觉风险测不到 | MED 存疑 | **纳入**：§7 显式标注 + §8 加人工视觉核验门 |
| 分页前沿行 isRunEnd 暂定、翻页自愈 | LOW | **纳入**：§4 一句说明，无需额外处理 |
| 键盘 `f`/Esc、border-l 与色列分层、字段就绪、可见性对账 | — 成立 | 无需改，确认健全 |
| 交互语义 / toggle / 正交 / H1 / 富数据流 | — 成立 | 设计健全，保留 |

**未采纳**：reviewer 提的 table `meta` 传 runs 方案（方案 A）——与 itemContent 特判（方案 B）二选一，选 B，因 session td 本就必须破例统一外壳，B 更自洽、不引入 meta 反应式的额外心智负担。
