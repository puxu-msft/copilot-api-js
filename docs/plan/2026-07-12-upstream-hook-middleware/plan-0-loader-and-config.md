# Phase 0：loader 单例 + config section（地基）✅ 实施完成

> 依赖：无。产出：`UpstreamHook` 类型 + `getUpstreamHook()`/`loadUpstreamHook()`/`resetUpstreamHook()` + `hooks` config section 全套接线。所有后续 Phase 依赖本阶段。

**Interfaces produced（后续 Phase 依赖这些确切签名）**：

```ts
// src/lib/pipeline/hooks/types.ts
export interface UpstreamHook {
  onRequest?: (env: RequestEnvelope) => RequestEnvelope | undefined
  onExchange?: (wire: PreparedRequest, env: RequestEnvelope, next: () => Promise<UpstreamStream>) => Promise<UpstreamStream>
  rewriteUpstreamFrame?: (frame: UpstreamFrame, env: RequestEnvelope) => UpstreamFrame | undefined
}
export interface UpstreamHookState {
  hook: UpstreamHook            // 生效的 hook（空 hook = 全直通）
  module: string                // 加载的模块路径
  loadedAt: number              // Date.now()
  version: string               // String(loadedAt)，回执/GET 用
  exports: Array<string>        // ["onExchange", ...] 实际导出的挂载点名
  lastReloadError?: string
}
// src/lib/pipeline/hooks/loader.ts
export function getUpstreamHook(): UpstreamHook | undefined     // driver 读；undefined=未配置=直通
export function getUpstreamHookState(): UpstreamHookState | undefined  // GET /api/hooks 读
export async function loadUpstreamHook(modulePath: string): Promise<UpstreamHookState>  // 启动 + reload；失败抛
export function resetUpstreamHook(): void                       // 测试重置 → undefined
```

---

## Task 0.1：loader 单例 + data-URL 加载 + 形状校验

**Files:**
- Create: `src/lib/pipeline/hooks/types.ts`
- Create: `src/lib/pipeline/hooks/loader.ts`
- Test: `tests/pipeline/hooks/loader.unit.test.ts`

**Interfaces:**
- Consumes: `RequestEnvelope`（`~/lib/pipeline/envelope`）、`PreparedRequest`/`UpstreamStream`/`UpstreamFrame`（`~/lib/pipeline/types`）。
- Produces: 上方 Interfaces produced 全部。

**关键实现（data-URL 机制 — Global Constraints 固定）**：

```ts
// loader.ts
import { readFileSync } from "node:fs"
import consola from "consola"
import type { UpstreamHook, UpstreamHookState } from "./types"

let hookState: UpstreamHookState | undefined

export function getUpstreamHook(): UpstreamHook | undefined {
  return hookState?.hook
}
export function getUpstreamHookState(): UpstreamHookState | undefined {
  return hookState
}
export function resetUpstreamHook(): void {
  hookState = undefined
}

const HOOK_POINTS = ["onRequest", "onExchange", "rewriteUpstreamFrame"] as const

/** Load (or reload) the hook module via data-URL (bypasses Bun's path-keyed ESM cache). */
export async function loadUpstreamHook(modulePath: string): Promise<UpstreamHookState> {
  const src = readFileSync(modulePath, "utf8")
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(src)
  const mod = (await import("data:text/javascript," + encodeURIComponent(js))) as Record<string, unknown>
  const exports = HOOK_POINTS.filter((k) => typeof mod[k] === "function")
  if (exports.length === 0) {
    throw new Error(`hook module ${modulePath} exports none of: ${HOOK_POINTS.join(", ")}`)
  }
  const hook: UpstreamHook = {}
  for (const k of exports) (hook as Record<string, unknown>)[k] = mod[k]
  const loadedAt = Date.now()
  hookState = { hook, module: modulePath, loadedAt, version: String(loadedAt), exports: [...exports] }
  return hookState
}
```

> **注**：`Bun.Transpiler` + data-URL 在本仓库无先例（loader 首次引入）。相对 import（hook 文件里的 `~/lib/...`）在 data-URL 模块仍解析（spec §6.4 实测）。

- [ ] **Step 1：写失败测试** — 建 `tests/pipeline/hooks/fixtures/valid-hook.ts`（导出 `onExchange`）+ `no-exports.ts`（无挂载点），写：加载 valid → `exports` 含 `onExchange`、`getUpstreamHook()` 非 undefined；加载 no-exports → 抛含 "exports none of"；`resetUpstreamHook()` 后 `getUpstreamHook()` === undefined。
- [ ] **Step 2：跑测试确认失败**（`bun test tests/pipeline/hooks/loader.unit.test.ts` → FAIL 模块不存在）。
- [ ] **Step 3：写 types.ts + loader.ts**（上方代码）。
- [ ] **Step 4：跑测试确认通过**。
- [ ] **Step 5：data-URL 重载测试** — 写临时 fixture 文件、加载得 v1、改写文件、`loadUpstreamHook` 再加载得 v2（**回归 B1**：证 data-URL 真重载、非返回旧模块）。跑绿。
- [ ] **Step 6：commit**（`git commit -- src/lib/pipeline/hooks/types.ts src/lib/pipeline/hooks/loader.ts tests/pipeline/hooks/`）。

## Task 0.2：加载失败 warn-continue + 保留旧值

**Files:** Modify `src/lib/pipeline/hooks/loader.ts`；Test 同上文件追加。

新增 `loadUpstreamHookSafe(modulePath)`：包裹 `loadUpstreamHook`，**捕获异常** → `consola.warn` + 若已有 `hookState` 则更新 `hookState.lastReloadError`（保留旧 hook）+ 返回 `{ ok:false, error }`；成功清 `lastReloadError` 返回 `{ ok:true, state }`。启动期与 reload 都走 safe 变体。

```ts
export async function loadUpstreamHookSafe(modulePath: string): Promise<{ ok: true; state: UpstreamHookState } | { ok: false; error: string }> {
  try {
    const state = await loadUpstreamHook(modulePath)
    return { ok: true, state }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    consola.warn(`[hooks] failed to load ${modulePath}: ${error} — keeping previous hook`)
    if (hookState) hookState.lastReloadError = error
    return { ok: false, error }
  }
}
```

- [ ] **Step 1：写失败测试** — 先加载 valid（hookState 有值）→ 加载不存在路径经 safe → 返回 `{ok:false}`、`getUpstreamHook()` 仍是旧 valid hook、`getUpstreamHookState().lastReloadError` 有值、**不抛**。
- [ ] **Step 2：跑确认失败** → **Step 3：写 `loadUpstreamHookSafe`** → **Step 4：跑绿** → **Step 5：commit**。

## Task 0.3：`hooks` config section — schema + 类型

**Files:** Modify `src/lib/config/schema.ts`；Test `tests/config/` 现有 schema 测试追加或新建。

在 schema.ts（照 `ResponsesConfigSchema` 行 603-624 模板）：

```ts
export const HooksConfigSchema = z
  .object({
    upstream_module: nullableString(),
    enabled: nullableBoolean(),
  })
  .strict()
export type HooksConfig = z.infer<typeof HooksConfigSchema>
```

顶层挂载（`ConfigSchema` 内，照行 794/817）：`hooks: nullableSection(HooksConfigSchema),`。

- [ ] **Step 1：写失败测试** — `HooksConfigSchema.parse({ upstream_module: "./x.ts", enabled: true })` 通过；`.parse({ unknown: 1 })` 因 `.strict()` 抛；`ConfigSchema.parse({ hooks: { enabled: false } })` 通过。
- [ ] **Step 2-4：跑失败 → 写 schema → 跑绿**。
- [ ] **Step 5：commit**。

## Task 0.4：state 字段 5 处接线 + setter

**Files:** Modify `src/lib/state.ts`（5 处）；Test `tests/config/` 追加。

按勘探 A.3 的 5 处编辑点（用 `setShutdownConfig` 行 1236 作最简 setter 模板）：

1. `MutableState` 声明（行 883 起 type 内）：`readonly hooksUpstreamModule: string` + `readonly hooksEnabled: boolean`。
2. `CONFIG_MANAGED_DEFAULTS`（行 1360 起）：`hooksUpstreamModule: ""` + `hooksEnabled: false`。
3. `mutableState` 初值（行 1615 起）：`hooksUpstreamModule: CONFIG_MANAGED_DEFAULTS.hooksUpstreamModule` + `hooksEnabled: CONFIG_MANAGED_DEFAULTS.hooksEnabled`。
4. `resetConfigManagedState`（行 1494 起）：加 `setHooksConfig({ hooksUpstreamModule: CONFIG_MANAGED_DEFAULTS.hooksUpstreamModule, hooksEnabled: CONFIG_MANAGED_DEFAULTS.hooksEnabled })`。
5. setter：
```ts
export function setHooksConfig(patch: Partial<Pick<MutableState, "hooksUpstreamModule" | "hooksEnabled">>): void {
  updateState(patch)
}
```

- [ ] **Step 1：写失败测试** — `state.hooksEnabled === false`（默认）；`setHooksConfig({ hooksEnabled: true })` 后 `state.hooksEnabled === true`；`resetConfigManagedState()` 后回 false。
- [ ] **Step 2-4：跑失败 → 5 处编辑 → 跑绿 + `bun run typecheck`**。
- [ ] **Step 5：commit**。

## Task 0.5：config→state apply + PUT 持久化 + bundled 注释 + completeness guard

**Files:** Modify `src/lib/config/config.ts`（apply）、`src/routes/config/route.ts:257`（mergeConfigIntoDocument）、`config.yaml`（注释）；Test `tests/config/config-effective-route.http.test.ts` 自动覆盖。

1. **config.ts apply**（`applyConfigToState` 行 488 内，照 history 块 682-695）——**只写声明态 state，不触发模块加载**（spec HIGH-2）：
```ts
if (config.hooks) {
  const hk = config.hooks
  if (hk.upstream_module !== undefined) setHooksConfig({ hooksUpstreamModule: hk.upstream_module })
  if (hk.enabled !== undefined) setHooksConfig({ hooksEnabled: hk.enabled })
}
```
2. **route.ts:257 mergeConfigIntoDocument**（评审 HIGH-1，照 A.4）：`if (hasOwn(body, "hooks")) setNestedScalarContainer(doc, ["hooks"], body.hooks)`。
3. **config.yaml** 注释块（照 openai_responses 双语格式，默认注释掉或 enabled:false）：
```yaml
hooks:
  # Path to an ad-hoc TS hook module for mocking/intercepting upstream. Dev/test only.
  # 指向一个 ad-hoc TS hook 模块，用于 mock/拦截上游。仅开发/测试环境。
  # upstream_module: "./exp/my-hook.ts"
  # Load the hook module. Default false — the feature is fully off unless true.
  # 是否加载 hook 模块。默认 false——除非 true 否则特性完全关闭。
  enabled: false
```
4. **completeness guard**（`tests/config/config-effective-route.http.test.ts:46`）：`hooksEnabled`/`hooksUpstreamModule` 进 `CONFIG_MANAGED_DEFAULTS` 后自动被要求出现在 `GET /api/config`——`buildEffectiveConfig` 自动 derive，跑一次确认绿即可。

- [ ] **Step 1：写失败测试** — 造含 `hooks: { enabled: true, upstream_module: "./x" }` 的 config 经 `applyConfigToState` → `state.hooksEnabled === true`；`mergeConfigIntoDocument` 对 `{hooks:{enabled:true}}` 写进 doc 不丢弃。
- [ ] **Step 2-4：跑失败 → 3 处编辑 + config.yaml → 跑绿**（含 completeness guard 测试）。
- [ ] **Step 5：commit**。

## Task 0.6：启动期加载接线

**Files:** Modify `src/start.ts`（`applyConfigToState` 之后、serve 之前的启动序列）；Test：集成留 Phase 5。

在启动序列（`start.ts` 的 `applyConfigToState()` 之后，找 config 已就绪的点，如行 303 附近）加：

```ts
if (state.hooksEnabled && state.hooksUpstreamModule) {
  await loadUpstreamHookSafe(state.hooksUpstreamModule)  // warn-continue on failure, never blocks startup
}
```

- [ ] **Step 1：typecheck 驱动** — 加 import + 上述块，`bun run typecheck` 绿（无独立单测，启动加载在 Phase 5 集成实测）。
- [ ] **Step 2：commit**。

**Phase 0 出口验收**：`bun test` 全绿 + `bun run typecheck` + `typecheck:ui-v4` 绿；`hooks` 未配置时零行为改变（`getUpstreamHook()` === undefined）。

## Task 0.7：`origin.ts` — hook 产物流标记原语（评审 HIGH-1 上移）

**Files:** Create `src/lib/pipeline/hooks/origin.ts`；Test `tests/pipeline/hooks/origin.unit.test.ts`。

从 Phase 2 上移到此（纯符号 + tag/read，无 driver 依赖），使 Phase 2（history 标记）与 Phase 3（helper）都只依赖 Phase 0、恢复 DAG 宣称的并行性。

```ts
// src/lib/pipeline/hooks/origin.ts
import type { UpstreamStream } from "~/lib/pipeline/types"
export const HOOK_ORIGIN = Symbol("hookOrigin")
export type HookOrigin = "hook-mock" | "hook-replay"
export function tagStream(s: UpstreamStream, origin: HookOrigin): UpstreamStream {
  return Object.assign(s, { [HOOK_ORIGIN]: origin })
}
export function readOrigin(s: UpstreamStream): HookOrigin | undefined {
  return (s as Record<symbol, unknown>)[HOOK_ORIGIN] as HookOrigin | undefined
}
```

- [ ] **Step 1：写失败测试** — `tagStream(s, "hook-mock")` 后 `readOrigin(s) === "hook-mock"`；未标记流 `readOrigin` === undefined。
- [ ] **Step 2-4：跑失败 → 写 origin.ts → 跑绿 + typecheck** → **Step 5：commit**。
