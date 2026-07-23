# HANDOFF：token 抽包 剩余任务（C3/C4/C5/C7）

> 面向接手的新会话。**权威 plan**：[plan-token-package.md](plan-token-package.md)（v2.2，经 3 轮异模型对抗审 0 blocker）。本文只记**当前落地状态 + 剩余任务 + 踩坑**，细节回 plan。工作在隔离 worktree `.worktrees/monorepo-split`（分支 `feat/monorepo-split`）。

## 当前状态（已 landed，均 test:backend 6305/0-fail 绿）

| commit | 内容 |
|---|---|
| `3acec08f` | **C1** — `tui/sensitive-output` + `utils`（sleep 等）→ foundation |
| `80b3cc07` | **C2** — error 纯基元（http-error/classify/parsing/utils/transport-reason）→ foundation；`ToolDiagnostics` 类型 SoT 抽 foundation、切 http-error 自身 import edge；`forward.ts` 留 core |
| `33f5a355` | **C6** — token 拥有 GHC auth HTTP（`ghc-auth-http.ts`：githubHeaders/GITHUB_* consts）；共享 HTTP 基元（standardHeaders/版本 consts/COPILOT_INTERNAL_API_VERSION）→ foundation `ghc-http-primitives.ts` |

> **注意 DAG 乱序**：应用户要求 **C6（GHC auth）提前一次性做完**，跳过了 C3/C4/C5。C3/C4/C5 **不依赖 C6**（composition root + 所有权反转与 auth-http 模块正交；ghc-auth-http 的 `githubHeaders(GithubHeaderIdentity)` 是结构化角色接口，C5 换 store 后仍兼容）。

**token→core 依赖进度**（`grep -rhoE 'from "~/lib/[a-z/-]+"' src/lib/token/`）：
- ✅ 已 foundation-alias（清）：`ghc-http-primitives`、`tui/sensitive-output`、`utils`。
- ⏳ **剩余 token→core 待反转**：
  - `~/lib/state`（3）+ `~/lib/state-readers/token`（4，读 state）→ **C5**（token store 所有权反转）。
  - `~/lib/transport/upstream-fetch`（2）→ **C4**（fetch 注入）。
  - `~/lib/config/paths`（1，`providers/file.ts`）→ **C4**（path 注入）。
  - `~/lib/error`（3）→ token 只用 `HTTPError`（foundation）；**C7 小清理**：改 `~/lib/error`（core barrel）→ `~/lib/error/http-error`（foundation alias）。

## 剩余任务（按 plan 闭合 commit DAG）

### C3 + C4：composition root + 注入（大、设计密集）
- 建 `createTokenRuntime({fetch,paths,runtimeConfig})` + `installTokenRuntime`/`getTokenRuntime`（fail-fast 未安装）/`resetTokenRuntimeForTests`——见 plan「Composition root」+「Singleton lifecycle 契约」。

> **为何 instance runtime 而非「模块全局 + reset」（决策已定，勿简化回全局）**：曾质疑「返回 instance 是过度设计、项目惯用全局单例（`state.ts`/`initTokenManagers`）更简单」。**实测证据推翻此质疑**：本仓库「bun 单进程跨文件共享 module-global 单例泄漏」是**反复出现的头号 flaky 根因**——为此才有 skill `test-isolation`/`debugging-test-pollution` + L1 守卫 `resetters-complete` + `useIsolatedRuntime` fixture 整套基建。即「全局 + reset」在本项目**不是够用的简单方案，而是持续产生污染 bug、要一整套守卫兜的已知债**。instance 版**每测试自造 runtime、依赖闭包随实例走、用完即弃 → 从结构上免疫跨测试泄漏**，正对本项目真实痛点，且顺项目既有 DI/隔离方向（`useIsolatedRuntime`）。`resetTokenRuntimeForTests` 仍要（覆盖对进程单例访问器的场景 + timer/in-flight 清理），但**主隔离手段是每测试自造实例**。**结论：plan v2.2 的 instance 设计保持不变。**

- **同一 commit** 收敛全部构造链到 runtime：
  - 5 条 CLI 链：`start`/`setup-claude-code`/`setup-codex`（用 `initTokenManagers`）+ **`auth`（直构造 DeviceAuth+FileProvider）+ `debug`（直构造 GitHubTokenManager ×3 + 直写 setGitHubToken/setCopilotToken）**——后两条是 escape hatch，必须收进 runtime。
  - 3 个 lifecycle-op 消费者用**同一实例**：`server.ts:126` 中间件 `ensureValidCopilotToken` / `token-refresh.ts:27` refresh / `shutdown.ts:398` dispose。删 `getCopilotTokenManager`/`ensureValidCopilotToken`/`stopTokenRefresh` 模块级公共导出。
  - 注入 `TokenFetch`（适配 upstreamFetch）+ `TokenPersistencePaths`（`providers/file.ts` 的 `PATHS.GITHUB_TOKEN_PATH`，穿透 3 构造链）+ `TokenRuntimeConfigView`（`showGitHubToken`/`vsCodeVersion`，**core-owned 注入**、不入 store）。
  - `providers/base.ts` validate 临时 token swap → 原子 `withGitHubTokenForValidation(token, op)`（try/finally + 并发）。

### C5：token store 所有权反转（**最危险**）
- token store 是 `githubToken`/`copilotToken`/`tokenInfo`/`copilotTokenInfo` 唯一 SoT。
- **8 个生产读点收敛矩阵**（plan「所有权收敛矩阵」有 file:line）：`anthropic/client:154`、`openai/{cc:42,embeddings:51,responses:57}`、`copilot-api:79`、`server.ts:48-54`、`routes/status`、`routes/token` → 经 token 包 API/视图读，**删 state 字段 + setter + 镜像**、禁 deep import。
- **测试隔离契约**（plan「测试隔离契约」）：`snapshotTokenStoreForTests`/`resetTokenStoreForTests` + `resetTokenRuntimeForTests`（停 timer+drain）登记 RESETTERS + fixture afterEach；**正向跨测试隔离测试**（测试 A 写 4 字段、B 断全恢复；未安装时 `getTokenRuntime` fail-fast）。注意 `cloneState`（`state.ts:1186,1219`）特殊克隆 tokenInfo/copilotTokenInfo——迁走后 restoreStateForTests 不恢复，故须自有 snapshot。
- **安全顺序**：先加 store + snapshot + 隔离测试证不泄漏，**再同 commit** 切 8 读点 + 删 state 字段。

### C7：物理抽包
- `git mv src/lib/token → packages/token/src`；`packages/token/package.json`（**声明 consola 等外部依赖**——单 lockfile hoist 会掩盖漏报）+ tsconfig；过渡 alias `~/lib/token`+`~/lib/token/*`。
- 内部 import 收敛相对；对 foundation 用 `@hsupu/ghc-proxy-foundation`（或 `~/lib/*` alias）；把剩余 `~/lib/error`→`~/lib/error/http-error`。
- **边界守卫**（复用 `tests/architecture/package-boundaries.unit.test.ts` foundation guard 手法）：扫 `packages/token/src`、**拒所有 `~/`**、只许相对 + `@hsupu/ghc-proxy-foundation` + bare external + `node:`；**正样本对照**证 `@hsupu/ghc-proxy-core`/`~/lib/state`/`~/lib/transport/upstream-fetch` 被命中。ESLint 同规则。
- smoke：`bun run build:backend` + bin `--help` 不变。

## 踩坑（C1/C2/C6 实测，接手必读）

1. **split-commit 陷阱**：`git mv` 后用**旧路径** pathspec `git add` 会 fail 并只提交 renames（半坏 commit）。修法：`git add` 用**新路径** + 修改的文件，split 了就 `git commit --amend` 补全。每次提交后 `git status --short` 确认树净。
2. **禁 `eslint --fix` 宽扫**（plan Global Constraints）：改 import 后常触发 `perfectionist/sort-imports`——用**精确 pathspec** `bunx eslint --fix <单文件>` + **必重跑 typecheck**（记忆 `.at()` autofix 破类型）。
3. **搬 helper 必逐字节核对行为**：C6 差点漏掉 githubHeaders 的 `"x-vscode-user-agent-library-version": "electron-fetch"` 头——搬迁前 diff 旧实现全字段，`copilot-api.it.test.ts` 是 githubHeaders 的 oracle。
4. **`~/lib/error` barrel 是 core**（index.ts 留 core、re-export foundation 基元）；token 用 HTTPError 应指 `~/lib/error/http-error`（foundation）不是 barrel。
5. **`export type { X } from` 不绑定本地名**：upstream-diagnostics 需 `import type { ToolDiagnostics } from foundation` + `export type { ToolDiagnostics }` 两句（本地用 + re-export）。
6. **bun.lock 偶尔被 install 触脏**（binary，~171B）：非语义改动就 `git restore bun.lock`。
7. **测试真相域**：`test:backend` = `bun scripts/parallel-test.ts unit it http`（authoritative，0 fail）；raw `bun test` 全套件可能因污染多 1 个 UDS flaky（isolated 复跑即绿，非回归）。

## Kick-off Prompt（接手贴这个）

```
接手 token 抽包剩余 C3/C4/C5/C7（.worktrees/monorepo-split 分支 feat/monorepo-split）。
先读 docs/plan/monorepo-split/{HANDOFF.md,plan-token-package.md}。C1/C2/C6 已 landed（3acec08f/80b3cc07/33f5a355）。
按闭合 commit DAG C3→C4→C5→C7，每 commit 同提交内完整闭合、typecheck+test:backend(parallel-test,0 fail)+精确 pathspec lint 绿、绝不跨 commit 留双 SoT。
DI 用视图/角色接口对象（非裸字段/位置参）。composition root createTokenRuntime 覆盖全 5 CLI 链(含 auth/debug 直构造)+3 lifecycle-op，无全局 escape。
C5 最危险(state 所有权反转+8 读点+隔离契约)——先立 store+snapshot+正向隔离测试再同 commit 切读点删字段；注意 cloneState 特殊克隆 token 字段。
C7 边界守卫扫 packages/token/src 拒所有 ~/、带正样本证 core/state/transport 被命中；package.json 声明 consola。
踩坑见 HANDOFF §踩坑（split-commit amend / 禁 eslint --fix 宽扫 / 搬 helper 逐字节核对 / ~/lib/error barrel 是 core）。
判据：长远正确+完整 > 省事，禁 ROI/YAGNI 砍范围。
```
