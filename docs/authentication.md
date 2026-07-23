# 认证与 Token 管理

Copilot 上游需要两层 token：GitHub OAuth token（长期）换取 Copilot token（短期、自动刷新）。本域已抽为独立包 `@hsupu/ghc-proxy-token`（`packages/token/src/`），对 core 零依赖——fetch / token 文件路径 / runtime-config 经注入（`dependencies.ts` 的 `TokenFetch` / `TokenPersistencePaths` / `TokenRuntimeConfigView` 端口），凭据自持（见「凭据存储」）。core / CLI 经 `~/lib/token` 过渡别名消费。

## 多源 Token Provider

GitHub token 按优先级从多源获取（`packages/token/src/providers/`）：`cli`（GitHub CLI）、`device-auth`（设备码登录）、`env`（环境变量）、`file`（持久化文件）。各 provider 声明优先级与可刷新性，`github-token-manager.ts` 按序取首个可用源并校验；`file` provider 的 token 文件路径来自注入的 `TokenPersistencePaths`。

## 生命周期与 composition root

`runtime.ts` 定义 `TokenRuntime`——进程级单一 owner，拥有 `GitHubTokenManager` + `CopilotTokenManager` 实例对，暴露窄操作面（initialize / acquire\* / getCopilotUsage / getGitHubUser / ensureValidCopilotToken / refreshCopilotToken / dispose）。装配点在 core 侧 `src/lib/token-runtime.ts`：把 core 原语（`upstreamFetch` / `PATHS` / live state 视图）适配成注入端口，`createTokenRuntime(deps)` 构造并 `installTokenRuntime` 为进程单例；请求 / 关停 / 重试腿都读同一实例（`getTokenRuntime` fail-fast / `peekTokenRuntime` 容忍）。

`copilot-token-manager.ts` 负责 Copilot token 的刷新（min interval / max retries + 在飞去重）；`dispose()` 停计时器并 drain 在飞刷新，`disposed` 守卫确保刷新 `.then` 的无条件重排不会在关停后遗留计时器。刷新失败由 `src/lib/request/strategies/token-refresh.ts` 反应式重试捕获（经 `peekTokenRuntime().refreshCopilotToken()`）。

## 凭据存储（单一 SoT）

`githubToken` / `copilotToken` / `tokenInfo` / `copilotTokenInfo` 由 token 包的 `store.ts` 独占（不再在 core `state` 里）。写只经 `credentials.ts` 单缝（含 `withGitHubTokenForValidation` 原子串行临时 swap）；core 消费者经 `getTokenCredentials()` 只读视图读。`setStateForTests` 保留转发这 4 个键到 store 的兼容层，`snapshotStateForTests` / `restoreStateForTests` 折入 store 快照，故既有 per-test 隔离夹具自动覆盖凭据。

## 入口

CLI 子命令 `login`（别名 `auth`）/ `logout` / `debug` / `start` / `setup-*` 在 `packages/cli/src/`（`@hsupu/ghc-proxy-cli`）；每条构造链先 `installDefaultTokenRuntime()`（或 `initTokenManagers`）装配 runtime，再走操作面（`auth`→`acquireGitHubToken({forceDeviceAuth})`、`debug`→`acquire*`/`getCopilotUsage`/`getGitHubUser`、`start`/`setup-*`→`initialize`）。服务器中间件经 `peekTokenRuntime().ensureValidCopilotToken()` 逐请求校验。

详见 DESIGN.md「核心模块 · packages/token/src/」与「入口点」。
