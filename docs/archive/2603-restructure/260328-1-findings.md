# docs/restructure 审查结论

日期：2026-03-28

## 总结

`docs/restructure/` 这组文档的方向并不全错，但当前版本不能直接作为重构执行依据。

核心问题有三类：

1. **关键事实有误**：最严重的是路由/UI 路径现状判断不准，把 `/ui` 和 `/history` 当成 Web UI 主入口，而代码、Vite 配置、E2E 测试、其他设计文档都把 `/history/v3` 当成规范入口。
2. **优先级失真**：文档把“超大文件”问题聚焦为 7 个文件，但当前仓库中 `src/ + ui/history-v3/src/` 实际有 **10 个**文件超过 500 行；如果按 `CLAUDE.md` 的 800 行硬上限算，则又只有 **3 个**文件超限。当前文档把两个阈值混在了一起。
3. **全面性不足**：部分文档只覆盖了“表面整洁度”，没有覆盖更接近项目需求/规划的真实问题，例如 `/history/v3` 静态入口、未注册但仍存在的 `src/routes/usage/route.ts`、以及当前测试体系并不只是“源文件名一一镜像”。

结论：

- `README.md`、`01-oversized-files.md`、`02-route-organization.md`、`04-test-alignment.md`、`07-cross-cutting.md` 都需要修订后才能作为执行计划。
- `03-module-boundaries.md`、`05-state-management.md`、`06-frontend-cleanup.md` 的方向基本合理，但仍有范围和事实层面的遗漏。

## 最高优先级 Findings

### F1. `/history/v3` 才是当前规划中的规范 UI 路径，但重构文档把 `/ui` 和 `/history` 当成主路径

这不是注释级问题，而是路由规划的核心事实错误。

证据：

- `ui/history-v3/src/router.ts:4` 把 hash base 固定为 `/history/v3/`。
- `ui/history-v3/vite.config.ts:22` 把构建 `base` 固定为 `/history/v3/`。
- `ui/history-v3/dist/index.html` 的资源引用也是 `/history/v3/assets/...`。
- `tests/e2e-ui/navigation.spec.ts:18-37` 明确把 `/history -> /history/v3`、`/history/v3` 视为预期行为。
- `docs/DESIGN.md:98-103`、`docs/history.md:58`、`docs/webui/README.md:33-37` 也都把 `/history/v3/*` 写成规范路径。
- 但 `src/routes/index.ts:46-48` 实际只挂了 `/history` 和 `/ui`。
- `src/routes/history/route.ts:54-84` 实际只处理了 `"/"` 和 `"/assets/*"`。

我还做了最小 Hono 复现验证：`app.route("/history", sub)` 只会匹配 `/history` 和 `/history/assets/*`，**不会**匹配 `/history/v3` 或 `/history/v3/assets/*`。

因此：

- `docs/restructure/02-route-organization.md:62-89` 把“给 `/ui` 写注释”列为问题 3，优先级明显失真。
- `docs/restructure/07-cross-cutting.md:54-71` 对静态路径问题的分析前后自相矛盾，而且其中“`/history/v3/assets/*` 会被 `/history` 子路由匹配到”的判断是错误的。

建议：

- 把 `/history/v3` 路由/静态服务一致性提升为 **P0**。
- 在 02 和 07 中明确回答一个问题：最终规范入口到底是 `/history/v3`、`/history`，还是 `/ui`。
- 在这个问题定稿前，不应推进后续注释性整理。

### F2. “7 个超限文件”这个基线不成立，导致 01 和 README 的优先级矩阵失真

`docs/restructure/README.md:10` 写的是“7 个文件超过 500 行，最大 1189 行（违反 CLAUDE.md 的 800 行上限）”。

这里混淆了两个不同标准：

- 如果按 **500 行关注阈值** 算，当前实际有 **10 个**文件超过 500 行：
  - `src/lib/history/store.ts` 1189
  - `src/lib/anthropic/auto-truncate.ts` 1091
  - `src/lib/anthropic/sanitize.ts` 930
  - `src/lib/openai/auto-truncate.ts` 755
  - `ui/history-v3/src/pages/ModelsPage.vue` 713
  - `src/lib/error.ts` 687
  - `ui/history-v3/src/pages/vuetify/VDashboardPage.vue` 668
  - `ui/history-v3/src/pages/DashboardPage.vue` 561
  - `src/lib/adaptive-rate-limiter.ts` 558
  - `src/lib/context/request.ts` 511
- 如果按 **CLAUDE.md 800 行硬上限** 算，则只有 **3 个**文件超限：
  - `src/lib/history/store.ts`
  - `src/lib/anthropic/auto-truncate.ts`
  - `src/lib/anthropic/sanitize.ts`

因此：

- `docs/restructure/01-oversized-files.md:3` 说“以下 7 个文件违反此规则”不准确。
- `docs/restructure/README.md:21` 把 01 定义成“拆分 7 个超限文件”，会直接遗漏 3 个同样超过 500 行的前端文件。
- `docs/restructure/06-frontend-cleanup.md` 被放到 P2，但其中两个页面实际已经比若干 P0/P1 文件更大。

建议：

- 先统一标准：是“解决 >800 的硬违规”，还是“系统性治理 >500 的过大文件”。
- 如果保留 500 行作为重构阈值，就要把 3 个前端大文件纳入总表；不能在 README/01 里说“全量”，再把它们放到后面的附录型文档里。

### F3. 测试对齐文档里有多处测试映射错误，按它执行会误导命名

`docs/restructure/04-test-alignment.md` 的问题意识是对的，但“确认的错位列表”并不可靠。

明确错误的例子：

- `tests/unit/system-prompt-manager.test.ts:10-17` 同时测试 `~/lib/config/config` 和 `~/lib/system-prompt`，不是单纯的 `config.ts` 测试。
  - 所以 `docs/restructure/04-test-alignment.md:28` 建议重命名为 `config-rewrite-rules.test.ts` 不正确，会掩盖它对 `system-prompt.ts` 的覆盖。
- `tests/unit/server-tool-rewriting.test.ts:6-12` 同时覆盖 `~/lib/anthropic/message-tools` 和 `~/lib/anthropic/server-tool-filter`。
  - 所以 `docs/restructure/04-test-alignment.md:32` 把它单独映射到 `server-tool-filter.ts` 不正确。
- `tests/unit/response-utils.test.ts:1-13` 只测 `isNonStreaming`，更像“函数级”测试，不是一个需要被强制镜像成目录结构的复杂模块测试。
- `tests/component/history-api.test.ts:1-43` 已经用 component test 方式直接覆盖 `routes/history/api.ts` 的 handler 层；当前项目测试体系本来就不是“只靠 unit 文件名镜像源路径”。

更大的问题是：`docs/restructure/04-test-alignment.md:15-21,67-68` 把“每个源文件至少有一个同名测试文件”当作目标，这不符合当前项目的测试策略。这个仓库已经明确使用 `unit / component / integration / e2e / contract` 分层测试，而不是“一源文件一测试文件”的镜像式策略。

建议：

- 04 应从“文件名整齐”改成“**可追踪性**”目标。
- 先区分：
  - 单函数/单模块单元测试
  - 面向 API handler 的 component test
  - 面向跨模块行为的 integration test
- 只修正明显误导的名字，不要把“镜像源路径”上升为统一原则。

## 中优先级 Findings

### F4. `07-cross-cutting.md` 对静态路径问题的结论错误，而且遗漏了更大的根因

`docs/restructure/07-cross-cutting.md:56-66` 先说“实际上没有路径不匹配问题”，后面又说“这是一个实际存在的路径匹配问题”，自身已经矛盾。

更关键的是，它给出的解释不成立：

- `src/routes/history/route.ts:65-84` 只注册了 `"/assets/*"`。
- 该路由不会自然覆盖 `/history/v3/assets/*`。
- 文档把根因弱化成“加启动 warning 和注释”，但当前真正需要的是 **路由设计修正**，不是注释修正。

建议：

- 07 中这一节应重写为“静态 UI 入口与资源路径设计不一致”，而不是“需要验证的疑点”。
- 修复项至少要覆盖：
  - `/history/v3`
  - `/history/v3/assets/*`
  - `/history` 是否 redirect 到 `/history/v3`
  - `/ui` 是否保留、若保留是 alias 还是独立入口

### F5. `05-state-management.md` 问题成立，但方案范围不完整

`docs/restructure/05-state-management.md` 正确指出了 `state.ts` 可随意写的问题，但它低估了当前写入面。

我用 `rg 'state\\.[A-Za-z0-9_]+\\s*=' src` 检查后，直接写入分布至少在这些文件中：

- `src/start.ts`
- `src/auth.ts`
- `src/check-usage.ts`
- `src/debug.ts`
- `src/setup-claude-code.ts`
- `src/lib/config/config.ts`
- `src/lib/copilot-api.ts`
- `src/lib/models/client.ts`
- `src/lib/token/index.ts`
- `src/lib/token/copilot-token-manager.ts`
- `src/lib/token/providers/base.ts`
- `src/lib/state.ts`

此外文档本身还有两处不完整：

- `docs/restructure/05-state-management.md:17` 把 `serverStartTime` 放进“杂项字段”，但真实代码里它不是 `state` 字段，而是 `src/lib/state.ts:189-195` 的独立导出变量。
- `docs/restructure/05-state-management.md:49-56` 的 setter 分组没有覆盖所有真实字段，例如 `verbose`、`showGitHubToken`、`vsCodeVersion`、`adaptiveRateLimitConfig`、`systemPromptOverrides`。

建议：

- 如果要做 setter 化，必须把 CLI 命令层和 token/config 子模块一起纳入迁移范围。
- 文档里要先区分三类状态：
  - 持久配置映射值
  - 运行时缓存
  - 生命周期状态（如 `serverStartTime`）

### F6. `06-frontend-cleanup.md` 方向基本合理，但事实数据已经明显过时

`docs/restructure/06-frontend-cleanup.md:11-15,41-44` 的多处行数已经不对。当前实际行为：

- `ui/history-v3/src/pages/ModelsPage.vue` 713 行，不是 494 行
- `ui/history-v3/src/pages/vuetify/VDashboardPage.vue` 668 行，不是 530 行
- `ui/history-v3/src/pages/DashboardPage.vue` 561 行，不是 358 行
- `ui/history-v3/src/pages/vuetify/VModelsPage.vue` 499 行，不是 389 行
- `ui/history-v3/src/components/detail/DetailPanel.vue` 475 行，不是 429 行
- `ui/history-v3/src/composables/useHistoryStore.ts` 444 行，不是 437 行

同时，它把重点只放在 Vuetify 页面上，也不完全符合当前仓库状态：

- Legacy `ModelsPage.vue` 和 `DashboardPage.vue` 反而比对应的 Vuetify 页面更大。
- 如果目标是“减小大组件”，那 Legacy 页面不能只用“加废弃注释”一笔带过。

建议：

- 06 应拆成两个子问题：
  - Legacy/Vuetify 双轨是否继续保留
  - 哪些页面/组件是当前真实的大文件治理对象
- 如果决定保留双轨，至少要明确 legacy 页面只做维护，不再继续长大。

### F7. `03-module-boundaries.md` 整体可行，但有一条已经被代码解决

`docs/restructure/07-cross-cutting.md:19-32` 说 `src/lib/history/ws.ts` 的相对路径 workaround 需要加注释。

但真实代码里这个注释已经存在：

- `src/lib/history/ws.ts:1-13`

这说明文档基线不是当前代码，而是较早状态。

这不是严重错误，但说明这组文档需要重新以当前仓库为基线做一遍 refresh。

## 低优先级 Findings

### F8. `README.md` 背景引用了不存在的 `docs/merge/`

`docs/restructure/README.md:5` 写的是“前后端合并（docs/merge/）完成后”，但仓库里并没有 `docs/merge/` 目录，相关文档现在在 `docs/archive/2603-merge/`。

这是小问题，但会让读者误以为有一组现行 merge 文档可追溯。

### F9. `02-route-organization.md` 对“路由组织”的覆盖并不完整

如果 02 真要讨论路由组织，至少还应覆盖两个现状：

- `src/routes/usage/route.ts` 仍然存在，但 `src/routes/index.ts` 并未注册它。
- `src/routes/index.ts:46` 的注释写的是“`/history/api/*, /history/ws` + Web UI (`/ui`)”，但实际 Web UI 规划与测试都已转向 `/history/v3`。

也就是说，02 现在更像“命名清理笔记”，还不是完整的路由组织文档。

## 分文档评级

| 文档 | 真实性 | 正确性 | 全面性 | 结论 |
|------|--------|--------|--------|------|
| `README.md` | 中 | 低 | 中 | 需重写部分总览和优先级基线 |
| `01-oversized-files.md` | 中 | 中 | 低 | 方向可用，但必须先统一阈值并补齐前端大文件 |
| `02-route-organization.md` | 低 | 低 | 低 | 当前不能直接执行，需先解决 `/history/v3` 事实基线 |
| `03-module-boundaries.md` | 中高 | 中高 | 中 | 基本可用，但需以当前代码刷新一遍 |
| `04-test-alignment.md` | 中 | 低 | 低 | 需要从“命名整齐”改为“测试可追踪性” |
| `05-state-management.md` | 高 | 中 | 中 | 问题判断正确，实施范围需补全 |
| `06-frontend-cleanup.md` | 中 | 中 | 中 | 方向合理，但数字和治理对象要更新 |
| `07-cross-cutting.md` | 中 | 低 | 中 | 类型部分基本对，静态路径部分需要重写 |

## 建议的修订顺序

1. 先修 `02` 和 `07`，把 `/history/v3`、`/history`、`/ui` 的真实目标路径和静态资源路径说清楚。
2. 再修 `README` 和 `01`，统一“大文件”阈值，并重排 P0/P1/P2。
3. 再修 `04`，把测试目标从“文件名镜像”改成“覆盖映射清晰”。
4. 最后补 `05`、`06`、`03` 的范围细节。

## 建议的最小修订原则

- 不要再以旧文档或旧印象为基线，直接以当前代码和当前测试为基线重写。
- 每个重构文档都应区分：
  - **已确认事实**
  - **待验证假设**
  - **建议方案**
- 涉及路径、路由、测试覆盖时，必须同时对照：
  - 当前代码
  - 当前测试
  - 当前现行设计文档

否则重构计划会持续把“旧问题”当成“现问题”，把“真正的结构问题”降级成注释问题。
