# RFC：History HTTP Header 捕获的理想形状重构

状态：**已落地** — Phase 0/1/2/3/4/5 全部完成（golden + 存原始 + driver 捕获删 bag + per-attempt ②③ + 第四腿 inboundResponse + in-flight 可见，全套测试绿）。设计基线：草案 v6.1（完整阶段模型；完整性轴复审通过、无残留裁剪）。

> **v6.1 修订（完整性轴复审）**：两个 reviewer 用 richest-data-flow 完整性轴（显式覆盖 YAGNI）复审——确认 v6 已彻底逆转 v1-v5 裁剪、无残留（两个"空/no-op"是 WS 真无源非裁剪）。精修：③ per-attempt 持久化**非纯加字段**（driver 现根本不写 per-attempt response，须在 `runExchange` 成功/catch 新增写入，§4.3/§5 Phase 3）；OQ1 经实测解答（Hono streamSSE 非 lazy，`c.res.headers` 返回后可靠）；补 trailers 未来完整性占位 OQ5。

> **v6 重定向（operator 纠正 v1-v5 的根本设计错误）**：v1-v5（我 + 默认持 DRY/YAGNI 的 subagent）用"重复""无消费者"去**裁剪数据模型**（砍 per-attempt headers、删 inboundResponse 腿）——这违反本项目 richest-data-flow 硬约束："History 记录请求/响应生命周期所有可观测原始数据，**后端存储必须完整，前端展示可选择性呈现**"。"无 UI 消费"不是删除理由（前端选择性展示 ≠ 后端可不存）；"与另一腿字节相同"也不是（它们是**不同阶段**的真实记录，恰好当前相同不代表语义相同）。**正确形状=四条腿都是代理中继的真实边，每条腿（及每个 attempt）自然地记录它完整的头**。v6 据此**逆转所有裁剪**：补齐 per-attempt headers、建 inboundResponse 腿，而非删除。

## 1. 完整阶段模型（理想形状）

代理是一个带重试的请求/响应中继。它的生命周期有**四条真实的可观测边**，每条边都该完整记录其 HTTP 头——这是 History 作为忠实可观测记录的本分：

```
  ┌─────────┐  ①inboundRequest   ┌─────────┐  ②outboundRequest   ┌──────────┐
  │ Client  │ ──── request ─────▶ │  Proxy  │ ──── request ─────▶ │ Upstream │
  │         │ ◀─── response ───── │         │ ◀─── response ───── │  (GHC)   │
  └─────────┘  ④inboundResponse   └─────────┘  ③outboundResponse  └──────────┘
```

| 腿 | 阶段（代理的边） | 基数 | 当前状态 |
|---|---|---|---|
| ① `inboundRequest` | Client → Proxy 请求头 | per-request（1） | ✅ 已捕获 + 持久化 |
| ② `outboundRequest` | Proxy → Upstream 请求头 | **per-attempt（N）** + 顶层镜像最终 | ⚠️ 顶层有；per-attempt 采集后被 `legFromWire` 丢弃 |
| ③ `outboundResponse` | Upstream → Proxy 响应头 | **per-attempt（N）** + 顶层镜像最终 | ⚠️ 顶层有；per-attempt 无存储槽 |
| ④ `inboundResponse` | Proxy → Client 响应头 | per-request（1） | ❌ 类型声明存在、从未捕获（数据源在 handler 写出点、只是没接线） |

**基数自然性**：客户端只发一次请求、只收一次响应（①④ per-request）；代理对上游每次 attempt（含重试）都发一次请求、收一次响应（②③ per-attempt，顶层镜像最终 attempt = "最终发生了什么"）。这是忠实记录，不是冗余。

**存储/展示分工**（richest-data-flow）：后端**完整**存四腿 + 全 attempt；前端 UI **选择性**呈现（当前只渲三腿、不渲 per-attempt——那是展示选择，不是不存的理由）。

## 2. 背景与误判纠正

最初怀疑"History 根本不存 HTTP headers"被实证推翻：已完成 entry（`req_1782120532100_1512`）三腿俱在、入站 21 头持久化（httpHeaders 随 head-meta blob 落盘，`serialize.ts` 的 `extractHeadMetaPayload` 不排除它）。最初看到"空"是 in-flight streaming entry（§3.5 in-flight 不可见），非持久化丢失。

所以本 RFC 不修"不存"漏洞，而是把一个**不完整**（②③ per-attempt 丢失、④ 未建）、**脱敏**（operator 要原始）、**散落捕获**（handler-bag 关注点泄漏）、**in-flight 不可见**的子系统**补齐到完整阶段模型**。

## 3. 现状缺口（相对完整模型，逐处对照代码）

### 3.1 ② per-attempt outboundRequest 头：采集后被丢弃

各 codec sampleRequest（anthropic `codec.ts:451`/cc:466/responses:471）产 per-attempt `wireRequest.headers`（源 `wire.headers`，driver.ts:253 prepareWire），经 `setAttemptWireRequest` 进 `attempts[].wireRequest`。但 `legFromWire`（`request.ts:85-94`）序列化时**不输出 `headers` 字段**（`RequestLegData` `types.ts:190` 无 headers 槽）——per-attempt 请求头落盘时被丢。顶层 `outboundRequest` 仅由 finalize（`request.ts:567`）从最终 attempt 捞一份。

### 3.2 ③ per-attempt outboundResponse 头：无存储槽

`attempts[].response`（`OutboundResponseData` `types.ts:200`）**无 header 字段**。顶层 `outboundResponse` 头由 handler-bag 的 `capture.response`（`fetch-utils.ts:28`，未脱敏）经 `setHttpHeaders` 写——但那只保留**最后一个 attempt**（每 attempt `captureHttpHeaders` 重新赋值覆盖，`send.ts:131-133`）。per-attempt 响应头无处可存。

> 上游响应头其实已有干净 per-attempt 数据源：成功路 `UpstreamStream.headers`（`pipeline/types.ts`，`http-transport.ts:93/105` 返回、driver `:468` 收）、失败路 `HTTPError.responseHeaders`（`http-error.ts:9/18`，每 attempt 抛错携带；经 `classifyError` 进 `apiError.raw`）。当前是经 handler-bag 旁路中转，且只留最终 attempt。

### 3.3 ④ inboundResponse 头：从未捕获（数据源未接线，非不存在）

类型字段 `httpHeaders.inboundResponse?: Record<string,string>`（4 处声明：`history/types.ts:268`、`context/types.ts:195/289`、`context/request.ts:142`，注释 "reserved for future use"）零 producer。**但数据源存在**：代理经 `streamSSE(c,…)`（`handler-v4.ts:388`）/ `c.json(…)`（`:506`）发客户端响应，`c.res.headers` 即代理实发给客户端的头。**缺的是 handler 写出点的捕获接线**，不是数据源。reviewer 早先"无数据源"结论混淆了"sink（`makeSseSink` 只持 `SSEStreamingApi`、不持 `c`）拿不到"与"代理（handler 持 `c`）拿不到"——后者拿得到。

> 同名陷阱：`HistoryEntry.inboundResponse`（`types.ts:251`，`ForwardedResponse` body 腿，转发帧内容）是另一回事、已活；`httpHeaders.inboundResponse`（header 腿）才是未建的。建 header 腿不碰 body 腿。

### 3.4 handler-bag：关注点泄漏 + 出站请求头双写

`HeadersCapture`（`context/types.ts:130`）是穿透 transport 的 mutable bag。每 handler driver 外 `new`、穿 transport deps、driver 返回后 `setHttpHeaders` 两次。`grep \.setHttpHeaders(` 13 处 / 6 文件。`grep headersCapture driver.ts` 零命中——driver 拥有 transport + S4 per-attempt 循环，却把出站 header 生命周期泄漏给每个 handler。且 bag `capture.request` 与 codec sampleRequest 同源 `wire.headers` 字节相同（出站请求头双写）。

> **澄清（v6）**：这是**捕获机制**（HOW）的关注点错置——driver 该拥有它产的数据。修它=换干净的单一捕获路径、**完整填四腿 + per-attempt**，**不是**删数据。与"不裁剪数据模型"不冲突：删的是冗余的 mechanism（一个字段两个写入者），保的/补的是数据。

### 3.5 脱敏 + in-flight 不可见

- **脱敏**：`sanitizeHeadersForHistory`（`fetch-utils.ts:32`，敏感头→`***`）在 History 捕获路径（入站 `:9`、出站 `:27` + codec `:451/:466/:471` + legacy client `:48/:63/:101`）。operator 要**存原始**。betaProbe（`codec:391`，只读 anthropic-beta、零泄漏）是唯一非 History 消费者，保留其调用不动；无 error-artifact 消费者（JSDoc 字面是幽灵契约）。③ `outboundResponse` 经 `capture.response`/`UpstreamStream.headers` 本就未脱敏。
- **in-flight 不可见**：header setter（`request.ts:279/289`）不 publish、`snapshot()`（`:163-181`）不含 httpHeaders、httpHeaders 只 finalize 组装、history sink `onContextUpdated`（`history.ts:178-221`）无 httpHeaders 分支——流式期 live 看不到（最初"空"的根因）。

## 4. 设计：补齐每腿到完整 + 干净捕获

原则：**每腿/每 attempt 自然记录其完整头；后端全存、前端选择性展示；捕获机制干净（driver 拥有它产的数据），但绝不为 DRY/无消费者裁剪数据。** 脱敏存原始（operator）。

捕获归属层正确（`eslint.config.js:149-156` 批准"mutate injected RequestContext or accept ScopedPublisher via DI"）：driver/handler mutate `ctx.httpHeaders` → ctx 注入的 publisher 发 `request.context_updated` → HistorySink，不绕 bus。

### 4.1 捕获产原始 + sink 落原始（不建开关）

History 捕获路径的 sanitize 调用改产原始头；sink 直接落原始、不加开关（operator 决策；betaProbe sanitize 保留不动）。脱敏退路是概念演进点（未来若需在 sink 单点加注释指明），非现在建表面。

### 4.2 ②③ 出站两腿：driver 用现成数据源 per-attempt 捕获

driver 在 S4 per-attempt 循环用**已存在的干净来源**写 ctx，每 attempt 一份 + 顶层镜像最终：

- ② outboundRequest：`wire.headers`（`driver.ts:253` 在手，原始）。
- ③ outboundResponse：成功读 `upstream.headers`（`UpstreamStream.headers`）、catch 读 `apiError`/`HTTPError.responseHeaders`。**前置**：扩 `classifyHTTPError`（`classify.ts`）让所有 HTTP-错误分支透传 `responseHeaders`（当前只 422/402/429/503，源 `HTTPError.responseHeaders` 恒带、`http-error.ts:24`），否则 400/500/502 等失败丢响应头。网络/abort 失败无上游响应（`send.ts:127` capture 前 throw），③ 正确为空。

捕获机制清理：删 handler-bag（每 handler `const headersCapture={}`）、13 处 `setHttpHeaders`、transport `headersCapture` dep、`captureHttpHeaders`、finalize 双写迁移（`request.ts:567`）；`sendUpstreamHttp` 返回签名扩暴露 `response.headers`，两个 transport（`http-transport.ts:93/105`、`responses-transport.ts:126/129`）从它构造 `UpstreamStream.headers`（脱 bag）。codec sampleRequest header 行**保留**（`WireRequest.headers` 非可选，`context/types.ts:50`）、去 sanitize 产原始。

### 4.3 ②③ per-attempt 持久化（补完整，不再丢）

`attempts[]` 完整存每 attempt 的出站两腿头：

- ② `RequestLegData`（`types.ts:190`）加 `headers?: Record<string,string>`；`legFromWire`（`request.ts:85`）输出 `headers: wp.headers`（修 §3.1 落盘丢弃；顶层 outboundRequest 经 finalize 镜像最终 attempt 本已活，此处补的是 per-attempt 槽，不冲突）。**纯机械加字段。**
- ③ `OutboundResponseData`（`types.ts:200`）加 `headers?: Record<string,string>`。**注意（实测）：driver 当前根本不写 per-attempt response**——`setAttemptResponse`（`request.ts:350`）只被 `complete()`/`fail()` 调一次写 final attempt；`runExchange`（`driver.ts:240-328`）成功路只 `return {upstream,env}`、catch 路只 `setAttemptError`，非终态 attempt 从不落 response。故 ③ per-attempt 须**新增 driver 写入逻辑**：在 `runExchange` 成功 `return` 前写 `upstream.headers`、catch 分支写 `apiError.responseHeaders` 到当前 attempt。数据源都可得，但这是新写入路径、非纯加字段（工作量大于 ②）。
- serialize 的 per-attempt stage（`serialize.ts:380-381` outbound_request/outbound_response row，payload=整对象）随 wireRequest/response 持久化 headers（既有 stage 容器，加字段即随对象 JSON 落盘 + deserialize 还原）。

顶层 `httpHeaders.outboundRequest/outboundResponse` 镜像最终 attempt。

### 4.4 ④ inboundResponse：建捕获（补完整第四腿）

handler 在写出点捕获代理实发给客户端的响应头，写 `ctx.httpHeaders.inboundResponse`：

- 流式：`streamSSE(c,…)` 设置响应（`handler-v4.ts:388`）后读 `c.res.headers`（Hono 已置 Content-Type 等 + 代理任何显式头）。
- 非流式：`c.json(…)`（`:506`）前后读 `c.res.headers`。
- 4 格式 handler 各接一处（与 ① 入站捕获对偶）；WS 路径按其语义（客户端经 WS 帧收，无 HTTP 响应头）保持空或记 WS 元数据——见 OQ。

保留 4 处类型声明（**不删**，§1 它是真实阶段），改为有 producer 的活腿。

### 4.5 in-flight 可见（经 bus）

不进轻量 `snapshot()`（保精简）。两处：① header setter（`request.ts:279/289` 及新增 inboundResponse setter）发 `request.context_updated`（`field:"httpHeaders"`、`contextRef:ctx`）；② history sink `onContextUpdated`（`history.ts:178-221`）加 `field==="httpHeaders"` 分支 `updateEntry(ctx.id,{httpHeaders:ctx.httpHeaders})`（读 live ref，`entries.ts:101` allowlist 已含）。

### 4.6 保留的 per-format / per-transport 真实差异

anthropic-beta 语义消费（`codec.ts:325` 读 + `request-preparation.ts:208` 注入）留 codec（与捕获正交）；WS 入站头 connection-scope（`ws.ts:240` 有意 `new Headers()`）——统一捕获对 WS 入站 no-op；web_search 旁路保留自己的捕获点。

## 5. Phase 拆分与 commit invariants

**总不变量**：每个中间 commit，已实现的腿不回退为空；新建腿增量上线。golden 覆盖**完成 + HTTP-错误失败（非-{422,402,429,503} 状态如 502）+ 网络失败（③ 正确空）+ 多-attempt 重试（②③ per-attempt 完整）**。

- **Phase 0（golden 预捕获）**：旧代码上 4 格式 ×（完成 + HTTP-错误失败 + 重试）golden，锁现有三腿 + 敏感头（`***`，Phase 1 更新）。`tests/history/*.it.test.ts`。
- **Phase 1（存原始）**：拆 History 捕获路径 sanitize；betaProbe 不动；sink 不加开关。迁移断言 `***` 的测试（`anthropic-client.it.test.ts:97`、`openai-responses-client.it.test.ts:117`、`history-store`/`history-api`/`request-context`）。Invariant：三腿在、敏感头变真实。
- **Phase 2（②③ driver 捕获 + 删 bag + 扩 classify）**：前置扩 `classifyHTTPError` 全分支透传 responseHeaders；driver per-attempt 写出站两腿（成败两路）；`sendUpstreamHttp` 返回扩 response.headers、transport 脱 bag。过渡双写比对（完成 + 502 失败）逐格式一致后删 bag + 13 setHttpHeaders + transport dep + captureHttpHeaders + finalize 迁移。迁移测试 `request-context.unit.test.ts:537/621/627`、`http-transport.it.test.ts:80/84/86`、`fetch-utils.it.test.ts:55-62`。Invariant：顶层三腿（含 HTTP-错误 ③）不回退。
- **Phase 3（②③ per-attempt 持久化）— 已落地**（c221028）。② `RequestLegData` 加 headers + `legFromWire` 输出 + **修 history sink onTerminal 的 outboundRequest 显式字段投影漏 headers**（根因：加新 leg 字段必须同步所有手列投影点）→ `attempts[].wireRequest.headers` / 顶层 outboundRequest 腿逐 attempt 完整。③ 新增 driver per-attempt 写入路径：`setAttemptResponseHeaders` setter，driver 为**每个** attempt 写（成功 `upstream.headers` / 失败 `apiError.responseHeaders`，不同于 `response` 仅 final 经 complete/fail），小字段随 attempt summary（head blob）落盘 → `attempts[].responseHeaders` 逐 attempt 完整。**注**：曾一度误用"冗余/无消费者"暂缓——那正是 richest-data-flow 禁止的裁剪谬误（[[feedback-richest-data-flow-store-complete-no-pruning]]）；序列化丢 headers 是该修的 bug（显式投影漏字段）而非放弃理由，已撤回并修复。
- **Phase 4（④ inboundResponse 建捕获）**：4 格式 handler 写出点捕获 `c.res.headers` → `ctx.httpHeaders.inboundResponse`；保留 4 处类型声明改活腿。Invariant：四腿齐全；WS 按语义。
- **Phase 5（in-flight 可见）**：setter publish + sink onContextUpdated 分支。Invariant：终态不变；in-flight 含 httpHeaders；WS 推送体积不爆。
- **Phase 6（① 入站捕获收敛，暂缓收尾）**：4 格式逐字节相同的入站捕获上移 driver S1（最低优先，撞 reject 路径 ctx 生命周期，OQ）。

## 6. Open questions

1. ~~**④ inboundResponse 的捕获时机**~~（已实测解答）：Hono `streamSSE` **非 lazy**——同步经 `c.header()` 设 4 头（Content-Type/Transfer-Encoding/Cache-Control/Connection）后 fire-and-forget 跑回调，`streamSSE(...)` **返回后** `c.res.headers` 即可靠完整。捕获改 `const resp = streamSSE(...); 读 resp.headers/c.res.headers; return resp`（非流式 `c.json` 同理）。无需移到 sink 启动点。
2. **④ WS 客户端语义**：Responses 客户端 WS（`ws.ts`）经 WS 帧收响应、无 HTTP 响应头——④ 对 WS 存空（真无源，非裁剪；WS 仍经历 ②③ 出站腿、照常记）。是否另记 WS 帧元数据（首帧时间）属另一可观测维度，倾向空 + 文档化。
3. **② per-attempt 跨 attempt dedup**：多 attempt 头近乎相同，是否 dedup（zstd 已压、倾向不 dedup 保完整）？
4. **Phase 6 入站上移与 reject 路径**：reject 保留入站捕获是否让 reject 也建 entry？
5. **响应 trailers ✅ 已实现（2026-06-24）**：GHC h2 响应理论上可带 trailers。探针实证 Bun `node:http2` 确实 emit `trailers` 事件（data 帧后、end 前），故"无数据源"实为"没接线"。已接线：`UpstreamFetchInit.onTrailers` 回调 → `http2-client` 注册 `req.once("trailers")` 归一成 record → `http-transport` 接到 `ctx.setOutboundResponseTrailers` → 存 `httpHeaders.outboundResponseTrailers`（第 5 个 header 腿），经 head blob round-trip。事件序保证回调先于 handler settle 落地。明文 http 路径无 trailers、不调。capture-when-present（GHC 当前少发→多缺省，与其它可选腿同语义，非永空投机表面）。

## 7. 测试策略

- **逐格式 golden（`tests/history/*.it.test.ts`）**：4 格式 ×（完成 + 502 失败 + 重试）；断言四腿结构 + 键集；Phase 1 后敏感头真实值；HTTP-错误失败守 ③ 不回退、网络失败守 ③ 正确空。
- **per-attempt（`tests/pipeline/` + `tests/history/`）**：mock 首次失败触发 retry，断言 `attempts[].wireRequest.headers`/`.response.headers` 逐 attempt 完整。
- **④ inboundResponse（`tests/history/` + handler 测试）**：断言四格式 entry 的 `httpHeaders.inboundResponse` 含代理实发响应头（Content-Type 等）。
- **既有测试迁移**：见 Phase 1/2 清单。
- **安全回归**：History 落盘原始头；betaProbe 只取 anthropic-beta 不异常。
- 隔离：DI/fetch-mock、临时 history runtime，不碰真实 `history.db`。

## 8. 不变量（编码进实现）

1. **四腿齐全**：①inboundRequest ②outboundRequest ③outboundResponse ④inboundResponse，每腿真实阶段、自然基数（①④ per-request，②③ per-attempt + 顶层镜像）。后端完整存、前端选择性展示——**绝不因 DRY/无消费者裁剪数据模型**。
2. History 落盘存**原始未脱敏**头；sink 不加开关；betaProbe 保留自有 sanitize。无 error-artifact 幽灵契约。
3. ②③ 出站两腿各唯一干净捕获路径（driver S4 per-attempt：② `wire.headers`、③ `upstream.headers`/`HTTPError.responseHeaders`），无 handler-bag、无双写。
4. ②③ per-attempt 完整持久化（`attempts[].wireRequest.headers`/`.response.headers`）；顶层镜像最终 attempt。
5. ③ HTTP-错误失败经扩 `classifyHTTPError` 全分支透传 responseHeaders 捕获、不回退；网络/abort 失败正确为空。
6. ④ inboundResponse 有 producer（handler 写出点 `c.res.headers`）——活腿、非死表面。
7. in-flight 可见经 bus（不进 `snapshot()`）；anthropic-beta 留 codec；WS 入站头 no-op。
8. 每中间 commit：已实现腿不回退、新建腿增量；golden 守完成/失败/网络/重试四类。
