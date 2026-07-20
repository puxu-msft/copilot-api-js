# 260327-1 Test Report

## 结论

本轮测试覆盖了前端合并方案当前仍未补完的主要验收项，结论如下：

- 根脚本层面的前端构建、类型检查、单测均通过
- `dev:ui` 下的主路由 `#/v/dashboard`、`#/v/history`、`#/v/logs`、`#/v/models`、`#/v/usage` 均可正常渲染
- legacy 路由 `#/dashboard`、`#/history`、`#/logs`、`#/models`、`#/usage` 也可进入页面并渲染内容
- 已验证的关键交互包括：
  - `History` 页搜索过滤可用
  - `Models` 页 `Cards / Raw` 视图切换逻辑可用
- 本轮发现 1 个需要继续跟进的问题：
  - `History` 页在一次冷启动访问中出现过 `504 Outdated Optimize Dep`（`vue-json-pretty`）和 Vue Router 警告；之后刷新与重复访问未再复现，当前判断为 Vite dev 冷启动相关的间歇性问题

## 测试环境

- 日期：2026-03-27
- 仓库：`/home/xp/src/copilot-api-js`
- 前端运行方式：用户手动启动 `npm run dev:ui`
- 浏览器自动化：Playwright MCP

## 执行项

### 根脚本验证

执行命令：

```bash
npm run build:ui
npm run typecheck:ui
npm run test:ui
```

结果：

- `build:ui` 通过
- `typecheck:ui` 通过
- `test:ui` 通过
  - `159 pass`
  - `0 fail`

### 浏览器路由验证

已验证 Vuetify 路由：

- `#/v/dashboard`
- `#/v/history`
- `#/v/logs`
- `#/v/models`
- `#/v/usage`

已验证 legacy 路由：

- `#/dashboard`
- `#/history`
- `#/logs`
- `#/models`
- `#/usage`

结果：

- 上述路由均可进入
- 标题均为 `Request History - Copilot API`
- Vuetify 路由均存在主内容区并完成渲染
- legacy 路由可渲染页面内容，但结构上不一定使用 `<main>` 标签；这是布局差异，不应误判为空白页

## 详细结果

### 1. Dashboard

结果：`通过`

观察到的关键内容：

- `healthy`
- `WS Live`
- `Authentication`
- `Quota`
- `Configuration`

控制台：

- 未见错误

### 2. History

结果：`通过（有一项间歇性 dev 问题待跟进）`

观察到的关键内容：

- 请求列表渲染正常
- 详情面板渲染正常
- 能加载：
  - `/history/api/entries?limit=20`
  - `/history/api/stats`
  - `/history/api/sessions`
  - `/history/api/entries/:id`

已验证交互：

- 搜索框输入 `nonexistent-xyz-12345` 后，列表从 `20` 条过滤为 `0` 条

本轮问题：

- 在一次冷启动访问 `#/v/history` 时，控制台出现：
  - `Failed to load resource: 504 (Outdated Optimize Dep)`  
    目标资源：`vue-json-pretty.js`
  - Vue Router 警告：
    - `uncaught error during route navigation`
    - `No match found for location with path "/v/"`

复测情况：

- 随后刷新和再次访问 `#/v/history` 时未再复现
- 后续访问控制台为 `0 errors, 0 warnings`
- 对应 `vue-json-pretty` 资源之后返回 `200`

当前判断：

- 更像 Vite 开发态预构建或冷启动时序问题
- 当前证据不足以判断为稳定的前端逻辑错误

### 3. Logs

结果：`通过`

观察到的关键内容：

- `Live Logs`
- 表格正常渲染
- 日志行、模型、耗时、输入/输出 token、预览文本均可见

控制台：

- 未见错误

### 4. Models

结果：`通过`

观察到的关键内容：

- 模型卡片正常渲染
- 可见 vendor / capabilities / endpoints / billing / context 等信息
- 网络请求 `/models?detail=true` 返回 `200`

已验证交互：

- `Cards / Raw` 切换逻辑可用
- 切换后：
  - 卡片视图中的 `Capabilities` 等字段消失
  - 原始模型文本仍可见

说明：

- Playwright 的标准 click 在该页上有一次“元素可见/稳定性等待超时”
- 改用 DOM 触发后切换成功
- 这更像自动化交互层面的稳定性问题，不足以单独认定为页面功能缺陷

### 5. Usage

结果：`通过`

观察到的关键内容：

- `Plan`
- `Resets`
- `Session In / Out / Total`
- `Quota`
- `Model Distribution`

网络请求：

- `/api/status` 返回 `200`

控制台：

- 未见错误

### 6. Legacy 路由

结果：`通过`

说明：

- `#/history` 已确认有实际页面内容，不是白屏
- legacy 页面与 Vuetify 页面结构不同，测试脚本不能以“是否存在 `<main>`”作为唯一判定条件

## 已确认通过项

- 根前端构建通过
- 根前端类型检查通过
- 根前端单测通过
- Vuetify 主路由可访问
- legacy 主路由可访问
- `History` 搜索过滤可用
- `Models` 视图切换可用
- `@mdi/font` 资源可加载
- Vuetify 组件与样式资源可加载
- History / Models / Usage 关键 API 可返回 `200`

## 问题清单

### P2. `History` 冷启动下出现间歇性 `Outdated Optimize Dep`

状态：`未稳定复现，但已观测到一次`

现象：

- 首次访问 `#/v/history` 时，`vue-json-pretty` 返回 `504 Outdated Optimize Dep`
- 同时出现 Vue Router 路由告警

影响：

- 可能导致首次进入 `History` 页时控制台报错
- 当前未观察到持续性页面不可用；刷新后恢复

当前判断：

- 优先怀疑 Vite 开发态依赖预构建缓存，而不是业务代码逻辑

建议下一步：

1. 以“冷启动 dev server -> 首次访问 `#/v/history`”作为最小复现路径
2. 检查 `vue-json-pretty` 是否在首次访问时触发了过期的 optimize-deps 缓存
3. 若问题稳定存在，再决定是否需要调整 Vite optimizeDeps 配置

## 未覆盖项

本轮仍未覆盖的测试有：

- `History` 页筛选器：
  - endpoint
  - status
  - session
- `History` 页分页与 `Older / Newer`
- `History` 页详情区按钮：
  - `Raw`
  - `Copy`
  - `Expand`
  - `Export`
- `Logs` 页实时更新行为
- WebSocket 断线重连与 UI 状态变化
- 后端异常返回下的前端错误态
- `preview:ui` 和生产静态托管路径 `/history/v3/` 的浏览器验收

## 建议

建议将 `docs/merge/260327-1-status.md` 中“浏览器级 UI 验收未完成”的结论更新为：

- 主路由浏览器验收已完成
- 关键基础交互已部分完成
- 仍有 deeper interaction / realtime / production preview 三类测试未完成
