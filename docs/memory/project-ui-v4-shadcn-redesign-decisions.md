---
name: project-ui-v4-shadcn-redesign-decisions
description: ui-v4 全面切换 shadcn/ui 重设计的累积决策与进度（ADR 随对话增补中、未实施）
metadata: 
  node_type: memory
  type: project
  originSessionId: d68f698b-2bc2-49f9-894e-5b0b082d679e
---

ui-v4（React 19 + Tailwind v4 + Vite，request inspector）正在讨论**全面抛弃定制样式、切换 shadcn/ui**。决策随对话增补进 ADR [ui-v4/docs/decisions/2026-07-10-ui-v4-shadcn-adoption.md](../../ui-v4/docs/decisions/2026-07-10-ui-v4-shadcn-adoption.md)（状态 **Proposed**、未实施；敲定后再派生迁移 spec/RFC 走 skill `large-refactor`）。**注意 ui-v4 有自己的 `ui-v4/docs/decisions/`**（ui-v4 专属 ADR 放这、根 `docs/decisions/` 是后端全项目级）。

**已锁定基调**：shadcn `new-york` 变体 · 锐角 `--radius:0` · 配色 tokenized 可调、默认 preset 继承现有暗色+琥珀（Amber 作可切换 preset）· 标准密度默认（compact 未来可选、暂不做）· 列表↔详情 **形态 A**（保留整页详情 + 补 prev/next 连续性 + 返回定位 `?at=id`）。

**本轮（2026-07-10）新增决策**：① 默认落地页 `/requests`→**`/overview`**；② LiveDock 在途请求浮窗从 RequestsListPage 专属**提取成全局浮窗**（渲染上移到常驻 `AppShell`；注：`useLiveRequests()` 订阅早已在 AppShell，仅浮窗 UI 还在 requests 页）；③ Models 详情抽屉与 Requests 详情**共用一个公共抽屉组件**（容器共享、内容各自渲染，与形态 A 整页不矛盾：整页路由与抽屉/peek 都复用 `DetailPanel` 内容层）；④ 明确 **Radix 是延续非替换**（shadcn 本就是 Radix+Tailwind）——本 ADR **重访并放宽**既有 [adopt-radix-primitives ADR](../../ui-v4/docs/decisions/2026-07-05-adopt-radix-primitives.md) 的「未采纳 §2：弃 shadcn 成品样式」（旧前提「保留 Amber 定制风格」已变、且 shadcn CSS-var 可主题化使 Amber 降为 preset 消解原冲突）；另引 [headless-component-stack](../../ui-v4/docs/decisions/2026-07-05-headless-component-stack.md) / [requests-list-libraries](../../ui-v4/docs/decisions/2026-07-06-requests-list-libraries.md)。

**定位（2026-07-10）**：这是 **ui-v4 原地 major 重设计（同前端世代）、非新世代 ui-v5**——不另起 `ui-v5/` 平行重建（同栈、ui-v4 约 80% 逻辑/可视化可复用，平行重建为刷 20% 皮肤复制 80% 价值层=负债；对比当年 Vue→React 跨框架才必须平行）。**决策 9：改造期新旧双版本共存于同一 ui-v4 + 全局整版切换**（TopBar 入口、ui-store `designVersion`、**非 per-page**，始终呈现完整自洽一版），供用户对照确认迭代方向；实现分层=**共享单份**（数据/hooks/stores/api/types/可视化渲染 detail/diff/SSE/shiki）+ **过渡期双份**（AppShell/NavRail/TopBar/各页 shell+皮肤+布局，`designVersion` 选挂哪棵呈现树）；与决策 3「Amber 色板 preset（永久换色）」区分——本项是**过渡整版开关**，新设计完整后**拆旧呈现树+移开关**（against-yagni 脚手架纪律、不留永久双轨，RFC 排收尾 phase）。

**已否决/defer**：antd 本体（PoC `exp/antd-poc/` 实证**可行但价值/成本错配**否决，见 [[project-antd-poc-rejected]]）· Mantine/MUI · 强制 master-detail 分栏（形态 B）· 双入口 peek+整页（形态 C，**defer 不砍**、记 `docs/todo/deferred-backlog.md`「ui-v4 列表↔详情双入口」）。

**尚在讨论**：详情内 7 段 sub-rail 竖排→顶部水平 tabs（倾向改未定）· NavRail（左侧导航条，现 150px 无图标纯文本）加宽+图标（未定）。

背景与「Radix migration P0–P3」历史（手搓→迁到 Radix 拿回 a11y→现在罩 shadcn 一致皮肤）见 ADR 正文。相关：[[feedback-ui-v4-code-authored-by-agents]]。
