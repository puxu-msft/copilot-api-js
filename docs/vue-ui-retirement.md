# Vue `ui/` 退役路线图（增量迁移到 React `ui-v4/`）

> **[2026-07-22 时效性警告]** 本文写作时的前提是「主服务器同时挂载 `/ui`（Vue）+ `/ui-v4`（React）两条路由，退役 = 删主服务器路由」（见 §1 现状锚点原文）。**该前提已被 UI 外置改动推翻**：主服务器不再服务/代理/构建任何前端 UI，两个前端都保留、都由运维独立托管（见 [DESIGN.md](DESIGN.md)「前端子项目」+ README「Hosting the Web UI」）。因此「退役」的含义从「删主服务器的 `/ui` mount」变成「决定运维还托管哪个/哪些静态产物、`ui/` 本身是否/何时整体删除」——**下文逐页迁移方法论、退役检查清单（§2/§3）、已完成退役日志（§4）作为方法论历史仍完整有效**（models 页退役的实测经验、共享件教训依然适用于任何后续页面迁移），但**§1「现状锚点」一段（主服务器双 mount 的表述）与「删主服务器路由」的隐含前提已过时**，读者应以 DESIGN.md「活的架构现状」为准核对当前主服务器路由挂载事实。（**2026-07-28 二次订正**：本段原写「两个 workspace 都保留」——`ui/` 已于当日移出 bun workspaces，不再是 workspace 成员，见 §0。）

- 创建：2026-07-10
- 归属：前端子项目退役跟踪。**这是「哪些 Vue 页面还能删、怎么删」的单一事实源。**
- ~~现状锚点：`ui-v4/` 是**当前活的** React History UI（`/ui-v4`）；`ui/` 是**旧 Vue** UI（`/ui`），正被逐页退役。两者并行挂载见 [DESIGN.md](DESIGN.md)「活的架构现状」+ `src/routes/index.ts`（`/ui` + `/ui-v4` 双 mount）。~~ （已过时，见上方警告——主服务器已不挂载任一 UI）
- 相关：[ui/CLAUDE.md](../ui/CLAUDE.md)、models 退役 spec [spec/2026-07-08-ui-v4-models-list-parity.md](spec/2026-07-08-ui-v4-models-list-parity.md) + [spec/2026-07-08-ui-v4-raw-json-dual-view.md](spec/2026-07-08-ui-v4-raw-json-dual-view.md)。

## 0. 工具链脱钩（2026-07-28，已完成）

**退役的第一步不是删页，是让 `ui/` 不再拖累主线。** 逐页 parity 审计（§1–§3）是笔慢账，在它走完之前，一个没人开发的前端不该继续占用每次 `bun install` 和每次 `eslint .`。故先把编译链切断，页面按原节奏慢慢退。

用户 2026-07-28 拍板的三条边界：

| 链路 | 脱钩后 | 说明 |
|---|---|---|
| bun workspace | **移出** | 根 `workspaces` 不再含 `ui`；`ui/` 自带 `bun.lock`，须 `cd ui && bun install` |
| root `eslint .` | **整体 ignore** | `ui/**` 不再 lint。连带移除根三个纯 Vue devDep（`eslint-plugin-vue`/`@vue/eslint-config-typescript`/`vue-eslint-parser`）与 `defineConfigWithVueTs` 包裹 |
| root `knip` | **整体 ignore** | 新建 `knip.json` 排除 `ui/**`。**反直觉**：移出 workspaces 不会让 knip 忽略该目录，反而把 `ui/` 从「有自己 entry point 的 workspace」降级成「一堆没人引用的散文件」——脱钩当天 knip 因此把 97 个 ui 文件报成 unused |
| 根 `*:ui` 脚本 | **保留，改 `cd` 形式** | 9 个入口名不变，实现从 `--filter copilot-api-ui`（已不能解析）改为 `cd ui && bun run …` |
| `~backend/*` | **保留** | 刻意留下的主要耦合，见下方「代价」 |
| `ui/bunfig.toml` preload | **保留** | 向上引用仓库的 `tests/helpers/sandbox-paths.ts`（测试期 fs 沙箱地板）。单向、单文件，沙箱比自足重要 |

已经无需处理的：根 `build`（2026-07-22 UI 外置时就不链 UI 了）、根 `tsconfig`（`include` 从来不含 `ui/`）、后端测试档位（`tests/infra/test-discovery-matrix.unit.test.ts` 已禁止聚合前端套件）。经异模型 reviewer 逐个入口核查后确认未拉链的还有：`bunfig.toml`（root 与 ui 各一份）、`tsdown.config.ts`、`prettier.config.mjs`、`prepare`/`prepack`/`release` 生命周期、发布 `files`（实跑 `npm pack --dry-run` 得 8 个文件、UI 为 0）、`scripts/**`、`.gitignore`、`.claude/`、`contrib/`。

脱钩后 root lint 问题数 395 → 368，正好少掉 `ui/` 的 27 个，其余目录一个不增；root knip 的 `ui/` 条目 97 → 0，其余 10158 条逐条不变（集合恒等）。机器护栏见 `tests/infra/ui-v3-decoupling.unit.test.ts`（workspaces / tsconfig / eslint ignore / knip ignore / `--filter` 残留五项，含「ui 目录仍存在」的非空转前提校验与变异正样本对照）。

> **附带发现（不在本次范围，未处理）**：root `knip` 本身目前是不可用的噪音源——它没有任何配置（`knip.json` 是本次为排除 ui 才新建的），总计报出 10255 条，其中 `refs/`（vendored 的 Claude Code 参考源码）独占 9403 条、`tests/` 707 条。要让 `bun run knip` 重新成为有意义的门，需要单独一轮配置工作（各 workspace 的 entry point、忽略 `refs/` 等），属独立工作项。

### 代价：`~backend` 会静默烂掉，且没有护栏

保留 `~backend/*` 意味着 `ui/` 仍编译后端源码，但**没有任何自动机制会在后端重构打断它时报警**——它不在根 tsconfig 里，不进任何测试档位。脱钩当天实测发现它已经断了三处，全都无人知晓：

- **telemetry / foundation 拆包**：`~backend/lib/request-telemetry` 与一批 `~/lib/…` 别名全部 TS2307，`typecheck:ui` 早已红。
- **`DecodeToolInputConfig.all` 被删**（commit `c9a22b9b`，理由写的是「default-off, no live consumer」）：真正且唯一的消费者就是 Vue 详情页的 tool_use 显示解码。删除时 ui 侧类型错 + vitest 红，但没人看见。这是「无消费者」类绝对断言必须跨全部树核实的又一个实例（→ `verifying-authoritative-claims`）。
- **`@types/node` 版本**：`ui/` 独立安装会把 vite/vitest 的可选 peer 解析到 26.x，其 Buffer 类型让后端源码编不过。故 `ui/package.json` 把 `@types/node` 钉死在后端同款 `24.6.2`——保留 `~backend` 就必须共用后端的类型环境，这个 pin 是代价的落点。

三处均已修复，`build:ui` / `typecheck:ui` / `test:ui`（248 bun + 78 vitest）当前三绿。**但这只是一次性的**：以后动后端、想确认没打断 Vue 前端，只能显式跑 `bun run typecheck:ui` + `bun run test:ui`。真正终结这笔账的是走完 §1–§3 把 `ui/` 删掉，而不是给它加护栏。

### 「独立」到什么程度（实测边界，非推断）

脱钩当天在**仓库外**（`/tmp` 的 detached worktree，无任何 root `node_modules`，故 node 解析无法向上借到主树）实测过三条脚本，结论不对称：

| 脚本 | 仓库外裸跑 | 原因 |
|---|---|---|
| `bun run build` | ✅ 通过 | vite 只需 `ui/` 自有依赖；`~backend` 那几个模块是纯的，且类型导入被擦除 |
| `bun run test` | ✅ 通过（248 bun + 78 vitest） | 同上 |
| `bun run typecheck` | ❌ 一片 TS2307 | `~backend/*` 把后端源码拖进类型图，而后端自己的依赖（`consola`/`fetch-event-stream`/`jsonrepair`/`@datadog/sketches-js`/`@anthropic-ai/sdk`…）装在**仓库根** |

即：**`ui/` 独立的是「前端依赖图」，不是「类型环境」**。只要 `~backend/*` 还在，typecheck 就必须在仓库内、且根已 `bun install` 过才能跑。这不是缺陷而是那条耦合的定义，写在这里是为了别把「ui 已独立」误读成「把 ui 目录拷出去就能用」。

这次实测还捞到一个静态扫描漏掉的洞：`ui/src/utils/block-diff.ts` 用了 `diff` 包，但 `ui/package.json` 从来没声明过它——workspace hoist 一直在替它兜底，脱钩后裸跑立刻 `Rollup failed to resolve import "diff"`。已补 `diff` + `@types/diff` + `@types/bun`。**教训**：判断「一个子项目要哪些依赖」不能靠 grep import 语句（多行 import、模板语法都会骗过正则），只有仓库外裸装裸跑才是 oracle。


## 1. 逐页退役状态

Vue `ui/` 剩余页面 → ui-v4 对应面 → 状态。**「parity 未审」= 只做了存在性映射，退役前必须先做深度对比审计**（见 §2 方法论），别凭「看起来有对应页」就删。

| Vue 页面（`ui/src/pages/vuetify/`） | 路由 | ui-v4 对应 | 状态 | 门控 / 备注 |
|---|---|---|---|---|
| VModelsPage + `components/models/` | ~~`/models`~~ | `ModelsPage`（`/models`） | ✅ **已退役**（2026-07-10） | 见 §4。深度 parity 审计 + 补齐 8 项缺口 + Raw JSON 双视图后退役 |
| VDashboardPage | `/dashboard` | `OverviewPage`（`/overview`） | ⬜ **parity 未审** | 退役前对比：运维看板的每块 stat/图表/遥测维度 ui-v4 是否覆盖。**注意共享件** `useModelTelemetry`（§3） |
| VActivityPage（请求列表） | `/activity` | `RequestsListPage`（`/requests`） | ⬜ **parity 未审** | 对比：列/筛选/分页/实时 WS/preview 快筛。ui-v4 有 `useRequestFilters` + filter chips |
| VDetailPage（请求详情） | `/activity/:id` | `RequestDetailPage`（`/requests/:id`） | ⬜ **parity 未审** | 对比：请求/响应分段渲染、SSE events、attempts timeline、diff、raw JSON（ui-v4 raw JSON 已双视图）、j/k/Esc 导航 |
| VConfigPage | `/config` | `ConfigPage`（`/config`） | ⬜ **parity 未审** | 二者都是 config 编辑器。对比：校验、错误提示、保存回写、字段覆盖 |
| VSearchPage | `/search` | **无对应** | 🚫 **门控：ui-v4 缺此功能** | ui-v4 **没有**内容寻址 5 源全文搜索页（只有 Requests 的轻量 filter chips，非 `/history/api/search` + `/search/contains` 的 5 facet 搜索）。**必须先在 ui-v4 建出对应，才能退役 Vue `/search`** |

ui-v4 独有、Vue 无对应的页（不涉及退役）：`/sessions`·`/sessions/:id`（SessionsPage）、`/learned`（LearnedPage，反应式学习记录生命周期）、`/tools/json`（JsonToolsPage）。

## 2. 退役方法论（可复用三步）

每退役一个 Vue 页面，走与 models 相同的流水线：

1. **深度 parity 审计**（先做，别跳）：派 subagent 逐特性对比 Vue 页 vs ui-v4 对应面，明确裁判轴 = **面向用户的功能完备度 + 信息覆盖**（不是代码风格/ROI）。产出：等价项 / ui-v4 已超越项 / **ui-v4 缺失或退化项**（每条带 Vue `file:line` 证据）。models 的范例见对话 + spec 附录 A。
2. **补齐缺口**（若审计发现 ui-v4 有回退）：写 parity spec（`docs/spec/<date>-ui-v4-<page>-parity.md`，含验收 oracle 附录）→ subagent-driven 执行补齐 → 直到 ui-v4 达到并超越 Vue。models 走了这步（补 8 项 + Raw JSON 双视图）。
3. **退役 Vue 页**（parity 确认后）：按 §3 检查清单删除，隔离 worktree + 独立分支，subagent 审查删除完整性，合回 master。

**门控页（如 `/search`）**：ui-v4 根本没有对应功能时，退役第 3 步被第 2 步阻塞——须先在 ui-v4 **建出**该页（新特性开发，非补缺口），才能退役 Vue 版。

## 3. 退役检查清单（删一个 Vue 页时逐项核对）

以 models 退役（commits `3fc6b78c`）为范本：

- [ ] **删页面 + 组件**：`pages/vuetify/V<Page>.vue` + 该页专属 `components/<page>/`。
- [ ] **删专属 composable / util / 类型**：先 grep 确认**只被该页引用**（`grep -rl <name> ui/src | grep -v <page>`）——被其它页共享的**绝不删**（见 §3 共享件教训）。
- [ ] **删该页测试**：`ui/tests/*<page>*` + `ui/vitest/*<page>*`。**注意文件名不含页名但引用该页组件的测试**（models 踩坑：`detail-primitives.test.ts` / `unmatched-telemetry-section.test.ts` / `navbar-config.test.ts` / `router.test.ts` 都引用了模型件却不含 "model" 名）——用 `grep -rn '<deleted-component>' ui/tests ui/vitest` 兜底。
- [ ] **删接线**：`ui/src/router.ts` 的路由 + `/v/<page>` 遗留重定向；`ui/src/components/layout/NavBar.vue` 的 nav 链接；对应更新 `navbar-config.test.ts`（nav labels 断言）+ `router.test.ts`（重定向断言）。
- [ ] **dangling-ref 全清**：`grep -rniE '<Page>|components/<page>/|use<Page>...' ui/src ui/tests ui/vitest` 必须空。
- [ ] **孤儿扫描**：删页后，原本**只被该页用**的通用组件/util 会成孤儿（models 踩出 `JsonViewerSurface.vue`——通用 JSON 组件、只被模型页用）。孤儿**保守保留 + 记 `docs/todo/deferred-backlog.md`**（no-destructive「绝不以无消费者为名擅自删」），或经用户确认后删（删时连带清 eslint 揪出的 unused imports）。
- [ ] **`components.d.ts` 自动重生**：`ui/types/components.d.ts` 是 gitignore 生成物，`build:ui` 会重生、无需手改/提交。
- [ ] **验证三绿**：`bun run build:ui`（vite，删除结构正确性的真门禁）+ `bun run typecheck:ui`（vue-tsc）+ `bun run test:ui`（bun + vitest）。
- [ ] **doc-sync**：更新 [ui/CLAUDE.md](../ui/CLAUDE.md) 路由表 + VueUse 小节（删该页的 composable 提及）；更新本文档 §1 状态。

### 共享件教训（退役 models 实测）

删页时**必须先验证依赖方向**，被非本页共享的件绝不连带删：
- `ui/src/composables/useModelTelemetry.ts` — 虽名带 "model"，却被 `useOperationalStats.ts` + `VDashboardPage.vue`（Dashboard）共享 → **保留**。**当 Dashboard 退役时，此件才随之可删**（届时先复核无其它消费者）。
- `ui/src/components/ui/JsonViewerSurface.vue` — 通用 JSON 查看组件，但实测只被模型页用 → models 退役后成孤儿，经用户确认已删（commit `ee838f63`）。

## 4. 已完成退役日志

- **models（2026-07-10）**：删整个 `/models` 特性（VModelsPage + 16 组件 + 4 composable + 2 util + 13 测试 + router/nav 接线）。保留共享 `useModelTelemetry`。ui-v4 `ModelsPage` 经 parity 审计 + 补 8 项缺口（endpoint 筛选/billing 滑块/错误态/thinking 单元格/active-filter 计数/空态引导/vendor chip/头部计数，spec [models-list-parity](spec/2026-07-08-ui-v4-models-list-parity.md)）+ Raw JSON 双视图（spec [raw-json-dual-view](spec/2026-07-08-ui-v4-raw-json-dual-view.md)）后达到并超越 Vue。commits：`3fc6b78c`（退役）+ `ee838f63`/`62d14d7d`（孤儿清理）。同时移除两个前端的 **CSV 导出**功能（用户决策，commit `1e0fdc13`）。

## 5. 附带：并发会话预存问题（非退役引入）

- ui-v4 侧 history/requests 测试 fixture 有 `EntrySummary.responsePreviewText` 类型漂移（另一会话给类型加了必填字段但没更新部分 fixture），`typecheck:ui-v4` 因此红。**非本退役工作引入**，属 `response_preview_text` 特性会话的收尾债。Vue 侧同类漂移已在 models 退役时顺手修（commit `7654a223`）。退役后续页时若再遇，同样修 fixture（`responsePreviewText: ""` 镜像 `previewText: ""`）。
