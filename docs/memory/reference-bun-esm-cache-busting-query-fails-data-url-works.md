---
name: reference-bun-esm-cache-busting-query-fails-data-url-works
description: Bun 忽略 import() 的 ?v= query cache-busting、热重载 .ts 须用 data-URL；拟下沉 skill bun-node-runtime-gotchas
metadata: 
  node_type: memory
  type: reference
  originSessionId: 7a99eb70-2a38-46f6-90fe-c6c9b3c41e28
---

Bun（实测 1.3.14）**按解析后的文件路径缓存 ESM 模块、忽略 import specifier 的 query string**，所以 Node 专有的 cache-busting 手法 `import(fileUrl + "?v=" + Date.now())` 在 Bun 上**静默返回旧模块**（磁盘已改成新版本仍拿到旧的）。`.ts` 与 `.mjs` 均复现。

**可行的热重载 .ts 手法**（实测重载成功）：读磁盘 → `new Bun.Transpiler({loader:"ts"}).transformSync(src)` → `import("data:text/javascript," + encodeURIComponent(js))`。每次 data-URL specifier 唯一 → 绕过缓存。

**意外但实测为真**：data-URL 模块 import `~/lib/xxx` 时 **`~/` tsconfig-paths 别名仍解析成功**（无文件系统锚点也能走 Bun 的 paths 解析），exp/ 真实文件同样解析成功。故用 data-URL 重载不牺牲别名 import 契约。

**Why**：copilot-api-js 的 upstream-hook 特性 `POST /api/hooks/reload` 依赖热重载 ad-hoc .ts hook 文件；对抗评审用 Bun 探针实测推翻了原 spec 的 `?v=` 假设（属承重机制、写码前挡下）。

**How to apply**：任何在 Bun 运行时做「改文件后不重启进程重新加载模块」的场景（hook/插件/config-as-code），别用 `?v=` query，用 data-URL + Transpiler。用 node:sqlite 那种 `require.cache` 删除法也不适用（ESM 无 require.cache）。属 [[reference-undici-websocket-runtime-split-bun-vs-node]] 同类的 Bun-vs-Node 运行时分歧，拟下沉 skill `bun-node-runtime-gotchas`。相关特性 [[project-upstream-hook-middleware]]。
