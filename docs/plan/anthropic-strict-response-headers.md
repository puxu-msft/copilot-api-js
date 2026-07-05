# Plan: `anthropic.strict_response_headers` — Anthropic 上游响应头转发

## Context（为什么做）

当前代理对**响应 header 是完全隔离**的——上游 GitHub Copilot（GHC）→ proxy 的 response header 一个都不会透传给 client。所有写出点（流式 `streamSSE`、非流式 `c.json`、错误 `forwardError`）都由 Hono/proxy 重新合成响应头。后果：`request-id`、`anthropic-ratelimit-*`（限流配额）、`anthropic-organization-id` 等运营/诊断价值高的字段对客户端不可见，客户端无法感知自己的速率预算、也无法用 request-id 与服务端对账。

数据源其实现成：driver 的 `complete` outcome 已携带 `{ headers: upstream.headers }`（[driver.ts:490](src/lib/pipeline/driver.ts#L490)），per-attempt 也已存进 history 的 `outboundResponse` 腿。只是 handler 当前不消费它做转发。

本特性新增 `anthropic.strict_response_headers: boolean` 开关，让 Anthropic 路径可控地把上游响应头透传给客户端。**仅作用于 Anthropic 主路径**（config 键即 `anthropic.*`）。

### 已确认的决策（来自用户）

- **默认值 `false`**（permissive：尽量透传）。注意：当前行为是零转发，无论默认哪个都会**改变默认行为**开始转发——这是用户明确意图。
- **`true`（strict）= 仅转发白名单**：`request-id`、`x-request-id`、`anthropic-ratelimit-*`（前缀匹配）、`anthropic-organization-id`、`retry-after`。
- **`false`（permissive）= 尽量全转发**，但**两种模式都**排除一个 **proxy-controlled 黑名单**（用户明确要求 permissive 也要有黑名单，例如 `content-length`）。
- **history 不加新字段**：只需保证 `outboundResponse`（上游原始头，driver 已存）+ `inboundResponse`（客户端实收头，写出点捕获）两腿在新逻辑下仍忠实。

### 一个固有限制（必须文档化）

streaming 有三个写出点，只有两个能转发：
1. **非流式**（`renderNonStreamingV4`）✅ 可转发
2. **流式 settled-within-window**（[handler-v4.ts:409](src/routes/messages/handler-v4.ts#L409)）✅ 可转发——upstream 已 settle，`upstream.headers` 在开 200 前就有
3. **流式 delayed-commit committed**（[handler-v4.ts:467](src/routes/messages/handler-v4.ts#L467)）❌ **无法转发**——200 SSE 流在 upstream header 到达**之前**就已 flush（这正是延迟-commit 的触发条件：upstream 静默超窗口）。一旦 200 头发出，无法追加上游头。

→ 因此一个流式请求是否带转发头取决于上游是否在 commit 窗口内 settle。这是可接受的行为皱褶，`inboundResponse` 会忠实记录实际发了什么（committed 路径就是没有转发头）。`streamCommitAfterSec: 0`（立即 commit）下，流式永不转发——这反而给了确定性测试覆盖此限制的入口。

## 实现

### 1. 新建纯函数 helper + 单测（TDD：先写测试）

新文件 `src/lib/anthropic/response-header-forward.ts`：

```ts
/** Headers the proxy itself controls/synthesizes — never forwarded from upstream, regardless of mode. */
export const PROXY_CONTROLLED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  // content framing —— 这四项删除即破坏 body 成帧（proxy 经 runResponseWhole 改写后 body 长度/类型与上游不一致，
  // 转发上游 content-length 会让客户端按错长度解析）。注释钉死，不可手滑删。
  "content-length", "content-encoding", "content-type", "transfer-encoding",
  // hop-by-hop（RFC 9110 §7.6.1）
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade",
  // proxy 自行决定
  "cache-control", "date",
  // 防御：GHC 实际不下发 cookie，但 permissive "尽量全转发" 下若上游意外带 cookie，Headers.entries() 对
  // set-cookie 行为特殊（可能合并）会转发损坏值 —— 零成本防御（reviewer M2）。
  "set-cookie",
])

const STRICT_ALLOWLIST_EXACT: ReadonlySet<string> = new Set([
  "request-id", "x-request-id", "anthropic-organization-id", "retry-after",
])
const STRICT_ALLOWLIST_PREFIXES: ReadonlyArray<string> = ["anthropic-ratelimit-"]

/** Select which upstream response headers to forward to the client. Lowercases names; both modes drop PROXY_CONTROLLED. */
export function selectForwardableResponseHeaders(upstream: Headers, strict: boolean): Record<string, string>
```

逻辑：遍历 `upstream.entries()`，name 转小写；命中 `PROXY_CONTROLLED_RESPONSE_HEADERS` 一律跳过；strict 模式再要求命中白名单（exact 或前缀）才保留；permissive 模式保留其余全部。

单测 `tests/anthropic/response-header-forward.unit.test.ts`：
- strict 只保留 `request-id`/`x-request-id`/`anthropic-ratelimit-*`/`anthropic-organization-id`/`retry-after`，丢弃任意 `x-internal-foo`
- permissive 保留任意 `x-internal-foo`，丢弃黑名单
- **成帧四项各一条断言**（reviewer M1）：`content-length`/`content-encoding`/`content-type`/`transfer-encoding` 两模式都丢（不止用户举的 `content-length`），加 `connection`/`set-cookie`
- 大小写：因 helper 签名收 `Headers`、WHATWG `Headers` 已把键名小写化，helper 内 `.toLowerCase()` 经 `Headers` 走不到——故**额外用裸字符串键喂一个内部归一化分支用例**（或让 helper 接受 `Iterable<[string,string]>` 以便喂混合大小写裸输入），确保归一化逻辑被真正覆盖（reviewer L4）

### 2. config 接线（schema / state / config.yaml / hot-reload matrix）

- [schema.ts](src/lib/config/schema.ts) `AnthropicConfigSchema`：加 `strict_response_headers: nullableBoolean()`
- [state.ts](src/lib/state.ts)：**5 处接线**（以 `stripServerTools` 为对照，已核实行号）——① anthropic behavior interface `readonly strictResponseHeaders: boolean`（~L161）② `setAnthropicBehavior` 的 key 联合类型（~L813）加 `"strictResponseHeaders"` ③ `CONFIG_MANAGED_DEFAULTS` = `false`（~L1010）④ `resetConfigManagedState()` 镜像（~L1094）⑤ `mutableState` 模块初始化镜像（~L1204）
- [config.ts](src/lib/config/config.ts) `applyConfigToState`：`if (a.strict_response_headers !== undefined) setAnthropicBehavior({ strictResponseHeaders: a.strict_response_headers })`
- bundled [config.yaml](config.yaml) `anthropic:` 段：加双语注释 + `strict_response_headers: false`（默认）
- [tests/config/config-hot-reload.it.test.ts](tests/config/config-hot-reload.it.test.ts) FIELDS 表：注册 `{ configKey: "anthropic.strict_response_headers", stateKey: "strictResponseHeaders", sampleYamlValue: "true", expectedStateValue: true, defaultStateValue: CONFIG_MANAGED_DEFAULTS.strictResponseHeaders }`（完整性守卫强制，否则 CI fail）

### 3. handler 注入（仅 [src/routes/messages/handler-v4.ts](src/routes/messages/handler-v4.ts)）

handler-local 小 helper（同文件）：
```ts
function applyForwardedAnthropicResponseHeaders(c: Context, upstreamHeaders: Headers): void {
  const forward = selectForwardableResponseHeaders(upstreamHeaders, state.strictResponseHeaders)
  for (const [name, value] of Object.entries(forward)) c.header(name, value)
}
```
**必须在响应构造前调用**（`c.header()` 在 `streamSSE`/`c.json` 之前设，否则不进 `c.res`、也不被 `inboundResponse` 捕获）：

- **非流式**：`renderNonStreamingV4` 新增参数 `upstreamHeaders: Headers`；调用点（[L398](src/routes/messages/handler-v4.ts#L398)）传 `upstream.headers`；在函数内 `c.json(finalResponse)`（L644）**之前**调 `applyForwardedAnthropicResponseHeaders`。现有 L645 的 `setInboundResponseHeaders(clientResponse.headers)` 自动记录。
- **流式 settled-within-window**：在 `return streamSSE(...)`（[L409](src/routes/messages/handler-v4.ts#L409)）**之前**调 `applyForwardedAnthropicResponseHeaders(c, upstream.headers)`。回调内 L411 的 `setInboundResponseHeaders` 自动记录。
- **流式 committed（L467）**：**不改**，加代码注释说明固有限制（200 已 flush，upstream 头尚未到达）。

### 4. history 忠实性

无需新字段。`outboundResponse`（driver 已存上游全量）不动；`inboundResponse`（写出点读 `c.res.headers`）因转发头在捕获前已 set，**自动包含**客户端实收的转发头。靠注入顺序（set 在 capture 前）保证。committed 路径忠实记录"无转发头"。

### 5. http 行为测试

`tests/anthropic/response-header-forward.http.test.ts`（用 `useIsolatedRuntime` + fetch-mock 造上游返回 `request-id` / `anthropic-ratelimit-requests-remaining` / `x-internal-foo` / `content-length`）：
- 非流式 permissive：client 响应含 request-id + ratelimit + x-internal-foo，**无** 上游 content-length（proxy 自有）
- 非流式 strict：仅 request-id + ratelimit + org-id + retry-after，**无** x-internal-foo
- 流式 settled-within-window：同上断言 SSE 响应头
- 流式 `streamCommitAfterSec: 0`（强制立即 commit）：断言**无**任何转发头（覆盖 committed 限制）

### 6. 文档同步（completion-includes-doc-sync）

- [docs/DESIGN.md](docs/DESIGN.md) 运行时选项表：加 `strictResponseHeaders` 行（来源 `anthropic.strict_response_headers`、默认 `false`、说明两模式 + 黑名单 + committed 限制）
- DESIGN.md "活的架构现状" HTTP header 捕获行：补一句 ④ inboundResponse 现含转发的上游头（非流式 + settled-within-window）、committed 路径不转发
- 完成后跨文档 `grep` 扫描验证（旧"零转发"表述、新 config 键逐处核对）

## 范围外（不做，文档注明）

- 非 Anthropic 格式（CC/Responses/Gemini）保持零转发——config 键是 `anthropic.*`
- web_search 双跳 bypass（legacy `executeRequestPipeline`，不经 driver）+ count_tokens（本地计算，无上游头）
- 错误路径 `forwardError`：保持现状（合成 body + status，retry_after 已折进 body）——本特性聚焦成功响应头

## 提交粒度（fine-grained-staging，一阶段一 commit）

1. `feat: add anthropic response-header-forward helper`（helper + 单测，TDD 先测后实现）
2. `feat: plumb anthropic.strict_response_headers config`（schema/state/config/yaml + hot-reload matrix）
3. `feat: forward upstream response headers on anthropic non-committed paths`（handler 注入 + http 测试）
4. `docs: document strict_response_headers + committed-path forwarding limit`（DESIGN.md）

每个 commit 用 `git add -p` / 显式 pathspec 精确暂存，`git diff --cached --stat` 复核。

## 验证

- `bun run test:backend`（新单测 + http 测试 + hot-reload 完整性守卫）
- `bun run typecheck`
- `bun run lint:all`（或 `eslint --fix`）
- 不启动服务器（no-auto-server-no-kill）；需实测转发行为时请用户手动起 server 后用 4141 history API / curl 核验

## subagent 复核（subagent-explicit-rubric）

实现后派 reviewer subagent，prompt 显式写明裁判轴：长远正确 + 范围内彻底；重点查 ① `c.header()` 注入时机相对 `streamSSE`/`c.json` 是否真在 capture 前 ② 黑名单是否覆盖所有 proxy 成帧/hop-by-hop 头 ③ committed 限制是否真无法绕过（不要被"看似能转发"误导）④ history 两腿是否真忠实。亲自读其引用的每个 `file:line` 再采纳。
