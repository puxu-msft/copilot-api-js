---
name: feedback-verify-ui-with-build-not-just-typecheck
description: UI 交付必跑 build:ui(typecheck+stub 假绿)已归入 skill debugging-frontend-tests；见那里
metadata:
  type: feedback
---

**已归入 skill `debugging-frontend-tests`（交付前跑 build:ui）。** 钩子：前端从 `~backend/*` 引入的模块必须纯（不 import `~/lib/state` 等后端运行时）；`typecheck:ui` + vitest stub 会假绿，只有 `bun run build:ui` 的 rollup 解析运行时 import 才暴露"拖入后端 import"→整页加载失败。UI 交付验收命令=build:ui。
