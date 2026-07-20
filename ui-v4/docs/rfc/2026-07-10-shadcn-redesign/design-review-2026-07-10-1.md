# RFC design.md 对抗 review 报告 — round 1（2026-07-10）

两个并行对抗 subagent(迁移安全 + 架构缺口,Explore 只读)审 `design.md` 草案(commit `0a90d976`)。裁判轴=长远正确+完整+架构健康(非 ROI/YAGNI)。下方为**主会话已独立核实**的发现(读引用的 file:line、复核计数、解决矛盾点),非照单全收。

## 核实裁决摘要

| # | 判定 | 主题 | 主会话核实 |
|---|---|---|---|
| F1 | **FAIL** | 地基:Tailwind v4 下无"shadcn init 直接跑";会引第二套 scoped `@radix-ui/*`(现用统一包 `radix-ui`)、`tailwindcss-animate` v4 不工作、`@theme inline`、`--color-*`↔shadcn token 无桥接 | 证实:package.json v4、无 config、`radix-ui` 统一包、lucide/cn/cva 全无 |
| F2 | **FAIL** | 双树切换作用点错位:`App.tsx` 单例 `createHashRouter`,页面经 `<Outlet/>` 渲染,**AppShell 开关管不到 Outlet 页面壳**(D 类主体) | 证实:App.tsx:20-47 单例 router + AppShell Outlet |
| F3 | **FAIL** | 新树零测试:66 vitest+24 bun 全绑 legacy 树、断言硬编码 Amber class;新 shadcn 树无覆盖;收尾删 legacy 后 vitest 绿也证不了新树 | 证实:测试大量断言 `var(--color-*)` |
| F4 | **FAIL(架构根因)** | **B 类非 design-agnostic**:detail/ 下 **152 `--color-*` + 29 裸 hex**(ThinkingBlock/MessageBlock/toc 语义色 map),与 INV-1"B 类不动"直接矛盾 | 亲手复核计数:152 + 29 |
| F5 | **FAIL(架构根因)** | **A 类"零改动"虚假**:`request-columns.ts` 返 ReactNode+amber token、`vendor-color.ts:10` 硬编码 hex、`model-status.ts` colorVar、`highlight/amber-theme.ts`+`shiki.ts:100` 单主题(CodeBlock 在新树仍 amber 高亮) | 证实全部 file:line |
| F6 | **FAIL(架构根因)** | INV-3 commit1"视觉零变化"与 `theme.css:29 *{border-radius:0!important}` 冲突:该全局 !important 架空 shadcn `--radius`,要生效必须作用域化→破坏 amber-legacy 像素等价 | 亲手复核 theme.css:29 |
| W1 | **WARN** | §2"C 单份/仅 D 双份"**改了 ADR 决策 9**(决策 9 把"组件皮肤"列入双份)却以"更精确澄清"措辞掩盖;OQ-1"旧树冻结"与"C 单份共用同一 primitive"自相矛盾 | 证实 design.md:27 vs adr 决策9;需回用户 |
| W2 | **WARN** | Cutover 错位:**LiveDock 已全局化到 AppShell:31**(决策 7 结构工作已完成、只剩样式),RFC 当待办放错 commit;Models 共享抽屉容器制造 Requests↔Models 跨页依赖,**破坏"逐页并行"** | 证实 AppShell.tsx:31 已挂 LiveDock、RequestsListPage 注释确认 |
| W3 | **WARN** | §2 三分类**遗漏组件**:`DiagnosticBar/MessageBlock/ConversationView/toc/*/*Button/*Modal` 未归类 | 证实存在、未列 |
| W4 | **WARN** | 切换丢运行态:WS 一次性 connected 快照(AppShell:14-19 注释)、滚动、virtuoso 位置随卸载归零 | 证实注释;但因 LiveDock/订阅已在 AppShell,若开关在 AppShell 之上则重演 |
| W5 | **WARN** | golden 基建为零(无 `toMatchSnapshot`);jsdom 锁不住 virtuoso 真虚拟化(行回收/windowing/tail);INV-4 漏 bun 测试 | 证实无快照基建 |
| W6 | **WARN** | 僵尸 `theme:light/dark/system` 字段(ui-store:6、TopBar:19)已存在、基本死代码,RFC 引入 designVersion+preset 却未处置,三态混淆 | 证实字段存在 |

## 贯穿性根因(F2/F3/F4/F5/F6 同源)

RFC 假设"设计只在 shell/皮肤层"。实际 **Amber 语义色贯穿 A 类 lib(信号色/厂商色/shiki 主题)+ B 类内容体(152+29 处)+ 全局 !important 锐角**。不先做一个**前置架构阶段**(语义 token 中性化 + shiki 双主题 + 全局锐角规则作用域化),双树一挂 shadcn 树即渲染 amber 内容 + 被压平圆角 → 被迫改 INV-1 宣布为红线的 A/B 层 = 返工。

## 对 RFC v2 的结构性要求(采纳)

1. **前置地基 PoC(gating)**:Tailwind v4 × shadcn × 统一 Radix 实测(`shadcn add button/dialog/tabs` 能否跑、是否引第二套 Radix、`@theme inline` 与现有 `@theme` 共存)。同 antd PoC,放 `exp/`。**不过此关,RFC 后续全是空中楼阁。**
2. **新增"前置中性化阶段"**(commit 1↔2 之间):抽设计中性语义 token(`--content-add/-del/-thinking/-tool/...`)两 preset 各自映射 + shiki 双主题按 preset 切 + 全局 `*{border-radius:0!important}` 作用域化到 `[data-design=amber-legacy]`。这不是 R2 一句缓解,是一等阶段。
3. **修正切换作用点**(F2):明确在 router 层换两套 router,还是每页内分叉(INV-2 下沉到页)。
4. **新树测试策略**(F3):断言层从 Amber 具体 class 改为语义/role/data-testid,一套测两树;明确收尾时旧树测试去向。
5. **回写 ADR 决策 7/9**(W1/W2):决策 7 改为"已落地(并发会话)、仅剩样式";决策 9 的 C 单份/双份边界回用户确认(与 OQ-1 合并)。
6. **补全分类**(W3)、**处置僵尸 theme 字段**(W6)、**golden 基建从零建 + virtuoso 真行为需 e2e/PoC 级契约**(W5)、**INV-4 纳入 bun 测试**。

## 未采纳 / 存疑

- 无 reviewer 建议被否决(均证实)。
- reviewer 1 WARN-4(切换丢 connected 快照)严重度受 LiveDock/订阅已在 AppShell 影响:若 designVersion 开关置于 AppShell **之上**才重演;置于其下则订阅常驻不受影响。切换作用点(F2)定了才能定此项——并入 F2 处理。

## 下一步

地基 PoC(要求 1)是 gating,建议立即并行搭。RFC v2 待 PoC 结论 + 用户解 OQ(尤其 C 单/双份=决策9边界、新默认强调色、实现方式)后重写。**当前 design.md 状态:Draft,不进 commit 序列。**
