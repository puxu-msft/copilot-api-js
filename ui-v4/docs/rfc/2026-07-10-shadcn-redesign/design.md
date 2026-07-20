# RFC: ui-v4 shadcn/ui 重设计迁移（v3）

- 状态: **Approved-for-planning（3 轮对抗 review 收敛：round3 零 FAIL、2 WARN 已就地收口——golden 仅预热、bun A′ 断言纳入 C2）**。v3 吸收 round2 3 FAIL + 8 WARN + 主会话 ground-truth 裁决；v2 吸收 round1 + 地基 PoC + 用户 OQ 决议。下一步：据本 RFC 派生 C0–C7 架子阶段实施 plan（subagent-driven）。
- 日期: 2026-07-10
- 派生自: ADR [../decisions/2026-07-10-ui-v4-shadcn-adoption.md](../decisions/2026-07-10-ui-v4-shadcn-adoption.md)（决策 1–11）
- 前置证据: PoC [../../../../exp/shadcn-tw4-poc/CONCLUSION.md](../../../../exp/shadcn-tw4-poc/CONCLUSION.md)（地基可行，F1 由 FAIL 降 WARN）、round1 review [design-review-2026-07-10-1.md](design-review-2026-07-10-1.md)（6 FAIL + 6 WARN）、round2 review [design-review-2026-07-10-2.md](design-review-2026-07-10-2.md)（3 FAIL + 8 WARN + 主会话 ground-truth 裁决：全 components 域 `var(--color)`=450、`VirtuosoMockContext` 零命中、`.toc-flash` 全局 amber 泄漏）、round3 收敛 review（0 FAIL；A4 三治分治抽样核实无 B 误划入 D、B3/B6 复核；2 WARN 已就地收口）
- 方法论: skill `large-refactor`（RFC-first + commit invariants + 过渡态显式无害 + golden 预捕获）

> **v2→v3 的根本变化**：round2 对抗 review 用 file:line 证伪了 v2 的三处承重主张——① **中性化 scope 被框死在 `detail/` 单目录（152），实测全 components 域 `var(--color)`=450**，Models/Sessions/Learned/Tools/Overview/Common 的 B 内容体 + A′ 列构建器同样耦合 amber，若不一并前置中性化会滑进逐页、破 INV-1「中性化全前置」；② **A′ 锚点错置**——`lib/model-columns.ts` 实测**零色**（纯 A，误归 A′），真带色的是 `components/models/model-table-columns.tsx`（10 `var(--color)` + 2 hex + import vendorColor，v2 漏分类）；③ **`VirtuosoMockContext` 不存在**（全仓零命中），真实基建是手写 `FakeTableVirtuoso` + `ResizeObserver` stub。v3 据实**撤回 v2「工作量下调」框架**（中性化面 = detail 152、全域 450，不小于 round1），并修正测试策略、golden flaky、C4 泄漏面、C7 过度抽象、INV-FIDELITY-1 强制手段五处。

## 1. 问题陈述

ui-v4 当前是定制「工业风 Terminal Amber」体系（`src/styles/theme.css`：暖近黑底、琥珀主色、IBM Plex Mono、深色 only、全局 `*{border-radius:0!important}`）。ADR 决策把它切换到 **shadcn/ui（new-york，锐角，色板 preset 化）** + 一批布局改动（默认页 /overview、LiveDock 全局、详情抽屉共用、列表-详情形态 A、详情内竖排→水平 tabs、NavRail 加宽加图标），改造期以**新旧双呈现树 + 全局 `designVersion` 开关**并存对照，完工后拆除旧树。

**round1 + round2 review 揭示的真问题（决定 v3 架构）**：设计不是「只在 shell」的一层，而是**三条贯穿性耦合，且贯穿全部页面域（非仅 detail/）**——

1. **lib 层 + 组件层伪 design-agnostic**：`lib/request-columns.ts` 返回带 amber class 的 `ReactNode`、`lib/vendor-color.ts` 硬编码 hex、`lib/model-status.ts` 的 `colorVar` 引 `var(--color-*)`、**`components/models/model-table-columns.tsx` 同样是产色的列构建器**（10 `var(--color)` + 2 hex + import `vendorColor`，round2-A4 亲手核实、v2 漏）、`lib/highlight/amber-theme.ts` + `shiki.ts` 只有单一 amber 主题（新树里 CodeBlock 仍出 amber 高亮）。这些是「共享逻辑/构建器」但**设计耦合**，v1 归为「A 类零改动」是虚假的。**注意 `lib/model-columns.ts` 实测零色（纯列 key 定义，round2-A4 裁决），是 A 不是 A′**。
2. **内容体伪 design-agnostic，且遍布全域**：`detail/` 下 152 `var(--color-*)` + 29 六位 hex（ThinkingBlock / MessageBlock / toc 语义色映射）**只是最大一块**；`tools/JsonTreeView`(21)、`common/RawJsonView`(6)、`models/detail-tabs/*`(11) + `UnmatchedTelemetry`(7)、`learned/LearnedRow`+`StatusBadge`(15)、`sessions/SessionRow`+`AgentLane`(10)、`overview/StatCard`(4) 等 B 内容体同样含裸 `var(--color-*)`。v1/v2 只算 detail/ 是 ~3× 低估（round2-A4）。
3. **全局 amber 规则 `!important`，不止锐角**：`theme.css` `*{border-radius:0!important}`（`:29`）架空 shadcn `--radius`；**且 `.toc-flash{background:#2a2212}`（`:40`，由共享 `hooks/useAnchorScroll.ts` 施加于 B 段）、`.rdp-amber`（`:53`，day-picker 重映射）、两个 `@keyframes`（drawer-overlay-in / drawer-slide-in）同样是全局 amber 规则**，泄漏进 shadcn 共享 B（round2-B8）。PoC 构建产物实测锐角规则并存、前者压平后者。要让 shadcn 树出圆角 + 不出 amber 泄漏，必须把这一整族全局 amber 规则作用域化。

若不先做一个**覆盖全域的前置中性化阶段**（全域语义 token 中性化 + shiki 双主题 + 全局 amber 规则族作用域化 + `data-design` 属性落根），双树一挂：shadcn 树会渲染出 amber 内容 + 被压平的圆角 + toc-flash 暖底 → 被迫在「INV 宣布为红线」的 lib/内容体层返工。故 v3 把**全域中性化**立为架子先行的第一等公民。

**仍然成立的核心事实**：ui-v4 价值的大头在**逻辑 + 可视化渲染算法**（diff/SSE 累积/shiki 分词/内容解析），这些**经中性化后**与设计无关、两版共享；迁移**不复制**逻辑层与算法层。只有 shell/皮肤/布局/页面壳需要双份呈现树。

## 2. 修正后的组件分类（据 PoC + round1/round2 实测重划，五类）

v1 的三分类被实测推翻两处：**「不动」的 A/B 实含设计耦合**、**C 不是单份而是双份**（OQ-1）。round2 进一步修正 v2：**A′ 锚点错置（model-columns→model-table-columns）**、**B 内容体遍布全域（非仅 detail/）**。v3 重划为五类：

| 类别 | 目录/文件（实测锚点） | 迁移处理 |
|---|---|---|
| **A. 纯数据/算法（真 design-agnostic，不动）** | `hooks/*` `stores/*`（含 live-store/list-store）`types/*` `lib/api.ts` `lib/content/*` `lib/diff/*` `lib/format.ts` `lib/json-tools.ts` `lib/learned.ts` `lib/request-filters.ts` `lib/model-filters.ts` `lib/model-telemetry.ts` `lib/ws-client.ts` `lib/query.ts`、**`lib/model-columns.ts`（round2-A4 实测零色，纯列 key 定义 → 归 A，v2 误归 A′ 已撤）**、`lib/live-summary.ts`（实测零色） | 返回数据/纯计算，无 JSX、无颜色字面量。**红线：任何 commit 不得在此引入 `designVersion` 分支或颜色字面量。** |
| **A′. 需中性化的列/单元构建器（产 JSX/颜色，前置阶段一次性中性化）** | **lib**：`lib/request-columns.ts`（返回带 amber class 的 `ReactNode`，12 处 `var(--color-*)`/hex）、`lib/vendor-color.ts`（6 处 hex）、`lib/model-status.ts`（`colorVar: var(--color-*)`，3 处）、`lib/highlight/amber-theme.ts` + `lib/highlight/shiki.ts`（单一 `AMBER_THEME`，`codeToHast` 走 `THEME_NAME`）。**components 内的列构建器**：`components/models/model-table-columns.tsx`（**round2-A4 新锚点**：10 `var(--color-*)` + 2 hex + `import { vendorColor }`，两树 Table 共用的列定义，v2 漏分类） | **不是「不动」，是「中性化一次、两版共用」**：颜色字面量 → 中性语义 token（`--content-*`/`--signal-*`/`--surface-*`，见 §3），两 preset 各自映射；shiki 单主题 → 双主题按 preset 切。中性化后**升格为 A**。此为架子先行前置阶段的核心工作量之一（C2）。 |
| **B. 可视化内容体（中性化后两版共用 — 遍布全域，非仅 detail/）** | **detail/（最大块）**：`detail/blocks/*` `detail/diff/*` `detail/segments/*` `detail/ContentRenderer` `detail/CodeBlock` `detail/LineNumberedText` `detail/MessageBlock` `detail/ConversationView` `detail/DiagnosticBar` `detail/toc/DetailTocTree`（152 `var(--color)` + 29 hex）。**其它域 B 内容体（round2-A4 补齐）**：`common/RawJsonView`(6)、`tools/JsonTreeView`(21)、`models/detail-tabs/{DetailParts,TelemetryTab,OverviewTab}`(11) + `models/UnmatchedTelemetry`(7)、`learned/{LearnedRow,StatusBadge}`(15)、`sessions/{SessionRow,AgentLane}`(10)、`overview/StatCard`(4)、`requests/RequestRow`(6，行内容体) | 内容渲染算法与设计无关，但**当前跨全域含裸 `var(--color-*)`**。前置中性化阶段（C3）把这些改为中性语义 token（结构 class 保留），之后两版共用。**红线（中性化后）：零新 amber 硬编码、零 `designVersion` 分支。** 内嵌交互 chrome（小按钮/modal 触发）走「B↔C 边界」（裸中性元素或设计无关适配器），使同一 B 文件服务两树。 |
| **C. 皮肤 primitive（过渡期双份 — OQ-1 冻结旧树）** | **新**：`components/ui/*`（shadcn button/input/select/dialog/tabs/badge/slider/…）。**旧（冻结）**：`components/shared/Modal` `shared/FilterSelect` `shared/RangeSlider` 等手写 Radix 封装（`components/shared/` 实测 23 处 `var(--color)`，随冻结保持 amber、Z1 整体删除）。 | **双份**（撤销 v1「C 单份 token 驱动」，见 W1）：OQ-1 定旧树用旧皮肤冻结，故过渡期 `shared/*`（legacy 树）与 `components/ui/*`（shadcn 树）并存，确认 ADR 决策 9「组件皮肤双份」原文正确。收尾随 legacy 树整体删除 `shared/*`。 |
| **D. 双份呈现树 shell/布局/页面壳（由 `designVersion` 选挂 — 逐页 fork，legacy 冻结）** | `shell/NavRail`（加宽+lucide 图标）`shell/TopBar` + shell 布局包裹、各页壳与 chrome（`requests/{RequestsListPage,RequestDetailPage,LiveDock,LiveGroup,HistoryList,RequestsColumnMenu,RequestFilterChips,RequestsFilterBar,DateRangePopover}`、`overview/OverviewPage`、`models/{ModelsPage,ModelDetail,ModelsTable,ModelsFilterBar,ModelsColumnMenu,ModelDetailSubRail}`、`sessions/*Page`、`config/ConfigPage`、`learned/LearnedPage`、`tools/JsonToolsPage`、`shell/{RouteError,NotBuiltYet}`）、`detail/DetailPanel`+`detail/DetailSubRail`（竖排→水平 tabs，决策 10）、`detail/toc/TocSidebar`、**新** 水平 Tabs 内容布局 primitive（见 C7，A2 收窄后） | 由 `designVersion` **互斥挂载**一棵。新树 import 中性化后的 B 内容 + 新 C primitive；**旧树保持现状冻结**（其 `var(--color)` 随 legacy 一起冻结，不进前置中性化，Z1 删除）。D-shell 的 amber 是**逐页 fork 点内的 legacy 侧**，新 shadcn 侧直接用 shadcn/中性 token 重写——故 D-shell 色**不进 C2/C3 前置中性化**，是 P1–P8 逐页工作。 |

**全域 `var(--color)` scope 分解（round2-A4 ground-truth 450，v3 据实全量给出并分治）**：

| 域 | 计数 | 治理归属 |
|---|---|---|
| `detail/` | 152 | **B 前置中性化（C3）** |
| `requests/` | 88 | 其中 `RequestRow`(6)=**B（C3）**；`LiveDock`(19)/`LiveGroup`(18)/`HistoryList`(14)/`RequestsColumnMenu`(10)/`RequestFilterChips`(8)/`DateRangePopover`(7)/`RequestsFilterBar`(4)/`RequestDetailPage`(2)=**D-shell（逐页 P2/P3，legacy 冻结）** |
| `models/` | 85 | `model-table-columns`(10+2hex)=**A′（C2）**；`detail-tabs/*`(11)+`UnmatchedTelemetry`(7)=**B（C3）**；`ModelsFilterBar`(25)/`ModelsColumnMenu`(10)/`ModelDetail`(9)/`ModelsPage`(6)/`ModelsTable`(4)/`ModelDetailSubRail`(3)=**D-shell（P4）** |
| `tools/` | 32 | `JsonTreeView`(21)=**B（C3）**；`JsonToolsPage`(11)=**D-shell（P8）** |
| `learned/` | 27 | `LearnedRow`(12)+`StatusBadge`(3)=**B（C3）**；`LearnedPage`(12)=**D-shell（P7）** |
| `shared/` | 23 | **C legacy 皮肤，冻结（不中性化，Z1 删）** |
| `sessions/` | 14 | `SessionRow`(6)+`AgentLane`(4)=**B（C3）**；`SessionsPage`(2)+`SessionDetailPage`(2)=**D-shell（P5）** |
| `shell/` | 12 | `TopBar`(5)/`RouteError`(3)/`NotBuiltYet`(2)/`NavRail`(2)=**D-shell chrome（C6/P*）** |
| `config/` | 7 | `ConfigPage`(7)=**D-shell（P6）** |
| `common/` | 6 | `RawJsonView`(6)=**B（C3）** |
| `overview/` | 4 | `StatCard`(4)=**B（C3）** |
| **合计** | **450** | + lib A′ 21（request-columns 12/vendor-color 6/model-status 3，不在 components 域计数内） |

> **v3 对 round2-A4 的精化（richest-data-flow，非缩范围）**：「全域 450 须中性化」这一断言按治理方式**分三治**——**B 内容体 + A′ 构建器（跨全域）必须 C2/C3 前置中性化**（这是 INV-1「中性化全前置」真正绑定的子集，约 detail 152 + 其它域 B ~80 + A′ 21+12）；**D-shell 色是逐页 fork 点内 legacy 侧，随 legacy 冻结、新 shadcn 侧重写**（P1–P8 本就要做，不额外前置）；**`shared/` 23 是冻结皮肤**（Z1 删）。三者工作量都不砍——D-shell 逐页重写是 P1–P8 的完整内容，只是**不属「前置中性化」阶段**。**INV-1 关键修正**：「中性化全前置」必须覆盖**所有域的 B/A′**（models/sessions/learned/tools/overview/common，非仅 detail/），否则该不变量对 Models 等不成立——B 内容体若滑进逐页 P4，会在逐页里被迫中性化、破坏「架子先行、逐页只填壳」的结构。

**关键边界澄清（易错点）**：

- **A′ 是一等类别**，专收产色的列/单元构建器（lib + `model-table-columns.tsx`）。中性化是**前置阶段做一次**、两树共享结果，不进逐页 commit。
- **`DetailSubRail`/`ModelDetailSubRail` + `DetailPanel`/`ModelDetail` 属 D**，但它们渲染的 **segment 内容体属 B**（中性化后不动）。迁移改 tab 容器与朝向，不改 segment 内容。
- **W3 遗漏组件归位**：`DiagnosticBar`/`MessageBlock`/`ConversationView`/`toc/DetailTocTree` → **B**；`toc/TocSidebar` → **D**；`ToolJumpButton`/`JsonModalButton`/`ExportButton`/`BlockJsonModal` → **B 内容旁交互 chrome**，按「B↔C 边界」处理。
- **B↔C 边界（round1 R2 + round2 A3 根治）**：B 内容体若内嵌交互原语，为「同一文件服务两树」，**不得硬编码走哪套 C primitive**。两条允许路径：①用中性 token 的裸 `<button>`/`<span>`（轻交互，`ExportButton` 走此路顺畅，round2-A3 证实）；②需 Radix 行为（focus-trap/portal）时经 design-version-agnostic 适配器取当前树 primitive。**round2-A3 实测：B 目录对 `shared/*` 直接 import 仅 1 处 = `BlockJsonModal.tsx:2` import `shared/Modal`**——方向对，但**成本非「小」**：`shared/Modal` 有 `title`/`onClose`/`data-testid=modal-backdrop` 单一契约（`Modal.tsx:34`），shadcn `Dialog` 是 slot 组合式无单一 title/testid，适配器须**规范化两套 Dialog API + 保住测试契约**，是一等硬工作量（见 §8.2、附表 A3）。

## 3. 主题 token 架构（两 preset + 中性化语义 token 层 + shiki 双主题）

三层，自下而上：

**(1) shadcn CSS 变量层（PoC 已落地形态）**：`shadcn init -b radix -t vite` 注入标准 shadcn token（`--background`/`--foreground`/`--primary`/`--border`/`--radius`/`--muted`/…）+ `@theme inline{}`（PoC 证实与现有 `@theme{}` 共存）+ `tw-animate-css`（v4 替代 `tailwindcss-animate`，CLI 自动处理）。

**(2) 中性化语义 token 层（架子先行要建的通用可扩展层，A′/B 中性化的落点）**：在 shadcn token 之上定义**设计中性的语义 token**，命名反映**语义角色**而非颜色。**round2-B5 修正——语义槽不止 `--content-*` 一族，须建更细的 token 家族，否则同角色跨文件多 shade 无处安放**：

- **内容语义** `--content-*`：`--content-add`/`--content-del`/`--content-thinking`/`--content-tool`/`--content-system`/`--content-muted` 等。**注意同角色多 shade（round2-B5 实测）**：thinking 至少 3 紫（`ThinkingBlock` `#a89ac0`/`#6a5a8a` + `DetailTocTree` `#9a8ad0`）、tool 至少 2 绿——须为每 shade 建独立 token（如 `--content-thinking` / `--content-thinking-dim` / `--content-thinking-accent`），不能一角色一 token 硬塞。
- **信号语义** `--signal-*`：`--signal-ok`/`--signal-fail`/`--signal-warn`/`--signal-live`（覆盖 request-columns / model-status / model-table-columns）。
- **厂商语义** `--vendor-*`：`--vendor-anthropic`/`--vendor-openai`/`--vendor-google`/`--vendor-other`（覆盖 vendor-color.ts + model-table-columns 的 `vendorColor`）。
- **表面/近黑语义** `--surface-*` + scale 族（**round2-B5 新增**）：实测约 29 个 `surface`/`near-black` hex（`#1a1820`/`#1e1e24`/`#100e0b`…）**无 `--content-*`/`--signal-*` 可归**——它们是层次背景/边框近黑阶。须建 `--surface-base`/`--surface-raised`/`--surface-overlay`/`--surface-sunken` 等 scale 族 + 每 shade 独立 token。**此族是 C3 工作量被低估的主因（>「齐整 --content-*」）**。

每个语义 token 由**每个 preset 各自映射**到具体色值：
- `amber` preset：复现 Terminal Amber（`--radius:0`、琥珀阶、mono、现有 `--color-*` 的等价值）。
- `neutral` preset（**OQ-2 新默认 = 中性灰 zinc/slate + 蓝白强调**）：覆盖 shadcn init 的默认 oklch。
- **可扩展**：新增第三 preset = 加一组映射，零结构改动。

现有 B/A′ 消费的 `--color-*`（amber 命名空间）与 shadcn `--primary` 不同名——**双向桥接在本层完成**（`--color-*` 别名指向语义 token，或语义 token 别名到 shadcn token），PoC WARN-2 的处理项即此。

**(3) shiki 双主题**：`highlight/` 现只 `codeToHast(code, { theme: THEME_NAME })`（`shiki.ts:180`，单 `AMBER_THEME`）。中性化：加一个中性/蓝白语法主题，`theme` 参数**按当前 preset 选**（`amber` → terminal-amber，`neutral` → 中性主题）。这样新树 CodeBlock 不再出 amber 高亮。**注意 shiki baked hex 对 amber-legacy preset 安全**（round2-B4：`shiki.ts` baked hex 随 `THEME_NAME` 走，amber-legacy 下等价）。

**`designVersion` vs `colorPreset` 的正交性 + 僵尸字段处置（W6）**：
- `designVersion`（`amber-legacy` | `shadcn`）是**过渡脚手架**（选哪棵呈现树），收尾删除。
- `colorPreset`（`amber` | `neutral` | …）是**永久**色板层。收尾后 Amber 作为永久 preset 保留、`designVersion` 移除。
- 过渡期约束：`amber-legacy` 树走作用域化的 amber 样式（冻结，不受 `colorPreset` 影响）；`shadcn` 树默认 `neutral` preset、preset 可独立切换。
- **僵尸 `theme:light/dark/system` 处置**：`ui-store.theme` + `setTheme` + `TopBar` 的 `◐ {theme}` 按钮是死代码（实测 TopBar 外零消费者，round2 复核证实）。**v3 地基 commit 直接删除 `theme`/`setTheme`/`ThemeMode` + TopBar 按钮**，代之以 `designVersion`（过渡）+ `colorPreset`（永久），避免三态混淆。

## 4. Cutover 计划（按 commit，架子先行）

**架子先行硬约束（OQ-3 追加）落实**：通用可扩展架子（地基 → 全域中性化 → 双树切换机制 → 详情容器 → C primitives）**必须在任何逐页 commit 之前完成且做成可扩展**；逐页只在稳定架子上填壳，不是每页各搭一套。下方每个「架子 commit」标注**可扩展性**。

### 架子先行阶段（逐页之前，全部完成）

- **C0 · 地基 + `data-design` 落根**（PoC 已验证路径）：`shadcn init -b radix -t vite`（`components.json` new-york）+ 装 lucide-react + `cn`/`cva` util + shadcn CSS 变量层 + `tw-animate-css`。ui-store **删僵尸 `theme`**、加 `designVersion`（默认 `amber-legacy`）+ `colorPreset`（默认 `amber`）。**round2-B7 修正——本 commit 同时在 DOM 根写 `data-design=amber-legacy` 属性**（据 `designVersion` 响应式设置于 `<html>`/根容器），**与 C4 作用域化的属性落点原子对齐**（避免 C4→C6 窗口独苗 legacy 丢全局锐角、圆角回弹破 INV-3）。**此 commit 后视觉零变化**。
  - **可扩展性**：token 变量层 + `components.json` + `data-design` 根属性就位，后续 `shadcn add X` 零配置接入。
- **C1 · 中性化语义 token 层 + 两 preset**（§3 第 2 层）：定义 `--content-*`（含同角色多 shade 独立 token）/`--signal-*`/`--vendor-*`/**`--surface-*` scale 族**（round2-B5）+ `amber`/`neutral` 两 preset 映射 + `--color-*` ↔ 语义 token 桥接。**此 commit 只加层、不改消费者**，视觉仍零变化。
  - **可扩展性**：新 preset = 加一组映射，零结构改动。
- **C2 · A′ 中性化**：`lib/request-columns` / `lib/vendor-color` / `lib/model-status` / **`components/models/model-table-columns.tsx`**（round2-A4 新锚点）的颜色字面量 → 语义 token；`lib/highlight/shiki` 单主题 → 双主题按 `colorPreset` 切（§3 第 3 层）。**amber-legacy 下语义 token 解析回等价 amber 值 → 像素等价（INV-3）**。（`lib/model-columns.ts` 零色，不在本 commit。）
  - **可扩展性**：A′ 升格为 A，任何树消费同一份中性化构建器。
- **C3 · B 内容体中性化（全域，非仅 detail/）**：**round2-A4 核心修正——中性化清单扩到所有域的 B 内容体**：`detail/`（152+29hex）+ `tools/JsonTreeView`(21) + `common/RawJsonView`(6) + `models/detail-tabs/*`(11) + `models/UnmatchedTelemetry`(7) + `learned/{LearnedRow,StatusBadge}`(15) + `sessions/{SessionRow,AgentLane}`(10) + `overview/StatCard`(4) + `requests/RequestRow`(6) → 中性语义 token（含 `--surface-*` 族）；B↔C 边界解耦（裸中性元素或适配器，含 `BlockJsonModal` 的 Dialog API 归一，见 §8.2）。**grep 守卫扩到全部 B 目录零 amber 硬编码**（不止 detail/）。**amber-legacy 像素等价**。
  - **可扩展性**：全域 B 内容体自此 design-agnostic，新增 preset/新树免改内容体；INV-1「中性化全前置」对所有域成立。
- **C4 · 全局 amber 规则族审计与作用域化**（round1 F6 + round2-B8 扩范围 + PoC WARN-1）：**不止锐角**——`theme.css` 全局 amber 规则**整族**作用域化到 `[data-design=amber-legacy]`：① `*{border-radius:0!important}`（`:29`）；② `.livedock-island` 2px 例外（`:32`）；③ **`.toc-flash{background:#2a2212}`（`:40`，由共享 `useAnchorScroll` 施加于 B 段、泄漏进 shadcn 共享 B，round2-B8）**；④ `.rdp-amber`（`:53`，day-picker 重映射）；⑤ 两个 `@keyframes`（drawer-overlay-in / drawer-slide-in）按需归属。`data-design` 属性已在 C0 落根（B7 原子性）。shadcn 树自此按 `--radius` token 出圆角/锐角、不出 toc-flash 暖底。**amber-legacy 树像素等价**。
  - **可扩展性**：全局 amber 规则不再污染新树，preset 完全掌控圆角 + 瞬态高亮。
- **C5 · C primitives 落地**：`components/ui/*`（button/input/select/dialog/tabs/badge/slider/…）映射现有 `shared/*` 封装（PoC 已证 dialog/tabs/button 跑通）。旧 `shared/*` **不动**（冻结，双份）。
  - **可扩展性**：新页直接 import `components/ui/*`，无需再造原语。
- **C6 · 双树切换机制**（切换作用点见 §5，本阶段架构核心）：AppShell 拆出**常驻 L0**（`useWs`+`useLiveRequests`+`LiveDock` 挂载点，不 fork）；**round2-A1 修正——`designVersion` 读取下沉到 AppShell 子组件（结构隔离，非纪律）**：持 hooks 的 AppShell 体**根本不订阅 `designVersion`**，chrome/dock 的 `designVersion` 读取放在 L0 之下的子组件里，从结构上杜绝「给 useWs 加非空 deps / 把 hook 挪到 designVersion 分支后」的回归（见 §5b INV-FIDELITY-1）。shell chrome（NavRail/TopBar/布局）按 `designVersion` 互斥挂载；LiveDock 呈现层按 `designVersion` fork（订阅常驻不受影响）。新 chrome 加 `designVersion` 切换按钮（替代已删的 theme 按钮）。INV-2/INV-3 生效。**shadcn shell 先是最小骨架**（加宽 NavRail + 图标 + TopBar + Outlet）。
  - **可扩展性**：切换在页元素/chrome/dock 三 fork 点，新页接入只需在其页元素加同构 fork，无新脚手架。
- **C7 · 水平 Tabs 内容布局 primitive 抽取**（round2-A2 收窄，排在 Requests/Models 两页之前）：**round2-A2 修正——撤销 v2「公共详情容器 DetailContainer」的过度抽象**。实测 `DetailPanel`（内联整页、`radix-ui` Tabs、无 Dialog）vs `ModelDetail`（Radix `Dialog`+`Portal`+`Overlay`+resize+animate+focus-trap，`ModelDetail.tsx:87-117`）**交互模型迥异**——「抽屉/面板容器」归并恰好塞进两者**唯一不重叠**的容器 chrome，会把模式开关泄漏进容器。**唯一真共享 = 竖→横 Tabs 布局**。故 C7 只抽「**水平 Tabs 内容布局 primitive**」（shadcn `Tabs` horizontal + 段内容槽），供 shadcn Requests（形态 A 整页）与 shadcn Models（抽屉）各自嵌入；**抽屉-chrome 与整页-chrome 各自实现，不归并成模式开关容器**。`legacy` 的 `DetailPanel`/`ModelDetail` 冻结不动（OQ-1）。
  - **可扩展性**：未来 peek（backlog 形态 C）复用同一水平 Tabs 布局 primitive；抽屉/整页 chrome 各自演进不互相牵制。

### 逐页阶段（架子稳定后，天然可并行 — 但 Requests/Models 依赖 C7）

- **P1 · Overview**（+默认页 `/requests` → `/overview`，决策 6）：shadcn OverviewPage 壳，import 中性化 B 内容（`StatCard` 已在 C3 中性化）。
- **P2 · Requests**（依赖 C7）：列表 + 形态 A 整页详情 + prev/next 快捷键 + `?at=id` 返回定位（决策 5）+ LiveDock 呈现层 shadcn 化（决策 7，**结构已在 AppShell，仅样式**，见 W2）。D-shell chrome（LiveDock/LiveGroup/HistoryList/filter/column-menu）新 shadcn 侧重写，legacy 冻结。
- **P3 · Requests 详情 DetailPanel**（决策 10）：竖排 sub-rail → 顶部水平 Tabs（嵌 C7 primitive）；7 段横排。segment 内容体（B）不动。
- **P4 · Models**（依赖 C7）：详情抽屉嵌 C7 水平 Tabs primitive（抽屉 chrome 各自实现）；ModelDetailSubRail 竖→横；D-shell（ModelsFilterBar/ColumnMenu/Table/Page）新 shadcn 侧重写。detail-tabs/model-table-columns 已在 C2/C3 中性化。
- **P5 · Sessions** / **P6 · Config** / **P7 · Learned** / **P8 · Tools**：各页壳 shadcn 化，import 中性化 B 内容 + C primitive；各域 D-shell（*Page/*FilterBar 等）新 shadcn 侧重写、legacy 冻结。

### 收尾阶段

- **Z1 · 收尾拆除**（触发条件 OQ-4 待定，不阻塞前序）：新树确认完整后，删旧呈现树（D legacy 壳 + C `shared/*` 的 23 处 amber）+ 移除 `designVersion` 开关与 `[data-design=amber-legacy]` 作用域 + Amber 降为永久 `colorPreset` + 更新 DESIGN.md「活的架构现状」/§2/§8 + whole-domain audit + 对抗 subagent review。

## 5. 切换作用点（round1 F2 的正解 — v2 亲手核实源码后定，round2-A1 强化）

**实测约束（读源码确认）**：
- `main.tsx:16` 单 `<RouterProvider router={router}>`；`App.tsx:20` 单例模块级 `createHashRouter`，`AppShell` 为根 `element`，页面经**单个 `<Outlet/>`** 渲染（`AppShell.tsx:26`）。
- `AppShell` 是**常驻宿主**：`useWs`（`AppShell.tsx:14`）+ `useLiveRequests`（`:19`，socket 打开的**一次性 `connected` 快照**只派发给当时已注册的订阅者，故必须常驻）+ `LiveDock` 挂载（`:31`，决策 7 结构已落地）。
- **`useWs` effect deps 实测 `[]`（`useWs.ts:29`）**——切 chrome 无害正是因为此 effect 不依赖任何随 `designVersion` 变的值（round2-A1 核实）。

**为何 v1 的「AppShell 按 designVersion 换 shell」是错的（F2）**：AppShell 换 chrome 换不到 `<Outlet/>` 里的页面壳（D 类主体），页面元素由 router 路由定义钉死。

**为何「换两套 router」也不可取（并入 W4）**：顶层 swap `RouterProvider` 的 `router` 会**重新挂载 AppShell → 丢失一次性 `connected` 快照 + 卸载常驻订阅**，重演「只显示切换后新请求」的历史 bug。

**切换作用点：单 router 树不变，在常驻 AppShell 之下设三个 fork 点**——

```
main.tsx  RouterProvider（单 router，不 fork）
  └ QueryClientProvider（resident，react-query 缓存跨切换存活）
    └ App router（单 createHashRouter，不 fork）
      └ AppShell L0（常驻，持 useWs/useLiveRequests，永不因 designVersion 重挂 —— 本体不订阅 designVersion）
         ├ useWs / useLiveRequests   ← 一次性快照 + 常驻订阅（写 zustand live-store），effect deps=[]
         ├ [fork A] shell chrome     ← L0 子组件读 designVersion，NavRail/TopBar/布局 互斥挂载
         ├ <Outlet/>
         │   └ [fork B] 页元素        ← 每个 RoutePage 内部按 designVersion 互斥挂载 legacy/shadcn 页壳
         └ [fork C] LiveDock 呈现层   ← L0 子组件读 designVersion fork（读同一常驻 live-store，切换不丢数据）
```

- **round2-A1 结构隔离**：三 fork 点的 `designVersion` 读取全部**下沉到 L0 之下的子组件**——持 `useWs`/`useLiveRequests` 的 AppShell 本体**不订阅 `designVersion`**，故切换绝无可能触发 L0 重渲染/重挂 hook。这是**结构强制 > 纪律**（v2 仅靠「别把开关放 L0 之上」的纪律，round2-A1 指出守卫只断挂载身份、断不住「给 useWs 加非空 deps」的回归）。
- **INV-2（互斥挂载）下沉到三 fork 点**：chrome、每个页元素、LiveDock 呈现层各自条件渲染只挂一棵，绝不双挂。router 保持单树。
- 切换 `designVersion` 是 store 变更（非导航），URL/route 不变 → react-router 保持同一路由 → 同一页元素重渲染切 fork → legacy 子树卸载、shadcn 子树挂载。

## 5b. 切换保真不变量（round1 W4 + round2-A1 强化）

- **INV-FIDELITY-1（常驻不重挂）**：`designVersion` 切换**绝不**重挂 AppShell L0（`useWs`/`useLiveRequests`/live-store 订阅）。**强制手段（round2-A1 升级）**：不再仅靠「`designVersion` 永不 gate AppShell 自身」的纪律，而是**结构隔离**——`designVersion` 读取只存在于 L0 之下的 chrome/dock/页元素子组件，L0 本体源码里零 `designVersion` 引用。→ 守卫测试断言：① fork 点在 L0 之下；② **`useWs` effect deps 保持为空（行为回归：快照到达后切换 designVersion，在飞请求仍在 live-store、订阅未断）**。
- **切换保留**（跨切换存活）：WS 连接 + 一次性 `connected` 快照、live-store 在飞请求、react-query 缓存（QueryClientProvider 在 router 之上常驻）、当前 route/URL。
- **切换重置（可接受、页局部）**：per-page 滚动位置、virtuoso 窗口偏移、页内瞬时 UI 态（展开菜单、当前 detail segment tab）。这些页局部态在切换页壳时按设计卸载归零，**过渡期开关不值得为其做持久化**（OQ-4 收尾即删）；若后续用户反馈需保留，再评估（记为潜在需求，不阻塞）。

## 6. Commit invariants（修正后）

- **INV-1**：**A 类（纯数据/算法）+ 中性化后的 A′/B** 在任何 commit **零 `designVersion` 分支、零新颜色字面量**（颜色只经语义 token）。中性化本身是**前置架子 commit（C2/C3）一次性完成**、**覆盖所有页面域的 B/A′**（round2-A4：非仅 detail/，含 models/sessions/learned/tools/overview/common）；C2/C3 之后此红线对全域生效。
- **INV-2**：任一 commit，`designVersion` 在 **chrome / 每个页元素 / LiveDock 呈现层**三 fork 点各**互斥挂载**一棵（绝不双挂同时渲染）。
- **INV-3**：从 C6 引入开关起，每个 commit **两版都可运行且自洽**——`amber-legacy` 保持像素等价（C2/C3/C4 的中性化 + 全局 amber 规则族作用域化对 legacy 必须解析回等价 amber 值 / 加 `data-design` 属性后等价），`shadcn` 版渐进完善；中间态绝不半坏。**`data-design=amber-legacy` 根属性须在 C0 与 C4 作用域化前落地（round2-B7 原子性）**，否则 C4→C6 窗口 legacy 丢全局锐角。
- **INV-4**：`typecheck:ui-v4` + `build:ui-v4`（含 bundle 体积对账，PoC 基线 JS 272KB/gzip 86KB）+ **vitest（66）+ bun 测试（27）** 每 commit 绿。
- **INV-FIDELITY-1**（见 §5b）：切换不重挂 AppShell L0，**结构隔离强制**（L0 本体零 `designVersion` 引用 + `useWs` deps 保持为空）。

## 7. 给用户的 Open Questions

- **OQ-1（旧呈现树皮肤策略）**：过渡期旧树保持现有手写 Radix 皮肤原样（冻结、纯对照），还是也改用新 shadcn primitive？
- **OQ-2（新默认色板强调色）**：中性灰 + 蓝白、保留琥珀作强调、还是纯信号色？
- **OQ-3（实现方式）**：逐页 commit 自己一路实现，还是三层文档 + 分派并行？
- **OQ-4（旧树保留期限）**：所有页迁完即删，还是保留一段用户验证期？

### OQ 决议（用户 2026-07-10）

- **OQ-1 → 旧树用旧皮肤（冻结）**。过渡期旧树保持现有手写 Radix 皮肤原样、纯作对照基线，收尾整体删除。**推论**：C 类（皮肤 primitive）在过渡期是**双份**（旧 `shared/*` 手写皮肤 + 新 `components/ui/*` shadcn），确认 ADR 决策 9「皮肤双份」原文正确——**撤销 §2 草案里「C 类单份 token 驱动」的表述**（review W1），RFC v2 据此改（见 §2 C 类）。
- **OQ-2 → 新默认强调色 = 中性灰 + 蓝白**。shadcn 默认 preset 走中性灰阶（zinc/slate）+ 蓝白强调（最专业后台）。中性化语义 token 的 shadcn preset 映射按此定（见 §3 `neutral` preset）。
- **OQ-3 → 逐页自己一路实现**（不走三层文档分派）。省 `prompts/` 层；但见下「架子先行」硬约束。
- **OQ-4 → 待定**（收尾拆除触发条件，实现到收尾 phase 前再定，不阻塞）。

### 架子先行（用户 2026-07-10 追加硬约束，与 OQ-3 并存）

**逐页 ≠ 无共享框架。** 必须**先把架子搭得通用、可扩展**，再在架子上逐页迁移。架子 = ①主题 token 系统（shadcn CSS 变量 + 中性/Amber 两 preset + 可扩展第三 preset）②中性化语义 token 层（`--content-*`，A/B 类去 Amber 化的落点）③shiki 双主题按 preset 切 ④全局锐角规则作用域化 ⑤shadcn primitives（`components/ui/*`）⑥双呈现树 + `designVersion` 切换机制（切换作用点见 review F2）。**这与 review 要求的「前置地基 + 中性化阶段先行」完全一致**——cutover 序列的通用架子 commit（§4 的 C0–C7）**必须在任何逐页 commit（P1–P8）之前完成且做成可扩展的**（新增 preset / 新页接入零重复脚手架）。逐页只是在稳定架子上填内容，不是每页各搭一套。

## 8. 测试策略（round1 F3/W5 + round2 B2/B3/B6 据实重定）

**实测现状（v3 核实）**：测试在 `ui-v4/tests/`（**66 `.vitest.test.tsx` + 27 `.bun.test.ts`**），断言分布：`getByText` 371 / `getByRole` 142 / `querySelector` 78 / `getByTestId` 27 / `getByLabelText` 16；**仅 8 个 vitest 文件断言颜色 token/amber**（`DetailTocTree`/`RequestRow`/`ModelsTable`/`segments`/`ConvoSegment`/`SessionRow`/`diff-primitives`/`CodeBlock`，round2 复核与 RFC 列举一致）；`toMatchSnapshot` **零**。

→ **修正 F3 的严重度**：测试套件**已大体 design-agnostic**（role/text/testid 驱动），只有 8 处硬绑颜色。但 round2-B2/B3 揭示「一套测两树」**不是免费**——见下具体策略。

**策略**：

1. **断言层去 amber 具体值**：这 8 个颜色断言文件从「断言具体 `var(--color-*)`/hex」改为断言**语义 token 名 / `data-*` role / `getByRole`+可访问名**。因中性化后两树共用同一语义 token 名，**断言语义 token 存在而非其解析色值**。round2-B1 证实 tab-role 断言可迁：`DetailSubRail.tsx:15-27` Radix Tabs → shadcn Tabs 仍 `role=tab` 同名，`getByRole("tab")` 不碎。
   - **§8.1a · bun A′ 颜色断言必须同法纳入（round3 硬 gap，须 C2 前解）**：上述「8 个」只是 **vitest** 计数，**漏了断 A′ 构建器输出色值的 bun 测试**——`tests/vendor-color.bun.test.ts`（**9 处** `expect(vendorColor("Anthropic")).toBe("#b48ead")` 硬编码 hex）+ `tests/model-status.bun.test.ts`（**3 处** `expect(meta.colorVar).toBe("var(--color-muted)")`）。C2 中性化 `vendor-color.ts`/`model-status.ts`（hex→`--vendor-*`、`var(--color-*)`→`--signal-*`）**直接改变这两函数返回值** → 这些 bun 断言必碎、卡 INV-4「bun 27 每 commit 绿」。故 **C2 的定义须含这两个 bun 测试的断言迁移**（断语义 token 名而非解析值，同 8 个 vitest 文件之法），否则 C2 无法变绿。

2. **§8.2 · D 测试从 leaf-import 重写为 fork-routed 渲染（round2-B2，一等项非「直接复用」）**：**round2-B2 修正 v2「参数化 designVersion 直接复用」的低估**——实测 D 测试**leaf-import 具体 legacy 组件**（`DetailPanel.test:36` / `ConvoSegment.test:19` / `RequestsListPage.test:82`），**翻 store flag 不换所渲 DOM**。`colorPreset` 翻转（纯 CSS，B/A′ 层，一套断言测两 preset 可行）与 `designVersion` 翻转（换整棵组件树，D 层）**是两回事，v2 混为一谈**。故：
   - **B/A′ 内容体测试**：中性化后 `colorPreset` 两 preset 各跑一遍断言语义 token，**基本直接复用**（内容不变）。
   - **D 页壳/chrome 测试**：须**从「leaf-import legacy 组件」重写为「fork-routed 渲染」**（渲染路由/页元素，由 `designVersion` 决定挂哪棵，再在 role/testid 层断言）——这是**一等重写工作量**，非「翻 flag 即测两树」。新增 C7 水平 Tabs primitive 与三 fork 点（C6）各配存在性/互斥挂载守卫测试 + INV-FIDELITY-1 行为回归（§5b）。
   - **B↔C 适配器测试契约（round2-A3）**：`BlockJsonModal` 的 `shared/Modal` → shadcn Dialog 适配器须保住 `title`/`onClose`/`data-testid=modal-backdrop` 契约（`Modal.tsx:34`），适配器测试是硬工作量项。

3. **收尾旧树测试去向**：Z1 删 legacy 树时，**先确认 fork-routed 测试的 `shadcn` 分支全绿**，再删 `amber-legacy` 分支与 legacy 专属测试（`shared/*` 皮肤测试随 `shared/*` 一起删）。删 legacy 后 vitest 绿即证新树（断言已在 role/语义层）。

4. **§8.4 · golden 从零建，且区分同步/高亮两类（round2-B6 修 flaky）**：现无 `toMatchSnapshot`。**round2-B6 修正——golden 不能一律 `toMatchSnapshot`**：`shiki.ts:90-109` highlighter 是**进程级异步单例**（`highlighterPromise`/`loadedHighlighter`），`toMatchSnapshot` 依测试序产出 plaintext（未加载）或高亮（前序已加载）**二态**——`CodeBlock.test` 正是用 `await waitFor` 绕开（`CodeBlock.test:39-114`），snapshot 无法 await 自身内容 → golden 自身 flaky，**不能作 INV-3 闸**。故 golden 分两类：
   - **纯同步体**（Meta/Headers/非高亮 segment、非 code-bearing 内容）：直接 `toMatchSnapshot`。
   - **含 CodeBlock 的 code-bearing 体**：测试前 `await getHighlighter()` **预热单例**（预热后单例整文件保持 loaded，每个 snapshot 确定性产高亮态）。**注意（round3 修正）**：`shiki.ts` 的 `highlighterPromise`/`loadedHighlighter` 是**模块私有 `let`、无 reset 导出**（实测只导出 `getHighlighter`/`getLoadedHighlighter`），故「beforeEach 置 undefined」**按字面不可操作**、且与「预热到 loaded」目标相悖。采用 **仅预热**（`beforeEach: await getHighlighter()`，不 reset — 单一确定性高亮态即可作 golden）；**唯有确需跨测试隔离**时才在 `shiki.ts` 显式加 test-only `resetHighlighter()` 导出（置二私有 `let` 为 undefined），并写清「reset → 重新 await getHighlighter → 再 snapshot」的顺序（否则 reset 后不重新 await 会退回二态）。默认取仅预热。
   - golden 中性化前锁 `amber-legacy` 渲染，中性化/作用域化后须仍过。

5. **§8.5 · virtuoso 真行为另立契约（round2-B3 删 VirtuosoMockContext 事实错）**：**round2-B3 修正——`VirtuosoMockContext` 全仓零命中，v2 引用了不存在的 primitive**。真实基建是：
   - **手写 `FakeTableVirtuoso`**（`RequestsListPage.test:52-78`，`forwardRef` 忠实复现 `HistoryList` 用到的 `TableVirtuoso` 契约：`components.{Table,TableRow}` + `fixedHeaderContent` 渲 `<thead>` + `itemContent` 渲单元格 + `context`，硬编码 `<thead>`/`<tbody>`/`TableRow`）；
   - **`ResizeObserver` stub**（`setup.ts:11-17`，Popper/DropdownMenu/Select 定位必需，jsdom 不实现）；
   - **`initialItemCount`**（`requests-virtuoso.poc.vitest.test.tsx` 等强制首屏渲染行数）。
   - **迁移影响**：shadcn 列表若**不再是 `TableVirtuoso`**（换其它虚拟化容器/行结构），该手写 fake **硬编码 thead/tbody/TableRow 契约不可迁**，须为新列表容器**新建契约测试**（复现其组件槽约定）。jsdom 只测 mock 行为；virtuoso 真虚拟化（行回收/windowing/tail）需 e2e/PoC 级验证（`no-auto-server` 下由用户启动，记为手动 UX 检查项）。

6. **INV-4 纳入 bun 测试**（v1 漏）：每 commit `typecheck:ui-v4` + `build:ui-v4` + vitest 66 + **bun 27** 全绿。

## 9. 风险与缓解

- **R1 逻辑层被污染**：中性化误在 A/A′/B 引入 `designVersion` 分支。**缓解**：INV-1；每 commit grep 守卫（`grep -rn designVersion src/lib src/hooks src/stores src/components`，**扩到全部 B 域非仅 detail/**）。
- **R2 中性化「像素等价」被打破**（INV-3 对 legacy）：C2/C3/C4 若语义 token 在 `amber-legacy` 下未解析回等价 amber 值 / 全局 amber 规则族漏加 `data-design` → legacy 树视觉漂移。**缓解**：golden 预捕获（§8.4，区分同步/高亮两类）在中性化前锁 legacy 渲染；`data-design` 根属性 C0 落地（B7 原子性）；每中性化 commit 双 preset 各跑测试。
- **R3 双树双挂/闪烁**：三 fork 点任一双挂。**缓解**：INV-2；三 fork 点各配互斥挂载守卫测试；手动 UX 边界确认。
- **R4 切换丢常驻态**：开关误置于 AppShell L0 之上重挂订阅 / 给 `useWs` 加非空 deps。**缓解**：INV-FIDELITY-1（§5b）**结构隔离**（L0 本体零 `designVersion` 引用）+ 存在性守卫测试 + `useWs` deps 为空的行为回归（round2-A1）。
- **R5 B↔C 边界未解耦 + 适配器成本**：B 内容体硬绑某 C primitive → 无法服务两树；`BlockJsonModal` 的 `shared/Modal`→shadcn Dialog 适配器非「小」（round2-A3）。**缓解**：审计 grep B 目录对 `shared/*` import（实测仅 1 处）+ amber class；`BlockJsonModal` 适配器规范化两套 Dialog API + 保测试契约，列为 C3 一等工作量项（§8.2）。
- **R6 bundle 膨胀 + lint 缺口**：shadcn + lucide 增体积（PoC 基线 272KB/86KB，远轻于 antd 920KB）；ui-v4 缺 react-hooks/jsx-a11y lint（backlog 已记）。**缓解**：每 commit `build:ui-v4` 实测体积对账；迁移中顺带启用 ui-v4 lint。
- **R7 虚拟列表回归**：`react-virtuoso` 6 处，shadcn 化行渲染不得破坏虚拟化；手写 `FakeTableVirtuoso` 契约随列表容器变可能失效（round2-B3）。**缓解**：手写 fake 契约测试沿用/按新容器重建 + virtuoso 真行为 e2e/PoC 级契约（§8.5）。
- **R8 中性化 scope 低估**（round2-A4）：B 内容体滑进逐页 → 破 INV-1「中性化全前置」。**缓解**：C3 中性化清单据实扩到全域 B（§2 scope 分解表 + §4 C3）；grep 守卫扩到全部 B 目录。
- **R9 C7 过度抽象**（round2-A2）：把两迥异交互模型（内联整页 vs Dialog 抽屉）归并成模式开关容器。**缓解**：C7 只抽水平 Tabs 布局 primitive，抽屉/整页 chrome 各自实现（§4 C7）。
- **R10 语义 token 家族不足**（round2-B5）：同角色多 shade + ~29 surface hex 无 token 可归。**缓解**：§3 建 `--surface-*` scale 族 + 每 shade 独立 token；C1 一次建齐。

## 10. 范围外

- 不改后端、不改 `~backend/*` 契约、不改数据/WS 协议。
- 不改可视化算法（diff / SSE 累积 / shiki 分词逻辑）——只把 shiki 主题从单一改双主题。
- compact 密度（决策 4 未来项）、双入口 peek（backlog 形态 C，前置：形态 A 落地）不在本次；C7 水平 Tabs primitive 为 peek 预留复用点、但 peek 本身 defer。
- OQ-4（旧树保留期限）到收尾前再定。

## 11. 验证

- **golden 预捕获**（§8.4）：中性化前锁 virtuoso 行为、详情 segment 渲染、关键页 `toMatchSnapshot`（同步体直接 snapshot，code-bearing 体 await shiki 预热 + beforeEach 重置单例）；中性化/作用域化后须仍过（锁 `amber-legacy` 像素等价）。
- 每 commit：`typecheck:ui-v4` + `build:ui-v4`（bundle 体积对账，基线 272KB/86KB）+ vitest 66 + bun 27（INV-4）。
- **手动 UX 检查**（`no-auto-server`，用户启动）：每 commit 边界确认 `designVersion` 两版各自完整、无三 fork 点双挂闪烁；virtuoso 真虚拟化滚动/回收保真；切换保留 WS 快照/在飞请求（§5b）。
- 收尾（Z1）：whole-domain audit + DESIGN.md「活的架构现状」/§2/§8 同步 + 对抗 subagent review。

---

## 附:review 逐条处置表（round1 + round2）

### round1（v2 处置，保留）

| # | round1 判定 | v2/v3 处置 | 落点 |
|---|---|---|---|
| **F1** | 地基:Tailwind v4 无「shadcn init 直跑」、引第二套 Radix、`@theme inline` 冲突 | **PoC 证伪、降 WARN**：shadcn 在 v4 原生跑通、用统一 `radix-ui`、`@theme inline` 与现有 `@theme` 共存、`tw-animate-css` CLI 自动处理；仅剩全局 amber 规则族作用域化 + token 桥接两处理项（C4/C1） | §1 前置证据、§3、C0-C1-C4 |
| **F2** | 切换作用点错位:App.tsx 单例 router，AppShell 管不到 Outlet 页壳 | **亲手核实源码后重定**：单 router 不变，常驻 AppShell L0 之下设**三 fork 点**；否定「换两套 router」；INV-2 下沉到三 fork 点 | §5、§6 INV-2、C6 |
| **F3** | 新树零测试:全绑 legacy、断言硬编码 amber | **实测修正严重度**：断言实为 371 getByText/142 getByRole 主导，**仅 8 文件断颜色**；但「一套测两树」非免费（见 round2-B2） | §8（全节）、C6/C7 守卫测试 |
| **F4** | B 类非 design-agnostic:detail/ 152 `--color-*`，与「B 不动」矛盾 | **重划分类**：新增 A′ + B 中性化为前置阶段（C3）；round2 进一步扩到全域 B | §2 B 类、§3 第 2 层、C3、INV-1 |
| **F5** | A 类「零改动」虚假:request-columns/vendor-color/model-status/shiki 单主题 | **新增 A′ 类**专收设计耦合 lib；C2 一次性中性化 + shiki 双主题；round2 修正 A′ 锚点（见 A4） | §2 A′ 类、§3 第 3 层、C2 |
| **F6** | INV-3「视觉零变化」与 `theme.css:29 *{border-radius:0!important}` 冲突 | **作用域化立为一等 commit（C4）**；round2-B8 扩为全局 amber 规则族审计 | §1、C4、R2 |
| **W1** | §2「C 单份」改了 ADR 决策 9、与 OQ-1「旧树冻结」矛盾 | **撤销「C 单份」**:据 OQ-1，C 类过渡期**双份**，确认 ADR 决策 9 原文正确 | §2 C 类、§7 OQ-1 决议 |
| **W2** | LiveDock 已全局化 RFC 当待办放错;Models 共享抽屉制造跨页依赖 | **核实 LiveDock 已在 AppShell:31**（P2 只剩样式）；公共详情容器独立成 C7；round2-A2 进一步收窄为水平 Tabs primitive | §2 D 类、C7、P2、R8 |
| **W3** | §2 遗漏 DiagnosticBar/MessageBlock/ConversationView/toc/*/*Button/*Modal | **逐个归位**:内容体→B；TocSidebar→D；*Button/*Modal→B 内容旁交互 chrome（B↔C 边界） | §2「W3 遗漏组件归位」+「B↔C 边界」 |
| **W4** | 切换丢运行态:WS 一次性快照/滚动/virtuoso 位置随卸载归零 | **并入 F2 切换作用点**:常驻 L0 保 WS 快照/live-store/query/URL；页局部态切换重置=可接受；INV-FIDELITY-1 | §5b、§6 INV-FIDELITY-1、R4 |
| **W5** | golden 基建为零;jsdom 锁不住 virtuoso;INV-4 漏 bun | **golden 从零建**（round2-B6 分同步/高亮两类）+ **virtuoso 真行为另立契约**（round2-B3 修基建描述）+ **INV-4 纳入 bun 27** | §8.4、§8.5、§6 INV-4、§11 |
| **W6** | 僵尸 `theme:light/dark/system` 未处置 | **地基 commit 直接删** `theme`/`setTheme`/`ThemeMode` + TopBar 按钮，代之以 `designVersion` + `colorPreset` | §3「僵尸字段处置」、C0 |

### round2（v3 处置，逐条 A1-A4/B1-B8）

| # | round2 判定 | v3 处置 | 落点 |
|---|---|---|---|
| **A1** | WARN:INV-FIDELITY-1 强制偏弱（守卫只断挂载身份，断不住给 useWs 加 deps） | **结构隔离 > 纪律**：`designVersion` 读取下沉到 AppShell 子组件、L0 本体零 `designVersion` 引用；补「useWs deps 为空 / 快照到达后切换仍在飞」行为回归 | §5 结构隔离、§5b INV-FIDELITY-1、C6、R4 |
| **A2** | WARN:C7 DetailContainer 抽象过度（塞进两交互模型唯一不重叠的容器 chrome） | **收窄 C7**：撤销「DetailContainer」，只抽「水平 Tabs 内容布局 primitive」；抽屉-chrome（ModelDetail Dialog+portal+overlay+resize+focus）与整页-chrome（DetailPanel 内联 Tabs）**各自实现** | §2 D 类、§4 C7、R9 |
| **A3** | WARN:B↔C 适配器成本低估（BlockJsonModal 依赖 shared/Modal title/onClose/testid 契约） | **列为硬工作量**：B 目录对 shared/* import 仅 1 处（`BlockJsonModal.tsx:2`），适配器须规范化两套 Dialog API + 保 `data-testid=modal-backdrop` 测试契约；ExportButton 走裸元素路径①顺畅 | §2 B↔C 边界、§8.2、R5 |
| **A4** | **FAIL**:五类 A′ 锚点误置 + Models 域 B/A′ 逃逸前置中性化 + scope 低估 ~3× | **最重修正**：A′ 删 `model-columns`（实测零色，纯 A）、加 `model-table-columns.tsx`（10+2hex+vendorColor）；C2/C3 中性化清单**扩到全 components 域 450**（据实全量 scope 分解表 + 三治分类）；INV-1「中性化全前置」重申覆盖所有域 | §1、§2 五类表 + scope 分解表、§4 C2/C3、§6 INV-1、R8 |
| **B1** | 成立:tab-role 断言可迁 | 已纳入:Radix Tabs → shadcn Tabs 仍 `role=tab`，`getByRole("tab")` 不碎 | §8.1 |
| **B2** | WARN:§8.2 参数化 designVersion 低估（测试 leaf-import legacy，翻 flag 不换 DOM） | **一等重写项**：D 测试从「leaf-import legacy 组件」重写为「fork-routed 渲染」；区分 colorPreset 翻转（CSS，B/A′ 可复用）vs designVersion 翻转（换组件树，D 须重写） | §8.2 |
| **B3** | **FAIL**:VirtuosoMockContext 事实错（零命中） | **删该 primitive**：改述真实基建=手写 `FakeTableVirtuoso`(`RequestsListPage.test:52-78` 硬编码 thead/tbody/TableRow 契约)+`initialItemCount`+`ResizeObserver` stub(`setup.ts`)；shadcn 若非 TableVirtuoso 该 fake 不可迁、需新契约测试 | §8.5、R7 |
| **B4** | 成立:hex 可 token 化、shiki baked hex 对 amber-legacy 安全 | 已纳入:内联 style/任意值换 `var()`；shiki baked hex 随 THEME_NAME 走、amber-legacy 等价 | §3 第 3 层 |
| **B5** | WARN:语义槽爆炸（~6 token 名不够，同角色多 shade + ~29 surface hex 无家） | **扩 token 家族**：`--surface-*` scale 族 + 每 shade 独立 token（thinking 3 紫/tool 2 绿各自 token）；C1 一次建齐 | §3 第 2 层、C1、R10 |
| **B6** | **FAIL**:§8.4 golden 对 code-bearing 体 flaky（shiki 进程级异步单例 → 二态） | **修 golden**：分同步/高亮两类——同步体直接 snapshot；code-bearing 体测试前 `await getHighlighter()` 预热 + beforeEach 重置单例，否则不作 INV-3 闸 | §8.4、§11、R2 |
| **B7** | WARN:C4 data-design 属性落点未指派（拖到 C6 则 C4→C6 窗口丢锐角） | **指派原子性**:C0 与 C4 作用域化同保证——`data-design=amber-legacy` 在 **C0 写进 DOM 根**、C4 作用域化引用它，两步不留窗口 | §4 C0/C4、§6 INV-3、R2 |
| **B8** | WARN:C4 范围过窄（.toc-flash 由共享 useAnchorScroll 施加、泄漏进 shadcn 共享 B） | **扩 C4 范围**:从「全局锐角作用域化」扩为「全局 amber 规则族审计与作用域化」——含 `.toc-flash`(#2a2212)、`.rdp-amber`、`@keyframes`、锐角、livedock 2px 例外 | §1、§4 C4 |
| **裁决** | 主会话 ground-truth:detail 152（非 127）、全域 450、VirtuosoMockContext 零命中、toc-flash 泄漏 | **撤回 v2「工作量下调」框架**:中性化面据实（detail 152、全域 450，不小于 round1） | §1 v2→v3、§2 scope 分解表 |

**未采纳 / 存疑 / v3 对 review 的独立修正**：
- **v3 独立核实 round2-A4 的「全域 450」并精化其治理**（richest-data-flow，非缩范围）：亲手 `grep -roE 'var\(--color-[a-z0-9-]+\)' src/components` 复现 450，并给全 11 子目录分解（round2-A4 列举的 detail 152/models 85/sessions 14/learned 27/tools 32/overview 4/common 6 仅合 320，**漏列 requests 88 + shared 23 + shell 12 + config 7 = 130**，v3 补齐）。**精化**：450 按治理分三治——**B/A′ 前置中性化子集（C2/C3，跨全域）** vs **D-shell 逐页 fork 内 legacy 侧（P1-P8 重写、不前置）** vs **`shared/` 冻结皮肤（Z1 删）**。三者工作量都不砍，但 INV-1「中性化全前置」精确绑定在 B/A′ 子集（约 detail 152 + 其它域 B ~80 + A′ lib 21 + model-table-columns 12），不是笼统「450 全前置」。此精化**不弱化** round2-A4 的核心结论（B 内容体遍布全域、必须前置），而是把工作量归属钉得更准。
- **A′ 计数精化**:`model-table-columns.tsx` round2 称「13 色」，v3 实测 = **10 `var(--color-*)` + 2 六位 hex + 2 处 `vendorColor()` 调用（import vendorColor）**，量级一致、锚点结论（属 A′、v2 漏分类）成立。
- **detail hex 计数**:主会话裁决 29（六位 hex），v3 复现 = 29，采纳。
- round2 无 reviewer 建议被否决:A1-A4/B1-B8 全部采纳落地（FAIL 3 条全修、WARN 8 条全纳）。
