# /models API 文档审阅 260331-1

## 结论

这次复查后，上一轮指出的主要问题已经被文档吸收并修正，文档现在已经基本可以作为实施输入使用。

我重点复核了以下几项，当前都已与代码现状对齐：

- `?detail=true` 不再被定义为“应删除的参数”，而是保留兼容、语义等价的 no-op。
- 前端影响面已明确覆盖两条链路：
  - Vuetify `VModelsPage`
  - legacy `ModelsPage.vue`
- `src/lib/models/client.ts` 的现状描述已修正为：
  - `policy`、`request_headers` 已存在
  - 真正缺少的是 `is_chat_default`、`is_chat_fallback`
- `request_headers` 已区分为“运行时可能出现的内部字段”，不再与 `refs/AVAILABLE_MODELS.json` 的快照字段集混淆。
- 测试计划已补入 `tests/e2e-ui/api-endpoints.pw.ts`，并明确 `GET /models?detail=true` 需要验证兼容语义。

## 当前判断

文档的核心方案是可信的：

1. `/models` 默认返回完整上游模型对象，仅剥离 `request_headers`。
2. `/models/:id` 同样按上述原则返回。
3. `?detail=true` 保留兼容，不制造额外 breaking change。
4. 前端按上游字段名消费：`vendor`、`name`，不再依赖 `owned_by`、`display_name`。
5. 测试目标已经覆盖 API 契约、前端适配和兼容语义。

按当前版本，我认为**可以进入实现阶段**。

## 唯一剩余的非阻塞建议

### 1. 原则引用仍写成 `CLAUDE.md`，建议改为当前仓库实际约束来源

相关文档：
- `docs/2603-api-models/README.md:5`

问题：
- 文档开头仍写“违反了 CLAUDE.md 原则3”。
- 当前仓库和本次会话里实际可见、可验证的项目约束来源是 `AGENTS.md`，其中已经明确要求“Data flows in its richest form; presentation decisions belong to the final consumer.”

建议：
- 将这里改为引用 `AGENTS.md`，或者直接写项目原则本身，避免引用一个当前仓库上下文中不可见的文件名。

这条不影响方案正确性，也**不阻塞实施**。

## 最终结论

本轮复查未发现新的阻塞性问题。  
文档已基本完成收敛，可以进入实现。  
如果要继续打磨，只建议顺手修正开头那一处 `CLAUDE.md` 引用。  
