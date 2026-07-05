# 导出单条请求全量信息为 `.json.zst`

> **实施状态：已完成**
> **落地**：—
> **现状锚点**：DESIGN 管理 API `/history/api/entries/:id/export`；ui/src/utils/export-entry.ts
> **备注**：后端 zstd 全量导出 + 前端二进制 fetch 全落地

## Context（为什么做）

ui-v4 详情页现有 "Export" 按钮走 `downloadEntryAsJson(entry.value)`（[export-entry.ts](ui/src/utils/export-entry.ts)）——在浏览器里 `JSON.stringify` 已加载的 entry 存为**明文 JSON**。两个问题：

1. **体积**：完整 entry 含每 attempt 的 `sseEvents`、五腿 headers、rewrites 等，明文动辄数 MB，未压缩不实用。
2. **权威性**：导出依赖前端已加载的对象与前端 `JSON.stringify`，用户担心 old ui 这条路径本身可能丢数据。

用户决策（已确认）：**仅单条 entry**、**后端做 zstd 压缩**、**Export 默认改为 `.json.zst`**，并采用「最佳方案导出全量」。

因此采用**后端权威导出**：新增端点读取规范的 `getEntry(id)`（= `getInFlight(id) ?? getEntryById(id)` → `assembleFullEntry`，系统对「一条 entry」的最丰富形式，含所有 stage / per-attempt sseEvents / 各腿 headers / request_group 展开），服务端 zstd 压缩后回传。这天然保证「全量」，复用已有 `compress`/`compressAsync`（[compression.ts](src/lib/history/sqlite/compression.ts)，zstd L3、node:zlib、Bun/Node 双跑），前端不引入任何 wasm 依赖、bundle 不变。

## 后端改动

### 1. 新增 handler `handleExportEntry`（[src/routes/history/handler.ts](src/routes/history/handler.ts)）
镜像 `handleGetEntry`（L64）的守卫：`isHistoryEnabled()` 否则 400、缺 id 400、`getEntry(id)` 为空 404。成功时：

```ts
const blob = await compressAsync(entry)          // 复用 compression.ts，off 事件循环
const model = entry.outboundResponse?.model || entry.inboundRequest.model || "unknown"
c.header("Content-Type", "application/zstd")
c.header("Content-Disposition", `attachment; filename="${id}_${model}.json.zst"`)
return c.body(blob)                              // Uint8Array
```

- import `compressAsync` from `~/lib/history/sqlite/compression`（子域内部 helper，已 `export`）。
- handler 改 `async`（`c.body` 接受 `Uint8Array`）。

### 2. 注册路由（[src/routes/history/route.ts](src/routes/history/route.ts) L32 附近）
在 `handleGetEntry` 那行下方加：
```ts
historyRoutes.get("/api/entries/:id/export", handleExportEntry)
```
放在 `/api/entries/:id` 之后即可（Hono 静态段 `/export` 不与 `:id` 冲突）。

### 3. OpenAPI（可选，若在意 `/openapi.json` 完整性）
在 [src/routes/openapi-compat.ts](src/routes/openapi-compat.ts) 用 `openAPIRegistry.registerPath()` 加一条简单文档条目（与 history REST 其余端点同档，非精确 zod）。History REST 属「简单 open-object schema」档，纯文档不绑 handler。

## 前端改动

### 4. 重写 [ui/src/utils/export-entry.ts](ui/src/utils/export-entry.ts)
`downloadEntryAsJson` → `downloadEntryAsZst`（名副其实）。改为**按 id 拉后端压缩字节**再触发下载，文件名前端构造（与旧行为一致，浏览器不自动读 Content-Disposition of blob URL）：

```ts
export async function downloadEntryAsZst(entry: HistoryEntry): Promise<void> {
  const blob = await api.fetchEntryExport(entry.id)   // 见下
  const model = entry.outboundResponse?.model || entry.inboundRequest.model || "unknown"
  triggerDownload(blob, `${entry.id}_${model}.json.zst`)
}
```
错误经 `useToast()` 提示（对齐 §已知设计问题「错误处理不一致」——这里显式 catch + toast，不静默）。

### 5. API 层加二进制 fetch（[ui/src/api/http.ts](ui/src/api/http.ts)）
`request<T>` 用 `.json()`，不适配二进制。新增：
```ts
async fetchEntryExport(id: string): Promise<Blob> {
  const res = await fetch(BASE + "/entries/" + id + "/export")
  if (!res.ok) { const body = await res.text().catch(() => "Unknown error"); throw new ApiError(res.status, `${res.status}: ${body}`, body) }
  return res.blob()
}
```

### 6. 更新两处调用点
- [ui/src/pages/vuetify/VDetailPage.vue](ui/src/pages/vuetify/VDetailPage.vue) L106
- [ui/src/components/detail/DetailPanel.vue](ui/src/components/detail/DetailPanel.vue) L136

改为 `void downloadEntryAsZst(entry.value)`（现在是 async），import 名同步更新。按钮文案/图标可保持 "Export"（[DetailToolbar.vue](ui/src/components/detail/DetailToolbar.vue) L103），无需改。

## 复用的既有能力（不新写）
- `getEntry` / `getEntryById` / `assembleFullEntry` — 规范全量 entry（[src/lib/history/queries.ts](src/lib/history/queries.ts)、[sqlite/read.ts](src/lib/history/sqlite/read.ts)、[sqlite/serialize.ts](src/lib/history/sqlite/serialize.ts)）。
- `compressAsync` / `decompress` — zstd 编解码（[compression.ts](src/lib/history/sqlite/compression.ts)）。
- `handleGetEntry` 守卫结构 — 直接镜像。

## 测试

### 后端 `tests/history/export-entry.http.test.ts`（`*.http` — 起 Hono app）
用 `useIsolatedRuntime()` + `createFullTestApp`（见 skill `test-isolation`），seed 一条含 sseEvents 的完整 entry：
1. `GET /history/api/entries/:id/export` → 200、`content-type: application/zstd`、`content-disposition` 含 `.json.zst`。
2. 取 body bytes → `decompress(bytes)` → `toEqual(getEntry(id))`（**独立 oracle**：解压结果逐字段等于规范全量 entry，钉死「全量且无损」）。
3. 未知 id → 404；history 关闭 → 400。

### 前端 vitest `ui/vitest/export-entry.test.ts`（jsdom + mock）
mock `api.fetchEntryExport` 返回一个 Blob + mock `URL.createObjectURL`/anchor click，断言：以正确 `<id>_<model>.json.zst` 名触发下载；fetch 抛错时走 toast、不抛穿。

## 验证命令
- 后端：`bun run test:backend`（含新 http 测试）、`bun run typecheck`。
- 前端：`bun run typecheck:ui`、`bun run test:ui`。
- lint：`bun run lint`（`eslint --fix`，勿直接 prettier）。
- 手动（用户自行起服务，遵守 no-auto-server）：详情页点 Export → 下载 `<id>_<model>.json.zst`；`zstd -d file.json.zst -o -` 或 `python -c "import zstandard,sys,json; ..."` 解压看到完整 entry（含 attempts[].sseEvents）。

## 收尾（completion == doc-sync）
- [DESIGN.md](docs/DESIGN.md) 管理 API 路由表 `/history/api/*` 行补 `POST→GET .../entries/:id/export`（zstd 全量单条导出）。
- ui 的 [CLAUDE.md](ui/CLAUDE.md) API 层小节如提及导出则同步。
- 无遗留 pending 记忆需清理；如导出机制有可复用教训（二进制 fetch 绕过 `request<T>`）再按边界提炼。

## 不在本次范围
- 批量/全库导出（用户明确选「仅单条」；现有 `/history/api/export` 明文全库端点不动）。
- 前端 wasm zstd（用户选后端压缩）。
