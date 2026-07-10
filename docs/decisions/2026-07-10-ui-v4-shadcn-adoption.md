# ADR: ui-v4 采用 shadcn/ui 组件体系替换手搓样式（否决重型组件库）

- 状态: Proposed（核心选型已由用户拍板；配色/密度/布局形态基调已定；部分布局细节讨论中、尚未实施）
- 日期: 2026-07-10
- 决策者: 用户 + 维护 agent
- 相关: PoC `exp/antd-poc/`（antd 可行性实证，反向支撑本决策）、`docs/todo/deferred-backlog.md`「ui-v4 列表↔详情双入口」条目、`internal-tool-security-posture`、`richest-data-flow`

## 背景

ui-v4 是 copilot-api 的 request inspector / History Web UI（React 19.2 + TypeScript + Vite 7，83 组件 / ~11200 行）。现有样式是一套强个性的手搓设计系统「工业风 Terminal Amber」（`src/styles/theme.css`）：暖近黑底、琥珀主色、**全局强制锐角**（`border-radius: 0 !important`）、IBM Plex Mono、深色 only。

用户诉求：抛弃"手搓界面风格"，全面采用一个后台组件库的风格，并偏好"专业微调"（棱角分明优于圆角）。

关键事实澄清（决策的前提）：

1. **现状并非"纯手搓"**：ui-v4 已站在 **Radix UI（无头 primitives）+ Tailwind v4 + 自定义 token** 底座上——这**恰是 shadcn/ui 的技术栈**。真正手写的只有两样：① Amber 皮肤；② 大量**数据可视化渲染**（`components/detail/` 下的 SSE 帧 diff、消息块、TOC 树、代码高亮 shiki、JSON 树）。
2. **场景性质是"数据密集 + 自定义渲染"，不是"标准 CRUD 后台"**：inspector 的主任务是深看单条请求的 SSE/diff/对话。组件库的价值区（表单/增删改查表格/弹窗）不是主战场；主战场（可视化）没有任何组件库能替代，反而其样式体系会同化这些精心设计的视图。
3. **虚拟滚动必留**：`react-virtuoso` 用在 6 处（含 TOC 树、会话列表、请求详情行，非仅表格），无法被组件库的 Table 替代。

## 决策

**ui-v4 采用 shadcn/ui 作为组件层，留在既有的 Radix + Tailwind 底座上，不引入重型 CSS-in-JS 组件库。** 配套设计基调：

1. **组件方案**：shadcn/ui 的 **`new-york` 变体**（更紧凑、锐利、border-driven 而非 shadow-driven）。把 `components/shared/` 手搓的 Modal/FilterSelect/RangeSlider 及散落的按钮/输入升级为一套一致的、抄进本仓库的 primitives。
2. **圆角**：锐角，`--radius: 0`（shadcn 所有组件圆角引用单一 token，设计系统原生支持，取代现有 `!important` 暴力覆盖）。
3. **配色**：**tokenized 可调配**主题系统，默认 preset **继承现有暗色 + 琥珀**（Amber 作为一套可切换 preset，不丢失现有设计资产，呼应 `richest-data-flow`）。
4. **密度**：**标准密度默认**；紧凑（compact）模式保留为未来可选，暂不实施（不砍）。
5. **列表↔详情布局 = 形态 A**：保留现有「整页详情」（详情独占全宽，契合 inspector「深看单条」主任务）+ 补「连续性」（相邻请求 prev/next 快捷键翻页 + 返回列表定位 `?at=id`）。理由：违反直觉的不是"整页"（邮件/PR/工单页皆整页全宽），而是"孤岛式整页"（进去出不来、不能连续看）；补 prev/next 后整页详情同时具备沉浸全宽 + 连续扫读 + 不丢上下文，是最小改动解。

## 理由

- **同源零地基迁移**：shadcn = Radix + Tailwind，正是现状底座；升级组件层不动可视化渲染层、不动数据/交互库（react-table / virtuoso / day-picker / shiki）。
- **无运行时锁定**：组件代码抄进本仓库，可逐个微调（契合用户"专业微调"偏好），无第三方 CSS-in-JS 运行时、无版本锁、不增额外 bundle 负担。
- **场景匹配**：把"一致性"给到该统一的地方（表单/按钮/弹窗/表格壳），把"个性"留给该保留的可视化——精准命中 inspector 的价值分布。
- **锐角是 shadcn 强项**：单一 `--radius` token + new-york 变体天然偏锐利专业，比重型库更能满足"棱角分明"审美。

## 后果

- 需逐个把手搓组件迁到 shadcn primitives（中等工作量，逻辑几乎不动、主要改 className / 结构）。
- 需搭一套 theme token 系统（Amber preset + 可扩展新 preset），主题切换在 token 层完成。
- dashboard 布局仍需自己拼（shadcn 是组件集合非成套框架，可参考官方 blocks）。
- 属 ≥1000 行结构性重构，实施须走 RFC-first（skill `large-refactor`）+ 对抗 subagent review。

## 未采纳（record-not-adopted）

- **Ant Design 本体（含双引擎）**：**否**。PoC（`exp/antd-poc/`，commit `07a5d574`）已实证 antd v6 + React 19 + Tailwind v4 + Amber 主题**技术可行**（四风险点全绿），但决策否决理由是**价值/成本错配**：① antd 红利在 CRUD、非本场景主战场；② 运行时 CSS-in-JS 与 Tailwind + 自定义渲染两套体系并行；③ bundle JS 920KB / gzip 298KB（PoC 实测）；④ 其视觉语言会同化可视化组件；⑤ 最强的 antd Table 用不上（已有 react-table + virtuoso）。PoC 的其余实证（React 19 无需 v5 补丁、antd 样式运行时注入、virtuoso 6 处必留）均沉淀在 `exp/antd-poc/CONCLUSION.md`。
- **Mantine / MUI**：否。Mantine 同类问题（自有样式体系、帮不上可视化层）；MUI 的 Material 个性太强 + emotion 与 Tailwind 冲突最重。
- **强制 master-detail 分栏（形态 B）**：否。详情内容极重（7 段 + SSE diff + 代码），塞进半屏损害主任务；且用大改动去解决一个 prev/next 小改动就能解决的问题。
- **双入口 peek + 整页（形态 C）**：**defer 不砍**。已记入 `docs/todo/deferred-backlog.md`「ui-v4 列表↔详情双入口」，作为形态 A 之上的未来演进（前置：形态 A 先落地）。
- **只换主题不换组件库**：部分采纳。"换观感 = 换 token"这一洞察被吸收进决策 3（tokenized 主题）；但用户诉求含"统一的组件层"，故仍引入 shadcn 组件，非仅换皮肤。
- **保留全部手搓**：否。手搓 primitives 缺一致性、每个 Modal/Select 重复造轮子，shadcn 以同源最小代价提供一致性。

## 尚在讨论（本 ADR 将随对话增补）

- 详情内 7 段 segment：竖排 sub-rail → 顶部水平 tabs（倾向改，未定）。
- Models 详情：右侧抽屉 → 与 Requests 统一（未定）。
- NavRail：150px 无图标 → 加宽 + 加图标（未定）。
- 默认落地页：`/requests` vs `/overview`（未定）。
