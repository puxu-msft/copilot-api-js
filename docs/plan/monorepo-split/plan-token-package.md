# Plan：把 token/auth 域抽成独立包 `@hsupu/ghc-proxy-token`

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`。步骤用 `- [ ]` 跟踪。索引 [README.md](README.md)、spec [../../spec/2026-07-22-monorepo-workspace-split.md](../../spec/2026-07-22-monorepo-workspace-split.md)。这是 spec §7.2 阶段 4+「core 内部增量解环」的**首个真领域包剥离**，作为后续 domain-peel 的模板。

**Goal:** 把 GitHub/Copilot auth 生命周期（`src/lib/token/`）从 core SCC 剥出为独立包 `@hsupu/ghc-proxy-token`，只依赖 `foundation` + 注入契约（fetch / token-store / paths），**不依赖 core**。

**Architecture:** token 域被依赖面极窄（仅 2 消费者：`routes/status`、`request/strategies/token-refresh`），领域正交。障碍是它**向 core 伸手的 6 条依赖**。策略：先把 3 条「共享瘦基元」上提 foundation（多域复用的清理性收益），再把 3 条 token 专属依赖反转成注入契约，最后物理 `git mv`。

**Tech Stack:** Bun workspaces、tsdown、ESLint 边界守卫、`bun test`。沿用 Phase 0 的过渡别名机制（`~/lib/x` 精确映射）。

## Global Constraints（详见 README §Global Constraints）

- 包名 `@hsupu/ghc-proxy-token`；发布根包/bin 不改。
- 每 commit：typecheck + `bun run test:backend`（authoritative parallel-test，0 fail）+ `bun run lint:all` 无新增违规 + 显式 pathspec 提交。
- 冻结 oracle = pre-move 已通过的 test:backend；搬迁/注入**不改任何测试的观测行为**，无需新增 golden（行为字节不变）。
- 每 commit 后跨包回边只减不增；DI 契约用**视图/角色接口**（非裸字段、非位置参），加字段时调用点零改（token 域 `TokenReadView` 已立此范式，commit `54b32200`）。

## 实测依据（依赖清单，已核）

token 向 core 的 6 条依赖：

| 依赖 | 实测 | 处理 |
|---|---|---|
| `tui/sensitive-output`（writeSensitiveOnce） | **零 import 纯叶子**；消费者 4（tui 2 + token 2） | **上提 foundation**（T0a） |
| `error` | token 3 文件 import `~/lib/error` | **上提 error 纯基元 foundation**（T0b，需先解 ToolDiagnostics 类型链，spec §3.2） |
| `config/paths` | token 仅 `providers/file.ts` 用 `PATHS.GITHUB_TOKEN_PATH`；paths 无 core 依赖但 11 消费者 | **注入路径**（T0c，不 hoist 整个 paths——11 消费者不值） |
| `copilot-api`（`githubHeaders` + `GITHUB_API_BASE_URL`） | `githubHeaders` 现**仅 token 用**（两调用方都是 token） | **移入 token 包**（T1a） |
| `transport/upstream-fetch`（`upstreamFetch`） | token 6 处调用（GHC/GitHub auth 端点） | **注入 fetch 契约**（T1b） |
| `state` 写（setGitHubToken/setCopilotToken/setTokenState）+ 读（经 `TokenReadView`） | token 拥有 github/copilot token + tokenInfo 状态 | **token 包拥有 token store**（T1c） |

---

## Phase T0：上提共享瘦基元到 foundation（清理性、多域复用、低风险）

### Task T0a：`sensitive-output` → foundation

**Files:** Move `src/lib/tui/sensitive-output.ts` → `packages/foundation/src/sensitive-output.ts`；Modify `tsconfig.json`（别名映射）、`packages/foundation/src/index.ts`（barrel）、4 消费者（`tui/terminal-ui.ts`、`tui/output-arbiter.ts`、`token/lifecycle.ts`、`token/providers/device-auth.ts`）的 import。

- [ ] **Step 1**：`git mv src/lib/tui/sensitive-output.ts packages/foundation/src/sensitive-output.ts`。
- [ ] **Step 2**：根 tsconfig `paths` 加 `"~/lib/tui/sensitive-output": ["./packages/foundation/src/sensitive-output"]`（精确 key，在 `~/*` 前）。
- [ ] **Step 3**：foundation barrel `index.ts` 加 `export * from "./sensitive-output"`。
- [ ] **Step 4**：4 消费者里凡**相对** import（`./sensitive-output` / `../tui/sensitive-output`）改 `~/lib/tui/sensitive-output`（alias 覆盖；`~/lib/*` 形式不用改）。用 `grep -rn 'sensitive-output' src` 找全。
- [ ] **Step 5**：`bun run typecheck` GREEN；`bun test tests/architecture/package-boundaries.unit.test.ts`（foundation 守卫仍绿——sensitive-output 纯、无 `~/` import）。
- [ ] **Step 6**：`bun run test:backend` = 0 fail；`bunx eslint --fix` 触碰文件 + 复跑 typecheck。
- [ ] **Step 7**：`git add -- <精确路径>`；`git commit`「refactor(foundation): hoist sensitive-output leaf primitive」。

### Task T0b：error 纯基元 → foundation（先解 ToolDiagnostics 类型链）

> 依据 spec §3.2：`http-error.ts` 被 `ToolDiagnostics` 类型经 `upstream-diagnostics.ts`（import state）拴 core，须先解链。

- [ ] **Step 1**：把 `ToolDiagnostics` **类型定义**从 `src/lib/upstream-diagnostics.ts` 抽到 `packages/foundation/src/tool-diagnostics-types.ts`（纯类型）；`upstream-diagnostics.ts` 改 `export type { ToolDiagnostics } from "~/lib/error/tool-diagnostics-types"`（re-export，SSOT）。typecheck GREEN。
- [ ] **Step 2**：`git mv` error 纯基元 `parsing.ts`/`utils.ts`（纯函数）/`http-error.ts`（解链后）/`classify.ts` → `packages/foundation/src/error/`；tsconfig 加 `"~/lib/error/*"` 精确映射子路径；**`forward.ts` 留 core**（import state+Hono）。
- [ ] **Step 3**：core 内 `lib/error/index.ts` barrel 继续 re-export forward（本地）+ 从 foundation re-export 纯基元——**barrel 符号表面零改动**，~57 消费者不动。
- [ ] **Step 4**：typecheck + test:backend 0 fail + foundation 守卫（error 纯基元零 `~/` import——若 classify 引 http-error 用相对 `./http-error` 则 OK）+ lint。
- [ ] **Step 5**：`git commit`「refactor(foundation): hoist error pure primitives (decouple ToolDiagnostics type)」。

### Task T0c：token 文件路径改注入（不 hoist config/paths）

- [ ] **Step 1**：写失败测试——`FileTokenProvider` 可注入 token 文件路径（构造参数），不再硬依赖 `PATHS.GITHUB_TOKEN_PATH`。
- [ ] **Step 2**：`providers/file.ts` 构造函数加 `tokenFilePath: string`（DI）；`fs.writeFile/readFile` 用注入值。移除 `import { PATHS } from "~/lib/config/paths"`。
- [ ] **Step 3**：`FileTokenProvider` 的构造点（token 装配处）传 `PATHS.GITHUB_TOKEN_PATH`——**注入发生在 core/cli 装配层**（token 包不知 PATHS）。找构造点：`grep -rn 'new FileTokenProvider' src`。
- [ ] **Step 4**：typecheck + test:backend 0 fail + lint。
- [ ] **Step 5**：`git commit`「refactor(token): inject token file path (drop config/paths dep)」。

---

## Phase T1：反转 token 专属 core 依赖为注入契约

### Task T1a：GHC auth HTTP helpers 移入 token 包

- [ ] **Step 1**：把 `githubHeaders` + `GithubHeaderIdentity`（现仅 token 用）+ auth 用的 URL 常量（`GITHUB_API_BASE_URL`；`github-client.ts` 里的 `GITHUB_BASE_URL`）迁到 `src/lib/token/ghc-auth-http.ts`（token 内部模块）；`copilot-api.ts` 删 `githubHeaders`（确认无他用：`grep -rn githubHeaders src` 仅 token）。
- [ ] **Step 2**：token 的 copilot-client/github-client 改 import 本地 `./ghc-auth-http`；`copilotBaseUrl`/`copilotHeaders`（token 是否还用？实测 token 不用这俩——仅 models/transport 用，留 core）。
- [ ] **Step 3**：typecheck + test:backend 0 fail（`tests/infra/copilot-api.it.test.ts` 的 githubHeaders 测试随之迁到 token 测试或调整 import）+ lint。
- [ ] **Step 4**：`git commit`「refactor(token): own GHC auth HTTP helpers (githubHeaders + urls)」。

### Task T1b：注入 fetch 契约

- [ ] **Step 1**：定义 token 包的 fetch 契约接口 `UpstreamFetch`（角色接口：`(url: string, init: RequestInit) => Promise<Response>`，与 `upstreamFetch` 签名对齐）在 token 包内。
- [ ] **Step 2**：copilot-client/github-client（及 device-auth）改为**接收注入的 fetch**（经 manager 构造参数或模块级 DI seam `setTokenFetch()`），不再 `import { upstreamFetch } from "~/lib/transport/upstream-fetch"`。
- [ ] **Step 3**：装配层（core/cli token 初始化处）把 `upstreamFetch` 注入 token。找初始化点：`grep -rn 'initTokenManagers\|new .*TokenManager' src`。
- [ ] **Step 4**：typecheck + test:backend 0 fail（token 测试注入 mock fetch）+ lint。
- [ ] **Step 5**：`git commit`「refactor(token): inject upstream fetch contract (drop transport dep)」。

### Task T1c：token 包拥有 token store（反转 state 写）

> 最承重一步。token 的 github/copilot token + tokenInfo 现属 `state.ts`。token 包应拥有这块 store，core 经视图读、经 token 包 API 写。

- [ ] **Step 1**：在 token 包建 `token-store.ts`——拥有 `{ githubToken, copilotToken, tokenInfo, copilotTokenInfo, showGitHubToken }` + 读视图（`getTokenReadView` 迁来）+ 写（`setGitHubToken` 等迁来）。
- [ ] **Step 2**：`state.ts` 这几字段**改为委托** token store（或 state 订阅 token store）——**决策点**：state 保留这些字段作 live-config 一部分？还是完全移交 token store、state 经 token 包读？倾向：token store 是 SoT，state.ts 的 `TokenReadView` seam 改成 re-export token 包的（`src/lib/state-readers/token.ts` → token 包）。**这步须确认热重载 / snapshot-restore 测试不破**（state 快照机制涉及这些字段）。
- [ ] **Step 3**：2 个外部消费者（`routes/status`、`request/strategies/token-refresh`）改经 token 包公共 API。
- [ ] **Step 4**：typecheck + test:backend 0 fail（**尤其 config-hot-reload / state snapshot-restore / RESETTERS 守卫**）+ lint。
- [ ] **Step 5**：`git commit`「refactor(token): own token store (invert state ownership)」。

---

## Phase T2：物理抽包

### Task T2：`git mv src/lib/token` → `packages/token/src` + 包定义 + 边界守卫

- [ ] **Step 1**：确认 T0/T1 后 token 对 core 零依赖：`grep -rn 'from "~/lib/' src/lib/token | grep -vE 'foundation-mapped|state-readers'` 应仅剩 foundation-alias + 注入契约。若有残留 core import，回补对应 T1 步。
- [ ] **Step 2**：`packages/token/package.json`（`@hsupu/ghc-proxy-token`, private, exports index）+ `tsconfig.json`。
- [ ] **Step 3**：`git mv src/lib/token/* packages/token/src/`；tsconfig 加 `"~/lib/token"` + `"~/lib/token/*"` 精确映射（过渡别名，2 消费者不改 import）。
- [ ] **Step 4**：token 包内部 import 收敛为相对 `./`；对 foundation 用 `@hsupu/ghc-proxy-foundation`（或过渡 `~/lib/*` alias）；注入契约为 token 包自有接口。
- [ ] **Step 5**：架构守卫 + ESLint：`packages/token/src/**` 禁 import `@hsupu/ghc-proxy-core`/`~/lib/{非foundation}`（只许 foundation + 注入契约 + 相对）。加正样本对照。
- [ ] **Step 6**：typecheck + test:backend 0 fail + lint + `bun run build:backend`（tsdown 内联 token 包）+ bin `--help` 不变。
- [ ] **Step 7**：`git commit`「refactor(token): extract @hsupu/ghc-proxy-token package」。

---

## 每 commit 通用 invariant（见 Global Constraints）+ 关键风险

- **最危险**：T1c（token store 反转 state 所有权）——涉 state snapshot-restore / 热重载 / RESETTERS 守卫。**缓解**：先只加 token store + 让 state 委托（双向一致），跑全 config/shutdown 测试确认快照机制不破，再切消费者。
- **T0b** ToolDiagnostics 解链若牵出更多 error 消费者的类型错，按 spec §3.2 gatekeeper 逐个补 re-export。
- **回滚**：隔离 worktree 内做，每 commit 自足绿、可 `git revert`。

## Self-Review

- spec §3.2（error 劈裂）→ T0b ✓；§5（视图 seam）→ 已立（T1c 沿用）✓；§7.2 阶段 4+（domain peel）→ 本 plan 是首例 ✓。
- 无占位：6 条依赖每条有具体 Task + 实测锚点。
- 类型一致：`TokenReadView`/`GithubHeaderIdentity`/`UpstreamFetch` 角色接口贯穿。
- **开放决策**（T1c Step 2）：state 保留 token 字段作 live-config vs 完全移交 token store——影响热重载语义，实施前定。

## Kick-off Prompt

```
执行 docs/plan/monorepo-split/plan-token-package.md（在 .worktrees/monorepo-split）。
按 T0a→T0b→T0c→T1a→T1b→T1c→T2 顺序。每 commit：typecheck + test:backend(parallel-test, 0 fail)
+ lint:all 无新增 + 显式 pathspec。DI 用视图/角色接口非裸字段。T1c 最危险(state 所有权反转)——
先加 store+委托、验快照/热重载/RESETTERS 守卫绿再切消费者。物理搬迁用 git mv + 过渡别名(2 消费者不改)。
判据：长远正确+完整 > 省事，禁 ROI/YAGNI 砍范围。
```
