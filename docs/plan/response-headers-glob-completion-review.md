# 审计报告：response-header blacklist/whitelist glob 补全计划

裁判轴：empirical-verification（探针实测、读源码逐字符）+ best-complete-solution + 向后兼容字节级。结论：**计划设计正确，向后兼容真逐字节，无安全地板绕过风险**。4 条核验全部成立，附 2 条次要收尾提示（不影响设计成立性）。

## 1. 向后兼容是否真逐字节 — 已核验成立（探针实测零 mismatch）

旧 strict=true 走 `matchesHeaderName`（`header-name-match.ts:23-25`）= `exact.has(lower) || prefixes.some(p => lower.startsWith(p))`，集合 `STRICT_ALLOWLIST_EXACT={request-id,x-request-id,anthropic-organization-id,retry-after}` + `STRICT_ALLOWLIST_PREFIXES=["anthropic-ratelimit-"]`（`response-header-forward.ts:50-53`）。新 whitelist 走 `keepHeaders`→`compileHeaderAllow`→`globToRegExp`（`header-glob-strip.ts:32-37,64-70`）。

写了 5 行探针复刻 `globToRegExp` + 旧 `matchesHeaderName`，对 17 个用例（含全部边界）对比，**0 mismatch**：

```
name                                   OLD   NEW   match?
anthropic-ratelimit-                   true  true  OK   ← 恰好等于前缀（无后缀）
anthropic-ratelimit                    false false OK   ← 前缀去掉尾 dash
anthropic-ratelimit-x                  true  true  OK   ← 一字符后缀
x-request-id-extra                     false false OK   ← exact 名+后缀，未误匹配
request-id-2                           false false OK
anthropic-organization-id-foo          false false OK
retry-after-ms                         false false OK
content-type / x-served-by             false false OK
（其余 ratelimit-* 实名 + 4 个 exact 名全 true=true）
mismatches: 0
```

逐点回答提问的子问：

- **`anthropic-ratelimit-*` glob 与旧 prefix 真等价？** 是。编译出 `/^anthropic-ratelimit-.*$/iu`。旧 `startsWith("anthropic-ratelimit-")` 与 `^anthropic-ratelimit-.*$` 在锚定下语义同构——前者"以 X 开头"，后者"X 后跟任意（含空）"。`.*` 含零长，故 glob **也匹配恰好等于前缀的 `anthropic-ratelimit-`**（与旧 prefix 一致 true）；两者都不匹配去掉尾 dash 的 `anthropic-ratelimit`。**无边界差异**。
- **exact 名作无通配 glob 是否被正确锚定？** 是。`request-id` → `/^request-id$/iu`，`retry-after` → `/^retry-after$/iu`。关键：`globToRegExp` 的 escape 字符类 `[.+^${}()|[\]\\]` **不含 `-`**——但 `-` 在 RegExp 字面（非字符类内）本就是普通字符，无需转义，故 `request-id` 的 `-` 直接进 regex 作字面短横，`^…$` 锚定保证全名精确匹配（`x-request-id-extra` 正确不匹配）。大小写：旧 `matchesHeaderName` 入参已 lowercased + glob 带 `i` flag，等价。

**字节级结论成立**：默认 `responseHeaderWhitelist=["request-id","x-request-id","anthropic-ratelimit-*","anthropic-organization-id","retry-after"]` 使旧 true 行为不变；默认 `responseHeaderBlacklist=[]` 经 `pruneHeaders([])`→`compileHeaderStrip` 返回 null→原样返回（`header-glob-strip.ts:52-54`），即"只过地板"，与旧 false 行为不变。

http 集成测试（`response-header-forward.http.test.ts`）不直接调 `selectForwardableResponseHeaders`，而是 `setStateForTests({strictResponseHeaders})` + 断言响应头值。其 strict 断言（`request-id`/`anthropic-ratelimit-requests-remaining`/`anthropic-organization-id` 存活、`x-internal-foo`/`content-length` 剔除，L139-148）被默认 whitelist 经 `keepHeaders` 精确复现，**预期零改动通过**——与计划第 7 步"预期改动极小或零"一致。

## 2. PROTECTED_HEADERS 复用风险 — 已核验成立（影响为零）

`pruneHeaders` 的 `PROTECTED_HEADERS={authorization,content-type,content-length,copilot-integration-id}`（`header-glob-strip.ts:29`）。计划声称"响应地板已剥 content-type/content-length，authorization/copilot-integration-id 即便出现也只是更安全"。

- 响应地板 `PROXY_CONTROLLED_RESPONSE_HEADERS`（`response-header-forward.ts:23-47`）**确含 `content-type`(L30) + `content-length`(L28)**——计划先过地板再 `pruneHeaders`，这两个永不进入 `pruneHeaders` 的输入，PROTECTED 守卫对它们恒不触发，无差异。
- `authorization`/`copilot-integration-id`：GHC 响应中基本不出现；即便出现，PROTECTED 守卫只阻止 blacklist **剥**它们。但 blacklist 模式默认 `[]`（不剥任何），且 operator 也几乎不会把这两个写进 response blacklist。守卫的唯一可观测效果是"operator 写了剥 authorization 的 glob 时该响应头不被剥"——这是**更保守**方向，且这两个头在 Anthropic 响应里无意义。**影响为零，复用合理**（DRY + battle-tested）。计划已要求在注释里说明，符合 best-complete-solution。

`keepHeaders` 无 PROTECTED 逻辑（它是交集，且响应侧无 core 重注入）——whitelist 模式不受 PROTECTED 影响，正确。

## 3. 安全地板顺序 — 已核验成立（whitelist 不能重放行地板剥的头）

计划顺序"先过 `PROXY_CONTROLLED_RESPONSE_HEADERS` 地板 → 再 prune/keep"。核验 whitelist 模式：`keepHeaders(floored, whitelist)` 的输入 `floored` **已剔除 content-length 等地板头**，故无论 whitelist glob 多宽（哪怕 `["*"]`）都无法重新放行被地板剥的头——`keepHeaders` 是对 `floored` 的子集筛选，地板剥掉的根本不在候选集里。这与请求侧 `selectPassthroughHeaders(client,coreLower)` → `keepHeaders(safe,whitelist)` 的同序逻辑（`request-preparation.ts:276-277`）完全同构：安全地板在模式分叉**之前**，whitelist 在地板**之后**。

现有 http 测试 `drops content-length even when ... allowlisted-adjacent (strict)`（unit L105-114）已锁此不变量，新签名下经地板剔除仍成立。**顺序正确，无地板绕过**。

## 4. 空名单语义 — 已核验成立且合理（响应侧确无 core 重注入）

`keepHeaders([])` → `compileHeaderAllow([])` 返回 null → `keepHeaders` 返回 `{}`（`header-glob-strip.ts:69,80）。故 whitelist 模式 + 空 whitelist = 完全不转发任何上游响应头。

这对响应侧是**预期且合理**的语义，且与请求侧**有意不同**：

- 请求侧 `keepHeaders([])`→`{}` 后还有 `{...selected, ...core}` 兜底（`request-preparation.ts:278`），core 头仍发出——故请求侧空 whitelist = core-only。
- 响应侧**无 core 兜底重注入**——核验 `applyForwardedAnthropicResponseHeaders`（`handler-v4.ts:649-655`）：它只 `for (const [name,value] of Object.entries(forward)) c.header(name,value)`，是在 handler 写出层合成的代理响应头之上**叠加** forward 子集。代理自己的响应头（content-type、status 等）由 `streamSSE`/`c.json` 独立合成（JSDoc L639-643 明示"every write-out point synthesizes its own response headers"）。故响应侧空 whitelist = 不叠加任何上游头 = 回到代理完全隔离的默认，**语义干净、无副作用**。计划第 26 行"响应侧无 core 兜底重注入"的论断**核验成立**。

## 次要收尾提示（不影响设计成立，记入待办）

这两条是计划已隐含但值得在实现/收尾时显式确认的点，非设计缺陷：

- **S1（state 登记完整性）**：计划改动清单第 2 步列了 6 个 state.ts 登记点。已逐一核验现有 `requestHeader*` 模板位置全部存在且行号吻合：接口 L191/198、cloneState L721-722、patch L778-783、`setAnthropicBehavior` union L867-871、`resetConfigManagedState` L1162-1163、reset defaults L1279-1280、`CONFIG_MANAGED_DEFAULTS` L1072-1073。新增 `responseHeader*` 镜像这 7 处（含接口、defaults、cloneState、patch、union、两 reset 点）即可。**遗漏任一处会被 typecheck（union/接口）或 hot-reload 完整性守卫捕获**，风险低。schema 的 `nullableNonemptyStringArray()` helper（schema.ts:84）与 config.ts apply 模板（L494-497）均已就位，镜像即可。

- **S2（config.yaml bundled SSOT — 强制要求）**：按项目记忆 `project-new-config-key-must-document-in-bundled-config-yaml`，新 config 键**必须**写进 bundled `config.yaml`（不只 CONFIG_MANAGED_DEFAULTS 兜底），否则丢可发现性。计划第 6 步已覆盖此项，收尾务必核对 `response_header_blacklist`/`response_header_whitelist` 两块连同注释落入 bundled config.yaml，且默认值与 state 的 `CONFIG_MANAGED_DEFAULTS` 一致（whitelist 5 项、blacklist 空）。

## 总评

设计正确，向后兼容经探针实测逐字节成立（17/17 用例零 mismatch，含全部 prefix/exact 边界），三处复用（PROTECTED_HEADERS、地板顺序、空名单镜像语义）均无隐藏行为差异或安全地板绕过。对称设计与请求侧完全同构，符合 DRY + best-complete-solution。可执行。
