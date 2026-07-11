# 实施计划: ui-v4 shadcn 重设计 — 逐页阶段 (P1-P8) + 收尾 (Z1)

- 状态: **Draft-for-execution**（据 RFC v3 `../rfc/2026-07-10-shadcn-redesign/design.md` §4 逐页阶段 + Z1 派生；架子 C0-C7 已全部 merge，HEAD `d98009bb`）。
- 日期: 2026-07-11
- 范围: **逐页 P1-P8（每页把 shadcn 侧从骨架填成完整，legacy 侧冻结不动）+ 收尾 Z1（架子退场）**。架子先行阶段 C0-C7 见 `2026-07-10-shadcn-redesign-scaffold.md`（已实施）。
- 派生自: RFC v3（Approved-for-planning）§4「逐页阶段」+「收尾阶段」、§2 五类分类、§5 三 fork 点、决策 5/6/7/8/10/11。
- 方法论: skill `large-refactor`（commit invariants + 过渡态显式无害 + golden 预捕获）、`superpowers:test-driven-development`、`superpowers:subagent-driven-development`。
- 裁判轴: **长远正确 + 完整**（非 ROI/YAGNI）。逐页只填 shadcn 侧、legacy 冻结；每页做成真正可用（`think-proactively`），不以「最小能交付」砍范围。

---

## 前置：架子落地现状（读真实代码核实，非 RFC 转述）

C0-C7 已全部 merge，逐页阶段建于这套**真实 API** 之上（实现者据此填页，勿再造脚手架）：

| 架子产物 | 真实位置 | 逐页如何用 |
|---|---|---|
| **fork 原语** `DesignFork` | `src/components/shell/DesignFork.tsx`（唯一 `store.designVersion` 读取者，除 `stores/ui-store` + `lib/data-design`） | 每个 RoutePage 内 `<DesignFork legacy={<XLegacy/>} shadcn={<XShadcn/>}/>` 互斥挂载。**页壳文件自身不出现 `designVersion` 标识符** → B/A′ 域 grep 守卫零命中。 |
| **9 个 shadcn primitive** | `src/components/ui/{button,input,select,dialog,tabs,badge,slider,popover,dropdown-menu,collapsible}.tsx` | 逐页 shadcn 侧 import 之，`shadcn add X` 增量接入。 |
| **水平 Tabs primitive**（决策 10） | `src/components/ui/HorizontalTabs.tsx`（`{value,label,content}[]` + `listVariant:"default"|"line"` + 受控/非受控；底层 `ui/tabs.tsx` 的 `TabsList` 已有 `line` cva 变体） | P3（Requests 详情 7 段）+ P4（Models 抽屉 6 tab）各自嵌入，竖→横。**不含 Dialog/portal/resize/focus-trap**（抽屉 chrome 各自实现）。 |
| **dialog seam** `AgnosticDialog` | `src/components/ui/AgnosticDialog.tsx`（唯一消费者 `detail/BlockJsonModal.tsx`；**当前恒委派 legacy `shared/Modal`**，`designVersion` fork 明确 **defer 到本阶段 = P4**） | P4 在此文件内加 `designVersion` fork（读 store + 挂 shadcn `Dialog` vs legacy `Modal`），**不碰任何 B 文件**（seam 在 `ui/` 域，允许读 `designVersion`）。契约锁死：`title`/`onClose`/`data-testid=modal-backdrop`。 |
| **shadcn chrome 骨架** | `shell/shadcn/{ShadcnChrome,ShadcnNavRail(w-52+lucide),ShadcnTopBar(搜索占位+WS+DesignVersionToggle),ShadcnLiveDock}.tsx` | 逐页打磨（P2 LiveDock 呈现层、P7/P8 搜索接线等）在此填充。 |
| **fork B 范式 = 逐页模板** | `overview/OverviewPage.tsx`（薄 `DesignFork` wrapper）+ `overview/OverviewLegacy.tsx`（C6 前原样搬来、冻结）+ `overview/OverviewShadcn.tsx`（Card 骨架，P1 填完整） | **P2-P8 复刻此三件套形态**：RoutePage 提取 body → `XLegacy`（冻结）、新建 `XShadcn`、RoutePage 变薄 `DesignFork` wrapper。 |
| **切换控件** `DesignVersionToggle` | `shell/DesignVersionToggle.tsx`（两版 TopBar 各嵌一个，双向可达） | 不改。 |
| **AppShell L0**（常驻） | `shell/AppShell.tsx`（`useWs`/`useLiveRequests`/`<LiveDock/>` 挂载；本体零 `designVersion`；fork A/C 已在此） | 不改（INV-FIDELITY-1 结构隔离已成立）。 |

**关键现状差异（勿凭 RFC/scaffold-plan 数字，见文末「与真实代码核实发现的差异」）**：
- **只有 Overview 页已做过 fork B 提取**（`OverviewLegacy` 存在）；**P2-P8 每页第一步都要先提取 legacy**（rename body → `XLegacy`，RoutePage 变 `DesignFork` wrapper）。
- **测试基数已漂移**：INV-4 引用的「vitest 66 + bun 27」是架子先行前的旧数；实测 HEAD = **77 vitest（70 `.tsx` + 7 `.ts`）+ 25 bun = 102**。故本 plan INV-4 一律表述「vitest + bun **全绿**」，不锁固定条数。
- **master 列配置特性已 merge 进 legacy Requests**（dnd-kit 重排 + `columnSizing` resize + `columnOrder` + 版本化 `useColumnState`）——见 P2 专节，shadcn 侧列表必须接同一套。

---

## Global Constraints（实现者红线，每 Task 通用，不重述）

1. **逐页只填 shadcn 侧，legacy 冻结不动**。每页 shadcn 侧是**新代码**；legacy 页壳/chrome/detail 容器/`shared/*` 一律零改动，**Z1 才删**。撤销自己刚做的编辑用**重新编辑**而非回退（`no-destructive-workspace-loss`）。
2. **`designVersion` 只允许出现在 D-shell / chrome / dock / fork 原语 / dialog seam**（`shell/`、`ui/DesignFork`、`ui/AgnosticDialog`）。**绝不进** A（`lib`/`hooks`/`stores`）、A′（已升 A）、B（`detail`/`tools`/`common`/`models/detail-tabs`/`learned`/`sessions`/`overview` 内容体）。每 Task 跑 grep 守卫（见约束 6）。
3. **INV-4 四绿（每 commit 硬门）**：
   - `bun run typecheck:ui-v4`
   - `bun run build:ui-v4`（含 bundle 体积对账，PoC 基线 JS 272KB / gzip 86KB；shadcn 侧新页会增体积，膨胀需在 commit message 记录）
   - `bun run test:ui-v4`（= `test:bun && test:vitest`；vitest + bun **全绿**，不锁固定条数）
   - 单文件 lint 用**无缓存** `bunx eslint <path>`（`lint` 带 `--cache` 假绿；ui-v4 现有 `react-hooks`/`jsx-a11y` 规则，shadcn 侧新交互组件必须过 a11y）。
4. **INV-1..4 + INV-FIDELITY-1 仍守**（逐页只影响 shadcn 侧新代码）：
   - **INV-1**：A/A′/B 零 `designVersion`、零新颜色字面量（颜色只经 C1 建的语义 token `--content-*`/`--signal-*`/`--vendor-*`/`--surface-*`）。
   - **INV-2**：`designVersion` 在 chrome / **每个页元素** / LiveDock 呈现层三 fork 点各互斥挂载一棵（本阶段主要作用于 fork B 页元素）。
   - **INV-3**：每 commit 两版都可运行且自洽——`amber-legacy` **像素等价**（legacy 冻结，天然成立）、`shadcn` 版渐进完善；中间态绝不半坏。
   - **INV-4**：四绿（上）。
   - **INV-FIDELITY-1**：切换 `designVersion` 不重挂 AppShell L0（架子已结构隔离；逐页不得在页元素之上引入新的 `designVersion` gate）。
5. **shadcn 侧复用 A/A′/B**：shadcn 页元素 import **中性化后的 B 内容体**（`detail/segments/*`、`StatCard`、`JsonTreeView`、`LearnedRow`、`SessionRow`…）+ **A/A′ 数据/构建器**（`useColumnState`、`REQUEST_COLUMNS`、`vendorColor`、`modelStatus`…）；只重写 **D-shell 呈现层**（页壳/chrome/filter/column-menu/detail 容器）。不复制逻辑层与算法层。
6. **grep 守卫（每 commit）**：`grep -rn designVersion src/lib src/hooks src/stores src/components/detail src/components/tools src/components/common src/components/models/detail-tabs src/components/learned src/components/sessions src/components/overview` **零命中**（`shell/`、`ui/`、`requests`/`models` 的 D-shell 页壳除外，但 shadcn 页壳文件本身仍应零 `designVersion`——读取只在 RoutePage 的 `DesignFork` 里）。
7. **fork-routed 测试（§8.2）**：D 页壳/chrome 测试**从「leaf-import legacy 组件」重写为「fork-routed 渲染」**——渲染路由/页元素，由 `designVersion` 决定挂哪棵，再在 `role`/`testid`/语义 token 层断言。参照架子已落地范式 `tests/DesignVersionForks.vitest.test.tsx`（`MemoryRouter` + `Routes` + `act(() => useUiStore.getState().setDesignVersion(...))` + `queryAllByTestId(...).toHaveLength(1)` 互斥断言）。**colorPreset 翻转（CSS，B/A′）与 designVersion 翻转（换组件树，D）是两回事，勿混。**
8. **no-auto-server**：绝不跑 `dev`/`start` 或任何启服务器命令；运行期行为记为**手动 UX 检查项**交用户启动。逐页会遇到 UX 决策（观感/密度/信号色）→ 标为**「交用户 UX 检查项」**，别擅自定。
9. **细粒度 pathspec 提交**：一律显式 `git add -- <精确路径>` / `git commit -F <msgfile> -- <精确路径>`；每语义单元一提交；conventional commits；不加模型署名。本仓库无 pre-commit 门禁。
10. **隔离 worktree（不动 master）**：实现在 `.worktrees/shadcn-redesign/`（分支 `feat/ui-v4-shadcn-redesign`）；最终提交用 pathspec 免疫 peer 并发 `git add` 的 index race。→ skill `git-preference:isolating-from-a-shared-git-worktree`。
11. **命令/锚点路径**：本 plan 全部 `file:line` 相对 `ui-v4/`（如 `src/components/requests/RequestsListPage.tsx:26`）。根命令带 `:ui-v4` 后缀。

---

## 逐页 backlog 项分派（累积待办 → 落到具体 Task）

| backlog 项 | 分派 | 说明 |
|---|---|---|
| **B 目录 grep 守卫自动化** | **P1 首做** | 把 Global Constraint 6 的 grep 固化为一个 vitest/bun 守卫测试（`tests/design-version-scope-guard.*.test.ts`），扫 A/A′/B 目录源码零 `designVersion`。P1 建，后续每页天然复用（不再靠人肉 grep）。 |
| **dialog seam fork** | **P4** | `ui/AgnosticDialog.tsx` 加 `designVersion` fork（shadcn `Dialog` vs legacy `Modal`），锁 `title`/`onClose`/`data-testid=modal-backdrop` 契约。BlockJsonModal 是唯一消费者，随 P4（Models 抽屉也用 Dialog）一并做，或提前到任何用到 modal 的页——归 P4。 |
| **listVariant 派生** | **P3（首用）** | `HorizontalTabs` 已有 `listVariant:"default"|"line"` prop + `ui/tabs.tsx` `line` cva 变体；P3 Requests 详情 7 段横排用 `line` 变体、P4 Models 抽屉用 `default`。**已存在，无需新建**，只在消费点选变体（若观感需第三变体，P3 扩 cva）。 |
| **live 信号绿-琥珀 UX 决策** | **P2（交用户 UX 检查项）** | ShadcnLiveDock/HistoryList 行的 live/streaming/retry 信号用绿还是保留琥珀强调——`neutral` preset 下的信号色选择是 UX 取舍，**标为交用户**，plan 不擅自定（默认走 C1 的 `--signal-live`/`--signal-ok`，具体色值待用户 UX 检查）。 |

---

## 阶段依赖与顺序

```
P1 Overview（首建 grep 守卫自动化）──┐
                                     ├─ P2 Requests（列表+形态A详情+prev/next+?at+LiveDock 呈现层）──┐
                                     │                                                                 ├─ P3 Requests 详情（HorizontalTabs 7 段）
                                     │  P4 Models（详情抽屉 HorizontalTabs 6 tab + dialog seam fork）──┘
                                     ├─ P5 Sessions ─ P6 Config ─ P7 Learned ─ P8 Tools（各页壳，天然可并行）
                                     └────────────────────────────────────────────────────────────────
Z1 收尾（触发条件 OQ-4 待用户定；不阻塞 P1-P8）
```

- **P1 首做**：建立 grep 守卫自动化 + 打磨 fork B 范式（Overview shadcn 骨架已在，最快闭环，给后续页当模板）+ 默认路由改 `/overview`。
- **P2/P3/P4 有序**：P3（Requests 详情）依赖 P2 建的 shadcn Requests 页壳与选中/导航；P4（Models 抽屉）复用 `HorizontalTabs`（已落地）+ P4 内做 dialog seam fork。P2 与 P4 都消费 `HorizontalTabs`（已落地，无阻塞）。
- **P5-P8 天然可并行**（各页独立域，import 中性化 B + C primitive）；可分派并行 subagent。
- **Z1 最后**，触发条件（所有页迁完即删 vs 留验证期）= **OQ-4，待用户定**，plan 标注待定、不阻塞 P1-P8。

---

## Task P1 · Overview（默认页切换 + fork B 范式打磨 + grep 守卫自动化）

> **实施状态: DONE**(commit `add4f520`,分支 `feat/ui-v4-shadcn-redesign`)。OverviewShadcn 填成完整(6 项健康指标 parity + Server info 深度段 + 真 `/metrics` 链接);默认路由 `/overview`(App.tsx export `routes`);grep 守卫**改为 fail-closed**(扫全 src / 全中性面、只排除有界合法者,逐页天然覆盖)——采纳 subagent review 的 fail-open→fail-closed 建议,经 mutation 实测有效。新增 shadcn `ui/card.tsx`。INV-4 四绿(bundle 1040.51KB)。交用户 UX 检查项见文末。


- **对应 RFC/决策**: §4 P1、决策 6（默认页 `/requests`→`/overview`）、fork B 范式（`OverviewPage`）。
- **目标（commit 终态）**: `OverviewShadcn` 从 Card 骨架填成完整 Overview（in-flight / rate-limiter / quota / active / history-entries + 深度指标呈现或 Grafana 指引）；默认路由改 `/overview`；建立 B/A′/B 域 `designVersion` grep 守卫自动化测试。**legacy `OverviewLegacy` 零改动。**
- **commit invariant**: INV-1（`overview/` 零 `designVersion`/颜色字面量——`StatCard` 已在 C3 中性化，shadcn 侧只用语义 token class）；INV-2（`OverviewPage` fork B 互斥挂载）；INV-4 四绿。

### 改动 file 锚点

- `src/components/overview/OverviewShadcn.tsx`（现 C6 骨架，`:9-41`）：填成完整——复用 `useStatus`/`useLiveStore`（同 legacy 数据源），shadcn `Card`/`Badge` 呈现，中性语义 token（`text-foreground`/`bg-card`/`border-border`/`--signal-*`）。深度分析入口（Grafana `/metrics` 指引，`:36-38` 占位）填成真链接或说明。
- `src/App.tsx`（`:28-33` index route `<Navigate to="/requests" replace/>`）：改默认 `to="/overview"`（决策 6）。**注意**：此改动对两版都生效（router 不 fork），是全局默认页变更，非 shadcn 专属——写进 commit message。
- **新增** `tests/design-version-scope-guard.vitest.test.ts`（或 `.bun.test.ts`）：读取 A/A′/B 目录源码文件（`fs.readFileSync` 遍历 Global Constraint 6 的目录列表），断言无 `designVersion` 标识符出现。**正样本自证**：先在测试里放一个已知含 `designVersion` 的 `shell/` 文件断言「若扫 shell 会命中」，证守卫触达目标，再断 B 域零命中。
- `src/components/overview/OverviewLegacy.tsx`：**零改动**（冻结）。

### TDD 步骤

1. **写 grep 守卫自动化测试**（红→绿）：先证正样本（扫 `shell/AppShell` 之外含 designVersion 的文件命中）、再断 A/A′/B 零命中。此测试后续每页复用。
2. **写默认路由测试**（红）`tests/default-route.vitest.test.tsx`：`MemoryRouter initialEntries={["/"]}` → 渲染断落到 Overview（`getByText`/testid），非 Requests。
3. **写 OverviewShadcn fork-routed 测试**（红）：`designVersion=shadcn` 下 `OverviewPage` 渲染完整卡片（断 `getByText("In-flight")` 等 + 语义 token class / role），`=amber-legacy` 挂 `OverviewLegacy`。
4. **填 `OverviewShadcn` + 改 `App.tsx` 默认路由**（绿）。
5. INV-4 四绿 + grep 守卫绿。

### 验收 gate

- INV-4 四绿；grep 守卫自动化测试绿（正样本自证 + B 域零命中）。
- 默认页 `/overview`（两版）。
- **交用户 UX 检查项**：shadcn Overview 卡片密度/信息层级观感；深度指标呈现 vs Grafana 指引取舍。

### 提交指引

```
git add -- ui-v4/src/components/overview/OverviewShadcn.tsx ui-v4/src/App.tsx ui-v4/tests/design-version-scope-guard.vitest.test.ts ui-v4/tests/default-route.vitest.test.tsx ui-v4/tests/OverviewPage.vitest.test.tsx
git commit -F <msg> -- <上述路径>
```
`feat(ui-v4): flesh out shadcn Overview + default to /overview + designVersion scope guard`

---

## Task P2 · Requests（列表 + 形态 A 整页详情入口 + prev/next + ?at 返回定位 + LiveDock 呈现层）

> **实施状态: DONE**（4 子 commit,分支 `feat/ui-v4-shadcn-redesign`,HEAD `aece8521`）。
> ① `c6fd8247` 提取 `RequestsListLegacy`(逐字冻结)+ `RequestsListPage` 变薄 `DesignFork` wrapper。
> ② `6eab9d38` `RequestsListShadcn` 完整壳 + 重接 master 列配置三态(`useColumnState`/`REQUEST_COLUMNS`/`reorderColumns` 共用数据层 + 自持 `DndContext`)；新 `HistoryListShadcn`(**虚拟化容器 fork 决策 = 选 A**:保 `TableVirtuoso`、`FakeTableVirtuoso` 契约沿用;中性化 + shadcn `Dialog` 替 `Modal`;逐字同构 legacy 的 `?at` 定位/load-until-found/键盘 roving/session 色带/清空)；新 shadcn D-shell:`RequestsFilterBarShadcn`/`RequestFilterChipsShadcn`/`RequestsColumnMenuShadcn`/`SessionPaletteSelectShadcn`/`DateRangePopoverShadcn`;theme.css 加 `.rdp-neutral` 皮肤(作用域化 `[data-design=shadcn]`)。行点击 → 整页详情(形态 A);`?at=` 返回定位复现。
> ③ `6f1b9e78` 新 A 类 `useRequestNeighbors`(design-agnostic prev/next hook,决策 5 新特性;P3 详情 chrome 消费)。
> ④ `aece8521` `ShadcnLiveDock` 填成完整(展开分组明细 `LiveGroupShadcn` + tail 开关 + 待合入 CTA + Escape,读同一 live-store)。
> INV-4 四绿(每子 commit):typecheck / build(index 1071.18KB,基线 1040.82KB,+30KB shadcn 列表+dock)/ test(481 全绿:新增 RequestsListShadcn 9 + useRequestNeighbors 11 + ShadcnLiveDock 6)/ eslint 无缓存;grep 守卫绿。**交用户 UX 检查项见文末**:live 信号绿/琥珀(未擅改 SIGNAL_COLOR 源值)、列表密度/resize 手感、virtuoso 真虚拟化保真、LiveDock 展开面板观感、prev/next 键位(j/k vs Arrow)、`.rdp-neutral` 日历皮肤观感。legacy Requests 全套零改动。

- **对应 RFC/决策**: §4 P2、决策 5（形态 A 整页详情 + prev/next + `?at` 返回定位）、决策 7（LiveDock 呈现层 shadcn 化，结构已在 AppShell）、**master 列配置特性**（见下专节）。
- **目标**: shadcn 侧完整 Requests 列表页——筛选工具条 + 活动 chips + 虚拟化 History 列表（**接 dnd 重排 / resize / columnOrder / 列可见性**）+ 行点击进整页详情 + `?at=id` 返回定位 + prev/next 键盘快捷键 + `ShadcnLiveDock` 呈现层填成完整。**legacy Requests 全套冻结。**
- **commit invariant**: INV-1（`RequestRow` 内容体已 C3 中性化，零 `designVersion`；新 shadcn 列表壳属 D，`designVersion` 只在 RoutePage fork）；INV-2（`RequestsListPage` fork B）；INV-FIDELITY-1（LiveDock 呈现层读同一常驻 `live-store`，切换不丢在飞请求——`ShadcnLiveDock` 已如此）；INV-4 四绿。
- **可拆子 commit**：列表壳 / 详情入口+prev-next+?at / LiveDock 呈现层 / 列配置接线，各独立四绿。

### master 列配置特性对 P2 的影响（读真实代码核实，一等约束）

master 已 merge 进 **legacy** Requests（`RequestsListPage.tsx` 现状）：`@dnd-kit/{core,modifiers,sortable}` 列头拖拽重排 + TanStack `columnSizing` 手柄 resize + `columnOrder` + 版本化 `useColumnState`（`src/hooks/useColumnState.ts`，单键 `COLUMN_STATE_KEY` v1 持久化）。数据/构建器层是 **design-agnostic**：
- `src/hooks/useColumnState.ts` = **A 类**（三态 visibility/sizing/order + merge 纯函数），两树共用。
- `src/lib/request-columns.ts`（`REQUEST_COLUMNS` `:124`、`REQUEST_COLUMN_IDS` `:280`、`DEFAULT_COLUMN_ORDER` `:292`、`reorderColumns`、`SIGNAL_COLOR` `:57` 已 C2 中性化到 `--signal-*`）= **A′→A**，两树共用。
- 呈现层 `HistoryList`（TanStack `TableVirtuoso` `:37`，`at`/`flashId`/`focusedId`/`tabStopId` context `:87-99`）、`RequestsColumnMenu`（`order` prop `:11`、dnd-aware 菜单）、`RequestsFilterBar`、`RequestFilterChips` = **D-shell legacy，冻结**。

**P2 shadcn 侧必须重新接线这套**：shadcn 列表壳自己 `useColumnState()` + 包 `DndContext`（`PointerSensor` distance:4 + `restrictToHorizontalAxis`，同 `RequestsListPage.tsx:30-33`）+ 渲染 shadcn 列头（可重排 + resize 手柄）+ 消费 `REQUEST_COLUMNS`/`columnOrder`/`columnSizing`。**这是 P2 的最大工作量块**，勿低估。

**虚拟化容器的 fork 决策（§8.5，交用户/实现者裁）**：
- **选 A（推荐，长远最小分歧）**：shadcn 列表**保留 `TableVirtuoso`**、只换呈现（shadcn 表格 class + 中性 token）→ `tests/RequestsListPage.vitest.test.tsx:52-78` 的手写 `FakeTableVirtuoso` 契约（`forwardRef` + 硬编码 `<thead>`/`<tbody>`/`TableRow`）**可沿用**。
- **选 B**：换其它虚拟化容器/行结构 → `FakeTableVirtuoso` 硬编码契约**不可迁**，须为新容器**新建契约测试**。
- **记为实现者裁决点**（选 A 除非有强观感理由换容器）；virtuoso 真虚拟化（行回收/windowing/tail）需手动 UX/PoC 级验证（`no-auto-server`）。

### 改动 file 锚点

- **提取 legacy（第一步）**：`src/components/requests/RequestsListPage.tsx`（现 `:20-74` 是 legacy body）→ rename body 为 **`RequestsListLegacy`**（新文件 `requests/RequestsListLegacy.tsx`，逐字搬、冻结），`RequestsListPage` 变薄 `DesignFork` wrapper（`legacy={<RequestsListLegacy/>} shadcn={<RequestsListShadcn/>}`）。`dont-lose-history`：先提交 rename（move），再新增 shadcn。
- **新增** `src/components/requests/RequestsListShadcn.tsx`：完整 shadcn 列表壳——`useColumnState` + `DndContext` + shadcn filter bar + chips + 虚拟化列表（选 A 复用 `TableVirtuoso`）。行点击 → `navigate('/requests/:id')`（同 legacy 行为，进整页详情 = 形态 A）。
- **新增** `src/components/requests/{RequestsFilterBarShadcn,RequestFilterChipsShadcn,RequestsColumnMenuShadcn}.tsx` 等 D-shell shadcn 呈现（用 `ui/{select,dropdown-menu,popover,badge}`）。行内容体 `RequestRow`（B，已中性化）**两树共用**、不重写。
- **详情入口 + 返回定位（决策 5）**：`?at=id` 返回定位**已在 legacy 实现**（`RequestDetailPage.tsx:31-33` `/requests?at=<id>` + `HistoryList` 的 `at` context `:89` + `selectionClass` `:126`）——shadcn 列表壳须**同样消费 `?at=` 选中/滚动定位**（读 `useSearchParams` 的 `at` → 定位/高亮行），复现该行为于 shadcn 列表。
- **prev/next 快捷键（决策 5，新特性）**：**核实 legacy 无 prev/next 详情导航**（grep 仅 `useResizableWidth` 的 ArrowLeft/Right）——P2/P3 **新增**。建议抽 design-agnostic hook `src/hooks/useRequestNeighbors.ts`（A 类：据当前列表顺序/filter 算 prev/next id），shadcn 详情页/列表消费；ArrowUp/Down 或 j/k 在列表移动焦点、Enter 进详情，详情内 prev/next 切相邻条目（P3 详情内也用）。**新 hook 属 A，零 `designVersion`**。
- **LiveDock 呈现层（决策 7）**：`src/components/shell/shadcn/ShadcnLiveDock.tsx`（现 `:18-43` 最小 idle/在途摘要条）→ 填成完整（展开面板 / tail 控件 / 分组明细，对齐 legacy `LiveDock`/`LiveGroup` 能力）。**结构已在 AppShell fork C**（读同一 `live-store`），仅呈现层。**live 信号色 = 交用户 UX 检查项**（绿 vs 琥珀）。

### TDD 步骤

1. **提取 legacy + fork wrapper**（先提交这步）：rename → `RequestsListLegacy`，`RequestsListPage` = `DesignFork`；跑现有 `RequestsListPage.vitest.test.tsx`（若 leaf-import legacy 组件，改为 fork-routed 或指向 `RequestsListLegacy`）。
2. **写 fork-routed 列表测试**（红）：`designVersion=shadcn` 渲染 shadcn 列表（断行/列头 role + 列可见性菜单 + `?at=` 高亮），`=amber-legacy` 挂 legacy。用 `FakeTableVirtuoso`（选 A 沿用）+ `ResizeObserver` stub（`setup.ts:11-17`）+ `initialItemCount`。
3. **写列配置接线测试**：shadcn 列表 dnd 重排 → `reorderColumns` → `useColumnState.setOrder`；resize → `columnSizing`；toggle → visibility。断三态通到 shadcn 表。
4. **写 prev/next hook 测试** `tests/useRequestNeighbors.vitest.test.ts`（A 类纯函数：给定顺序 + 当前 id → prev/next id，边界 null）。
5. **写 ShadcnLiveDock 呈现测试**：读 `live-store` byId 渲染在途摘要/展开（fork-routed，dock-shadcn testid 已在）。
6. **实现** shadcn 列表壳 + filter/chips/column-menu shadcn + prev/next hook + LiveDock 填充（绿）。
7. INV-4 四绿 + grep 守卫（`requests/` 的 B `RequestRow` 零 `designVersion`；shadcn 壳文件本身零 `designVersion`）。

### 验收 gate

- INV-4 四绿；grep 守卫绿。
- shadcn 列表：列可见性/重排/resize 三态可用（TDD 证）；`?at=` 返回定位复现；prev/next 快捷键工作。
- fork-routed 测试两版各自完整。
- **交用户 UX 检查项**：live 信号绿/琥珀；shadcn 列表密度/列头 resize 手感；virtuoso 真虚拟化滚动/回收保真；LiveDock 展开面板观感；prev/next 键位（j/k vs Arrow）。

### 提交指引（多子 commit 示例）

```
git add -- ui-v4/src/components/requests/RequestsListLegacy.tsx ui-v4/src/components/requests/RequestsListPage.tsx ui-v4/tests/RequestsListPage.vitest.test.tsx
git commit -F <msg> -- <上述>   # extract legacy + fork wrapper
```
`refactor(ui-v4): extract RequestsListLegacy + DesignFork wrapper (freeze legacy)` /
`feat(ui-v4): shadcn Requests list with column config (dnd/resize/order) + ?at positioning` /
`feat(ui-v4): request neighbor prev/next keyboard nav (design-agnostic hook)` /
`feat(ui-v4): flesh out ShadcnLiveDock presentation layer (decision 7)`

---

## Task P3 · Requests 详情（DetailPanel 竖排 sub-rail → 顶部水平 Tabs）

> **实施状态: DONE**（3 子 commit,分支 `feat/ui-v4-shadcn-redesign`,HEAD `c095e867`）。
> ① `7654b115` 提取 `RequestDetailLegacy`(原 RequestDetailPage body 逐字冻结:竖排 sub-rail + 返回 + Esc)+ `RequestDetailPage` 变薄 `DesignFork` wrapper + `RequestDetailShadcn` 骨架(`data-testid=request-detail-shadcn`)。
> ② `763fa237` `DetailPanelShadcn`(新 D-shell):`HorizontalTabs`(`line` 变体)顶部水平 7 段替 legacy `Tabs.Root orientation=vertical` + `DetailSubRail`;DiagnosticBar + 7 段内容体(`segments/*`,B)**逐字复用零改动**(声明式 `{value,label,content}` 映射,顺序/命名 = SEGMENTS);数据源同 legacy(`useEntry`);roving/键盘/aria 由 Radix。`RequestDetailShadcn` 填成完整 chrome:返回列表 shadcn Button + Esc(逐字复现 legacy `/requests?at=<id>` replace 定位 + modal 让位 Esc)。fork-routed 测试断水平 tablist(`dataset.orientation=horizontal`)+ 7 段 + tabpanel 复用 segment 内容体;amber-legacy 断竖排。
> ③ `c095e867` 接入 prev/next(闭环 P2 M1,决策 5):chrome 用 A 类 `useRequestNeighbors`(据列表顺序算相邻 id + goPrev/goNext 导航到相邻 `/requests/:id` 留在详情 + 绑键盘 ArrowLeft/k·ArrowRight/j),header 加边界禁用 prev/next Button。
> ④ `9b802743` subagent review fix(major):方向键翻页与水平 tab 的 Radix roving-focus 抢键——焦点在 tab 上按方向键会既移 tab 焦点又导航走(劫持 tab 键盘可达性)。根因修复在 A 类 hook 内:方向键落在 ARIA roving 组件(tablist/tab/menu/listbox/grid/tree/radiogroup/slider/spinbutton/combobox)内时让位、不翻页;j/k 不受限。回归测试前红后绿。
> INV-4 四绿(每子 commit):typecheck / build(index 1078.20KB,基线 1071.18KB,+7KB shadcn 详情)/ test(254 bun + 494 vitest 全绿:新增 RequestDetailShadcn.vitest 13)/ eslint 无缓存;grep 守卫绿(detail/ + useRequestNeighbors 零 designVersion)。legacy `DetailPanel`/`DetailSubRail`/`segments/*` 零改动(git diff 空)。**交用户 UX 检查项**:水平 tab 观感/7 段滚动溢出(`overflow-x-auto`)、`line` 变体 vs 需第三变体、prev/next 键位(j/k vs Arrow)与按钮位置;**已知局限(reviewer minor,非回归)**——邻居据已加载页(50/页)算,当前条目落在已加载页边界时相邻端邻居为 null(hook 注释声明的优雅降级,无 auto-loadMore),翻页在页边界会"卡住",记为 UX 检查/backlog 项。

- **对应 RFC/决策**: §4 P3、决策 10（竖排 sub-rail → 水平 Tabs）、`HorizontalTabs`（已落地）、`listVariant` 派生（首用 `line` 变体）。
- **目标**: shadcn 侧 Requests 详情用 `HorizontalTabs`（7 段顶部横排）替 legacy 竖排 `DetailSubRail`；**segment 内容体（B，已中性化）复用不动**。整页详情 chrome（返回列表 + prev/next）shadcn 化。**legacy `DetailPanel`/`DetailSubRail` 冻结。**
- **commit invariant**: 不改 segment 内容体（B）；legacy `DetailPanel.tsx`/`DetailSubRail.tsx` 零改动（OQ-1 冻结）；INV-2（`RequestDetailPage` fork B）；INV-4 四绿。

### 改动 file 锚点

- **提取 legacy**：`src/components/requests/RequestDetailPage.tsx`（现 `:23-60` legacy body：返回按钮 + `<DetailPanel/>`）→ rename `RequestDetailLegacy`，`RequestDetailPage` 变 `DesignFork` wrapper。
- **新增** `src/components/detail/DetailPanelShadcn.tsx`：复用 `useEntry`（`DetailPanel.tsx:25`）+ `DiagnosticBar`（B）+ 7 段内容体（`ConvoSegment`/`SystemSegment`/`StagesSegment`/`ResponseSegment`/`SseEventsSegment`/`HeadersSegment`/`MetaSegment`，B，`DetailPanel.tsx:11-17` import，**逐字复用**），用 `HorizontalTabs`（`listVariant="line"`）替 `Tabs.Root orientation="vertical"` + `DetailSubRail`。段定义 = `DetailSubRail.tsx:3` 的 `SEGMENTS`（7 段，B1：`role=tab` 迁 shadcn 不碎）。
- **新增** `src/components/requests/RequestDetailShadcn.tsx`：shadcn 整页 chrome（返回列表按钮 shadcn + prev/next 相邻条目导航，用 P2 的 `useRequestNeighbors`）+ 嵌 `DetailPanelShadcn`。Esc 返回 + modal 让位逻辑（`RequestDetailPage.tsx:35-44`）复用。
- **不改**：`detail/DetailPanel.tsx`、`detail/DetailSubRail.tsx`、`detail/TocSidebar`（D，冻结）；`detail/segments/*`、`DiagnosticBar`（B，共用）。

### TDD 步骤

1. **提取 legacy + fork wrapper**（提交）。
2. **写 fork-routed 详情测试**（红）：`designVersion=shadcn` 下详情用**水平** tab（断 `role=tablist` 水平 orientation + 7 个 `role=tab` 名 = SEGMENTS + `role=tabpanel` 内容），`=amber-legacy` 挂 legacy 竖排。段内容断言复用现有（B 内容体测试不动）。
3. **写 prev/next 详情导航测试**：详情内切相邻条目（复用 `useRequestNeighbors`）。
4. **实现** `DetailPanelShadcn` + `RequestDetailShadcn`（绿）：嵌 `HorizontalTabs`，7 段 `{value,label,content}` 映射。
5. **确认 legacy 零改动**（`git diff --stat` 不含 `DetailPanel.tsx`/`DetailSubRail.tsx`）。
6. INV-4 四绿 + grep 守卫（`detail/` 零 `designVersion`）。

### 验收 gate

- INV-4 四绿；`detail/` B 域零 `designVersion`。
- shadcn 详情 7 段水平 tab（role/键盘/aria 绿）；segment 内容体复用（B 测试不动）。
- legacy `DetailPanel`/`DetailSubRail` 零改动。
- **交用户 UX 检查项**：水平 tab 观感/滚动溢出（7 段是否需 scroll/overflow）；`line` 变体 vs 需第三变体；prev/next 在详情内的键位。

### 提交指引

```
git add -- ui-v4/src/components/requests/RequestDetailLegacy.tsx ui-v4/src/components/requests/RequestDetailPage.tsx ui-v4/src/components/detail/DetailPanelShadcn.tsx ui-v4/src/components/requests/RequestDetailShadcn.tsx ui-v4/tests/RequestDetailShadcn.vitest.test.tsx
git commit -F <msg> -- <上述>
```
`feat(ui-v4): shadcn request detail with horizontal Tabs (7 segments, decision 10)`

---

## Task P4 · Models（详情抽屉 + dialog seam fork + ModelDetailSubRail 竖→横）

> **实施状态: DONE**（3 子 commit,分支 `feat/ui-v4-shadcn-redesign`,HEAD `4e22f439`）。
> ① `ffe2aa15` 提取 `ModelsLegacy`(原 ModelsPage body 逐字冻结:计数头 + 列菜单 + raw 切换 + 筛选 + 表格 + 竖排 `ModelDetail` 抽屉)+ `ModelsPage` 变薄 `DesignFork` wrapper + `ModelsShadcn` 骨架。
> ② `09f2294d` `ModelsShadcn`(完整,决策 8 + 10):复用**共用数据/构建器层**(`useModels`/`useModelTelemetry`/`filterModels`/`modelStatus`/`buildModelTelemetryIndex`/`model-table-columns`/`detail-tabs`,A/A′/B)+ `?model=<id>` URL 选中;新 D-shell shadcn `ModelsFilterBarShadcn`(Input/Select/Slider + 中性 chip)/`ModelsColumnMenuShadcn`(dropdown-menu)/`ModelsTableShadcn`(复用 buildModelColumns,只换中性 `<table>` 外壳)。新 `ModelDetailShadcn`:右靠可 resize 的 modal **抽屉**(Radix Dialog + `useResizableWidth`),**抽屉 chrome 各自实现**(round2-A2 不与整页 DetailPanel 归并,只共享 `HorizontalTabs`);竖排 `ModelDetailSubRail` 6 tab → 顶部**水平** `HorizontalTabs`(决策 10),6 个 detail-tabs 内容体(B)逐字复用。fork-routed 测试:shadcn 断互斥挂载 + 表格行 + 行点击开抽屉 + 水平 6 tab(名 = MODEL_DETAIL_TABS)+ 内容体复用 + `?model=` deep link + 抽屉覆盖不卸载列表 + × 关闭;amber-legacy 断竖排 sub-rail。
> ③ `4e22f439` dialog seam fork(backlog A3):`AgnosticDialog` 从「恒委派 legacy Modal」改为按 designVersion fork(amber-legacy → legacy `shared/Modal`;shadcn → 中性 Radix `Dialog`——非 ui/dialog 居中卡片,因需 `modal-backdrop` testid + 显式遮罩点击关闭)。seam 在 ui/ 域(守卫白名单)读 designVersion,不碰任何 B 文件。**三 affordance 契约两侧保**(`title`/`onClose` on Escape+遮罩+×/`data-testid=modal-backdrop`);测试扩为两 describe 各跑契约 + 正样本证挂对皮肤;Modal/BlockJsonModal 回归全过。
> INV-4 四绿(每子 commit):typecheck / build(index 1094.03KB,基线 1078.20KB,+15.8KB shadcn Models+抽屉+seam)/ test(254 bun + 508 vitest 全绿:新增 ModelsShadcn 7 + AgnosticDialog fork +3)/ eslint 无缓存;grep 守卫绿(models/detail-tabs B 零 designVersion,中性面无 amber,AgnosticDialog 是白名单 seam)。legacy `ModelDetail`/`ModelDetailSubRail`/`ModelsTable`/`ModelsFilterBar`/`ModelsColumnMenu`/`model-table-columns`/`detail-tabs`/`shared/Modal` 零改动(git diff 空)。**交用户 UX 检查项**:抽屉宽度/resize 手感(shadcn 用独立 localStorage 键 `-shadcn`,与 legacy 抽屉宽度偏好隔离——共享 vs 独立是取舍)、6 tab 水平溢出(`overflow-x-auto`)vs 需第二变体、抽屉 overlay/slide-in 动画(`@keyframes drawer-overlay-in`/`drawer-slide-in` 是**全局定义、非 amber 作用域**,故 shadcn 抽屉复用同 keyframe 名照常入场动画——已核实 theme.css `:313-320` 全局,观感待用户 UX 检查)、列表密度、filter chip/slider 观感、shadcn 列可见性独立持久化键。

- **对应 RFC/决策**: §4 P4、决策 8（详情抽屉）、决策 10（`ModelDetailSubRail` 竖→横）、`HorizontalTabs`（已落地）、**dialog seam fork**（backlog 项，本 Task 做）。
- **目标**: shadcn 侧 Models 页——表格 + 详情**抽屉**（shadcn `Dialog` chrome **各自实现**，只嵌 `HorizontalTabs` 做 6 tab 布局）+ `ModelDetailSubRail` 竖→横；D-shell（`ModelsFilterBar`/`ModelsColumnMenu`/`ModelsTable`/`ModelsPage` 壳）新 shadcn 侧重写；**`ui/AgnosticDialog` 加 `designVersion` fork**（dialog seam）。`detail-tabs/*`/`model-table-columns`（B/A′）已 C2/C3 中性化，复用。**legacy `ModelDetail`/`ModelsPage` 等冻结。**
- **commit invariant**: 不引入模式开关容器（round2-A2：抽屉 chrome vs 整页 chrome 各自实现，只共享 `HorizontalTabs`）；legacy `ModelDetail.tsx`/`ModelDetailSubRail.tsx`/`ModelsPage.tsx` 等零改动；`detail-tabs/*` B 内容体复用；dialog seam fork 锁 `title`/`onClose`/`data-testid=modal-backdrop` 契约；INV-4 四绿。

### 改动 file 锚点

- **dialog seam fork（backlog 项）**：`src/components/ui/AgnosticDialog.tsx`（现 `:36-45` 恒委派 legacy `Modal`）→ 加 `designVersion` fork：读 `useUiStore` → `shadcn` 挂 `ui/dialog.tsx` 的 `Dialog`（中性皮肤）、`amber-legacy` 挂 `shared/Modal`。**seam 在 `ui/` 域允许读 `designVersion`**（不碰任何 B 文件，`BlockJsonModal` 无感）。shadcn 分支必须 emit 同三 affordance：`title`→`DialogTitle`、`onClose`→Escape+backdrop+×、`data-testid="modal-backdrop"` 于点击关闭遮罩。
- **提取 legacy**：`src/components/models/ModelsPage.tsx`（现 `:52-217`）→ rename `ModelsLegacy`，`ModelsPage` 变 `DesignFork` wrapper。
- **新增** `src/components/models/ModelsShadcn.tsx`：完整 shadcn Models 页——复用 `useModels`/`useModelTelemetry`/`filterModels`/`modelStatus`/`buildModelTelemetryIndex`（A，`ModelsPage.tsx:19-40` import）+ `?model=<id>` URL 选中（`:86-110`）+ shadcn 表格 + `RawJsonView`（B）raw 切换。
- **新增** `src/components/models/{ModelsFilterBarShadcn,ModelsColumnMenuShadcn,ModelsTableShadcn}.tsx`：D-shell shadcn 呈现（`model-table-columns` 已 C2 中性化、A′→A，两树共用列构建器）。
- **新增** `src/components/models/ModelDetailShadcn.tsx`：shadcn **抽屉 chrome 各自实现**——用 shadcn `Dialog`（或复用 `useResizableWidth` `ModelDetail.tsx:77` 做 resize）+ portal + overlay + focus-trap（Radix 提供），**嵌 `HorizontalTabs`**（`listVariant="default"`）做 6 tab 横排（`MODEL_DETAIL_TABS`，`ModelDetail.tsx:25`）。6 个 tab 内容体（`OverviewTab`/`CapabilitiesTab`/`LimitsVisionTab`/`BillingPolicyTab`/`TelemetryTab`/`RawJsonTab`，B，`ModelDetail.tsx:17-22` import）**逐字复用**。header 的 `vendorColor`（A′→A）+ `statusMeta`（A）复用。
- **不改**：`models/ModelDetail.tsx`、`ModelDetailSubRail.tsx`、`ModelsTable.tsx`、`ModelsFilterBar.tsx`、`ModelsColumnMenu.tsx`（D，冻结）；`models/detail-tabs/*`、`UnmatchedTelemetry`（B，共用）。

### TDD 步骤

1. **dialog seam fork 测试**（红→绿）`tests/AgnosticDialog.vitest.test.tsx`（已存在，扩展）：`designVersion=shadcn` 挂 shadcn Dialog、断三 affordance 契约（`title`/`onClose`/`data-testid=modal-backdrop`）；`=amber-legacy` 挂 legacy Modal。**先证正样本**（legacy 分支现契约），再断 shadcn 分支同契约。回归 `BlockJsonModal.vitest`/`Modal.vitest` 全绿。
2. **提取 legacy + fork wrapper**（提交）。
3. **写 fork-routed Models 测试**：`shadcn` 渲染 shadcn 表 + 抽屉（断详情用**水平** 6 tab + `?model=` 选中开抽屉），`=amber-legacy` 挂 legacy。
4. **实现** seam fork + `ModelsShadcn` + filter/column/table shadcn + `ModelDetailShadcn`（绿）。
5. **确认无模式开关容器**（抽屉 chrome 独立实现，只 import `HorizontalTabs`）；legacy 零改动。
6. INV-4 四绿 + grep 守卫（`models/detail-tabs/` 零 `designVersion`）。

### 验收 gate

- INV-4 四绿；`models/detail-tabs/` B 域零 `designVersion`。
- dialog seam fork 两皮肤各保 `title`/`onClose`/`data-testid=modal-backdrop` 契约。
- shadcn Models 抽屉 6 tab 水平；`?model=` 选中；抽屉 chrome 独立（无模式开关容器，code review 确认）。
- legacy `ModelDetail`/`ModelsPage` 等零改动。
- **交用户 UX 检查项**：抽屉宽度/resize 手感（是否复用 `useResizableWidth`）；6 tab 水平 vs 溢出；抽屉 overlay/slide-in 动画（`neutral` preset 下的 `@keyframes` 归属，C4 已作用域化 legacy）。

### 提交指引

```
git add -- ui-v4/src/components/ui/AgnosticDialog.tsx ui-v4/tests/AgnosticDialog.vitest.test.tsx
git commit -F <msg> -- <上述>   # dialog seam fork first
```
`feat(ui-v4): fork AgnosticDialog seam by designVersion (shadcn Dialog vs legacy Modal)` /
`refactor(ui-v4): extract ModelsLegacy + DesignFork wrapper` /
`feat(ui-v4): shadcn Models page + resizable detail drawer with horizontal Tabs`

---

## Task P5 · Sessions（页壳 shadcn 化）

- **对应 RFC/决策**: §4 P5。
- **目标**: shadcn 侧 Sessions 列表页 + Session 详情页壳；import 中性化 B 内容（`SessionRow`/`AgentLane`，已 C3 中性化）+ C primitive。**legacy `SessionsPage`/`SessionDetailPage` 冻结。**
- **commit invariant**: `SessionRow`/`AgentLane`（B）零改动、共用；INV-2 fork B；INV-4 四绿。

### 改动 file 锚点

- **提取 legacy**：`src/components/sessions/SessionsPage.tsx`（现 `:4-24`）+ `SessionDetailPage.tsx`（`:29+`）→ rename `SessionsLegacy`/`SessionDetailLegacy`，RoutePage 变 `DesignFork` wrapper。
- **新增** `src/components/sessions/{SessionsShadcn,SessionDetailShadcn}.tsx`：复用 `useSessions`（A）+ `SessionRow`/`AgentLane`（B，共用），shadcn 列表/卡片壳 + 中性 token。
- **不改**：`sessions/SessionRow.tsx`、`AgentLane.tsx`（B，共用）。

### TDD 步骤

1. 提取 legacy + fork wrapper（提交）。
2. fork-routed 测试：`shadcn` 渲染 shadcn 列表（断 session 行 + 空态 role），`=amber-legacy` 挂 legacy。
3. 实现 `SessionsShadcn`/`SessionDetailShadcn`（绿）。
4. INV-4 四绿 + grep 守卫（`sessions/` B 零 `designVersion`）。

### 验收 gate

- INV-4 四绿；`sessions/` B 零 `designVersion`；`SessionRow`/`AgentLane` 零改动。
- **交用户 UX 检查项**：session 列表/详情密度、agent lane 呈现。

### 提交指引

`refactor(ui-v4): extract SessionsLegacy/SessionDetailLegacy + DesignFork wrappers` /
`feat(ui-v4): shadcn Sessions list + detail shells`

---

## Task P6 · Config（页壳 shadcn 化）

- **对应 RFC/决策**: §4 P6。
- **目标**: shadcn 侧 Config 页壳（表单用 `ui/{input,select,slider,button}`）；import 中性化内容 + C primitive。**legacy `ConfigPage` 冻结。**
- **commit invariant**: INV-2 fork B；INV-4 四绿；a11y（表单 label/role，jsx-a11y 规则）。

### 改动 file 锚点

- **提取 legacy**：`src/components/config/ConfigPage.tsx`（`:9+`）→ rename `ConfigLegacy`，RoutePage 变 `DesignFork` wrapper。
- **新增** `src/components/config/ConfigShadcn.tsx`：复用 config 数据 hook/api（A）+ shadcn 表单原语。`ConfigPage`（7 处 `var(--color)`）是 D-shell → shadcn 侧新写、legacy 冻结。

### TDD 步骤

1. 提取 legacy + fork wrapper（提交）。
2. fork-routed 测试：`shadcn` 渲染 shadcn 表单（断 label/role/输入），`=amber-legacy` 挂 legacy。
3. 实现 `ConfigShadcn`（绿）。
4. INV-4 四绿 + a11y lint（无缓存 `bunx eslint`）。

### 验收 gate

- INV-4 四绿；表单 a11y 绿。
- **交用户 UX 检查项**：表单布局/分组/校验反馈观感。

### 提交指引

`refactor(ui-v4): extract ConfigLegacy + DesignFork wrapper` /
`feat(ui-v4): shadcn Config form shell`

---

## Task P7 · Learned（页壳 shadcn 化）

- **对应 RFC/决策**: §4 P7。
- **目标**: shadcn 侧 Learned 页壳（filter + 导出 + 列表）；import 中性化 B（`LearnedRow`/`StatusBadge`，已 C3 中性化）+ C primitive。**legacy `LearnedPage` 冻结。**
- **commit invariant**: `LearnedRow`/`StatusBadge`（B）零改动、共用；INV-2 fork B；INV-4 四绿。

### 改动 file 锚点

- **提取 legacy**：`src/components/learned/LearnedPage.tsx`（`:30+`，含 `useLearned`/filter/export `onExport`）→ rename `LearnedLegacy`，RoutePage 变 `DesignFork` wrapper。
- **新增** `src/components/learned/LearnedShadcn.tsx`：复用 `useLearned`（A）+ export 逻辑（`api.getBlob("/api/negotiation/export")` + `triggerDownload`，A）+ `LearnedRow`/`StatusBadge`（B，共用），shadcn filter/列表壳。
- **不改**：`learned/LearnedRow.tsx`、`StatusBadge.tsx`（B，共用）。

### TDD 步骤

1. 提取 legacy + fork wrapper（提交）。
2. fork-routed 测试：`shadcn` 渲染 shadcn Learned（断 filter/导出按钮/行 role），`=amber-legacy` 挂 legacy。
3. 实现 `LearnedShadcn`（绿）。
4. INV-4 四绿 + grep 守卫（`learned/` B 零 `designVersion`）。

### 验收 gate

- INV-4 四绿；`learned/` B 零 `designVersion`；`LearnedRow`/`StatusBadge` 零改动。
- **交用户 UX 检查项**：Learned 列表/分类 filter/TTL 呈现观感。

### 提交指引

`refactor(ui-v4): extract LearnedLegacy + DesignFork wrapper` /
`feat(ui-v4): shadcn Learned page shell`

---

## Task P8 · Tools（JSON decode 页壳 shadcn 化）

- **对应 RFC/决策**: §4 P8。
- **目标**: shadcn 侧 JSON Tools 页壳（unescape + tree 两面板）；import 中性化 B（`JsonTreeView`，已 C3 中性化）+ C primitive。**legacy `JsonToolsPage` 冻结。**
- **commit invariant**: `JsonTreeView`（B）零改动、共用；INV-2 fork B；INV-4 四绿。

### 改动 file 锚点

- **提取 legacy**：`src/components/tools/JsonToolsPage.tsx`（`:28+`，`unescapeJsonString`/`parseJson` + 两面板 `renderTreePanel`）→ rename `JsonToolsLegacy`，RoutePage 变 `DesignFork` wrapper。
- **新增** `src/components/tools/JsonToolsShadcn.tsx`：复用 `unescapeJsonString`/`parseJson`（A，`lib/json-tools`）+ `JsonTreeView`（B，共用），shadcn `Input`/`textarea` + 面板壳。`JsonToolsPage`（11 处 `var(--color)`）是 D-shell → shadcn 侧新写、legacy 冻结。可顺带接 ShadcnTopBar 搜索占位（若 P2/P7 未接）。
- **不改**：`tools/JsonTreeView.tsx`（B，共用）。

### TDD 步骤

1. 提取 legacy + fork wrapper（提交）。
2. fork-routed 测试：`shadcn` 渲染 shadcn 双面板（断输入 + tree 输出 role/内容），`=amber-legacy` 挂 legacy。
3. 实现 `JsonToolsShadcn`（绿）。
4. INV-4 四绿 + grep 守卫（`tools/JsonTreeView.tsx` 零 `designVersion`）。

### 验收 gate

- INV-4 四绿；`tools/JsonTreeView.tsx` B 零 `designVersion`。
- **交用户 UX 检查项**：双面板布局、输入框/tree 观感。

### 提交指引

`refactor(ui-v4): extract JsonToolsLegacy + DesignFork wrapper` /
`feat(ui-v4): shadcn JSON tools page shell`

---

## Task Z1 · 收尾拆除（架子先行的退场，against-yagni 脚手架纪律）

- **对应 RFC/决策**: §4 收尾阶段 Z1、§8.2 收尾旧树测试去向、OQ-4（触发条件待定）、round2-A4/B8（作用域化撤除）、final review A1（剪枝未消费 token）。
- **触发条件（OQ-4，待用户定，不阻塞 P1-P8）**: 「所有页迁完即删」vs「留一段用户验证期」——**plan 标注待定**，执行到本 Task 前由用户拍板；P1-P8 期间 Z1 不启动。
- **目标**: 新树确认完整后，删旧呈现树 + 移除 `designVersion` 开关 + Amber 降为永久 `colorPreset` + 剪枝未消费 token + 更新活文档。**先确认 fork-routed 测试的 `shadcn` 分支全绿，再删 `amber-legacy` 分支。**
- **commit invariant**: 删 legacy 前 shadcn 分支测试全绿（§8.2）；删后 vitest 绿即证新树（断言已在 role/语义层）；INV-4 四绿。

### 改动 file 锚点（分多子 commit，安全序）

- **① 删 D legacy 壳**：`*Legacy.tsx`（`OverviewLegacy`/`RequestsListLegacy`/`RequestDetailLegacy`/`ModelsLegacy`/`SessionsLegacy`/`SessionDetailLegacy`/`ConfigLegacy`/`LearnedLegacy`/`JsonToolsLegacy`）+ legacy chrome（`shell/{LegacyChrome,NavRail,TopBar}.tsx`）+ legacy detail 容器（`detail/{DetailPanel,DetailSubRail}.tsx`、`models/{ModelDetail,ModelDetailSubRail,ModelsTable,ModelsFilterBar,ModelsColumnMenu}.tsx`、`requests/{HistoryList,LiveDock,LiveGroup,RequestsColumnMenu,RequestFilterChips,RequestsFilterBar,DateRangePopover}.tsx` 等 D-shell legacy）。**逐个核实无 shadcn 侧仍 import**（reviewer 断言亲自复核）。
- **② 删 C `shared/*`**（23 处 amber，冻结皮肤）：`components/shared/*`（`Modal`/`FilterSelect`/`RangeSlider` 等）+ 其测试。`ui/AgnosticDialog` 的 legacy 分支同步删（seam 只留 shadcn `Dialog`）。
- **③ 收敛 fork 原语**：`DesignFork.tsx` 删除；各 RoutePage 从 `<DesignFork legacy shadcn/>` 收敛为直接渲染 shadcn 页元素（rename `XShadcn` → `X` 或就地内联）；`AppShell` 的 fork A/C 收敛为直挂 shadcn chrome/dock；删 `DesignVersionToggle`。
- **④ `designVersion` 字段退场 + Amber 降永久 preset**：`stores/ui-store` 删 `designVersion`/`setDesignVersion`；`colorPreset` 保留（`amber` 降为永久 preset 之一，`neutral` 默认）；`lib/data-design` 的 DOM 属性反射改为只反射 `colorPreset`（或移除 `data-design`）。
- **⑤ 撤 `[data-design=amber-legacy]` 作用域**：`styles/theme.css`（C4 作用域化的整族——`border-radius:0!important` `:29`、`.livedock-island` `:34`、`.toc-flash` `:40-44`、`.rdp-amber` `:53-69`、`@keyframes` `:73-80`）→ 改为 `[data-color-preset=amber]` 作用域（amber preset 专属）或按永久 preset 重组；shadcn/neutral 树的圆角/瞬态高亮走 token。
- **⑥ 剪枝未消费中性 token**（final review A1）：C1 建的语义 token 若某 shade 迁完无消费者，剪枝（**先 grep 全仓确认零引用**，reviewer 复核，`no-destructive` 判据 = 可恢复性 + 零消费者实证）。
- **⑦ 删 legacy 专属测试**：`Modal.vitest`、legacy 页壳 leaf-import 测试、fork 守卫测试（`DesignVersionForks`/`AppShellForkStructure`/`design-version-scope-guard`）——fork 机制退场后这些失去对象。fork-routed 测试删 `amber-legacy` 分支、保 `shadcn` 分支断言。
- **⑧ 更新活文档**：`docs/DESIGN.md`「活的架构现状」（删双树/`designVersion` 行，留永久 `colorPreset` + 语义 token 层）；RFC §2/§8（标注收尾完成、五类归并）；跨文档 grep 验证一致。

### TDD/验证步骤

1. **前置门**：删任何 legacy 前，全量跑 fork-routed 测试确认**每页 `shadcn` 分支全绿**（正样本证新树完整）。
2. **按 ①→⑧ 序逐子 commit**，每步后 INV-4 四绿（删一批 legacy → typecheck 抓残留 import → 修）。
3. **grep 全仓终检**：`grep -rn 'designVersion\|data-design\|shared/\|Legacy' src tests` 收敛到零（除 git 历史）。
4. **whole-domain audit**：删后 vitest 全绿即证新树（断言在 role/语义层）。

### 验收 gate

- INV-4 四绿；全仓 `designVersion`/`shared/*`/`*Legacy` 零残留。
- 剪枝的 token 经 grep 证零消费者（reviewer 复核）。
- DESIGN.md/RFC 同步（跨文档 grep 一致）。
- **交用户 UX 检查项**：收尾后单树完整、Amber 作为永久 preset 可切、无功能回退。
- **对抗 subagent review**（session-closeout）：派 `ecc:react-reviewer` + 对抗 reviewer，**prompt 显式裁判轴：长远正确 + 完整**，核删除的每个「无消费者」断言亲自对照代码/实测复核。

### 提交指引（多子 commit）

`chore(ui-v4): remove legacy presentation trees (D shells + chrome + detail containers)` /
`chore(ui-v4): remove legacy shared/* skin (C dual-tree end)` /
`refactor(ui-v4): collapse DesignFork + retire designVersion, amber → permanent colorPreset` /
`refactor(ui-v4): scope amber rule family to [data-color-preset=amber]` /
`chore(ui-v4): prune unconsumed neutral tokens (grep-verified zero consumers)` /
`docs(ui-v4): sync DESIGN living-architecture + RFC §2/§8 for shadcn cutover complete`

---

## 逐页收尾（每 Task 后，session-closeout）

按序做完（`no-premature-stop`，无需提醒）：
1. **subagent audit**：每页/每组页派 `ecc:react-reviewer`（+ 对抗 reviewer），**prompt 显式裁判轴：长远正确 + 完整**，核 INV-1/2/4 + INV-FIDELITY-1 成立、grep 守卫零泄漏、legacy 确实冻结零改动。reviewer 的「无消费者/可安全删/已通过」绝对断言**亲自对照代码/实测复核**。
2. **doc-sync**：更新 `docs/DESIGN.md`「活的架构现状」（各页 shadcn 侧完成度）；RFC §4 标注对应 P 实施状态；跨文档 grep 验证。
3. **sync-plan-with-impl**：本 plan 头部/对应 Task 标注实施状态；与实现同步。
4. **细粒度阶段提交**：每语义单元一 commit、pathspec、conventional commits、不加模型署名。

---

## fork-routed 测试策略要点（§8.2，逐页通用）

- **范式**（架子已落地 `tests/DesignVersionForks.vitest.test.tsx`）：`MemoryRouter` + `Routes`/`Route` 渲染 RoutePage，`act(() => useUiStore.getState().setDesignVersion(v))` 翻树，`queryAllByTestId(...).toHaveLength(1)` 断互斥挂载，再在 shadcn 分支断 role/语义 token/内容。
- **D 页壳/chrome 测试**：从「leaf-import legacy 组件」**重写为 fork-routed**（非「翻 flag 即测两树」——leaf-import 翻 flag 不换 DOM）。
- **B/A′ 内容体测试**：中性化后（C2/C3 已做）断语义 token 名 / role，两 preset 各跑，**基本直接复用**（内容不变，逐页不改 B）。
- **虚拟化 fake**：选 A（保 `TableVirtuoso`）沿用 `RequestsListPage.test:52-78` 手写 `FakeTableVirtuoso` + `setup.ts:11-17` `ResizeObserver` stub + `initialItemCount`；选 B（换容器）须新建契约测试。
- **golden**：架子期 golden（同步体直接 snapshot、code-bearing 体 `beforeEach: await getHighlighter()` 仅预热）锁 `amber-legacy` 像素等价；逐页只加 shadcn 侧，legacy golden 应仍过（legacy 冻结）。
- **a11y**：shadcn 侧新交互组件过 `jsx-a11y`/`react-hooks` lint（无缓存 `bunx eslint`）；`HorizontalTabs`/`Dialog` role/键盘/aria 由 Radix 提供，测试断之。

---

## 与真实代码核实发现的差异（供实现者 + 用户注意）

**全部据 HEAD `d98009bb` 真实源码核实，非 RFC/scaffold-plan 转述：**

1. **架子 C0-C7 已全部 merge**（HEAD `d98009bb`，含 master 列配置 + color-neutralization）。逐页建于其上，**勿再造脚手架**。真实 API 见前置表（`DesignFork`/9 primitive/`HorizontalTabs`/`AgnosticDialog`/`shadcn/*` chrome 骨架/`OverviewShadcn` 已存在）。
2. **只有 Overview 做过 fork B 提取**（`OverviewLegacy` 是唯一 `*Legacy` 文件）。**P2-P8 每页第一步都要先提取 legacy**（rename body → `XLegacy` 冻结，RoutePage 变薄 `DesignFork` wrapper），复刻 `OverviewPage`/`OverviewLegacy`/`OverviewShadcn` 三件套形态——RFC/scaffold-plan 未明写这步，是逐页的隐含首工作量。
3. **测试基数已漂移**：RFC INV-4 写「vitest 66 + bun 27」；实测 HEAD = **77 vitest（70 `.tsx` + 7 `.ts`）+ 25 bun = 102**（架子 + 列配置 + 中性化多轮 merge 后增长/迁移）。本 plan INV-4 一律表述「vitest + bun **全绿**」、不锁固定条数。
4. **master 列配置特性对 P2 的影响（最重）**：dnd-kit 重排 + `columnSizing` resize + `columnOrder` + 版本化 `useColumnState` 已 merge 进 **legacy** `RequestsListPage`（`DndContext` `:56` + `HistoryList` TanStack `TableVirtuoso` + `RequestsColumnMenu`）。数据层（`useColumnState` = A、`REQUEST_COLUMNS`/`reorderColumns` = A′→A、`SIGNAL_COLOR` 已 C2 中性化）两树共用；**shadcn 侧 P2 必须重新接线这套三态 + `DndContext`**（P2 最大工作量块，RFC 只一句「含 master 新落地的列配置特性」带过，未展开接线量）。虚拟化容器 fork = 实现者裁决点（选 A 保 `TableVirtuoso` → fake 契约可沿用；选 B → 新契约测试）。
5. **prev/next 快捷键是新特性**：legacy **无** 详情 prev/next 导航（grep 仅 `useResizableWidth` 的 ArrowLeft/Right）；决策 5 的 prev/next **P2/P3 新增**（建议抽 A 类 `useRequestNeighbors` hook）。而 `?at=` 返回定位**已在 legacy 实现**（`RequestDetailPage.tsx:31-33` + `HistoryList` `at` context）——shadcn 侧复现即可，非新建。
6. **`listVariant` 派生已存在**：`HorizontalTabs.tsx` 已有 `listVariant:"default"|"line"` prop + `ui/tabs.tsx` `line` cva 变体——backlog 的「listVariant 派生」实际已落地，P3/P4 只在消费点选变体（若需第三观感变体再扩 cva）。
7. **dialog seam fork 已明确 defer 到本阶段**：`AgnosticDialog.tsx` docstring 显式写「`designVersion` fork deferred to per-page phase」，当前恒委派 legacy `Modal`。归 **P4**（唯一消费者 `BlockJsonModal`）。
8. **`ShadcnLiveDock`/`ShadcnChrome`/`ShadcnNavRail`/`ShadcnTopBar`/`OverviewShadcn` 是 C6 骨架、非空白**：逐页是**填充**（P1 Overview、P2 LiveDock 呈现层、P7/P8 TopBar 搜索接线），非从零建。
