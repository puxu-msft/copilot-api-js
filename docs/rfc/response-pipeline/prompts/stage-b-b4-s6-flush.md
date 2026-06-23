# Stage B — B4：流末 drain 收口进 driver S6 flush（收尾架构对称，非功能修复）

> **粘贴进新会话直接执行。** 这是 response-pipeline RFC **Stage B** 的最后一项收尾。Stage B 主体（全 5 格式 owns-sink）+ 统一 abort/H3 覆盖已全部落地（见下「已就绪」）；本步把各格式**仍在 handler-side 的流末 drain** 收口进 driver 的 `runResponseSink`，作「S6 flush 镜像 S5 flushChain」的阶段对称收尾。**这是纯架构收口、无功能缺陷**——当前 handler-side drain 是正确的、字节等价的；B4 只为让"流末交付"和"逐帧改写 flush"一样归 driver 所有，使 handler 进一步薄化。若评估后认为收益不抵 byte-critical 回归面，**可正当地不做**（带文档结论即可，见 §6）。
>
> 设计稿 [design.md](../design.md) §3.2/§3.3；master plan [stage-b-plan.md](../stage-b-plan.md) Task B4。

## 0. 通用红线（每会话必守，见项目 CLAUDE.md + prompts 上级 [README](./README.md)）

中文对话；**绝不** `git checkout/restore <file>`/`reset --hard`/`clean -f`/`rm` 工作区文件（不可逆，no-destructive-workspace-loss）；`git add`/本地 commit 允许、`push`/`gh pr` 需明确同意；**细粒度暂存** `git add -- <精确路径>`、绝不 `-A`/`-am`、提交前 `git diff --cached --stat` 复核；不自动启服务器、不 `kill` 本项目进程；**改写/复审永远派 ≥2 全量工具 subagent（claude/general-purpose）多视角对抗 + 主线亲核每个 file:line**；测试用 DI/fetch-mock 不用 `mock.module`、绝不碰真实 `$HOME`；不使用分号、三元行首、`printWidth` 160；只改 `.ts/.json/.yaml` 才跑 `bun run typecheck`/`bun run test:backend`/`bunx eslint --fix`（**不是 `npm`/`prettier --write`**）。

> **⚠️ 并发编辑警告**：本仓库历史上有另一进程高频并发提交（曾把未提交 hunk 扫进它的 commit、改 handler/driver）。开工先 `git log --oneline -10` + `git status` 看现状；提交用 `git commit --only -F <msgfile> -- <精确路径>`（`--only` 忽略其它已暂存路径，race-immune）；**下方所有 file:line 锚点必 re-read**（handler 已因 truncation-detection 等并发工作漂移）。

## 1. 已就绪（Stage B 已提交，本步直接复用，**勿重做**）

| 资产 | 在哪 | 契约 |
|---|---|---|
| `driver.runResponseSink(upstream, env, sink, opts?)` | `src/lib/pipeline/driver.ts` | owns-the-sink：drain generator `runResponse` 写进 `sink.write`；丢弃 `[DONE]`；`opts.onRenderedFrame?(frame)→ClientFrame\|undefined`（post-S6-render transform，undefined=skip）；`opts.stopAfterFrame?(frame)→bool`（终态早停）；`finally` 调 `sink.close?()`。clean drain→`complete{headers}`，throw→`stream-error{error}`，client-abort→`settled-abort` |
| `makeSseSink`/`makeWsSink` | `src/lib/pipeline/client-sink.ts` | `onForwarded` 采样已在 sink 内、`forwardedType` 覆盖（Gemini）、heartbeat（Anthropic）。**forwarded 采样下沉已完成**——B4 的"采样进 sink"部分各 cut-over 已做，**本步只剩流末 drain 收口** |
| 各格式 owns-sink handler | `messages/handler-v4.ts`(Anthropic)、`chat-completions/handler-v4.ts`(CC)、`responses/handler-v4.ts`(Resp-HTTP)、`responses/ws.ts`(Resp-WS)、`gemini/handler-v4.ts`(Gemini) | 均 `outcome = driver.runResponseSink(...)` + 映射 `ctx.complete/fail/abort` |
| **B0/cut-over goldens（字节 oracle）** | `tests/anthropic/*`、`tests/openai/chat-completions-v4.http`、`tests/responses/responses-v4.http`+`responses-ws.http`、`tests/gemini/gemini-v4.http` | 含各格式流式字节 + owns-sink abort/H3。**逐字节必须仍绿** |

> Stage B commit 锚点：Anthropic `cdca98e` / CC `230c934` / Responses-HTTP `d35c1b5` / Responses-WS `deb8f07` / Gemini `433c9ba`。

## 2. 现状：流末 drain **各自 handler-side**（这就是 B4 要收口的）

每个 handler 在 `outcome.kind === "complete"` 分支、`runResponseSink` 返回**之后**做格式特有的流末收尾（re-read，已漂移）：

| 格式 | 流末 drain（现 handler-side） | 是否 `codec.flushResponse` | 锚点（re-read） |
|---|---|---|---|
| **Responses-HTTP** | `if (viaFallback) for (closing of codec.flushResponse(env)) { restoreAndAccumulate(closing) → sink.write }` | ✅ 是 | `responses/handler-v4.ts` ~`:317-326` |
| **Responses-WS** | 同上，`restoreAccumulateCount(closing)` | ✅ 是 | `responses/ws.ts` ~`:351-355` |
| **Gemini** | `for (frame of codec.flushResponse(env)) sink.write(frame)`（剩余 tool drain + 终态 finishReason/usage 帧）；之后 `codec.getStreamMeta()` settle | ✅ 是（但帧**不过** onRenderedFrame——codec 直出 Gemini 帧） | `gemini/handler-v4.ts` ~`:317/336` |
| **CC** | `await sink.write({ data: "[DONE]" })`（**总合成单 [DONE]**，passthrough+via-responses 统一）+ verbose 截断 marker（**pre-loop 首帧**注入） | ❌ **否**（[DONE] 是合成终止符、marker 是首帧注入，都不是 codec.flushResponse） | `chat-completions/handler-v4.ts`：[DONE] ~`:393`、marker ~`:316` |
| **Anthropic** | 无流末 drain（无 [DONE]、无 flushResponse、终态读 acc） | ❌ 否 | — |

**关键观察**：B4 的「S6 flush」精确对应的是 **`codec.flushResponse` 那条 drain = Responses-HTTP/WS + Gemini**。CC 的 `[DONE]`/marker **不是** codec.flushResponse（见 §3 红线 4 的归宿决策）；Anthropic 无流末 drain。

## 3. 目标 + 必须正确处理的红线（逐条核，这些是 B4 的全部难点）

**目标终态**：`runResponseSink` 在 clean drain 后、返回 `complete` 前，自己调 `deps.codec.flushResponse?.(env)` 把流末帧写进 sink（每帧仍过 `opts.onRenderedFrame`）；Responses/Gemini handler 删掉 post-loop 的 `for (... codec.flushResponse(env))` drain。

1. **`FormatCodec` 接口加可选 `flushResponse?(env): ClientFrame[]`**（`src/lib/pipeline/types.ts`）。现状它只在 concrete `OpenAiResponsesCodec`/`OpenAiGeminiCodec` 上，driver 看的是泛型 `FormatCodec`（无此方法）。driver 调 `deps.codec.flushResponse?.(env) ?? []`——Anthropic/CC codec 无此方法 → no-op，零影响。

2. **clean-completion-only，不在 `finally`**：S5 `flushChain` 在 `runResponse` 的 `finally`（所有退出都 drain buffered rewrite 帧）；S6 `flushResponse` **只在干净完成**跑（error/abort 不跑——Responses `response.completed`、Gemini 终态帧不该在错误流上发）。所以 S6 flush 放 `runResponseSink` 的 **for-await loop 之后、`return {complete}` 之前**（try 内 clean 路径），**不是** finally。plan「同 finally 阶段对称」是措辞——实测 S6 必须 clean-only，与 S5 flushChain 的 all-exit 语义**不同**，别硬塞进同一 finally。

3. **flush 帧必过 `opts.onRenderedFrame`**：Responses 的 flush 帧要走 restore+accumulate（`response.completed` 设 `acc.responseId/usage`）——现 handler 用 `restoreAndAccumulate`/`restoreAccumulateCount`，即各自的 `onRenderedFrame`。driver 的 S6 flush 须对每个 flush 帧调 `opts.onRenderedFrame?.(f) ?? f`（与 loop 内一致），`if (out) sink.write(out)`。Gemini **不传** onRenderedFrame → flush 帧 identity 直写（codec 已出 Gemini 帧）——同一段 driver 代码两格式都对。

4. **CC 的 `[DONE]`/marker 归宿决策（开放，需裁定）**：二者**不是** codec.flushResponse。
   - **marker**（verbose 截断）是 **pre-loop 首帧**注入、不是流末 drain → **留 handler-side**（与 S6 flush 无关，别动）。
   - **`[DONE]`**：CC 总在 complete 合成单个 `data: [DONE]`。两条路：(a) **留 handler-side**（[DONE] 是合成终止符，类比 Anthropic 不发终止符——最小改动，B4 只收口 codec.flushResponse 三格式）；(b) 给 CC codec 加 `flushResponse(env)` 返回 `[{data:"[DONE]"}]`，让 driver S6 flush 统一发。**推荐 (a)**——`[DONE]` 是 OpenAI 传输层终止符、非 codec 渲染产物，硬塞 codec.flushResponse 是为对称而对称（投机泛化，违 best-complete-solution）；driver 已有 `[DONE]` drop 逻辑，再让 codec 产 `[DONE]` 概念重复。**裁定写进 commit + DESIGN**。

5. **Gemini meta 时序不变**：handler 在 `runResponseSink` 返回**后**读 `codec.getStreamMeta()`。codec 的 flush（B4 后由 driver 在 runResponseSink 内跑）累积终态 meta → runResponseSink 返回 → handler 读 getStreamMeta()。时序保持（flush 在 return 前）。**亲验**：getStreamMeta() 仍拿到终态 finishReason/usage。

6. **Responses session 注册留 handler-side**：direct 的 `registerResponseSession(acc.responseId, ...)` **不是**帧 drain（是 acc 副作用）→ 留 handler post-loop。但它读 `acc.responseId`，而 `acc.responseId` 由 flush 帧的 `response.completed` 经 onRenderedFrame 设——B4 后 driver 在 runResponseSink 内跑 flush（设 acc.responseId）→ 返回 → handler 读 acc.responseId 注册。时序保持。**亲验 fallback 的 eager 注册（stream 前）+ direct 的 post-loop 注册都不变**。

7. **`[flush]→[error]` 顺序 + abort 零字节**：clean 路径 flush 帧在 complete 前写；error/abort 路径**不 flush**（红线 2）。owns-sink-two-racer + abort 覆盖 golden 必仍绿。

8. **driver.ts `renderFrames` 陈旧注释**：现注释枚举"driver 不能 own 的注入帧（verbose marker/heartbeat/Gemini）"作 P3.2b-D1 论据——B4 后逐项给归宿（marker→handler 首帧注入保留、heartbeat→sink、Gemini→已进 codec.renderResponse/flushResponse）。更新注释 + DESIGN 活架构表标 P3.2b-D1 已推翻。

## 4. TDD / 步骤

1. **改前再跑全格式流式 + abort/H3 goldens 全绿**（确认基线）：`bun test tests/responses/ tests/gemini/gemini-v4.http.test.ts tests/openai/chat-completions-v4.http.test.ts tests/anthropic/`。
2. **`FormatCodec` 加 `flushResponse?`**（types.ts，可选）。typecheck 绿（纯加可选成员，无消费者改行为）→ 可独立 commit。
3. **driver `runResponseSink` 加 S6 flush**：for-await loop 后、`return {complete}` 前，`for (const f of deps.codec.flushResponse?.(env) ?? []) { const out = opts?.onRenderedFrame ? opts.onRenderedFrame(f) : f; if (out) await sink.write(out) }`。加 driver 单测（mock codec.flushResponse 返回帧 → 验 clean 完成 drain、error/abort 不 drain、onRenderedFrame 施于 flush 帧）。
4. **Responses-HTTP/WS + Gemini handler 删 post-loop drain**：删 `for (... codec.flushResponse(env))`（driver 接管）；**保留** Responses 的 session 注册 + Gemini 的 getStreamMeta() 读（红线 5/6）。
5. **CC 按红线 4 裁定**：推荐留 `[DONE]`/marker handler-side、不动。
6. **跑全格式 golden 逐字节等价**（硬 gate）+ abort/H3 + 流式连跑 10-25× 确定。`bun run test:backend` 全绿。
7. `bun run typecheck` + `bunx eslint --fix`。
8. **≥2 全量工具 subagent 对抗 review**（视角：byte-safety 流末帧序 / clean-only gating 正确性 / Gemini meta+Responses session 时序 / CC [DONE] 归宿），显式裁判轴=长远正确+完整；主线亲核每个 file:line。
9. **Commit**（细粒度暂存）：可拆「types 加 flushResponse?」+「driver S6 flush + 各 handler 删 drain」两 commit，或一个。`git commit --only -F <msgfile> -- src/lib/pipeline/types.ts src/lib/pipeline/driver.ts src/routes/responses/handler-v4.ts src/routes/responses/ws.ts src/routes/gemini/handler-v4.ts tests/...`，msg 例：`refactor(pipeline): Stage B B4 流末 drain 收口进 driver S6 flush(Responses/Gemini;CC [DONE] 留 handler-side 裁定)`。

## 5. 验收

- 全格式流式 golden 逐字节等价 + abort/H3 覆盖仍绿；`bun run test:backend` 绿（唯一允许的预存无关 fail 须明示）。
- Responses-HTTP/WS + Gemini handler 不再有 post-loop `codec.flushResponse` drain；driver `runResponseSink` 在 clean 完成跑 S6 flush。
- Gemini getStreamMeta() + Responses session 注册时序不变（亲验）。
- CC `[DONE]`/marker 归宿有明确裁定 + 文档化。
- 2 轮 subagent 对抗 review 无 CRITICAL/HIGH。

## 6. 若决定不做（正当退出）

B4 是架构对称收口、非功能修复。若 review 认为「driver 持 S6 flush」相对「handler-side drain（当前正确、字节等价、可读）」的收益不抵 byte-critical 回归面（5 格式流末帧序），**可正当地不做**——但须：① 在 stage-b-plan.md 收尾节把 B4 标「评估后不做」+ 理由；② 确认 handler-side drain 的注释（如 `responses/handler-v4.ts:322` 的「Deferred: B4 moves this...」）改为「评估后保留 handler-side」，不留虚假 pending。

## 收尾（无论做不做）

- 更新 `stage-b-plan.md` 收尾节 B4 状态（已做 / 评估后不做）。
- 更新 `docs/DESIGN.md` 活架构「流式写出」行：若做，标 flushResponse 已进 driver S6 flush + P3.2b-D1 推翻；若不做，标 B4 评估结论。
- memory `project-v4-pipeline-rearchitecture.md`：Stage B 段补 B4 终态（一行，权威仍指 DESIGN）。
