# ADR: ui-v4 采用 shadcn/ui 组件体系（重访并放宽「弃 shadcn 成品样式」的旧结论）

- 状态: Proposed（核心选型已由用户拍板；配色/密度/布局形态基调已定；部分布局细节讨论中、尚未实施）
- 日期: 2026-07-10
- 决策者: 用户 + 维护 agent
- 相关: [2026-07-05-adopt-radix-primitives.md](2026-07-05-adopt-radix-primitives.md)（**本 ADR 重访其「未采纳 §2：弃 shadcn 成品样式」**）、[2026-07-05-headless-component-stack.md](2026-07-05-headless-component-stack.md)、[2026-07-06-requests-list-libraries.md](2026-07-06-requests-list-libraries.md)、PoC `exp/antd-poc/`（antd 可行性实证，反向支撑本决策）、根级 `docs/todo/deferred-backlog.md`「ui-v4 列表↔详情双入口」、`internal-tool-security-posture`、`richest-data-flow`

## 背景

ui-v4 是 copilot-api 的 request inspector / History Web UI（React 19.2 + TypeScript + Vite 7，83 组件 / ~11200 行）。当前样式是一套强个性的定制设计系统「工业风 Terminal Amber」（`src/styles/theme.css`）：暖近黑底、琥珀主色、**全局强制锐角**（`border-radius: 0 !important`）、IBM Plex Mono、深色 only。

用户诉求（2026-07-10）：抛弃现有的定制界面风格，全面采用一个后台组件库的风格，偏好"专业微调"（棱角分明优于圆角）。

关键前提（与既有 ADR 的关系，必须先厘清）：

1. **底座是 Radix，且 Radix 是延续、非替换**。[adopt-radix-primitives ADR](2026-07-05-adopt-radix-primitives.md)（2026-07-05，Accepted）已把 ui-v4 的交互原语迁到 **Radix Primitives（`radix-ui ^1.6.1`）**——经「Radix migration P0–P3」把早期各自实现的 Modal/Tabs/Menu/Select 换成 Radix Dialog/Tabs/DropdownMenu/Select，拿回 focus-trap / scroll-lock / 键盘 menu / APG tabs 等 a11y 能力（现用于 11 个文件）。**shadcn/ui 本身就是 Radix + Tailwind + 一套标准结构约定**，故采用 shadcn**不移除任何 Radix**，是在既有 Radix 上加一层一致封装与样式约定。DESIGN.md §2 技术栈原本也一直写的是 shadcn/ui。

2. **场景是"数据密集 + 自定义渲染"，非"标准 CRUD 后台"**。inspector 主任务是深看单条请求的 SSE/diff/对话（`components/detail/` 是最大子树）。组件库价值区（表单/CRUD 表格/弹窗）不是主战场；主战场（可视化）无组件库能替代。

3. **虚拟滚动必留**。`react-virtuoso`（[requests-list-libraries ADR](2026-07-06-requests-list-libraries.md)）用在 6 处（含 TOC 树、会话列表、请求详情行），无法被组件库 Table 替代。

## 与 2026-07-05 ADR 的结论差异（本 ADR 重访 / 放宽的那条）

[adopt-radix-primitives ADR](2026-07-05-adopt-radix-primitives.md) 的「未采纳 §2」当时**否决了「引整套 shadcn/ui 成品组件」**，理由是：shadcn 默认视觉（`rounded-md`、阴影、间距 token）与 Terminal Amber（`rounded:0`/高密度/amber/mono）冲突，落地需大量覆写；故取 shadcn 底座（Radix）、弃其成品样式，「规格 §2 的 shadcn/ui 措辞精化为 Radix Primitives」。

**为何现在反转这条**（诚实记录，非无视旧决策）：

- **前提变了**：旧 ADR 的否决建立在「**要保留 Terminal Amber 定制风格**」之上。而用户 2026-07-10 的诉求正是**主动放弃定制风格、拥抱组件库观感**——旧否决的大前提不再成立。
- **原冲突可被消解而非回避**：旧 ADR 认为「shadcn 样式 vs Amber」互斥所以弃 shadcn 样式。但 **shadcn 的主题是 CSS 变量驱动、可完全主题化**——Amber 不必与 shadcn 对立，而是作为 shadcn 的**一套 theme preset**（`--radius:0` + 琥珀 token + mono）存在。于是「保留 Amber」与「采用 shadcn」从互斥变成兼容：Amber 降为可切换 preset（本 ADR 决策 3）。
- **new-york 变体本就偏锐利**：旧 ADR 假设 shadcn = 圆角柔和；实际 shadcn 有 `new-york` 变体（锐利、border-driven），配 `--radius:0` 天然贴近工业风审美，覆写量远小于旧 ADR 估计。

结论：本 ADR **不推翻 Radix 采用（那是延续）**，只**放宽旧 ADR「弃 shadcn 成品样式」这一条**——在既定 Radix 底座上，采用 shadcn 的成品封装约定 + 可主题化样式层。

## 决策

**ui-v4 在既有 Radix + Tailwind 底座上采用 shadcn/ui 组件层，不引入重型 CSS-in-JS 组件库。** 配套基调：

1. **组件方案**：shadcn/ui `new-york` 变体（紧凑、锐利、border-driven）。把 `components/shared/` 现有的 Modal/FilterSelect/RangeSlider（已是 Radix 封装）及散落组件收敛为一套一致的 shadcn primitives。
2. **圆角**：锐角 `--radius: 0`（shadcn 圆角统一引用单一 token，设计系统原生支持，取代现有 `!important` 覆盖）。
3. **配色**：**tokenized 可调配**主题系统，默认 preset **继承现有暗色 + 琥珀**（Amber 作可切换 preset，消解与旧 ADR 的冲突，呼应 `richest-data-flow`）。
4. **密度**：**标准密度默认**；紧凑（compact）模式保留为未来可选、暂不实施（不砍）。
5. **列表↔详情布局 = 形态 A**：保留现有「整页详情」（详情独占全宽，契合 inspector「深看单条」主任务）+ 补「连续性」（相邻请求 prev/next 快捷键 + 返回列表定位 `?at=id`）。违反直觉的不是"整页"（邮件/PR/工单页皆整页全宽），而是"孤岛式整页"；补 prev/next 后即兼得沉浸全宽 + 连续扫读 + 不丢上下文。
6. **默认落地页**：`/requests` → **`/overview`**（对齐后台默认落地 Dashboard 的通用直觉）。
7. **在途请求浮窗（LiveDock）提升为全局**：从 RequestsListPage 专属提取为**常驻 `AppShell` 的全局浮窗**（订阅 `useLiveRequests()` 早已在 AppShell，本项把浮窗 UI 也上移），任意页面可见在途活动。
8. **详情抽屉统一为公共组件**：Models 详情与 Requests 详情**共用一个公共抽屉/面板容器**（容器共享、内容各自渲染）。与形态 A 不矛盾：整页路由与抽屉/未来 peek 都复用 `DetailPanel` 内容层；两处详情呈现有差异但容器实现共享。
9. **改造期新旧双版本共存 + 全局切换（过渡脚手架，非 per-page）**：迁移期间**新旧两套设计并存于同一 ui-v4**（不另起 `ui-v5/`），由一个**全局切换入口**（TopBar 按钮，持久化到 ui-store `designVersion: "amber-legacy" | "shadcn"`）**整版切换**——**非 per-page**（始终呈现完整、自洽的一版，不出现半新半旧混合），目的是让用户随时对照两版、确认迭代方向。实现分层：**共享单份**（数据层 / hooks / stores / api / types / 可视化内容渲染 detail/diff/SSE/shiki，与设计无关，两版共用）；**过渡期双份**（AppShell / NavRail / TopBar / 各页 shell + 组件皮肤 + 布局，由 `designVersion` 选择挂载哪棵**呈现树**）。**与决策 3 区分**：决策 3 的 Amber 色板是**永久换色 preset**；本项是**过渡期整版本开关**（旧 Amber 组件+旧布局 ↔ 新 shadcn 组件+新布局）。**against-yagni 的脚手架纪律**：新设计确认且完整后**拆除旧呈现树 + 移除版本开关**（可降级为决策 3 的色板 preset），不留永久双轨债。

## 理由

- **同源零地基迁移**：shadcn = Radix + Tailwind，正是现状底座（[adopt-radix ADR](2026-07-05-adopt-radix-primitives.md)）；升级组件层不动可视化渲染层与数据/交互库（react-table / virtuoso / day-picker / shiki）。
- **无运行时锁定**：组件代码进本仓库，可逐个微调（契合"专业微调"偏好），无第三方 CSS-in-JS 运行时、无版本锁、不增额外 bundle。
- **场景匹配**：一致性给到该统一处（表单/按钮/弹窗/表格壳），个性留给该保留的可视化。
- **锐角是 shadcn 强项**：单一 `--radius` + new-york 变体天然锐利，比重型库更贴"棱角分明"。

## 后果

- 需逐个把现有组件迁到 shadcn primitives（中等工作量，逻辑几乎不动、主要改 className / 结构）。
- 需搭 theme token 系统（Amber preset + 可扩展 preset），主题切换在 token 层完成。
- LiveDock 上移 + 详情抽屉共用组件抽取，属结构调整（有测试 oracle 兜底）。
- dashboard 布局需自拼（shadcn 是组件集合非成套框架，可参考官方 blocks）。
- 属 ≥1000 行结构性重构，实施须走 RFC-first（skill `large-refactor`）+ 对抗 subagent review。
- **双呈现树脚手架成本**（决策 9）：过渡期 shell/布局/皮肤维持两份、由 `designVersion` 切换，须防止逻辑层被复制（只有呈现层双份）；完工后有一步**明确的拆除**（删旧呈现树 + 移开关），需在 RFC 里排成收尾 phase、不可遗留。
- 需同步更新 DESIGN.md §2/§8（技术栈措辞从「Radix Primitives」升级为「shadcn/ui on Radix」、视觉方向从定制 Amber 改为「shadcn + Amber preset」）。

## 未采纳（record-not-adopted）

- **Ant Design 本体（含双引擎）**：**否**。PoC（`exp/antd-poc/`，commit `07a5d574`）实证 antd v6 + React 19 + Tailwind v4 + Amber 主题**技术可行**（四风险点全绿），但否决理由是**价值/成本错配**：antd 红利在 CRUD（非本场景主战场）；运行时 CSS-in-JS 与 Tailwind + 自定义渲染两套体系并行；bundle JS 920KB / gzip 298KB（实测）；视觉语言同化可视化组件；antd Table 用不上（已有 react-table + virtuoso）。实证细节见 `exp/antd-poc/CONCLUSION.md`。
- **Mantine / MUI**：否。Mantine 同类问题；MUI Material 个性过强 + emotion 与 Tailwind 冲突最重。
- **强制 master-detail 分栏（形态 B）**：否。详情内容极重，塞半屏损害主任务；用大改动解决 prev/next 小改动即可解决的问题。
- **双入口 peek + 整页（形态 C）**：**defer 不砍**。已记根级 `docs/todo/deferred-backlog.md`「ui-v4 列表↔详情双入口」（前置：形态 A 先落地）。
- **只换主题不换组件库**：部分采纳。"换观感 = 换 token"洞察被吸收进决策 3；但诉求含"统一组件层"，仍引入 shadcn 组件。
- **维持现状不动**：否。现有组件缺跨组件一致性（每个 Radix 封装各写各的 className），shadcn 以同源最小代价提供一致约定。
- **（继承自 [adopt-radix ADR](2026-07-05-adopt-radix-primitives.md)）弃 shadcn 成品样式、只用裸 Radix**：**本 ADR 放宽此条**——理由见上「与 2026-07-05 ADR 的结论差异」。
- **另起 `ui-v5/` 平行重建**：**否**（用户 2026-07-10 定：保留在 ui-v4 原地改）。不同于当年 Vue→React（v4）跨框架必须平行重写，本次同栈（React/Vite/Tailwind/Radix）、ui-v4 约 80%（数据层/hooks/stores/可视化渲染）可直接复用；平行重建会为重刷 20% 皮肤而复制 80% 价值层，纯负债。故定位为 **ui-v4 原地 major 重设计（同前端世代），非新世代 v5**。改造期双版本共存由决策 9 的过渡开关承载，而非双目录。

## 尚在讨论（本 ADR 将随对话增补）

- 详情内 7 段 segment：竖排 sub-rail → 顶部水平 tabs（倾向改，未定）。
- NavRail（左侧导航条，现 150px 无图标纯文本 `components/shell/NavRail.tsx`）：加宽 + 加图标（未定）。
