# Kick-off：ui-v4 Radix Primitives 增量迁移

复制以下内容开启新会话执行本迁移。

---

你在 copilot-api-js 仓库执行 **ui-v4（React 前端，5173）手写交互原语 → Radix Primitives 增量迁移**。

**先读**（按序）：
1. [ui-v4/docs/decisions/2026-07-05-adopt-radix-primitives.md](decisions/2026-07-05-adopt-radix-primitives.md)（ADR：WHY / 手写原语全清单 + file 锚点 / Radix 映射 / 取舍 / 未采纳方案）
2. [ui-v4/docs/plans/2026-07-05-radix-migration.md](plans/2026-07-05-radix-migration.md)（本迁移 plan：commit invariants / 分阶段 / 门禁）
3. [ui-v4/docs/DESIGN.md](DESIGN.md) §2 技术栈、§8 视觉方向（Terminal Amber）

**核心不变量（每 commit 终态成立）**：① 视觉零变化（保留 Terminal Amber CSS 变量 / `.mono` / `rounded:0`，经 Radix `data-state` 驱动）② 行为等价（现有 `tests/*.vitest.test.tsx` 作 oracle，全绿；仅当断言编码了被 Radix 修正的 a11y 缺陷才显式升级断言并记明）③ a11y 只增不减 ④ 每 phase 门禁全绿：`bun run typecheck:ui-v4` + `bun run build:ui-v4`（真 rollup，验 bundle 增量 + radix-ui 可打包）+ `bun run test:ui-v4` + `bunx eslint ui-v4/src`（**无缓存**，0 error——注意 `eslint --cache` 会对已提交但缓存过期文件假绿，见记忆 `tooling-eslint-cache-false-pass`）。

**从 Phase 0 开始**：`bun add radix-ui`（装当前最新稳定，核对锁定版本，勿凭记忆锁旧版）→ **扩 [tests/setup.ts](tests/setup.ts) 补 Radix 所需 jsdom stub**（`ResizeObserver` / `hasPointerCapture`+`setPointerCapture`+`releasePointerCapture` / `getBoundingClientRect`·`DOMRect` / `scrollTo`——现只 stub `scrollIntoView`，不补则 P1 一开工撞墙）+ 加 Radix `Dialog` smoke test 证 stub 生效 → 建样式桥约定 doc（`ui-v4/docs/radix-styling.md`，含 z-index 契约）→ 为待迁组件补齐 golden 行为快照测试（**`ModelsColumnMenu`/`ModelsFilterBar`/`DetailSubRail` 现无独立测试**，先补；Modal/ModelDetailSubRail 已有）。P0 门禁绿后进 P1（Dialog + Tabs 试点）。

**红线**：
- 保持对外 props 契约不变（如 `Modal` 的 `title`/`onClose`/`children`），让消费者零改动。
- 迁移 Tabs 时删手写 roving/方向键 handler（Radix 白送、自动修正 P4 audit 的 H-1）。
- `useResizableWidth` / `JsonTreeView` **保留手写**（无 Radix 对等件）；splitter 仅按 APG 补键盘可操作。
- `~backend` 只引纯/type-only 模块（否则 rollup 崩，见记忆 `feedback-verify-ui-with-build-not-just-typecheck`）。
- 不自启 dev server；需实测让用户开 5173 目视核对视觉/交互对等。

**每 phase 收尾**：门禁全绿 → 细粒度提交（显式 pathspec、conventional、不加模型署名）→ phase 末派 subagent audit（裁判轴：行为等价 + a11y 只增不减 + 视觉不变 + 长远正确，**非 ROI/YAGNI**）→ 落地后回填 DESIGN §2/§8 + 更新 plan 状态。
