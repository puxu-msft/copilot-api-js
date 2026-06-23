# Stream-Finalize 重设计 —— 评估后驳回（supersedes Stage B B4 "S6 flush 镜像 S5 flushChain"）

> **状态**：EVALUATED — **REJECTED**（2026-06-23）。本稿曾提议把各格式流末终态处理收进 driver；经 3 轮对抗 subagent review + 主线亲核 file:line，结论是**过度设计 + 结构上不适配 WS**。最终落地的是 **γ：保留流末 handler-side + 抽出唯一干净的微 DRY（`openAIStreamErrorFrame`）+ 修正陈旧 B4 注释**。本文档保留完整评估记录，**防止 B4/finalize 被重新尝试**。
> **同时正式驳回**：design.md §3.3 line 113 的「codec 流末 `flushResponse` 由 driver 在 `finally` drain，S6 flush 镜像 S5 flushChain 的阶段对称」框架——该框架写在 truncation-detection 落地**之前**，假设 flush 是无条件"drain 剩余帧"；truncation-detection 落地后该假设不再成立（见 §3）。

## 0. 决策链（怎么走到"驳回"的）

1. **B4 kick-off**（`prompts/stage-b-b4-s6-flush.md`）提议把 `codec.flushResponse` 搬进 driver `runResponseSink` 作"S6 flush 镜像 S5 flushChain"。
2. **B4-as-scoped 评估**（2 对抗 subagent）：B4 只能干净接管 clean 路径的 flush；截断路径的选择性 flush + 合成 error 帧 + fail 留 handler；对 Gemini 把 flush 劈成 driver/handler 两处、**降内聚**。→ B4-as-scoped 非理想。
3. **用户问"这样的收口是长远最佳理想吗"** → 选了"做完整 finalizeStream 理想重设计"（让 codec/handler 把流末作为数据产出、driver 统一消费）。
4. **本稿（finalize / α）写出 + 3 轮对抗 review（契约 / 字节安全 / 完整性）+ 主线亲核** → 证伪（§2）。
5. **用户重定方向** → 选 **γ**（保留 handler-side + 抽截断 helper + 修注释/文档）。

## 1. 现状全景（五格式流末，权威落地态，re-read 锚点）

| 格式 | 语义终止-ok 信号 | clean terminal 写出 | 截断信号 | 截断-vs-flush 时序 | H2（上游 error 帧） | flush |
|---|---|---|---|---|---|---|
| Anthropic | `acc.sawMessageStop` | 无 trailing | `!sawMessageStop` | 无 flush | `acc.streamError`→fail，无合成 | 无 |
| CC | `acc.finishReason!==""` | 合成单 `[DONE]` | `===""` | 无 flush | 折进 stream-error | 无（[DONE] 是传输终止符） |
| Responses-HTTP | `acc.status!==""` | fallback `codec.flushResponse` closing 序列 | `===""`（**flush 之后**判） | **flush-then-detect** | — | fallback only |
| Responses-WS | `acc.status!==""` | 同 HTTP | 同 HTTP | 同 HTTP | — | fallback only |
| Gemini | `getStreamMeta().finishReason!==UNSPEC` | `codec.flushResponse` 终态帧 | `===UNSPEC` | **detect-then-selective-flush**（截断时 flush 但 drop 终态帧、只转发半截 tool-call） | — | always（translator 末尾） |

**ctx 终态设置（`ctx.complete/fail/abort`）天然 handler-side**：读自家 acc + 格式特定 responseData builder（`buildAnthropicResponseData`/`buildOpenAIResponseData`/`buildResponsesResponseData`/`geminiUsageFromMeta`）+ RequestContext 生命周期。

## 2. 为何驳回 finalize（α）——3 个被证伪的核心前提（主线已亲核 file:line）

### ① "byte-critical 不变量五处手写" 实质是假的——它们早已统一在 sink

finalize 的核心卖点是"流末写出序列的 byte-critical 不变量（序列化、close、采样非对称）五处手写、收进 driver 一处"。但亲核 `src/lib/pipeline/client-sink.ts`：
- **单 Promise chain 序列化**（`makeSerializer`，:80-89）——所有 `write`/`writeSynthetic` 共用，帧绝不交错。
- **采样非对称**（:135-158）——`write` 采样 forwarded、`writeSynthetic` 不采样（H2-sampled / H3-unsampled 锁）。
- **close 停心跳**（:162-166）——`runResponseSink` 的 `finally` 已调。

这些 byte-critical 机器**早在 Stage B 就统一进了 driver+sink**，handler 流末剩的只是 ~3 行写出 + 格式特定的 detect/flush/settle。finalize 的"收口"卖点落空。

### ② 五态 outcome 不挣钱——分类被算两遍

finalize 把 outcome 扩成 `complete/truncated/upstream-error/stream-error/settled-abort`。但 handler 在每个非错误分支**都还得读自家 acc** 建 responseData/partial——而分类本身就是从 acc 推的（`acc.sawMessageStop` / `acc.finishReason` / `acc.status` / `getStreamMeta`）。outcome 的 `kind` 携带**零** handler 不会重算的信息（分类算两遍：finalize 闭包一遍、handler 建数据时隐式一遍）。这违反 design.md §3.2:83 已裁定的"outcome 只载格式无关控制信号、最小三态、`complete` 已吸收 H2"。`upstream-error` 更是**只 Anthropic 一格式**有 H2 的投机 surface（现状 `complete`+`acc.streamError` 已正确处理它，driver 零参与）。

### ③ WS 结构上装不进统一契约（最硬，决定性）

亲核 `client-sink.ts` 的 `makeWsSink`（:208-221）：只返回 `{ write }`——**没有 `writeSynthetic`、没有 `close`**。WS 的 error/截断走 `sendErrorAndClose(ws, message, type)`+1011（**传输级关连接**，`ws.ts:125`/:342/:371），`StreamFinalization` 的 `{errorFrame}`+`writeSynthetic` 契约**根本表达不了**——按 finalize 实现会 `sink.writeSynthetic?.()` 静默 no-op（错误帧不发、连接不关，客户端挂悬空 WS）。要"修"就得给 ClientSink 长出 WS-close 语义 → 朝过度设计更远。

**附**：`codec.formatError` 是死代码（全仓零生产调用）且有损（罐头消息，丢上游 raw message + 无 truncated 种类）——OQ1"把 H3 收进 driver 经 formatError"会逐字节回归。

### 总判

finalize 给一个 ~3 行的真实小重复套上五态 outcome + 新 opt + 新 type + driver 纯穿透闭包，还装不进 WS。**真正干净的边界其实就是现状**：driver 拥有帧级传输（已统一在 sink），handler 拥有流末语义终态 + ctx 设置（天然 handler-side、不与 driver 写出交织）。这是 `best-complete-solution`/YAGNI "不为对称而对称（投机泛化）" 的正面案例。

## 3. 为何"S6 flush 镜像 S5 flushChain"是假对称

- S5 `flushChain`（`driver.ts:413-436`）drain 的是 **rewrite-registry buffer**——格式无关、**所有退出路径都跑**（finally）。
- `codec.flushResponse` drain 的是 **codec 翻译器的收尾生命周期**——格式特定、**只在 clean 完成跑**、且与**格式特定的截断分支**耦合（Gemini detect-then-selective-flush / Responses flush-then-detect，两种相反时序）。

二者 drain 不同 buffer、退出语义不同——"镜像"只剩名字。design.md §3.3 line 113 的框架据此驳回。

## 4. 实际落地（γ）

1. **抽出唯一干净的微 DRY**：`openAIStreamErrorFrame(error): SseFrame`（`src/lib/openai/stream-error.ts`）——CC + Responses(HTTP) 的 H3 **与**截断路径都构造同一个 `{event:"error", data:{error:{message,type}}}` 帧（4 处），收敛成单一来源防漂移。WS 不用（其终态是 `sendErrorAndClose`+1011，不是写帧），但共享同一 `streamErrorToOpenAIErrorType` 分类。golden（cc-stream-truncation / responses-stream-truncation）逐字节等价。
2. **截断检测本身不抽 helper**：五处截断分支共享一个 SHAPE 但**几乎无字面内容相同**（acc 字段、builder、错误帧、甚至 Error 措辞都各异——Anthropic 用 "upstream stream truncated: closed without message_stop"，其余用 "Upstream stream truncated before completion (no X)"）。统一 helper 会成 callback-soup（净负），且 "forgot the check" 脆弱性已被**既有 per-format 截断测试**（`cc-stream-truncation.http`/`responses-stream-truncation.http`/`responses-ws.http` 等）守住。
3. **修正陈旧注释**：`responses/handler-v4.ts`（模块 doc + inline）、`responses/ws.ts` 的 "Deferred: B4 moves this into the driver's S6 flush" → "评估后保留 handler-side，见本文档"。
4. **DESIGN.md「流式写出」行**："暂缓：B4 移进 driver S6 flush" → "评估后保留 handler-side（finalize 过度设计 + WS 不适配）"。

## 5. 若将来重新考虑（给未来决策者）

唯一可能让"driver 拥有流末"重新成立的前提变化：**ClientSink 抽象统一了 WS 的 close-with-error 语义**（让 WS 也能 `writeSynthetic` + `close(1011)`）。即便如此，§2 的 ①②（byte 机器已在 sink、outcome 分类重复）仍成立——收益依旧小。建议：**除非有新的真实驱动（不是对称美学），不重启 finalize**。截断检测的五处重复若真要收敛，正确形态是**测试层守卫**（meta-test 断言每个流式格式 complete 分支有截断覆盖），而非 runtime callback helper。
