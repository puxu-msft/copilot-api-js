---
name: feedback-verify-ui-with-build-not-just-typecheck
description: 前端从 ~backend 引入的模块必须是纯的;typecheck+stub 测试会假绿,只有 bun run build:ui 才暴露"拖入后端运行时 import"导致整页加载失败
metadata:
  type: feedback
---

交付 UI 改动前**必须跑 `bun run build:ui`**(真实 vite/rollup bundle),不能只靠 `typecheck:ui` + vitest stub 测试——三者的模块解析语义不同,后者会假绿。

**Why(踩坑实录)**:Models 页从 `~backend/lib/models/resolver` 引入 `normalizeModelId`,但 `resolver.ts` 内部 `import { state } from "~/lib/state"`(后端运行时)。结果:
- `typecheck:ui` 用 tsconfig path 把 `~/lib/state` 当**类型**解析 → 通过(假绿);
- vitest 用 stub、不走真实模块图 → 通过(假绿);
- 只有 `build:ui` 的 rollup 解析**运行时 import** → `Rollup failed to resolve import "~/lib/state"` → **整个 `/models` 模块图加载失败、页面毫无变化**。

我当时宣告"交付/全绿"却没跑 build,用户打开页面毫无变化才暴露。这是 [[feedback-multidim-completeness-audit-before-claiming-done]] 的具体失败形态("活路径真被执行?传输层真到达?"漏了 bundle 这一维度)。

**How to apply**:
- **前端从 `~backend/*` 引入的每个模块必须是纯的**(SDK-free、不 import `~/lib/state`/`consola`/node 内建/任何后端运行时)。`capabilities.ts`(纯派生)、`client.ts`(纯类型)可跨界;`resolver.ts`(import state)不可。需要后端某个纯函数时,把它抽到**无依赖模块**(如 `normalize-id.ts`),后端 re-export 保持消费者不变,前端从纯模块引入。single-source-of-truth,不在前端重实现。
- **UI 交付前的验收命令是 `bun run build:ui`**,与 typecheck/test 并列必跑(no-auto-server 不阻碍 build——build 不启服务器)。build 绿 ≠ 页面对,但 build 红 = 页面必死;它是最便宜的"整页真能加载"探针。
- 能启 dev server 时,亲手开页面核对可见变化(工具栏/过滤器/交互),这才是终极验证。
