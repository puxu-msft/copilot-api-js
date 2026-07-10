# RFC: ui-v4 shadcn/ui 重设计迁移（v2）

- 状态: Draft（v2 已吸收 round1 对抗 review + 地基 PoC 结论 + 用户 OQ 决议；待再一轮 review 后进 commit 序列）
- 日期: 2026-07-10
- 派生自: ADR [../decisions/2026-07-10-ui-v4-shadcn-adoption.md](../decisions/2026-07-10-ui-v4-shadcn-adoption.md)（决策 1–11）
- 前置证据: PoC [../../../../exp/shadcn-tw4-poc/CONCLUSION.md](../../../../exp/shadcn-tw4-poc/CONCLUSION.md)（地基可行，F1 由 FAIL 降 WARN）、round1 review [design-review-2026-07-10-1.md](design-review-2026-07-10-1.md)（6 FAIL + 6 WARN）
- 方法论: skill `large-refactor`（RFC-first + commit invariants + 过渡态显式无害 + golden 预捕获）

> **v1→v2 的根本变化**：v1 假设「设计只在 shell/皮肤层，逻辑与可视化两版共享零改动」。round1 review 用 file:line 证伪了这个假设——**Amber 设计语义贯穿 lib（信号色/厂商色/shiki 主题）+ 详情内容体（127 处 `--color-*` + 42 处裸 hex，v2 亲手复核）+ 全局 `*{border-radius:0!important}`**。v2 的核心修正：把「去 Amber 化 / 中性化」从 v1 的「一句风险缓解」提升为一个**一等前置阶段**（在双树骨架之前、逐页之前），并据实测重新划分组件类别、重新定位 designVersion 的真实切换作用点。

## 1. 问题陈述

ui-v4 当前是定制「工业风 Terminal Amber」体系（`src/styles/theme.css`：暖近黑底、琥珀主色、IBM Plex Mono、深色 only、全局 `*{border-radius:0!important}`）。ADR 决策把它切换到 **shadcn/ui（new-york，锐角，色板 preset 化）** + 一批布局改动（默认页 /overview、LiveDock 全局、详情抽屉共用、列表-详情形态 A、详情内竖排→水平 tabs、NavRail 加宽加图标），改造期以**新旧双呈现树 + 全局 `designVersion` 开关**并存对照，完工后拆除旧树。

**round1 review 揭示的真问题（决定 v2 架构）**：设计不是「只在 shell」的一层，而是**三条贯穿性耦合**——

1. **lib 层伪 design-agnostic**：`request-columns.ts` 返回带 amber class 的 `ReactNode`、`vendor-color.ts` 硬编码 4 个 hex、`model-status.ts` 的 `colorVar` 引 `var(--color-*)`、`highlight/amber-theme.ts` + `shiki.ts` 只有单一 amber 主题（新树里 CodeBlock 仍出 amber 高亮）。这些是「共享逻辑」但**设计耦合**，v1 归为「A 类零改动」是虚假的。
2. **内容体伪 design-agnostic**：`detail/` 下 127 处 `--color-*` + 42 处裸 hex（ThinkingBlock / MessageBlock / toc 语义色映射）。v1 归为「B 类不动」与 INV「B 类零改动」直接矛盾。
3. **全局锐角 `!important`**：`theme.css` `*, *::before, *::after { border-radius: 0 !important }` 架空 shadcn 的 `--radius` token——PoC 构建产物实测两者并存、前者压平后者。要让 shadcn 树出圆角必须把该规则作用域化，而作用域化又会触碰 amber-legacy 的像素等价。

若不先做一个**前置中性化阶段**（语义 token 中性化 + shiki 双主题 + 全局锐角作用域化），双树一挂：shadcn 树会渲染出 amber 内容 + 被压平的圆角 → 被迫在「INV 宣布为红线」的 lib/内容体层返工。故 v2 把中性化立为架子先行的第一等公民。

**仍然成立的核心事实**：ui-v4 价值的大头在**逻辑 + 可视化渲染算法**（diff/SSE 累积/shiki 分词/内容解析），这些**经中性化后**与设计无关、两版共享；迁移**不复制**逻辑层与算法层。只有 shell/皮肤/布局/页面壳需要双份呈现树。

## 2. 修正后的组件分类（据 PoC + review 实测重划，五类）

v1 的三分类（A 逻辑不动 / B 内容不动 / C 皮肤单份 / D shell 双份）被实测推翻两处：**「不动」的 A/B 实含设计耦合**、**C 不是单份而是双份**（OQ-1）。v2 重划为五类：

| 类别 | 目录/文件（实测锚点） | 迁移处理 |
|---|---|---|
| **A. 纯数据/算法（真 design-agnostic，不动）** | `hooks/*` `stores/*`（含 live-store/list-store）`types/*` `lib/api.ts` `lib/content/*` `lib/diff/*` `lib/format.ts` `lib/json-tools.ts` `lib/learned.ts` `lib/request-filters.ts` `lib/model-filters.ts` `lib/model-telemetry.ts` `lib/ws-client.ts` `lib/query.ts` | 返回数据/纯计算，无 JSX、无颜色字面量。**红线：任何 commit 不得在此引入 `designVersion` 分支或颜色字面量。** |
| **A′. 需中性化层（lib 里产 JSX/颜色，前置阶段一次性中性化）** | `lib/request-columns.ts`（返回带 amber class 的 `ReactNode`，line 60-64 色 map + line 167/188/205/219/244 内联 `var(--color-*)`）、`lib/vendor-color.ts`（line 10-13 硬编码 4 hex）、`lib/model-status.ts`（`colorVar: var(--color-*)`）、`lib/model-columns.ts` / `lib/activity-row.ts`（若含色）、`lib/highlight/amber-theme.ts` + `lib/highlight/shiki.ts`（单一 `AMBER_THEME`，`themes:[AMBER_THEME]`）、`lib/live-summary.ts`（若含色） | **不是「不动」，是「中性化一次、两版共用」**：颜色字面量 → 中性语义 token（`--content-*`/`--signal-*`，见 §3），两 preset 各自映射；shiki 单主题 → 双主题按 preset 切。中性化后**升格为 A**（经 token 间接、design-agnostic）。此为架子先行的前置阶段核心工作量。 |
| **B. 可视化内容体（中性化后两版共用）** | `detail/blocks/*` `detail/diff/*` `detail/segments/*` `detail/ContentRenderer` `detail/CodeBlock` `detail/LineNumberedText` `detail/MessageBlock` `detail/ConversationView` `detail/DiagnosticBar` `detail/toc/DetailTocTree` `common/RawJsonView` `tools/JsonTreeView` | 内容渲染算法与设计无关，但**当前含 127 `--color-*` + 42 hex**。前置中性化阶段把这些改为中性语义 token（结构 class 保留），之后两版共用。**红线（中性化后）：零新 amber 硬编码、零 `designVersion` 分支。** 内嵌的交互 chrome（小按钮/modal 触发）用中性 token 的裸元素或经「设计无关适配器」取 primitive（见下「B↔C 边界」），使同一 B 文件服务两树。 |
| **C. 皮肤 primitive（过渡期双份 — OQ-1 冻结旧树）** | **新**：`components/ui/*`（shadcn button/input/select/dialog/tabs/badge/slider/…，PoC 已证 `shadcn add` 在 v4 + 统一 `radix-ui` 下跑通）。**旧（冻结）**：`components/shared/Modal` `shared/FilterSelect` `shared/RangeSlider` 等手写 Radix 封装。 | **双份**（撤销 v1「C 单份 token 驱动」表述，见 W1）：OQ-1 定旧树用旧皮肤冻结，故过渡期 `shared/*`（legacy 树）与 `components/ui/*`（shadcn 树）并存，**确认 ADR 决策 9「组件皮肤双份」原文正确**。收尾随 legacy 树整体删除 `shared/*`。 |
| **D. 双份呈现树 shell/布局/页面壳（由 `designVersion` 选挂）** | `shell/NavRail`（加宽+lucide 图标）`shell/TopBar` + shell 布局包裹、各页壳（`requests/RequestsListPage` `requests/RequestDetailPage` `overview/OverviewPage` `models/ModelsPage` `sessions/*Page` `config/ConfigPage` `learned/LearnedPage` `tools/JsonToolsPage`）、`detail/DetailPanel`+`detail/DetailSubRail` 与 `models/ModelDetail`+`models/ModelDetailSubRail`（竖排→水平 tabs，决策 10）、`requests/LiveDock`（**仅呈现层** fork，订阅常驻见 §切换作用点）、`detail/toc/TocSidebar`、**新** `DetailContainer`（公共详情容器，见 W2 前置 commit） | 由 `designVersion` **互斥挂载**一棵。新树 import 中性化后的 B 内容 + 新 C primitive；旧树保持现状冻结直到收尾删除。 |

**关键边界澄清（易错点，v2 修订）**：

- **A′ 是新增的一等类别**，专收 v1 误判为「A 零改动」但实含设计字面量的 lib 文件。它们的中性化是**前置阶段做一次**、两树共享结果，不进逐页 commit。
- **`DetailSubRail`/`ModelDetailSubRail` + `DetailPanel`/`ModelDetail` 属 D**（导航/布局/容器，竖排→横排是决策 10），但它们渲染的 **segment 内容体属 B**（中性化后不动）。迁移改 tab 容器与朝向，不改 segment 内容。
- **W3 遗漏组件归位**：`DiagnosticBar`/`MessageBlock`/`ConversationView`/`toc/DetailTocTree` → **B**（内容体，随中性化）；`toc/TocSidebar` → **D**（布局壳）；`ToolJumpButton`/`JsonModalButton`/`ExportButton`/`BlockJsonModal` → **B 内容旁的交互 chrome**，按下「B↔C 边界」处理（裸中性元素或适配器取 primitive，不硬绑某一 C 实现）。
- **B↔C 边界（review R2 的根治）**：B 内容体若内嵌交互原语，为「同一文件服务两树」，**不得硬编码走哪套 C primitive**。两条允许路径：①用中性 token 的裸 `<button>`/`<span>`（轻交互，不需 Radix 行为）；②需要 Radix 行为（focus-trap/portal）时，经一个 design-version-agnostic 的小适配器/context 取当前树的 primitive。审计阶段 grep B 目录里对 `shared/*` 的直接 import + amber class，逐个按此二法解耦。

## 3. 主题 token 架构（两 preset + 中性化语义 token 层 + shiki 双主题）

三层，自下而上：

**(1) shadcn CSS 变量层（PoC 已落地形态）**：`shadcn init -b radix -t vite` 注入标准 shadcn token（`--background`/`--foreground`/`--primary`/`--border`/`--radius`/`--muted`/…）+ `@theme inline{}`（PoC 证实与现有 `@theme{}` 共存）+ `tw-animate-css`（v4 替代 `tailwindcss-animate`，CLI 自动处理）。

**(2) 中性化语义 token 层（架子先行要建的通用可扩展层，A′/B 中性化的落点）**：在 shadcn token 之上定义**设计中性的语义 token**，命名反映**语义角色**而非颜色：
- 内容语义：`--content-add` / `--content-del` / `--content-thinking` / `--content-tool` / `--content-system` / `--content-muted` 等（覆盖 detail/ 内容体的 127 处 `--color-*`）。
- 信号语义：`--signal-ok` / `--signal-fail` / `--signal-warn` / `--signal-live`（覆盖 request-columns / model-status）。
- 厂商语义：`--vendor-anthropic` / `--vendor-openai` / `--vendor-google` / `--vendor-other`（覆盖 vendor-color.ts 的 4 hex）。

每个语义 token 由**每个 preset 各自映射**到具体色值：
- `amber` preset：复现 Terminal Amber（`--radius:0`、琥珀阶、mono、现有 `--color-*` 的等价值）。
- `neutral` preset（**OQ-2 新默认 = 中性灰 zinc/slate + 蓝白强调**）：覆盖 shadcn init 的默认 oklch。
- **可扩展**：新增第三 preset = 加一组映射，零结构改动（PoC 的 token 桥接结论正是要建此层）。

现有 B/A′ 消费的 `--color-*`（amber 命名空间）与 shadcn `--primary` 不同名——**双向桥接在本层完成**（`--color-*` 别名指向语义 token，或语义 token 别名到 shadcn token），PoC WARN-2 的处理项即此。

**(3) shiki 双主题**：`highlight/` 现只 `themes:[AMBER_THEME]`。中性化：加一个中性/蓝白语法主题，`codeToHast` 的 `theme` 参数**按当前 preset 选**（`amber` → terminal-amber，`neutral` → 中性主题）。这样新树 CodeBlock 不再出 amber 高亮。

**`designVersion` vs `colorPreset` 的正交性 + 僵尸字段处置（W6）**：
- `designVersion`（`amber-legacy` | `shadcn`）是**过渡脚手架**（选哪棵呈现树），收尾删除。
- `colorPreset`（`amber` | `neutral` | …）是**永久**色板层。收尾后 Amber 作为一个永久 preset 保留、`designVersion` 移除。
- 过渡期约束：`amber-legacy` 树走作用域化的 amber 样式（冻结，不受 `colorPreset` 影响）；`shadcn` 树默认 `neutral` preset、preset 可独立切换。
- **僵尸 `theme:light/dark/system` 处置**：`ui-store.theme` + `setTheme` + `TopBar` 的 `◐ {theme}` 按钮是死代码（实测：只切换一个 label，无任何消费者做实际主题）。**v2 地基 commit 直接删除 `theme`/`setTheme`/`ThemeMode` + TopBar 按钮**，代之以 `designVersion`（过渡）+ `colorPreset`（永久），避免三态混淆。

## 4. Cutover 计划（按 commit，架子先行）

**架子先行硬约束（OQ-3 追加）落实**：通用可扩展架子（地基 → 中性化 → 双树切换机制 → 公共详情容器 → C primitives）**必须在任何逐页 commit 之前完成且做成可扩展**；逐页只在稳定架子上填内容，不是每页各搭一套。下方每个「架子 commit」标注**可扩展性**（新增 preset / 新页接入零重复脚手架）。

### 架子先行阶段（逐页之前，全部完成）

- **C0 · 地基**（PoC 已验证路径）：`shadcn init -b radix -t vite`（`components.json` new-york）+ 装 lucide-react + `cn`/`cva` util + shadcn CSS 变量层 + `tw-animate-css`。ui-store **删僵尸 `theme`**、加 `designVersion`（默认 `amber-legacy`）+ `colorPreset`（默认 `amber`，过渡期 legacy 走冻结样式）。**此 commit 后视觉零变化**（默认 amber-legacy 旧树，shadcn 层已装未挂）。
  - **可扩展性**：token 变量层 + `components.json` 就位，后续 `shadcn add X` 零配置接入。
- **C1 · 中性化语义 token 层 + 两 preset**（§3 第 2 层）：定义 `--content-*`/`--signal-*`/`--vendor-*` 语义 token + `amber`/`neutral` 两 preset 映射 + `--color-*` ↔ 语义 token 桥接。**此 commit 只加层、不改消费者**，视觉仍零变化。
  - **可扩展性**：新 preset = 加一组映射，零结构改动。
- **C2 · A′ 中性化**：`request-columns` / `vendor-color` / `model-status` / `model-columns` / `activity-row` / `live-summary` 的颜色字面量 → 语义 token；`shiki` 单主题 → 双主题按 `colorPreset` 切（§3 第 3 层）。**amber-legacy 下语义 token 解析回等价 amber 值 → 像素等价（INV-3）**。
  - **可扩展性**：A′ 升格为 A，任何树消费同一份中性化 lib。
- **C3 · B 内容体中性化**：`detail/` 下 127 `--color-*` + 42 hex → 中性语义 token；B↔C 边界解耦（裸中性元素或适配器）。grep 守卫 B 目录零 amber 硬编码。**amber-legacy 像素等价**。
  - **可扩展性**：B 内容体自此 design-agnostic，新增 preset/新树免改内容体。
- **C4 · 全局锐角作用域化**（review F6 + PoC WARN-1）：`theme.css` 的 `*{border-radius:0!important}` → `[data-design=amber-legacy] *{…}`；`.livedock-island` 的 2px 例外一并作用域化。shadcn 树自此按 `--radius` token 出圆角/锐角（new-york + `--radius:0` 仍可锐）。**amber-legacy 树加 `data-design` 属性后像素等价**。
  - **可扩展性**：全局压平不再污染新树，preset 完全掌控圆角。
- **C5 · C primitives 落地**：`components/ui/*`（button/input/select/dialog/tabs/badge/slider/…）映射现有 `shared/*` 封装（PoC 已证 dialog/tabs/button 跑通）。旧 `shared/*` **不动**（冻结，双份）。
  - **可扩展性**：新页直接 import `components/ui/*`，无需再造原语。
- **C6 · 双树切换机制**（切换作用点见 §5，是本阶段的架构核心）：AppShell 拆出**常驻 L0**（`useWs`+`useLiveRequests`+`LiveDock` 挂载点，不 fork）；shell chrome（NavRail/TopBar/布局）按 `designVersion` 互斥挂载；LiveDock 呈现层按 `designVersion` fork（订阅常驻不受影响）。TopBar/新 chrome 加 `designVersion` 切换按钮。INV-2/INV-3 生效。**shadcn shell 先是最小骨架**（加宽 NavRail + 图标 + TopBar + Outlet）。
  - **可扩展性**：切换在页元素/chrome/dock 三 fork 点，新页接入只需在其页元素加同构 fork，无新脚手架。
- **C7 · 公共详情容器抽取**（review W2 前置，排在 Requests/Models 两页之前）：现状实测 `DetailPanel` 仅 Requests 用（`RequestDetailPage` + 自身），`ModelDetail` 是独立 Radix `Dialog` 抽屉、**不复用 DetailPanel**（`grep -c DetailPanel ModelDetail.tsx == 0`）。决策 8 要「Models 详情与 Requests 详情共用公共容器」——这是**新抽象**，且制造 Requests↔Models 跨页依赖，**必须独立成 commit 排在两页之前**（否则两页无法并行、互相阻塞）。C7 建 shadcn 树的 `DetailContainer`（抽屉/面板容器，内容层各自渲染 B），供 shadcn Requests（形态 A 整页）与 shadcn Models（抽屉）复用；**legacy 的 DetailPanel/ModelDetail 冻结不动**（OQ-1）。
  - **可扩展性**：未来 peek（backlog 形态 C）复用同一 `DetailContainer`。

### 逐页阶段（架子稳定后，天然可并行 — 但 Requests/Models 依赖 C7）

- **P1 · Overview**（+默认页 `/requests` → `/overview`，决策 6）：shadcn OverviewPage 壳，import 中性化 B 内容。
- **P2 · Requests**（依赖 C7）：列表 + 形态 A 整页详情 + prev/next 快捷键 + `?at=id` 返回定位（决策 5）+ LiveDock 呈现层 shadcn 化（决策 7，**结构已在 AppShell，仅样式**，见 W2）。
- **P3 · Requests 详情 DetailPanel**（决策 10）：竖排 sub-rail → 顶部水平 Tabs（shadcn `Tabs` horizontal）；7 段横排。segment 内容体（B）不动。
- **P4 · Models**（依赖 C7）：详情抽屉接入公共 `DetailContainer`；ModelDetailSubRail 竖→横。
- **P5 · Sessions** / **P6 · Config** / **P7 · Learned** / **P8 · Tools**：各页壳 shadcn 化，import 中性化 B 内容 + C primitive。

### 收尾阶段

- **Z1 · 收尾拆除**（触发条件 OQ-4 待定，不阻塞前序）：新树确认完整后，删旧呈现树（D legacy 壳 + C `shared/*`）+ 移除 `designVersion` 开关与 `[data-design=amber-legacy]` 作用域 + Amber 降为永久 `colorPreset` + 更新 DESIGN.md「活的架构现状」/§2/§8 + whole-domain audit + 对抗 subagent review。

## 5. 切换作用点（review F2 的正解 — v2 亲手核实源码后定）

**实测约束（读源码确认）**：
- `main.tsx:16` 单 `<RouterProvider router={router}>`；`App.tsx:20` 单例模块级 `createHashRouter`，`AppShell` 为根 `element`，页面经**单个 `<Outlet/>`** 渲染（`AppShell.tsx:26`）。
- `AppShell` 是**常驻宿主**：`useWs`（`AppShell.tsx:14`）+ `useLiveRequests`（`:19`，socket 打开的**一次性 `connected` 快照**只派发给当时已注册的订阅者，故必须常驻）+ `LiveDock` 挂载（`:31`，决策 7 结构已落地）。

**为何 v1 的「AppShell 按 designVersion 换 shell」是错的（F2）**：AppShell 换 chrome 换不到 `<Outlet/>` 里的页面壳（D 类主体），页面元素由 router 路由定义钉死。

**为何「换两套 router」也不可取（并入 W4）**：顶层 swap `RouterProvider` 的 `router` 会**重新挂载 AppShell → 丢失一次性 `connected` 快照 + 卸载常驻订阅**，重演「只显示切换后新请求」的历史 bug。

**v2 定的切换作用点：单 router 树不变，在常驻 AppShell 之下设三个 fork 点**——

```
main.tsx  RouterProvider（单 router，不 fork）
  └ QueryClientProvider（resident，react-query 缓存跨切换存活）
    └ App router（单 createHashRouter，不 fork）
      └ AppShell L0（常驻，永不因 designVersion 重挂）
         ├ useWs / useLiveRequests   ← 一次性快照 + 常驻订阅（写 zustand live-store）
         ├ [fork A] shell chrome     ← NavRail/TopBar/布局 按 designVersion 互斥挂载
         ├ <Outlet/>
         │   └ [fork B] 页元素        ← 每个 RoutePage 内部按 designVersion 互斥挂载 legacy/shadcn 页壳
         └ [fork C] LiveDock 呈现层   ← 按 designVersion fork（读同一常驻 live-store，切换不丢数据）
```

- **INV-2（互斥挂载）下沉到三 fork 点**：chrome、每个页元素、LiveDock 呈现层——各自条件渲染只挂一棵，绝不双挂。router 保持单树。
- 切换 `designVersion` 是 store 变更（非导航），URL/route 不变 → react-router 保持同一路由 → 同一页元素重渲染切 fork → legacy 子树卸载、shadcn 子树挂载。

## 5b. 切换保真不变量（review W4，切换作用点定后可定）

- **INV-FIDELITY-1（常驻不重挂）**：`designVersion` 切换**绝不**重挂 AppShell L0（`useWs`/`useLiveRequests`/live-store 订阅）。强制手段：`designVersion` 永不 gate AppShell 自身的 hook 或挂载，只 gate 子子树。→ AppShell 存在性守卫测试断言 fork 点在 L0 之下。
- **切换保留**（跨切换存活）：WS 连接 + 一次性 `connected` 快照、live-store 在飞请求、react-query 缓存（QueryClientProvider 在 router 之上常驻）、当前 route/URL（停在同一逻辑页）。
- **切换重置（可接受、页局部）**：per-page 滚动位置、virtuoso 窗口偏移、页内瞬时 UI 态（展开菜单、当前 detail segment tab）。这些页局部态在切换页壳时按设计卸载归零，**过渡期开关不值得为其做持久化**（OQ-4 收尾即删）；若后续用户反馈需保留，再评估（记为潜在需求，不阻塞）。

## 6. Commit invariants（修正后）

- **INV-1**：**A 类（纯数据/算法）+ 中性化后的 A′/B** 在任何 commit **零 `designVersion` 分支、零新颜色字面量**（颜色只经语义 token）。中性化本身是**前置架子 commit（C2/C3）一次性完成**，非逐页；C2/C3 之后此红线生效。
- **INV-2**：任一 commit，`designVersion` 在 **chrome / 每个页元素 / LiveDock 呈现层**三 fork 点各**互斥挂载**一棵（绝不双挂同时渲染）。
- **INV-3**：从 C6 引入开关起，每个 commit **两版都可运行且自洽**——`amber-legacy` 保持像素等价（C2/C3/C4 的中性化 + 作用域化对 legacy 必须解析回等价 amber 值 / 加 `data-design` 属性后等价），`shadcn` 版渐进完善；中间态绝不半坏。
- **INV-4**：`typecheck:ui-v4` + `build:ui-v4`（含 bundle 体积对账，PoC 基线 JS 272KB/gzip 86KB）+ **vitest（66）+ bun 测试（27）** 每 commit 绿。（v1 漏 bun 测试，v2 纳入。）
- **INV-FIDELITY-1**（见 §5b）：切换不重挂 AppShell L0。

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

## 8. 测试策略（review F3 / W5，据实测重定）

**实测现状（v2 核实）**：测试在 `ui-v4/tests/`（**66 `.vitest.test.tsx` + 27 `.bun.test.ts`**），断言分布：`getByText` 371 / `getByRole` 142 / `querySelector` 78 / `getByTestId` 27 / `getByLabelText` 16；**仅 8 个 vitest 文件断言颜色 token/amber**（`DetailTocTree`/`RequestRow`/`ModelsTable`/`segments`/`ConvoSegment`/`SessionRow`/`diff-primitives`/`CodeBlock`）；`toMatchSnapshot` **零**。

→ **修正 F3 的严重度**：测试套件**已大体 design-agnostic**（role/text/testid 驱动），只有 8 处硬绑颜色。「一套测两树」基本可行，改动集中在这 8 处。

**策略**：
1. **断言层去 amber 具体值**：这 8 个颜色断言文件从「断言具体 `var(--color-*)`/hex」改为断言**语义 token 名 / `data-*` role / `getByRole`+可访问名**。因中性化后两树共用同一语义 token 名，**一套断言测两树**（在 `amber-legacy` 与 `shadcn` 两 preset 下各跑一遍，断言语义 token 存在而非其解析色值）。
2. **新树覆盖来源**：B 内容体测试（大多数）中性化后**直接复用**（内容不变）；D 页壳/chrome/DetailContainer 测试**参数化 `designVersion`**——同一测试体在 `amber-legacy` 与 `shadcn` 下各渲染断言（role/testid 层），使新树获得等价覆盖。新增 `DetailContainer`（C7）与三 fork 点（C6）各配存在性/互斥挂载守卫测试。
3. **收尾旧树测试去向**：Z1 删 legacy 树时，**先确认参数化测试的 `shadcn` 分支全绿**，再删测试里的 `amber-legacy` 分支与 legacy 专属测试（`shared/*` 皮肤测试随 `shared/*` 一起删）。删 legacy 后 vitest 绿即证新树（因断言已在 role/语义层，非「删了就没人测」）。
4. **golden 从零建（W5）**：现无 `toMatchSnapshot`。前置阶段（C2/C3/C4 之前）对**关键内容体渲染 + 详情 segment + 关键页**建 `toMatchSnapshot` golden，锁中性化「像素等价」（INV-3）。**注意 jsdom 锁不住 virtuoso 真虚拟化**（行回收/windowing/tail），故 virtuoso 关键行为（`tests/requests-virtuoso.poc.vitest.test.tsx` 沿用 VirtuosoMockContext）**另立契约测试**，真虚拟化保真需 e2e/PoC 级验证（`no-auto-server` 下由用户启动验证，记为手动 UX 检查项）。
5. **INV-4 纳入 bun 测试**（v1 漏）：每 commit `typecheck:ui-v4` + `build:ui-v4` + vitest 66 + **bun 27** 全绿。

## 9. 风险与缓解

- **R1 逻辑层被污染**：中性化误在 A/A′/B 引入 `designVersion` 分支。**缓解**：INV-1；每 commit grep 守卫（`grep -rn designVersion src/lib src/hooks src/stores src/components/detail`）。
- **R2 中性化「像素等价」被打破**（INV-3 对 legacy）：C2/C3/C4 若语义 token 在 `amber-legacy` 下未解析回等价 amber 值 / 作用域化漏加 `data-design` → legacy 树视觉漂移。**缓解**：golden 预捕获（W5）在中性化前锁 legacy 渲染，中性化后须仍过；每中性化 commit 双 preset 各跑测试。
- **R3 双树双挂/闪烁**：三 fork 点任一双挂。**缓解**：INV-2；三 fork 点各配互斥挂载守卫测试；手动 UX 边界确认。
- **R4 切换丢常驻态**：开关误置于 AppShell L0 之上重挂订阅。**缓解**：INV-FIDELITY-1（§5b）+ AppShell 存在性守卫测试断言 fork 在 L0 之下。
- **R5 B↔C 边界未解耦**：B 内容体硬绑某 C primitive → 无法服务两树。**缓解**：审计 grep B 目录对 `shared/*` import + amber class，按「B↔C 边界」二法解耦（§2）。
- **R6 bundle 膨胀 + lint 缺口**：shadcn + lucide 增体积（PoC 基线 272KB/86KB，远轻于 antd 920KB）；ui-v4 缺 react-hooks/jsx-a11y lint（backlog 已记）。**缓解**：每 commit `build:ui-v4` 实测体积对账；迁移中顺带启用 ui-v4 lint。
- **R7 虚拟列表回归**：`react-virtuoso` 6 处，shadcn 化行渲染不得破坏虚拟化。**缓解**：VirtuosoMockContext 测试沿用 + virtuoso 真行为 e2e/PoC 级契约（§8.4）。
- **R8 公共详情容器跨页耦合**：C7 制造 Requests↔Models 依赖。**缓解**：C7 独立成 commit 排在 P2/P4 之前，两页只依赖已稳定的 `DetailContainer`，恢复逐页并行。

## 10. 范围外

- 不改后端、不改 `~backend/*` 契约、不改数据/WS 协议。
- 不改可视化算法（diff / SSE 累积 / shiki 分词逻辑）——只把 shiki 主题从单一改双主题。
- compact 密度（决策 4 未来项）、双入口 peek（backlog 形态 C，前置：形态 A 落地）不在本次；`DetailContainer`（C7）为 peek 预留复用点、但 peek 本身 defer。
- OQ-4（旧树保留期限）到收尾前再定。

## 11. 验证

- **golden 预捕获**（§8.4）：中性化前锁 virtuoso 行为、详情 segment 渲染、关键页 `toMatchSnapshot`；中性化/作用域化后须仍过（锁 `amber-legacy` 像素等价）。
- 每 commit：`typecheck:ui-v4` + `build:ui-v4`（bundle 体积对账，基线 272KB/86KB）+ vitest 66 + bun 27（INV-4）。
- **手动 UX 检查**（`no-auto-server`，用户启动）：每 commit 边界确认 `designVersion` 两版各自完整、无三 fork 点双挂闪烁；virtuoso 真虚拟化滚动/回收保真；切换保留 WS 快照/在飞请求（§5b）。
- 收尾（Z1）：whole-domain audit + DESIGN.md「活的架构现状」/§2/§8 同步 + 对抗 subagent review。

---

## 附:v2 对 review round1 逐条处置表

| # | round1 判定 | v2 处置 | 落点 |
|---|---|---|---|
| **F1** | 地基:Tailwind v4 无「shadcn init 直跑」、引第二套 Radix、`@theme inline` 冲突 | **PoC 证伪、降 WARN**：shadcn 在 v4 原生跑通、用统一 `radix-ui` 无第二套、`@theme inline` 与现有 `@theme` 共存、`tw-animate-css` CLI 自动处理；仅剩锐角作用域化 + token 桥接两处理项（已排 C4/C1） | §1 前置证据、§3、C0-C1-C4 |
| **F2** | 切换作用点错位:App.tsx 单例 router，AppShell 管不到 Outlet 页壳 | **v2 亲手核实源码后重定切换作用点**：单 router 不变，常驻 AppShell L0 之下设**三 fork 点**（chrome / 每个页元素 / LiveDock 呈现层）；否定「换两套 router」（会重挂 L0 丢快照）；INV-2 下沉到三 fork 点 | §5、§6 INV-2、C6 |
| **F3** | 新树零测试:66 vitest+24 bun 全绑 legacy、断言硬编码 amber | **实测修正严重度**：断言实为 371 getByText/142 getByRole 主导，**仅 8 文件断颜色**；策略=8 处改语义 token/role 断言 + D 层参数化 `designVersion` 一套测两树 + 收尾先验 shadcn 分支绿再删 legacy 分支 | §8（全节）、C6/C7 守卫测试 |
| **F4** | B 类非 design-agnostic:detail/ 152 `--color-*`+29 hex，与「B 不动」矛盾 | **v2 重划分类**：新增 A′ 类 + B 中性化为一等前置阶段（C3）；亲手复核计数**修正为 127+42**；B 经中性语义 token 后才两版共用 | §2 B 类、§3 第 2 层、C3、INV-1 |
| **F5** | A 类「零改动」虚假:request-columns/vendor-color/model-status/shiki 单主题 | **新增 A′ 类**专收这些设计耦合 lib（逐个 file:line 确认:request-columns 返 ReactNode+amber、vendor-color 4 hex、model-status colorVar、shiki `themes:[AMBER_THEME]`）；C2 一次性中性化 + shiki 双主题 | §2 A′ 类、§3 第 3 层、C2 |
| **F6** | INV-3「视觉零变化」与 `theme.css:29 *{border-radius:0!important}` 冲突 | **作用域化立为一等 commit（C4）**:`*{…!important}` → `[data-design=amber-legacy] *{…}`（含 `.livedock-island` 2px 例外）；amber-legacy 加 `data-design` 后像素等价、shadcn 树按 `--radius` 出圆角；PoC 已确认此为低风险机械项 | §1、C4、R2 |
| **W1** | §2「C 单份」改了 ADR 决策 9、与 OQ-1「旧树冻结」矛盾 | **撤销「C 单份 token 驱动」表述**:据 OQ-1，C 类过渡期**双份**（旧 `shared/*` 冻结 + 新 `components/ui/*`），确认 ADR 决策 9 原文正确 | §2 C 类、§7 OQ-1 决议 |
| **W2** | LiveDock 已全局化（AppShell:31）RFC 当待办放错;Models 共享抽屉制造跨页依赖破坏逐页并行 | **核实 LiveDock 已在 AppShell:31**（P2 只剩样式、非结构待办）；**公共详情容器抽取独立成 C7**（实测 ModelDetail 不复用 DetailPanel，`grep -c==0`），排在 P2/P4 之前恢复并行 | §2 D 类、C7、P2、R8 |
| **W3** | §2 遗漏 DiagnosticBar/MessageBlock/ConversationView/toc/*/*Button/*Modal | **逐个归位**:DiagnosticBar/MessageBlock/ConversationView/DetailTocTree→B；TocSidebar→D；ToolJumpButton/JsonModalButton/ExportButton/BlockJsonModal→B 内容旁交互 chrome（B↔C 边界处理） | §2「W3 遗漏组件归位」+「B↔C 边界」 |
| **W4** | 切换丢运行态:WS 一次性快照/滚动/virtuoso 位置随卸载归零 | **并入 F2 切换作用点后定**:常驻 AppShell L0 保 WS 快照/live-store/query 缓存/URL；页局部态（滚动/virtuoso/segment tab）切换重置=可接受（OQ-4 收尾即删，不做持久化）；INV-FIDELITY-1 强制不重挂 L0 | §5b、§6 INV-FIDELITY-1、R4 |
| **W5** | golden 基建为零（无 toMatchSnapshot）;jsdom 锁不住 virtuoso 真虚拟化;INV-4 漏 bun | **golden 从零建**（中性化前锁关键内容体/segment/页）+ **virtuoso 真行为另立 e2e/PoC 级契约**（jsdom 只测 mock 行为）+ **INV-4 纳入 bun 27** | §8.4、§8.5、§6 INV-4、§11 |
| **W6** | 僵尸 `theme:light/dark/system` 未处置，与 designVersion+preset 三态混淆 | **v2 地基 commit 直接删** `theme`/`setTheme`/`ThemeMode` + TopBar 按钮（实测死代码:只切 label 无消费者），代之以 `designVersion`（过渡）+ `colorPreset`（永久）两正交字段 | §3「僵尸字段处置」、C0 |

**未采纳 / 存疑**（round1「未采纳」栏对应）：
- round1 无 reviewer 建议被否决（均证实）。v2 唯一对 reviewer 的**修正**:F3 严重度与 F4 计数——reviewer 称「66 vitest 全绑 legacy、断言硬编码 amber」，v2 实测仅 8 文件断颜色、其余 role/text 驱动，故「一套测两树」比 reviewer 隐含的「新树几乎从零补测」乐观；F4「152+29」实测为「127+42」（代码已演进，量级结论不变）。二者均**放大了工作量估计**，v2 据实下调但不改架构方向。
