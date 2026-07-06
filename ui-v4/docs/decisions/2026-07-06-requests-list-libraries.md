# ADR: Requests 列表页的库选型（react-virtuoso + react-day-picker + TanStack Table）

- **状态**：**Accepted**
- **日期**：2026-07-06
- **相关**：[headless-component-stack ADR](2026-07-05-headless-component-stack.md)（本 ADR **supersede 其「虚拟滚动 = TanStack Virtual」一行** + **解决其挂起的「date-picker 待评估」**）、spec [2026-07-06-ui-v4-requests-list-enhancement.md](../spec/2026-07-06-ui-v4-requests-list-enhancement.md)、缺口来源 [TODO.md「Activity」节](../TODO.md)、user-rule `battle-tested-over-hand-rolled`

## 背景

Requests 列表页要从「Live 泳道 + tail/缓冲 + 富行 + `?at=` 定位」全面增强到**功能对等且超越**老 `ui/` Activity：补齐七维筛选（search / model / endpoint / state / pid / sessionId / 时间范围）+ URL 深链 + 错误/空态 + paused 行内更新 + 键盘导航 + 清空历史（见 spec）。

headless-component-stack ADR 已定栈方向，并**点名** Requests：数据表 = TanStack Table（*"作 Requests 列表/筛选地基"*）、虚拟滚动 = TanStack Virtual（*"长 History 列表触发时引"*）、date-picker *"待评估 react-aria useDatePicker / react-day-picker"*。全面增强正是这些「触发点」。本 ADR 把三处具体库选型定死。

关键约束：**筛选/分页是 server-side**（查询参数打到 `/history/api/entries` + 游标分页），不是客户端。这直接影响 TanStack Table 的角色（其客户端 filter/sort 引擎在此**被绕过**）。

## 定夺

### 决策一：长 History 列表虚拟化 = **react-virtuoso**（非 TanStack Virtual）

本列表的形状是三合一：**tail 实时跟随**（新完成条目从顶部进）+ **无限往旧翻**（触底加载旧页）+ **`?at=` 定位**（深链滚动到任意条目并高亮）。这三样正是 [HistoryList.tsx](../../src/components/requests/HistoryList.tsx) 现在手搓的 scroll / locate / load-until-found 逻辑。

react-virtuoso 把这些作为一等能力**白送**：
- `endReached` → 触底加载旧页（替 `onScroll` 阈值判断 + 手动翻页）。
- `scrollToIndex({ index, align })` → `?at=` 定位（替 `findRow` 的 DOM `querySelector` + `scrollIntoView`；虚拟化后离屏行不在 DOM，DOM-query 定位**根本失效**，`scrollToIndex` 是虚拟列表的正解）。
- 变高行 + 窗口化 → 长列表性能（无限滚动会 append 到数千行）。
- `TableVirtuoso` → 与真实 `<table>` 语义 + TanStack Table 列模型组合（标准搭配）。

> **`firstItemIndex` 稳定 prepend 本期不采用**（record-not-adopted，勘误 M3）：本期 tail 揭示新条目沿用现 `invalidateQueries` **整页 refetch 首页**（见 spec §10.2），非增量头部插入，故 `firstItemIndex` 用不上。它是 Virtuoso 未来若把 tail 改为增量 prepend（不 invalidate）时的能力，届时再启用。此处不把它列作本期采用理由，避免与 spec「tail 语义不动」不自洽。

**诚实边界**（勘误一次口误）：Virtuoso 的 `followOutput` 是**底部追加**（chat 式）语义，本列表是**最新在顶、旧页往底**，方向相反，故 **`followOutput` 不用**。tail / buffer / paused 语义**仍留在 [list-store](../../src/stores/list-store.ts)**（那套 reducer 是对的，不删）。Virtuoso 在此的价值 = 窗口化 + `endReached` + `scrollToIndex` + 变高，**不是** tail 语义本身（`firstItemIndex` 稳定 prepend 本期不采用，见上方勘误框）。

为何不是 TanStack Virtual（ADR 原选）：TanStack Virtual 是**低阶窗口化原语**，上述 endReached / scrollToIndex / 稳定 prepend / 触底加载全要自己在其之上手接。对「只读、等高、无 tail/locate」的表它够用；对本列表的 tail-infinite-locate 三合一，Virtuoso 的高阶行为**净删**手写代码更多，长远可维护性更好（`battle-tested-over-hand-rolled` + `long-term-wins`）。这是对 ADR 该行的**有依据反转**，非未评估。

### 决策二：时间范围筛选 = **react-day-picker**

后端 `/history/api/entries` 支持 `from`/`to`（epoch ms）。Radix / TanStack 均无日期选择器。react-day-picker 轻、流行、headless 友好（自控 Terminal Amber 样式），弹在 filter bar 的 Radix `Popover` 里。解决 headless-stack ADR 挂起的 date-picker 项。

为何不是 react-aria `useDatePicker`：react-aria 已在 headless-stack ADR 经双 PoC 对照不采纳（bundle 4× + 单-vendor 优势在已选 Radix 前提下不成立）；只为一个日期选择器引入整个 react-aria 体系不划算。react-day-picker 是单点、按需。

### 决策三：Requests 列模型 = **TanStack Table**（列可见性；filter/sort 引擎不用）

富行现在是**手搓的固定像素宽 `<span>`**（[RequestRow.tsx](../../src/components/requests/RequestRow.tsx) 的 `w-[92px]` 等）——本质是张手写表。改用 TanStack Table `ColumnDef` + `VisibilityState`，得**列可见性开关**（与 Models 页 ColumnMenu 对齐、用户可切列），列定义结构化取代硬编码宽度。

**诚实边界**：因筛选/排序是 server-side，TanStack Table 的 `getFilteredRowModel` / `getSortedRowModel` / faceting **在此不用**，只用 `getCoreRowModel` + `VisibilityState`。它带来的净收益是**列可见性 + 结构化列定义**，不是排序/过滤引擎（那些是 server 的活）。faceting 也不需要：endpoint/state 是固定枚举，model/pid/sessionId 是自由文本/钻取，无需从已加载行推候选。这与 Models 页 ADR PoC 结论一致（渲染/列配置「平移非净删」，收益在能力而非删行数）。

## 后果

**正面**：三合一列表行为白送（Virtuoso）+ 列可见性白送（TanStack Table）+ 日期选择白送（react-day-picker）+ 净删手写 scroll/locate/翻页逻辑 + 与 Models 页列模型对齐。全对齐 `battle-tested-over-hand-rolled`。

**负面/成本（如实记录）**：
- 新增两个运行时依赖（react-virtuoso、react-day-picker）+ 启用已装的 @tanstack/react-table。三者皆 tree-shakeable。
- **bundle 增量**：由 `build:ui-v4` 前后对照实测、**写入提交信息**（headless-stack ADR 的门禁纪律）。
- Virtuoso 偏离 ADR 原「TanStack Virtual」——已在决策一给出有依据反转，并回写更新 headless-stack ADR 对应行。
- 每库仍自写 Terminal Amber 渲染层（headless 代价 = 视觉自控收益，同一枚硬币）。

## 未采纳（record-not-adopted）

1. **TanStack Virtual**（ADR 原选）——见决策一：低阶原语，tail-infinite-locate 三合一要手接，Virtuoso 白送更多。
2. **react-aria useDatePicker**——见决策二：只为日期选择引整个 react-aria 体系不划算，已在前置 ADR 不采纳。
3. **继续手搓固定宽富行 + 手写 scroll**——否：手写窗口化/定位/翻页在长列表反复踩坑，与 `long-term-wins` 冲突。
4. **cmdk 做 model 筛选 combobox（自动补全）**——本次不做（留给全局 Search 的 cmdk 落地阶段）；列表 model 筛选先用普通防抖 input，镜像老 `ui/` Activity。记入 spec「非目标」。

## 实施

随 spec [2026-07-06-ui-v4-requests-list-enhancement.md](../spec/2026-07-06-ui-v4-requests-list-enhancement.md) 落地。每次：门禁全绿（含 `build:ui-v4` 验 bundle 前后对照入提交信息 + `~backend` 纯）→ 细粒度提交 → subagent audit。
