# RFC design.md v2 对抗 review 报告 — round 2（2026-07-10）

两个 opus 对抗 subagent 审 v2（commit `fbc4f5a5`)的**新承重主张**（不重复 round1）。主会话对 subagent 冲突/绝对断言**亲手 grep 裁决**（ground truth 优先于任一 subagent 自述）。

## 主会话 ground-truth 裁决（先于下方分述，解决 v2 writer ↔ round2-B 的事实冲突）

| 冲突项 | v2 writer 称 | round2-B 称 | 主会话实测（裁决） |
|---|---|---|---|
| detail/ `var(--color-*)` 数 | 127（"工作量下调"） | 152（"未缩反增"） | **152**（`grep -roE 'var\(--color-[a-z-]+\)'`）→ **round2-B 对**，v2「下调」框架在此轴错 |
| detail/ 6 位 hex 数 | 42 | 51 | **29**（`#[0-9a-fA-F]{6}\b`）→ 三方都不完全一致（计数口径差:3 位 hex/含注释/theme.css），量级 ~30-50，不影响架构 |
| `VirtuosoMockContext` 存在? | 引作"现有可沿用基建" | 全仓零命中 | **ui-v4 零命中** → **round2-B 对**：RFC 引用了不存在的 primitive（真实=手写 FakeTableVirtuoso + initialItemCount + ResizeObserver stub）。v3 必改 |
| `.toc-flash` 全局 amber 泄漏? | 未提 | 共享 hook 施加、漏出 C4 守卫 | **证实**：`theme.css:42 .toc-flash{background:#2a2212}` 由共享 `useAnchorScroll.ts:59` 施加 → 泄漏进 shadcn 共享 B |

**结论**:round2-B 的事实性发现成立;v2 的「工作量下调」框架**撤回**（中性化面 = 152 `--color-*`，不小于 round1）。

## round2-B（测试 + 中性化现实性）—— 2 FAIL + 5 WARN，已核实

| # | 判定 | 主题 | 证据（主会话核实） |
|---|---|---|---|
| B1 | 成立 | tab-role 断言可迁 | `DetailSubRail.tsx:15-27` Radix Tabs → shadcn Tabs 仍 `role=tab` 同名，`getByRole("tab")` 不碎 |
| B2 | **WARN** | §8.2 参数化 designVersion 低估 | 测试 **leaf-import 具体 legacy 组件**（`DetailPanel.test:36`/`ConvoSegment.test:19`/`RequestsListPage.test:82`），翻 store flag 不换所渲 DOM；「一套测两树」需把 D 测试**重写为 fork-routed 渲染**，非「直接复用」。colorPreset 翻转(纯 CSS)与 designVersion 翻转(换组件树)被 v2 混为一谈 |
| B3 | **FAIL** | VirtuosoMockContext 事实错 | ui-v4 零命中（见裁决）；真实=手写 FakeTableVirtuoso（`RequestsListPage.test:46-79` 硬编码 thead/tbody/TableRow 契约）+ initialItemCount，shadcn 若非 TableVirtuoso 该 fake 不可迁 |
| B4 | 成立 | hex 机制可 token 化 | 内联 style/Tailwind 任意值均可换 `var()`；shiki baked hex 对 amber-legacy preset 安全（`shiki.ts:180` THEME_NAME → 同 baked hex） |
| B5 | **WARN** | 语义槽爆炸（§3 ~6 token 名不够） | 同角色跨文件多 shade:thinking 3 紫（ThinkingBlock `#a89ac0`/`#6a5a8a` + DetailTocTree `#9a8ad0`）、tool 2 绿；另 ~29 个 surface/near-black hex（`#1a1820`/`#1e1e24`/`#100e0b`…）无 `--surface-*` 族可归 → C3 需更细的 token 家族，工作量>「齐整 --content-*」 |
| B6 | **FAIL** | §8.4 golden 对 code-bearing 体 flaky | `shiki.ts:90-109` highlighter 是**进程级单例**、异步加载 → `toMatchSnapshot` 依测试序产出 plaintext（未加载）或高亮（前序已加载）二态。`CodeBlock.test` 正是用 `await waitFor` 绕开；snapshot 无法 await 自身内容 → golden 自身 flaky，不能作 INV-3 闸。修:code-bearing golden 前 `await getHighlighter()` 预热 + beforeEach 重置单例 |
| B7 | **WARN** | C4 data-design 属性落点未指派 | grep `data-design`/`designVersion` 零命中;C4 作用域化到 `[data-design=amber-legacy]` 但没 commit 把该属性写进 DOM 根 → 若拖到 C6，C4→C6 窗口独苗 legacy 丢全局锐角 → 圆角回弹破 INV-3。修:C0/C4 同 commit 在根写 `data-design=amber-legacy` |
| B8 | **WARN** | C4 范围过窄（全局 amber 泄漏） | `.toc-flash`(`#2a2212`+`var(--color-primary)`)由共享 `useAnchorScroll` 施加于 B 段 → 泄漏进 shadcn 共享 B;C3「grep B 目录 tsx 零 amber」抓不到（hex 在 theme.css 非 tsx）。C4 标题应扩为「全局 amber 规则（锐角+toc-flash+rdp-amber+keyframes）审计与作用域化」 |
| — | 成立（无依赖） | C2↔C3 顺序 | A′ lib 与 B detail 基本不相交，无半坏 |

## round2-A（切换机制 / DetailContainer / B↔C 边界 / 五类完整性）

opus 审 §5/§2,主会话亲手 grep 核实焦点 4（承重）。

| # | 判定 | 主题 | 证据（主会话核实） |
|---|---|---|---|
| A1 | 成立 / **WARN** | §5 三 fork 可行、但 INV-FIDELITY-1 强制偏弱 | 结构属实（`App.tsx:20` 单 router、`AppShell.tsx:14/19/31` L0）；切 chrome 无害仅因 `useWs.ts:29` effect deps=[]；守卫只断**挂载身份**、断不住「给 useWs 加非空 deps / 把 hook 挪到 designVersion 分支后」的回归。**建议**:C6 把 chrome/dock 的 designVersion 读取**下沉到 AppShell 子组件**（持 hooks 的 AppShell 体根本不订阅 designVersion，结构隔离 > 纪律）+ 补「L0 effect deps 为空 / 快照到达后切换仍在飞」行为回归 |
| A2 | **WARN** | §2 C7 DetailContainer 抽象过度 | `DetailPanel`（内联整页、无 Dialog）vs `ModelDetail`（Radix Dialog+portal+overlay+resize+anim+focus，`:87-117`）交互模型迥异；唯一真重叠是竖→横 Tabs 布局。「抽屉/面板容器」归并恰好塞进两者**唯一不重叠**的容器 chrome → 模式开关泄漏容器。**建议**:共享面收敛为「水平 Tabs 内容布局 primitive」，抽屉-chrome 与整页-chrome 各自实现 |
| A3 | 成立 / **WARN** | §2/§3 B↔C 解耦、适配器成本低估 | B 目录对 shared/* 直接 import **仅 1 处**（`BlockJsonModal.tsx:2`）→ 方向对；但它依赖 `shared/Modal` 的 title/onClose/`data-testid=modal-backdrop` 契约（`Modal.tsx:34`），shadcn Dialog 是 slot 组合式无单一 title/testid → 适配器要规范化两套 Dialog API + 保测试契约，非「小」适配器。ExportButton 走裸元素路径①顺畅 |
| A4 | **FAIL** | §2 五类划分 A′ 锚点误置 + Models 域 B/A′ 逃逸前置中性化 | **亲手核实**:`model-columns.ts` 色=**0**（v2 误归 A′，实为 A）；真带色的 `model-table-columns.tsx` 色=**13** + import vendorColor（A′-性质，v2 **未分类**）；**中性化面远超 detail/ 152**——models 85 / sessions 14 / learned 27 / tools 32 / overview 4 / common 6，**全 components 域 `var(--color)`=450**。v2 把 scope 框在 detail/ 单目录、低估 ~3×。models/detail-tabs 等 B 内容体 + model-table-columns 未进 C2/C3 前置 → 会滑进逐页 P4，**破 INV-1「中性化全前置」不变量** |
| — | 核实无误 | v2 若干主张 | §8「仅 8 文件断色」准确（8 文件与 RFC 列举一致）、`toMatchSnapshot`=0、僵尸 theme 属实（TopBar 外零消费者） |

**round2-A 最重两条**:A4（中性化 scope 低估 3× + A′ 锚点错 → 动摇架子先行结构）、A2（C7 强并两交互模型）。

## v3 待处理清单（round2 A+B → v3，含主会话 ground-truth）

1. **A4 修中性化 scope（最重）**:C2/C3 的中性化清单从「detail/ 152」扩为**全 components 域 450 `var(--color)`**——补 models（含 `model-table-columns.tsx`+`models/detail-tabs/`）、sessions、learned、tools、overview、common 的 B 内容体 + A′ 列构建器；A′ 清单删 `model-columns`（纯 A）、加 `model-table-columns.tsx`。重申「中性化全前置」需覆盖所有域，否则该不变量对 Models 等不成立。
2. **B3 删 VirtuosoMockContext**:改述真实基建（手写 FakeTableVirtuoso + initialItemCount + ResizeObserver stub）。
3. **B6 修 golden**:code-bearing golden 前 await shiki 预热 + beforeEach 重置单例;分同步/高亮两类。
4. **B2/A3 提测试+适配器工作量**:§8.2「D 测试从 leaf-import 重写为 fork-routed」为一等项;BlockJsonModal 的 Dialog API 归一是硬工作量。
5. **B5 扩 token 家族**:加 `--surface-*`/scale 族 + 每 shade 独立 token。
6. **B7 指派 data-design**:C0/C4 同 commit 在根写 `data-design`。
7. **B8 扩 C4 范围**:theme.css 全局 amber 规则整体审计（toc-flash/rdp-amber/keyframes）。
8. **A1 强化 INV-FIDELITY-1**:结构隔离 chrome 到子组件（非纪律）+ 行为回归。
9. **A2 收窄 C7**:共享面=水平 Tabs 布局 primitive，抽屉/整页 chrome 各自实现。
10. **撤回「工作量下调」**:中性化面据实（detail 152、全域 450）。
