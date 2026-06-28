# L2 实现交接文档 — 流式响应事务化缓冲重试

> **用途**：新会话零上下文接续 L2（保护大 Write/Edit 生成不被上游 GHC mid-stream RST 砍断）的 Phase 2-4 实现。本文自包含。
> **设计权威**：`docs/rfc/streaming-upstream-rst-buffered-retry.md`（读它，本文只做实现态索引 + Phase 2 kick-off）。
> **写于**：2026-06-22，HEAD=`ead13cb`，master。

---

## 1. 这是什么 / 在整条线的哪

opus-4.8 在超大上下文（150K-200K token）上生成大 Write/Edit 工具调用时，上游 GitHub Copilot 在**活跃流中途**发 `RST_STREAM(NGHTTP2_CANCEL)` 砍断（已观测 4 次，60/87/140/148s 各不同 → 非固定墙、非 idle、非 keepalive、非 loop，是 GHC 对大生成的请求级中止）。两个官方客户端（GHC 扩展、Claude Code/Anthropic SDK）都**不保护** mid-stream RST（已读源码核实）。代理靠 `abort-bridge` 能确定性区分"客户端取消 vs 上游 RST"，处于**独有的保护位置**。

**L2 方案 = 事务化缓冲重试（方案 A）**：缓冲整响应、`message_stop` 后才 commit flush 给客户端；transport-close RST（或 truncation=clean drain 无 message_stop）丢弃 buffer、回 S4 重取新流重来，上限 `retryCap`；**all-or-nothing**（绝不转发半截生成）。

> 关联：用户在并行写一份 pre-response 静默保活 RFC（`0e4f6f7`/`b903622` 等，opus 长思考期 pre-response abort 处理）——与 L2 **正交**（那篇治"首字节前静默"，L2 治"已流式后被 RST"）。别混。

---

## 2. 设计决策（已定案，RFC §14-16）

- **D1**：每尝试各留上游原貌——`Attempt.sseEvents` 字段；`onUpstreamFrame` 经 `runResponse` 把帧 setSseEvents 到顶层，buffered driver 每尝试 `commitAttemptSseEvents()` 快照到该 attempt；顶层 `_sseEvents` 仍镜像成功那次作 `inboundResponse`。失败尝试的帧保留以诊断"为何 RST"。
- **D2**：`retryCap` **可配置、默认 3**（loop/成本闸，**非超时闸**——已实证 Claude Code 258s 是 idle 超时，heartbeat 无限保活缓冲期；`0`=不重试退回现状）。
- **D3**：escalation（重试时收紧 context_management）默认**关**；L2 总开关 `protect_streaming_generation` 也默认**关**。
- **转发粒度**：**A（缓冲整条）实现**；B（完整块 live + continuation 续写）列**未来探索**，gating = 先实证 GHC 是否接受 thinking-prefill 续写（不可行则 B 永久搁置）。
- **CRITICAL 不变量**：commit 条件 = `drained && sawMessageStop()`，**不是**"循环结束"——Bun 把 clean 服务器 RST 当正常 `end`（rstCode=0，不可检测，`transport/http2-client.ts:169-175`），故 clean drain 无 message_stop = truncation = 可重试。

---

## 3. 已落地（Phase 0 + 1，全绿）

| Commit | 内容 |
|---|---|
| `1fe879b` | **Phase 0**：`tests/anthropic/streaming-l2-baseline.http.test.ts` —— live-streaming 字节回归基线（complete + mid-stream transport-close 现状）。**L2 落地后默认 live 路径不变的回归门**，每 phase 重跑必绿。 |
| `5538722` | **Phase 1**：driver `runResponseBufferedSink`（缓冲/sawMessageStop 门控/re-exchange/per-attempt 重置）+ D1 ctx（`Attempt.sseEvents` + `commitAttemptSseEvents`/`resetSseEvents`）+ `RunBufferedOpts`。**默认不接线（死代码）**。`tests/pipeline/buffered-sink.unit.test.ts`。 |
| `ead13cb` | **Phase 1 焦点审修复 [HIGH]**：commit-flush 的 `sink.write` reject 须映射成 `ResponseOutcome`（不裸抛破坏契约）。 |
| `caa0af7` | **Phase 2 前置**：`isolated-fixture` beforeAll 加 `resetTestRuntime()` 完整重连——修"首测试继承前文件陈旧 bus/manager/closed-DB"的 fixture 潜在 bug。 |
| `6c8095a` | **Phase 2 接线**：配置三键（`protect_streaming_generation`/`_max_retries`/`_heartbeat`）+ `pumpAnthropicStreamingV4` 按开关选 buffered vs live + 🔴 强制 heartbeat（同 commit）+ 🔴 acc/checkRepetition/local sseEvents/streamState 四项全量重置（forwardedSseEvents 故意不重置，§10）。`streaming-l2-buffered.http.test.ts`（RST 透明重试/acc 不叠加/耗尽 fail/FakeClock heartbeat 保活）。 |
| `cedaa42` | **Phase 2 D1**：per-attempt 上游 sseEvents 持久化（toHistoryEntry + sink + serialize 非 final 尝试落行 + deserialize 分流 + head 剥离）+ UI AttemptsTimeline 帧数 + serialize round-trip 测。 |
| `c239e1f` | **Phase 2 焦点审修复**：[HIGH] H2 上游 error 帧经 `sawUpstreamError` 与 RST-truncation 区分（commit 而非重试、保留原始 error 语义）；[MEDIUM] `commitAttemptSseEvents` 移进重试分支（仅失败尝试快照，final 帧只留顶层、内存==DB）。 |

**关键文件（已改）**：
- `src/lib/pipeline/driver.ts` —— `runResponseBufferedSink`（在 `runResponseSink` 之后）。**已完整实现**，Phase 2 只需 handler 调它。
- `src/lib/pipeline/types.ts` —— `RunBufferedOpts`（`sawMessageStop`/`onAttemptReset`/`retryCap`）。
- `src/lib/context/types.ts` —— `Attempt.sseEvents?` + RequestContext 接口加 `commitAttemptSseEvents`/`resetSseEvents`。
- `src/lib/context/request.ts` —— 这两个方法（在 `setAttemptError` 之后）。

**验证态**：buffered-sink 5 测全绿；Phase 0 基线绿；typecheck 干净；全后端 `bun run test:backend` 2957 pass（仅 1 个无关 flaky 超时 `request-payload`，单跑过）。

**焦点审核实为正确**：sawMessageStop 门控、per-attempt sseEvents 时序（探针实测空帧尝试不误拷）、re-exchange env 线程（`currentEnv=re.env`、ctx 引用不变）、重试分类（仅 transport-close + truncation 重试）、all-or-nothing、driver S5 每尝试自动重建 state。

---

## 4. Phase 2-4 剩余（详 Phase 2）

### Phase 2 —— handler 接线 + heartbeat 强制 + 配置门控（最吃上下文）

> **[已落地 2026-06-22]** commits `caa0af7`/`6c8095a`/`cedaa42`/`c239e1f`（见 §3 表）。全后端 2994 pass、两轮焦点审通过。**下一步是 Phase 3**（buffer cap + escalation）。以下为当时 kick-off 原文，留作 Phase 3/4 接续参考。
1. **配置**：加 `anthropic.protect_streaming_generation`（`false`|`"on"`|`"tool_use_only"`，默认 `false`）+ `protect_streaming_max_retries`（默认 3）+ `protect_streaming_heartbeat`（默认 15）到 `state.ts` + config.yaml（参照既有 `anthropic.*` 字段，含 hot-reload 矩阵 `tests/config/config-hot-reload.it.test.ts`）。
2. **handler 选路**：`pumpAnthropicStreamingV4`（`src/routes/messages/handler-v4.ts`）按 `protect_streaming_generation` 选 `runResponseBufferedSink`（buffered）vs `runResponseSink`（live）。默认 false → 走 live → **Phase 0 基线必须仍逐字节绿**。
3. **🔴 红线（RFC §14，必须同 commit）**：buffered 路径**强制构造 heartbeat**（即使用户 `stream_fake_sse_heartbeat=0`，用 `protect_streaming_heartbeat` 兜底）——否则缓冲期客户端裸奔无 ping 早断，比现状更糟（违反 transitional-states-need-explicit-no-harm）。当前 `handler-v4.ts:~568` 是 `state.anthropicFakeSseHeartbeat>0 &&` 才挂 heartbeat。
4. **🔴 acc `const`→`let`（焦点审 [MEDIUM]）**：`handler-v4.ts:~528` 的 `acc` 现为 `const`；buffered 重试要在 `onAttemptReset` 里**全量重置 5 项**：`acc`(=`createAnthropicStreamAccumulator()`)、`sseEvents`(local)、`forwardedSseEvents`、`streamState`(bytesIn/eventsIn)、`checkRepetition`。漏任一项 → 跨尝试叠加（usage/token 翻倍）。`onUpstreamFrame` 闭包须读**可变引用**。
5. **sawMessageStop**：传 `() => acc.sawMessageStop`（onAttemptReset 重置 acc 后它自然 false）。
6. **per-attempt sseEvents 持久化（D1 read 侧）**：路径激活后，把 `Attempt.sseEvents` 接进 `toHistoryEntry` 的 attempts map（`request.ts:557`）+ history sink `toHistoryAttempts` + serialize（落 `entry_stages` 的 attempt_index 分行）+ history UI 读侧。Phase 1 已备 runtime 字段，这步是把它持久化/展示。
7. **测试**：① 开 L2 + 前 N 次 RST→客户端透明拿完整 + acc 不跨尝试叠加（http 测试，仿 `streaming-l2-baseline` 范式 + `createSseResponseThenError`）；② heartbeat 缓冲期保活（仿 `fake-sse-heartbeat.unit.test`）；③ acc 全量重置回归。**验收**：Phase 0 基线 + 全后端绿；2nd 焦点审。

### Phase 3 —— buffer cap（`protect_streaming_buffer_cap_bytes` 默认 16MB，超限退回 live）+ escalation（可选，默认关）。 **[已落地 2026-06-22]** buffer cap `98d7f7c`、escalation `bebf595`（+ `7cdc92d` 补 beta header / 修遥测漏计）。
### Phase 4 —— 重试命中率遥测（`history.protect_streaming_retry{outcome}`）+ DESIGN.md/history.md/config 文档同步 + memory 回填。 **[已落地 2026-06-22]** 遥测 `65d1896`（`protect-streaming-stats` + `/api/status` + ctx feature tag）、heartbeat=0 跨字段告警 `cab8364`、文档同步本次。**L2 全 Phase（0-4）完成。**

---

## 5. 项目纪律 / 踩坑（务必遵守）

- **commit 纪律**：一阶段一 commit，conventional commits，**不加 Claude 署名**；`git add -- <精确路径>`，**绝不** `git add -A`；提交前 `git diff --cached --stat` 复核；散文一段一行（prose-line-per-paragraph）。
- **验证命令走 `bun run`**（非 npm）：`bun run test:backend` / `typecheck` / `bunx eslint --fix`（不直接 prettier）。改 `.ts` 才验证，改 `.md` 不必。
- **测试隔离**：bun 单进程跨文件泄漏全局单例。**别 `mock.module`**；mutate 全局 state 加 `autoRestoreState()`；fs I/O 用注入临时目录、**绝不写真实 `$HOME`/`~/.claude`**。**已知**：某些 context 测试把全局 `staleRequestMaxAge` 设 0.05s 不还原，会污染 baseline（targeted-combined 跑会假失败）——**以 `bun run test:backend` 全套件为真实门**，别用 targeted-combined 判回归。
- **已知 flaky/无关失败**（别追）：FileSink 2 测（时间/日期相关，FileSink 子系统零改动）、`request-payload` 超时（全套件高负载，单跑过）。
- **subagent 审查**：派 subagent 必写显式裁判轴（长远正确+完整，非 ROI/YAGNI）+ 给全量工具；对其结论**亲自读它引用的 file:line 复核**（reviewer 也是声音权威）。本特性是大改，每 phase 落地后焦点审。
- **golden 方法论**：流/输出字节保持，golden 先锁在改动前代码（Phase 0 已做）。
- **持久化背景**（同会话前半已修，相关）：失败 entry 现可靠落盘（`clearHistory`/`deleteSession` 会高声日志、finalize 无损 + tombstone）——L2 的"重试命中率"可事后从 history 验证。

---

## 6. 新会话 kick-off 提示词（直接用）

> 接续 L2（流式响应事务化缓冲重试，保护大 Write/Edit 不被上游 GHC mid-stream NGHTTP2_CANCEL 砍断）的 **Phase 2 实现**。先读交接文档 `docs/rfc/streaming-upstream-rst-buffered-retry.HANDOFF.md`（自包含）+ 设计权威 `docs/rfc/streaming-upstream-rst-buffered-retry.md`（尤其 §4 集成、§5 heartbeat、§9 配置、§11 Phase 2、§14 红线、§15-16 决策）。
>
> 现状：Phase 0（live 字节回归基线 `tests/anthropic/streaming-l2-baseline.http.test.ts`）+ Phase 1（driver `runResponseBufferedSink` + D1 ctx per-attempt sseEvents，**默认不接线/死代码**，含焦点审 + HIGH 修复）已落地全绿（commit `1fe879b`/`5538722`/`ead13cb`）。
>
> 做 Phase 2：① 加配置 `anthropic.protect_streaming_generation`(false|on|tool_use_only,默认 false)/`protect_streaming_max_retries`(默认3)/`protect_streaming_heartbeat`(默认15)到 state.ts+config.yaml+hot-reload 矩阵；② `pumpAnthropicStreamingV4`(handler-v4.ts) 按开关选 `runResponseBufferedSink` vs `runResponseSink`，默认 false 走 live（Phase 0 基线必须仍逐字节绿）；③ 🔴 buffered 路径**强制 heartbeat**（与选路同 commit，用 protect_streaming_heartbeat 兜底，否则缓冲期裸奔早断）；④ 🔴 acc 从 const 改 let，`onAttemptReset` **全量重置** acc/sseEvents(local)/forwardedSseEvents/streamState/checkRepetition 5 项（漏一项跨尝试叠加），onUpstreamFrame 闭包读可变引用；⑤ sawMessageStop 传 `()=>acc.sawMessageStop`；⑥ per-attempt sseEvents 接进 toHistoryEntry attempts map + history 持久化（D1 read 侧）。
>
> 测试：开 L2+前 N 次 RST→客户端透明拿完整+acc 不叠加（http，仿 baseline + createSseResponseThenError）、heartbeat 缓冲期保活、acc 全量重置回归。验收：Phase 0 基线 + `bun run test:backend` 全绿（别用 targeted-combined 判回归，有 staleRequestMaxAge 污染；FileSink/request-payload flaky 别追）+ typecheck + `bunx eslint --fix`。落地后派焦点 subagent 审（显式裁判轴：长远正确+完整；重点核 heartbeat 强制时序 + acc 全量重置 + 选路默认 live 字节不变），亲自复核其引用的 file:line。完成一阶段就主动提交（conventional commits，无 Claude 署名，精确 `git add -- <路径>`）。
>
> 遵守 CLAUDE.md：中文回答、bun-first、architecture-health-first、empirical-verification、big-feature-pipeline、completion-includes-doc-sync。
