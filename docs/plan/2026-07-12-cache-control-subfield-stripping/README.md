# cache_control 子字段剥离 + sanitize 收窄 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按 task 逐个实施。步骤用 `- [ ]` 复选框跟踪。

**Spec（单一事实源）**：[../../spec/2026-07-12-cache-control-subfield-stripping.md](../../spec/2026-07-12-cache-control-subfield-stripping.md)

**Goal**：消除 Claude Code 发送的 `cache_control.scope` 子字段被 GHC 上游 400 拒绝的问题，且保留 passthrough 的客户端精调断点；一般化到「任意 GHC 未支持 cache_control 子字段」踩一次 400 即自愈。

**Architecture**：三阶段。Phase 0 收窄 sanitize 语义（保留客户端合法 ttl + 跨层 TTL 单调化 + 抽共享 TTL 原语）；Phase 1 在 passthrough 加黑名单子字段过滤（四源 union 读取端，内置 `scope`）；Phase 2 加反应式学习腿（endpoint-level negotiation + retry）。

**Tech Stack**：TypeScript / Bun test（`bun:test`）/ 现有 `src/lib/anthropic/request-preparation.ts` 管线 + `feature-negotiation.ts` negotiation cache + `codec/anthropic/strategies.ts` retry 腿。

---

## Global Constraints（每个 task 隐含继承）

- **TDD**：先写失败测试 → 跑到红 → 最小实现 → 跑到绿 → 提交。每 task 结束是独立可测的交付物。
- **commit invariants**：每个 commit 的终态满足其不变量，中间态**绝不半坏**（删函数但调用方还引用 = 禁止）。推进到 typecheck 绿再 commit。
- **golden-fixture 预捕获**：改动前先锁旧行为（Phase 0 的 sanitize 现状矩阵），证等价/差异，再改。
- **no-auto-server**：绝不运行 `bun run dev`/`start` 或任何启动服务器的命令、绝不 `kill`/`pkill`。可跑 `bun test` / `bun run typecheck` / `bunx eslint <path>`（单文件核 lint 用无缓存）。
- **显式 pathspec 提交**：`git add -- <精确路径>`、`git commit -F <msgfile> -- <精确路径>`。conventional commits，不加模型署名。
- **相对路径导入**：同目录文件互相导入用 `./foo` 非 `~/lib/...`。
- **CacheTtl 取值**：仅 `"5m"` | `"1h"`（顺序 `5m < 1h`）。见 [request-preparation.ts:156](../../../src/lib/anthropic/request-preparation.ts#L156) `EphemeralCacheControl`。
- **中文文档/注释**：面向人的输出中文，技术标识符保留英文。

---

## 阶段 DAG 与红线

```
Phase 0 (sanitize 收窄)  ⊥  Phase 1 (passthrough filter)
                              │
                              ▼
                         Phase 2 (reactive learning)  ← 依赖 Phase 1 的读取端 + PrepareHints
```

- **Phase 0 ⊥ Phase 1**：Phase 0 只改 `applyCacheControlMode` 的 `sanitize` 分支 + 抽 `resolveSanitizedTtls`；Phase 1 只改 `passthrough` 分支 + 新增 filter。两者不依赖，可并行/任意顺序。**但** Phase 0 的 `resolveSanitizedTtls` 若已落地，Phase 1 的 proxied/sanitize 不受影响（Phase 1 不碰它们）。
- **Phase 2 依赖 Phase 1**：Phase 2 的 retry 腿经 `PrepareHints.excludeCacheControlSubfields`（源④）+ negotiation 学习集（源③）喂给 Phase 1 的读取端 `collectUnsupportedCacheControlSubfields`。故 Phase 1 必须先落地。

### 红线（绝不违反）

1. **filter handler 绝不返回 `undefined`**——那会删掉整个 `cache_control`（退化成 disabled 语义）。必须原地 `delete cc[field]` 后 `return cc`（identity），走 replace 分支但对象不变。见 spec §5.2。
2. **跨层单调化只降后层、绝不升前层**——方向与现有 `resolveExtendedTtls` clamp 一致（降 messages，非升 tools）。见 spec §4.3。
3. **Phase 2 新增 `NegotiationCategory` 必须补全所有穷尽点**（评审 H1/M1）——不补编译报错或测试污染：
   - 后端 `never` 守卫：[feature-negotiation.ts:668](../../../src/lib/anthropic/feature-negotiation.ts#L668) `locateMeta` + [:712](../../../src/lib/anthropic/feature-negotiation.ts#L712) `deleteLocated`
   - **ui-v4 穷尽 Record**：[ui-v4/src/lib/learned.ts:8](../../../ui-v4/src/lib/learned.ts#L8) `CATEGORY_LABELS: Record<NegotiationCategory,string>`——**根 typecheck 不覆盖 ui-v4**，须跑 `bun run typecheck:ui-v4`（项目记忆 verify-ui-with-build-not-just-typecheck）
   - 测试污染防护：[feature-negotiation.ts:836](../../../src/lib/anthropic/feature-negotiation.ts#L836) `clearNegotiationMaps()` 加新 map 的 `.clear()`
   - 完整十点扇出见 spec §6.1 + plan-2 Task 2.1。
4. **遮蔽风险回归测试必须含三路径**（`system.N.` / `tools.N.` / `messages.N.content.M.` 的 cache_control，尤其最险的 `tools.N.cache_control.*`）。见 spec §6.3。
5. **内置 `{scope}` 在读取端注入、不在 config 默认值里**——config 默认 `{}` 表示「无额外覆盖」，与内置正交。见 spec §5.5。

---

## 冻结的跨 task interface 契约

实施者只看到自己的 task，以下签名是各 task 之间的契约，**逐字不变**：

### Phase 0 产出

```ts
// request-preparation.ts —— 新增共享 TTL 决策原语（单一 owner）
// 输入每层「客户端出现的最大 ttl」快照（缺层 undefined）+ extended 是否激活，
// 返回单调化后每层的 effective ttl（tools≥system≥messages）。
interface PerLayerClientTtls {
  tools?: CacheTtl
  system?: CacheTtl
  messages?: CacheTtl
}
interface SanitizedLayerTtls {
  tools: CacheTtl
  system: CacheTtl
  messages: CacheTtl
}
export function resolveSanitizedTtls(
  clientMax: PerLayerClientTtls,
  extendedActive: boolean,
  extendedTtls: { toolsSystem: CacheTtl; messages: CacheTtl },
): SanitizedLayerTtls

// 算法（承重，见 spec §4.3；per-breakpoint min 不够，必须层级统一）：
//   floor.tools = floor.system = extendedActive ? extendedTtls.toolsSystem : "5m"
//   floor.messages                = extendedActive ? extendedTtls.messages   : "5m"
//   effective.tools    = max(clientMax.tools    ?? "5m", floor.tools)
//   effective.system   = min( max(clientMax.system   ?? "5m", floor.system),   effective.tools )
//   effective.messages = min( max(clientMax.messages ?? "5m", floor.messages), effective.system )
// sanitize walk 时：同层所有断点统一设为 effective[section]（规范化语义，非 per-breakpoint 保留）。
// 这保证跨层单调（effective 本身递减），又保留「层级客户端最大 ttl 意图」。
```

### Phase 1 产出

```ts
// request-preparation.ts
export function collectUnsupportedCacheControlSubfields(
  model: string,
  hints?: ReadonlyArray<string>,   // 源④ per-attempt（Phase 1 恒 undefined，Phase 2 注入）
): Set<string>

// filter 原语：就地删黑名单子字段、保留其余。作用于 passthrough 分支。
function filterCacheControlSubfields(wire: Record<string, unknown>, blacklist: Set<string>): Array<string>
//   返回值 = 实际剥掉的字段名去重列表（供 history 标记；空数组=未剥）

// PrepareContext 新增出参（对齐 wroteExtendedTtl 模式，request-preparation.ts:78）
interface PrepareContext {
  // ...现有字段
  strippedCacheControlSubfields?: ReadonlyArray<string>  // 由 cache-control step 写
}

// ⚠️ 两个不同接口，勿混（评审 C1）：
//   PrepareAnthropicRequestOptions（request-preparation.ts:~124）—— prepare 入参，excludeBetas/excludeToolFields 在此
//   PrepareHints（pipeline.ts:96）—— retry 腿 RetryAction.prepareHints 的类型，是 per-attempt hint 的源
// 源④ hint 是端到端多跳通道，必须逐跳接（漏一跳则 hint 恒 undefined、静默死接线）：
//   ① pipeline.ts:96 PrepareHints 加字段
//   ② codec/anthropic/codec.ts:~407-411 逐字段白名单桥接加一行 env.prepareHints.X → opts.X
//   ③ request-preparation.ts PrepareAnthropicRequestOptions 加字段 + passthrough 消费点
interface PrepareHints {              // pipeline.ts:96
  // ...现有 excludeBetas / excludeToolFields / rejectFields / excludeServerToolTypes / contextEscalation
  excludeCacheControlSubfields?: ReadonlyArray<string>   // 源④
}
interface PrepareAnthropicRequestOptions {   // request-preparation.ts
  // ...现有
  excludeCacheControlSubfields?: ReadonlyArray<string>   // 源④ 落到 prepare 入参
}

// PreparedAnthropicRequest（request-preparation.ts:67）—— prepareAnthropicRequest 的 return
// 现只有 { wire, headers }；Task 1.5 加 strippedCacheControlSubfields 出参：
interface PreparedAnthropicRequest {
  wire: Record<string, unknown>
  headers: Record<string, string>
  strippedCacheControlSubfields?: ReadonlyArray<string>   // Task 1.5：从 ctx 透出供 codec recordFeature
}

// history 诊断落点 = recordFeature 通道（评审 H2 + SSOT）：
// 弃「给跨端点共享的 WireRequest/UpstreamRequestLeg 加 anthropic 专属字段」（SSOT smell），
// 改用现成的 deps.requestContext?.recordFeature(kind, detail)（codec.ts:423 thinking coercion 先例，
// 已验证进 history）。codec 读 prepared.strippedCacheControlSubfields → recordFeature。
// FeatureKind（context/types.ts）加成员 "cache_control_strip"。

// state.ts 新增 config-managed 字段
readonly stripCacheControlSubfields: Record<string, Array<string>>   // 默认 {}
// config 键名 = anthropic.cache_control_strip_subfields（对齐 beta_strip_headers/tool_strip_fields 的
// <noun>_strip_<field> 约定，评审 M2；strip_cache_control_subfields 是 compat.ts:265 已废弃的旧模式）
// config→state 映射是 MANDATORY（config.ts:588+ 每键显式，漏则源② 死路径，评审 H3）
```

### Phase 2 产出

```ts
// feature-negotiation.ts —— endpoint-level（model-agnostic），对齐 markAnthropicUnsupportedToolFields
export function markAnthropicUnsupportedCacheControlSubfield(field: string): void
export function getUnsupportedCacheControlSubfields(): Array<string>

// 新 NegotiationCategory 成员
type NegotiationCategory = /* ...现有 */ | "cacheControlSubfields"

// retry 腿：codec/anthropic/strategies.ts 注册（ordering 见红线 4）
export function createCacheControlSubfieldRejectionStrategy<
  TPayload extends { model: string }
>(): RetryStrategy<TPayload>
```

---

## Phase 文件

- [plan-0-sanitize-narrowing.md](plan-0-sanitize-narrowing.md) — Phase 0：sanitize 收窄 + resolveSanitizedTtls + 跨层单调化
- [plan-1-passthrough-filter.md](plan-1-passthrough-filter.md) — Phase 1：passthrough 黑名单过滤 + 四源读取端 + config + history 标记
- [plan-2-reactive-learning.md](plan-2-reactive-learning.md) — Phase 2：negotiation 分类扇出 + reactive 腿 + 三路径遮蔽测试
- [plan-kickoff.md](plan-kickoff.md) — 各阶段 kickoff 提示词

## 实施状态

- [x] Phase 0 — landed (5a9ba6cf..e5e37515)
- [ ] Phase 1 — 未开始
- [ ] Phase 2 — 未开始
