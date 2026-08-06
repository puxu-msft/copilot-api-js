# GitHub Enterprise 鉴权主机实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。所有步骤用 checkbox 跟踪；每个任务完成后先评审再进入下一任务。

- 计划状态：已定稿，独立评审通过
- 实施状态：未实施；按 docs-merge-before-execute，合入 master 后另行决定是否执行
- 计划评审：[2026-08-06-github-enterprise-auth-host-review.md](./2026-08-06-github-enterprise-auth-host-review.md)
- 规格：[docs/spec/2026-08-05-github-enterprise-auth-host.md](../spec/2026-08-05-github-enterprise-auth-host.md)
- 规格评审：[docs/spec/2026-08-05-github-enterprise-auth-host-review.md](../spec/2026-08-05-github-enterprise-auth-host-review.md)
- Kick-off：[2026-08-06-github-enterprise-auth-host-kickoff.md](./2026-08-06-github-enterprise-auth-host-kickoff.md)

**Goal:** 允许通过 `config.yaml` 为 `*.ghe.com` 数据驻留 tenant 联动配置 GitHub OAuth、GitHub REST API 与 Copilot API，并为自托管部署提供显式端点覆盖，同时保持公共 GitHub 默认行为。

**Architecture:** Core config 域解析并冻结 `GitHubEndpointSnapshot`；token 包只消费注入的 endpoint/path，不理解 YAML 或 GHE 派生。配置加载改为 prepare/commit 两阶段事务，CLI 入口经共享 bootstrap 取得同一 snapshot 和 provider policy，proxy 保留 CLI/env/config 三来源到逐 origin 决策点。

**Tech Stack:** TypeScript 5.9、Bun/Node、Zod 4、YAML 2、`@octokit/oauth-methods`、`@octokit/request`、undici、node:http2、Bun test。

## Global Constraints

- 这是中小型任务，按 6 个语义任务实施；不得升级成大型 RFC，也不得以规模为由删减规格验收。
- 不触碰或终止用户的 4141 主服务器；本计划不需要启动测试服务器。
- 公共 authority `https://github.com` 必须继续使用现有 `$APP_DIR/github_token`。
- GitHub Web/API endpoint、authority 和 token path 是进程启动快照，不热更新；一般配置仍可 hot reload。
- 无效 GitHub identity 配置在首次启动和一次性命令中 fail-closed；运行期 reload 保持 last-known-good。
- 同目录文件互导使用相对路径；跨域使用项目别名或 workspace package 名。
- 后端快速反馈用 `bun run test`；提交前完整门禁用 `bun run test:backend`、`bun run typecheck`、`bun run lint:all`。
- 新增 module-global 状态必须提供 `reset*ForTests` 并登记测试 RESETTERS。
- 每个任务遵循 TDD：先红、再实现、再绿；任务列出的 mutation control 必须真实注入、确认因目标机制变红、恢复后再绿。
- 计划含 6 个语义 commit，执行前必须创建 `docs/tmp/2026-08-06-github-enterprise-auth-host-progress-impl.md`，按 `session-closeout` §6b 随每个实现 commit 更新并提交。
- 所有 Git 操作使用精确 pathspec；不得 push、amend、stash、reset 或清理他人文件。

---

## 文件与职责

### 新建

- `packages/foundation/src/github-endpoints.ts`：跨 core/token 共享的 endpoint snapshot 类型，以及保留 base path 的 route append primitive。
- `src/lib/config/github-endpoints.ts`：GitHub 配置 raw guard、GHEC tenant 派生、显式 override 和 token path 解析。
- `src/lib/config/application-plan.ts`：零副作用 prepare、no-throw commit plan、配置事务通知边界。
- `packages/cli/src/token-bootstrap.ts`：token-aware CLI 的共享 config/snapshot/proxy/runtime bootstrap。
- `tests/config/github-endpoints.unit.test.ts`：URL、authority、override 与 path 派生双向矩阵。
- `tests/config/config-application-transaction.it.test.ts`：prepare/commit 原子性、last-known-good、PUT 复用 plan 与 listener 一致性。
- `tests/token/github-oauth-device.it.test.ts`：Octokit low-level methods、可取消轮询与零遗留 timer。
- `tests/token/github-token-authority.it.test.ts`：authority-specific persistence、原子写和 provider policy。
- `tests/cli/token-bootstrap.it.test.ts`：全部 token-aware CLI 的入口/provider 负向矩阵。

### 修改

- `packages/foundation/src/state.ts`：配置事务期间延迟/coalesce 同步 listener 通知。
- `packages/foundation/src/index.ts`：导出共享 endpoint 类型/primitive。
- `packages/token/package.json`、`bun.lock`：加入最新稳定、实施时重新查询确认的 `@octokit/oauth-methods` 与兼容 `@octokit/request`。
- `packages/token/src/dependencies.ts`：注入 immutable endpoint snapshot、token path 和 OAuth scheduler 所需 signal。
- `packages/token/src/github-client.ts`、`packages/token/src/copilot-client.ts`：移除公共 host 常量依赖，使用 snapshot 与 path-preserving append。
- `packages/token/src/providers/device-auth.ts`、`packages/token/src/providers/file.ts`、`packages/token/src/github-token-manager.ts`：低层 OAuth methods、原子持久化、显式 provider policy。
- `packages/token/src/runtime.ts`、`packages/token/src/index.ts`：runtime 构造和新类型导出。
- `src/lib/config/schema.ts`、`src/lib/config/config.ts`、`src/lib/config/paths.ts`、`src/lib/config/validation.ts`：GitHub schema、raw parser、配置事务、last-known-good 和 app-dir/token-path 职责拆分。
- `src/routes/config/route.ts`：PUT 写盘前 prepare，写盘后复用同一 plan；写入 `github` section。
- `src/lib/token-runtime.ts`：从 bootstrap snapshot 构造 token deps，不再从全局 `PATHS.GITHUB_TOKEN_PATH` live 读取。
- `src/lib/proxy.ts`、`src/lib/transport/http2-client.ts`：逐 origin proxy policy。
- `packages/cli/src/auth.ts`、`logout.ts`、`debug.ts`、`start.ts`、`setup-codex.ts`、`setup-claude-code.ts`：统一 bootstrap 与各命令 provider/storage policy。
- `config.yaml`、`config.example.yaml`、`config.schema.json`：配置表面与生成 schema。
- `README.md`、`docs/authentication.md`、`docs/DESIGN.md`、`docs/API.md`：用户配置、认证架构、状态 API 与待重启语义。

---

### Task 1: Endpoint 类型、严格 URL guard 与配置解析

**Files:**
- Create: `packages/foundation/src/github-endpoints.ts`
- Create: `src/lib/config/github-endpoints.ts`
- Create: `tests/config/github-endpoints.unit.test.ts`
- Modify: `packages/foundation/src/index.ts`
- Modify: `src/lib/config/schema.ts:1281-1310,1384-1390`
- Modify: `src/lib/config/paths.ts:6-15,56-91`
- Modify: `src/routes/config/route.ts:292-312`
- Modify: `config.yaml:50-65`
- Modify: `config.example.yaml`

**Interfaces:**
- Produces:

```ts
// packages/foundation/src/github-endpoints.ts
export interface GitHubEndpointSnapshot {
  readonly authority: string
  readonly webBaseUrl: string
  readonly apiBaseUrl: string
  readonly copilotBaseUrlOverride?: string
  readonly githubTokenPath: string
}

export function appendEndpointPath(baseUrl: string, route: `/${string}`): string
```

```ts
// src/lib/config/github-endpoints.ts
export interface ResolveGitHubEndpointsOptions {
  readonly appDir: string
  readonly github?: { enterprise_host?: string; web_base_url?: string; api_base_url?: string }
  readonly ghcApiBaseUrl?: string
}

export function resolveGitHubEndpointSnapshot(options: ResolveGitHubEndpointsOptions): GitHubEndpointSnapshot
export function assertStrictGithubConfig(
  raw: { readonly github?: unknown; readonly ghc_api_base_url?: unknown },
  source?: string,
): void
```

- Consumes: `Config.github`, `PATHS.APP_DIR`, CLI-resolved `ghcApiBaseUrl`。

- [ ] **Step 1: 写 URL/authority 失败测试**

在 `tests/config/github-endpoints.unit.test.ts` 写表驱动测试，至少包含：

```ts
const equivalent = [
  "msft.ghe.com",
  "https://msft.ghe.com",
  "https://api.msft.ghe.com",
  "https://copilot-api.msft.ghe.com",
]
for (const enterprise_host of equivalent) {
  test(`derives all GHEC origins from ${enterprise_host}`, () => {
    expect(resolveGitHubEndpointSnapshot({ appDir: "/data", github: { enterprise_host } })).toEqual({
      authority: "https://msft.ghe.com",
      webBaseUrl: "https://msft.ghe.com",
      apiBaseUrl: "https://api.msft.ghe.com",
      copilotBaseUrlOverride: "https://copilot-api.msft.ghe.com",
      githubTokenPath: expect.stringMatching(/^\/data\/github_tokens\/[0-9a-f]{64}$/u),
    })
  })
}
```

负样本明确构造 `\\`、TAB/LF/CR、其它 C0、DEL、`/a/..`、`/a/%2e%2e`、`//`、credentials、query、fragment、非默认 GHEC 端口、裸 `ghe.com` 和非 `*.ghe.com`。

- [ ] **Step 2: 运行测试确认因模块缺失而红**

Run: `bun test tests/config/github-endpoints.unit.test.ts`

Expected: FAIL，提示无法解析 `~/lib/config/github-endpoints` 或缺少导出。

- [ ] **Step 3: 实现共享类型与 path-preserving append**

`appendEndpointPath` 必须先拒绝不是单个 leading slash 的 route、query、fragment、scheme、authority 和反斜杠，再使用：

```ts
const url = new URL(baseUrl)
const basePath = url.pathname.replace(/\/+$/u, "")
url.pathname = `${basePath}/${route.slice(1)}`
url.search = ""
url.hash = ""
return url.toString().replace(/\/$/u, "")
```

测试 `https://host/api/v3` + `/user` 得到 `https://host/api/v3/user`，并断言 `new URL("/user", base)` 的错误形态不会被采用。

- [ ] **Step 4: 实现 raw guard、GHEC 派生与 authority token path**

在任何 `trim()` 或 `new URL()` 前执行：

```ts
const FORBIDDEN_RAW_URL_CHARS = /[\\\u0000-\u001f\u007f]/u
```

Web origin 只允许 authority 后空或单 `/`；API/Copilot endpoint 允许正斜杠 base path。公共 authority 精确返回 `path.join(appDir, "github_token")`；其它 authority 返回 `path.join(appDir, "github_tokens", createHash("sha256").update(authority).digest("hex"))`。

- [ ] **Step 5: 接入 Zod schema 与 YAML 写盘表面**

新增并导出严格 `GitHubConfigSchema`：

```ts
export const GitHubConfigSchema = z.object({
  enterprise_host: nullableString(),
  web_base_url: nullableString(),
  api_base_url: nullableString(),
}).strict()
```

`ConfigSchema` 增加 `github: nullableSection(GitHubConfigSchema)`；`mergeConfigIntoDocument()` 增加 `setNestedScalarContainer(doc, ["github"], body.github)`；bundled/example config 写完整注释但不默认启用 enterprise host。`assertStrictGithubConfig()` 必须同时检查 raw `github` 子树和顶层 raw `ghc_api_base_url`，后者不能先被一般 warn-strip 清掉；HTTP PUT 的 hard-fail schema 和 boot/reload raw guard 复用同一 URL validator。

- [ ] **Step 6: 跑正向、负向与 schema 测试**

Run: `bun test tests/config/github-endpoints.unit.test.ts tests/config/config-validation.unit.test.ts tests/config/config-yaml-routes.http.test.ts tests/config/config-schema-json-export.unit.test.ts`

Expected: PASS。

- [ ] **Step 7: 运行 raw-guard mutation control**

临时删除反斜杠/C0 pre-parser guard，运行：

`bun test tests/config/github-endpoints.unit.test.ts --test-name-pattern "raw URL"`

Expected: FAIL，至少 `https://msft.ghe.com\\evil` 或 TAB/LF 样本被错误接受；确认失败来自 raw guard 后恢复实现，再运行同命令为 PASS。

- [ ] **Step 8: 生成 config schema 并提交**

Run: `bun run generate:config-schema && git diff --check`

Commit:

```bash
git add -- packages/foundation/src/github-endpoints.ts packages/foundation/src/index.ts src/lib/config/github-endpoints.ts src/lib/config/schema.ts src/lib/config/paths.ts src/routes/config/route.ts config.yaml config.example.yaml config.schema.json tests/config/github-endpoints.unit.test.ts tests/config/config-validation.unit.test.ts tests/config/config-yaml-routes.http.test.ts tests/config/config-schema-json-export.unit.test.ts docs/tmp/2026-08-06-github-enterprise-auth-host-progress-impl.md
git commit -m "feat(config): resolve GitHub Enterprise endpoints"
```

---

### Task 2: 两阶段配置事务与 last-known-good reload

**Files:**
- Create: `src/lib/config/application-plan.ts`
- Create: `tests/config/config-application-transaction.it.test.ts`
- Modify: `src/lib/config/config.ts:123-325,356-658,683-1235`
- Modify: `src/lib/config/validation.ts:33-150`
- Modify: `src/lib/config/compat.ts:408-550`
- Modify: `packages/foundation/src/state.ts:1133,1508-1705`
- Modify: `src/routes/config/route.ts:109-163`
- Modify: `src/routes/status/route.ts:59-93,188-205`
- Modify: `tests/config/config-hot-reload.it.test.ts`
- Modify: `tests/config/config-effective-route.http.test.ts`
- Modify: `tests/config/generation-runtime-config.unit.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `GitHubConfigSchema` 与 endpoint config 类型。
- Produces:

```ts
export interface ConfigContentGeneration {
  readonly mtimeMs: number
  readonly size: number
  readonly sha256: string
}

export interface ConfigDiagnostic {
  readonly dedupKey: string
  readonly level: "info" | "warn" | "error"
  readonly message: string
}

export interface ConfigValidationPlan {
  readonly value: Config
  readonly legacyPathsRemoved: ReadonlyArray<string>
  readonly diagnostics: ReadonlyArray<ConfigDiagnostic>
}

export function prepareConfigValidation(raw: Record<string, unknown>): ConfigValidationPlan
export function commitConfigDiagnostics(diagnostics: ReadonlyArray<ConfigDiagnostic>): void

export type ConfigManagedStateKey =
  | keyof typeof CONFIG_MANAGED_DEFAULTS
  | "modelMappings"
  | "modelTranslation"

export type ConfigStatePatch = Partial<Pick<State, ConfigManagedStateKey>>
// The types above live in packages/foundation/src/state.ts and are exported by foundation;
// core application-plan.ts imports them. Foundation never imports core config.

export type ConfigDomainPatch =
  | { readonly kind: "v3-persist-retry"; readonly value: { maxAttempts: number; backoffMs: number; maxTotalMs: number } }
  | { readonly kind: "disabled-models"; readonly value: ReadonlyArray<string> }

export type ConfigAfterCommitEffect =
  | { readonly kind: "sync-model-refresh-loop"; readonly intervalSeconds: number }
  | { readonly kind: "record-timeout-diff"; readonly before: TimeoutSnapshot; readonly after: TimeoutSnapshot }

export interface ConfigApplicationPlan {
  readonly effectiveConfig: Config
  readonly generation: ConfigContentGeneration
  readonly statePatch: Readonly<ConfigStatePatch>
  readonly domainPatches: ReadonlyArray<ConfigDomainPatch>
  readonly diagnostics: ReadonlyArray<ConfigDiagnostic>
  readonly afterCommitEffects: ReadonlyArray<ConfigAfterCommitEffect>
}

export interface PrepareConfigApplicationOptions {
  readonly candidate: Config
  readonly validationDiagnostics: ReadonlyArray<ConfigDiagnostic>
  readonly generation: ConfigContentGeneration
  readonly baseline: "current-runtime" | "config-defaults"
}

export async function prepareConfigApplication(options: PrepareConfigApplicationOptions): Promise<ConfigApplicationPlan>
export function commitConfigApplication(plan: ConfigApplicationPlan): Config
export async function runConfigTransaction<T>(operation: () => Promise<T>): Promise<T>
export async function loadAndPrepareConfig(options: { mode: "boot" | "reload" }): Promise<ConfigApplicationPlan | null>
export function getConfigRuntimeStatus(): {
  readonly activeGeneration: ConfigContentGeneration | null
  readonly pendingInvalid: { generation: ConfigContentGeneration; message: string } | null
  readonly pendingRestart: { github: boolean; ghcApiBaseUrl: boolean }
}
```

```ts
// packages/foundation/src/state.ts
export interface ConfigStateNotificationBatch {
  readonly channels: ReadonlyArray<"history" | "telemetry" | "watchdog" | "transport">
}
export function applyConfigManagedStatePatchDeferred(patch: Readonly<ConfigStatePatch>): ConfigStateNotificationBatch
export function flushConfigStateNotifications(batch: ConfigStateNotificationBatch): void
// apply updates the full state patch without notifying; flush runs only after core domain patches complete.
```

- [ ] **Step 1: 写 partial-publish 回归测试**

在新测试中先应用合法配置并快照 state/cache/listener counts；再写入 Zod 合法但 generation 交叉约束非法的配置，例如：

```yaml
anthropic:
  tool_search: false
generation:
  max_active_candidates: 3
  max_total_candidates: 2
```

调用 reload 后断言 Anthropic、generation、config cache、accepted generation 全保持旧值，listener 调用为 0，且记录 `pending-invalid`。

- [ ] **Step 2: 运行测试确认当前实现会部分修改后红**

Run: `bun test tests/config/config-application-transaction.it.test.ts`

Expected: FAIL，当前 `setAnthropicBehavior` 已执行或 cache 已更新后 generation 才抛错。

- [ ] **Step 3: 抽出 raw YAML parser 和 candidate builder**

把 `loadRawConfigFile()` 拆为：

```ts
export async function parseUserConfigYamlRaw(): Promise<Record<string, unknown>>
export function validateAndMergeConfig(
  raw: Record<string, unknown>,
  bundled: Config,
): { readonly config: Config; readonly diagnostics: ReadonlyArray<ConfigDiagnostic> }
```

`parseUserConfigYamlRaw()` 不调用 `validateConfig()`；boot/reload/PUT 都在 warn-strip 前把**完整 raw top-level mapping**传给 `assertStrictGithubConfig(raw)`，让它同时检查 `github` 与顶层 `ghc_api_base_url`。Reload 读取整份内容一次，并从同一 bytes 计算 `mtime + size + sha256`，避免 parse/digest 双读 TOCTOU。三路径共享表驱动测试：非法 `github.web_base_url` 与非法顶层 `ghc_api_base_url` 均 fail-closed；mutation 把任一路径调用改成 `assertStrictGithubConfig(raw.github)` 后，顶层 URL 样本必须变红。

把 `extractAndTranslateDeprecatedWithOps` 拆出纯 `prepareDeprecatedConfigMigration()`：返回 value、legacy paths 与 deprecation diagnostics，不写 consola、不修改 warned set。`prepareConfigValidation()` 调纯 migration + Zod safeParse/clean/reparse，返回 `ConfigValidationPlan`；现有 `validateConfig()` 改为兼容 wrapper（prepare 后立即 commit diagnostics），供未迁移的纯读取测试/调用点保持行为。`validateAndMergeConfig()` 把 validation/migration diagnostics 与 merged config 一起返回；调用 `prepareConfigApplication({ candidate: config, validationDiagnostics: diagnostics, ... })` 将其原样带入 `ConfigApplicationPlan.diagnostics`。事务路径只在配置 commit 成功后调用 `commitConfigDiagnostics(plan.diagnostics)`，此时才登记 warn-once key 和输出。

- [ ] **Step 4: 把 apply-time 计算移入 prepare**

`application-plan.ts` 预计算所有 regex、model-key normalization、generation patch/cross-field checks、restart-only warnings 和 domain patch。不要让 commit 再调用可能抛错的 `compile*`/`normalize*`。现有 invalid regex 的 warn-and-skip 语义在 prepare 中保留，warning 作为带稳定 `dedupKey` 的 `ConfigDiagnostic` 合并进 `validationDiagnostics`，延迟到 commit 后登记并输出。`baseline:"current-runtime"` 用于 hot reload，缺失字段保持当前值；`baseline:"config-defaults"` 用于 PUT/reset 语义，从 `CONFIG_MANAGED_DEFAULTS`、`DEFAULT_MODEL_MAPPINGS`、`DEFAULT_MODEL_TRANSLATION` 和空 disabled list 构造完整基线。两条路径都产出完整而非增量的 `statePatch`，避免 listener 比较部分对象。

逐一分类现有 `applyConfigToState()` 的非-state side effects，禁止遗漏：

- **Commit 内 no-throw module patches**：`setV3PersistRetryConfig`，以及 `applyDisabledModels`（列表与过滤后 catalog view 必须在 listener flush 前一致）；参数在 prepare 完全计算。`disabledModels` 不同时放入 `statePatch`，避免写两次。
- **After-commit effects**：`syncModelRefreshLoop`、`recordConfigReloadTimeoutDiff`。它们只在 state/cache commit 完成后运行；失败要 `consola.error` 并进入可观测诊断，不得把已提交配置伪装回滚。
- **Diagnostics**：`warnProtectStreamingHeartbeatOnce`、shared retry disable、telemetry fallback、restart-only、Bun h2 warning、silence-guard warning、reload info。prepare 生成消息/级别，commit 后发出；prepare 失败只发 pending-invalid，不发候选配置的普通 warning。

对这份清单做 AST/文本 guard：`applyConfigToState()` 重构后不得残留直接 setter/compile/normalize/effect 调用，所有项目必须进入 plan builder、commit patch 或 after-commit effect。

- [ ] **Step 5: 在 foundation 实现单次 config-owned state patch**

新增 `applyConfigManagedStatePatchDeferred(patch)`：先根据完整 before/after 计算 `history`、`telemetry`、`watchdog`、`transport` 四个 channel 是否变化，再一次 `updateState(patch)`，返回只含变化 channel 的不可变 batch，不通知。Core 完成 `disabled-models` 等 domain patch 和 committed snapshot 发布后才调用 `flushConfigStateNotifications(batch)`。Flush 中每个 listener 单独 `try/catch`，一个 listener 抛错时记录 channel/error 并继续同 channel 及后续 channel；对调用方保持 no-throw。原有单域 setter 保留给其它调用者，行为不变。`ConfigManagedStateKey` 与 `CONFIG_MANAGED_DEFAULTS` + 两个 state 独立默认源（model mappings/translation；disabled list 归 domain patch）做类型/测试 completeness 对账；新增 config-owned state 字段时必须更新该 union，否则守卫红。订阅时立即调用的 `onHistoryRawCaptureChange` 注册语义保持不变。

- [ ] **Step 6: 实现 no-throw commit 和 last-known-good cache**

所有 config 入口（middleware/handler/system-prompt/CLI/PUT）通过 module-global `runConfigTransaction()` 串行执行 read→prepare→write/commit；它用 rejection-tolerant promise chain，某次失败不毒化下一次。Reload 在 prepare 后、commit 前重新读取磁盘 bytes 并比较完整 content generation；若变化，丢弃 stale plan，在同一队列 operation 中从最新 bytes 重试，设有限重试上限并记录高频 churn。PUT operation 在队列内读取最新 editable doc、合成 candidate、prepare、atomic write、commit，不允许锁外 prepare。

`commitConfigApplication(plan)` 的同步 commit point 按固定顺序执行：先发布一个不可变 `CommittedConfigSnapshot` 引用（effective config + accepted generation），再调用 `applyConfigManagedStatePatchDeferred(plan.statePatch)` 得到 notification batch，再穷尽解释结构化 `domainPatches`（含 disabled list + catalog view），最后清除 pending-invalid、commit validation diagnostics 的 warn-once keys，并调用 `flushConfigStateNotifications(batch)`。这样 listener 同时看到新 cache/generation、完整 state 与新 catalog view。不得用任意函数 closure 充当 patch/effect。之后按枚举 kind 执行 `afterCommitEffects` 和 diagnostics；effect 若抛错，记录 effect kind 和错误但继续后续 effect，配置保持 committed，不允许部分 rollback。Reload prepare 失败时保留 last-known-good，按 content generation 一次性 warn。新增 `resetConfigApplicationStateForTests()` 并登记 RESETTERS。

- [ ] **Step 7: 重构 PUT 为 prepare-before-write，并暴露配置运行态**

`PUT /api/config/yaml` 在内存中合成 disk migration patch + payload + bundled candidate，strict validate + prepare；失败返回 structured 400 且磁盘/runtime 不变。成功时用 `atomicWriteText(PATHS.CONFIG_YAML, doc.toString())`，再 commit 同一 plan，不 reset/re-read。

`getConfigRuntimeStatus()` 暴露 active generation、pending-invalid 与 GitHub/GHC endpoint pending-restart。`GET /api/status` 新增开放对象 `config`，至少返回该状态；不得只返回磁盘声明值。PUT 成功修改 endpoint 时响应仍返回保存后的 YAML，但 `config.pendingRestart` 必须为 true、active snapshot 不变。

- [ ] **Step 8: 补 listener、PUT 与状态 API 双向测试**

测试：

- prepare 失败所有 domain/listener/cache 不变，`consola.warn` 调用与 schema/deprecation warned-key 集也不变；同一候选修正后成功 commit 时 warning 仍会首次输出，第二次成功应用同一 diagnostic 不重复。
- `validateAndMergeConfig()` 产生的 schema/deprecation `dedupKey` 逐个存在于最终 `ConfigApplicationPlan.diagnostics`；删除这条传递接线的 mutation 必须让测试红。
- commit 后每个 channel 最多通知一次，listener 读取的其它 domain 已是新值。
- 同 mtime/size 但不同 digest 的修复文件会重试成功。
- 用 barrier 构造 reload A 读/prepare 后暂停、PUT B 请求到达、A 恢复：共享队列保证 B 等 A 完成；再构造测试 seam 让 A commit 前磁盘 generation 变化，A 必须丢弃 stale plan 并重读，不能覆盖新磁盘内容。
- 两个并发 `applyConfigToState()` 和一个 PUT 的完成顺序与队列顺序一致；任一 operation 失败不阻塞后续。
- PUT prepare 失败不写盘；写盘失败不改 runtime；成功复用 plan。
- 一般非法非 GitHub leaf 仍 warn-strip，GitHub section strict fail。
- `applyDisabledModels`、`refreshCatalogView`、`syncModelRefreshLoop`、timeout diagnostics 在 prepare 失败时调用次数为 0；成功时只在完整 commit 后调用。
- 人为让一个 after-commit effect 抛错，断言其它 effect 继续执行、committed state/cache 不回滚、错误可观测。
- 手工写入 invalid GitHub/YAML 后 status.config 显示 pending-invalid 且 active generation 不变；修复后清除。PUT 改 endpoint 后 pending-restart=true、active endpoint snapshot 不变。
- Source guard 枚举原 `applyConfigToState` 的 setter/compile/normalize/effect 集合，断言重构后每一项有且只有一个新归属。

- [ ] **Step 9: 运行三个 mutation controls**

依次临时注入并确认目标测试变红：

1. 在 prepare 前发布 cache。
2. 让 `setTimeoutConfig` 在事务内立即通知。
3. 把 generation 交叉约束移回第一个 state setter 之后。
4. 在 prepare 阶段直接调用 `warnIssueOnce`／deprecated warn wrapper。
5. 绕过 `runConfigTransaction()` 让 stale reload plan 在 PUT 后 commit。

每次恢复后运行 `bun test tests/config/config-application-transaction.it.test.ts` 为 PASS。

- [ ] **Step 10: 跑配置回归并提交**

Run:

```bash
bun test tests/config/config-application-transaction.it.test.ts tests/config/config-hot-reload.it.test.ts tests/config/config-yaml-routes.http.test.ts tests/config/config-effective-route.http.test.ts tests/config/config-apply-catalog-consistency.it.test.ts tests/config/generation-runtime-config.unit.test.ts
bun run typecheck
```

Commit:

```bash
git add -- src/lib/config/application-plan.ts src/lib/config/config.ts src/lib/config/validation.ts src/lib/config/compat.ts src/routes/config/route.ts src/routes/status/route.ts packages/foundation/src/state.ts tests/config/config-application-transaction.it.test.ts tests/config/config-hot-reload.it.test.ts tests/config/config-yaml-routes.http.test.ts tests/config/config-effective-route.http.test.ts tests/config/config-apply-catalog-consistency.it.test.ts tests/config/generation-runtime-config.unit.test.ts docs/tmp/2026-08-06-github-enterprise-auth-host-progress-impl.md
git commit -m "refactor(config): apply configuration transactionally"
```

---

### Task 3: 逐 origin proxy policy

**Files:**
- Modify: `src/lib/proxy.ts:154-253,382-503`
- Modify: `src/lib/transport/http2-client.ts`（`getProxyUrlForOrigin` 消费点）
- Modify: `packages/cli/src/start.ts:346-356`
- Test: `tests/infra/proxy.unit.test.ts`
- Test: `tests/transport/proxy-connect.unit.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ProxyPolicyOptions {
  readonly cliProxyUrl?: string
  readonly configProxyUrl?: string
  readonly fromEnv: boolean
}

export function initProxyPolicy(options: ProxyPolicyOptions): void
export function getProxyUrlForOrigin(origin: URL): string | undefined
```

- Resolution: CLI explicit → env for this origin（NO_PROXY-aware）→ config fallback → direct。

- [ ] **Step 1: 写 Web/API/Copilot 三 origin 矩阵测试**

表驱动覆盖：CLI wins all、env hit、env miss→config、NO_PROXY→config、env disabled→config、无来源→direct。三个 origin 分别为 `msft.ghe.com`、`api.msft.ghe.com`、`copilot-api.msft.ghe.com`。

- [ ] **Step 2: 运行测试确认 current global folding 失败**

Run: `bun test tests/infra/proxy.unit.test.ts --test-name-pattern "per-origin policy"`

Expected: FAIL；当前 `ProxyOptions.url` 把 config 与 CLI 折成同一来源，env miss 无法回落 config。

- [ ] **Step 3: 保留三来源到请求决策点**

替换 `cachedProxyOptions` 为 `cachedProxyPolicy`。`getProxyUrlForOrigin()` 逐次调用 `getProxyForUrl(origin)`；env 未命中后返回 config。Undici dispatcher 不能再用现有 `EnvProxyDispatcher` 的 env-only逻辑：改为 `PolicyProxyDispatcher`，其 dispatch 调共享 `resolveProxyUrlForOrigin(policy, origin)`。

- [ ] **Step 4: 统一 Bun/Node/http2 消费**

Bun 不再把 config fallback 冒充环境变量；HTTPS h2 继续调 `getProxyUrlForOrigin()`。Plain HTTP undici 使用 policy dispatcher。CLI `--proxy` 和 `--http-proxy-from-env` 只构造 policy，不预采样 Copilot host。

- [ ] **Step 5: 运行旧预采样 mutation**

临时把 policy 初始化改回只看 Copilot origin；运行三-origin matrix，Expected: FAIL 在 Web/API env/NO_PROXY 分支。恢复后 PASS。

- [ ] **Step 6: 回归并提交**

Run:

```bash
bun test tests/infra/proxy.unit.test.ts tests/transport/proxy-connect.unit.test.ts tests/transport/http2-client.it.test.ts
bun run typecheck
```

Commit:

```bash
git add -- src/lib/proxy.ts src/lib/transport/http2-client.ts packages/cli/src/start.ts tests/infra/proxy.unit.test.ts tests/transport/proxy-connect.unit.test.ts tests/transport/http2-client.it.test.ts docs/tmp/2026-08-06-github-enterprise-auth-host-progress-impl.md
git commit -m "refactor(proxy): resolve proxy policy per origin"
```

---

### Task 4: Token endpoint snapshot、authority persistence 与可取消 OAuth

**Files:**
- Modify: `packages/foundation/src/atomic-fs.ts`
- Modify: `tests/infra/atomic-fs.unit.test.ts`
- Modify: `packages/token/package.json`
- Modify: `bun.lock`
- Modify: `packages/token/src/dependencies.ts`
- Modify: `packages/token/src/ghc-auth-http.ts`
- Modify: `packages/token/src/github-client.ts`
- Modify: `packages/token/src/copilot-client.ts`
- Modify: `packages/token/src/providers/file.ts`
- Modify: `packages/token/src/providers/device-auth.ts`
- Modify: `packages/token/src/github-token-manager.ts`
- Modify: `packages/token/src/runtime.ts`
- Modify: `packages/token/src/index.ts`
- Modify: `src/lib/token-runtime.ts`
- Modify: `src/routes/status/route.ts`
- Create: `tests/token/github-oauth-device.it.test.ts`
- Create: `tests/token/github-token-authority.it.test.ts`
- Modify: `tests/infra/copilot-client.it.test.ts`
- Modify: `tests/helpers/install-token-deps.ts`

**Interfaces:**
- Consumes: Task 1 `GitHubEndpointSnapshot`、Task 3 proxy-capable `TokenFetch`。
- Produces:

```ts
export interface TokenRuntimeDependencies {
  readonly fetch: TokenFetch
  readonly endpoints: GitHubEndpointSnapshot
  readonly runtimeConfig: TokenRuntimeConfigView
}

export function getActiveGitHubEndpointSnapshot(): GitHubEndpointSnapshot | null

export type GitHubTokenProviderKind = "cli" | "env" | "file" | "device-auth"

export interface GitHubTokenManagerOptions {
  readonly cliToken?: string
  readonly providers?: ReadonlyArray<GitHubTokenProviderKind>
  readonly signal?: AbortSignal
  // existing callbacks preserved
}
```

- [ ] **Step 1: 查询并加入最新稳定依赖**

Run:

```bash
npm view @octokit/oauth-methods version
npm view @octokit/request version
```

Expected at planning time: `6.0.3` and `10.0.13`；实施时若 latest stable 已变，使用当天 latest compatible 版本并记录探针结果。运行 `bun --cwd packages/token add @octokit/oauth-methods@<实测版本> @octokit/request@<实测版本>` 更新 workspace manifest/根 `bun.lock`，不手改 lock；安装后用 `git diff -- packages/token/package.json bun.lock` 确认只改变目标依赖。

- [ ] **Step 2: 写 token client URL 与 persistence 失败测试**

测试 public snapshot 与 GHE snapshot 下五条最终 URL；GHES API base `/api/v3` 保留。测试公共 path、两个 authority digest 分离、API/Copilot override 不改变 path、企业缺 file 不回退公共。

- [ ] **Step 3: 运行测试确认硬编码 URL 和单 path 导致红**

Run: `bun test tests/infra/copilot-client.it.test.ts tests/token/github-token-authority.it.test.ts`

Expected: FAIL，当前 URL 固定公共 GitHub且 `githubTokenPath` 唯一。

- [ ] **Step 4: 注入 immutable snapshot 并改写 clients**

删除 `GITHUB_BASE_URL`/`GITHUB_API_BASE_URL` 的 URL 职责，只保留 client ID/header constants。`github-client` 和 `copilot-client` 从 `getTokenDeps().endpoints` 取 base URL，并调用 `appendEndpointPath()`。

- [ ] **Step 5: 实现原子 authority file provider**

先扩展 foundation 原语：

```ts
export interface AtomicWriteTextOptions { readonly mode?: number }
export async function atomicWriteText(targetPath: string, content: string, options?: AtomicWriteTextOptions): Promise<void>
```

`mode` 传给 temp-file `fs.writeFile`，并在 rename 前 `chmod(tmpPath, mode)`；既有无 options 调用行为不变。`tests/infra/atomic-fs.unit.test.ts` 断言目标在首次可见时即为 `0600`，写失败清 temp，旧内容保持。

`FileTokenProvider` 用 `deps.endpoints.githubTokenPath`。保存时 `mkdir(dirname, {recursive:true, mode:0o700})`，调用 `atomicWriteText(path, token, { mode: 0o600 })`；不得 rename 后才 chmod。缺失和空文件都 unavailable。`clearToken()` 改为 unlink current path，ENOENT 幂等，不写空文件。

- [ ] **Step 6: 用 low-level OAuth methods 实现可取消轮询**

`DeviceAuthProvider` 用 `createDeviceCode`/`exchangeDeviceCode`。自定义 Octokit request 的 fetch adapter 把 headers/body/signal 转成 `TokenFetchInit`。用 `abortableDelay()` 驱动 pending/slow_down；slow_down 后 interval += 7。绝对 deadline 来自 `expires_in`，与 caller signal、15 秒 request timeout 合并。verification callback 接 signal。所有路径 finally 清 deadline timer。

移除当前 `getToken()` 的 catch-all→`null`：定义 `GitHubDeviceAuthError`，`kind` 为 `"deadline" | "cancelled" | "denied" | "expired" | "network" | "protocol" | "persistence"`，保留 `cause` 和 OAuth error code。Provider 仅把 `authorization_pending`/`slow_down` 作为内部控制流；其它错误原样分类后抛给 runtime/CLI。日志在命令边界输出一次，provider 不重复吞错/打多份日志。

- [ ] **Step 7: 写 fake-clock cancellation tests**

分别停在 verification callback、pending delay、slow_down delay、在途 fetch；每条断言 promise settle、后续请求 0、timer 0。受控响应先 `authorization_pending`、再 `slow_down`、再成功，断言 5→12 秒和最终 token。另为 deadline、caller cancel、access_denied、expired_token、fetch/network、未知 OAuth error、原子写失败逐项断言 `GitHubDeviceAuthError.kind` 与 cause；测试 provider 不吞错，CLI 只记录一次。

- [ ] **Step 8: provider policy 参数化**

`GitHubTokenManager` 只构造 `options.providers` 允许的 provider，默认保持现有全 provider 顺序，避免公共 start 行为回归。禁止 `forceDeviceAuth()` 在未启用 device provider 的 manager 上静默继续。

- [ ] **Step 9: 暴露当前生效 endpoint snapshot**

Token runtime 安装时冻结 snapshot；`getActiveGitHubEndpointSnapshot()` 返回该不可变对象，runtime dispose/reset 时清空。`GET /api/status` 的 `auth.github` 返回 authority、webBaseUrl、apiBaseUrl、copilotBaseUrlOverride、githubTokenPath；不得从当前磁盘 config 重算。测试 PUT 改 endpoint 后声明值变化、`pendingRestart=true`，但 `auth.github` 仍为旧运行 snapshot。

- [ ] **Step 10: mutation controls**

- 把 enterprise token path改回公共 path，authority isolation test 必须红。
- 把 OAuth delay 改成裸 `setTimeout`，cancellation timer test 必须红。
- 把 slow_down 当 pending 不增加 7 秒，cadence test 必须红。

恢复后相关测试 PASS。

- [ ] **Step 11: 回归并提交**

Run:

```bash
bun test tests/token/github-oauth-device.it.test.ts tests/token/github-token-authority.it.test.ts tests/infra/copilot-client.it.test.ts tests/token/copilot-token-manager-dispose.it.test.ts tests/token/credential-store-isolation.it.test.ts
bun run typecheck
```

Commit:

```bash
git add -- packages/foundation/src/atomic-fs.ts tests/infra/atomic-fs.unit.test.ts packages/token/package.json bun.lock packages/token/src/dependencies.ts packages/token/src/ghc-auth-http.ts packages/token/src/github-client.ts packages/token/src/copilot-client.ts packages/token/src/providers/file.ts packages/token/src/providers/device-auth.ts packages/token/src/github-token-manager.ts packages/token/src/runtime.ts packages/token/src/index.ts src/lib/token-runtime.ts src/routes/status/route.ts tests/token/github-oauth-device.it.test.ts tests/token/github-token-authority.it.test.ts tests/infra/copilot-client.it.test.ts tests/token/copilot-token-manager-dispose.it.test.ts tests/token/credential-store-isolation.it.test.ts tests/helpers/install-token-deps.ts docs/tmp/2026-08-06-github-enterprise-auth-host-progress-impl.md
git commit -m "feat(auth): support authority-scoped GitHub OAuth"
```

---

### Task 5: 统一 CLI bootstrap 与 debug/provider 负向入口

**Files:**
- Create: `packages/cli/src/token-bootstrap.ts`
- Create: `tests/cli/token-bootstrap.it.test.ts`
- Modify: `packages/cli/src/auth.ts`
- Modify: `packages/cli/src/logout.ts`
- Modify: `packages/cli/src/debug.ts`
- Modify: `packages/cli/src/start.ts`
- Modify: `packages/cli/src/setup-codex.ts`
- Modify: `packages/cli/src/setup-claude-code.ts`
- Modify: `src/lib/token-runtime.ts`

**Interfaces:**

```ts
// setup/debug modules additionally export testable runners; citty commands only map args.
export interface RunDebugModelsOptions { readonly accountType: "individual" | "business" | "enterprise"; readonly githubToken?: string }
export interface RunDebugUsageOptions { readonly json: boolean; readonly githubToken?: string }
export async function runDebugModels(options: RunDebugModelsOptions): Promise<void>
export async function runDebugUsage(options: RunDebugUsageOptions): Promise<void>
export async function runSetupCodex(options: SetupCodexOptions): Promise<void>
export async function runSetupClaudeCode(options: SetupClaudeCodeOptions): Promise<void>

export type TokenCommandPolicy =
  | { kind: "login"; providers: ["device-auth"] }
  | { kind: "interactive"; providers: ["cli", "env", "file", "device-auth"] }
  | { kind: "debug-info"; providers: [] }
  | { kind: "debug-network"; providers: ["cli", "env", "file"] }
  | { kind: "logout"; providers: [] }

export interface BootstrapTokenCommandOptions {
  readonly policy: TokenCommandPolicy
  readonly cliToken?: string
  readonly ghcApiBaseUrl?: string
  readonly cliProxyUrl?: string
  readonly httpProxyFromEnv: boolean
}

export interface BootstrappedTokenCommand {
  readonly config: Config
  readonly endpoints: GitHubEndpointSnapshot
  readonly runtime: TokenRuntime | null
}

export async function bootstrapTokenCommand(options: BootstrapTokenCommandOptions): Promise<BootstrappedTokenCommand>
```

- [ ] **Step 1: 写真实 CLI runner 入口矩阵测试**

测试不得只调用 `bootstrapTokenCommand()`。通过依赖注入 seam 分别驱动真实导出 `runAuth`、`runLogout`、`runDebug`（仅 info）、`runDebugModels`、`runDebugUsage`、`runServer`、`runSetupCodex`、`runSetupClaudeCode`；对每个 runner 记录它传给共享 bootstrap 的 policy/CLI overrides，并断言最终 effective config、endpoint snapshot、token path、proxy policy。Expected 写死，不调生产 resolver 生成。`runServer` 使用 boot dependency seam 在 bootstrap 后立即停止，不监听端口、不初始化 History；setup runners 使用 dry-run/依赖 seam，不写真实客户端配置。

增加 source guard：6 个物理 CLI 文件（auth/logout/debug/start/setup-codex/setup-claude-code）不得直接引用 `ensurePaths`、`applyConfigToState`、`initProxy`、`installDefaultTokenRuntime` 或 `getProxyForUrl`；这些符号只允许出现在 `token-bootstrap.ts`。该 guard 与 8 个真实 runner 测试共同证明不是“新 primitive 自己绿、真实入口仍走旧线”。

- [ ] **Step 2: 写 debug 无 token 负向测试**

- `runDebug()`（info）：成功，`tokenExists=false`，manager construct/device/network/write 全 0。
- `runDebugModels()` 与 `runDebugUsage()`：确定性非零失败并提示 `copilot-api login`，device/OAuth/network/write 全 0。
- 两个 network runner 各自覆盖 CLI/env/current-authority file 三个成功来源（共 6 个正样本），证明 policy 接线不是只在其中一条命令生效。
- `runAuth()`、`runServer()`、两个 setup runner 无 token 仍调用 device provider。

- [ ] **Step 3: 运行测试确认重复 bootstrap 与 device fallback 造成红**

Run: `bun test tests/cli/token-bootstrap.it.test.ts`

Expected: FAIL；当前 debug models/usage 会安装包含 DeviceAuthProvider 的 manager，debug info 也可能走 network manager。

- [ ] **Step 4: 实现共享 bootstrap**

严格顺序：ensure app dir → load/prepare/commit config → resolve snapshot → init proxy policy → 按 policy 安装 runtime。`debug-info` 和 `logout` 返回 `runtime:null`。Bootstrap 只装配，不执行命令自己的业务请求。

- [ ] **Step 5: 迁移所有 CLI 入口**

删除各文件重复的 `ensurePaths/applyConfigToState/initProxy/installDefaultTokenRuntime`。把 `debug models` 与 `debug usage` 的内联 citty callbacks 分别抽成 `runDebugModels()`、`runDebugUsage()`，command wrapper 只映射 args。把 setup 两条命令同样抽出/导出 runners。Start 的 observability spool 若必须早于 config，改用只创建 app/log 目录的 `ensureAppDirectory()`，不得因此预创建 token。

- [ ] **Step 6: 明确 logout 与 debug 行为**

Logout 从 snapshot 取 path，unlink 当前 authority。Debug info stat snapshot path，不查 account network。Debug models/usage 调 noninteractive manager；捕获“No valid GitHub token”并转换成稳定错误/退出码，不调用 `process.exit` 以便测试，命令边界再设置 exit code。

- [ ] **Step 7: 运行 composition-seam 与 provider mutations**

1. 让一个真实 runner 完全绕过 bootstrap；runner spy/source guard 必须红。
2. 只让 `setup-codex` 或 `debug usage` 保留旧装配；单入口矩阵必须红，证明不是仅测 shared primitive。
3. 在 `start.ts` 恢复单 Copilot-origin `getProxyForUrl` 预采样；source guard + Task 3 三-origin oracle 必须红。
4. Debug info 构造 runtime：零 manager断言红。
5. Debug models/usage providers 加 device-auth：零 OAuth断言红。
6. Login/start providers 删除 device-auth：交互正样本红。

逐项确认失败来自目标 seam 后恢复，重跑为 PASS。

- [ ] **Step 8: 回归并提交**

Run:

```bash
bun test tests/cli/token-bootstrap.it.test.ts tests/config/config-strict-parse.unit.test.ts tests/restart/runserver-wiring.unit.test.ts tests/architecture/telemetry-startup-order.unit.test.ts
bun run typecheck
```

Commit:

```bash
git add -- packages/cli/src/token-bootstrap.ts packages/cli/src/auth.ts packages/cli/src/logout.ts packages/cli/src/debug.ts packages/cli/src/start.ts packages/cli/src/setup-codex.ts packages/cli/src/setup-claude-code.ts src/lib/token-runtime.ts tests/cli/token-bootstrap.it.test.ts tests/config/config-strict-parse.unit.test.ts tests/restart/runserver-wiring.unit.test.ts tests/architecture/telemetry-startup-order.unit.test.ts docs/tmp/2026-08-06-github-enterprise-auth-host-progress-impl.md
git commit -m "refactor(cli): share token command bootstrap"
```

---

### Task 6: 合并态验收、配置文档与 live evidence

**Files:**
- Modify: `README.md`
- Modify: `docs/authentication.md`
- Modify: `docs/DESIGN.md`
- Modify: `docs/API.md`
- Modify: `docs/spec/2026-08-05-github-enterprise-auth-host.md`（状态和实施 commit）
- Modify: `exp/github-enterprise-auth-host/README.md`（实施后的复跑结果）
- Modify: `tests/config/config-schema-json-export.unit.test.ts`
- Modify: `tests/architecture/package-boundaries.unit.test.ts`（若新模块边界需要登记）

**Interfaces:**
- Consumes: Tasks 1–5 的完整实现。
- Produces: 用户文档、架构现状、最终验收记录与可复跑 live probe。

- [ ] **Step 1: 跑 endpoint/config/token/CLI/proxy 聚合测试**

Run:

```bash
bun test tests/config/github-endpoints.unit.test.ts tests/config/config-application-transaction.it.test.ts tests/token/github-oauth-device.it.test.ts tests/token/github-token-authority.it.test.ts tests/cli/token-bootstrap.it.test.ts tests/infra/proxy.unit.test.ts tests/config/config-yaml-routes.http.test.ts
```

Expected: PASS。

- [ ] **Step 2: 运行 architecture 与 generated-schema 门禁**

Run:

```bash
before=$(sha256sum config.schema.json | cut -d' ' -f1)
bun run generate:config-schema
after=$(sha256sum config.schema.json | cut -d' ' -f1)
test "$before" = "$after"
bun test tests/architecture/package-boundaries.unit.test.ts tests/config/config-schema-json-export.unit.test.ts tests/infra/test-discovery-matrix.unit.test.ts
```

Expected: Task 1 已提交生成结果，因此重新生成前后 SHA-256 相等，所有 guard PASS。若 hash 不等，先审查/提交 schema drift，不得用 `git checkout` 覆盖。

- [ ] **Step 3: 运行完整后端门禁**

Run:

```bash
bun run typecheck
bun run lint:all
bun run test:backend
bun run build:backend
```

Expected: 全部 exit 0；若 history-search native 缺失，按项目约定只出现显式 skip，不得作为既有失败忽略。

- [ ] **Step 4: 重跑匿名与跨-authority evidence**

Run:

```bash
node exp/github-enterprise-auth-host/probe-anonymous.mjs
USE_COPILOT_API_TOKEN_FILE=1 node exp/github-enterprise-auth-host/probe-cross-authority-token.mjs
node exp/github-enterprise-auth-host/probe-octokit-adapter.mjs
bun exp/github-enterprise-auth-host/probe-octokit-adapter.mjs
```

Expected: 匿名状态仍为 `200/200/401/401/403`；公共正控 `200 + login` 后企业三 `401`；Node/Bun adapter calls 全落 Web origin且 `delays:[12]`。这些结果不等于有权企业成功链。

- [ ] **Step 5: 尝试有权 live chain，只按真实结果记录**

若执行账号仍无法访问 `msft.ghe.com/login/device`，记录“权限阻塞，未验证”，不让用户手工补测。若权限已具备，用隔离 APP_DIR 跑 `login`，再验证 `/user → token exchange → /models`；不写入主用户 token 文件，不输出 token。无论结果如何都更新实验 README 的日期、账号权限边界和实际状态。

- [ ] **Step 6: 同步用户和架构文档**

README 增配置示例和重启说明；authentication 写三端点、authority token path、provider policy；DESIGN 更新 token package/composition root/config transaction/proxy；API 记录 config GET/PUT 的 pending-invalid/pending-restart 可观测字段。Spec 状态改为“已实施”，写最终 commit。

- [ ] **Step 7: 跨文档残留扫描**

Run:

```bash
rg -n 'GITHUB_BASE_URL|GITHUB_API_BASE_URL|固定.*github\.com|githubTokenPath|ghc_api_base_url' docs README.md packages/token/src src/lib packages/cli/src tests
rg -n '暂缓|暂未|未实现|TODO|reserved|无源' docs/spec/2026-08-05-github-enterprise-auth-host.md docs/authentication.md docs/DESIGN.md README.md
```

逐条 disposition；历史描述可保留但须标历史，活文档不得继续声称 endpoint 固定公共 GitHub。

- [ ] **Step 8: 合并态独立评审**

派独立 reviewer 双向检查：错误状态能否通过、正确公共/GHEC/GHES 状态能否通过；逐条复核 absolute claims 与命令证据。处理 findings 后用 `SendMessage` 恢复同一 reviewer 复评，直到无 blocker/major。

- [ ] **Step 9: 提交最终实现文档与验收**

```bash
git add -- README.md docs/authentication.md docs/DESIGN.md docs/API.md docs/spec/2026-08-05-github-enterprise-auth-host.md exp/github-enterprise-auth-host/README.md config.schema.json tests/config/config-schema-json-export.unit.test.ts tests/architecture/package-boundaries.unit.test.ts docs/tmp/2026-08-06-github-enterprise-auth-host-progress-impl.md
git commit -m "docs: document GitHub Enterprise authentication"
```

---

## Property → Acceptance 对账

| Property | Acceptance | Mutation control |
|---|---|---|
| GHEC 四种输入同源派生 | Task 1 equivalent table | 删除 `api.`/`copilot-api.` 归一化之一，目标样本红 |
| Raw URL 不被 parser 洗形 | Task 1 C0/backslash/dot-segment negatives | 删除 pre-parser guard，反斜杠/TAB 样本红 |
| GHES base path 保留 | Task 1 append test | 改成 `new URL("/user", base)`，`/api/v3` 样本红 |
| Config prepare 失败零副作用 | Task 2 state/cache/listener/diagnostic snapshot | 提前 publish cache、延后 generation check或 prepare 内直接 warning，测试红 |
| Config 入口不提交 stale plan | Task 2 queue + disk-generation barrier test | 绕过 queue/CAS，让旧 reload 在 PUT 后 commit，测试红 |
| Listener 不见半状态 | Task 2 before/after listener probe | 第一个 setter 后立即 notify，测试红 |
| Proxy 逐 origin 保持三来源 | Task 3 origin matrix | 恢复单 Copilot origin 预采样，Web/API 样本红 |
| Token 不跨 authority fallback | Task 4 path/file tests | enterprise path 改回 public，测试红 |
| OAuth 取消零遗留 timer | Task 4 fake-clock cases | abortable delay 改裸 timeout，timer test 红 |
| 每个真实 CLI runner 都走共享 bootstrap | Task 5 runner matrix + source guard | 整段绕过或只漏一个 setup/debug 入口，测试红 |
| Debug 不意外交互 | Task 5 no-token negatives | 加回 DeviceAuthProvider，OAuth/network count 红 |
| Login/start/setup 仍可交互 | Task 5 interactive positive | 全局删除 device provider，正样本红 |
| Evidence 不扩大 | Task 6 public positive control + explicit “未证明” | 移除 public `/user` control，probe test/审查红 |

## 实施顺序与 checkpoint

1. Task 1 建立纯 endpoint/config 语言。
2. Task 2 建立配置原子发布基座；这是第一个高风险 checkpoint，完成后做独立 code review。
3. Task 3 修 proxy 来源模型。
4. Task 4 落 token/OAuth/persistence；这是第二个高风险 checkpoint，完成后做独立 verifier。
5. Task 5 迁移全部 CLI 入口。
6. Task 6 做合并态验收、live evidence 与文档同步。

任务之间没有可安全并行的写入：Task 2 依赖 Task 1 schema，Task 4 依赖 Task 1 snapshot 和 Task 3 transport，Task 5 依赖 Tasks 2–4；实施者串行执行，reviewer 可在 checkpoint 后后台运行但不得与 mutation writer 共用 worktree。
