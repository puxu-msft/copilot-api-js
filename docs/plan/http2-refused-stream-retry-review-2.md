# 对抗性审查报告:重试 NGHTTP2_REFUSED_STREAM 方案

> **类型**：对抗性审查报告 —— 非独立 plan，实施状态见父 plan [http2-refused-stream-retry.md](http2-refused-stream-retry.md)。

裁判轴:长远架构正确 + 范围内彻底 > 改动量;真实风险必修;richest-data-flow;doc-sync;但守 YAGNI。

**总评**:方案的核心机制判断正确且经实测/源码验证。分类点选对了(REFUSED 走 `isNetworkError` 分支而非 HTTPError 分支),全 4 格式 + legacy web_search 自动修好,可观测性无盲点。但有若干 HIGH/MEDIUM 需在实施前落实,尤其**测试真实错误形态触达路径**与 **GOAWAY 同源漏洞的判断依据不足**。

---

## 逐问核验(带 file:line 证据)

### 1. 覆盖完整性 — 分类改一处是否真修好全部路径? ✅ 是

- `network-retry` 在**全 4 格式链的 index 0**,实证:
  - anthropic `strategies.ts:88` `adapt(createNetworkRetryStrategy...)`
  - openai-cc `strategies.ts:54`
  - openai-responses `strategies.ts:46`
  - **gemini** 走 `buildOpenAiCcStrategies`(`gemini/handler-v4.ts:87`),故也含 network-retry。
- **legacy web_search 双跳共享同一 classifyError**:`request/pipeline.ts:298` 的 `executeRequestPipeline` catch 里 `classifyError(error)`,与 v4 driver(`driver.ts:288`)是**同一函数**。分类是单一源 → 两条路径都自动修好。方案此断言(:33)成立。
- **没有路径绕过 classifyError**:v4 driver 的 catch(`driver.ts:288`)与 legacy pipeline(`pipeline.ts:298`)是仅有的两个上游错误分类点,都调 classifyError。
- **分类点选择正确(关键验证,曾疑为 CRITICAL)**:REFUSED_STREAM 在 pre-response 阶段由 `http2-client.ts:397` `req.once("error", err => reject(err))` reject `http2Fetch` 的 promise,error 是**原始 `Error`**(message 含 `NGHTTP2_REFUSED_STREAM`)。`send.ts:114-141` 的 catch **不把它包成 HTTPError**——只有 `rewriteShutdownAbort && isAbortError` 才包 529(REFUSED 非 abort),否则 `throw error`(:140)原样上抛。故到 classifyError 时它是 `Error` 实例、走 `isNetworkError` 分支(`classify.ts:72`),方案在该分支前/内加 helper **够得到**。`isNetworkError` 用原始 `error.message`(`classify.ts:284`)、不经 `formatErrorWithCause`,子串匹配作用于原始 message,`NGHTTP2_REFUSED_STREAM` 直接可匹配。

### 2. 可观测性 / History — 失败尝试是否留痕? ✅ 有,无盲点

- REFUSED→重试成功后,失败尝试**会被记录**:
  - `[RETRY-n]` console 行由 `request.attempt_failed { willRetry: true }` 触发(`console.ts:132-133`, `onAttemptFailed`),该事件由 v4 driver 的 `recordAttemptFailure`(`driver.ts:336`)在 budget gate 通过后发射。
  - History `attempts[]` per-attempt 持久化:`history.ts:207-209` 对 `field==="attempts"` 增量 `persistEntryStages`,`history.ts:299` 记 `outboundResponse` 含 error(既有 `NGHTTP2_CANCEL` 测试 `persist-resilience.it.test.ts:150` 证 `attempts[].outboundResponse.error` 落盘)。
- **不会"失败被吞成成功"**:失败尝试的 error 记在该 attempt 的 outboundResponse,成功尝试是新 attempt。顶层终态是成功,但 attempts[] 保留失败痕迹 → richest-data-flow 满足。

### 3. scope 是否漏真问题 — GOAWAY 暂缓是 YAGNI 还是同源漏洞? ⚠️ 判断依据不足(见 HIGH-1)

- 池化架构确实存在 GOAWAY:`http2-client.ts:57` per-origin 单 h2 会话池,`:181` `session.on("goaway", drop)`。方案对触发机制的描述(GOAWAY drain 时已 dispatch 的在飞流被 REFUSED)与代码一致。
- **但方案对"GOAWAY 会话级错误(`ERR_HTTP2_GOAWAY_SESSION`)未观测到"的判断没有实证支撑**。当前无法从代码或本次审查断定其频率。这是"暂缓"决策的薄弱处——见 HIGH-1。

### 4. 测试充分性 — 合成 Error 的 E2E 是否触达真实 wire? ⚠️ 部分假绿风险(见 HIGH-2)

- classify 单测(方案 :37-40)充分且契合既有范式(`error.unit.test.ts:281-310` 已有 ECONNRESET 等同构测试 + `:360` abort 反例段),守卫测试(CANCEL 仍 bad_request)正确锁 scope。
- E2E(方案 :44)用 `applyFetchMock` 首击 throw `new Error("...NGHTTP2_REFUSED_STREAM")`——**但这绕过了 `http2-client.ts` 真实的 pre-response reject 路径**(fetch-mock 在 `upstreamFetch` seam 注入,`http2Fetch` 根本不执行)。它验证的是 classify→network-retry→重发全链(有价值),但**不验证真实 REFUSED 错误确实从 `req.once("error")` 冒泡到 classifyError 且 message 形态匹配**。见 HIGH-2 补测建议。

### 5. 架构健康 — 复用 network_error 桶 vs 新建 type? ✅ 复用合理,但 helper 命名需强表意(见 MEDIUM-1)

- 复用 `network_error` 桶 + 独立 helper(不塞 `NETWORK_ERROR_PATTERNS`)是对的:`NETWORK_ERROR_PATTERNS`(`classify.ts:245`)语义确为 socket/TLS/errno 词汇,混入 h2 协议码会误导。独立 helper 呼应 best-complete-solution「命名反映实际职责」。
- **语义差异担忧成立但不构成新建 type 的理由**:REFUSED(协议保证零处理)与 ECONNRESET(POST 上可能已处理)确实语义不同,但二者**重试动作相同**(network-retry 单次重试同 payload),且 network-retry 只重试一次(`network-retry.ts:41` `!hasRetried`),风险受控。新建 type/strategy 属 speculative surface(YAGNI),方案判断正确。但 helper 命名与注释必须把"协议保证可安全重试 vs 网络瞬断"的区别写清(见 MEDIUM-1),否则日后若要给 REFUSED 特殊延迟/次数,语义已被埋进 network_error 桶难以拆分。

### 6. 收尾 — DESIGN.md/memory 同步点是否够? ⚠️ 指向偏(见 MEDIUM-2)

---

## 分级问题清单

### HIGH-1:GOAWAY 暂缓缺实证依据,可能是同源真漏洞

方案 :25「当前未观测到」是**单方声称、无数据**。生产已确认 REFUSED ~10/天,而 REFUSED 与 `ERR_HTTP2_GOAWAY_SESSION` 是**同一 GOAWAY drain 事件的两种表现**:GOAWAY 到达时,`> Last-Stream-ID` 的流被 REFUSED(已被本方案覆盖),但**新 `session.request()` 打在一个刚收到 GOAWAY / 正在关闭的 session 上会抛 `ERR_HTTP2_GOAWAY_SESSION`**(RFC 9113 §6.8:GOAWAY 后 session 不再接受新流)。`http2-client.ts:154-156` 的 `getSession` 只检查 `!closed && !destroyed`——一个收到 GOAWAY 但尚未 `close`/`destroy` 的 session 仍会被复用,此时 `session.request()` 可抛 GOAWAY_SESSION。这条错误**不含 `NGHTTP2_REFUSED_STREAM` 子串**,方案 scope 不覆盖 → 仍落 `bad_request` → FAIL,且**RFC 同样保证对高于 Last-Stream-ID 的流零处理、协议安全可重试**。

**建议**:实施前用一个探针实测 GOAWAY 场景下 `session.request()` 抛出的 error message/code 形态(可复用本审查的 h2 probe 模式,server 端 `session.goaway()` 后 client 再发新流),据实测决定:(a) 若确会高频伴生 → 本次一并覆盖(同 helper 加 `ERR_HTTP2_GOAWAY_SESSION` / `GOAWAY` 判定,RFC 同等安全);(b) 若确不触发(getSession 的 drop 处理已挡住)→ 文档化"为何不会发生"的实证结论,而非"未观测到"的空判断。architecture-health-first:真实同源风险不应以"未观测到"归类为"等触发再说"。

### HIGH-2:E2E 未触达真实 http2-client reject 路径 → 自洽但没测到真实 wire

方案的 E2E 在 `upstreamFetch` seam 注入合成 Error,**`http2Fetch` 不执行**,故不验证:
1. 真实 REFUSED 是否确从 `http2-client.ts:397` `req.once("error")` reject(而非被 body-stream `controller.error` 路径 `:366`/`:376` 吞成 mid-stream truncation——这条路径对**已收到 response header 后**的 RST 才走,pre-response REFUSED 应走 `:397`,但无测试钉死)。
2. 真实 error message 形态是否精确等于合成的字符串。

**实测已部分补强**:本审查用 node:http2 探针确认 client 侧 `err.message === "Stream closed with error code NGHTTP2_REFUSED_STREAM"`、`err.code === "ERR_HTTP2_STREAM_ERROR"`(Node v24 实测)。这印证了合成字符串形态正确。但**Bun 侧未跑通**(探针 server crash 提前退出)。

**建议**:补一条 transport 级测试,用 `setHttp2SessionFactoryForTests`(`http2-client.ts:203`)注入一个 fake session,其 `request()` 返回的 req 在收到 headers 前 `emit("error", new Error("...REFUSED_STREAM..."))`,断言 `http2Fetch` reject 的 error message 匹配 + 走 `:397` 而非 body-stream 路径。这把"分类字符串"与"真实 wire 错误形态"用独立 oracle 对齐,消除 empirical-verification 关注的"自洽但没测到真实 wire"假绿。(注:这是 SHOULD,非 MUST——classify 单测 + Node 探针已给出较强证据链;但本项目对 transport 形态一贯用 factory-inject 测,补一条成本低、价值高。)

### MEDIUM-1:helper 命名 + 注释须显式编码"协议保证零处理"语义

方案 :29 已提议 `isRetryableHttp2StreamError`,方向对。**要求**:注释里写明 RFC 9113 §5.1.2 REFUSED_STREAM = 零处理保证,**并显式说明为何不匹配 CANCEL/INTERNAL_ERROR**(那些无零处理保证)。这样日后维护者读 helper 即知边界,不会误加其它 h2 码。呼应 self-consistent-needs-independent-oracle:注释引 RFC 作独立 oracle,而非"我们觉得可重试"。

### MEDIUM-2:DESIGN.md 收尾指向偏

方案 :54 说"回填 DESIGN.md 活的架构现状**流式截断/传输相关行**"。但 REFUSED 是 **pre-response 分类缺陷**,与流式截断检测(那行讲的是 `sawMessageStop`/mid-stream 语义残缺)是**不同关注点**。更准的落点:
- DESIGN.md 的 **classify 说明**(error/ 模块图行,`src/lib/error/` 的"反直觉契约"段),或
- "活的架构现状"表里 transport/重试相关行(`node:http2` 那格,或新增"h2 协议级错误重试"说明)。
- 若无合适现成行,加进 `docs/spec/upstream-http2-transport.md`(该 spec 讲 h2 transport,REFUSED 属其错误处理语义)。

memory 登记建议:REFUSED_STREAM 协议可安全重试 + 分类缺口来自 undici→http2 迁移(词汇表换了分类表没同步)——这条对未来加 h2 协议码分类有复用价值,归 memory 正确。

### LOW-1:network-retry 单次重试对 GOAWAY 风暴可能不足

`network-retry.ts:35` `hasRetried` 只允许一次重试。GOAWAY drain 若成簇(部署/再平衡瞬时多个连接被 drain),第二次重试仍可能撞上刚建的 session 又被 GOAWAY。当前 ~10/天、单次重试落到新 session 大概率成功,方案不为此加计数属合理 YAGNI。**但**若 HIGH-1 实测发现 GOAWAY 成簇高频,应重估是否给 h2-协议错误一个独立的 2-3 次重试(此时才值得独立 strategy,方案 :19 已预留此升级路径,判断正确)。记录待遥测。

---

## 结论

方案主干**正确、可实施**,核心断言经源码 + Node 探针验证成立。放行前建议:
- **必做**:HIGH-1(GOAWAY 探针实测 → 一并覆盖或实证文档化,不留同源漏洞);MEDIUM-1(helper 语义注释);MEDIUM-2(doc 落点纠偏)。
- **强烈建议**:HIGH-2(transport-级 factory-inject 测,对齐真实 wire 形态)。
- **记录待办**:LOW-1(遥测观察 GOAWAY 是否成簇)。

无 CRITICAL(曾疑的"REFUSED 被包成 HTTPError 够不到分类点"经 send.ts 核实为不成立)。
