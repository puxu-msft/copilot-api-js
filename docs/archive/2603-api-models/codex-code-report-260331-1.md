# /models API 实施报告 260331-1

## 实施范围

本轮按 `docs/2603-api-models/README.md` 落地了 `/models` 忠实度修复，覆盖：

- 后端 `/models` / `/models/:id` 响应契约
- `Model` 类型补全
- Vuetify Models 页面链路
- legacy Models 页面链路
- 组件测试、HTTP 测试、部分 E2E 断言与相关强类型 mock

## 已完成改动

### 1. 后端：`/models` 改为完整透传，仅剥离 `request_headers`

修改文件：
- `src/routes/models/route.ts`
- `src/lib/models/client.ts`

结果：
- 删除了 `formatModel()`、`formatModelDetail()`、`EPOCH_ISO`
- `GET /models` 现在返回完整 public model payload
- `GET /models/:id` 同样返回完整 public model payload
- `request_headers` 在 route 层被显式剥离，不对外暴露
- `has_more`、`type`、`created`、`created_at`、`owned_by`、`display_name` 不再注入
- `?detail=true` 继续接受，但语义上为 no-op，返回值与默认 `/models` 等价

`Model` 类型新增：
- `is_chat_default`
- `is_chat_fallback`

### 2. 前端：切换到上游字段名

修改文件：
- `ui/history-v3/src/api/http.ts`
- `ui/history-v3/src/composables/useModelsCatalog.ts`
- `ui/history-v3/src/components/models/ModelCard.vue`
- `ui/history-v3/src/components/models/ModelsFilterBar.vue`
- `ui/history-v3/src/pages/ModelsPage.vue`

结果：
- `fetchModels(true)` 改为 `fetchModels()`
- Vuetify models 页面改为消费 `vendor` / `name`
- legacy models 页面也同步改为消费 `vendor` / `name`
- Vuetify filters 搜索框 placeholder 调整为 `Search model id or name`

### 3. 测试与 mock 同步

修改文件：
- `tests/helpers/factories.ts`
- `tests/component/supported-endpoints.test.ts`
- `tests/component/models-endpoint.test.ts`
- `tests/http/basic-routes.test.ts`
- `tests/e2e-ui/api-endpoints.pw.ts`
- `tests/e2e-ui/navigation.pw.ts`
- `tests/e2e-ui/vuetify-models.pw.ts`
- `tests/component/auto-truncate.test.ts`
- `tests/component/model-resolver.test.ts`

结果：
- 所有强类型 `Model` mock 补齐 `is_chat_default` / `is_chat_fallback`
- `models-endpoint` 测试从“复制旧格式化逻辑”改为“验证透传契约”
- `basic-routes` 改为断言上游字段名，并验证没有 fabricated fields
- `GET /models?detail=true` 改为验证与默认 `/models` 等价
- 相关 E2E 断言同步到新的 placeholder 和 `/models` 兼容语义

## 验证结果

已执行并通过：

```bash
npm run typecheck
npm run typecheck:ui
bun test tests/component/models-endpoint.test.ts tests/component/supported-endpoints.test.ts tests/http/basic-routes.test.ts tests/unit/models-client.test.ts
bun test tests/component/auto-truncate.test.ts tests/component/model-resolver.test.ts
```

## 未执行项

以下测试文件已更新，但本轮未实际跑浏览器 E2E：

- `tests/e2e-ui/api-endpoints.pw.ts`
- `tests/e2e-ui/navigation.pw.ts`
- `tests/e2e-ui/vuetify-models.pw.ts`

原因：
- 本轮没有额外启动或接管一套后端 + 浏览器 E2E 环境
- 代码层、类型层与后端契约层已完成验证，但浏览器端回归仍建议在现成环境下补跑一次

## 结果判断

当前实现已经达到文档目标：

1. `/models` 默认返回完整上游字段，仅剥离 `request_headers`
2. `/models/:id` 同样返回完整字段
3. `?detail=true` 保留兼容，不引入 breaking change
4. 前端两套 Models 页面都已从 `owned_by` / `display_name` 切换到 `vendor` / `name`
5. 相关测试和类型系统已同步更新
