> **状态**：已实施（Task 1-4 全部落地，见文末「偏离与根因」——Task 3 主体机制在执行期发现并校正了一处设计缺口，已按新机制实现+测试+提交）。属于 `docs/plan/2026-07-14-transport-config-reorg/README.md` 定义的 P3 阶段——依赖 P1（`plan-1-config-reorg.md`，需已落地：`schema.ts` 的 `upstream_transport`/`server.responses_ws` 三段 Zod schema + 顶层挂载 + `compat.ts` 的 6 条新 `renameLeaf` 迁移规则），与 P2（`plan-2-new-knobs-wiring.md`）无文件交集，可并行执行。P3 完成后解锁 P4（热重载 reconcile）。

# P3 — PUT 文档级迁移：legacy 路径可追踪 + YAML 写回时真正清除旧键

## Goal

`config.yaml` 的 file-load 路径（`validateConfig`）早已把 legacy key 迁移到新路径并在**内存**里生效；但 HTTP `PUT /api/config/yaml` 路径（`validateConfigInput` → `mergeConfigIntoDocument`）只把迁移后的新值写回 YAML 文档，从未删除磁盘上残留的旧键——用户通过管理 UI 保存一次配置后，`config.yaml` 里会同时存在旧键（原样保留）和新键（新写入的），下次加载时旧键继续触发 deprecation 警告，永远"迁移不完"。

本阶段让迁移应用逻辑（compat.ts）显式追踪"这次迁移真正删除了哪些 legacy 顶层路径"，PUT handler 在写回新文档前先把这些路径从磁盘 YAML 里删除（并向上剪除因此变空的父节点），使一次 PUT 之后旧键彻底从文件消失、下次加载不再警告。

**范围边界**（与 P2/P4 解耦，见 README 依赖表）：
- 不改任何连接建立/使用逻辑（P2 职责）。
- 不改热重载 reconcile（P4 职责）。
- 不新增/不修改 `CONFIG_MIGRATIONS` 里的具体迁移规则（P1 已经把 6 条新规则加入该数组；本阶段的迁移应用器对规则内容一无所知，只是通用地遍历 `CONFIG_MIGRATIONS` 并追踪"删了哪些路径"——这是纯粹的机制升级，不是新增迁移规则）。
- 不改变 `validateConfig`（file-load 路径）对外可观察的迁移行为——它的返回值签名不变（仍是 `Config`），本阶段只是把它内部依赖的私有函数搬到 `compat.ts` 并增强。

## Architecture

迁移应用逻辑从 `validation.ts` 私有函数搬到 `compat.ts`（迁移规则的"单一归属地"，呼应模块头 JSDoc「Single home for every legacy→current config-key migration」），并增强为同时返回"被删除的 legacy 路径列表"：

```
raw payload
  │
  ▼
compat.ts: extractAndTranslateDeprecatedWithOps(raw)
  │   遍历 CONFIG_MIGRATIONS：定位→删除 legacy key→(若非 in-place 值迁移)记入 legacyPathsRemoved→按 translate() 合并新值
  ▼
{ value: 迁移后的 payload, legacyPathsRemoved: string[] }
  │
  ├─ validateConfig(file-load)：只取 .value 继续走 Zod parse（行为不变）
  │
  └─ validateConfigInput(PUT)：取 .value 走 Zod parse；成功时把 .legacyPathsRemoved
       原样带进 ConfigValidationResult，供 route.ts 使用
           │
           ▼
     routes/config/route.ts PUT handler：
       1. deleteLegacyPathsAndPruneEmptyParents(doc, validation.legacyPathsRemoved)  ← 新增，写在 mergeConfigIntoDocument 之前
       2. mergeConfigIntoDocument(doc, validation.value)  ← 既有，新增两行处理 upstream_transport/server
```

**关键设计取舍——为什么不需要 `{oldPath,newPath,migratedValue,deleteOnly}` 序列**：PUT handler 已经把迁移后的**完整新值**（`validation.value`）交给 `mergeConfigIntoDocument` 写入磁盘（写什么、写到哪，`mergeConfigIntoDocument` 按新 schema 结构处理，不需要单独告知"新路径在哪"）；`legacyPathsRemoved` 只需要回答一个更窄的问题——"磁盘上哪些旧路径必须被清掉，不能留着"。这也正确处理了 D5 的 `0→absence` 特例（legacy 值为 `0` 时 `transform` 返回 `undefined`，不产生新值，只删旧键——旧键仍需要从磁盘消失，让 schema 默认值接管）。

**为什么 `migrateValue`（同路径值一致化，如 `thinking_block_sanitize` 的 `"empty_thinking"→"all_empty"`）不能算进 `legacyPathsRemoved`**：这类迁移的"旧路径"和"新路径"是同一个 key（值变了，位置没变）。若把它也当作"legacy path"交给 YAML 层先 `deleteIn` 再由 `mergeConfigIntoDocument` 用 `setIn` 重新写入，会把该键从原来的文档位置删除后**追加到父 Map 末尾**，附带丢失原来挂在那一行上的注释——这是纯粹的负面副作用，且没有必要（`mergeConfigIntoDocument` 已经会用新值覆盖同一个 key，`setScalar`/`doc.setIn` 在**已存在的**路径上赋值不会重新定位或丢注释）。因此 `ConfigMigration` 新增一个内部（非导出契约）标记 `isInPlaceValueMigration`，由 `migrateValue()` builder 设置，迁移应用器据此跳过这类条目的 `legacyPathsRemoved.push`。这个字段不出现在 README「跨阶段共享接口清单」里，属于 compat.ts 模块内部实现细节，不影响任何跨阶段签名。

## Tech Stack

- 沿用既有 `yaml`（`^2.9.0`）库；新增用到 `isMap`（已实测验证：见下方 Task 3 的 oracle 依据）。
- 沿用 Zod（`zod@^4.4.3`）、`bun:test`。无新依赖引入。

## Global Constraints

- **零占位符**：每个 Step 给出完整可运行代码，不写"（实现细节省略）"。
- **TDD**：每个 Task 先写失败测试→跑确认失败→最小实现→跑确认通过→提交。
- **细粒度提交**：每个 Task 收尾一次提交，显式 pathspec，conventional commits，不加模型署名。
- **签名冻结**：`ConfigMigrationApplyResult` / `extractAndTranslateDeprecatedWithOps` / `ConfigValidationResult` 新增字段 `legacyPathsRemoved: ReadonlyArray<string>`，逐字对齐 README「P3 产出」——如实现中发现必须偏离，先回 README 更新，不在本文件私自改名。
- **不破坏 L1 guard**：`_resetConfigValidationWarnTrackingForTests` 的导出名字、导出文件（`validation.ts`）不变（已注册进 `tests/helpers/isolated-fixture.ts` 的 `RESETTERS` 表）。
- **真实测试命令**：`bun test <path>`、`bun run typecheck`、`bunx eslint <path>`（单文件无缓存）、`bun run lint:all`（全量收尾）。

## 文件总览

| 文件 | 改动 |
|---|---|
| `src/lib/config/compat.ts` | 新增 `ConfigMigrationApplyResult` 接口 + `extractAndTranslateDeprecatedWithOps()` 导出函数（迁移应用逻辑，从 `validation.ts` 搬入并增强）；新增导出 `navigate()`；新增私有 `deepMergeMissingOnly`/`deepCloneJsonSafe`；新增私有 `warnedDeprecatedKeys` + `warnDeprecatedKeyOnce` + 导出 `_resetDeprecatedKeyWarnTrackingForTests()`；`ConfigMigration` 接口新增可选字段 `isInPlaceValueMigration?: boolean`；`migrateValue()` builder 设置该字段为 `true`；模块头 JSDoc 更新（不再说"consumed by validation.ts's extractAndTranslateDeprecated()"，改为"owns the migration application logic itself"） |
| `src/lib/config/validation.ts` | 删除私有 `extractAndTranslateDeprecated`/`deepMergeMissingOnly`/`navigate`/`deepCloneJsonSafe`（迁移到 compat.ts，`navigate` 改为从 `./compat` 导入）；`ConfigValidationResult` 的 `valid:true` 分支新增 `legacyPathsRemoved: ReadonlyArray<string>`；`validateConfig`/`validateConfigInput` 改用 `extractAndTranslateDeprecatedWithOps`；`_resetConfigValidationWarnTrackingForTests` 内部新增调用 `_resetDeprecatedKeyWarnTrackingForTests()` |
| `src/routes/config/route.ts` | `mergeConfigIntoDocument` 新增 `upstream_transport`/`server` 两行（复用既有 `setNestedScalarContainer`）；新增私有 `deleteLegacyPathsAndPruneEmptyParents(doc, legacyPaths)`；PUT handler 在 `mergeConfigIntoDocument` 调用前插入这一步；新增 import `isMap`；`setNestedScalarContainer`（既有函数）升级为对嵌套子对象递归深合并 + 任意深度 `null` 删除，签名不变（B9，Task 3 附加范围） |
| `tests/config/config-compat.unit.test.ts` | 新增对 `extractAndTranslateDeprecatedWithOps` 的直接单测（legacyPathsRemoved 内容 + in-place 值迁移不进入该列表） |
| `tests/config/config-yaml-routes.http.test.ts` | 新增 PUT 场景：legacy 路径写回后从磁盘消失 + 父节点剪除 + 兄弟字段保留 + in-place 值迁移不触发误删；新增 `upstream_transport.http2`/`anthropic.buffered_retry` 递归深合并 + 任意深度 `null` 删除场景（B9） |

---

## Task 1 — compat.ts：新增 `extractAndTranslateDeprecatedWithOps` 迁移应用器

- **Files**：
  - Modify：`/home/xp/src/copilot-api-js/src/lib/config/compat.ts`
  - Test：`/home/xp/src/copilot-api-js/tests/config/config-compat.unit.test.ts`
- **Interfaces**（新增，逐字对齐 README）：
  ```ts
  export interface ConfigMigrationApplyResult {
    value: Record<string, unknown>
    legacyPathsRemoved: ReadonlyArray<string>
  }
  export function extractAndTranslateDeprecatedWithOps(raw: Record<string, unknown>): ConfigMigrationApplyResult
  export function navigate(obj: unknown, path: ReadonlyArray<PropertyKey>): unknown
  export function _resetDeprecatedKeyWarnTrackingForTests(): void
  ```
  `ConfigMigration` 接口新增可选字段（内部实现细节，非跨阶段契约）：
  ```ts
  isInPlaceValueMigration?: boolean
  ```

### Steps

1. **写失败测试**——在 `tests/config/config-compat.unit.test.ts` 追加新 `describe` 块，直接导入 `extractAndTranslateDeprecatedWithOps`（此刻从 `~/lib/config/compat` 导入会因函数不存在而编译失败/运行失败）：

   ```ts
   import { extractAndTranslateDeprecatedWithOps } from "~/lib/config/compat"
   ```

   在文件末尾追加：

   ```ts
   describe("config compat — extractAndTranslateDeprecatedWithOps (legacyPathsRemoved tracking)", () => {
     test("renameLeaf migration reports the legacy dot-path in legacyPathsRemoved", () => {
       const { value, legacyPathsRemoved } = extractAndTranslateDeprecatedWithOps({ fetch_timeout: 200 })
       expect((value.timeouts as Record<string, unknown> | undefined)?.response_header).toBe(200)
       expect(legacyPathsRemoved).toContain("fetch_timeout")
     })

     test("removeKey migration (pure removal, no replacement) reports the legacy path too", () => {
       const { legacyPathsRemoved } = extractAndTranslateDeprecatedWithOps({ history: { min_entries: 5 } })
       expect(legacyPathsRemoved).toContain("history.min_entries")
     })

     test("renameSection migration reports the legacy section path", () => {
       const { value, legacyPathsRemoved } = extractAndTranslateDeprecatedWithOps({ "openai-responses": { upstream_websocket: true } })
       expect((value.openai_responses as Record<string, unknown> | undefined)?.upstream_ws).toBe(true)
       expect(legacyPathsRemoved).toContain("openai-responses")
     })

     test("migrateValue (in-place value consolidation, SAME key) does NOT report a legacy path", () => {
       const { value, legacyPathsRemoved } = extractAndTranslateDeprecatedWithOps({ anthropic: { thinking_block_sanitize: "empty_thinking" } })
       expect((value.anthropic as Record<string, unknown> | undefined)?.thinking_block_sanitize).toBe("all_empty")
       // The key never relocates — deleting it from the on-disk YAML would only
       // drop the user's comment/position for no reason (see plan-3 §Architecture).
       expect(legacyPathsRemoved).not.toContain("anthropic.thinking_block_sanitize")
     })

     test("already-valid migrateValue-gated value passes through with no legacyPathsRemoved entry", () => {
       const { legacyPathsRemoved } = extractAndTranslateDeprecatedWithOps({ anthropic: { thinking_block_sanitize: "all_empty" } })
       expect(legacyPathsRemoved).toEqual([])
     })

     test("legacy value of 0 on a transform-gated renameLeaf (0→absence) still reports the legacy path, even though no new value is written", () => {
       const { value, legacyPathsRemoved } = extractAndTranslateDeprecatedWithOps({ timeouts: { upstream_keepalive: 0 } })
       expect((value.upstream_transport as Record<string, unknown> | undefined)?.tcp_keepalive_probe_delay).toBeUndefined()
       expect(legacyPathsRemoved).toContain("timeouts.upstream_keepalive")
     })

     test("no legacy keys present → empty legacyPathsRemoved, value unchanged (deep-cloned)", () => {
       const input = { proxy: "http://x" }
       const { value, legacyPathsRemoved } = extractAndTranslateDeprecatedWithOps(input)
       expect(legacyPathsRemoved).toEqual([])
       expect(value).toEqual(input)
       expect(value).not.toBe(input)
     })
   })
   ```

   跑：
   ```
   bun test tests/config/config-compat.unit.test.ts
   ```
   确认新增的 7 个用例全部失败（`extractAndTranslateDeprecatedWithOps` 不存在，import 报错导致整个文件测试失败）。

2. **最小实现**——编辑 `compat.ts`：

   在文件顶部（第 17 行 `export interface ConfigMigration {` 之前）新增 import：
   ```ts
   import consola from "consola"
   ```

   在 `ConfigMigration` 接口内（紧接 `isLegacyValue?` 字段之后）新增：
   ```ts
     /**
      * When true, this migration's `translate()` writes the new value back to
      * the SAME dot-path as `path` (in-place value consolidation — see
      * `migrateValue`). Such migrations must NOT be reported in
      * `extractAndTranslateDeprecatedWithOps`'s `legacyPathsRemoved`: deleting
      * then recreating the SAME YAML key would drop its position/comment for
      * no reason, since `mergeConfigIntoDocument` already overwrites it in
      * place. Relocations (`renameLeaf`/`renameSection`) and pure removals
      * (`removeKey`) leave this undefined and ARE reported.
      */
     isInPlaceValueMigration?: boolean
   ```

   在 `migrateValue()` builder 的返回对象里新增该字段：
   ```ts
   export function migrateValue(oldPath: string, isLegacy: (value: unknown) => boolean, newValue: unknown, message: string): ConfigMigration {
     const located = splitLegacyPath(oldPath)
     const parts = oldPath.split(".")
     return {
       ...located,
       message,
       isLegacyValue: isLegacy,
       isInPlaceValueMigration: true,
       translate: () => buildNested(parts, newValue),
     }
   }
   ```

   在文件末尾（`CONFIG_MIGRATIONS` 数组之后）追加迁移应用逻辑：
   ```ts
   // ============================================================================
   // Migration applier — walks CONFIG_MIGRATIONS top-down against a raw
   // payload, deleting/translating/warning as each rule's locator matches, and
   // tracking which legacy dot-paths were actually removed (so PUT-time YAML
   // rewrite can delete them from the on-disk document too — see
   // routes/config/route.ts's deleteLegacyPathsAndPruneEmptyParents).
   // ============================================================================

   const warnedDeprecatedKeys = new Set<string>()

   function warnDeprecatedKeyOnce(key: string, message: string): void {
     if (warnedDeprecatedKeys.has(key)) return
     warnedDeprecatedKeys.add(key)
     consola.warn(`[Config] ${message}`)
   }

   /** Test-only reset for the warn-once tracking above (registered in tests/helpers/isolated-fixture.ts via validation.ts's _resetConfigValidationWarnTrackingForTests). */
   export function _resetDeprecatedKeyWarnTrackingForTests(): void {
     warnedDeprecatedKeys.clear()
   }

   /**
    * Walk a dot-path through nested plain objects. Returns `undefined` if any
    * segment is missing or the value along the way is not an object.
    *
    * Shared by the migration applier below AND validation.ts's Zod-issue path
    * lookups (`cleanInvalidPaths`/`zodIssueToDetails`) — those two call sites
    * are unrelated to migration, just reuse the same "walk a dot-path" primitive.
    */
   export function navigate(obj: unknown, path: ReadonlyArray<PropertyKey>): unknown {
     let current: unknown = obj
     for (const segment of path) {
       if (!current || typeof current !== "object") return undefined
       current = (current as Record<PropertyKey, unknown>)[segment]
     }
     return current
   }

   function deepCloneJsonSafe<T>(value: T): T {
     return structuredClone(value)
   }

   /** Deep-merge `patch` into `target` ONLY for keys not already present (user-set value wins) */
   function deepMergeMissingOnly(target: Record<string, unknown>, patch: Record<string, unknown>): void {
     for (const [key, value] of Object.entries(patch)) {
       const existing = target[key]
       if (value && typeof value === "object" && !Array.isArray(value)) {
         if (existing && typeof existing === "object" && !Array.isArray(existing)) {
           deepMergeMissingOnly(existing as Record<string, unknown>, value as Record<string, unknown>)
         } else if (existing === undefined) {
           target[key] = deepCloneJsonSafe(value)
         }
         // else: user already provided a primitive at this path; do not override.
       } else if (existing === undefined) {
         target[key] = value
       }
     }
   }

   export interface ConfigMigrationApplyResult {
     value: Record<string, unknown>
     legacyPathsRemoved: ReadonlyArray<string>
   }

   /**
    * Apply every CONFIG_MIGRATIONS rule to `raw`, returning the migrated
    * payload plus the list of legacy dot-paths that were actually present and
    * removed (declaration order; a path appears at most once). `renameLeaf`/
    * `renameSection`/`removeKey` migrations are reported; `migrateValue`
    * in-place value consolidations (`isInPlaceValueMigration: true`) are not
    * (see the field's doc comment on `ConfigMigration`).
    *
    * Consumed by BOTH validation paths: file load's `validateConfig` (only
    * uses `.value`, unchanged behavior) and HTTP PUT's `validateConfigInput`
    * (also threads `.legacyPathsRemoved` through `ConfigValidationResult` to
    * `routes/config/route.ts`, which deletes those paths from the on-disk
    * YAML document before writing the migrated value back).
    */
   export function extractAndTranslateDeprecatedWithOps(raw: Record<string, unknown>): ConfigMigrationApplyResult {
     const out: Record<string, unknown> = deepCloneJsonSafe(raw)
     const legacyPathsRemoved: Array<string> = []

     for (const dep of CONFIG_MIGRATIONS) {
       const parent = dep.parentPath === "" ? out : navigate(out, dep.parentPath.split("."))
       if (!parent || typeof parent !== "object") continue
       const parentObj = parent as Record<string, unknown>
       if (!(dep.key in parentObj)) continue

       const legacyValue = parentObj[dep.key]
       // Value-gated migrations (migrateValue) fire only for legacy values; an
       // already-valid value must pass through WITHOUT delete or warn.
       if (dep.isLegacyValue && !dep.isLegacyValue(legacyValue)) continue
       // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- key comes from CONFIG_MIGRATIONS
       delete parentObj[dep.key]
       warnDeprecatedKeyOnce(dep.path, dep.message)
       if (!dep.isInPlaceValueMigration) legacyPathsRemoved.push(dep.path)

       if (!dep.translate) continue
       const patch = dep.translate(legacyValue)
       if (!patch) continue
       deepMergeMissingOnly(out, patch)
     }

     return { value: out, legacyPathsRemoved }
   }
   ```

   更新模块头 JSDoc（第 9-11 行），把：
   ```
    * Consumed by `validation.ts`' `extractAndTranslateDeprecated()` on BOTH paths:
    *   - file load (`validateConfig`)        — graceful migrate + warn
    *   - HTTP PUT (`validateConfigInput`)    — normalize old-key bodies before parse
   ```
   改为：
   ```
    * Owns the migration-application logic itself (`extractAndTranslateDeprecatedWithOps`),
    * consumed on BOTH validation paths:
    *   - file load (`validateConfig`)        — graceful migrate + warn
    *   - HTTP PUT (`validateConfigInput`)    — normalize old-key bodies before parse,
    *                                            also threads `legacyPathsRemoved` through
    *                                            to routes/config/route.ts for on-disk cleanup
   ```

3. 跑：
   ```
   bun test tests/config/config-compat.unit.test.ts
   ```
   确认新增 7 个用例全部通过，既有用例（对 `validateConfig`/`validateConfigInput` 的既有覆盖）此刻仍然通过（它们目前调用的是 `validation.ts` 里还未改动的旧 `extractAndTranslateDeprecated`，Task 1 完全不触碰 `validation.ts`，所以不受影响）。

4. 跑 `bun run typecheck` 确认无类型错误（`CONFIG_MIGRATIONS` 数组里的字面量对象在结构上仍满足 `ConfigMigration`，新增的可选字段不会破坏既有条目）。

5. 跑 `bunx eslint src/lib/config/compat.ts tests/config/config-compat.unit.test.ts`（无缓存单文件检查）确认无新增 lint 违规。

6. 提交：
   ```
   git add -- src/lib/config/compat.ts tests/config/config-compat.unit.test.ts
   git commit -F <msgfile> -- src/lib/config/compat.ts tests/config/config-compat.unit.test.ts
   ```
   msgfile 内容：`feat(config): add extractAndTranslateDeprecatedWithOps with legacyPathsRemoved tracking`

---

## Task 2 — validation.ts：改用新迁移应用器 + `ConfigValidationResult` 新增 `legacyPathsRemoved`

- **Files**：
  - Modify：`/home/xp/src/copilot-api-js/src/lib/config/validation.ts`
  - Test：`/home/xp/src/copilot-api-js/tests/config/config-compat.unit.test.ts`（既有 PUT describe 块新增断言）
- **Interfaces**（README 锁定，逐字）：
  ```ts
  export type ConfigValidationResult =
    | { valid: true; value: Config; legacyPathsRemoved: ReadonlyArray<string> }
    | { valid: false; details: Array<ConfigValidationDetail> }
  ```

### Steps

1. **写失败测试**——在 `tests/config/config-compat.unit.test.ts` 的既有 `describe("config compat — validateConfigInput (PUT) also migrates (C3)"` 块内追加：

   ```ts
   test("PUT legacyPathsRemoved reports the migrated legacy path", () => {
     const r = validateConfigInput({ fetch_timeout: 30 })
     expect(r.valid).toBe(true)
     if (r.valid) expect(r.legacyPathsRemoved).toContain("fetch_timeout")
   })

   test("PUT legacyPathsRemoved is empty when no legacy keys are present", () => {
     const r = validateConfigInput({ model_refresh_interval: 300 })
     expect(r.valid).toBe(true)
     if (r.valid) expect(r.legacyPathsRemoved).toEqual([])
   })

   test("PUT legacyPathsRemoved excludes in-place value migrations (anthropic.thinking_block_sanitize)", () => {
     const r = validateConfigInput({ anthropic: { thinking_block_sanitize: "empty_thinking" } })
     expect(r.valid).toBe(true)
     if (r.valid) {
       expect(r.value.anthropic?.thinking_block_sanitize).toBe("all_empty")
       expect(r.legacyPathsRemoved).not.toContain("anthropic.thinking_block_sanitize")
     }
   })
   ```

   跑：
   ```
   bun test tests/config/config-compat.unit.test.ts
   ```
   确认新增 3 个用例失败（TypeScript 层面 `r.legacyPathsRemoved` 在 `valid:true` 分支上不存在——若 `bun test` 的宽松运行时不因类型错误失败，先跑 `bun run typecheck` 确认这里报类型错误作为"失败"的证据；`r.legacyPathsRemoved` 运行时值为 `undefined`，`toContain`/`toEqual([])` 断言会真实失败，两种失败信号都印证当前实现缺失该字段）。

2. **最小实现**——编辑 `validation.ts`：

   顶部 import 改为（把 `CONFIG_MIGRATIONS` 换成新迁移应用器 + `navigate`）：
   ```ts
   import { extractAndTranslateDeprecatedWithOps, navigate, _resetDeprecatedKeyWarnTrackingForTests } from "./compat"
   ```

   删除第 78-134 行的私有 `extractAndTranslateDeprecated`/`deepMergeMissingOnly`/`navigate`/`deepCloneJsonSafe` 四个函数定义（连同它们各自的分节注释 `// Step 1 —…`），因为它们已经整体搬进 `compat.ts`。`cleanInvalidPaths`（原第 140 行起）保留不动，但它调用的 `navigate` 现在来自上面新增的 import。

   `_resetConfigValidationWarnTrackingForTests`（第 47-50 行）改为：
   ```ts
   export function _resetConfigValidationWarnTrackingForTests(): void {
     warnedDeprecatedKeys.clear()
     warnedIssueKeys.clear()
     _resetDeprecatedKeyWarnTrackingForTests()
   }
   ```
   *（保留 `warnedDeprecatedKeys` 这个本地 Set 是否还有意义？—— 不再有意义：迁移的 warn-once 追踪已经完全搬到 `compat.ts` 的 `warnedDeprecatedKeys`。删除 `validation.ts` 里的 `warnedDeprecatedKeys` 声明（第 32 行）和 `warnDeprecatedKeyOnce`（第 35-39 行），因为迁移路径不再调用它们——`validation.ts` 现在只剩 Zod issue 的 `warnedIssueKeys`/`warnIssueOnce`。相应地上面的 reset 函数简化为：*
   ```ts
   export function _resetConfigValidationWarnTrackingForTests(): void {
     warnedIssueKeys.clear()
     _resetDeprecatedKeyWarnTrackingForTests()
   }
   ```

   `validateConfig`（原第 192-212 行）里的：
   ```ts
   const processed = extractAndTranslateDeprecated(raw as Record<string, unknown>)
   ```
   改为：
   ```ts
   const { value: processed } = extractAndTranslateDeprecatedWithOps(raw as Record<string, unknown>)
   ```

   `ConfigValidationResult` 类型（原第 234 行）改为：
   ```ts
   export type ConfigValidationResult =
     | { valid: true; value: Config; legacyPathsRemoved: ReadonlyArray<string> }
     | { valid: false; details: Array<ConfigValidationDetail> }
   ```

   `validateConfigInput`（原第 241-258 行）改为：
   ```ts
   export function validateConfigInput(input: unknown): ConfigValidationResult {
     if (!input || typeof input !== "object" || Array.isArray(input)) {
       return {
         valid: false,
         details: [{ field: "$", message: "Config body must be a JSON object", value: input }],
       }
     }

     // Normalize legacy key names first (same migration as file load), so PUT
     // bodies carrying old keys are migrated rather than 400'd. Remaining
     // invalid fields still hard-fail with structured details.
     const { value: processed, legacyPathsRemoved } = extractAndTranslateDeprecatedWithOps(input as Record<string, unknown>)
     const result = ConfigSchema.safeParse(processed)
     if (result.success) return { valid: true, value: result.data, legacyPathsRemoved }

     const details = result.error.issues.flatMap((issue) => zodIssueToDetails(issue, processed))
     return { valid: false, details }
   }
   ```

3. 跑：
   ```
   bun test tests/config/config-compat.unit.test.ts tests/config/config-validation.unit.test.ts
   ```
   确认 Task 2 新增的 3 个用例通过，且 `config-validation.unit.test.ts`（覆盖 `_resetConfigValidationWarnTrackingForTests`/Zod issue 警告等既有行为）全部保持通过——这是本 Task 的回归红线：迁移搬家不能影响 Zod issue 的 warn-once 追踪。

4. 跑 `bun run typecheck`：应无错误。若 `ConfigValidationResult` 的收窄导致别处按窄类型访问 `r.value` 而未 narrowing `r.valid`，typecheck 会报错——按现有代码风格加 `if (r.valid)` 守卫（既有调用点均已遵循此模式，见 `config-compat.unit.test.ts` 第 202/208/214 行）。

5. 跑：
   ```
   bun test
   ```
   全量跑一次，确认没有隐藏依赖 `validation.ts` 内部私有函数名字的测试（这些函数从未导出，理论上不可能有外部依赖，此步骤是双重确认）。

6. 跑 `bunx eslint src/lib/config/validation.ts tests/config/config-compat.unit.test.ts`。

7. 提交：
   ```
   git add -- src/lib/config/validation.ts tests/config/config-compat.unit.test.ts
   git commit -F <msgfile> -- src/lib/config/validation.ts tests/config/config-compat.unit.test.ts
   ```
   msgfile 内容：`refactor(config): validation.ts delegates migration application to compat.ts, thread legacyPathsRemoved`

---

## Task 3 — route.ts：PUT 写回前删除 legacy 路径 + 剪除变空父节点 + 挂载新 section

- **Files**：
  - Modify：`/home/xp/src/copilot-api-js/src/routes/config/route.ts`
  - Test：`/home/xp/src/copilot-api-js/tests/config/config-yaml-routes.http.test.ts`
- **Interfaces**（内部，不跨阶段共享，仅本文件内）：
  ```ts
  function deleteLegacyPathsAndPruneEmptyParents(doc: ConfigDocument, legacyPaths: ReadonlyArray<string>): void
  ```
- **实测依据**（yaml 库真实行为，`bun -e` 验证，非文档推断）：`Document.getIn(path, true)` 对指向 Map 节点的路径返回底层 `YAMLMap` 本身，`isMap(node)` 判真，`node.items.length` 正确反映子项数；对单子键的父节点删除唯一子键后 `items.length === 0`。验证脚本与输出：
  ```
  bun -e '
  import { parseDocument, isMap } from "yaml"
  const doc = parseDocument("a:\n  b:\n    c: 1\n  d: 2\n")
  doc.deleteIn(["a","b","c"])
  const node = doc.getIn(["a","b"], true)
  console.log("isMap:", isMap(node), "items.length:", node.items.length)
  console.log(doc.toString())
  '
  # → isMap: true items.length: 0
  # → a:\n  b: {}\n  d: 2\n
  ```
  以及针对本 Task 实际迁移场景（多路径级联删除 + 父节点剪除 + 兄弟保留）的验证：
  ```
  bun -e '
  import { parseDocument, isMap } from "yaml"
  function deleteLegacyPathsAndPruneEmptyParents(doc, legacyPaths) {
    for (const dotPath of legacyPaths) {
      const parts = dotPath.split(".")
      doc.deleteIn(parts)
      for (let depth = parts.length - 1; depth > 0; depth--) {
        const ancestorPath = parts.slice(0, depth)
        const node = doc.getIn(ancestorPath, true)
        if (isMap(node) && node.items.length === 0) doc.deleteIn(ancestorPath)
        else break
      }
    }
  }
  const doc = parseDocument("timeouts:\n  upstream_keepalive: 0\n  stream_idle: 300\nopenai_responses:\n  client_ws_keep_open: true\n  max_ws_frame_bytes: 0\n  max_client_ws_connections: 128\n  max_upstream_ws_connections: 64\n  upstream_ws: false\n")
  deleteLegacyPathsAndPruneEmptyParents(doc, ["timeouts.upstream_keepalive","openai_responses.client_ws_keep_open","openai_responses.max_ws_frame_bytes","openai_responses.max_client_ws_connections","openai_responses.max_upstream_ws_connections"])
  console.log(doc.toString())
  '
  # → timeouts:\n  stream_idle: 300\nopenai_responses:\n  upstream_ws: false\n
  ```
  （`timeouts` 因还有 `stream_idle` 兄弟未被剪除；`openai_responses` 因还有 `upstream_ws` 兄弟未被剪除；两个 section 里被删的旧键全部消失，兄弟字段完整保留——这正是本 Task 的核心正确性依据。）

### Steps

1. **写失败测试**——在 `tests/config/config-yaml-routes.http.test.ts` 末尾（`describe("config yaml routes"` 块内，`})` 收尾之前）追加：

   ```ts
   test("PUT /api/config/yaml deletes a legacy top-level key from disk after migrating it", async () => {
     await writeConfig(`
   fetch_timeout: 45
   model_refresh_interval: 600
   `)

     const res = await app.request("/api/config/yaml", {
       method: "PUT",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({ model_refresh_interval: 601 }),
     })

     expect(res.status).toBe(200)
     const written = await readConfig()
     expect(written).not.toContain("fetch_timeout")
     expect(written).toContain("response_header: 45")
     expect(written).toContain("model_refresh_interval: 601")
   })

   test("PUT /api/config/yaml prunes a legacy section that becomes empty after its only key is removed", async () => {
     await writeConfig(`
   timeouts:
     upstream_keepalive: 0
     stream_idle: 300
   `)

     const res = await app.request("/api/config/yaml", {
       method: "PUT",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({}),
     })

     expect(res.status).toBe(200)
     const written = await readConfig()
     expect(written).not.toContain("upstream_keepalive")
     expect(written).toContain("stream_idle: 300")
   })

   test("PUT /api/config/yaml deleting the last legacy key inside openai_responses removes the section but keeps siblings", async () => {
     await writeConfig(`
   openai_responses:
     client_ws_keep_open: true
     max_ws_frame_bytes: 0
     max_client_ws_connections: 128
     max_upstream_ws_connections: 64
     upstream_ws: false
   `)

     const res = await app.request("/api/config/yaml", {
       method: "PUT",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({}),
     })

     expect(res.status).toBe(200)
     const written = await readConfig()
     expect(written).not.toContain("client_ws_keep_open")
     expect(written).not.toContain("max_ws_frame_bytes")
     expect(written).not.toContain("max_client_ws_connections")
     expect(written).not.toContain("max_upstream_ws_connections")
     expect(written).toContain("openai_responses:")
     expect(written).toContain("upstream_ws: false")
   })

   test("PUT /api/config/yaml writes upstream_transport and server sections when present in the body", async () => {
     const res = await app.request("/api/config/yaml", {
       method: "PUT",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({
         upstream_transport: { tcp_keepalive_probe_delay: 20, http2: { ping_interval: 25, session_connect_timeout: 8 } },
         server: { responses_ws: { keep_open: true, max_frame_bytes: 65536, max_connections: 64 } },
       }),
     })

     expect(res.status).toBe(200)
     expect(await res.json()).toEqual({
       upstream_transport: { tcp_keepalive_probe_delay: 20, http2: { ping_interval: 25, session_connect_timeout: 8 } },
       server: { responses_ws: { keep_open: true, max_frame_bytes: 65536, max_connections: 64 } },
     })

     const written = await readConfig()
     expect(written).toContain("upstream_transport:")
     expect(written).toContain("tcp_keepalive_probe_delay: 20")
     expect(written).toContain("session_connect_timeout: 8")
     expect(written).toContain("server:")
     expect(written).toContain("keep_open: true")
   })

   test("PUT /api/config/yaml migrating a legacy key into upstream_transport does not clobber an already-written sibling", async () => {
     await writeConfig(`
   upstream_transport:
     http2:
       session_connect_timeout: 8
   timeouts:
     upstream_h2_ping: 40
   `)

     const res = await app.request("/api/config/yaml", {
       method: "PUT",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({}),
     })

     expect(res.status).toBe(200)
     const written = await readConfig()
     expect(written).not.toContain("upstream_h2_ping")
     expect(written).toContain("ping_interval: 40")
   })

   test("PUT /api/config/yaml in-place value migration (thinking_block_sanitize) does not touch legacy-path deletion machinery", async () => {
     await writeConfig(`
   anthropic:
     thinking_block_sanitize: empty_thinking
     tool_dedup_calls: result
   `)

     const res = await app.request("/api/config/yaml", {
       method: "PUT",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({}),
     })

     expect(res.status).toBe(200)
     const written = await readConfig()
     expect(written).toContain("thinking_block_sanitize: all_empty")
     expect(written).toContain("tool_dedup_calls: result")
   })
   ```

   跑：
   ```
   bun test tests/config/config-yaml-routes.http.test.ts
   ```
   确认新增 6 个用例中，前 5 个失败（当前 PUT handler 从不删除磁盘上的 legacy 路径，也不处理 `upstream_transport`/`server` 顶层键——`upstream_transport: {...}` 场景实际会因为 `Config` schema 尚不认识这两个键而在 `validateConfigInput` 层被拒绝为未知字段，返回 400 而非 200，这本身就是失败信号；假设 P1 已经把 schema 落地，则这里失败在于 `mergeConfigIntoDocument` 没有对应分支，写回的 YAML 里不会出现 `upstream_transport:`）；最后一个用例（in-place 值迁移）当前应该已经通过（因为它不依赖任何新逻辑，只是确认新增机制没有破坏这条既有行为——留作显式回归锚点）。

2. **最小实现**——编辑 `route.ts`：

   顶部 import 改为：
   ```ts
   import { isMap, parseDocument } from "yaml"
   ```

   在 `mergeConfigIntoDocument`（第 257 行起）的 `if (hasOwn(body, "openai_responses")) …` 行之后新增两行：
   ```ts
   if (hasOwn(body, "upstream_transport")) setNestedScalarContainer(doc, ["upstream_transport"], body.upstream_transport)
   if (hasOwn(body, "server")) setNestedScalarContainer(doc, ["server"], body.server)
   ```

   在文件末尾（`replaceCollection` 函数之后）新增：
   ```ts
   /**
    * Delete every legacy dot-path reported by `ConfigValidationResult.legacyPathsRemoved`
    * from the on-disk YAML document, then walk upward pruning any ancestor Map
    * that became empty as a result (so a fully-migrated section disappears
    * entirely instead of leaving a dangling `section: {}`). Stops climbing as
    * soon as an ancestor still has at least one sibling key — untouched
    * sibling fields and their comments are never disturbed.
    *
    * Must run BEFORE mergeConfigIntoDocument, which writes the migrated new
    * value at its (possibly different) new path.
    */
   function deleteLegacyPathsAndPruneEmptyParents(doc: ConfigDocument, legacyPaths: ReadonlyArray<string>): void {
     for (const dotPath of legacyPaths) {
       const parts = dotPath.split(".")
       doc.deleteIn(parts)
       for (let depth = parts.length - 1; depth > 0; depth--) {
         const ancestorPath = parts.slice(0, depth)
         const node = doc.getIn(ancestorPath, true)
         if (isMap(node) && node.items.length === 0) {
           doc.deleteIn(ancestorPath)
         } else {
           break
         }
       }
     }
   }
   ```

   在 PUT handler 里（第 124-125 行之间）插入一行：
   ```ts
   const doc = await loadEditableConfigDocument()
   deleteLegacyPathsAndPruneEmptyParents(doc, validation.legacyPathsRemoved)
   mergeConfigIntoDocument(doc, validation.value)
   ```

3. 跑：
   ```
   bun test tests/config/config-yaml-routes.http.test.ts
   ```
   确认全部 6 个新增用例通过，且既有用例（尤其是"保留兄弟字段""保留注释""空 body 保持不变"这几类）全部保持通过——这条回归红线尤其重要：`deleteLegacyPathsAndPruneEmptyParents` 只应该删除 `legacyPathsRemoved` 列出的路径，绝不能误删用户主动设置的、与 legacy 无关的字段。

4. 跑 `bun test`（全量）确认没有其它测试文件间接依赖 `mergeConfigIntoDocument`/PUT handler 的旧行为而回归。

5. 跑 `bun run typecheck` 确认 `body.upstream_transport`/`body.server` 在 `Config` 类型上存在（依赖 P1 的 schema 改动已落地；若 P1 尚未执行，此步骤会因类型不存在而报错——这是本 Task 对 P1 完成状态的隐式前置校验，属预期依赖顺序，非本 Task 缺陷）。

6. 跑 `bunx eslint src/routes/config/route.ts tests/config/config-yaml-routes.http.test.ts`。

7. 提交：
   ```
   git add -- src/routes/config/route.ts tests/config/config-yaml-routes.http.test.ts
   git commit -F <msgfile> -- src/routes/config/route.ts tests/config/config-yaml-routes.http.test.ts
   ```
   msgfile 内容：`feat(config): PUT /api/config/yaml deletes migrated legacy paths from disk and prunes empty parents`

---

### Task 3 附加范围 — 嵌套 section 部分 PUT 升级为递归深合并 + `null` 删除（用户裁决，B9）

**背景**：`setNestedScalarContainer`（`route.ts:315`）目前只对`value`自己的**直接子键**做逐键处理——子键若是标量/数组，`setScalar` 正确地"只改这一个键、其余兄弟不动"；但子键若本身还是一个嵌套对象（如 `upstream_transport.http2`、`anthropic.buffered_retry`），当前实现把整个子对象原样交给 `setScalar`，后者调用 `doc.setIn(childPath, wholeObject)`——`yaml` 库据此把该路径下的整个节点**整体替换**，抹掉该子对象里当前 PUT body 没提到的其他字段（只 PUT `session_connect_timeout` 会抹掉磁盘上已有的 `ping_interval`）。用户已裁决升级为**逐字段递归深合并**（部分 PUT 只改给出的字段、任意深度的同段兄弟字段保留）+ **`null` 在任意深度都显式删除该字段**，`anthropic.buffered_retry`（现存唯一命中该 bug 的既有字段）一并切到新语义——本项目 PUT 行为无向后兼容负担，不为它单独保留旧的整体替换分支。此前 `plan-kickoff.md` 把"是否要做这个升级"记为待主会话裁决的开放项（见文末条目更新），现已裁决为**做**，故并入本 Task（而非单开新 Task），因为改的是同一个 `setNestedScalarContainer` 函数，且它已经被 Task 3 上方 Step 2 用于挂载 `upstream_transport`/`server`。

- **Files**：
  - Modify：`/home/xp/src/copilot-api-js/src/routes/config/route.ts:315-326`（`setNestedScalarContainer`，无签名变化，纯内部逻辑升级）
  - Test：`/home/xp/src/copilot-api-js/tests/config/config-yaml-routes.http.test.ts`

#### Steps

1. **写失败测试**——在 `config-yaml-routes.http.test.ts` 末尾（`describe("config yaml routes"` 块内收尾 `})` 之前）追加：

   ```ts
   test("PUT /api/config/yaml deep-merges upstream_transport.http2 instead of whole-replacing the section (B9)", async () => {
     await writeConfig(`
   upstream_transport:
     http2:
       ping_interval: 30
       session_connect_timeout: 5
   `)

     const res = await app.request("/api/config/yaml", {
       method: "PUT",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({
         upstream_transport: { http2: { session_connect_timeout: 8 } },
       }),
     })

     expect(res.status).toBe(200)
     const written = await readConfig()
     expect(written).toContain("ping_interval: 30")
     expect(written).toContain("session_connect_timeout: 8")
   })

   test("PUT /api/config/yaml null-deletes a single leaf inside upstream_transport.http2 while preserving its sibling (B9)", async () => {
     await writeConfig(`
   upstream_transport:
     http2:
       ping_interval: 30
       session_connect_timeout: 5
   `)

     const res = await app.request("/api/config/yaml", {
       method: "PUT",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({
         upstream_transport: { http2: { ping_interval: null } },
       }),
     })

     expect(res.status).toBe(200)
     const written = await readConfig()
     expect(written).not.toContain("ping_interval")
     expect(written).toContain("session_connect_timeout: 5")
   })

   test("PUT /api/config/yaml anthropic.buffered_retry deep-merges instead of whole-replacing (B9, existing field switched to new semantics)", async () => {
     await writeConfig(`
   anthropic:
     buffered_retry:
       max_retries: 5
       heartbeat_sec: 20
   `)

     const res = await app.request("/api/config/yaml", {
       method: "PUT",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({
         anthropic: { buffered_retry: { max_retries: 9 } },
       }),
     })

     expect(res.status).toBe(200)
     const written = await readConfig()
     expect(written).toContain("heartbeat_sec: 20")
     expect(written).toContain("max_retries: 9")
   })

   test("PUT /api/config/yaml sending null for a whole nested sub-object still deletes it entirely (regression, any depth)", async () => {
     await writeConfig(`
   anthropic:
     buffered_retry:
       max_retries: 5
       heartbeat_sec: 20
     tool_strip_read_result_tags: true
   `)

     const res = await app.request("/api/config/yaml", {
       method: "PUT",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({
         anthropic: { buffered_retry: null },
       }),
     })

     expect(res.status).toBe(200)
     const written = await readConfig()
     expect(written).not.toContain("buffered_retry")
     expect(written).not.toContain("max_retries")
     expect(written).not.toContain("heartbeat_sec")
     expect(written).toContain("tool_strip_read_result_tags: true")
   })
   ```

   跑：
   ```
   bun test tests/config/config-yaml-routes.http.test.ts
   ```
   确认前 3 个用例失败（当前实现把 `http2`/`buffered_retry` 整体替换，磁盘上原有的兄弟字段消失，断言 `toContain` 落空）；第 4 个用例（整体 `null` 删除）在当前实现下已经通过——保留作为显式回归锚点，证明"升级为深合并"不会连带破坏"整体删除"这个既有能力。

2. **最小实现**——编辑 `route.ts:315-326`，把：
   ```ts
   function setNestedScalarContainer(doc: ConfigDocument, path: Array<string>, value: unknown, options?: { excludeKeys?: Set<string> }): void {
     if (value === null || value === undefined) {
       doc.deleteIn(path)
       return
     }
     if (!isPlainObject(value)) return

     for (const [key, child] of Object.entries(value)) {
       if (options?.excludeKeys?.has(key)) continue
       setScalar(doc, [...path, key], child)
     }
   }
   ```
   改为：
   ```ts
   /**
    * Recursively merge `value`'s keys into `doc` at `path`. A nested plain-object
    * child recurses into a fresh merge at the child path (so untouched sibling
    * keys survive at EVERY nesting depth, not just the top one); `null`/
    * `undefined` deletes that exact key at any depth (`setScalar` already
    * handles this); any other value (scalar, array) is written wholesale.
    *
    * Used to stop recursing after the first level: a nested-object CHILD value
    * (e.g. `anthropic.buffered_retry`, `upstream_transport.http2`) was handed to
    * `setScalar`, which does `doc.setIn(childPath, wholeObject)` — silently
    * replacing the entire child node and erasing sibling fields the PUT body
    * didn't mention (`ping_interval` disappearing when a PUT only sent
    * `session_connect_timeout`). Recursing keeps every already-existing sibling
    * untouched at any depth, matching this API's "sparse override" PUT
    * semantics (`docs/spec/2026-07-14-upstream-transport-config-reorg.md` §5 —
    * user decision; `anthropic.buffered_retry`, the one existing field that hit
    * this bug, switches to the same semantics too — no back-compat burden for a
    * config PUT behavior change).
    */
   function setNestedScalarContainer(doc: ConfigDocument, path: Array<string>, value: unknown, options?: { excludeKeys?: Set<string> }): void {
     if (value === null || value === undefined) {
       doc.deleteIn(path)
       return
     }
     if (!isPlainObject(value)) return

     for (const [key, child] of Object.entries(value)) {
       if (options?.excludeKeys?.has(key)) continue
       const childPath = [...path, key]
       if (isPlainObject(child)) setNestedScalarContainer(doc, childPath, child)
       else setScalar(doc, childPath, child)
     }
   }
   ```
   （`excludeKeys` 只在调用方显式传入时生效，且只作用于**当次调用**自己遍历的那一层键——递归调用不传 `options`，这与现状一致：`excludeKeys` 目前唯一的调用点是 `anthropic` 顶层的 `system_rewrite_reminders`/`tool_search_non_deferred`，它们是 `anthropic` 的直接子键而非更深层嵌套对象的子键，不需要穿透进递归。）

3. 跑：
   ```
   bun test tests/config/config-yaml-routes.http.test.ts
   ```
   确认新增 4 个用例全部通过；且本文件既有的"preserves untouched anthropic sibling keys during partial updates"、"deletes nested scalar child keys while preserving the container"等既有用例（均只涉及一层嵌套的标量子键，不受本次递归升级影响）保持通过。

4. 跑 `bun test`（全量）确认没有其它测试文件依赖 `anthropic.buffered_retry`/其他嵌套 section 的旧整体替换语义（已检索 `tests/config/buffered-retry-keys.test.ts`/`tests/config/config-hot-reload.it.test.ts`，两者都走文件直写 + `applyConfigToState` 的 file-load 路径而非本函数覆盖的 PUT-body-merge 路径，不受影响）。

5. 跑 `bun run typecheck` 确认无类型错误（`setNestedScalarContainer` 签名未变，`isPlainObject`/`setScalar` 均为既有函数，新增的是一处递归调用，不引入新类型）。

6. 跑 `bunx eslint src/routes/config/route.ts tests/config/config-yaml-routes.http.test.ts`（无缓存单文件检查）确认无新增 lint 违规。

7. 提交：
   ```
   git add -- src/routes/config/route.ts tests/config/config-yaml-routes.http.test.ts
   git commit -F <msgfile> -- src/routes/config/route.ts tests/config/config-yaml-routes.http.test.ts
   ```
   msgfile 内容：`feat(config): recursive deep-merge for nested section PUT, anthropic.buffered_retry included (B9)`

   （本提交与上一个 Task 3 提交都改 `route.ts`/`config-yaml-routes.http.test.ts` 同一对文件，但改的是不重叠的函数/用例——`deleteLegacyPathsAndPruneEmptyParents` 全新增，`setNestedScalarContainer` 是既有函数的独立升级，两次提交各自的 diff 互不相交，可安全分开提交。）

---

## Task 4 — 跨 Task 回归 + 自审 + README 交接核对

### Steps

1. 全量跑：
   ```
   bun run typecheck
   bun test
   bun run lint:all
   ```
   三者必须全绿。`lint:all` 用全量无缓存的 `eslint .`（详见项目记忆 `tooling-eslint-cache-false-pass.md`——targeted `lint` 带缓存会对已修改文件之外的存量文件假绿，收尾必须用 `lint:all`）。

2. 核对 README「跨阶段共享接口清单」（第 121-132 行）与本文件 Task 1/2 实际交付的签名逐字一致：`ConfigMigrationApplyResult { value, legacyPathsRemoved }`、`extractAndTranslateDeprecatedWithOps(raw): ConfigMigrationApplyResult`、`ConfigValidationResult` 的 `valid:true` 分支新增 `legacyPathsRemoved: ReadonlyArray<string>`。若发现偏离，回 README 更新后再继续。

3. 自审清单（对照本文件 Goal 逐条核对，而非泛泛"看起来对"）：
   - [ ] `validateConfig`（file-load）对外行为完全不变——`tests/config/config-compat.unit.test.ts` 顶部"file load"describe 块的既有用例一字不改地全部通过。
   - [ ] `migrateValue` 的三个既有调用点（`thinking_block_message_policy` 一致化、`thinking_block_sanitize` 两条、`stream_keepalive_mode`）均不出现在任何 `legacyPathsRemoved` 结果里（已由 Task 1/2 测试覆盖 `thinking_block_sanitize` 一例作为代表；若不放心可自行加测其余三处，机制完全通用，逐一验证只是重复劳动，非必须）。
   - [ ] `renameLeaf`/`renameSection`/`removeKey` 的每一类 builder 至少各有一条 `legacyPathsRemoved` 覆盖用例（Task 1 已覆盖 `renameLeaf`=fetch_timeout、`removeKey`=history.min_entries、`renameSection`=openai-responses）。
   - [ ] PUT 场景下，legacy 路径删除**先于** `mergeConfigIntoDocument` 执行（代码顺序即保证，Task 3 Step 2 已固定）。
   - [ ] 已知继承限制（非本阶段新增缺陷，见下方"待主会话裁决"第 3 条）已记录，不在本阶段静默"顺手修复"从而扩大改动面。
   - [ ] `setNestedScalarContainer` 的递归深合并（B9）在**三个**新嵌套子段（`upstream_transport.http2`/`upstream_transport.websocket`/`server.responses_ws`）与既有 `anthropic.buffered_retry` 上行为一致——本阶段测试显式覆盖了 `upstream_transport.http2` + `anthropic.buffered_retry` 两例作为代表（机制通用，逐一验证 `websocket`/`responses_ws` 属重复劳动，非必须，见 Task 3 附加范围）。

4. 若发现任何自审未通过项，回到对应 Task 修复并重新走一遍该 Task 的测试→提交流程，不在 Task 4 里堆积未经测试驱动的修补。

---

## Self-Review（本阶段撰写过程中的自我核验记录）

- **yaml 库行为不靠猜测**：`isMap`/`getIn(path,true)`/`items.length` 的组合行为已用 `bun -e` 实测两遍（通用场景 + 本 Task 实际迁移场景），非查文档推断，符合项目 `empirical-verification` 纪律。
- **`legacyPathsRemoved` 排除 in-place 值迁移是本阶段最容易踩的坑**：若不排除，`anthropic.thinking_block_sanitize` 这类同路径值迁移会在 PUT 时被"先删后加"，丢失原 YAML 位置和注释——已通过 `isInPlaceValueMigration` 标记 + 显式回归测试（Task 1 test 4、Task 3 最后一个用例）锁定。
- **未采纳方案**：spec §5 提到的更完整 `{oldPath, newPath, migratedValue, deleteOnly}` 序列设计——未采纳，因为 PUT handler 已经拥有迁移后的完整新值（`validation.value`），只需要"删哪些旧路径"这一窄信息；序列设计会引入这条信息流的第二份真相来源（新路径该怎么写，`mergeConfigIntoDocument` 已经独立决定），徒增复杂度且有unsync风险。此设计已在 README 落定，本阶段严格遵循，不重新引入。
- **`setNestedScalarContainer` 递归深合并（B9）是最小diff修法**：新旧实现的唯一区别是子键为嵌套对象时递归而非整体替换——`setScalar` 本身早就正确处理了 `null`/标量/数组，不需要为"任意深度 `null` 删除"单独写分支，递归调用天然复用了它。这一处升级独立于 Task 3 本身的"legacy 路径删除"改动，函数不重叠，故分开提交（见 Task 3 附加范围收尾说明）。

## 待本阶段自身记录、汇总进 `plan-kickoff.md`「待主会话裁决」的条目

1. ~~嵌套 section 的 PUT 部分更新是"整体替换"而非"深度合并"~~——**已裁决（B9）：升级为递归深合并 + 任意深度 `null` 删除**，`anthropic.buffered_retry` 一并切换，实现见上方"Task 3 附加范围"。此条目原为开放问题，现已被用户裁决关闭，不再是待主会话决定的分叉；保留删除线记录决策沿革，供 `plan-kickoff.md` 的 C10 收尾步骤引用核对。

## 偏离与根因（执行期发现，实现时校正）

**Task 3 主体机制的字面描述（"PUT handler 只把 `validation.legacyPathsRemoved` 传给 `deleteLegacyPathsAndPruneEmptyParents`，`validation.value` 直接交给 `mergeConfigIntoDocument`"）满足不了本文件自己定义的测试用例，实现时发现并校正**：

- **根因**：`validateConfigInput(body)`（因而 `validation.legacyPathsRemoved`）只对 **PUT 请求体**（`body`）跑迁移。但 Task 3 自己的测试（如"prunes a legacy section that becomes empty..."、"migrating a legacy key into upstream_transport does not clobber..."）写的场景是——legacy 键**只存在于磁盘上**，PUT body 是空 `{}` 或只改无关字段。这类场景下 `validation.legacyPathsRemoved` 恒为空，字面机制完全不会触发磁盘清理，测试必然失败（实测复现：5/6 新增用例在最小实现后失败，见执行记录）。这正是本阶段 Goal 要修的那个 bug 的另一半——不仅"PUT 写回不清理磁盘旧键"，而且哪怕 PUT body 根本没提到那个旧键，只要它还在磁盘上，也该被这次写回顺手迁移掉（否则用户永远等不到一次"覆盖到这个字段"的 PUT，deprecation 警告就永远清不掉）。
- **校正方案**：`compat.ts` 新增 `extractDiskOnlyMigrationPatch(diskRaw)`——对**磁盘原始内容**（而非 PUT body）跑迁移，但只返回迁移**实际写入的稀疏 patch**（哪些新路径被填了值）+ 命中的 legacy 路径，而不是完整迁移后的 payload。PUT handler 读磁盘 `doc.toJSON()`，调用这个函数拿到 `{patch, legacyPathsRemoved}`，把 `patch` 用**已有的** missing-only 深合并（`deepMergeMissingOnly`，从 `validation.ts` 私有函数**提升为 `compat.ts` 导出函数**，供 route.ts 复用）合进 `validation.value`（PUT body 迁移后的值），再把两路 `legacyPathsRemoved` 取并集，一并交给 `deleteLegacyPathsAndPruneEmptyParents`。
- **为什么不能直接把整份 `extractAndTranslateDeprecatedWithOps(diskRaw).value` 合并进去**：磁盘上完全没有 legacy 命中的字段（典型如 `model_overrides`、`system_prompt_overrides` 这类数组集合）如果被裹进合并结果再交给 `mergeConfigIntoDocument`，会被 `replaceCollection`（`doc.deleteIn` + `doc.setIn`）当作"这次 PUT 也提到了这个字段"来写——即使值完全没变，也会把该集合从原位置删除、追加到父 Map 末尾，丢失原始摆放顺序（虽然目前测试未断言这类字段的确切行位置，但这违反"未触碰字段不应产生任何写回副作用"的最小惊讶原则，且已知 `replaceCollection` 有此重定位副作用——见 Task 3 正文对 `anthropic.thinking_block_sanitize` in-place 迁移同类问题的分析）。改为共享的 `applyMigrations` 核心 + 可选 `patchAccumulator` 参数，让"只迁移实际命中的新路径值"和"完整迁移收敛（供 chaining）"复用同一遍历逻辑、不产生逻辑分叉。
- **对 README「跨阶段共享接口清单」的影响**：无——`extractDiskOnlyMigrationPatch`/`deepMergeMissingOnly`（导出版）是 P3 内部实现细节，不在 P2/P4 消费的签名列表里，不影响跨阶段契约。`extractAndTranslateDeprecatedWithOps`/`ConfigMigrationApplyResult`/`ConfigValidationResult.legacyPathsRemoved` 三个签名逐字未变。
- **测试证据**：Task 3 全部 6 个新增用例 + B9 全部 4 个新增用例，加回归套件（既有"保留兄弟字段/注释""空 body 保持不变""collections 整体替换"等用例）全部通过，见执行报告。
