# PoC 结论：antd 组件库全面替换 ui-v4 手搓风格 —— 四风险点实测

- **日期**：2026-07-09
- **背景**：用户决定抛弃 ui-v4 的「Terminal Amber 工业风」手搓样式，全面采用 **Ant Design 本体**（接受双引擎：antd 出组件 + Tailwind 保留），Amber 保留为可切换主题。
- **本 PoC 目的**：在写迁移 RFC 前，用**真实构建环境**（React 19.2 + Tailwind v4 + Vite 7，复刻 ui-v4）实测四个可能否决方案的风险点。
- **运行方式**：`bun install && bun run typecheck && bun run test && bun run build`（纯构建/测试，无 dev server，符合项目 no-auto-server 纪律）。

## 结论：四风险点全部 GREEN，方案可行

| # | 风险点 | 实测结论 | 证据 |
|---|---|---|---|
| 1 | React 19 兼容 | ✅ **antd v6 原生兼容 React 19，无需任何补丁** | `message`/`Modal.confirm`（App.useApp context 版）在 React 19.2 下渲染进 DOM，测试通过；不引 `@ant-design/v5-patch-for-react-19`（那是 v5 专用） |
| 2 | 虚拟长列表 | ✅ **antd 视觉组件可渲染进 react-virtuoso 行** | `.ant-tag` 出现在 `[data-testid=virtuoso-antd-row]` 内；antd Table 亦独立渲染。混用路径「antd 出视觉 + virtuoso 出虚拟滚动」成立 |
| 3 | CSS-in-JS × Tailwind v4 层叠 | ✅ **共存，`StyleProvider hashPriority="high"` 控特异性** | `bun run build` 通过；产出 CSS 含 Tailwind `@layer` + `.flex/.gap-3`；同一行 Tailwind class 未被 antd 剥离 |
| 4 | Amber 保留为可切换主题 | ✅ **ConfigProvider token 一等公民** | `darkAlgorithm` + `borderRadius:0`（复现锐角）+ IBM Plex Mono + 琥珀调色板；运行时在「企业蓝白 / Terminal Amber」间切换不崩 |

**测试**：6/6 通过（`tests/poc.vitest.test.tsx`）。**typecheck**：0 error。**build**：成功。

## 关键发现（会改变 RFC 的事实）

1. **antd 最新是 v6.5.0，不是 v5**（我知识截止 2026-01 时以为是 v5）。v6 保留 ConfigProvider / cssinjs / StyleProvider / darkAlgorithm，主题方案不变；且**原生支持 React 19**，砍掉了「装 v5 补丁」这一步。→ RFC 定 antd **^6.x**。

2. **antd v6 样式是运行时 CSS-in-JS 注入，非构建期**。构建产出的 44KB CSS **纯是 Tailwind**（`@layer` + utilities）；antd 组件样式由 `@ant-design/cssinjs` 在运行时以 `<style>` 注入。含义：
   - Tailwind 与 antd 不在同一份静态 CSS 里争，冲突面小于预期。
   - IBM Plex Mono / Amber token 也走运行时注入（在 ConfigProvider theme 里），不进构建 CSS。

3. **Bundle 体积是真实代价**：JS **920KB / gzip 298KB**（含 antd 全量组件）。对比现有 ui-v4 底座。→ RFC 需列 **按需/code-split** 策略（antd v6 ES module 可 tree-shake，但 PoC 未做分包，Vite 已告警 >500KB）。

4. **虚拟滚动必留 react-virtuoso**：它在 ui-v4 用于 6 处（含 TOC 树、会话列表、请求详情行，非仅表格），antd Table 无法替代这些。正确形状 = **antd 视觉 + virtuoso 虚拟**混用。react-table 仅 ModelsTable 一处真用，可评估换 antd Table。

5. **迁移应采用 `App.useApp()` context 版 message/modal**（非静态 import）：能消费 ConfigProvider 主题、React 19 下渲染稳定，是 antd v6 惯用写法。静态 message 也工作（探针已证 `.ant-message` + 文本渲染），但 context 版更正确。

## 未采纳 / 记录在案

- **不引 `@ant-design/v5-patch-for-react-19`**：v6 原生兼容，补丁是 v5 专用，引入反而多余。
- **不用 antd Table 全面替代 virtuoso**：virtuoso 6 处场景多为非表格，强替换会丢能力。
- **jsdom 下 virtuoso 需 `VirtuosoMockContext` 注入视口/行高**才确定性渲染（无真实布局测量）——迁移后前端测试沿用此法（ui-v4 现用 fake mock，PoC 用官方 mock context 保留真实集成）。

## 文件

- `src/amber-theme.ts` —— Amber↔蓝白双 ThemeConfig 映射（迁移可直接复用）。
- `src/App.tsx` —— StyleProvider + ConfigProvider + AntApp + antd 组件 + virtuoso 混用样例。
- `src/styles.css` —— Tailwind v4 `@layer` 顺序声明。
- `tests/poc.vitest.test.tsx` —— 四风险点断言。

## 下一步

四风险点全绿，可进入 `docs/rfc/` 起草迁移 RFC：迁移分期、83 组件映射清单（antd 对应组件 + virtuoso 保留清单）、双主题 token 方案、bundle code-split 策略、前端测试 VirtuosoMockContext 迁移。
