# 对抗性审查报告:重试 NGHTTP2_REFUSED_STREAM 方案

## 裁决摘要

方案的**核心分类思路、strategy 复用、RFC 边界划分均正确**,并经实测/RFC 独立裁决确认。但存在若干**未文档化的运行时差异缺口**与**测试有效性缺口**,其中一个(Bun 运行时下修复静默失效 + 测试测不到真实 wire)达 HIGH。以下按严重度分级,均附 file:line 与实证。

---

## CRITICAL

无。方案不引入数据丢失、崩溃或协议违规。

---

## HIGH

### H1 — Bun 运行时下修复静默失效;E2E 测试无法裁决真实 transport 形态(bun-first 项目的核心盲区)

**实证(探针 /tmp/probe-h2-client.mjs、/tmp/probe-bun-preresponse.mjs,Node v24.16.0 + 本机 bun):**

同一个服务端干净 `stream.close(NGHTTP2_REFUSED_STREAM)`:

| 运行时 | client 侧观测 | error message |
|---|---|---|
| **Node** | `req.once("error")` 触发,`rstCode=7` | `"Stream closed with error code NGHTTP2_REFUSED_STREAM"` ✅ 方案子串命中 |
| **Bun** | **无 error 事件**,`req` 收到正常 `end`,`rstCode=0` | **不存在 REFUSED_STREAM 字样** ❌ |

这正是 `http2-client.ts:360-372` 注释已钉死的 Bun caveat:"a *clean* server RST_STREAM is delivered by Bun's node:http2 as a normal `end` with rstCode=0"。

**后果分两层:**

1. **修复的适用面被运行时切割,方案完全未提。** 生产日志出现 `NGHTTP2_REFUSED_STREAM` 字样 ⇒ 生产该错误路径跑的是 **Node**(Bun 根本不产生该字样)。但本项目是 **bun-first**(CLAUDE.md / DESIGN.md "Bun 是一等公民")。若部署迁到 Bun,GHC 的同一 pre-response 干净 RST 会被 `http2-client.ts:376` 的 close-before-end backstop 呈现为 `"[http2] upstream stream closed before end (rstCode=0)"` —— **既不含 REFUSED_STREAM、rstCode 是 0 不是 7**,方案子串永远匹配不到 → 修复静默失效,同样的每天 10 次 FAIL 在 Bun 下毫无改善。方案应显式声明"此修复只在 Node 运行时生效;Bun 下 GHC 干净 RST 呈现为 rstCode=0 的 close-before-end,不在本次 scope"(empirical-verification:否定性主张"已修好"需先证明检查在目标运行时触达)。

2. **方案的 E2E 测试(TDD 步骤 3)是 self-consistent 假绿。** 方案用 `new Error("...NGHTTP2_REFUSED_STREAM")` 合成错误喂 fetch-mock,断言 `messagesHits===2`。这**只测了 classify→strategy→重发的机械链路**,测不到:(a) 真实 transport 是否真会以这个 message 抛出(Node 会,Bun 不会);(b) Bun 下的真实形态(rstCode=0 close-before-end)是否被覆盖(答案:否)。这是 CLAUDE.md `self-consistent-needs-independent-oracle` 的典型 —— 合成 Error 是自己写的字符串,与真实 wire 形态之间没有独立 oracle。方案自己也承认"真 h2 服务器发 REFUSED 在 Bun 下测不了",但**由此得出的结论方向错了**:测不了不代表可以只测合成 Error 就宣称覆盖了生产行为,而应显式标注"E2E 只覆盖 Node message 形态的分类链路,不覆盖 Bun transport 形态"。实际上一个 h2c 测试服务器(`setHttp2SessionFactoryForTests` 已支持注入,http2-client.ts:203)在 Node 下就能发真 REFUSED,比合成 Error 更有 oracle 价值 —— 方案未评估这个更强的测试手段。

**建议:** 不阻断落地(Node 路径确实被修复),但必须(a)在方案与代码注释显式声明运行时适用面 + Bun 缺口;(b)E2E 补一条经 `setHttp2SessionFactoryForTests` 注入 h2c server 发真 REFUSED 的 Node 集成测试(独立 oracle),而非仅合成 Error 单测。

---

## MEDIUM

### M1 — `error.code` 匹配比 message 子串更稳的主张需修正:REFUSED 的具体码只在 message,不在 code

方案第 6 问隐含"按 error.code 匹配是否更稳"。**实测否定:** Node 下该错误 `error.code === "ERR_HTTP2_STREAM_ERROR"`(通用码,不区分 REFUSED/CANCEL/INTERNAL),`error.errno === undefined`,`error.cause` 不存在。**具体码 `NGHTTP2_REFUSED_STREAM` 只出现在 `error.message` 里**(实证 /tmp/probe-h2-client.mjs)。因此:

- 按 `error.code` 匹配**无法区分** REFUSED 与 CANCEL —— 会破坏方案"只 scope REFUSED、不碰 CANCEL"的核心安全边界。
- **message 子串匹配在这里反而是正确选择**(唯一能区分具体码的信号),方案现有做法正确,但方案文档应把"code 更稳"这个开放问题明确否掉,并注明理由(具体码只在 message)。
- 更精确的替代是读 `req.rstCode === 7`,但那需要在 `http2-client.ts` 的 error 分支把 rstCode 编码进抛出的 error(当前 `req.once("error")` line 397 原样透传 node 的 error,rstCode 未附加)—— 属更大改动,非本次必须。方案继续用 message 子串合理,但应在 helper 注释记录"rstCode 才是权威、message 是当前唯一可得的携带处"。

### M2 — network-retry 单次闩锁被 REFUSED 与真 ECONNRESET 共享,方案未文档化(非回归,但语义延伸)

`network-retry.ts:35` 的 `hasRetried` 是 per-request 单次闩锁,`canHandle` 要求 `!hasRetried`(line 41)。REFUSED 归入 `network_error` 桶后,**一次请求内 REFUSED 与真 socket 错误共用同一个重试预算**。场景:请求先撞 REFUSED(消耗闩锁)→ 重发 → 再撞真 ECONNRESET → 闩锁已置位 → 不重试 → FAIL。

**判定:非回归**(方案实施前 REFUSED 直接 FAIL,连一次机会都没有;实施后至少多一次 REFUSED 重试机会,严格改善)。但这是 network 桶语义的延伸,方案完全未提。GOAWAY drain 风暴(plan line 9 自述的触发场景)恰恰可能在短时间连发多个 REFUSED —— 单次闩锁下第二个 REFUSED 就 FAIL。方案 line 19 说"GOAWAY 风暴容 2 次"是专用 strategy 才有的价值、当前 YAGNI,这个判断本身合理,但应在方案明确记录"复用 network-retry 意味着单请求内 REFUSED 只重试一次;若遥测显示 drain 风暴导致二次 REFUSED FAIL,再升级专用 strategy 提高次数"。

### M3 — L2 buffered-retry 内部 runExchange 复用同一 network-retry 闩锁实例(交互未评估)

`driver.ts:530` L2 buffered sink build 一次 `strategies`,line 623 每次 mid-stream cut 重试都调 `runExchange(deps, currentEnv, strategies)` **复用同批 strategy 实例**。network-retry 的 `hasRetried` 闭包状态**跨 L2 多次内部重试持续**。

**分析:** pre-response REFUSED 由 runExchange 内部的 network-retry 处理(先于 buffered sink 拿到 upstream stream,实证:`sendUpstreamHttp` 在收到 response headers 前 reject → runExchange catch,send.ts:140 原样 throw),与 L2 的 mid-stream 重试是两个不同阶段,不直接冲突。但若 L2 第一次 mid-stream cut 后内部 runExchange 重发时**又撞 pre-response REFUSED**,而 network-retry 闩锁已在更早的某次 runExchange 里置位,则该 REFUSED 不被认领 → runExchange throw → L2 收到 stream-error。**这是既有 network-retry 单次语义在 L2 场景下的自然结果,非本方案新增缺陷**,但方案未评估 L2 交互(方案只说"REFUSED 是 pre-response、与 L2 无冲突",这个结论对但论证不完整)。属可接受,建议记录。

---

## LOW

### L1 — REFUSED 复用同会话重试是否正确:方案第 3 问的判断成立,补实证

方案第 3 问自答"REFUSED 是纯 per-stream 拒绝、会话仍健康时复用同会话重试反而正确"。**RFC 9113 §8.7 + http2-client.ts 会话池语义共同确认此判断成立:**

- REFUSED_STREAM 是 per-stream RST,不拆会话。但 http2-client.ts:154-156 `getSession` 只在 `live.closed || live.destroyed` 时才建新会话;GHC drain 场景下 GOAWAY 会触发 `session.on("goaway", drop)`(line 181)把会话移出池,故**下次 getSession 会拿新会话**。若 REFUSED 未伴随 GOAWAY(纯并发超限),复用同健康会话重试正是 RFC §5.1.2 期望的行为。
- **不存在"REFUSED 未拆会话 → 重试复用 draining session → 再次 REFUSED"的死循环**:即便复用同会话,network-retry 单次闩锁(M2)保证最多重试一次,不会无限撞。方案 line 17"会话池已在 goaway/error/close 自动 drop"的主张经 http2-client.ts:179-181 核实为真。

### L2 — RFC 独立裁决确认 POST 重试安全 + CANCEL 边界正确(方案第 5 问全部成立)

**RFC 9113 §8.7 逐字裁决(curl /tmp/rfc9113.txt):**

> "The REFUSED_STREAM error code ... indicate[s] that the stream is being closed prior to any processing having occurred. **Any request that was sent on the reset stream can be safely retried.**"
> "Requests that have not been processed have not failed; clients MAY automatically retry them, **even those with non-idempotent methods.**"

方案对非幂等 POST 重试安全的核心主张**协议保证正确**。"只 scope REFUSED、不碰 CANCEL"的边界正确 —— CANCEL 无"零处理"保证。

**GOAWAY 暂缓是合理 YAGNI 而非漏洞:** RFC §8.7 确认"GOAWAY ... Requests on streams with higher numbers are ... guaranteed to be safe to retry",理论上同样可重试。但实证(/tmp/probe-goaway.mjs)显示 GOAWAY 场景在 Node/Bun 都**不呈现为 REFUSED_STREAM message 形态**(是 session 级 `ERR_HTTP2_GOAWAY_SESSION` 或被当已处理),与本方案的 per-stream 分类正交;且生产日志确为 per-stream `NGHTTP2_REFUSED_STREAM` 字样,说明 GHC 用 per-stream REFUSED drain 在飞流(方案已覆盖),纯 session-GOAWAY 未观测到。暂缓 + 文档化(plan line 25)的处理得当。

### L3 — message 子串判定不受 formatErrorWithCause 干扰(确认无误报/漏报副作用)

方案第 6 问担心 message 变形。实证:`classify.ts:284` 的 `isNetworkError` 用 **原始 `error.message.toLowerCase()`** 判定,`formatErrorWithCause`(utils.ts:59,含 `stripBunVerboseHint`)只在 line 76 **存储 message 时**应用,不参与判定。故子串匹配作用于未变形的原始 message,安全。cause 递归遍历(line 287)也已覆盖 —— 与 `isNetworkError` 一致,方案 line 31 复用 cause 遍历的设计正确(尽管实测 Node 下 REFUSED 无 cause,防御性保留合理)。

### L4 — isAbortError 不会误判 REFUSED(确认无冲突)

方案第 1 问担心 abort 误判。实证(/tmp/probe-refused.mjs):`"Stream closed with error code NGHTTP2_REFUSED_STREAM"` 经 `isAbortError`(classify.ts:272,先于 network 判定)返回 false —— message 不含 "aborted"/" abort "/前后缀 abort,`name` 非 AbortError/TimeoutError。分类顺序 abort→network→bad_request 下,REFUSED 干净落到 network_error。**唯一需警惕**:若未来 GHC 某 message 同时含 "abort" 与 REFUSED,会被 abort 抢先(概率极低,但 helper 若放在 isAbortError 之后则天然规避 —— 方案 line 29 说"之前或之内"添加,建议明确放在 network 判定处、abort 之后,与现有优先级一致)。

---

## 方案正确性确认清单(经实证/RFC,非推断)

- ✅ 根因诊断正确:REFUSED 现落 `bad_request`(/tmp/probe-refused.mjs 复现)。
- ✅ network-retry 存在于全 4 格式链(anthropic:88 / openai-cc:54 覆盖 gemini / responses:46)。
- ✅ pre-response REFUSED 经 sendUpstreamHttp:140 原样 throw → runExchange:287 catch → classify,干净重发无半截帧(driver 重试环在 response headers 之前)。
- ✅ rewriteShutdownAbort(Anthropic transport)不会把 REFUSED 误改 529:send.ts:132 要求 isAbortError,REFUSED 不满足。
- ✅ server-error-retry 只认领 5xx HTTP,与 network(status 0)无重叠。
- ✅ RFC §8.7 确认 POST 重试协议安全 + CANCEL 边界正确。
- ✅ 分类单一源同时修 v4 driver 与 legacy web_search(plan line 33 主张成立)。

## 必须补的(不阻断落地,但收尾前处理)

1. **[HIGH H1]** 方案 + helper 注释显式声明"仅 Node 运行时生效;Bun 干净 RST 呈 rstCode=0 close-before-end,不在 scope",并把 E2E 从纯合成 Error 升级为 `setHttp2SessionFactoryForTests` 注入 h2c server 发真 REFUSED 的 Node 集成测试(独立 oracle)。
2. **[MEDIUM M1]** 方案文档否掉"error.code 更稳":具体码只在 message,code 是通用 ERR_HTTP2_STREAM_ERROR,message 子串是当前唯一能区分 REFUSED/CANCEL 的信号;helper 注释记录"rstCode=7 才是权威、当前只在 message 可得"。
3. **[MEDIUM M2/M3]** 方案记录"复用 network-retry ⇒ 单请求内 REFUSED 只重试一次(与真 socket 错误共享闩锁);L2 内部 runExchange 复用同闩锁实例";遥测显示 drain 风暴二次 REFUSED FAIL 时再升级专用 strategy。
