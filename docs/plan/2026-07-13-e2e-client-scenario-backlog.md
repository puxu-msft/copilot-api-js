# client↔proxy e2e 场景 backlog 实现指南（交接）

> **交接目的**：把 spec `2026-07-13-client-proxy-sdk-e2e-harness.md`「e2e 场景覆盖 roadmap」的未覆盖 backlog，变成新会话可**逐条直接执行**的配方。每条给：层 / config / 上游帧 pattern / 客户端可观测 oracle / harness 需求（现有 or 新扩展）/ gotcha / 建议变异。**先读 skill `client-proxy-e2e-testing`**（承重机制 + oracle 纪律），再挑一条实现。
> **现状**：21 场景已覆盖（Tier1 SDK 19 + Tier2 CLI 2），全变异验证有牙。骨架 `tests/e2e-client/`。

## Kick-off prompt（复制给新会话）

```
读 skill client-proxy-e2e-testing + docs/plan/2026-07-13-e2e-client-scenario-backlog.md。
从「一梯队」挑一条未覆盖场景（如 B9 其余 retry 腿），按其配方在
tests/e2e-client/anthropic-sdk.it.test.ts（Tier1）或 anthropic-cli.e2e.test.ts（Tier2）加测试：
① 先证正样本对照（正常帧下客户端正确拼装/不 throw）② 再断言目标行为
③ [CODE-INFER] 条目先跑真实客户端 oracle 坐实真实行为再固化断言
④ 新绿测试做变异验证有牙（关掉被测行为→只该测试变红）⑤ typecheck+lint+提交。
Tier2 spawn 真 proxy 需 claude+github_token（gated），改 config 用不同 refusal/hook。
```

## 通用纪律（每条都守）
- **否定/降级断言必配正样本对照**（`verifying-authoritative-claims`）：证「throw/丢帧/stall/降级」前先证正常路径成功。
- **`[CODE-INFER]` 先实测坐实**：文档没直接记录客户端可观测终态的，先跑真实 SDK/CLI 看真实行为、别把推断当断言（我踩过：SDK 不补 citations、eventless START 被后续 delta 遮蔽——都是实测才知道）。
- **新绿测试变异验证有牙**：关掉被测源码行为（如 `if (false && ...)`），确认**只**对应那条测试变红、无附带，再还原。
- Tier1 上游屏蔽只用 `setUpstreamFetchForTests`，绝不 `applyFetchMock`；Tier2 hook 帧存 base64（避 data-URL 具名导出丢失）。

## 可能需要的 harness 扩展（按需加，别预造）
- **时序场景（B1/B2/B18 keepalive/idle）**：用 `tests/helpers/fake-clock.ts` + `fake-stream.ts`（已存在，keepalive 单测在用）驱动确定性时间，别真 sleep。或加一个「长静默后再发帧」的上游 helper（`createSseResponse` 之间插可控延迟/挂起）。**关键**：真实 CC 的 300s 墙只能 Tier2 真计时验；Tier1 只能验「空 delta 被 SDK 无害累积」（喂空 delta 序列，SDK finalMessage 不含可见空文本、不崩）。
- **client-abort（B17）**：Tier1 给 `client.messages.stream(..., { signal })` 传 `AbortController.signal`、中途 abort；断言 SDK 抛 `APIUserAbortError`。Tier2/history 侧三类中止区分需查 history（heavier）。
- **Tier2 多 config**：`spawn-proxy` 每场景传不同 `configYaml`（已支持）；不同上游形状改 `cli-refusal-hook.ts` 的 base64 帧或新增 hook 文件。
- **reactive retry**：用 `sequencedUpstream([() => httpErrorResponse(400, pattern), () => createSseResponse(happyTurn(...))])`（已有）。

---

## 一梯队（生产 incident 催生、`[DOC-REAL]`、优先）

### B9 其余 reactive retry 腿（server-tool / cache-control / unsupported-beta）— Tier1 SDK
✅ **全覆盖（2026-07-13）**：tool-field + cache_control-subfield + server-tool + unsupported-beta 四腿全落地。unsupported-beta 用 explicit-list 路径 `unsupported beta header(s): <flag>` 干净单重试（laconic `invalid beta flag` 探测路径需 outbound 真带 beta + `getProbeCandidates` 才 retry，故用 explicit 更确定）。四腿同构，只换首腿 400 body 的 pattern（正则在各 strategy 文件，务必精确命中）：
| 腿 | 首腿 400 message pattern（造能被 `.test()` 命中的串） | strategy 文件 |
|---|---|---|
| cache-control-subfield | `...cache_control.ephemeral.<field>: Extra inputs are not permitted`（正则 `/\.cache_control\.\w+\.([a-z_]\w*): Extra inputs are not permitted/`） | `cache-control-subfield-rejection-retry.ts:40` |
| server-tool | 见 `SERVER_TOOL_REJECTION_TABLE` 的 `pattern`（`server-tool-rejection-retry.ts`，grep 表内正则照造） | 同名文件 |
| unsupported-beta | `invalid beta flag`（`BETA_ERROR_PATTERN`，`unsupported-beta-retry.ts:62`） | 同名文件 |
- **oracle**：`sequencedUpstream([400-pattern, 正常流])` → SDK 拼出正常 turn + `callCount()===2`（内部重试透明）。
- **gotcha**：body 必须是 error-shaped `{type:"error",error:{type,message}}`（`httpErrorResponse` 已是），message 命中 pattern；某些腿改的是**请求**字段，故 mock 上游二腿直接返正常即可。
- **变异**：把该 strategy 从 driver 注册表摘掉（或 `canHandle` 返 false）→ 不重试 → `callCount===1` + 客户端拿 400 throw → 测试红。

### B8 thinking 双相邻块毒化 → reactive 恢复 — Tier1 SDK
- **上游**：首腿返 HTTP-400 `messages.N.content.M.thinking: cannot be modified`（`ghc-anthropic-upstream` skill 症状表 / `thinking-quarantine/`），二腿返正常流。config 开 `strip_thinking_on_reject` 或默认 L1 de-stack。
- **oracle**：客户端最终拿到成功 turn（而非每轮 400 硬失败），`callCount()>=2`。
- **`[CODE-INFER]` 风险**：确切 400 body 串 + 哪条腿触发需实测坐实（先造 400 看 proxy 是否重试成功）。
- **变异**：关 thinking reactive 恢复 → 客户端拿 400 throw。

### B1 CC 300s no-real-content keepalive 墙 — Tier2 计时（Tier1 只验空 delta 无害）
- **Tier1 可做的**：上游发一串**空 content_block_delta**（`thinking_delta{thinking:""}`/`text_delta{text:""}`）后正常收尾 → SDK finalMessage 拼出正常内容、**不把空 delta 当可见文本**（`docs/refusal-recovery.md:37`、`debugging-claude-client-connection` skill「空 delta 算 chunk」）。这是 B15 的一半，Tier1 确定性可测。
- **Tier2 真墙**：spawn proxy + config `stream_keepalive_mode: ping`（撞 300s 墙）vs `empty_text`（保活到 340s），hook 上游长静默 → 真 claude 是否报 `Stream idle timeout - no chunks received`。**需真计时（数百秒）**，重、gated；参考 `exp/cc-idle-280s/REPORT.md` 四臂对照。**建议先只做 Tier1 空-delta-无害那半**，真墙留 Tier2 后续。

---

## 二梯队（承重、较专）

### B5 非流式语义截断 — Tier1 SDK 非流式（弱 oracle）
- 上游非流式 200 JSON **无 `stop_reason`** → proxy 记 fail 但**仍转发 partial body 200**（richest-data-flow）→ 客户端拿到残缺投影**非 500**。oracle 弱（有趣的 fail 在 history 侧、非客户端可观测）；若要测客户端侧，断言 `msg.stop_reason` 为 undefined + content 是 partial。**优先级低**（客户端行为不突出）。

### B13 HTTP-429 vs 200-error-429 CC 重试发散 — Tier1（SDK 类型）+ Tier2（CC 包装层）
- **Tier1**：HTTP-429 → SDK 得 `RateLimitError`（`.status===429`）；200+流内 error-429 → 无类型 `APIError`（`.status===undefined`）。已做 HTTP-400 类型化那条，此为 429 变体 + 对照。
- **Tier2**：HTTP-429 → CC 持续重试 ≥7×（`callCount` 大）；200-error-429 → 一次即弃（`callCount===1`）。需 Tier2 真 CC。来源 `debugging-claude-client-connection` skill「零重试」节。

### B17 三类中止（client-abort/reaper/header-timeout）区分 — Tier1（client-abort）+ history
- **client-abort（Tier1 可做）**：`stream(..., {signal})` 中途 `controller.abort()` → SDK 抛 `APIUserAbortError`（`@anthropic-ai/sdk` 导出）。
- reaper/header-timeout 需真计时 + 查 history state（600 vs 300s），heavy；来源 `debugging-claude-client-connection` skill「事后判别」表。

### B16 buffered-retry 上游 RST 透明 — Tier1（最终完整）+ Tier2（保活）
- config `protect_streaming_generation: true`，上游首腿活跃流中途 **body error/RST**（`createSseResponseThenError(frames, new Error("RST"))`）→ 二腿正常 → 客户端拿完整 turn（半截不泄漏）、`callCount===2`。
- **变异**：关 buffered-retry → 客户端拿半截 + throw。

---

## 三梯队（广度、多为回归锚点）
- **B12 翻译矩阵反向腿**（Anthropic client × CC/Responses/Gemini upstream 逐 cell）：每 cell 一条 happy-path，客户端用 Anthropic SDK、模型导向异协议 GHC 腿、mock 上游返该协议帧、断言 SDK 正确拼装。承重约束（反向不合成 thinking、streamError 门）见 `project-universal-translation-matrix.md`。量大、逐 cell 加。
- **B15 合成帧空 delta 不泄漏**：keepalive/anchor 空 delta 不进 SDK finalMessage 可见内容（与 B1-Tier1 那半重叠）。
- **B18 Responses SSE/WS keepalive**：Tier1 用 OpenAI SDK responses / 需 WS harness（Tier1 明确不覆盖 WS 路由）。
- **B20/B22/B23**（repetition 终止 / cache_control 剥离透明 / tool name 还原）：`[CODE-INFER]`，先实测坐实。

---

## 收尾（每批做完）
typecheck + `bunx eslint <改动文件>` + 全 `tests/e2e-client/` 绿 + 无 leftover proxy（Tier2）→ 更新 spec roadmap 的「已覆盖」清单 → 细粒度提交。若发现新 gotcha/机制，回填 skill `client-proxy-e2e-testing` 与本 plan。
