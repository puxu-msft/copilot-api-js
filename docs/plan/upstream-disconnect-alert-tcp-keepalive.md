# 优化上游断连告警 + 用 undici 在 Bun 热路径补 TCP keepalive

## Context（为什么做这件事）

线上出现这条失败:

```
[FAIL] POST /v1/messages claude-opus-4.8 630.6s ↑826.2KB ↓531B: The socket connection was closed unexpectedly.
[ERR ] [upstream-diagnostics] STREAM DISCONNECT kind=transport-close | frames=2 | last-frame=content_block_start@57ms silence=606139ms | stuck-block=thinking
```

两个已用证据裁决的事实:

1. **方向 = 上游侧连接被关**(非 client 主动断)。`classifyStreamError`([stream.ts:63](src/lib/stream.ts#L63))把 client abort 单列为 `client-abort`(记为 aborted 非 FAIL);本条 `kind=transport-close` 是兜底 `other`,已排除 client-abort / 本地 idle-timeout / 本地 shutdown。结合 silence≈606s + stuck=thinking + frames=2,是 opus adaptive thinking 在 `content_block_start` 后长时间静默期间,连接被中间设备(NAT/防火墙/LB,~30s 空闲窗口)回收。

2. **根因 = Bun 热路径无 TCP keepalive**。错误文案 `The socket connection was closed unexpectedly.` 经仓库测试确证是 **Bun fetch** 文案([error.unit.test.ts:374](tests/infra/error.unit.test.ts))。实测裁决(本机 Bun 1.3.14):Bun 的 `fetch()` 无任何 socket keepalive 配置入口(`BunFetchRequestInit` 无该字段,`tls` 仅证书,`keepalive` 只是连接池开关)。因此 [proxy.ts:80](src/lib/proxy.ts#L80) 的 `keepAliveInitialDelay` 和 `upstreamKeepaliveDelay=15` 配置**在 Bun 下完全失效**——这条连接从建立起就没有任何 TCP 探针保活。DESIGN.md 第 293 行也已注明"仅 Node 路径生效;Bun 的 fetch 不受影响"。

**选定方案 = 用成熟库 undici**(用户指示;呼应项目"scoped 组件优先成熟库"惯例)。undici 已是项目依赖、纯 JS 无 node-gyp、API 兼容标准 fetch、Node 路径已复用同一套 `Agent` 配置。

实测裁决(本机 Bun 1.3.14 + undici 7.26.0,oracle 级证据):
- undici 在 Bun 下可原生 import,发起非流式/流式 HTTPS 均正常;
- `Agent({ connect: { keepAlive: true, keepAliveInitialDelay } })` 经 `node:net.setKeepAlive` **真落内核**——`ss -tno` 观测到 `timer:(keepalive,...)`,端口与探针一致(SO_KEEPALIVE + TCP_KEEPIDLE);
- 长静默流 + `AbortSignal` 中途取消实测 1501ms 干净抛 `AbortError`;
- 零 `binding.gyp` / `.node`,合规 bun-first。
- 未独立实测(中等置信,Node 路径已生产在用):800KB 大 body POST、HTTP/SOCKS 代理 → 落地测试需补。

预期结果:Bun 热路径上游连接获得与 Node 对称的 TCP keepalive,长 thinking 静默期不再被中间设备回收;告警一眼能看出"保活有没有在工作"。

---

## 任务一:告警优化(确定做)

让诊断行直接暴露**保活状态**(当前最该有却缺失的信息)+ 可操作判断。改两个文件,保持 [upstream-diagnostics.ts](src/lib/upstream-diagnostics.ts) 纯(由调用方算好传入,沿用现有 `kindLabel`/`detail` 的设计)。

- [upstream-diagnostics.ts](src/lib/upstream-diagnostics.ts) `UpstreamStreamDisconnectInfo` 增字段:
  - `keepaliveStatus: string` —— 调用方传入**实际生效**值(如 `"15s"` / `"disabled"` / `"unsupported(bun-fetch)"`)。与具体 transport 解耦:undici 落地后此值自动反映新现实,无需改诊断模块。
- `logUpstreamStreamDisconnect` 输出增补:
  - 追加 `keepalive=<status>` 段;
  - **likely-cause 启发式**(hint-only,沿用 tool-diagnostics 的"suspicious 非 invalid"哲学):当 `silence` 大(≥ keepalive 窗口或固定阈值如 30s)且 `frames` 少且(`stuckBlockType==="thinking"` 或 `lastFrameType==="content_block_start"`)→ 输出 `likely=middlebox-idle-reclaim-during-thinking-stall`;
  - keepalive 未生效时附 `hint`(措辞按任务二是否落地而定:未落地→建议切 Node;落地后→提示连接路径空闲窗口可能 < keepalive 延迟,建议下调 `timeouts.upstream_keepalive`)。
- [streaming-pump.ts](src/routes/messages/streaming-pump.ts#L55) `logUpstreamStreamError`:组装 `keepaliveStatus`(从 proxy 暴露的 getter / runtime 判定)。
- 测试:[tests/infra/upstream-diagnostics.unit.test.ts](tests/infra/upstream-diagnostics.unit.test.ts) 增 keepalive 字段 + likely-cause 启发式断言。

---

## 任务二:undici keepalive 根因修复(核心范围)

**最佳落点**:[send.ts](src/lib/transport/send.ts) 的 `sendUpstreamHttp` 是 **v4 和 legacy 共享的上游 HTTP 出口**([http-transport.ts](src/lib/transport/http-transport.ts) 包它,所有 OpenAI/Responses/Gemini/未来 Anthropic-v4 都经此),单点改它两条路径同时受益。legacy Anthropic 直连 [client.ts:125](src/lib/anthropic/client.ts#L125) 是 flag OFF 期的活路径,一并改。

### 2.1 proxy.ts 暴露显式 dispatcher（接线基础）
当前只有 `setGlobalDispatcher`(Bun 下空操作)。新增:
- 模块级缓存"当前上游 dispatcher" + `export function getUpstreamDispatcher(): Dispatcher`;
- `installGlobalDispatcher`(Node)构造 dispatcher 时**同时缓存**到该变量(不止 setGlobalDispatcher);
- `initProxyBun` 改为**也构造并缓存同一类 dispatcher**(HTTP proxy → `ProxyAgent`;无 proxy → `new Agent(getUndiciAgentOptions())`),不再只设 `process.env.HTTP_PROXY`;
- 热重载 `onTransportTimeoutChange` 重建时刷新缓存(getter 返回新实例,旧的留给在途请求 GC,与现有语义一致)。

### 2.2 热路径 fetch 改 undici（根因修复）
[send.ts](src/lib/transport/send.ts) + [anthropic/client.ts](src/lib/anthropic/client.ts):
- `import { fetch as undiciFetch } from "undici"`;
- `fetch(url, {...})` → `undiciFetch(url, { method, headers, body, signal, dispatcher: getUpstreamDispatcher() })`;
- **删 `DISABLE_BUILTIN_FETCH_TIMEOUT`**(`{ timeout: false }` 是压制 Bun 内建 300s 的 Bun 专属字段;undici 无该时钟,超时全由 Agent 的 `headersTimeout`/`bodyTimeout` 控制,已在 `getUndiciAgentOptions` 配好);
- `signal`(`createFetchSignal` + `combineAbortSignals`)**保留**——undici 完全支持(实测确认),仍驱动 header-wait 超时 + shutdown/client-abort 折叠;
- 返回类型:undici `fetch` 返回标准 `Response`,`events(response)`(fetch-event-stream)消费 `response.body` 不变;`response.json()` / `.text()` / `.headers` 不变。需核 `captureHttpHeaders` / `HTTPError.fromResponse` 对 undici Response 的兼容(应一致,标准 WHATWG Response)。

### 2.3 测试（补 subagent 未实测项）
- send.ts 现有 http/it 测试经 undici dispatcher 仍绿(行为保持);
- 专测:**800KB body POST** + **流式 SSE 读取** + **AbortSignal 中途取消**(经 undiciFetch 路径);
- dispatcher 配置断言:`getUpstreamDispatcher()` 返回的 Agent 含 `keepAliveInitialDelay`(用 `state.upstreamKeepaliveDelay` 驱动);
- 代理路径(HTTP `ProxyAgent` / SOCKS 连接器)经 undiciFetch 仍工作;
- 隔离纪律:DI/fetch-mock(对 undici 用 MockAgent 或注入 dispatcher)、不用 `mock.module`、`autoRestoreState()`、不碰真实 `$HOME`。

---

## 范围:全统一(已选定)

所有出站 fetch 统一走 `undiciFetch(url, { ..., dispatcher: getUpstreamDispatcher() })`,彻底消除 Bun/Node fetch 分流、删光 `DISABLE_BUILTIN_FETCH_TIMEOUT`、更新 DESIGN 原则。完整调用点清单(grep 已枚举):

**GHC 热路径**(核心,2.2):[send.ts:102](src/lib/transport/send.ts#L102)、[anthropic/client.ts:125](src/lib/anthropic/client.ts#L125)
**其余 GHC**:[openai/embeddings.ts:21](src/lib/openai/embeddings.ts#L21)、[models/client.ts:46](src/lib/models/client.ts#L46)、[anthropic/web-search/backends.ts:285,306](src/lib/anthropic/web-search/backends.ts)(打本地 SearXNG)
**非 GHC**:[copilot-api.ts:150](src/lib/copilot-api.ts#L150)(VSCode release)、[token/github-client.ts:32,55,80](src/lib/token/github-client.ts)、[token/copilot-client.ts:17,44](src/lib/token/copilot-client.ts)、[count-tokens.ts:49](src/routes/messages/count-tokens.ts#L49)(api.anthropic.com)、[ui/route.ts:198](src/routes/ui/route.ts#L198)(UI upstream)

注意点:统一用同一个全局 `getUpstreamDispatcher()`(undici Agent 按 origin 池化,keepalive 对所有连接无害,与现 `setGlobalDispatcher` 全局语义一致);SearXNG/localhost 经代理时须保留现 `EnvProxyDispatcher` 的 `NO_PROXY` 尊重语义。`DISABLE_BUILTIN_FETCH_TIMEOUT` 全删后,[fetch-utils.ts:34](src/lib/fetch-utils.ts#L34) 的 export + 其注释一并移除(grep 确认零残留)。

---

## 与 v4 P2.6 的协调

`send.ts` 是进行中的 v4 重构核心,但本改动只动其**内部 fetch 传输层**(换库 + 加 dispatcher),不碰 codec/driver/envelope 语义,v4 与 legacy 同时受益、无冲突。可在 v4 推进中并行落地。DESIGN.md 第 293 行"仅 Node 路径生效"及"运行时兼容"表的 fetch 分流描述需相应更新。

## Commit 拆分（每个自洽 + typecheck/test/eslint 绿 + 主动提交）

1. **proxy.ts**:导出 `getUpstreamDispatcher` + Bun 路径构造/缓存 dispatcher(无热路径行为变化:Node 仍 setGlobalDispatcher,新增 getter + Bun dispatcher 缓存)。
2. **核心热路径** send.ts + anthropic/client.ts:换 undiciFetch + dispatcher,删该两处 `DISABLE_BUILTIN_FETCH_TIMEOUT` + 专测(根因修复:Bun 长流获 keepalive;含 800KB body / 流式 / abort / dispatcher keepalive 配置 / 代理路径)。
3. **其余调用点统一**:GHC(embeddings/models/web-search)+ 非 GHC(token/copilot-api/count-tokens/ui-proxy)全部改 undiciFetch + dispatcher;删光剩余 `DISABLE_BUILTIN_FETCH_TIMEOUT` 用法 + 移除 [fetch-utils.ts](src/lib/fetch-utils.ts#L34) 的 export;更新 DESIGN.md(运行时兼容表的 fetch 分流描述 + 第 293 行 keepalive"仅 Node 生效"表述 + bun-first 章节 undici 定位)。
4. **告警优化**:upstream-diagnostics.ts + streaming-pump.ts + 测试(反映新现实:keepalive 两端生效,hint 改为提示下调 `timeouts.upstream_keepalive`)。

## 验证

- `bun run typecheck` + `bun run test:backend` 全绿(每 commit)。
- 新增专测覆盖:800KB body、流式 + abort、dispatcher keepalive 配置、代理路径、告警 keepalive 字段 + likely-cause。
- **实测裁决(用户启服务器)**:Bun 下打一个真实 opus 长 thinking 请求,期间 `ss -tno | grep 443` 应看到上游连接带 `timer:(keepalive,...)`;长静默不再 `transport-close`。(本项目原则3:不自动起服务器,需用户操作。)
- subagent review + 主线亲自核验关键结论;流式/时序测试连跑 10–25× 确认确定性。
