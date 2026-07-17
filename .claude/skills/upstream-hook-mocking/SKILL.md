---
name: upstream-hook-mocking
description: 当需要在不真发 GitHub Copilot（消耗额度/依赖网络/无法构造特定上游响应）的前提下，验证 copilot-api-js 代理对上游响应的处理行为时使用——mock 上游 SSE、拦截改写请求/响应、录制-回放历史请求、注入故障/延迟/断流、或专门驱动 reactive retry 学习腿（造 400/畸形帧测 tool-field/server-tool/cache-control/unsupported-beta 策略）。触发场景：想离线复现某个上游响应、想测某条 retry 腿被触发、想让代理走完整管线（sanitize/cache_control 剥离/格式翻译/retry）但只 mock 上游那一段、调试时不想烧 Copilot 额度、`POST /api/hooks/reload` 热重载 hook。即使用户没说「hook」二字，只要意图是「测代理行为但不想真打上游」就用本 skill。
---

# 上游 hook 中间件用法

copilot-api-js 在上游边界（`Transport.send`）提供 driver 编排的 ad-hoc hook：一个 config 声明的 TS 文件，在 driver 的三个 phase 边界介入，让你 mock/拦截/回放/注入故障上游响应，而**前面的 sanitize、cache_control 剥离、格式翻译、retry 腿全走真实处理**——只 mock 你指定的上游那一段。默认关闭、零开销。

**权威文档**：`docs/spec/2026-07-12-upstream-hook-middleware.md`、ADR `docs/decisions/2026-07-12-driver-orchestrated-upstream-hooks.md`、`docs/DESIGN.md` 活的架构现状。

## 快速开始（三步）

1. **写 hook 文件**（放任意别名可解析处——loader 转译到项目内文件、`~/` 别名全局可解析），`export const hooks = { ... }` 导出你关心的挂载点：

```ts
// hooks/my-hook.ts
import { mockUpstreamError, stripMessageBlock } from "~/lib/pipeline/hooks"

export const hooks = {
  client: {
    // 生产改写：剥客户端注入的 role:system 噪声（client-native body，翻译/sanitize 之前）
    inbound: (env) => stripMessageBlock(env, (t) => t.role === "system" && /TodoWrite/.test(t.text)),
  },
  exchange: async (wire, env, next) => {
    // 测试：只对某模型 mock 一个 400，其余真发 GHC
    if (env.model?.id === "claude-opus-4-8") return mockUpstreamError.toolFieldRejection()
    return next()
  },
}
```

2. **config 启用**（`config.yaml`）：

```yaml
hooks:
  upstream_module: "./hooks/my-hook.ts"
  enabled: true          # 默认 false，必须显式 true 才加载
```

3. **启动服务器**（启动期自动加载）；改了 hook 文件后 **`curl -X POST localhost:4141/api/hooks/reload`** 热重载，不必重启。

## 对称四挂载点 + exchange（`export const hooks`，全部可选、未导出=直通、`return undefined`=observe）

`client|upstream`=body 形状（客户端原生 / 上游目标）、`inbound|outbound`=相对 proxy 方向。

| 挂载点 | 何时调 | 签名 | 典型用途 |
|---|---|---|---|
| `client.inbound` | 一次性，S1a parse 后 / S1b translate 前（**唯一** client-native 点，driver 给防御性 body 克隆） | `(env) => RequestEnvelope \| undefined` | **生产改写请求**：剥客户端注入块、省 token（`stripMessageBlock`/`stripSystemText` 四格式 helper） |
| `upstream.outbound`（旧 `onRequest`） | 一次性，retry 循环**外**、朝上游 | `(env) => RequestEnvelope \| undefined` | 贴近上游的最终请求改写 |
| `exchange`（旧 `onExchange`） | S4 上游交换核心，包裹 `transport.send`（**L1×L2 次**） | `(wire, env, next) => Promise<UpstreamStream>` | mock/拦截/回放/故障四用途 |
| `upstream.inbound`（旧 `rewriteUpstreamFrame`） | 逐帧，上游采样**之后** | `(frame, env) => UpstreamFrame \| undefined`（undefined=丢帧） | 逐帧改写上游响应 |
| `client.outbound` | 逐 client 帧，S6 render 后（覆盖渲染帧，不含 sink 合成/心跳帧——见 deferred-backlog） | `(frame, env) => ClientFrame \| undefined`（undefined=丢帧） | 改写回客户端的响应帧 |

`exchange` 如何覆盖四测试用途：

- **Mock 上游**：不调 `next`，返回合成 `UpstreamStream`（离线、零额度）。
- **拦截改写**：调 `next` 前改 `wire`，或调 `next` 后包裹返回的 stream。
- **录制回放**：`return replayFromHistory(reqId)`（不调 `next`）。
- **注入故障/延迟/断流**：返回 `mockUpstreamError(...)` / `delay(ms)` 包装 / `truncateAfter(n, stream)`。

## helper 工具箱（`import { ... } from "~/lib/pipeline/hooks"`）

| helper | 产出 | 说明 |
|---|---|---|
| `sse(event, dataObj)` | 单个 `UpstreamFrame` | `dataObj` 非字符串则 JSON 序列化 |
| `streamOf(frames, headers?)` | `UpstreamStream`（打 `hook-mock` 标记） | 手构帧序列打包 |
| `rawStream(frames, headers?)` | `UpstreamStream`（**不打标记**） | 需要无标记流时用（少见） |
| `mockAnthropicMessage(text)` | 合法 Anthropic SSE 序列 | message_start→delta→stop 全套 |
| `mockCcChunks(text)` | 合法 OpenAI/CC chunk 序列 | |
| `mockGeminiResponse(text)` | 合法 Gemini 响应 | 复用生产 translator |
| `mockUpstreamError(status, body?)` | **抛真 HTTPError** | `body` 进 `responseText`，见下 |
| `replayFromHistory(selector)` | 从 history 重建 `UpstreamStream`（打 `hook-replay` 标记） | `selector` = reqId 字符串 或 `{model?, endpoint?, latest?}` |
| `delay(ms)` | `<T>(s) => Promise<T>` 包装器 | `return delay(2000)(mockAnthropicMessage("hi"))` |
| `truncateAfter(n, stream)` | 只保留前 n 帧的 stream | 造断流 |

**raw 逃生口**：`exchange` 可直接返回手构的 `UpstreamStream = { frames: AsyncIterable<{event?,data?,id?,retry?}>, headers: Headers, nonStream? }`——能造**任意畸形帧序列**（helper 造不出的边界情况）。

### 驱动 reactive retry 学习腿（核心动机）

`mockUpstreamError` 必须产**真 HTTPError**，`body` 序列化进 `responseText`——否则 reactive 策略的 `canHandle`（读 `error.raw.responseText`）不命中、retry 腿静默不触发。四个预设已对准四条真实学习腿：

```ts
mockUpstreamError.toolFieldRejection()    // → tool-field-rejection-retry
mockUpstreamError.serverToolRejection()   // → server-tool-rejection-retry
mockUpstreamError.cacheControlSubfield()  // → cache-control-subfield-rejection-retry
mockUpstreamError.unsupportedBeta()       // → unsupported-beta-retry
```

自定义命中其他策略时，先 grep `src/lib/request/strategies/<x>.ts` 的正则常量，构造能被它 `test()` 命中的 `responseText`。

## 管理 API

- `GET /api/hooks` → 生效态：`{enabled, declaredModule, loadedModule, loadedAt, version, exports, lastReloadError?}`。区分「config 声明态」（`declaredModule`/`enabled`）与「实际加载态」（`loadedModule`/`version`/`exports`）——二者刻意脱钩（`applyConfigToState` 不触发加载）。
- `POST /api/hooks/reload` → 重载声明的模块。成功 `{ok:true, module, exports, version}`；失败 `{ok:false, error}` 200（**保留旧 hook**、绝不杀进程）；未配置 module → 400。`version` 单调递增，每次成功重载必变。

## 承重坑（务必知道，都是实测踩过的）

1. **loader 机制（2026-07-14 起）**：hook 经 `Bun.Transpiler` 转译后写 `.hooks-cache/` 唯一项目文件再 import——绕 Bun path-keyed ESM 缓存（热重载有效）**且**经 tsconfig `paths` 解析 `~/` 别名（旧 data-URL 方案不解析别名、带 import 的 hook 静默失效，已弃）。data-URL 时代的「yield 内联对象字面量丢导出」坑随之消失。
2. **hook 文件放哪**：loader 转译到项目内文件，`~/` 别名全局可解析——放任意项目内位置皆可（如 `hooks/`）。放仓库外须用相对路径或包导出。
3. **`exchange` 被调 L1×L2 次**：同一客户端请求内，`exchange` 可能被调多次（L1 retry 循环 × L2 buffered-retry 再交换）。有状态 hook（计数器、录制）须知道这点。对返回固定响应的 mock 无害。
4. **mock 流绕过守卫**：不调 `next` 的 mock 流**绕过** `guardSseIterable`（idle/shutdown/client-abort 守卫）+ adaptive rate-limiter（都在 `transport.send` 内）。要测超时/断流须自己在 raw 逃生口构造。
5. **history 可辨识性**：mock/回放帧在 history 上游轨自动打 `synthetic:"hook-mock"`/`"hook-replay"`；改写帧在 forwarded 轨打 `"hook-rewrite"`——所以事后看 history 能区分真实 vs hook 产物。**上游轨永远记 hook 改写前的真实帧**（`upstream.inbound` 只影响 forwarded 侧）。**注意**：forwarded `hook-rewrite` 标记**仅 Anthropic `/v1/messages` 直连 + CC 直连腿可靠**——Responses 腿（因 `restoreAndAccumulate` 重建帧）+ translate 腿会丢标（见 `docs/todo/deferred-backlog.md`）。
6. **`upstream.outbound`（及 `client.inbound`）是一次性的**：落在 retry 循环外，多 attempt 只调一次——别指望它每 attempt 改 env（那会破坏 reactive 策略的 env 修正）。要每 attempt 介入用 `exchange`。

## 测试里用（不起服务器）

测试中直接注入 hook 用 `setUpstreamHookForTests(hook)`（`~/lib/pipeline/hooks`）——能表达带闭包/计数器的 hook（真实文件加载表达不了）。**务必配 `afterEach(() => resetUpstreamHook())`**（hookState 是 module-global 单例，跨文件泄漏会污染 driver 的 `getUpstreamHook()` 读取）。参考 `tests/pipeline/hooks/*.it.test.ts` 的接线模式（含 `real-anthropic-driver-helpers.ts` 的 driver 脚手架）。
