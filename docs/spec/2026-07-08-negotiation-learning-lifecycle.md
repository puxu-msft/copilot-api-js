# Spec: 反应式学习记录 生命周期 + 查看/编辑页面

- 状态: Draft（待实现）
- 日期: 2026-07-08
- 归属: 本项目 spec（docs/spec/），路线图挂在 History/管理面板 + feature-negotiation 子系统
- 相关: [feature-negotiation.ts](../../src/lib/anthropic/feature-negotiation.ts)、[docs/DESIGN.md](../DESIGN.md)、ADR [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)

## 1. 背景与问题

`copilot-api-js` 的**反应式学习记录**（下称「学习记录」）指 [feature-negotiation.ts](../../src/lib/anthropic/feature-negotiation.ts) 维护的 per-(endpoint, model) 兼容性缓存：管线从上游 GHC 的 400 拒绝中**反应式学到** workaround，后续请求预先规避，持久化到 `negotiation-states.json`。共 10 个功能分组：

| 分类 (category) | key 维度 | value 维度 | 学习来源（上游错误） |
|---|---|---|---|
| `features` | modelKey | 字段名 | `X: Extra inputs are not permitted` |
| `betas` | modelKey | beta token | `unsupported beta header(s): X` |
| `efforts` | model | 支持的 effort 有序 list | `invalid_reasoning_effort`（带 supported values） |
| `effortUnsupported` | model（扁平集合） | — | `does not support reasoning effort`（无 list） |
| `deferredTools` | modelKey | toolName | `Tool reference 'X' not found in available tools` |
| `serverTools` | modelKey | serverTool 类型前缀 | `The use of the web search tool is not supported.` |
| `partnerFeatures` | modelKey | partner feature 名 | Vertex `allowedPartnerModelFeatures violated` |
| `systemRejectModels` | model（扁平集合） | — | `Unexpected role "system"` |
| `serverToolDowngrade` | model（扁平集合） | — | `Tool '…' not found in provided tools` |
| `toolFields` | endpointKey（**model 无关**） | 字段名 | `tools.N.<variant>.<field>: Extra inputs are not permitted` |

**现状痛点**：所有条目**永久**（无 TTL、无时间戳），唯一「重测」手段是手删 `negotiation-states.json`。上游若修复了某不兼容，陈旧 workaround 会一直施加、无从发现；且这些学习记录**完全没有暴露给任何 HTTP 端点 / UI**，不可观测、不可管理。

## 2. 目标（What & Why）

给学习记录引入**生命周期模型**并提供**查看/编辑 UI**，让陈旧 workaround 能自动重测、也能人工干预：

1. **生命周期**：每条记录带 `firstLearnedAt` / `lastConfirmedAt`，**按分类可配 TTL（默认 30d）、到期自动过期**；每条可 **pin（永不过期）**。
2. **后端管理 API**：新 `/api/negotiation` 路由暴露分组快照 + 编辑动作 + 整体导出。
3. **ui-v4 页面**：按 10 个功能分组查看、整体导出（完整 v2 JSON）、四个编辑动作 —— **续约 / 立即失效（不删除）/ pin·unpin / 删除**。

### 非目标 / 明确排除

- **app-wide i18n 框架**：ui-v4 当前无 i18n（nav 英文 + body 混排中文）。本特性沿用该约定（nav `Learned` + body 中文），**不**引入 i18n 框架 —— 记为 deferred backlog，若日后要全站双语再单独立项。
- 不改变 workaround 的**学习触发逻辑**（各 reactive-rejection 策略的 matcher 不动），只改「学到后如何存 / 何时失效 / 如何暴露管理」。

## 3. 验收标准（Acceptance Criteria）

- AC1 迁移：加载旧 v1 `negotiation-states.json` 后，每条记录得到 `firstLearnedAt = lastConfirmedAt = 载入时刻`、`migrated: true`、`pinned: false`；下次 persist 写 `version: 2`；legacy `serverToolHistoryDowngrade` 仍被读取。
- AC2 过期：非 pin、非 manuallyExpired 的记录在 `now > lastConfirmedAt + categoryTTL` 时，**所有消费点**读作「未学过」（workaround 不施加）。
- AC3 pin：`pinned: true` 的记录永不过期，无视 TTL 与 manuallyExpired。
- AC4 再确认：上游对某记录再次拒绝触发 `markX` 时，即使 value 已存在也刷新 `lastConfirmedAt=now`、清 `manuallyExpired`、并 schedulePersist。
- AC5 编辑动作经 API 生效并持久化：续约（刷新 lastConfirmedAt + 清 manuallyExpired）、立即失效（manuallyExpired=true，保留行）、pin/unpin、删除（移除行）。
- AC6 整体导出：`GET /api/negotiation/export` 返回完整 v2 数据集 JSON（附下载头），可作为 `negotiation-states.json` 再导入。
- AC7 UI：10 分组分节展示，每行显示 model/key、value、状态徽章、firstLearnedAt/lastConfirmedAt（相对时间）、过期时间、四个动作按钮；空分组折叠；顶部「整体导出」+ 状态筛选。
- AC8 配置：`negotiation_learning.default_ttl` + 按分类 `ttl.<category>` 可配，`never`/`0`/`null` = 不自动过期。

## 4. 设计

### 4.1 数据模型（`negotiation-states.json` v1 → v2）

每条叶子记录（分类 × key × value）挂元数据：

```ts
interface LearnedEntryMeta {
  firstLearnedAt: number    // epoch ms
  lastConfirmedAt: number   // epoch ms — 每次上游再确认 / 用户续约时刷新
  pinned?: boolean          // true = 永不过期（无视 TTL / manuallyExpired）
  manuallyExpired?: boolean // 立即失效：强制过期但保留行；再确认 / 续约时清除
  migrated?: boolean        // 由 v1 永久记录迁移而来，firstLearnedAt 非真实首学时刻
}
```

**内存表示**：
- `Map<string, Set<string>>` → `Map<string, Map<string, LearnedEntryMeta>>`（features/betas/deferredTools/serverTools/partnerFeatures/toolFields）。
- 扁平集合 `Set<string>` → `Map<string, LearnedEntryMeta>`（effortUnsupported/systemRejectModels/serverToolDowngrade）。
- `efforts`：`Map<model, { values: string[]; meta: LearnedEntryMeta }>`（value 维度是整条 effort list，一模型一 meta）。

**持久化 v2 文件形状**：

```jsonc
{
  "version": 2,
  "features": { "<modelKey>": { "<field>": <meta> } },
  "betas": { "<modelKey>": { "<beta>": <meta> } },
  "efforts": { "<model>": { "values": ["low","high"], "meta": <meta> } },
  "effortUnsupported": { "<model>": <meta> },
  "deferredTools": { "<modelKey>": { "<tool>": <meta> } },
  "serverTools": { "<modelKey>": { "<prefix>": <meta> } },
  "partnerFeatures": { "<modelKey>": { "<feature>": <meta> } },
  "systemRejectModels": { "<model>": <meta> },
  "serverToolDowngrade": { "<model>": <meta> },
  "toolFields": { "<endpointKey>": { "<field>": <meta> } }
}
```

**迁移**（load 时，AC1）：读到 `version !== 2` 的旧数组/集合，逐值合成 meta（`firstLearnedAt = lastConfirmedAt = Date.now()`、`migrated: true`、无 pin）。继续兼容读 legacy `serverToolHistoryDowngrade`。下次 `schedulePersist` 落 `version: 2`，旧键自然消失。

**为何存事实、派生过期**（richest-data-flow）：只存 `firstLearnedAt` / `lastConfirmedAt` / `pinned` / `manuallyExpired` / `migrated`，**不存 `expiresAt`**——过期在读取/展示时按当前 config TTL 派生，这样改 config 能追溯生效、不留陈旧派生值。

### 4.2 过期 / pin / TTL 语义（单一共享 primitive）

```ts
function categoryTtlMs(category: NegotiationCategory): number // config，默认 30d；never → Infinity

function isEntryActive(meta: LearnedEntryMeta, category: NegotiationCategory, now: number): boolean {
  if (meta.pinned) return true
  if (meta.manuallyExpired) return false
  const ttl = categoryTtlMs(category)
  return ttl === Infinity || now <= meta.lastConfirmedAt + ttl
}
```

**消费点全量 gate（不变量关键 — 漏一个则过期记录仍生效，AC2）**。所有读取型消费函数在返回前用 `isEntryActive` 过滤：

- `isAnthropicFeatureUnsupported` / `getUnsupportedFeatures`
- `isAnthropicBetaUnsupported`
- `getSupportedEfforts`
- `isEffortUnsupported`
- `isToolStickyUndeferred` / `getStickyUndeferredTools`
- `getUnsupportedServerToolTypes`
- `isAnthropicPartnerFeatureUnsupported`
- `isSystemRejectModelLearned`
- `isServerToolDowngradeLearned`
- `getUnsupportedToolFields`

实现纪律：先 `grep` 全仓这些符号的调用点、逐一核对（方法论见记忆 [fix-all-comparison-sites]），每分类配一条「过期后不再施加」的守卫测试。

**自然重测环**：过期记录读作「没学过」→ workaround 不施加 → 上游再拒 → 对应 reactive-rejection 策略再学 → `markX` 刷新 `lastConfirmedAt`。无需独立的重测调度器。

**`markX` 改为再确认（AC4）**：现有 `addToSetMap` 在 value 已存在时返回 false、不 persist。改为：即使已存在，也 `lastConfirmedAt = now`、清 `manuallyExpired`、`schedulePersist`（debounce 1s 吸收高频）。新建时另设 `firstLearnedAt`。

### 4.3 按分类可配 TTL（config.yaml 新段，AC8）

```yaml
negotiation_learning:
  default_ttl: 30d          # 未列出的分类用此值
  ttl:
    tool_fields: 90d        # endpoint 级、稳定
    partner_features: never # org policy、极稳定，永不自动过期
    # features / betas / efforts / ... 省略 → default_ttl
```

- `never` / `0` / `null` → `Infinity`（不自动过期，除非手动失效）。
- 沿用项目既有 duration 解析风格（参考 `reaper_interval` / `stale_request_max_age` / `extended_cache_ttl`），落进 state 的 negotiation 配置切片；`config.ts` 增 `negotiation_learning` 解析分支。

### 4.4 后端 API（新 `src/routes/negotiation/route.ts`，`OpenAPIHono`，挂 `/api/negotiation`）

| 方法 | 路径 | 请求 | 作用 |
|---|---|---|---|
| GET | `/` | — | 分组快照（见下） |
| POST | `/renew` | `{category,key,value}` | 续约：`lastConfirmedAt=now`、清 `manuallyExpired` |
| POST | `/expire` | `{category,key,value}` | 立即失效：`manuallyExpired=true`（保留行） |
| POST | `/pin` | `{category,key,value,pinned:boolean}` | 切换永不过期 |
| DELETE | `/entry` | `{category,key,value}` | 彻底删除该行 |
| GET | `/export` | — | 完整 v2 数据集 JSON（`Content-Disposition: attachment`） |

**分组快照响应**（richest-data-flow — 后端算全、前端选择性呈现）：

```ts
interface LearnedSnapshot {
  categories: Array<{
    category: NegotiationCategory
    ttlMs: number | null           // null = never
    entries: Array<LearnedEntryView>
  }>
}
interface LearnedEntryView {
  category: NegotiationCategory
  key: string                       // 扁平集合为 ""
  value: string                     // efforts 为 model；其余为叶子值
  detail?: unknown                  // efforts.values 等附加数据
  firstLearnedAt: number
  lastConfirmedAt: number
  expiresAt: number | null          // 派生；pin/never → null
  status: "active" | "expired" | "pinned" | "manually_expired"  // 后端区分四态
  pinned: boolean
  migrated: boolean
}
```

条目统一用 `(category, key, value)` 寻址（扁平集合 key=""）。feature-negotiation.ts 增 `renewEntry` / `expireEntry` / `setPinned` / `deleteEntry` / `getGroupedSnapshot` / `exportAll` + 一个 `(category,key,value) → 目标 map` 的 resolver（穷尽 10 分类 —— 用 `satisfies Record<NegotiationCategory, …>` 逼编译期完备，方法论见记忆 [route-variant-to-existing-outcome]）。

路由在 `src/routes/index.ts` 挂 `app.route("/api/negotiation", negotiationRoutes)`。

### 4.5 前端页面（`ui-v4/src/components/learned/`）

- **导航 / 路由**：NavRail 加 `{ to: "/learned", label: "Learned" }`；App.tsx 加 `{ path: "learned", element: <LearnedPage /> }`。
- **数据层**：`useLearned()`（react-query）GET `/api/negotiation` + renew/expire/pin/delete mutations（`onSuccess` invalidate）。给 [api.ts](../../ui-v4/src/lib/api.ts) 补 `post` 方法。
- **类型**：经 `~backend/*` re-export API 响应类型（`LearnedSnapshot` / `LearnedEntryView` / `NegotiationCategory`），SSOT-types。
- **页面结构**：
  - 顶部：**「整体导出」**按钮（`getBlob('/api/negotiation/export')` → 复用既有下载 util 存 JSON）+ 状态筛选（全部 / active / 已过期 / pinned）。
  - **10 个功能分组**分节：节头显示分类中文名 + TTL + 条目数；空分组折叠/隐藏。
  - 每行：model/key、value、**状态徽章**、firstLearnedAt / lastConfirmedAt（相对时间，`migrated` 加「迁移·首学未知」提示）、过期时间；行内动作 **续约 / 立即失效 / pin·unpin / 删除**（删除二次确认）。
  - **状态徽章合并**（用户决定）：UI 把 `expired` 与 `manually_expired` **合并为一个「已过期」徽章**；后端 status 仍区分四态（数据完整、可导出/诊断区分）。徽章三态：`活跃` / `已过期` / `已固定`。

### 4.6 测试

- **后端单元**（bun，`useIsolatedRuntime` + DI 临时目录，见 skill `test-isolation`）：
  - v1→v2 迁移（含 legacy 键）。
  - `isEntryActive` 覆盖 pinned / manuallyExpired / TTL 到期（`fake timers`）。
  - `markX` 再确认刷新 `lastConfirmedAt` + 清 `manuallyExpired`。
  - **每消费点一条守卫测试**：过期后该 workaround 不再施加（10 分类各一）。
  - 四个 mutation（renew/expire/pin/delete）+ resolver 完备性。
- **API 集成**：GET 分组 / renew / expire / pin / DELETE / export。
- **前端 vitest（jsdom）**：分组渲染、动作触发 mutation、导出触发下载；**须跑 `build:ui`（rollup）非仅 vitest**（`~backend/*` 纯度，见 skill `debugging-frontend-tests`）。

## 5. 未采纳 / 记录

- **导出 CSV**：未采纳。整体导出用完整 v2 JSON（含全部元数据 + 派生状态），信息最全、可再导入。
- **默认永久（仅手动失效）**：未采纳。用户选「有限默认 TTL 30d + 自动过期 + 分类可配 + pin 永不过期」。
- **存 `expiresAt` 而非派生**：未采纳。派生保证改 config TTL 可追溯生效。
- **app-wide i18n 框架**：本特性排除，记为 deferred backlog（见 §2 非目标）。

## 6. 影响面 / 风险

- **行为变更**：既有永久记录迁移后 30d 起开始自动过期 → 稳定不兼容（Vertex org policy、endpoint 级 toolFields）每 TTL 会多一次 400 重测往返 —— 已用「按分类可配 + partner_features/tool_fields 设长/never」缓解。
- **不变量风险**：消费点 gate 必须穷尽，漏一个则过期记录仍生效 —— 靠 grep 全量 + 每分类守卫测试兜底。
- **无向后兼容负担**：v1→v2 单向迁移，旧格式读时适配、写时升级，不留双轨。
