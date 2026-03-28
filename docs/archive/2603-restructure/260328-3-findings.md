# 260328-3 Findings

## 审查标准

本轮只以**当前代码**为准核验 `docs/restructure/*`：

- 只接受当前仓库中的源码、前端构建产物、测试文件、路由注册、实际 import/export 关系作为证据
- 不把其他规划文档、`DESIGN.md`、历史结论、Claude 修改意图当作事实依据
- 因此本文会区分三类结论：
  - **代码已证实**
  - **代码已证伪**
  - **代码无法证明，只是方案/判断/推断**

## 总结

这一版 `docs/restructure` 比前两轮明显更接近代码，但还存在两类问题：

1. 少数**可量化事实**仍然写错了
2. 少数条目把“设计判断”或“历史意图”写成了“已确认事实”

最大的剩余问题仍然是 `usage/route.ts`：代码只能证明它**存在且未注册**，不能证明它一定是“残留文件”或“一定应删除”。

补充复核：在当前工作区重新检查后，`usage` 相关表述在 `README.md` 和 `02-route-organization.md` 中**仍未改成中性表述**，因此这一条发现暂时不能移除。

---

## Findings

### 1. `usage/route.ts` 被写成“已确认残留文件”，这超出了当前代码证据

涉及文档：

- `docs/restructure/README.md:23`
- `docs/restructure/02-route-organization.md:91-108`

文档当前表述把 `src/routes/usage/route.ts` 定性为“已被主动移除注册的残留文件”，并进一步给出“应删除”的结论。

当前代码只能证实这些事实：

- `src/routes/usage/route.ts` 仍然存在，并导出 `usageRoutes`
- `src/routes/index.ts` 没有注册它

对应代码：

- `src/routes/usage/route.ts:1-15`
- `src/routes/index.ts:23-49`

因此，**“存在且未注册”是事实**；但**“残留而非遗漏”**、**“应删除”**都不是当前代码本身能证明的结论。  
如果要继续保留这条判断，文档应明确写成“根据 git 历史/设计演化推测”，而不是“已确认事实”。

### 2. `01-oversized-files.md` 中 `history/store.ts` 的两个数量结论不准确

涉及文档：

- `docs/restructure/01-oversized-files.md:9`
- `docs/restructure/README.md:17`

文档写法：

- `history/store.ts` “包含 30 个类型定义”
- 前端“通过 `~backend/lib/history/store` 导入了 33 个类型”

按当前代码核对：

- `src/lib/history/store.ts:28-396` 中共有 **33 个** `export type` / `export interface`
- `ui/history-v3/src/types/index.ts:7-39` 当前从 `~backend/lib/history/store` re-export 了 **31 个**类型名

对应代码：

- `src/lib/history/store.ts:28-396`
- `ui/history-v3/src/types/index.ts:7-39`

所以这里不是“近似偏差”，而是**两个具体数字都写错了**。

### 3. `01-oversized-files.md` 把 `context/request.ts` 写成“11 个接口”，实际并不是

涉及文档：

- `docs/restructure/01-oversized-files.md:49-53`

当前代码里 `src/lib/context/request.ts` 的类型声明构成是：

- 9 个 `interface`
- 2 个 `type`

对应代码：

- `src/lib/context/request.ts:18-23`
- `src/lib/context/request.ts:28-181`

所以“11 个接口”不准确。更准确的说法应是：

- “11 个类型声明 + 工厂函数”，或
- “9 个接口 + 2 个类型别名 + 工厂函数”

### 4. `04-test-alignment.md` 里“已确认的问题测试文件”有一部分其实是命名判断，不是代码事实

涉及文档：

- `docs/restructure/04-test-alignment.md:8-26`

代码能直接证明的是：

- `system-prompt-manager.test.ts` 同时导入了 `~/lib/config/config` 和 `~/lib/system-prompt`
- `server-tool-rewriting.test.ts` 同时导入了 `~/lib/anthropic/message-tools` 和 `~/lib/anthropic/server-tool-filter`
- `copilot-headers.test.ts` 导入的是 `~/lib/copilot-api`

对应代码：

- `tests/unit/system-prompt-manager.test.ts:10-17`
- `tests/unit/server-tool-rewriting.test.ts:5-12`
- `tests/unit/copilot-headers.test.ts:3-7`

但“名称误导”“属于问题测试文件”属于**命名判断**，不是代码本身能证明的事实。  
这份文档的 import 证据是对的，但标题和措辞比证据更强。

### 5. `06-frontend-cleanup.md` 中“CLAUDE.md 已指出职责过重”不符合本轮代码基准

涉及文档：

- `docs/restructure/06-frontend-cleanup.md:39-43`

当前代码确实能证明 `useHistoryStore.ts` 混合了：

- 数据加载
- 分页
- WS 连接
- 搜索/过滤
- 选择与清空等 UI 动作

对应代码：

- `ui/history-v3/src/composables/useHistoryStore.ts:1-219`

但“CLAUDE.md 已指出”不是代码证据。  
如果这份文档要保持“根据代码确认”的标准，应直接引用 `useHistoryStore.ts` 的职责混合现状，而不是引用外部说明。

### 6. `07-cross-cutting.md` 中“这是 CLAUDE.md 原则 5 的设计选择”不是代码可验证事实

涉及文档：

- `docs/restructure/07-cross-cutting.md:7-18`

当前代码能证实：

- 前端从 `~backend/lib/history/store` 和 `~backend/lib/history/ws` 获取类型
- `src/lib/history/ws.ts` 确实用相对路径 `../ws`，并且文件注释写明了原因
- `history/store.ts` 目前导出总数是 52

对应代码：

- `ui/history-v3/src/types/index.ts:7-39`
- `ui/history-v3/src/types/ws.ts`
- `src/lib/history/ws.ts:1-17`
- `src/lib/history/store.ts`

但“这是某条原则驱动的设计选择”属于**设计意图解释**，不是当前代码能单独证明的事实。  
这里建议把“设计选择”改成“当前实现方式”。

---

## 各文档核验结果

### README.md

结论：**大体准确，但仍有 2 处需要收紧**

- `/history/v3` 与后端路由不一致，代码已证实
- `state.ts` 被 12 个文件直接写入，代码已证实
- 前端双轨页面并存，代码已证实
- `history/store.ts` “30 个类型定义”不准确，应改为 33
- `usage/route.ts` “已被主动移除注册（残留文件）”超出当前代码证据

### 01-oversized-files.md

结论：**主要方向正确，但有 3 个数量/表述问题**

- `history/store.ts` 职责混合，代码已证实
- `error.ts`、`anthropic/sanitize.ts`、`openai/auto-truncate.ts` 属于大文件且职责混合，代码基本支持
- `history/store.ts` 的“30 个类型定义”不准确，实际是 33
- 前端“导入 33 个类型”不准确，当前是 31
- `context/request.ts` “11 个接口”不准确，实际是 9 个 interface + 2 个 type

### 02-route-organization.md

结论：**路由主问题判断成立，但 `usage` 部分写得过强**

- `ui/history-v3/dist/index.html` 的静态资源引用是 `/history/v3/assets/*`，代码已证实
- `src/routes/index.ts` 只挂载 `/history` 和 `/ui`，`historyRoutes` 只处理 `/` 和 `/assets/*`，代码已证实
- 最小 Hono 复现实验也确认 `/history/v3/assets/x` 返回 404
- 因此“资源路径断裂”这个 P0 结论成立
- “生产模式 UI 无法渲染”是**很强的合理推断**，但仍比“资源路由不匹配”多推了一步
- `usage/route.ts` “残留、应删除”不属于当前代码可证实结论

### 03-module-boundaries.md

结论：**描述性事实多数成立，重命名/分组建议本质上是架构判断**

- `ws/index.ts` 350 行、20 exports，代码已证实
- `auto-truncate/index.ts` 425 行、20 exports，代码已证实
- `system-prompt.ts` / `sanitize-system-reminder.ts` 行数和职责描述基本成立
- `shutdown.ts` 403 行、14 exports，代码已证实
- 但“不叫 barrel 就应改名”“不拆分 shutdown.ts”属于设计判断，不是代码可直接证明的事实

### 04-test-alignment.md

结论：**证据表正确，但“问题”定性偏强**

- 各测试文件的 import 映射与文档一致
- `message-sanitizer` / `dedup-tool-calls` / `strip-read-tool-result-tags` 确实共同覆盖了 `anthropic/sanitize.ts` 的不同子功能
- 但“名称误导”“已确认的问题测试文件”应视为建议性结论，而不是纯事实

### 05-state-management.md

结论：**本轮最扎实，基本成立**

- `state.ts` 是可变单例，代码已证实
- 12 个文件直接写 `state.xxx = ...`，代码已证实
- `setServerStartTime` 和 `rebuildModelIndex` 是少数专门入口，代码已证实
- `serverStartTime` 独立于 `State` 接口，代码已证实
- 这里没有发现新的事实性错误

### 06-frontend-cleanup.md

结论：**文件规模和路由现状准确，个别论据来源不符合本轮标准**

- 5 legacy + 5 Vuetify 页面并存，代码已证实
- `/` 重定向到 `/v/dashboard`，代码已证实
- 页面/组件行数表与当前代码一致
- `VDashboardPage.vue`、`VModelsPage.vue`、`useHistoryStore.ts`、`DetailPanel.vue` 都确实混合了多类职责
- 但“CLAUDE.md 已指出”不是代码证据

### 07-cross-cutting.md

结论：**事实层基本准确，但“设计意图”一句应降级**

- 前后端类型耦合存在，代码已证实
- `src/lib/history/ws.ts` 使用相对路径并解释原因，代码已证实
- `vite.config.ts` 中 4 个 proxy 都硬编码 `localhost:4141`，代码已证实
- “这是原则 5 的设计选择”不是代码能独立证明的结论

---

## 建议修改优先级

### 必改

1. 删除或降级 `usage/route.ts` “残留文件/应删除”的确定性表述
2. 修正 `history/store.ts` 的类型数量和前端导入数量
3. 修正 `context/request.ts` 的“11 个接口”表述

### 建议改

1. 把 `04-test-alignment.md` 中“已确认的问题测试文件”改成“已确认的命名/追踪性争议文件”
2. 把 `06-frontend-cleanup.md` 中 `CLAUDE.md 已指出` 改成直接基于代码的职责描述
3. 把 `07-cross-cutting.md` 中“设计选择”改成“当前实现方式”

## 最终判断

按“全面根据代码确认文档说法”这个标准，这一版 `docs/restructure` **已经明显收敛**，但还没有完全达到“事实和判断分离”的程度。

当前状态更准确的评价是：

- **主问题判断基本成立**
- **少数数字仍然错误**
- **少数意图性结论写成了事实**

如果只改上面的 3 个必改点，这套文档就会更接近“可以直接作为代码基准审查稿”的状态。
