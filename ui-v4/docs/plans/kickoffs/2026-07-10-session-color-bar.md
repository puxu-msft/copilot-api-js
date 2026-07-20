# Kick-off：Session 色带 + 多选对比 + 可切换色板

复制以下提示词到新会话（或用于 subagent-driven 执行）：

---

在 `copilot-api-js` 项目实施 ui-v4 特性「Requests 列表 session 色带 + 多选对比高亮 + 可切换色板」。

**先读**（按序）：
1. 计划：`ui-v4/docs/plans/2026-07-10-session-color-bar.md`（分 4 Task、TDD、每步含完整代码）。
2. 权威 spec（概念/取舍/审查纪要）：`ui-v4/docs/spec/2026-07-10-ui-v4-session-color-bar.md`。
3. 现状锚点：`ui-v4/src/components/requests/HistoryList.tsx`、`ui-v4/src/lib/request-columns.ts`、`ui-v4/src/styles/theme.css`、`ui-v4/tests/HistoryList.vitest.test.tsx`（顶部 render helper 名与 navigate 注入方式，Task 2/3 测试须对齐它）。

**执行纪律**：
- 逐 Task、逐 Step 走 TDD（先写失败测试→跑挂→实现→跑绿→typecheck+lint→提交）。
- **红线**（见计划 Global Constraints）：色列取数走 itemContent 第三参 context 绝不走 ColumnDef.cell；session td 用 `p-0 relative` 不套 `px-2 py-1 overflow-hidden`；圆角走 `.session-cap-*` 破例类 + `!important`；dim 只用 `opacity-40`；subagent 缩进落 status 单元格 `pl-3`；后端零改动、只碰 `ui-v4/**`。
- 色值逐字取自 spec §4，默认色板 `terminal-neon`。
- **no-auto-server**：不跑 `bun run dev`/`start`、不 `kill`；可跑 `bunx tsc --noEmit` / `bunx vitest run` / `bun test` / `bun run build:ui-v4`。
- 显式 pathspec commit（`git commit -- <精确路径>`），conventional commits，不加模型署名。
- Task 4 的人工视觉核验须**请用户起服**核对（色块贯通/缩进/淡背景/多选/切色板/`?at=`叠加），jsdom 测不到布局正确性。

**每 Task 完成**：typecheck + 对应测试全绿再提交；Task 间可停下让 reviewer 把关。全部完成走 Task 4 收尾（全量门禁 + build:ui-v4 + 人工核验 + subagent 合并态审查 + doc-sync）。

---
