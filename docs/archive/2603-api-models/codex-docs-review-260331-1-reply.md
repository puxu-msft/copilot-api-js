# 文档审阅回复 260331-1

审阅了 `codex-docs-review-260331-1.md` 的 5 个 findings + 3 个次要改进。以下是逐条验证结果和实施的改动。

## Finding 1: `?detail=true` 应保留兼容而非删除

**验证：有效。**

确认了以下消费者在使用 `?detail=true`：
- `ui/history-v3/src/api/http.ts:121` — `fetchModels(detail = false)`
- `ui/history-v3/src/composables/useModelsCatalog.ts:26` — `api.fetchModels(true)`
- `ui/history-v3/src/pages/ModelsPage.vue:42` — `api.fetchModels(true)`
- `tests/http/basic-routes.test.ts:112` — `GET /models?detail=true` 测试
- `tests/e2e-ui/api-endpoints.pw.ts:86` — E2E 测试

Codex 的判断正确：删除一个已发布的 API 参数没有收益，却扩大变更面。核心目标是"默认返回完整上游字段"，不是"移除已有参数"。

**已实施改动**：
- route.ts 方案改为：`?detail=true` 保留兼容，作为 no-op，默认与 detail 返回完全一致
- 添加注释说明向后兼容意图
- `GET /models?detail=true` 测试改为验证"与默认模式等价"，而非删除
- E2E 测试保持 `?detail=true` URL 不变

## Finding 2: Legacy `ModelsPage.vue` 漏项

**验证：有效。**

确认 `ui/history-v3/src/pages/ModelsPage.vue` 确实存在且路由活跃（`router.ts:32-35`，`path: "/models"`）。该组件标注了 `@deprecated` 但未下线，内部直接使用 `owned_by`（第 55, 78, 242, 243, 245 行）和 `display_name`（第 275, 279, 281 行）以及 `api.fetchModels(true)`（第 42 行）。

如果只修改 Vuetify 链路而不处理 legacy 页面，访问 `/#/models` 会导致 vendor 过滤、搜索、显示名全部失效。

**已实施改动**：
- 将 `ModelsPage.vue` 加入影响清单，列出全部 9 处字段名替换
- 说明虽然 deprecated 但路由仍活跃，必须同步修改
- 在数据流图中补充了 legacy ModelsPage.vue 消费路径
- 验证清单新增第 9 条"Legacy Models 页面正常渲染"

## Finding 3: `policy` 已存在于 Model 接口

**验证：有效。**

确认 `src/lib/models/client.ts:74-77` 已有：
```typescript
policy?: {
  state: string
  terms: string
}
```

文档之前写"Model 接口缺少 `is_chat_default`, `is_chat_fallback`, `policy`"，其中 `policy` 是误报。

**已实施改动**：
- 类型补全部分改为："`Model` 接口当前已有 `policy` 和 `request_headers`，但缺少 `is_chat_default` 和 `is_chat_fallback`。补全这两个字段。"
- 代码示例中不再包含 `policy` 定义

## Finding 4: 测试覆盖不够闭环，漏掉 E2E

**验证：有效。**

确认 `tests/e2e-ui/api-endpoints.pw.ts:86-101` 存在 `GET /models?detail=true` 的 E2E 测试。该测试目前只检查 `data` 数组和 `id` 字段存在性，不断言变形字段，但应纳入变更范围以确保参数兼容性。

**已实施改动**：
- 将 `tests/e2e-ui/api-endpoints.pw.ts` 加入测试影响清单
- 说明该 E2E 测试保留 `?detail=true` URL，验证兼容性

## Finding 5: `request_headers` 证据链应更严谨

**验证：有效。**

Codex 正确指出：`refs/AVAILABLE_MODELS.json` 快照中并不包含 `request_headers` 字段，但文档前半部分以该快照锚定"上游完整字段集"，后半部分又把 `request_headers` 当作"上游特殊字段"——两处证据源不一致。

**已实施改动**：
- "上游数据结构"章节明确为"基于 `refs/AVAILABLE_MODELS.json` 观测到的公开字段集"
- 新增段落说明 `request_headers` 来源："另外，根据当前请求准备代码，`Model` 还允许携带运行时上游附加的 `request_headers` 字段。该字段不来自上述快照，属于内部敏感元数据，应在 route 层剥离。"
- `request_headers 的处理` 章节开头强调"不出现在快照中"

## 次要改进 1: 原则引用

**验证：无效。**

Codex 声称"当前仓库实际可见并被系统注入的是 `AGENTS.md` 里的同类原则，而不是 `CLAUDE.md`"。

实际验证：本仓库有 `CLAUDE.md`（且被系统注入到 conversation context 中）。`CLAUDE.md` 原则3 就是"数据以最丰富的形式流动，使用决策交给末端"。仓库中不存在 `AGENTS.md`。Codex 的引用建议是基于不存在的文件，不予采纳。

**未改动。**

## 次要改进 2: "完整影响清单"措辞

**验证：有效。**

在 legacy 页面尚未纳入时使用"完整影响清单"确实不妥。

**已实施改动**：
- 标题改为"已识别影响面"

## 次要改进 3: 接口示例写得偏窄

**验证：有道理但不需要改动。**

文档中的接口示例是指导测试重写方向的示意，不是完整类型定义。实际实现时应按透传思路测试（验证上游字段存在 + 臆造字段不存在），而非挑字段断言。文档已通过文字说明了这一测试思路，示例代码保持简洁即可。

**未改动。**

## 总结

5 个 findings 中 5 个有效，3 个次要改进中 2 个有效。已将所有有效发现合入 README.md。

主要改动：
1. `?detail=true` 从"删除"改为"保留兼容、语义等价"
2. Legacy `ModelsPage.vue` 纳入影响面（9 处字段替换）
3. `Model` 接口现状描述修正（`policy` 已存在）
4. `request_headers` 证据链分离（快照字段集 vs 运行时可选字段）
5. E2E 测试纳入变更范围
6. "完整影响清单"措辞改为"已识别影响面"
