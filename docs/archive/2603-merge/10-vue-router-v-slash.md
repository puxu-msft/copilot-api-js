# P3：Vue Router `/v/` 路径告警

**状态：已修复** ✅

从 [09-p2-cold-start-504.md](09-p2-cold-start-504.md) 拆出。此问题与 Vite optimizeDeps 504 无关。

## 现象

控制台出现 Vue Router 警告：

```
[Vue Router warn]: No match found for location with path "/v/"
```

## 根因分析

路由表中没有 `/v/` 路径。已定义的 Vuetify 路由为：

- `/v/history`、`/v/logs`、`/v/dashboard`、`/v/models`、`/v/usage`

`NavBar.vue` 中的 UI 切换逻辑在根路径时会生成无效的 `/v/`：

```ts
const switchPath = computed(() => {
  const p = route.path
  if (p.startsWith("/v/")) return p.replace("/v/", "/")
  return "/v" + p   // 当 p === "/" 时 → "/v/" — 无对应路由
})
```

由于路由表配置了 `{ path: "/", redirect: "/v/dashboard" }`，用户首次进入时 `route.path` 短暂为 `/`，
此时 `switchPath` 计算出 `/v/`，触发 Vue Router 警告。

## 修复内容

路由切换逻辑提取为独立工具函数 `ui/history-v3/src/utils/route-variants.ts`：

```ts
export function getVariantSwitchPath(path: string): string {
  if (path === "/") {
    return "/v/dashboard"
  }
  if (isVuetifyPath(path)) {
    return path.replace("/v/", "/")
  }
  return `/v${path}`
}
```

`NavBar.vue` 改为调用 `getVariantSwitchPath(route.path)`，根路径特殊情况得到正确处理。

配套新增了测试文件 `ui/history-v3/tests/route-variants.test.ts`。

## 优先级

P3 — 仅产生控制台警告，不影响功能。
