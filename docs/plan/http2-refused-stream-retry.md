# 方案:重试上游 h2 `NGHTTP2_REFUSED_STREAM`(经双 subagent 对抗审查 + RFC 9113 裁决 + 运行时确认)

## Context(为什么做)

生产(**运行时 = Bun**,已确认)上 `POST /v1/messages` 等每天约 10 次以 `[FAIL] … Stream closed with error code NGHTTP2_REFUSED_STREAM` 收场、返 500、History 记 `failed`。

- **触发方(GHC 上游)正常,非 bug。** per-origin **单 h2 会话池**([http2-client.ts:58](src/lib/transport/http2-client.ts#L58))多路复用所有请求;GHC 边缘/LB 周期性 GOAWAY drain 连接,在飞流被 `REFUSED_STREAM` 拒。竞态不可消除,协议设计的应对就是"换新连接重试"。
- **REFUSED_STREAM 是 HTTP/2 里最安全可重试的错误。** RFC 9113 §5.1.2/§8.7(subagent 逐字裁决):REFUSED = *"refused prior to performing any application processing"*,*"Any request that was sent on the reset stream can be safely retried … clients MAY automatically retry them, **even those with non-idempotent methods**"* —— **协议保证零处理**,故重试 POST 无重复执行/计费风险。与普通 5xx、mid-stream `NGHTTP2_CANCEL`(可能已部分处理)有本质区别。
- **FAIL 是我们的分类缺陷(undici→node:http2 迁移遗留)。** 该消息不匹配 [classify.ts:245-258](src/lib/error/classify.ts#L245) `NETWORK_ERROR_PATTERNS`(全是 socket/TLS/errno 词汇)→ 穿到 [classify.ts:81](src/lib/error/classify.ts#L81) 落 `bad_request` → 无 strategy 认领 → [driver.ts:301](src/lib/pipeline/driver.ts#L301) throw → FAIL。

**运行时确认(化解审查 H1)**:生产 Bun 打出该消息 ⇒ **Bun 的 node:http2 在 pre-response 会如实抛出 REFUSED 错误**(走 [http2-client.ts:397](src/lib/transport/http2-client.ts#L397) `req.once("error")` reject,**不同于** line 366 body-stream handler)。代码里 [http2-client.ts:359-365](src/lib/transport/http2-client.ts#L359) 的 "Bun 吞成 clean end" caveat **只针对 mid-stream body 流**,与本 pre-response 修复正交、不适用。生产日志即独立 oracle,证明修复对观测 case 有效。

**预期结果**:REFUSED(及经探针确认的 GOAWAY-unprocessed)被分类为可重试 → 复用 `network-retry`(全 4 格式链 index 0)→ S4 重试环重发、`getSession` 自动落新会话 → 一次重试即成功,客户端不再见 500。

## 方案:精确扩分类 + 复用 network-retry(不新增 strategy/type)

REFUSED 概念上属 `network_error` 桶(瞬时连接级、重试一次),且是**该桶最安全成员**(比已在桶里的 ECONNRESET 更安全:后者 POST 上可能已服务端处理,前者协议保证未处理)。故不新增 strategy、不新增 ApiErrorType —— 只精确分类为 `network_error`,重发/换会话/waitMs/预算 gate/`[RETRY-n]` 全复用。

**为何不做专用 strategy(YAGNI,审查一致)**:专用 strategy 只在需区分延迟(近 0 vs 1s)/次数/主动 evict 时有价值;当前 ~10/天、1s 可忽略、池已自动 drop 会话。日后遥测证明裸重试命中率低再升级。

### scope:http2 协议可安全重试族(经 Phase 0 探针钉死形态)

- **REFUSED_STREAM**:已确认(生产 Bun oracle)。命中消息子串 `NGHTTP2_REFUSED_STREAM`。
- **GOAWAY-unprocessed**(采纳审查 HIGH-1,不再"无数据暂缓"):`ERR_HTTP2_GOAWAY_SESSION` 是同一 drain 的另一表现、RFC 对高于 Last-Stream-ID 的流同样保证可安全重试。**Phase 0 探针实测**它在本池化架构下能否发生([getSession](src/lib/transport/http2-client.ts#L154) 只查 `!closed && !destroyed`,GOAWAY 未 close 的 session 可能被复用后抛此错)——能发生则纳入同一 helper(同协议安全族、仅多一处字符串匹配,非投机表面);探针证明不会发生则实证文档化后跳过。
- **绝不**泛匹配 `ERR_HTTP2_STREAM_ERROR` 或 `NGHTTP2_`(会连带 `NGHTTP2_CANCEL`/`INTERNAL_ERROR` —— 无零处理保证,盲重试 POST 有重复风险)。`NGHTTP2_CANCEL` 维持 `bad_request`、不重试(守卫测试锁死边界)。
- **必须按 message 子串、不按 `error.code`**(采纳审查 M1,实测:`error.code === "ERR_HTTP2_STREAM_ERROR"` 通用、不区分 REFUSED/CANCEL,具体码只在 message —— code 匹配会破坏 REFUSED/CANCEL 边界)。

## Phase 0:pre-response 探针(实证优先,先于写码)

放 `exp/http2-refused-retry/`(不放 /tmp)。用 `http2.createServer()` 在 `secureConnection`/stream 到达时**在发送任何响应头之前** `stream.close(NGHTTP2_REFUSED_STREAM)`(pre-response,**非** mid-stream),客户端分别用 **Bun** 与 **Node** 跑 `http2.connect` 观测:
1. REFUSED 的确切 `err.message` / `err.code`(两运行时),确认 `isRetryableHttp2StreamError` 匹配式无误报/漏报。
2. 构造 MAX_CONCURRENT_STREAMS 超限 + GOAWAY drain,观测是否产生 `ERR_HTTP2_GOAWAY_SESSION`、其消息形态,决定 GOAWAY 是否纳入 scope。
产出探针报告存 `exp/http2-refused-retry/report.md`。

## 改动文件

1. **[src/lib/error/classify.ts](src/lib/error/classify.ts)** — 核心。加独立、带 **RFC 9113 §5.1.2/§8.7 "零处理保证" 注释**的 helper `isRetryableHttp2StreamError`(采纳 MEDIUM-1:注释显式说明为何可安全重试 POST、为何**不**匹配 CANCEL/INTERNAL_ERROR),在 `classifyError`(:49)的 `isNetworkError`(:72)分支前/内命中 → 返回 `type: "network_error"`。复用 `error.cause` 递归遍历(与 isNetworkError 一致,Node 有时包一层)。**不**把 token 塞进 `NETWORK_ERROR_PATTERNS`(语义纯洁)。
2. 无其它 src 改动。分类是单一源,同时修 v4 driver([driver.ts:288](src/lib/pipeline/driver.ts#L288))与 legacy web_search 双跳([request/pipeline.ts:298](src/lib/request/pipeline.ts#L298))(审查确认二者共享同一 classifyError、无路径绕过)。

## TDD 步骤

1. **RED — 分类单元测试** [tests/infra/error.unit.test.ts](tests/infra/error.unit.test.ts)(`describe("classifyError")` :109):
   - `classifyError(new Error("Stream closed with error code NGHTTP2_REFUSED_STREAM"))` → `network_error`(现 `bad_request`,先失败)。
   - **守卫测试(锁精确 scope)**:`NGHTTP2_CANCEL` 仍 → `bad_request`。
   - `cause` 链变体各一条;若 Phase 0 纳入 GOAWAY,加 `ERR_HTTP2_GOAWAY_SESSION` → `network_error`。
2. **GREEN** — 实现 helper,`bun run test:unit` 转绿。
3. **transport 级独立 oracle 测试**(采纳审查 HIGH-2,破 self-consistent 假绿) [tests/transport/](tests/transport/) 新增 `.it.test.ts`:用 [setHttp2SessionFactoryForTests](src/lib/transport/http2-client.ts#L203) 注入 h2c `http2.createServer()`,服务端 **pre-response** `stream.close(NGHTTP2_REFUSED_STREAM)`,断言 `http2Fetch`/`upstreamFetch` reject 的 err **真实** message 形态 → 经 `classifyError` → `network_error`。这测到**真实 wire**(合成 `Error` 测不到)。镜像既有 h2c 注入范式 [tests/transport/http2-client.it.test.ts:45](tests/transport/http2-client.it.test.ts#L45)。(若 `bun test` 下该 h2c pre-response 行为异常,Phase 0 已先验;退路是 classify 单测 + 生产 log oracle。)
4. **E2E 重试测试** [tests/anthropic/anthropic-v4.http.test.ts](tests/anthropic/anthropic-v4.http.test.ts):镜像既有 `"network-retry: … retries once then succeeds"`(:280),首击抛 REFUSED、次击成功,断言两次上游命中 + 成功体 + 记录一次 `[RETRY]`。现在有 step 3 的真实 oracle 兜底,这条锁全链(分类→strategy→重发→成功)不再是纯自洽。openai-cc/responses parity 可选。

## 已知限制(文档化,非阻塞;采纳审查 M2/M3、LOW-1)

- **单次重试闩锁跨错误共享**:[network-retry.ts:35](src/lib/request/strategies/network-retry.ts#L35) 的 `hasRetried` 被 REFUSED 与后续真 ECONNRESET 共享 —— **非回归**(严格优于今日的零重试),但 GOAWAY drain 风暴下一请求内第二个 REFUSED 会 FAIL。当前频率下容忍;遥测若见成簇再拆专用 strategy/独立 budget。
- **L2 `protect_streaming` buffered retry** 内部 [runExchange](src/lib/pipeline/driver.ts) 复用同一 strategy 实例 —— REFUSED 是 pre-response、buffered 路径在 pre-response 前尚未开始缓冲,交互良性;文档记录待遥测。

## 验证

- Phase 0 探针(Bun + Node)先跑,产报告。
- `bun run test:unit` + `bun run test:backend`(含新 transport oracle + E2E)+ `bun run typecheck`;改动文件 `eslint --fix`。
- 不起服务器(no-auto-server);行为由 transport oracle + E2E 覆盖。

## 收尾(采纳审查 MEDIUM-2:落点纠偏)

- **DESIGN.md**:落 `error/` 模块图**反直觉契约段**(classify 的 http2 协议可安全重试族)或 h2 transport 行,**不**落"流式截断检测"行(REFUSED 是 pre-response 分类缺陷、非流截断)。可补 [docs/spec/upstream-http2-transport.md](docs/spec/upstream-http2-transport.md)。
- **memory**:登记两条 —— ① REFUSED_STREAM 协议保证可安全重试(含非幂等 POST)、分类缺陷源自 undici→http2 迁移;② 实测:Bun node:http2 pre-response 如实抛 REFUSED(mid-stream caveat 不适用于 pre-response)。互链 [[reference-bun-http-connect-broken-and-http2-handshake-hang]]、[[feedback-self-consistent-needs-independent-oracle]]。

## 提交(细粒度,一阶段一 commit)

1. `test: add failing classify tests for retryable http2 stream errors`
2. `fix: classify http2 REFUSED_STREAM (+GOAWAY-unprocessed) as retryable network error`(classify.ts + transport oracle + E2E)
3. `docs: record http2 retry-safe classification`(DESIGN/spec/memory)
