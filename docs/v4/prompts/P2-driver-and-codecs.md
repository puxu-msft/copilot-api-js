# P2 — driver + 逐格式迁移实现提示词

复制以下内容到新会话启动 P2 实现。这是 v4 的核心阶段，建议**每个格式一个会话**（P2.1-2 建骨架一个会话，P2.3/2.4/2.5/2.6 各一个）。

---

我要实施 copilot-api-js 管线重构 v4 的 **P2 阶段（driver + 逐格式迁移）**。建 driver 七阶段骨架，逐格式从旧 handler 切到新管线，**新旧路径并存**（feature flag 可回切），旧路径保留到验证完成。

**前置**：P0、P1 完成。
**先读**：
- `docs/v4/01-architecture.md`（全文，尤其 §2 七阶段、§3 三角色分离、§5 重试模型）
- `docs/v4/03-spec/envelope-driver.md`（driver 编排 + 自动采样）、`codec.md`（FormatCodec + 透传矩阵）、`retry-transport.md`
- `docs/v4/02-current-state.md` 对应格式章节
- `docs/v4/04-migration-plan.md` 的 P2 表 + 迁移顺序理由
- 遵守 `docs/v4/prompts/README.md` 通用红线

**迁移顺序**（04 推荐，唯一建议复核点）：CC → Responses → Gemini → Anthropic。理由：CC 是翻译中枢、strategy 最少、风险最低，先跑通 driver 全链；Responses/Gemini 依赖 CC 翻译边；Anthropic 最复杂、约束最严，driver 成熟后最后迁。**若你要先验证最难约束，可把 Anthropic 提前——开始前用 AskUserQuestion 与用户确认顺序。**

**六个 commit**：

### P2.1 — driver + stages 骨架
按 `03-spec/envelope-driver.md` §3/§4 新建 `src/lib/pipeline/driver.ts` + `stages/*`：`runRequest`（S1→S4）、`runResponse`（S5→S7）、非流式变体。消费 codec + rewrite-registry + transport + strategies。**driver 在 stage 边界自动 publish 事件 + 自动采样**（§4 表：inbound/routed/rewrite_applied/attempt/upstream_frame/forwarded_frame/终态）。无格式接入。invariant：driver 单测（mock codec/transport）绿。

### P2.2 — openai-cc codec
按 `03-spec/codec.md` §1/§3 新建 `src/lib/codec/openai-cc.ts`：parse/decideRoute（透传 or via-responses or reject）/translateOut（identity or CC→Responses）/renderResponse（identity or Responses→CC）/formatError/createResponseAccumulator/prepareWire。复用现 `sanitize/translate/request-preparation`。invariant：codec 单测绿；旧 CC handler 仍在用。

### P2.3 — CC 切 driver
`chat-completions/route.ts` 改走 `driver.runRequest/runResponse`；旧 `handleChatCompletion` 保留但 feature flag 控制（`USE_V4_DRIVER["openai-cc"]`，默认开新、可回切）。invariant：**CC 全行为等价**——e2e + golden 覆盖透传/via-responses/auto-truncate/工具名还原/流式+非流式；且 CC 现在**也记上游原始 sseEvents**（driver 自动采样，补齐现状缺口=改进，非回归）。Azure CC 变体一并验证（model override 注入）。

### P2.4 — Responses 切 driver
新建 `codec/openai-responses.ts` + 切 `responses/route.ts`。含：CC↔Responses 翻译、上游 WS（transport 内部二次选择，`retry-transport.md` §4.1）、客户端侧 WS（`responses/ws.ts` 复用 driver）、Google force-fallback、stream-id-sync（响应改写）、normalizeCallIds（请求改写）。invariant：Responses 全行为等价（含 ws:/responses、force-fallback、client_ws_keep_open、max_ws_frame_bytes）。

### P2.5 — Gemini 切 driver
新建 `codec/gemini.ts`（按 `codec.md` §3 委托策略：parse=Gemini→CC + 记 dropped，decideRoute=无 gate 翻 CC，renderResponse=CC→Gemini，formatError=sidecar）+ 切 `gemini/route.ts`。codec 内委托 openai-cc codec 处理 CC payload 的 S3-S5。invariant：Gemini 全行为等价（dropped LOSSY params、tool_call 跨帧合成、错误帧 sidecar 而非 event:error）。

### P2.6 — Anthropic 切 driver（最复杂）
新建 `codec/anthropic.ts`（旁路直连：translateOut/renderResponse=identity）+ 切 `messages/route.ts`。难点：
- 所有 Anthropic strategy（含 P0.4 的 effort-learning）改 env 而非 wire（`retry-transport.md` §2.2）。
- **thinking signature 逐字回传**——带签名 thinking 块整块 echo 不改、不重排（registry gate，`01-arch` §4）。
- sseEvents 双轨（driver 自动采样上游原始）。
- `processAnthropicStream` 统一为 `guardSseIterable`（`retry-transport.md` §4：解析归 transport、累积归 sink，消除不对称）。
- web_search 双跳（codec 内子流程，保留裁剪版 sanitize 语义）。
- `acc.streamError` 控制信号 → driver 终态决策（`01-arch` §3 特例）。

invariant：Anthropic 全行为等价；**thinking signature 往返**（golden：从 `/history/api/entries/:id` 拉真实带签名 thinking 请求，splice 最小用例 POST `/v1/messages` 验证 200，参照 empirical-probe 手法）；web_search 双跳等价；连跑流式 idle/abort/shutdown 用 fake timers 10-25 次确认确定性。

**完成后**：更新 `05-progress.md` P2 表。每格式切换后 subagent review + 亲自复核"行为等价""thinking 无损"。

**关键坑**：
- feature flag 让每格式可运行时回切旧路径——切换前确保旧路径完好，别提前删（P3 才删）。
- S5（改写，操作 targetEndpoint 帧）vs S6（翻译到 clientFormat）边界严格（`rewrite-registry.md` §5）——CC-via-Responses 时上游 Responses 帧先归一到 CC（S4/S5 边界），再 S5 CC 改写，别混层。
- 上游 WS 是 transport 内部细节，不要泄漏到 codec/driver。
- 非流式路径走同 codec 的 NonStreaming 分支，别只迁流式。
