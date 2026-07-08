---
name: feedback-verify-ui-with-build-not-just-typecheck
description: ui-v4 验收有两条独立盲区——根 typecheck 不覆盖 ui-v4 子项目、build:ui-v4(esbuild)不做类型检查、且只有 rollup 暴露拖入后端运行时；见 skill debugging-frontend-tests
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9adc2eaf-0885-437d-9c58-0b8c86859381
---

**ui-v4 交付验收有两条正交盲区,漏任一都会假绿(应下沉 skill `debugging-frontend-tests`):**

1. **类型覆盖盲区。** 根 `bun run typecheck`(=`tsc` 走根 tsconfig)**不包含 ui-v4 子项目**(`copilot-api-ui-v4` 是独立 workspace),且 `build:ui-v4`(Vite/Rolldown 用 esbuild 转译)**不做类型检查**。所以一个前端 TYPE 错误能同时通过根 typecheck + build:ui-v4 两道门。前端类型的权威门是 **`bun run typecheck:ui-v4`**(=`bun run --filter copilot-api-ui-v4 typecheck`)。实例(2026-07-08 LiveDock):B1+B2 的 reducer 联合收窄漏洞 + `types/ws.ts` 的 `export type {X as Y} from` 不建本地绑定,根 typecheck + build:ui-v4 全绿却在 typecheck:ui-v4 报 3 个真错。

2. **运行时纯度盲区。** 前端从 `~backend/*` 引入的模块必须纯(不 import `~/lib/state` 等后端运行时);type-only re-export(`import type`/`export type`)被 isolatedModules 擦除是安全的,但一旦误写值导入,`typecheck` + vitest stub 会假绿,只有 `bun run build:ui-v4` 的 rollup 解析运行时 import 才暴露"拖入后端"→整页加载失败。

**ui-v4 交付验收命令集 = `typecheck:ui-v4`(类型)+ `build:ui-v4`(rollup 纯度)+ vitest。** 注意 `build:ui` 是旧 Vue `ui/`、`build:ui-v4` 才是 React `ui-v4/`——别用错。布局/叠加几何 jsdom 测不了,须浏览器人工核。
