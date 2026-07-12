# Spec: cache_control 子字段剥离 + sanitize 语义收窄

- 状态：**已实施（landed master，2026-07-12）** —— 三阶段全落地，见 plan `docs/plan/2026-07-12-cache-control-subfield-stripping/`。实现期三处偏离：① `resolveSanitizedTtls` 收窄为「仅规范化已有断点、缺层 undefined」（sanitize NOT 注入）；② proxied 未收口到共享原语（sanitize/proxied TTL 语义本质不同，各自 owner）；③ history 标记**双通道**——`recordFeature("cache-control-stripped")` 记 live TUI/WS 看板 + `pipelineInfo.cacheControlStripped` 持久化 history（合并态审查 HIGH-1 修正：feature_applied 被 history sink 丢弃、只走 recordFeature 不落盘；改经 pipelineInfo 这个 prepare 诊断持久容器，弃跨端点共享 WireRequest 加专属字段的 SSOT smell）。
- 日期：2026-07-12
- 归属：`docs/spec/`（模块契约 / 兼容行为，见 CLAUDE.md 文档路由）
- 相关：ADR `docs/decisions/2026-07-05-richest-data-flow.md`、skill `ghc-api-reference` / `ghc-anthropic-upstream`

## 1. 问题（What & Why）

### 1.1 触发实例

Claude Code 2.1.206（`agent-sdk/0.3.199`）经本项目 `anthropic-messages` 端点请求 `claude-opus-4-8`，上游返回：

```
HTTP 400  system.1.cache_control.ephemeral.scope: Extra inputs are not permitted
request_id: req_011CcwL3uKA8N7zE8HoQsNQi
```

实测原始请求（`/mnt/q/my/Downloads/req_1783821234150_118_claude-opus-4.8.json.zst`）确认：

```json
system[1].cache_control = { "type": "ephemeral", "scope": "global" }   // 400 元凶
system[2].cache_control = { "type": "ephemeral" }                       // 正常
```

请求头 `anthropic-beta` 含 `prompt-caching-scope-2026-01-05`。即 `scope: "global"` 是 Claude Code 的正规新特性（全局作用域 prompt cache），由该 beta 启用。**GHC 上游（→ Anthropic 后端）未启用此 beta**，于是把 `scope` 当未知字段拒绝。request_id 是 Anthropic 格式，因为 GHC 把后端校验错误透传回来。

### 1.2 根因

本质是「**客户端 beta 集合 ⊋ GHC 支持的 beta 集合**」。Claude Code 持续发送 GHC 未必支持的新 beta（同请求还有 `mid-conversation-system-2026-04-07`、`advanced-tool-use-2025-11-20`、`effort-2025-11-24` 等）。`scope` 是首个「往 body 现有字段内部塞子字段」的形态，恰好被现有的顶层字段剥离机制漏过——现有 `collectRejectedFields` 剥的是**顶层 body 字段**，`filterUnsupportedBetas` 剥的是**beta token**，`stripToolFields` 剥的是**tool 顶层字段**，**没有「cache_control 内部子字段」这个粒度**。

### 1.3 为何默认 passthrough 会漏

`cacheControlMode` 默认 `passthrough`（[state.ts:1390](../../src/lib/state.ts#L1390)），[applyCacheControlMode](../../src/lib/anthropic/request-preparation.ts#L916) 的 `case "passthrough"` 纯 `break`，原样转发 → `scope` 直达上游 400。而 `sanitize`（整体重建 cache_control）与 `proxied`（全删客户端 cache_control 再自注入）走的是「重建/全删」语义，对 `scope` 天然免疫，但代价是丢弃客户端精调的断点。

## 2. 目标与非目标

### 目标
- **G1**：消除 `cache_control.scope` 类 400，且**保留** passthrough 的客户端精调断点（只挖已知地雷，不整体重建）。
- **G2**：一般化——未来任何新的「GHC 未支持 cache_control 子字段」踩一次 400 即自愈，零改代码。
- **G3**：收窄 sanitize 语义，使其「规范化」职责不再越权替客户端做 TTL 降级决策。

### 非目标
- 不改 proxied（其「全删客户端断点、GHC 式重建」是刻意语义，不涉及保留客户端 ttl；但复用 §4.4 共享 TTL 原语）。
- 不处理「GHC 未支持 beta」的其他形态（如顶层新字段、tool 新字段）——那些已有对应机制。本 spec 只补 cache_control 子字段这一粒度缺口。
- **不剥 `prompt-caching-scope` beta 头**——实测证实 beta 头单独无害（§8），只剥 body 子字段。
- 不做白名单法（见 §11 决策记录）。
- 不在本轮收敛 6 套同构 strip 机制（记入 backlog，见 §9）。

## 3. 方案总览（判据）

| 决策 | 取值 | 判据 |
|---|---|---|
| 剥离策略 | **黑名单 B + 反应式学习 C** | 黑名单只剥确认地雷、不误杀 GHC 其实支持但我们没登记的字段（GHC 总滞后于 Claude Code）；反应式补「新字段先踩一次 400」的缺口 |
| 作用范围 | **仅 passthrough** | sanitize/proxied 对未知子字段已免疫，无需接黑名单/学习集 |
| sanitize | **收窄：保留客户端合法 ttl** | 剥非法子字段是其应有之义，但强制 TTL 降级是越权；TTL 覆盖应由 extended 特性以「只升不降」叠加 |
| 学习键 | **endpoint-level（model-agnostic）** | 「GHC 未支持某 cache_control 子字段」是上游版本属性、非 per-model，对齐 tool-field-rejection |

## 4. Phase 0：sanitize 语义收窄

### 4.1 现状（越权）

[applyCacheControlMode](../../src/lib/anthropic/request-preparation.ts#L924) 的 sanitize：

```ts
walkCacheControl(wire, (_current, section) => (section === "messages" ? messagesEphemeral : toolsSystemEphemeral))
```

丢弃 `_current`，无条件换成层预算对象（`ephemeralFor(layerTtl)`）。这把两件事混在一起：① 剥掉非 `{type,ttl}` 子字段（正确）；② **无条件设定 TTL**（越权——extended 未激活时，客户端的 `ttl:"1h"` 被误降为 5m 默认）。

### 4.2 新语义

sanitize 改为「保留白名单字段 `{type, ttl}` 重建」，TTL 取「客户端合法 ttl」与「extended 升级值」的 max（只升不降）：

```
sanitizeOne(current, section):
  result = { type: "ephemeral" }
  clientTtl  = current.ttl in {"5m","1h"} ? current.ttl : "5m"
  layerTtl   = extendedTtlActive ? (section=="messages" ? messagesTtl : toolsSystemTtl) : "5m"
  perLayer   = max(clientTtl, layerTtl)   // 顺序 5m < 1h；只升不降（对单块而言）
  # 关键：perLayer 只是候选，最终值还须过 §4.4 的跨层排序守卫
  if perLayer == "1h":  result.ttl = "1h"
  return result   // scope 等非白名单子字段：只挑 type+ttl 重建，自动剥除
```

**但 §4.4 的跨层排序守卫必须叠加在 per-layer max 之上**——单块 max 不够，见下。

### 4.3 承重不变量：Anthropic 跨层 TTL 排序（评审 C1/HIGH-1，独立交叉确认）

**约束（代码钉死的 oracle，非本 spec 自述）**：Anthropic 要求「更长的 TTL 必须在 tools→system→messages 前缀顺序中更早出现」，即最终 wire 必须满足 `ttl(tools) ≥ ttl(system) ≥ ttl(messages)`。证据：[resolveExtendedTtls](../../src/lib/anthropic/request-preparation.ts#L176) 主动把 messages 从 1h clamp 到 5m + 注释 "Anthropic requires longer TTLs to appear earlier"；[schema.ts](../../src/lib/config/schema.ts#L417) 同款注释。作者的主动 clamp 就是「此约束真实存在」的确认。

**旧 sanitize 为何意外安全**：旧 handler 对 extended 未激活时两层都塌缩成 `ephemeralFor("5m")`（同值），意外掩盖了任何跨层排序违规。**§4.2 的忠实保留会把这个被意外防住的违规重新引入**——正是本 spec 要消灭的那类 400。这是最初 §4.4「按 invariant 自定」恰恰漏掉的那个 invariant。

**裁决**：per-layer max 之后，**必须再过一遍跨层单调化**——沿 tools→system→messages 把后层 ttl clamp 到 ≤ 前层（`ttl(messages) ≤ ttl(system) ≤ ttl(tools)`），复用与 `resolveExtendedTtls` 同一方向的排序守卫。

**tension 的显式裁决**：这与「不替客户端降级」存在真实张力——排序守卫会强制降低后层。裁决理由：被降的是**本就非法、上游必拒或必降的客户端组合**（如 `system=5m + messages=1h`），修正非法输入 ≠ 越权降级合法诉求；且降的方向（降后层 messages，非升前层）与现有 clamp 完全一致，同样被代码钉死。合法组合（`ttl(tools)≥ttl(system)≥ttl(messages)`）零影响。

### 4.4 共享 TTL 决策原语（评审 MEDIUM-2）

抽出 `resolveSanitizedTtls(perLayerClientTtls, extendedActive): { tools, system, messages }`，**单一 owner** 集中三件事：① per-layer `max(clientTtl, layerFloor)`；② extended 激活时的 messages≤tools_system clamp（现 `resolveExtendedTtls` 逻辑内聚进来）；③ §4.3 的跨层单调化。sanitize handler 与 proxied inject 都经此原语取 ttl，消除「三个写 TTL 站点各自为政」（sanitize handler / proxied `ephemeralFor` / extended clamp）。这才是 G3「sanitize 只规范化、TTL 决策归单一 owner」的**结构性**落地，而非仅换公式贴标签。

### 4.5 行为矩阵（跨层组合，含 C1 用例）

单块视角（extended 未激活）：

| 客户端 cache_control | 输出 |
|---|---|
| `{ephemeral}` | `{ephemeral}` |
| `{ephemeral, ttl:1h}` | `{ephemeral, ttl:1h}`（保留，现状误降 5m） |
| `{ephemeral, ttl:1h, scope}` | `{ephemeral, ttl:1h}`（剥 scope、保 ttl） |

跨层视角（承重，golden 必测）：

| 场景 | tools | system | messages | 输出（tools/system/messages） |
|---|---|---|---|---|
| 合法递减 | 1h | 5m | 5m | 1h / 5m / 5m（原样） |
| **C1 非法组合** | — | 5m | 1h | — / 5m / **5m**（messages 被排序守卫降到 ≤system） |
| extended 激活 + 客户端全 5m | — | — | — | 按 layerFloor 升级，仍满足递减 |

### 4.6 可观测变化（评审 M2 修正）

Phase 0 有**两处**可观测变化，golden 须同时锁：
1. **body**：extended 未激活时客户端合法 `ttl:1h` 不再被误降 5m（§4.5 单块表）。
2. **anthropic-beta 头**：因 body 现在可能保留 1h ttl，[wireHasOneHourTtl](../../src/lib/anthropic/request-preparation.ts#L192) → `ctx.wroteExtendedTtl` → mirror `extended-cache-ttl-2025-04-11` beta（[L326](../../src/lib/anthropic/request-preparation.ts#L326)/[L952](../../src/lib/anthropic/request-preparation.ts#L952)）。旧语义此场景降 5m、不发 beta；新语义保 1h、发 beta。这是**头部 delta**，非只 body。

### 4.7 golden 测试

改动前先捕获现有 sanitize 对上述矩阵的输出（锁旧行为），改后断言新矩阵，**须含跨层组合样本 + 头部 delta 断言**（不能只测孤立单块、只锁 body）。C1 非法组合行是必测项。

## 5. Phase 1：passthrough 黑名单子字段过滤

### 5.1 读取端（三源 union，对齐 [collectStripBetas](../../src/lib/anthropic/request-preparation.ts#L228)）

新增 `collectUnsupportedCacheControlSubfields(model, hints?): Set<string>`，union **四源**（对齐 [collectStripBetas](../../src/lib/anthropic/request-preparation.ts#L228) + tool-field 的 per-attempt hint 通道）：

- **源① 内置硬编码**：`{ "scope" }`（确认地雷，默认生效，无需 config 显式开——它是 bug 修复非可选增强）
- **源② config**：新键 `anthropic.strip_cache_control_subfields`，`Record<modelPattern, string[]>`，per-model + 通配 `"*"`，经 `collectAllMatching(model, state.stripCacheControlSubfields)` 合并
- **源③ negotiation 学习集**：Phase 2 才写入。**Phase 1 明确缺席**（见 §5.3 对 LOW-1 的裁决）——union 表达式在 Phase 1 不含源③调用，Phase 2 加一行 union，读取端**签名不变**（`Set` 结果类型不变）但表达式改动一行。不再宣称"读取端零改动"，只宣称"读取端结构与签名稳定"。
- **源④ per-attempt hint**：`prepareHints.excludeCacheControlSubfields`（Phase 2 的 retry 腿注入）。对齐 [excludeToolFields](../../src/lib/anthropic/request-preparation.ts#L133) / [excludeBetas](../../src/lib/anthropic/request-preparation.ts#L261) 的 per-attempt deterministic 契约（不依赖 cache 已写）。Phase 1 亦缺席，与源③同批加入。

### 5.2 filter 原语（保对象、删子字段）

现有 [walkCacheControlArray](../../src/lib/anthropic/request-preparation.ts#L1181) handler 契约是 **return-based**（返回替换对象 → 整体 replace；返回 undefined → 删除整个 cache_control）。本 filter 要的是**第三种语义：部分变更**（原地 `delete cc[field]`、保留其余）。落地方式明确为：handler 内 `for (const f of blacklist) delete cc[f]` 后 **`return cc`（identity）**，走 replace 分支但对象不变——**不得**返回 undefined（那会删掉整个 cache_control，退化成 disabled 语义）。复用同一 system/messages/tools + 嵌套 content 递归骨架，避免第二套遍历逻辑。

不变量：
- **保留** `type` / `ttl` / 一切非黑名单字段（含未来合法字段——黑名单法不误杀）。
- 黑名单为空时**完全不动** wire（Phase 1 若源①被 config 清空 → no-op）。
- 覆盖嵌套：`message.content[].cache_control`、`tool_result.content[].cache_control`。
- **system 为 string 时 no-op**（string 无处挂 cache_control）；**Anthropic schema 无顶层 cache_control**——二者作为显式不变量 + 测试断言，非隐含（评审 L2 核实为非问题，但须显式声明）。

### 5.3 源③/④ 在 Phase 1 的归属（评审 LOW-1）

评审指出「读取端零返工」与「接口留空」自相矛盾：若 Phase 1 就调 `getUnsupportedCacheControlSubfields()`，则是无写入者的 stub（近似死代码，违背 large-refactor 过渡态显式无害）；若不调、Phase 2 再加，则读取端在 Phase 2 确实改了。**裁决取后者**：Phase 1 的 union 表达式**不含**源③/④（无 stub、无死代码）；Phase 2 一次性加入源③（negotiation）+源④（hint）两行 union。措辞从「读取端零改动」修正为「读取端**函数签名与遍历结构**稳定，Phase 2 仅在 union 表达式追加两源」。

### 5.4 接线

[applyCacheControlMode](../../src/lib/anthropic/request-preparation.ts#L921) 的 `case "passthrough"`：`break` 前调用 filter。`disabled`/`sanitize`/`proxied` 不动。

`ctx.wroteExtendedTtl` = `wireHasOneHourTtl(wire)` 逻辑不变（passthrough 客户端 1h 断点仍被正确 mirror 到 beta 头）。

### 5.5 config / state 落点（对齐 stripBetaHeaders 三处）

- schema.ts：加 `strip_cache_control_subfields`（`Record<string, string[]>`，nullable），紧邻 [cache_control](../../src/lib/config/schema.ts#L413)
- state.ts：加 `readonly stripCacheControlSubfields: Record<string, Array<string>>` + clone 逻辑（[801/837 附近](../../src/lib/state.ts#L801)）+ CONFIG_MANAGED_DEFAULTS（[1473/1477 附近](../../src/lib/state.ts#L1473)，默认 `{}`）+ patch 键白名单（[1175/1179 附近](../../src/lib/state.ts#L1175)）
- 注意：源①内置 `{scope}` 在**读取端**注入，不在 config 默认值里（config 默认 `{}` 表示"无额外覆盖"，与内置正交）

### 5.6 测试

单元覆盖：剥 `scope` / 保留合法 `ttl`+`type` / per-layer（system·messages·tools）/ 嵌套 tool_result.content / config 追加字段生效 / 空黑名单 no-op / system=string no-op / passthrough 保留其余客户端断点不变。集成：模拟 §1.1 的实测 body，断言过 passthrough 后 `system[1].cache_control == {type:ephemeral}`（scope 已剥）、`system[2]` 不变、且 history 的 `pipelineInfo.cacheControlStripped == ["scope"]` 可辨识标记（§8 静默降级可观测性；注：**不能**走 `recordFeature` 单通道——feature_applied 被 history sink 丢弃、只到 live TUI）。

## 6. Phase 2：反应式学习腿

### 6.1 negotiation cache（endpoint-level）+ 新分类的完整扇出（评审 H2）

feature-negotiation.ts 加 `markAnthropicUnsupportedCacheControlSubfield(field)` / `getUnsupportedCacheControlSubfields(): string[]`，键控 endpoint（model-agnostic），对齐 [markAnthropicUnsupportedToolFields](../../src/lib/anthropic/feature-negotiation.ts#L402)。

**⚠️ 新增 `NegotiationCategory` 的爆炸半径（评审核实，非"加两个函数"那么小）**：接入 Learned 页生命周期需新增分类 `"cacheControlSubfields"`，它扇出到以下**必改点**（不改则编译失败），plan 拆分须按此计工作量：

1. [negotiation-lifecycle.ts:22](../../src/lib/anthropic/negotiation-lifecycle.ts#L22) `NegotiationCategory` union + [:35](../../src/lib/anthropic/negotiation-lifecycle.ts#L35) `NEGOTIATION_CATEGORIES` 数组 + `categoryTtlMs` 分类 TTL
2. [feature-negotiation.ts:668](../../src/lib/anthropic/feature-negotiation.ts#L668) `locateMeta` 的 `const _exhaustive: never = category` 守卫 → **不补 case 编译报错**
3. [feature-negotiation.ts:712](../../src/lib/anthropic/feature-negotiation.ts#L712) `deleteLocated` 同款 `never` 守卫
4. [feature-negotiation.ts:439](../../src/lib/anthropic/feature-negotiation.ts#L439) `NegotiationStateFileV2` 接口新增字段 + [:471](../../src/lib/anthropic/feature-negotiation.ts#L471) `buildV2Snapshot`
5. [feature-negotiation.ts:563](../../src/lib/anthropic/feature-negotiation.ts#L563) `loadPersistedFeatureNegotiation`（加 loadRecordMap + count 累加）
6. [feature-negotiation.ts:788](../../src/lib/anthropic/feature-negotiation.ts#L788) `getGroupedSnapshot` 的 `recordMaps` 数组
7. state.ts `negotiationTtlOverridesMs` 分类
8. `/api/negotiation` 管理 API + ui-v4 Learned 页分类渲染

「读取端签名稳定」成立，但**写入侧（negotiation plumbing）是完整一套**，不是 spec v1 暗示的「一行」。这是 completeness 要求的一部分（against-YAGNI：Learned 页管理该做），只是须据实计量。

### 6.2 retry strategy

match `<section>.N[...].cache_control.<variant>.<field>: Extra inputs are not permitted`，`matchAll` 解析全部字段（多字段一次剥，对齐 tool-field H1），mark → `prepareHints.excludeCacheControlSubfields`（§5.1 源④）剥掉重试。手写（非 `createReactiveRejectionStrategy`），因为 batch matchAll + model-agnostic mark 不匹配原语的 single-token/per-model 形状（与 tool-field 同理）。

### 6.3 遮蔽风险（承重，评审 H1 已实测三路径）

`Extra inputs` 已被 [tool-field](../../src/lib/request/strategies/tool-field-rejection-retry.ts#L84)（`/tools\.\d+\.\w+\.([a-z_]\w*):/`）与 body-field（`/(?<![.\w])([a-z_]\w*):\s*Extra inputs/i` top-level lookbehind）两 matcher 认领。评审对三条实际错误路径**逐位推演**证实新腿不被遮蔽（正向已证，非自证）：

| 错误路径 | tool-field | body-field | 结论 |
|---|---|---|---|
| `system.1.cache_control.ephemeral.scope: ...` | 无 `tools.` 前缀 → 不匹配 | `scope` 前缀是 `.`/`\w` → lookbehind 排除 → 不匹配 | 安全 |
| `tools.0.cache_control.ephemeral.scope: ...`（**最险，共享 `tools.` 前缀**）| `[a-z_]\w*:` 要匹配 `ephemeral.scope:` 但 `ephemeral` 后是 `.` 非 `:`（4 段 vs 正则 3 段）→ 不匹配 | 同上排除 → 不匹配 | 安全 |
| `messages.0.content.1.cache_control.ephemeral.scope: ...` | 无 `tools.` → 不匹配 | 同上排除 → 不匹配 | 安全 |

**认领归属回归测试必须显式含上表三条路径**（尤其 `tools.N.cache_control.*` 这条最险的近似命中，spec v1 只列了 system 路径，遗漏它是不完整自证）。教训：记忆 `methodology-new-strategy-shadowed-by-broader-first-match`。driver ordering 经 [strategies.ts](../../src/lib/codec/anthropic/strategies.ts) 确认（tool-field 排 body-field 前、两者对 cache_control 错误均返 null）。

### 6.4 reactive → proactive 收敛

学到的字段经 §5.1 源③（+同请求内源④ hint）自动进入下次请求的 passthrough 预剥（学一次 → 后续预剥，对齐 tool-field 双层）。

## 7. 已知限制（评审 MEDIUM-1，黑名单固有代价）

黑名单法的对称代价（§8「否 A」只讲了优点，此处补齐）：

- **Phase 0+1-only 中间态**：源③/④ 未接入，任何**新的非 scope 子字段**会**每次硬 400、永不自愈**，直到运维手动写 config 或 Phase 2 上线。
- **即使 Phase 2 到位**：每个真正的新子字段**首次仍必付一次 400 往返**（黑名单固有——retry 把它透明化为一次延迟而非失败，但冷缓存首次不可免）。
- **G2「零改代码自愈」仅在 Phase 2 落地后成立**。据 against-YAGNI，**Phase 2 不得延后/砍掉**——它是 G2 的唯一保证。若资源受限只能先做 Phase 0+1，须显式告知「新子字段仍会硬 400」这一中间态限制。

## 8. beta 头接缝与静默降级可观测性（评审 MEDIUM-3）

**承重实测事实（否定性结论，不自证）**：§1.1 原始请求**同时**带 `prompt-caching-scope-2026-01-05` beta 头**和** body 里的 `scope`，而 400 **只报 body 子字段**。[buildAnthropicHeaders](../../src/lib/anthropic/request-preparation.ts#L329) 经 `mergeAnthropicBeta` 把客户端 beta 转发到上游（注释 "so SDK-provided betas survive"），即 beta 头确实到了 GHC 却未引发 beta 类 400。**结论：beta 头单独无害，无需剥**——§2 非目标「beta 头已有对应机制」成立（真要 400，现成 `unsupported-beta-retry` + `filterUnsupportedBetas` 会学习剥掉）。

**两点须记录**：
1. `prompt-caching-scope` 是**一个特性、两个表面**（beta 头 + body 子字段），由两套互不协调的机制处理（beta negotiation vs 本 spec 的子字段剥离），各自独立 400/自愈、不同步。
2. **静默语义降级不可观测**：剥掉 body scope 后 beta 头仍在，客户端**以为**拿到 global-scope 缓存、实际退回默认 scope。按 [richest-data-flow ADR](../decisions/2026-07-05-richest-data-flow.md)「注入真实流的合成/误导物必须可辨识」，此「客户端预期 vs 实际」落差目前完全不可见。**决策**：Phase 1 剥 scope 时，在 history 记一条可辨识标记（如 `strippedCacheControlSubfields: ["scope"]`），让运维能看出缓存语义被降级，而非 history 里一切正常。落点对齐现有 `strippedToolFields` meta（[tool-field strategy](../../src/lib/request/strategies/tool-field-rejection-retry.ts#L151)）。

## 9. 与既有 negotiation-strip 家族的关系（评审 MEDIUM-4）

本 spec 新增的是**第 6 套**近乎同构的「`collectAllMatching(config) ∪ negotiation cache ∪ per-attempt hint → strip + 手写 reactive strategy`」机制（已有：betas / body-fields / tool-fields / server-tools / partner-features）。`scope` 揭示的更一般问题是「**任意嵌套子对象里 GHC 落后的字段**」（不止 cache_control——output_config / thinking / tool.custom 内部都可能重演）。

**决策（record-not-adopted + 记入 backlog）**：本轮**仍手搓** cache-control-subfields 这一套，理由：① 与 tool-field 逐字同构、落地风险已知可控；② 抽「negotiated strip target 通用注册表（路径 + 学习键 + 剥离原语）」把 6 套收敛成配置化一套，是独立的大型重构，不应阻塞本次 scope 400 修复。**但**「嵌套子字段剥离一般化 + 6 套 strip 机制收敛」记入 [docs/todo/deferred-backlog.md](../todo/deferred-backlog.md)（含根因/当前行为/理想架构/为何暂缓/若做需改什么），避免第 7 个 case 再建第 7 套。这符合 `spot-unneeded-homegrown` + `learn-by-analogy`——发现规律并登记，而非静默重复造轮。

## 10. 分阶段与验证

- **Phase 0** 独立可测可提交（sanitize 收窄 + 跨层单调化 + 共享 TTL 原语，golden 跨层矩阵 + 头部 delta）。
- **Phase 1** 独立消除 scope 400（无 driver retry 接线风险）+ history 剥离标记。与 Phase 0 正交（Phase 0 改 sanitize、Phase 1 改 passthrough，互不依赖）。
- **Phase 2** 涉及 negotiation 分类扇出（§6.1 八点）+ retry ordering + 遮蔽验证（§6.3 三路径），风险与体量隔离到独立阶段。
- 读取端函数签名与遍历结构在 Phase 1 建好，Phase 2 在 union 表达式追加源③/④两行（**非**"零返工"，见 §5.3）。
- **empirical-verification**：Phase 1/2 用 §1.1 实测 body 作正样本 oracle 验证剥离触达目标；遮蔽风险用 §6.3 三路径独立回归测试证实，不自证；C1 跨层排序建议写最小探针实测 Anthropic 对 `system=5m + messages=1h` 是硬 400 还是静默降级（无论哪种，单调化守卫都正确——见 §4.3）。

## 11. 决策记录（record-not-adopted）

- **否 A（白名单法）**：白名单会误杀「GHC 其实支持、我们没登记」的字段；GHC 上游总滞后于 Claude Code，白名单等于持续追平 Anthropic 合法字段表。违背 passthrough「保留精调、只挖地雷」+ richest-data-flow。改用黑名单 B（代价见 §7）。
- **否「直接切默认 sanitize/proxied 绕过」**：会丢弃客户端精调断点（sanitize 整体重建 / proxied 全删）。用户明确要保留精调。
- **否「sanitize 不动」（我最初误判）**：曾以「TTL 覆盖是 extended 依赖的」为由主张不改，实为语义耦合——extended 借用 sanitize 的无条件覆盖实现升级，撑大了 sanitize 职责。正确分层：sanitize 只规范化（保留客户端合法 ttl + 跨层排序守卫），TTL 决策归 §4.4 共享原语单一 owner。收窄为 Phase 0。
- **否「sanitize 纯保留客户端 ttl、不加排序守卫」（评审 C1 挡下）**：会产出违反 Anthropic tools→system→messages TTL 递减约束的非法 wire，重新引入本 spec 要消灭的那类 400。改为 per-layer max **叠加**跨层单调化（§4.3）。
- **proxied 不动**：其「全删客户端断点、GHC 式重建」是刻意语义，不涉及保留客户端 ttl；但 §4.4 共享 TTL 原语仍供 proxied inject 复用（消除三站点各自为政）。
- **本轮不收敛 6 套 strip 机制**：记入 backlog，见 §9。
