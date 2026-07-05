# Anthropic 上游客户端头透传 + 头剥离

## Context

排查"剥 attribution header"时实测发现更根本的架构事实：代理对发往 GHC 的上游请求头**从零重建**（`copilotHeaders` 固定 allowlist，[copilot-api.ts:76](src/lib/copilot-api.ts#L76)），客户端入站头里**只有 `anthropic-beta` 的值**被透传，其余（含 Claude Code 注入的 `x-anthropic-billing-header` attribution）在构建上游请求时全被静默丢弃（exp/attribution-header-wire-check/probe.ts 探针实证）。

用户判定这是缺陷：**客户端原生 HTTP 头应默认透传**（未被代理特殊处理的字段），用 `anthropic.strict_request_headers` 控制；`anthropic.strip_request_headers` 剥掉透传里不想发的（默认剥 attribution 保 prompt cache）。

**范围**：仅 Anthropic **v4 codec 路径**。web_search 双跳（6 跳独立 legacy 链、outboundRequest 观测本就空）**不线程化**——保持现状无 passthrough，是安全默认（不泄漏）。OpenAI/Gemini/embeddings/WS/count_tokens 不动。

**已定决策**：① 护栏=core 优先 + 敏感黑名单；② 默认透传（`strict_request_headers` 默认 `false`）；③ `strip_request_headers` 默认 `["x-anthropic-billing-header"]`。

## ⚠️ 关键护栏（两轮 subagent review + 实测裁决）

**`new Headers(record)` 对异大小写同名键是逗号拼接，不是覆盖**（实测：`{authorization:"CLIENT", Authorization:"CORE"}` → `"CLIENT, CORE"`）。故"core 优先靠 spread 顺序"的假设**错误**，会把客户端凭证拼给 GHC。**护栏必须在 merge 之前由 `selectPassthroughHeaders` 把所有 core 键剔除干净，passthrough ∩ core（按 lowercased）= ∅。** `clientRequestHeaders` 取自 `raw.headers`（`Headers.entries()` 规范保证键全 lowercased），与 coreLower/denylist 的 lowercased 比对天然契合。

## 方案

唯一 Anthropic v4 上游头构建点 [buildAnthropicHeaders](src/lib/anthropic/request-preparation.ts#L231)。`strict`/`strip` 标志从 module `state` 读（仿 `collectStripBetas`）；只有 per-request 客户端头需线程化（仿 `clientAnthropicBeta`）。

### 1. helper（src/lib/strip-headers.ts，复用现有 pruneHeaders）
- 复用 `pruneHeaders(Record, patterns)`（现零消费者）作 strip。
- 新增 `selectPassthroughHeaders(clientHeaders, reservedCoreLower)`：返回键 ∉（`reservedCoreLower` ∪ denylist）的子集，lowercased 比对。
- denylist = **精确集** `cookie / x-api-key / api-key / authorization / proxy-authorization / host / content-length / content-encoding / accept-encoding / expect / connection / keep-alive / transfer-encoding / te / trailer / upgrade / via / forwarded / x-real-ip / x-forwarded-for / x-forwarded-host / x-forwarded-proto`（authorization/api-key 虽已被 coreLower 覆盖，仍显式列入作 defense-in-depth）**+ 前缀封堵** `x-github-*`、`openai-*`（代理自有命名空间，除已在 coreLower 的 core 键；防客户端借同命名空间操纵 GHC 路由/计费归因）。
- 注释更新（strip-headers.ts:1-8）：标明 `PROTECTED_HEADERS`（剥离侧守护）vs `SENSITIVE_DENYLIST`（透传侧封堵）两套常量的分工；request 侧 passthrough-strip 已接线、client-bound response 侧暂缓。

### 2. 线程化客户端头（仿 clientAnthropicBeta，仅 v4 codec 链）
新字段 `clientRequestHeaders?: Record<string,string>`（lowercased，**直接从 `raw.headers` 迭代取**，不复用 ctx 存的副本以解耦 history 脱敏策略）：
closure 变量声明（codec.ts:145 区 `let`）→ parse 捕获回写（:170）→ `ParseAnthropicResult`（:244）→ `PrepareWireDeps`（:362）→ `prepareAnthropicWire` 条件展开（:387）→ `PrepareAnthropicRequestOptions`（[request-preparation.ts:72](src/lib/anthropic/request-preparation.ts#L72)）。空对象 `{}` 走 passthrough 分支但产空集=no-op（**不要**加 `Object.keys().length` 短路）；漏传退化为不透传（安全）。

### 3. buildAnthropicHeaders 合并逻辑（request-preparation.ts:231）
```
core = { ...copilotHeaders(...), "X-Initiator": ..., "anthropic-version": ... }
if (filteredBeta) core["anthropic-beta"] = filteredBeta            // beta 进 core,strip 永不触及
coreLower = new Set(Object.keys(core).map(k => k.toLowerCase()))   // 动态取——天然含运行时注入的 modelRequestHeaders 键
coreLower.add("copilot-vision-request")                            // 硬编码例外:本请求未设 vision 也不许透传(加注释立规)
let headers = core
if (!state.strictRequestHeaders && opts.clientRequestHeaders) {
  let pass = selectPassthroughHeaders(opts.clientRequestHeaders, coreLower)
  pass = pruneHeaders(pass, state.stripRequestHeaders)             // strip 只作用 passthrough,["*"]→剥光透传=回 allowlist,无害
  headers = { ...pass, ...core }                                   // pass ∩ core=∅,无异大小写拼接;core 含 beta
}
```

### 4. config / state（仿 anthropic.beta_strip_headers→state.stripBetaHeaders 嵌套→扁平）
- **schema.ts**（anthropic section ~148-271）：`strict_request_headers: nullableBoolean()`、`strip_request_headers: nullableNonemptyStringArray()`（禁空字符串项、**允许空数组** `[]`）。
- **config.ts**（`a.` 块 ~548）：`setAnthropicBehavior({ strictRequestHeaders, stripRequestHeaders })`，retain-on-absence。
- **state.ts** 精确锚点：① State interface 字段声明（仿 :311 `disabledModels`）② `setAnthropicBehavior` union（:809-860，两字段都加）③ `cloneState` array 深拷贝 `[...]`（:685）④ `cloneStatePatch`（**非 applyPatch**）array 块 `[...]`（:738-739）⑤ `CONFIG_MANAGED_DEFAULTS`：`strictRequestHeaders:false`、`stripRequestHeaders:["x-anthropic-billing-header"]`（:1009-1101 区）⑥ `resetConfigManagedState` 用 `[...CONFIG_MANAGED_DEFAULTS.stripRequestHeaders]`（仿 :1152）⑦ 初始 `mutableState` 字面量用 `[...]`（仿 :1257）。boolean 是标量，**不进** cloneState/cloneStatePatch。
- **config.yaml**：anthropic section 加带注释默认。注释须含：retain-on-absence 语义（默认仅首次加载/`PUT /api/config` reset 时生效；删键=保留现值；`[]`=清空 attribution 剥离；恢复默认需 reset）+ **strict=true 时 strip_request_headers 为 no-op**（passthrough 为空，避免 operator 困惑）。

### 5. 守卫与文档
- `tests/config/config-hot-reload.it.test.ts` FIELDS 加 2 项。**坑**：`strip_request_headers` 默认**非空**（全库唯一），故 `defaultStateValue: CONFIG_MANAGED_DEFAULTS.stripRequestHeaders`（=`["x-anthropic-billing-header"]`，**不能写 `[]`**）；`sampleYamlValue` 必须 ≠ 默认（如 `["x-custom-attr"]`）否则接线断也假绿。bool 仿 :211 sanitize_tool_names。
- 单测 strip-headers：`selectPassthroughHeaders`（剔除 core/敏感/forwarded/encoding/hop-by-hop、x-github-*/openai-* 前缀、lowercased、modelRequestHeaders 动态 core 键不被客户端覆盖）+ `pruneHeaders`（glob、`["*"]`）。
- 集成测 buildAnthropicHeaders（仿 tests/anthropic/anthropic-request-preparation.it.test.ts）：透传开/关 × **客户端异大小写 `authorization` vs core `Authorization`→上游单值无逗号拼接**（#1 回归锁）× 敏感头被挡 × `anthropic-beta` 不被 strip × `["*"]` 不伤 core × **`strip_request_headers:[]`→attribution 透传**（默认反面）× **`copilot-vision-request` 无条件保留**（vision=false + 客户端发该头→上游无）。
- DESIGN.md：运行时选项表加两行；"header 重建"段更新为"默认透传 + 护栏"，**用户面明确作用域**：透传/strip 仅 Anthropic 主路径，web_search 子请求不透传。
- **观测说明（修正计划早期事实错误）**：outbound history 经 driver.ts:272 存**原始 wire.headers**（非 sanitizeHeadersForHistory——该函数只喂 betaProbe）。敏感头已被 denylist 在进 wire 前剔除→不进 wire→也不进 outbound history；残余自定义头原文入库，与既有 richest-data-flow 决策一致（http-headers-per-attempt.it.test.ts:71 已断言 outbound authorization 明文）。DESIGN.md 注明此作用域变化。

### 不在范围（文档标注）
web_search 双跳（保持无 passthrough=安全）、count_tokens（真 Anthropic API 手搓头）、OpenAI/Gemini/WS、strip-headers 的 response 侧。**defense-in-depth 跟进项**（非本次必做）：http2-client.ts:139-142 让客户端 `accept-encoding` 覆盖 `identity`——denylist 已挡，可在 transport 层强制 identity 作纵深，记入暂缓。

## 验证
`bun run typecheck` → `bun run test:backend`（新单测/集成/hot-reload 守卫，**含 #1 异大小写拼接回归锁**）→ 收尾 subagent audit + 文档同步。注：dry-run-pipeline inspector 喂空 Headers、**验不出 passthrough**，故透传验证走集成测而非 dry-run。
