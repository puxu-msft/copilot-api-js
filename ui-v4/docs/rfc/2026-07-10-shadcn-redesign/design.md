# RFC: ui-v4 shadcn/ui 重设计迁移

- 状态: Draft（待 ≥3 轮对抗 subagent review + 用户解 open questions）
- 日期: 2026-07-10
- 派生自: ADR [../decisions/2026-07-10-ui-v4-shadcn-adoption.md](../decisions/2026-07-10-ui-v4-shadcn-adoption.md)（决策 1–11）
- 方法论: skill `large-refactor`（RFC-first + commit invariants + 过渡态显式无害 + golden 预捕获）

## 1. 问题陈述

ui-v4 当前样式是定制「Terminal Amber」体系（`src/styles/theme.css` 全局 `border-radius:0 !important`、暖黑+琥珀、mono）。ADR 决策把它全面切换到 **shadcn/ui（new-york，锐角，Amber 作可切换色板 preset）** + 一批布局改动（默认页 /overview、LiveDock 全局、详情抽屉共用、列表-详情形态 A、详情内水平 tabs、NavRail 加宽加图标）+ **改造期新旧双呈现树 + 全局 `designVersion` 开关**。

本 RFC 把 11 条设计基调转成可执行的迁移：组件映射、主题 token 架构、双呈现树脚手架、按 commit 的 cutover、commit invariants、验证与收尾拆除。

**核心事实（决定架构）**：ui-v4 的价值 80% 在**逻辑层 + 可视化渲染**（与设计无关、两版共享），只有 20%（shell/皮肤/布局）需要双份。迁移不得复制逻辑层。

## 2. 组件三分类（目录级审计，架构图价值轴 = 上下文经济）

| 类别 | 目录/文件 | 迁移处理 |
|---|---|---|
| **A. 共享逻辑层（不动）** | `lib/` `hooks/` `stores/` `types/` `lib/api.ts` `lib/content/*` `lib/diff/*` `lib/highlight/*` | 零改动，两版共用。**红线：任何 commit 不得在此引入 designVersion 分支。** |
| **B. 共享可视化内容（不动）** | `components/detail/blocks/*`、`detail/diff/*`、`detail/segments/*`（内容体）、`detail/ContentRenderer`、`detail/CodeBlock`、`detail/LineNumberedText`、`components/common/RawJsonView`、`tools/JsonTreeView` | 内容渲染与设计无关，两版共用。**边界例外**：这些内部若直接用了 `shared/` 的皮肤组件（Modal/Select）或硬编码 Amber class，需抽出皮肤依赖（见 §4 风险 R2）。 |
| **C. 皮肤 primitive（shadcn 化，单份收敛）** | `components/shared/Modal`（Radix Dialog）、`shared/FilterSelect`（Radix Select）、`shared/RangeSlider`（Radix Slider）、散落 button/input/badge/tag | 收敛为 shadcn primitives（`components/ui/*`）。这些**本就是 Radix 封装**，改造=换成 shadcn 标准封装 + token 样式。**两版可共用同一 shadcn primitive**（primitive 是设计无关的行为壳，样式由 token 决定）——故严格说 C 类不是"双份"，是"单份 shadcn + token 切换"。 |
| **D. 过渡期双份呈现树（shell + 布局 + 页面壳）** | `components/shell/*`（AppShell/NavRail/TopBar）、各页 page 壳（`requests/RequestsListPage`、`overview/OverviewPage`、`models/ModelsPage`、`sessions/SessionsPage`、`config/ConfigPage`、`learned/LearnedPage`、`tools/JsonToolsPage`）、`detail/DetailPanel`+`DetailSubRail`（竖排→横排 tabs）、`requests/LiveDock`（→全局）、详情抽屉容器 | 由 `designVersion` 选挂哪棵。**新树 import B 类内容 + C 类 shadcn primitive；旧树保持现状不动直到收尾删除。** |

**关键边界澄清（易错点）**：
- `detail/DetailSubRail` 与 `DetailPanel` 属 **D 类**（导航/布局，竖排→横排是决策 10），但它们渲染的 **segment 内容体属 B 类**（不动）。迁移改的是 tab 容器与朝向，不是 segment 内容。
- C 类 shadcn primitive **两版共用**：新旧树都 import 同一 `components/ui/button` 等；旧树的 Amber 观感靠 `designVersion=amber-legacy` 时激活的 Amber token preset 呈现，新树靠 shadcn 默认 token。**这意味着"双呈现树"主要双份的是 D 类 shell/布局/页面壳，C 类 primitive 是单份 token 驱动。**（这是比 ADR 决策 9 更精确的分层——见 open question OQ-1：旧树是否值得保留其原有手写皮肤，还是直接让旧树也用 shadcn primitive + Amber token？）

## 3. 主题 token 架构

- **shadcn CSS 变量层**：`--background`/`--foreground`/`--primary`/`--border`/`--radius`/`--muted` 等标准 shadcn token，定义在 `styles/` 下，按 preset 分组。
- **Preset**：`shadcn-dark`（新默认，中性 + 蓝白或琥珀强调待定，见 OQ-2）、`amber`（复现现有 Terminal Amber：`--radius:0`、琥珀 primary、mono font）。preset 切换 = 换一组 CSS 变量值（`data-theme` 或 class 作用域）。
- **`designVersion` vs `theme` preset 的正交性**：`designVersion`（amber-legacy/shadcn 呈现树）是**过渡脚手架**；`theme` preset（色板）是**永久**。收尾删除旧呈现树后，Amber 作为一个永久 preset 保留、`designVersion` 开关移除。**二者不可混用一个状态字段。**

## 4. 风险与缓解

- **R1 逻辑层被污染**：迁移中在 `lib/`/`hooks/`/`stores/` 引入 designVersion 分支 → 破坏"单份逻辑"。**缓解**：commit invariant #1（A/B 类零 designVersion 分支）；每 commit grep 守卫。
- **R2 B 类内容体硬编码 Amber class / 直接依赖旧皮肤**：可视化组件里若散落 `text-[var(--color-primary)]` 或 import `shared/Modal`，则它不是纯 B 类。**缓解**：审计阶段 grep B 类目录的 Amber class + shared import，把皮肤依赖上移到 D 类或换 shadcn primitive；内容体只保留结构 class。
- **R3 双 stdout/输出重叠**（large-refactor §3 过渡态显式无害的 UI 类比）：新旧呈现树若在某 commit 同时挂载渲染 → 用户看到双份/闪烁。**缓解**：`designVersion` 开关是**互斥挂载**（条件渲染只挂一棵），非双挂；commit invariant #2。
- **R4 bundle 膨胀 + lint 缺口**：shadcn + lucide 增体积；ui-v4 缺 react-hooks/jsx-a11y lint（backlog 已记）。**缓解**：每 commit `build:ui-v4` 实测体积；迁移中顺带启用 ui-v4 lint（关联 backlog 项）。
- **R5 虚拟列表回归**：`react-virtuoso` 6 处（B/D 交界），shadcn 化行渲染不得破坏虚拟化。**缓解**：golden 预捕获 virtuoso 行为 + VirtuosoMockContext 测试沿用。

## 5. Cutover 计划（按 commit，非 phase）

**Commit invariants（全程守）**：
- **INV-1**：A 类（逻辑层）+ B 类（可视化内容）在任何 commit **零 `designVersion` 分支、零新 Amber 硬编码**。
- **INV-2**：任一 commit，`designVersion` 开关**互斥挂载**一棵呈现树（绝不双挂同时渲染）。
- **INV-3**：从引入开关起，每个 commit **两版都可运行且自洽**（amber-legacy 保持现状像素等价、shadcn 版渐进完善）——中间态绝不半坏。
- **INV-4**：`typecheck:ui-v4` + `build:ui-v4` + vitest 每 commit 绿。

**Commit 序列（草案，待 review 精化）**：
1. **地基**：`shadcn init`（`components.json` new-york）+ 装 lucide-react + `cn` util + shadcn CSS 变量层 + Amber preset token（复现现有观感）+ ui-store 加 `designVersion`（默认 `amber-legacy`）。**此 commit 后视觉零变化**（默认走 amber-legacy 旧树；shadcn 层已装但未挂）——过渡态显式无害。
2. **双呈现树骨架**：`AppShell` 按 `designVersion` 互斥挂载 legacy vs shadcn shell（shadcn shell 先是最小骨架：NavRail 加宽+图标 + TopBar + Outlet）+ TopBar 加 `designVersion` 切换按钮。INV-2/INV-3 生效。
3. **C 类 shadcn primitives**：`components/ui/*`（button/input/select/dialog/tabs/badge/…）落地，映射现有 shared/ 封装。
4–N. **逐页 shadcn 呈现树**（每页一 commit，可并行分派）：Overview（+默认页改 /overview）、Requests（列表 + 形态 A 整页详情 + prev/next + LiveDock 全局）、详情 DetailPanel（竖排→水平 tabs）、Models（详情抽屉→共用容器）、Sessions、Config、Learned、Tools。每页新树 import B 类内容 + C 类 primitive。
N+1. **收尾拆除**：新版确认完整后，删旧呈现树（D 类 legacy）+ 移除 `designVersion` 开关 + Amber 降为永久 preset + 更新 DESIGN.md §2/§8。

## 6. 范围外

- 不改后端、不改 `~backend/*` 契约、不改数据/WS 协议。
- 不改可视化算法（diff/SSE 累积/shiki）。
- compact 密度（决策 4 未来项）、双入口 peek（backlog）不在本次。

## 7. 给用户的 Open Questions

- **OQ-1（旧呈现树的皮肤策略）**：过渡期旧树（amber-legacy）是**保持现有手写 Radix 皮肤原样**（改动最小、纯参照），还是**也改用新 shadcn primitive + Amber token**（旧树也现代化、但改动旧树有回归风险）？推荐前者（旧树冻结不动，纯作对照基线，收尾整体删除）。
- **OQ-2（新默认色板强调色）**：shadcn 默认 preset 的强调色——中性灰 + 蓝白（最"专业后台"）、保留琥珀作强调、还是纯信号色？（此前 AskUserQuestion 未收到答案，需明确。）
- **OQ-3（实现方式）**：逐页 commit **自己一路实现**，还是**三层文档 + 分派并行实现者**（large-refactor §5）？页与页格式独立、天然可并行，但 context 与合并序需协调。
- **OQ-4（旧树保留期限）**：收尾拆除的触发条件——所有页迁完即删，还是保留一段用户验证期？

### OQ 决议（用户 2026-07-10）

- **OQ-1 → 旧树用旧皮肤（冻结）**。过渡期旧树保持现有手写 Radix 皮肤原样、纯作对照基线，收尾整体删除。**推论**：C 类（皮肤 primitive）在过渡期是**双份**（旧 `shared/*` 手写皮肤 + 新 `components/ui/*` shadcn），确认 ADR 决策 9「皮肤双份」原文正确——**撤销 §2 草案里「C 类单份 token 驱动」的表述**（review W1），RFC v2 据此改。
- **OQ-2 → 新默认强调色 = 中性灰 + 蓝白**。shadcn 默认 preset 走中性灰阶（zinc/slate）+ 蓝白强调（最专业后台）。中性化语义 token 的 shadcn preset 映射按此定。
- **OQ-3 → 逐页自己一路实现**（不走三层文档分派）。省 `prompts/` 层；但见下「架子先行」硬约束。
- **OQ-4 → 待定**（收尾拆除触发条件，实现到收尾 phase 前再定，不阻塞）。

### 架子先行（用户 2026-07-10 追加硬约束，与 OQ-3 并存）

**逐页 ≠ 无共享框架。** 必须**先把架子搭得通用、可扩展**，再在架子上逐页迁移。架子 = ①主题 token 系统（shadcn CSS 变量 + 中性/Amber 两 preset + 可扩展第三 preset）②中性化语义 token 层（`--content-*`，A/B 类去 Amber 化的落点）③shiki 双主题按 preset 切 ④全局锐角规则作用域化 ⑤shadcn primitives（`components/ui/*`）⑥双呈现树 + `designVersion` 切换机制（切换作用点见 review F2）。**这与 review 要求的「前置地基 + 中性化阶段先行」完全一致**——cutover 序列的通用架子 commit（§5 的 1–3 + 新增中性化阶段）**必须在任何逐页 commit 之前完成且做成可扩展的**（新增 preset / 新页接入零重复脚手架）。逐页只是在稳定架子上填内容，不是每页各搭一套。

## 8. 验证

- **golden 预捕获**（large-refactor §4）：迁移前锁 virtuoso 行为、详情 segment 渲染、关键页快照，改后须仍过。
- 每 commit：`typecheck:ui-v4` + `build:ui-v4`（含 bundle 体积对账）+ vitest（VirtuosoMockContext 沿用）。
- **手动 UX 检查**（large-refactor §3）：每 commit 边界确认 `designVersion` 两版各自完整、无双挂闪烁。
- 收尾：whole-domain audit + DESIGN.md 同步 + 对抗 subagent review。
