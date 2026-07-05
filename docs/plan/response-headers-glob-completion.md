# 补全 response headers 的 blacklist/whitelist glob 处理

## Context（为何做这个改动）

请求侧的客户端→上游 header 转发已是**三件套**对称结构（`strict_request_headers` 模式开关 + `request_header_blacklist` + `request_header_whitelist` 两份 glob 名单），operator 可按 glob 精确控制。

响应侧（上游→客户端）目前只有一个 `strict_response_headers` boolean，且两种行为的名单都**硬编码**在 `response-header-forward.ts` 里（`STRICT_ALLOWLIST_EXACT`/`STRICT_ALLOWLIST_PREFIXES`），operator 无法定制：
- `false` = 转发除 `PROXY_CONTROLLED_RESPONSE_HEADERS` 黑名单外的全部
- `true` = 仅转发硬编码 allowlist（request-id / x-request-id / anthropic-ratelimit-* / anthropic-organization-id / retry-after）

本改动把响应侧补全成与请求侧同构的三件套：`strict_response_headers` 升级为**模式开关**，新增 `response_header_blacklist` / `response_header_whitelist` 两份 operator 可控的 glob 名单，复用请求侧已有的 `pruneHeaders`/`keepHeaders` 原语。

**向后兼容**：选默认值使旧 boolean 语义逐字节保持——`responseHeaderBlacklist` 默认 `[]`（旧 `false` 行为），`responseHeaderWhitelist` 默认 = 旧硬编码 allowlist 的 glob 形式（旧 `true` 行为）。

## 对称设计

| 维度 | 请求侧（已有，模板） | 响应侧（本次补全） |
|---|---|---|
| 模式开关 | `strictRequestHeaders` | `strictResponseHeaders`（语义升级为模式开关） |
| 安全地板（强制剥，两模式） | `selectPassthroughHeaders`（core keys + sensitive denylist） | `PROXY_CONTROLLED_RESPONSE_HEADERS`（content framing + hop-by-hop + set-cookie/cache-control/date） |
| blacklist 模式（`false`） | `pruneHeaders(safe, requestHeaderBlacklist)` | `pruneHeaders(floored, responseHeaderBlacklist)` |
| whitelist 模式（`true`） | `keepHeaders(safe, requestHeaderWhitelist)` | `keepHeaders(floored, responseHeaderWhitelist)` |
| blacklist 默认 | `["x-anthropic-billing-header"]` | `[]`（= 旧 false：仅过地板） |
| whitelist 默认 | `["accept", "x-claude-code-*", …]` | `["request-id", "x-request-id", "anthropic-ratelimit-*", "anthropic-organization-id", "retry-after"]`（= 旧 true allowlist 的 glob 化） |

`pruneHeaders`/`keepHeaders`（`src/lib/anthropic/header-policy/header-glob-strip.ts`）直接复用——glob 编译（`globToRegExp`）、空名单镜像语义（`pruneHeaders([])` 留全部 / `keepHeaders([])` 留空）、PROTECTED_HEADERS 守卫均已存在且测试覆盖。响应侧无 "core 兜底重注入"（代理响应头由 handler 写出层合成，转发头是叠加），所以第 3 步省略。

> 已知良性差异：`pruneHeaders` 的 `PROTECTED_HEADERS`（authorization/content-type/content-length/copilot-integration-id）是请求侧概念。响应地板已剥 content-type/content-length；authorization/copilot-integration-id 在响应中基本不出现，即便出现，不被 blacklist 剥也只是更安全的默认。影响为零，复用合理（DRY + battle-tested），在代码注释里说明。

## 改动清单

### 1. `src/lib/anthropic/header-policy/response-header-forward.ts`（核心重写）
- 删除 `STRICT_ALLOWLIST_EXACT` / `STRICT_ALLOWLIST_PREFIXES` / `isStrictAllowed` / `matchesHeaderName` import（响应侧不再硬编码名单）。
- 保留 `PROXY_CONTROLLED_RESPONSE_HEADERS`（安全地板）不变。
- `selectForwardableResponseHeaders` 改签名：第二参从 `strict: boolean` 换为 `opts: { strict: boolean; blacklist: ReadonlyArray<string>; whitelist: ReadonlyArray<string> }`（镜像请求侧 `buildAnthropicHeaders` 的两模式分叉）。实现：先迭代过 `PROXY_CONTROLLED_RESPONSE_HEADERS` 地板 + 小写化成 `Record`，再 `opts.strict ? keepHeaders(floored, opts.whitelist) : pruneHeaders(floored, opts.blacklist)`。
- 更新模块顶部 JSDoc：描述模式开关 + 两份可控名单。
- import `keepHeaders`/`pruneHeaders` from `./header-glob-strip`。

### 2. `src/lib/state.ts`（新增 2 字段 + 登记点）
- 接口加 `readonly responseHeaderBlacklist` / `readonly responseHeaderWhitelist`（紧邻 `strictResponseHeaders`，JSDoc 镜像请求侧）。
- 升级 `strictResponseHeaders` 的 JSDoc 为"模式开关"。
- `CONFIG_MANAGED_DEFAULTS`（~1070）：加两默认值（blacklist `[]`、whitelist 上述 5 项）。
- `cloneState`（~721）：加 `responseHeaderBlacklist: [...source.responseHeaderBlacklist]` 等（数组深拷贝，镜像 requestHeader* 行）。
- patch 处理（~778）：加 `if ("responseHeaderBlacklist" in patch)` 等（镜像 requestHeader* 的 `? [...] : undefined`）。
- `setAnthropicBehavior` 的 `Pick<…>` union（~867）：加两 stateKey。
- `resetConfigManagedState`（~1160）与 reset defaults（~1277）两处：加 `[...CONFIG_MANAGED_DEFAULTS.responseHeader*]`。

### 3. `src/lib/config/schema.ts`（~154）
- `strict_response_headers` 后加 `response_header_blacklist: nullableNonemptyStringArray()` / `response_header_whitelist: nullableNonemptyStringArray()`（镜像 `request_header_*`，JSDoc 同构）。

### 4. `src/lib/config/config.ts`（~494）
- `strict_response_headers` apply 行后加两行 `if (a.response_header_blacklist !== undefined) setAnthropicBehavior({ responseHeaderBlacklist: a.response_header_blacklist })` 等。

### 5. `src/routes/messages/handler-v4.ts`（~650）
- `applyForwardedAnthropicResponseHeaders` 内调用改为传 opts 对象：`selectForwardableResponseHeaders(upstreamHeaders, { strict: state.strictResponseHeaders, blacklist: state.responseHeaderBlacklist, whitelist: state.responseHeaderWhitelist })`。

### 6. `config.yaml`（bundled，~403）
- `strict_response_headers` 注释升级为模式开关（中英双语，镜像 252-258 的请求侧块），其后加 `response_header_blacklist`（默认空数组 + 注释）与 `response_header_whitelist`（默认 5 项 + 注释）两块。

### 7. 测试
- `tests/anthropic/header-policy/response-header-forward.unit.test.ts`：更新所有 `selectForwardableResponseHeaders(…, true/false)` 调用为新 opts 签名（传默认名单）；新增 case 覆盖**自定义** blacklist/whitelist glob（如 whitelist `["x-served-by"]` 只留它、blacklist `["x-internal-*"]` 剥前缀），证明 operator 可控且复用 glob 语义。
- `tests/config/config-hot-reload.it.test.ts`（~272）：在 `strict_response_headers` 行后加 `anthropic.response_header_blacklist` / `anthropic.response_header_whitelist` 两矩阵行（镜像 281-296 的请求侧行，sample 须异于默认）。
- 检查 `tests/anthropic/response-header-forward.http.test.ts`（http 集成）是否依赖旧 boolean 行为，按需更新（默认值保证旧行为不变，预期改动极小或零）。

### 8. 文档 + 同模块 JSDoc 同步（收尾，subagent review 补充）
- `docs/DESIGN.md`：
  - 运行时选项配置表（~298-302）：`strictResponseHeaders` 行改为模式开关描述；新增 `responseHeaderBlacklist` / `responseHeaderWhitelist` 两行（镜像 `requestHeaderBlacklist`/`requestHeaderWhitelist` 行）。
  - 四腿捕获表 `inboundResponse` 段（line 69）：`strictResponseHeaders` "若开" → 模式措辞同步（确认改的是 line 69，非仅配置表行）。
- **`src/lib/anthropic/header-policy/index.ts:7-10`**（barrel JSDoc）：响应侧描述从单纯 boolean "forward policy" 升级为"模式开关 + blacklist/whitelist 两份可控名单"；`header-glob-strip.ts` 的描述 "over the request passthrough set" 同步为不再仅 request（请求 + 响应两侧共用）。
- **`src/lib/anthropic/header-policy/header-name-match.ts:10-16`**（顶部 JSDoc）：删除响应侧 import 后 `matchesHeaderName` 只剩请求侧一个消费者，移除 line 10-12 的"response side strict-mode allowlist"消费者描述 + line 15-16 关于"request side's extra glob-strip layer"的对比措辞（响应侧现也有 glob 层）。`matchesHeaderName` 本体不变（`request-header-forward.ts:76` 仍用，不变死代码）。

## 验证

改了 `.ts`/`.yaml`，按 `verify-only-on-executable-changes` 跑：
```
bun run typecheck
bun run test:backend  # 至少 tests/anthropic/header-policy/ + tests/config/config-hot-reload
```
- 单测证明：blacklist 模式自定义 glob 剥除生效、whitelist 模式只留命中项、两模式都强制过 PROXY_CONTROLLED 地板、空名单镜像语义、向后兼容（默认名单下旧 true/false 行为逐字节不变）。
- hot-reload 矩阵守卫证明两新键 wired + retain-on-absence + 完整性守卫不 fail（新键已登记进矩阵）。
- typecheck 证明 `setAnthropicBehavior` union + state 登记点完整、handler 调用签名匹配。

收尾（`completion-includes-doc-sync`）：DESIGN.md 配置表 + bundled config.yaml 已含两新键；跨文档 grep 扫一遍 `strict_response_headers` 旧"仅 allowlist"措辞、并把范围扩到整个 `src/lib/anthropic/header-policy/` 目录的 JSDoc（捕获 index.ts barrel + header-name-match.ts 的陈旧措辞）全部更新。bundled config.yaml 两新键的默认值须与 `CONFIG_MANAGED_DEFAULTS` 逐项一致（`project-new-config-key-must-document-in-bundled-config-yaml`）。收尾再派 subagent audit 核验落地。
