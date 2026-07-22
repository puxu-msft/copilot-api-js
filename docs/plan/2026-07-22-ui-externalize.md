# Plan: UI 完全移出主服务器（主包零 UI、运维自理托管）

> 状态：**已实施完成**（2026-07-22，`.worktrees/ui-externalize` 分支 `feat/ui-externalize`，base master `ac2c5c68`，待合并）。全部「实现顺序」1-5 阶段 + 「审查补充」清单已落地，见下方「实施记录」。
>
> 原状态：设计定稿待用户签核 + 对抗审查（已通过，见文末「用户已签核」）。

## 实施记录（2026-07-22）

- **阶段 1-2（拆主服务器接线 + history 根重定向）**：`caacda6a`（删 `routes/ui/route.ts` + `history/assets.ts` + 拆 `routes/index.ts`/`server.ts`/`start.ts` 的 UI 接线）、`b6b1981e`（history 根重定向改兜底）。
- **阶段 3（package.json）**：`d7ce0f91`（build/files/test/typecheck 脚本 + `@playwright/test` 迁至 `ui/`）。
- **阶段 4（测试）**：`78ce5653`（删两 UI 测试文件、`test-app.ts`/`unknown-endpoint-server`/`openapi-spec` 适配）、`97492a63` + `796bcd78`（`tests/e2e-ui/` → `ui/tests/e2e/` 迁移 + 补齐重命名的 delete 侧）、`f91080db`（`api-endpoints.pw.ts` 转 `tests/infra/api-endpoints-smoke.http.test.ts`，随附 lint 修复合入 `796bcd78`）。
- **阶段 5（文档同步）**：`b9576eaf`（README/API.md/DESIGN.md/coding-conventions.md/spec/vue-ui-retirement.md/proxy-api-reference skill/ui 与 ui-v4 文档）。
- **验收**：`bun run typecheck`（根 + `ui/tests/e2e/tsconfig.json`）绿；`bunx eslint` 逐改动文件绿；`bun run knip` 无新增 unused（src/ 零新增，ui/ 的 knip 计数变化系 `@playwright/test` 依赖检测面扩大导致的既有测试文件噪声，非本次引入的死代码）；`bun run test:backend` 6141 测试仅 5 个既有基线失败（store-performance ×2、store.it ×2、resetters-complete ×1——后者是本次执行中新发现的既有基线漂移，非计划文档原估的 4 个，已实测对照 master `ac2c5c68` 确认为该分支引入前已存在）；`git grep` oracle 归零。
- **偏离计划之处**：`test:acceptance`/`test:all` 的 ui-v4 聚合门「顺手补」项——实测已在此前提交中补齐，无需改动（非偏离，是发现既有状态与计划描述不一致）。

## 原始计划（下方保留供参考）

## Context（为什么做）

用户决定：主服务器（Hono app）**完全不服务、不代理、不构建 UI**——`ui/`（旧 Vue）与 `ui-v4/`（活的 React History UI）都从主包移出、都由运维**单独启动**（自建静态服务器 + 反代 `/api`·`/history/api`·`/ws`·`/models` 到后端 4141）。两个 UI workspace 都**保留、都不退役**；`~backend/*` 类型 re-export（dev-time monorepo 机制）**不动**。

**与并发工程的关系（已核实、正交不冲突）**：仓库有活跃的 `feat/monorepo-split`（后端拆 `foundation/core/server/cli` 包，spec 过两轮审 + Phase 0 plan）。它**明确保留 ui/ui-v4 作 workspace 成员**（§3.1）、明确「UI build 已独立正交、不受拆分影响」（§8.3），**不涉及主服务器服务/构建 UI**。故本任务与之正交。协调点仅 `package.json` 行级重叠（split 改 workspaces/build、本任务改 build:ui/files/test:ui\*）——用隔离 worktree + 显式 pathspec 行级共存。`feat/ui-v4-shadcn-redesign` 在改 ui-v4 内部，本任务不碰 ui-v4 内部。

## 移除面（Explore 实测穷尽，file:line 为准）

### 删文件（整体纯 UI 服务、无其它消费者）
- `src/routes/ui/route.ts`（247 行，全是静态服务 + vite-proxy）
- `src/routes/history/assets.ts`（`getMimeType`；**全仓唯一消费者是 ui/route.ts:17**，删 route 后成孤儿，knip 会报——一并删）
- `tests/history/history-ui-route.unit.test.ts`（151 行全 UI 路由/代理测试）
- `tests/infra/ui-v4-route.http.test.ts`（17 行，仅测 `createUiRoutes`）
- `tests/e2e-ui/`（整目录，8 个 `.pw.ts` + helpers）+ `playwright.config.ts`（见「测试」节裁断）

### 改代码
- **[src/routes/index.ts](src/routes/index.ts)**（`:35-39` import `createUiRoutes`/`UiRoutesOptions`、`:45-48` `RegisterHttpRoutesOptions extends UiRoutesOptions` + `externalUiV4Url` 字段、`:101` `/ui` mount、`:102` `/ui-v4` mount）：删两 mount + import + interface 字段。**保留 `:100` `/history` mount**（后端 API，非 UI）。
- **[src/server.ts](src/server.ts)**（`:25-28` ServerOptions 的 `externalUiUrl`/`externalUiV4Url`、`:156` `registerHttpRoutes(server, {...})`）：删两字段、`registerHttpRoutes(server)` 无 options。**保留 `:143` `cors()`**（非 UI 专属、有测试依赖）、`:146` `server.get("/")` → `/openapi.json`（已与 UI 无关，不改）。
- **[src/start.ts](src/start.ts)**（`--external-ui-url` 全链：`:106` import `normalizeExternalUiUrl`、`:185` `RunServerOptions.externalUiUrl`、`:215-223` 验证块、`:531` `createServer({externalUiUrl})`、`:540-544` `consola.info("Web UI:...")`、`:723-726` flag 定义、`:775-777` knownArgs、`:802` arg 读取）：整链删；`createServer()` 无 UI options。
- **[src/routes/history/route.ts:26](src/routes/history/route.ts)**：`historyRoutes.get("/", c=>c.redirect("/ui#/v/activity",302))` **指向已无人服务的旧 UI** → **删这行**（用户决定），让 `:27` `historyRoutes.all("/", 404)` 兜底（与其它未知路径一致）。其单测在 `tests/history/history-ui-route.unit.test.ts:32-37`（该文件整删）。
- **[tests/helpers/test-app.ts](tests/helpers/test-app.ts)**（`:5,15,48` `UiRoutesOptions` import + `createFullTestApp(options=...)` + `registerHttpRoutes(app,options)`）：去 UI options、形参改无参。**先 grep `createFullTestApp(` 全调用点确认无人传 UI options**。
- **[tests/observability/unknown-endpoint-server.it.test.ts](tests/observability/unknown-endpoint-server.it.test.ts)**：`:99-105` "route-owned c.notFound (missing UI asset)" 用 `/ui/assets/...` 断言不记日志——**UI 删后 `/ui/assets/*` 变真 unknown-404（会记日志）语义反转**，须删该用例或换一个仍存在的 route-owned 404 路径（如 `/history/api/...` 下的已知 404）；`:145-149` `createServer({externalUiUrl:...})` → `createServer()`。
- **[tests/infra/openapi-spec.http.test.ts:46-48](tests/infra/openapi-spec.http.test.ts)**：`canonicalSpecPath` 里 `if(p==="/ui")return null`/`if(p==="/ui-v4")return null` 变死码 → 删。

### package.json
- `files`（`:26-32`）：删 `"ui/dist"`、`"ui-v4/dist"`（主包零 UI 产物）。保留 `dist`/config。
- `workspaces`（`["ui","ui-v4"]`）：**保留**。
- `build`（`:38`）：`build:ui && build:ui-v4 && build:backend && build:history-search` → **去掉 build:ui、build:ui-v4**。
- **保留的 delegator 脚本**（运维单独构建/开发/测试用）：`build:ui`/`build:ui-v4`/`dev:ui`/`dev:ui-v4`/`preview:ui`/`test:ui*`/`test:ui-v4`/`typecheck:ui`/`typecheck:ui-v4`——都是 `--filter` 委派、留着。
- `test:acceptance`（`:58`）/`test:all`（`:59`）：拆解去掉 `test:e2e-ui`（见下）；`test:ui`/`test:ui-v4` 是否仍聚合由「测试」节定。
- `typecheck`（`:77` `tsc && tsc -p tests/e2e-ui/tsconfig.json`）：删第二段（e2e-ui 移除）。
- devDep `@playwright/test`（`:114`）：仅服务 e2e-ui + playwright.config → 删。**保留** `@vue/eslint-config-typescript`/`eslint-plugin-vue`/`vue-eslint-parser`（服务 ui/ Vue lint，ui workspace 保留）。

### 测试裁断：`tests/e2e-ui/`（浏览器 e2e）—— **用户决定：迁入 `ui/` workspace 自跑**
- 现状：`helpers.ts` 只 `fetch(BASE_URL/health)` 检查**已在跑**的主服务器、`uiUrl()=BASE_URL/ui#...`、`playwright.config.ts baseURL=localhost:4141`；所有 `.pw.ts` `page.goto('/ui#/v/...')` 打**旧 Vue UI**（经主服务器 `/ui` 服务）；有 `history-mocks.ts`（API mock）。
- UI 外置后主服务器不在 `/ui` 服务 UI → 这些浏览器 e2e **在主包语境下全部失效**；且它们只测旧 Vue `ui/`。
- **裁断（用户决定：迁入 `ui/` workspace）**：把 `tests/e2e-ui/` + `playwright.config.ts` **迁进 `ui/` workspace**（如 `ui/tests/e2e/` + `ui/playwright.config.ts`），让它自起 **vite preview**（serve `ui/dist` 或 dev）跑 e2e。`@playwright/test` 从根 devDep 迁到 `ui/` 的 devDep；`test:e2e-ui` 改为委派 `bun run --filter copilot-api-ui test:e2e`（或从根移除、由 ui workspace 自有）。**API 依赖处理**：e2e 现用 `history-mocks.ts` mock API + 打 `/api/*`——迁移后 vite preview 无后端，须 ① 保留/扩展 mock 覆盖所测 API，或 ② preview.proxy 反代到一个运行的后端。优先沿用现有 mock 路径（`history-mocks.ts` 已存在），最小化对真后端的依赖。`helpers.ts` 的 `BASE_URL`/`uiUrl` 改指 ui workspace 自己的 preview server。
- **主包侧移除**：根 `package.json` 的 `test:e2e-ui`/`test:e2e-ui:local`（`:71-72`，改为委派或删）、`typecheck` 第二段（`:77` `tsc -p tests/e2e-ui/tsconfig.json` → 删，tsconfig 随目录迁走）、`@playwright/test`（`:114` 从根 devDep 移到 ui workspace）、`playwright.config.ts`（迁走）。
- **注**：此迁移是本任务里相对独立的一块，可作为最后一个 commit 或拆成 follow-up；但用户已决定保留 e2e 覆盖、归 ui workspace，不整删。

### 文档
- **README.md**：`:33`（`--external-ui-url` proxying 示例）、`:34`（`dev:ui`）、`:82`（flag 表格行）、`:209`（"Web UIs `/ui/*` `/ui-v4/*` documented in API.md"）→ 全改为「UI 外置、运维自建静态服务器 + 反代 `/api`·`/history/api`·`/ws`·`/models` 到 4141」+ 指向运维说明。
- **docs/API.md**：`:103` `/ui/*` 行、`:104` `/ui-v4/*` 行 **删**；`:101` `/docs` 措辞、`:102` `/` 行保留。
- **docs/DESIGN.md**：`:122` `~backend` 纯度校验段说明 `build:ui-v4` 现由 workspace/运维跑（非根 build 链）；`:124/:126` `~backend` re-export 段保留；`:207` ui workspace 脚本委派段同步「根 build 不再链 build:ui/build:ui-v4」；`:407` "History Web UI" 节按需更新语境。
- **新增运维说明**：README 或 `docs/` 加一节「自托管 UI」——运维 `bun run --filter copilot-api-ui-v4 build` 后用任意静态服务器托管 `ui-v4/dist`，配反代把 `/api`·`/history/api`·`/ws`（websocket）·`/models` 转到后端 4141；注意 ui-v4 vite `base` 写死 `/ui-v4/`（`ui-v4/vite.config.ts:24`）、旧 ui `/ui/`，运维在别的前缀/根托管需调 workspace 的 `base` 或反代前缀。

### 零改动确认（Explore 实测）
- config schema/yaml：无 Web UI 键（`tui.enabled` 是终端 TUI、不动）。
- CSP：不存在。
- OpenAPI 注册层：不含 `/ui`。
- CORS：`cors()` 全局默认已放行跨源、非 UI 专属 → 不删（运维反代同源或跨源都工作）。
- root `/` → `/openapi.json`（已与 UI 无关）。

## 实现顺序（单 worktree、细粒度提交）
1. 删两 UI 服务文件 + assets.ts 孤儿 + 拆 routes/index.ts + server.ts + start.ts 的 UI 接线（一个语义单元）→ typecheck 绿。
2. history/route.ts 根重定向改兜底。
3. package.json：build/files/test 脚本 + 去 @playwright/test。
4. 删/改测试（test-app.ts 签名、unknown-endpoint 用例、openapi-spec canonical、删两 UI 测试文件、删 tests/e2e-ui/+playwright.config）。
5. 文档同步 + 新增自托管 UI 运维说明。

## 验收 / 验证
- `bun run typecheck` 绿；`bunx eslint <改动文件>`（无 cache）绿；`knip` 无新增 unused（确认 assets.ts 删干净）。
- `bun run test:backend` 全绿（除既有 4 基线失败）；确认无 UI-route 测试残留引用 `createUiRoutes`。
- **真实例冒烟**（非 4141）：起主服务器 → `GET /ui` 与 `/ui-v4` 返 **404**（不再服务 UI）、`GET /openapi.json` 正常、`GET /health` 正常、`/history/api/*` 正常 → 证明主服务器 API-only、UI 已移出。
- `git grep -n 'createUiRoutes\|externalUiUrl\|externalUiV4Url\|/ui-v4\|routes/ui\|e2e-ui'` 在 src/ 归零（残留引用 oracle）。
- **绝不 kill 4141 主服务器**、绝不碰主 worktree 与 `feat/monorepo-split`/`feat/ui-v4-shadcn-redesign` worktree。

## 审查补充：plan 漏掉的引用（对抗审查揪出，全部并入移除面，无 blocker）

### major（漏掉的跨会话/单一事实源引用）
- **`.claude/skills/proxy-api-reference/SKILL.md:47`**：端点表硬编码 `/ui/*`、`/ui-v4/*` → 删这两 token，行尾描述去「/前端」。这是被 `Skill` 工具索引、跨会话复用的项目 skill，不改会误导后续会话。
- **`docs/vue-ui-retirement.md`（全文 59 行）**：整篇以「主服务器 `/ui`+`/ui-v4` 双 mount」为前提的 Vue 逐页退役 SSOT。UI 外置后前提失真（"退役"从"删主服务器路由"变成"运维决定托管哪个静态产物")。头部加时效警告/删除线（`archive-outdated-docs`）说明前提已变。

### minor（代码行引用失效 / 死配置 / 文档目录树）
- **`tests/observability/unknown-endpoint-server.it.test.ts:99-105`**：实测全仓**仅** `routes/ui/route.ts` 用 `c.notFound()`（history handler 的 404 都是 `c.json(...,404)`、不经 `c.notFound` 分发、不被判 route-owned）。删 UI 后 `route-owned-not-found` 分类**失去唯一活样本**。**修法**：不简单删——改用临时 `app.get("/__test_route_owned__", c=>c.notFound())` 保留三态分类器 route-owned 分支回归覆盖，同步更新 spec/API.md 举例路径。
- **`docs/spec/2026-07-14-unknown-endpoint-logging.md:97,102,175`**：把 `routes/ui/route.ts:160/166/170/182/238-239` 当分类设计的代码行证据引用 → 补「原始证据文件随 UI 外置移除，见 git 历史」说明，或换成上面新样本。
- **`tsconfig.json:30-31`** 根 `exclude: ["tests/e2e-ui/**/*"]`：e2e-ui 迁走后变死配置 → 同 commit 删。
- **`docs/DESIGN.md:220`** 测试目录树 `├── e2e-ui/`：迁走后改指 `ui/tests/` 或删行。
- **`docs/coding-conventions.md:22`**：`e2e-ui/（Playwright）单列` 表述 → 同步（e2e-ui 不再算后端测试）。
- **`ui/CLAUDE.md:7`**：「后端 `src/routes/ui/route.ts` 默认在 `/ui` 提供…`--external-ui-url`」过时 → 改「运维独立托管 + 反代」。
- **`ui-v4/README.md:3,25`、`ui-v4/docs/{ARCHITECTURE.md,DESIGN.md}`** 多处「后端 `/ui-v4` 静态路由」「与旧 Vue `/ui` 并行」表述过时：本次改动是直接原因 → 同步改（ui-v4 内部文档，本 commit 序列一并更新，别 silently 遗漏）。
- **README.md:33** `--external-ui-url` 示例整行 → 换成「运维起 ui-v4 + 反代」示例命令（非仅改注释）。
- **`docs/API.md:101`** 「与 Vue 前端 `/ui` 分离」→ 「与前端 UI（运维独立托管）分离」。

### 确认无需改动（审查实测）
- 根 tsconfig 无 `references`/`composite`、`include` 不含 ui/；`eslint.config.js` 只有 `ignores` 里 playwright.config 文件级忽略、无 e2e-ui override；无 knip 配置文件（走默认全仓扫、删文件后 unused 自然清零）；bunfig.toml 无 e2e 设置；**全仓无 CI 配置**。

### e2e-ui 迁入 ui/ 的 3 个连带项（实现必做，漏则迁移后跑不起来）
1. `tests/e2e-ui/tsconfig.json` 的 `extends:"../../tsconfig.json"` → 改指 `ui/tsconfig.json`（接入 ui workspace 的 `~backend/*`/`~/*`→`../src/*` alias，别继承根后端 `~/*`→`src/*`）。
2. 根 `tsconfig.json` `exclude` 删 + 根 `package.json:77` typecheck 第二段 `tsc -p tests/e2e-ui/tsconfig.json` → 委派 `ui` 自己的 typecheck。
3. `playwright.config.ts` `testDir` 改 + `@playwright/test` **从根 devDep 移到 `ui/package.json`**（不两处声明）；根 `test:e2e-ui*` 改委派 `bun run --filter copilot-api-ui test:e2e`。
- **`api-endpoints.pw.ts` 归属修正（我裁定，代码性质钉死）**：它测的是纯后端 API（`/api/status`·`/config`·`/tokens`·`/logs`·`/models`·`/health`·`/history/api/stats`），fetch-only、不需浏览器、与 UI 无关——**不迁 ui/**，转成后端 `.http.test.ts` 留主包（或 `tests/e2e-client/`）。只迁 7 个测 UI 页面的 `.pw.ts` + helpers + history-mocks 到 ui/。
- 顺手（无取舍）：`test:acceptance`/`test:all` 补上遗漏的 ui-v4 聚合门（`spec 2026-07-14-test-tiering:74` 记「现状漏 ui-v4」）——既然动这两行，顺带补。

## 用户已签核
1. `tests/e2e-ui/` 处置：**迁入 `ui/` workspace 自跑**（自起 vite preview + 自带 playwright + 沿用 history-mocks），保留浏览器 e2e 覆盖、归 UI workspace；主包侧移除 `@playwright/test`/`test:e2e-ui`/typecheck e2e 段/playwright.config。
2. `/history` 根重定向（原 `/ui#/v/activity`）：**删除该行**，由 `all("/",404)` 兜底。
