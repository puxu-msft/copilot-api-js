# ADR: 依赖选型 bun-first

- **状态**：Accepted
- **日期**：2026-07-05
- **相关**：[DESIGN.md「运行时兼容（Bun-first / Node-compatible）」](../DESIGN.md)、[coding-conventions.md「依赖选型 bun-first」](../coding-conventions.md)、skill `debugging-ghc-api-upstream-transport`、[spec/upstream-http2-transport.md](../spec/upstream-http2-transport.md)

## 背景

项目同时支持 Bun 与 Node 两个运行时，但两者优先级**不对称**：Bun 是默认/推荐运行时，所有开发与运行命令（`dev` / `start` / `test:*`）都走 `bun`，`bun test` 是唯一被 CI 实测的后端套件；Node 只是有意维护的兼容目标，实测覆盖弱于 Bun（Node 专属分支在 `bun test` 下走不到）。

在这种不对称下，「引入某个外部依赖是否可接受」需要一条明确、可执行的裁判准则，否则容易出现两类失败：其一，引入 node-gyp 原生绑定的库（如 `better-sqlite3`），Bun 加载时直接拒绝，逼迫用户在安装时二选一；其二，引入在 Bun 下行为异常但看似可用的库（如裸 `undici` 被 Bun 内建 shim 静默替换、丢弃 dispatcher），埋下难查的运行时缺陷。

## 定夺

**外部依赖的裁判准则是「Bun 热路径上的库 Bun 原生可跑」，而非「禁止任何 node-only 依赖」。** 具体分三条：

1. **拒绝 node-gyp 原生绑定（`binding.gyp`）。** 这是 Bun 兼容性最大的雷区。标杆实例：SQLite 层刻意不用 `better-sqlite3`（Bun 1.3 加载即拒绝 “not yet supported in Bun”），改用两端各自的内建 SQLite（`bun:sqlite` / `node:sqlite`），使用户安装时不被迫二选一。

2. **node-only 库可作兼容路径，但不得进 Bun 热路径。** `@hono/node-server`、`@hono/node-ws` 只在 Node 分支被动态 `import()`；上游 https 热路径改走内建 `node:http2` 而非 undici（undici-on-Bun 对 h2 chunked 响应永久挂，是解析层 bug）；`undici` 经 `undici/index.js` 子路径仅留给明文 `http://`（本地 SearXNG），且 pin undici 7（undici 8 的 `index.js` 在 Bun 加载即崩）。

3. **命令走 `bun run`，不用 `npm run`**（本机 Volta 无默认 Node，`npm run` 会失败）。

**引入新依赖前的实测审计**（判据是实测而非推断）：`find node_modules -name binding.gyp` 应为空（零 node-gyp 依赖）；`find node_modules -name "*.node"` 命中的 `@rollup` / `@rolldown` / `@oxc-*` 都是**构建工具**的预编译产物，只在构建期用、不进运行时 dist，不算违反。

## 备选方案（未采纳）

- **纯 Node、放弃 Bun**：牺牲 Bun 作为一等公民带来的启动/测试速度与开发体验，与项目既定方向相反。
- **禁止一切 node-only 依赖**：过度收窄，会砍掉 `@hono/node-*` 这类只在 Node 分支动态加载、根本不进 Bun 热路径的合法兼容依赖，得不偿失。
- **不设准则、逐库临时决策**：无法防住上述两类失败（node-gyp 硬拒载、Bun shim 静默丢 dispatcher），且缺少可复核的审计手段。

## 后果

- **正向**：用户无论用 Bun 还是 Node 安装都不被 node-gyp 绑定卡住；运行时差异收敛到单一判别点 `typeof globalThis.Bun !== "undefined"` 分流的少数子系统（HTTP server / WebSocket / SQLite / 上游 fetch / 代理），其余代码运行时无关；依赖合规可用一条 `find` 命令机械审计。
- **代价**：Node 专属分支（如 `driver.ts` 的 `nodeFactory()`）在 `bun test` 下走不到，实测覆盖弱于 Bun，需要时靠 `bun build --target node` 打包后真 Node 跑或 e2e 兜底；上游传输为绕开 Bun 的 undici/h2 缺陷而手工分流 `node:http2` + undici 子路径，带来额外复杂度（详见 skill `debugging-ghc-api-upstream-transport`）。
