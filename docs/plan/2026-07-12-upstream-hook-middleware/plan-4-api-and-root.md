# Phase 4：API 路由 + 根路径重定向

> 依赖：Phase 0（`loadUpstreamHookSafe`/`getUpstreamHookState`）。根路径重定向是正交独立微改动、单独 commit。

---

## Task 4.1：`GET /api/hooks`（生效态可查）+ `POST /api/hooks/reload`

**Files:** Create `src/routes/hooks/route.ts`；Modify `src/routes/index.ts:88-94`（挂载）；Test `tests/routes/hooks.http.test.ts`。

route 骨架（勘探 E.1，照 `src/routes/status/route.ts` + `config/route.ts` 模板，OpenAPIHono）：

```ts
// src/routes/hooks/route.ts
import { OpenAPIHono } from "@hono/zod-openapi"
import { getUpstreamHookState, loadUpstreamHookSafe } from "~/lib/pipeline/hooks/loader"
import { state } from "~/lib/state"

export const hooksRoutes = new OpenAPIHono()

// GET / — 生效态（评审 MEDIUM-1）
hooksRoutes.get("/", (c) => {
  const st = getUpstreamHookState()
  return c.json({
    enabled: state.hooksEnabled,
    declaredModule: state.hooksUpstreamModule || null,
    loadedModule: st?.module ?? null,
    loadedAt: st?.loadedAt ?? null,
    version: st?.version ?? null,
    exports: st?.exports ?? [],
    ...(st?.lastReloadError && { lastReloadError: st.lastReloadError }),
  })
})

// POST /reload — data-URL 重载（评审 B1），warn-continue 保留旧（富回执）
hooksRoutes.post("/reload", async (c) => {
  const modulePath = state.hooksUpstreamModule
  if (!modulePath) return c.json({ ok: false, error: "hooks.upstream_module not configured" }, 400)
  const res = await loadUpstreamHookSafe(modulePath)
  if (!res.ok) return c.json({ ok: false, module: modulePath, error: res.error }, 200)  // 200: 保留旧 hook 非致命
  return c.json({ ok: true, module: res.state.module, exports: res.state.exports, version: res.state.version })
})
```

挂载（`src/routes/index.ts` 行 88-94 块加一行 + 顶部 import）：`app.route("/api/hooks", hooksRoutes)`。

- [ ] **Step 1：写失败测试**（Hono app 测试）— 未配置 `GET /api/hooks` → `{enabled:false, exports:[]}`；`POST /api/hooks/reload` 未配置 → 400；配置 valid fixture 后 reload → `{ok:true, exports:["onExchange"]}`、`GET` 反映生效态；配置坏 fixture reload → `{ok:false, error}` 200 + 保留旧。
- [ ] **Step 2：跑确认失败** → **Step 3：写 route + 挂载** → **Step 4：跑绿 + typecheck**。
- [ ] **Step 5：commit**（`git commit -- src/routes/hooks/route.ts src/routes/index.ts tests/routes/hooks.http.test.ts`）。

## Task 4.2：根路径 302 重定向到 /openapi.json（正交微改动）

**Files:** Modify `src/server.ts:88`；Test `tests/` 现有 server 测试追加或新建。

```ts
// server.ts:88
server.get("/", (c) => c.redirect("/openapi.json"))  // Hono c.redirect 默认 302
```

- [ ] **Step 1：写失败测试** — `GET /` → 302、`Location: /openapi.json`。
- [ ] **Step 2：跑确认失败** → **Step 3：改一行** → **Step 4：跑绿**。
- [ ] **Step 5：commit（单独）** — message `feat: redirect root path to /openapi.json`，`git commit -- src/server.ts tests/...`（与 hook 特性解耦）。

**Phase 4 出口验收**：`/api/hooks` GET/POST 单测绿、根路径 302 测试绿、`typecheck` 绿。
