# Plan：把 token/auth 域抽成独立包 `@hsupu/ghc-proxy-token`

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`。步骤用 `- [ ]` 跟踪。索引 [README.md](README.md)、spec [../../spec/2026-07-22-monorepo-workspace-split.md](../../spec/2026-07-22-monorepo-workspace-split.md)。这是 spec §7.2 阶段 4+「core 内部增量解环」的**首个真领域包剥离**，作为后续 domain-peel 的模板。
>
> **修订说明（2026-07-23，v2，经 GPT 对抗审 + 逐条实测证实后大改）**：v1 严重低估了 token 的所有权收敛面（把「消费者」误算成 2，实为 **8 个**直接读 token-owned state 字段的生产文件）、漏列第 7 条依赖（`utils/sleep`）、未定义 composition root / 测试隔离契约 / 生命周期 owner。评审报告见 `exp/monorepo-split/review-token-plan-gpt.md`。本 v2 补齐。
>
> **实施状态（2026-07-23）**：**全部 landed（C1–C7 + lifecycle-hardening）**，每 commit typecheck + test:backend + 精确 lint 绿。commit DAG：C1 `3acec08f` / C2 `80b3cc07` / C6 `33f5a355`（foundation 清理 + GHC auth，早做）→ C3 `61e78be4`（composition-root seam）→ C4 `28d27f5a`（注入 + runtime 单例 + 收敛全链）→ hardening `3dfb923e`（dispose 计时器泄漏守卫，C3/C4 异模型审 0-blocker 后修）→ C5 `faf2a896`（凭据所有权反转进 token store，单一 SoT）→ C7 `705f4f09`（物理抽包 `@hsupu/ghc-proxy-token` + 边界守卫 + build/bin smoke）。DAG 乱序说明见 [HANDOFF.md](HANDOFF.md)。token 包现对 core 零依赖（机器可验证边界），是后续 domain-peel（models / transport）的活模板。

**Goal:** 把 GitHub/Copilot auth 生命周期（`src/lib/token/`）从 core SCC 剥出为独立包 `@hsupu/ghc-proxy-token`，只依赖 `foundation` + **注入契约**（fetch / paths / runtime-config），**对 core 零依赖**（机器可验证边界守卫）。

**Architecture:** token 被依赖面窄但**读 token-owned 状态的生产点有 8 个**（含 anthropic/openai 四条请求认证活路径）。障碍是 token→core 的 **7 条依赖** + state 所有权反转。策略：先上提共享瘦基元到 foundation → 建 **composition root `createTokenRuntime(deps)`** 统一全部构造链 → 反转 state 所有权（单一 SoT + 隔离契约）→ 物理 `git mv`。

**Tech Stack:** Bun workspaces、tsdown、ESLint 边界守卫、`bun test`（authoritative `parallel-test`）、Phase 0 过渡别名机制。

## Global Constraints

- 包名 `@hsupu/ghc-proxy-token`；发布根包/bin 不改；`packages/token/package.json` **必须显式声明 `consola` 等外部依赖**（单 lockfile hoist 会掩盖漏报；foundation 空 deps 不是模板）。
- 每 commit：typecheck + `bun run test:backend`（0 fail）+ **精确 pathspec** `bunx eslint <path>`（**禁 `eslint --fix` 宽扫**——记忆 `tooling-eslint-fix-broad-sweeps` + `.at()` autofix 破类型；确需 fix 用精确 pathspec + 必跑 typecheck）+ 显式 pathspec commit。
- 冻结 oracle = pre-move 已通过的 test:backend；搬迁/注入不改任何测试观测行为，无需新增 golden。
- **DI 用视图/角色接口对象**（非裸字段、非位置参）：加字段时调用点零改（`TokenReadView`/`GithubHeaderIdentity` 已立范式，`54b32200`）。
- **每 commit 终态自洽绿**：跨多构造链/多消费点的原子迁移**必须在同一 commit 完成**（见「闭合 commit DAG」）；façade 仅作 commit 内短暂委托层、该 commit 后无新消费者可调用它；**绝不跨 commit 留双 SoT**。

## 通用 DomainPeel Contract（可复用模板——每个后续域 models/transport 填同一张表作 gate）

| 通用步骤 | 必填可验证产物 |
|---|---|
| **依赖盘点** | 完整 import 清单，分类 foundation-hoist / domain-owned / injected-core-capability / 不可切；grep 带正样本 |
| **公共 API** | 包 barrel + 禁 deep-import 的消费者矩阵；类型由拥有包定义、消费方 re-export |
| **角色视图** | 只读 domain-state 与 runtime-config **分离**；无裸 `State` / 位置参 |
| **composition root** | `create<Domain>Runtime(deps)`，逐条列全部 production entry + 直接构造路径，**无全局 DI escape hatch** |
| **所有权迁移** | 单一 SoT、全读写消费者矩阵、旧字段删除条件、生命周期 dispose/reload 契约 |
| **测试隔离** | snapshot/restore 或 reset 所有权、fixture 接线、RESETTERS/L1 守卫、**跨测试正向控制** |
| **物理搬迁** | `git mv`、过渡 alias、package deps 声明、边界 guard 正反控制、build/runtime smoke |

**token 特有（不入通用模板）**：GitHub device OAuth、`githubHeaders`/GHC endpoint 常量、token-file 路径、validate 临时 credential swap、refresh timer/refreshInFlight、sensitive 一次性终端输出。通用模板只要求每域声明自己的 external ports / durable+ephemeral state / dispose / 行为 oracle。

## 实测依赖清单（7 条 token→core，已逐条核实）

| # | 依赖 | 实测锚点 | 处理 |
|---|---|---|---|
| 1 | `tui/sensitive-output`（writeSensitiveOnce） | 零 import 纯叶子；消费者 4（tui 2 + token 2） | **上提 foundation**（C1） |
| 2 | `error` 纯基元 | token 3 文件 import；`http-error.ts:1` 自身 type-import `~/lib/upstream-diagnostics` | **上提 foundation + 切 http-error 自身 import edge**（C2） |
| 3 | **`utils/sleep`**（v1 漏） | `github-client.ts:16 import { sleep } from "~/lib/utils"`（93/107 调用）；无 `~/lib/utils` alias | **上提 sleep 到 foundation**（C1，随瘦基元） |
| 4 | `config/paths.PATHS.GITHUB_TOKEN_PATH` | 仅 `providers/file.ts`；但构造链 3 条（GitHubTokenManager/DeviceAuthProvider/CLI auth） | **注入 `TokenPersistencePaths` 角色对象**（C4） |
| 5 | `copilot-api` auth 符号 | 完整表：`standardHeaders`/`GITHUB_API_BASE_URL`/`GITHUB_BASE_URL`/`GITHUB_CLIENT_ID`/`COPILOT_INTERNAL_API_VERSION`/`GithubHeaderIdentity`/`githubHeaders`（token 外零消费） | **移入 token 私有 `ghc-auth-http.ts`**（C6） |
| 6 | `transport/upstream-fetch` | token 6 处调用；`UpstreamFetchInit` 含 onTrailers/onStreamClosed | **注入 `TokenFetch` 角色契约**（C4） |
| 7 | `state` token 字段（读 8 生产点 + 写 3 setter + validate swap） | 见「所有权收敛矩阵」 | **token store 单一 SoT**（C5） |

## Composition root（承重设计）

token 包唯一公开装配入口，覆盖**全部 5 条 CLI 构造链**（实测：`start`/`setup-claude-code`/`setup-codex` 用 `initTokenManagers`；**`auth` 直构造 DeviceAuth+FileProvider；`debug` 直构造 GitHubTokenManager ×3 + 直写 setGitHubToken/setCopilotToken**）：

```ts
export interface TokenPersistencePaths { readonly githubTokenPath: string }
export interface TokenRuntimeConfigView { readonly showGitHubToken: boolean; readonly vsCodeVersion?: string } // core-owned, injected live
export interface TokenCredentialsView { readonly githubToken?: string; readonly copilotToken?: string; readonly tokenInfo?: TokenInfo; readonly copilotTokenInfo?: CopilotTokenInfo } // token-owned SoT
export interface TokenFetch { (url: string, init: TokenFetchInit): Promise<Response> } // token-owned role type, assembly adapts upstreamFetch
export interface TokenRuntimeDependencies { readonly fetch: TokenFetch; readonly paths: TokenPersistencePaths; readonly runtimeConfig: TokenRuntimeConfigView }
export interface TokenRuntime {
  initialize(options?: InitTokenManagersOptions): Promise<TokenRuntimeManagers>
  acquireGitHubToken(options?: AcquireGitHubTokenOptions): Promise<TokenInfo>
  getCopilotUsage(): Promise<CopilotUsageResponse>
  getGitHubUser(): Promise<GitHubUser>
  getCredentials(): TokenCredentialsView
  ensureValidCopilotToken(): Promise<void> // request-time (server middleware)
  refreshCopilotToken(): Promise<boolean>  // retry strategy
  dispose(): Promise<void> // stop refresh timer, await/reject in-flight refresh, release store
}
export function createTokenRuntime(deps: TokenRuntimeDependencies): TokenRuntime
/** Process-singleton lifecycle: composition root INSTALLS THE runtime; request/
 *  shutdown-time consumers read this same instance (never a fresh one). */
export function installTokenRuntime(runtime: TokenRuntime): void // replace requires prior dispose; installing over a LIVE runtime throws
export function getTokenRuntime(): TokenRuntime // fail-fast throws if not installed (no silent module-global fallback)
export function resetTokenRuntimeForTests(): Promise<void> // dispose current (stop timer + drain in-flight) + clear singleton; registered in RESETTERS
```

**Singleton lifecycle 契约**（承重——防多命令启动/测试间留 disposed/错误实例）：
- `installTokenRuntime` 安装进程单例；**重复安装规则**：替换前必须先 `dispose()` 旧 runtime，安装到一个 LIVE runtime 之上 throw（防双 owner）。
- `getTokenRuntime()` 未安装即 fail-fast throw（明确错误，**无模块级 manager 静默兜底**）。
- `resetTokenRuntimeForTests()`：dispose 当前（停 timer + drain in-flight refresh）+ 清空单例；**登记 RESETTERS** + fixture afterEach 调用（纳入 §测试隔离契约）。

装配层（CLI 各命令唯一组装点）构造 runtime；`auth`→`acquireGitHubToken({forceDeviceAuth:true})`；`debug`→runtime operations，**禁回写 core state**；core/CLI 需 credential 只读 `getCredentials()` 视图，**不存镜像**。模块级 `setTokenFetch()` 仅可作过渡 shim、由 runtime 拥有含 reset，**非生产公共 API**。

**同实例生命周期操作消费者矩阵**（承重——runtime 是单一进程 owner，request/shutdown 时点必须用**同一实例**，非新建、非模块级 manager escape hatch）：

| 消费点（file:line） | 现状 | 迁为 |
|---|---|---|
| `src/server.ts:126` 中间件 `ensureValidCopilotToken()` | 模块级全局 | `getTokenRuntime().ensureValidCopilotToken()`（或装配层注入 runtime 引用） |
| `src/lib/request/strategies/token-refresh.ts:27` `getCopilotTokenManager().refresh()` | 全局 singleton 访问 | `getTokenRuntime().refreshCopilotToken()` |
| `src/lib/shutdown.ts:398` `stopTokenRefresh()`（`deps.stopTokenRefreshFn` 可注入） | 模块级 | `getTokenRuntime().dispose()`（shutdown 只调它，单 owner） |

C4 建立 composition root 时**同时**收敛这 3 个 lifecycle-op 消费者到 `getTokenRuntime()` 的窄 operation API；**禁**保留 `getCopilotTokenManager`/`ensureValidCopilotToken`/`stopTokenRefresh` 模块级导出作为绕过路径（可留为 runtime 内部委托、但公共面只剩 runtime）。

## 所有权收敛矩阵（C5 gate——8 生产读点，全部核实）

token store 是 `githubToken`/`copilotToken`/`tokenInfo`/`copilotTokenInfo` **唯一 SoT**；下列每点迁为经 token 包只读 API/视图，**删 state 字段 + setter + 镜像**：

| 读点（file:line） | 用途 |
|---|---|
| `src/lib/anthropic/client.ts:154` · `src/lib/openai/{chat-completions-client:42,embeddings:51,responses-client:57}.ts` | 请求认证活路径 |
| `src/lib/copilot-api.ts:79`（copilotHeaders/BaseUrl 的 token 读） | 上游 header builder |
| `src/server.ts:48-54` | 启动认证 |
| `src/routes/status/route.ts:108,199-201` · `src/routes/token/route.ts:55-69` | 状态/metadata |
| `src/lib/request/strategies/token-refresh.ts` · `src/routes/status`（`~/lib/token` 深 import） | 改经 token barrel、禁 deep import |

**`showGitHubToken`/`vsCodeVersion` 不入 store**（CLI/config 经 `setCliState` 拥有）→ 经 `TokenRuntimeConfigView` 注入 live 视图；热重载改这俩后须断言 token header + sensitive 决策读新值。

## 测试隔离契约（C5 gate——单进程全套件基础）

实测 `cloneState` 特殊克隆 `tokenInfo`/`copilotTokenInfo`（`state.ts:1186,1219`），token store 迁走后 `restoreStateForTests` 不恢复它 → 跨测试泄漏/双 SoT 漂移。**必须**：
- token 包 `snapshotTokenStoreForTests()`/`restoreTokenStoreForTests()`（深拷贝）**或** core 单一 `snapshotRuntimeStateForTests()` 原子组合 state+store；`tests/helpers/isolated-fixture.ts` 同一 beforeEach/afterEach capture+restore。
- 新 module-global store 提供 `resetTokenStoreForTests()` 登记 RESETTERS **或**明确纳入快照 + L1 `EXEMPT`（二选一不可漏）。**并且** `resetTokenRuntimeForTests()`（dispose 单例 runtime：停 refresh timer + drain in-flight）登记 RESETTERS + fixture afterEach 调用——否则 runtime 的 timer/异步 refresh 会跨测试残留。
- **正向隔离测试**：测试 A 写 4 字段、测试 B 断全恢复；refresh timer/in-flight promise 存在时证 teardown 不留计时器/异步写；**runtime 未安装时 `getTokenRuntime()` fail-fast**（防静默兜底掩盖漏装配）。

## 闭合 commit DAG（每步同一 commit 内完整闭合、终态绿；替代 v1 松散 task）

- **C1**（冷、低风险）：`sensitive-output` + `sleep`（连同 utils 里 sleep）上提 foundation；tsconfig 精确 alias（`~/lib/tui/sensitive-output`、`~/lib/utils` 需拆——见下）；4+ 消费者相对 import 改 alias；foundation barrel + 守卫。
  - 注：`utils.ts` 是多符号文件，只需 `sleep` → 抽 `sleep` 到 foundation（`packages/foundation/src/sleep.ts` 或并入现有），`utils.ts` re-export 或消费者改 import；避免整文件搬（其它符号可能有 core 依赖，先查 `grep -n 'export' src/lib/utils.ts`）。
- **C2**：foundation 建 `error/tool-diagnostics-types.ts`（纯类型 SoT）→ **改 `http-error.ts:1` 自身 import 指向 foundation 类型**（不是靠 upstream-diagnostics re-export）→ 移 `http-error`/`classify`/`parsing`/`utils`(error) 纯基元入 foundation；`upstream-diagnostics.ts` 仅对旧 core 消费者 type re-export；**`forward.ts` 留 core**。targeted 测试：`instanceof HTTPError` 跨 foundation/core barrel 为真、400 diagnostics 从 producer 到 `forwardError` log 仍可观测（`tests/infra/{error,error-format,upstream-diagnostics}.unit.test.ts`）。error barrel 符号面零改、~57 消费者不动。
- **C3**：建 `createTokenRuntime`/`TokenRuntimeDependencies` 骨架 + 视图接口；旧 `initTokenManagers` lifecycle **façade 委托** runtime（同 commit 内不改消费者）。
- **C4**：**同一 commit** 收敛全部 provider/manager/CLI 5 链 + **3 个 lifecycle-op 消费者**（server 中间件 `ensureValidCopilotToken`、refresh 策略、shutdown）到 `getTokenRuntime()` 单例 + runtime 窄 API，带 fetch(`TokenFetch`) + paths(`TokenPersistencePaths`) + config(`TokenRuntimeConfigView`)；validate 临时 swap → `withGitHubTokenForValidation(token, op)`（try/finally + 并发策略）。装配层适配 `upstreamFetch`/`PATHS`/config 视图。**删除 `getCopilotTokenManager`/`ensureValidCopilotToken`/`stopTokenRefresh` 模块级公共导出**（escape hatch）。
- **C5**：接入 token-store snapshot/reset + fixture；**同一 commit** 迁完 8 个 core token-field 读点经 token 包 API、删 state token 字段+setter+镜像；`routes/token`/status/readiness/4 client/header builder 逐一。生命周期 `disposeTokenRuntime()` 单 owner，shutdown 只调它；测试：重复 init / shutdown-during-refresh / teardown-during-refresh 三条确定性 + 跨测试隔离正向。
- **C6**：GHC auth HTTP 完整符号表（见依赖 #5）移入 token `ghc-auth-http.ts`；`copilot-api.ts` 删 `githubHeaders`（确认 token 外零用）。`copilotBaseUrl`/`copilotHeaders` 留 core（models/transport 用）。
- **C7 = T2**：`git mv src/lib/token → packages/token/src`；package.json（声明 consola 等）+ tsconfig；过渡 alias `~/lib/token`+`~/lib/token/*`（2 barrel 消费者不改）；内部 import 收敛相对、对 foundation 用包名/alias。
  - **边界守卫**（复用 `package-boundaries.unit.test.ts` foundation guard 手法）：扫 `packages/token/src`，**拒所有 `~/`**、只许相对 + `@hsupu/ghc-proxy-foundation` + bare external + `node:`；**正样本对照**证 `@hsupu/ghc-proxy-core`/`~/lib/state`/`~/lib/transport/upstream-fetch` 会被命中。ESLint 同规则。
  - smoke：`bun run build:backend`（tsdown 内联 token）+ bin `--help` 不变。

## 风险 + 回滚

- **最危险 = C5**（state 所有权反转 + 8 读点 + 隔离契约）。缓解：C3/C4 先把 runtime + 注入立好、façade 委托保持行为；C5 先加 store+snapshot+隔离测试证不泄漏，再同 commit 切 8 读点 + 删 state 字段。
- **C2 http-error edge**：必须改 http-error 自身 import（非 re-export），否则 foundation→core type edge，守卫红。
- 隔离 worktree、每 commit 自足绿、可 `git revert`。

## Self-Review

- 7 依赖每条有 commit + 实测锚点 ✓；composition root 覆盖 5 CLI 链 ✓；8 读点收敛矩阵 ✓；隔离契约 ✓；两视图分离（credential vs config）✓；边界守卫正反控制 ✓；DomainPeel Contract 可复用 ✓。
- 无占位。类型一致：`TokenCredentialsView`/`TokenRuntimeConfigView`/`TokenFetch`/`TokenPersistencePaths`/`TokenRuntime` 贯穿。
- **开放决策（实施前定）**：state token 字段快照——(a) token store 自有 snapshot + fixture 组合，还是 (b) core 单一 `snapshotRuntimeStateForTests` 原子组合。倾向 (a)（token 拥有自己的隔离，符合包自治）。

## Kick-off Prompt

```
执行 docs/plan/monorepo-split/plan-token-package.md v2（.worktrees/monorepo-split）。
按闭合 commit DAG C1→C7 顺序，每 commit 同一提交内完整闭合、终态 typecheck+test:backend(parallel-test,0 fail)+精确 pathspec lint 绿，绝不跨 commit 留双 SoT。
DI 用视图/角色接口对象（非裸字段/位置参）。composition root createTokenRuntime 覆盖全 5 CLI 链(start/setup-*/auth/debug)、无全局 DI escape。
C2 必须改 http-error 自身 import 指 foundation 类型(非 re-export)。C5 最危险(state 所有权反转+8 读点+隔离契约)——先立 store+snapshot+正向隔离测试再同 commit 切读点删字段。
C7 边界守卫扫 packages/token/src 拒所有 ~/、带正样本证 core/state/transport 被命中。禁 eslint --fix 宽扫。
判据：长远正确+完整 > 省事，禁 ROI/YAGNI 砍范围。
```
