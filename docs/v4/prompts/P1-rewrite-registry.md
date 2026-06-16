# P1 — 改写 registry 化实现提示词

复制以下内容到新会话启动 P1 实现。

---

我要实施 copilot-api-js 管线重构 v4 的 **P1 阶段（改写 registry 化）**。把现状 40+ 个改写动作从"handler 内联 + 注释维系顺序"重组为"命名、可插拔、registry 声明顺序"的 transform 链。**核心硬约束：每个改写的输出必须与现状逐字节等价**（golden fixture 守，diff 即 fail）。

**前置**：P0 完成。
**先读**：
- `docs/v4/01-architecture.md` §1.6（registry 概念）
- `docs/v4/02-current-state.md` §2（请求改写 A/B/T/O/S 全集）、§3（响应改写 A/C/P 全集）—— **实现前逐个复核 file:line**
- `docs/v4/03-spec/rewrite-registry.md`（接口 + 顺序契约 + 改写映射）
- `docs/v4/04-migration-plan.md` 的 P1 表
- 遵守 `docs/v4/prompts/README.md` 通用红线

**六个 commit**：

### P1.1 — registry 接口 + 装配器
按 `03-spec/rewrite-registry.md` §1/§2 新建 `src/lib/pipeline/rewrite-registry.ts`：`RequestRewrite`/`ResponseRewrite`/`RewriteResult`/`FrameAction`/`RewriteState` 接口 + `assembleRequestRewrites`/`assembleResponseRewrites`（filter by appliesTo + sort by order）。纯新增，无消费者。

### P1.2 — Anthropic 请求改写注册（T*/A*）
把 `message-tools.ts` 的 T1-T7、`sanitize/*` 的 A1-A9 包成 `RequestRewrite`，**order 键编码顺序契约**（`03-spec/rewrite-registry.md` §3：T<sanitize、T7 在中间、A6<A8、A7<A8）。`messages/handler.ts` 的内联 `directSanitize` 闭包（handler.ts:264）改调 `assembleRequestRewrites` + 顺序 apply。invariant：**sanitize 输出逐字节等价**——先对现状 `sanitizeAnthropicMessages` 在一组覆盖 fixture（含 reminder/server-tool/thinking/孤儿 tool/dedup）上抓 golden，注册化后对比无 diff。

### P1.3 — Anthropic prepare 子步骤注册（B*）
现状 `prepareAnthropicRequest`（request-preparation.ts:134）的 B1-B12 是 file-local 私有子步骤、顺序硬编码。**导出**为有序 `RequestRewrite`（header/body 裁剪类，order 400-490），声明 B3<B4<B5、B8<B9<B10。**注意**：B 组依赖 `prepareHints`（每 attempt 变），所以它们组装进"prepareWire"链（S4 每 attempt 跑），不是 S3 一次性——本 commit 先注册 + 让现 prepare 调 registry，保持每 attempt 调用语义。invariant：**wire payload + headers 逐字节等价**（golden：beta/effort/cache_control/context_mgmt/reject-field 各种组合 + prepareHints 注入场景）。

### P1.4 — OpenAI CC/Responses 请求改写注册（O*）
O1-O15 包成 RequestRewrite。CC 的 O10（max_completion_tokens 填充，现内联 handler.ts:206）抽成命名 rewrite。invariant：wire golden 等价。

### P1.5 — 响应改写注册
按 `03-spec/rewrite-registry.md` §4 响应表，把 Anthropic A1-A4、CC C1-C2、Responses P1-P2 包成 `ResponseRewrite`（含 buffer/flush 语义：tool-input-decode 用 buffer+flush；server-tool-filter 用 suppress/emit；heartbeat/marker 用 emit-only）。各 handler 流式循环改调装配的链。**保留顺序**：anthropic thinking-sig(100)<tool-input-decode(200)<server-tool-filter(300)。invariant：**forwarded SSE 帧逐字节等价**（golden SSE fixture，含 server-tool/工具名/thinking-sig/decode 场景）。

### P1.6 — 错误帧 formatter → codec
三协议错误帧成形（`anthropicStreamErrorType`/`streamErrorToOpenAIErrorType`/`geminiStreamErrorStatus`）收进各 codec 雏形的 `formatError`，共享 `classifyStreamError`。invariant：错误帧 golden 等价（idle/shutdown/other 各协议）。

**完成后**：更新 `05-progress.md` P1 表。每 commit subagent review + 亲自复核字节等价断言。

**关键坑**：
- 逐字节等价是**铁律**：任何顺序、空白、字段序差异都会让上游 400 或客户端 SDK 解析失败。golden fixture 先抓现状、再对比。
- web_search 双跳用"裁剪版 sanitize"（只跑 Phase 2，故意不跑 preprocessTools/T7，`02 §2.6`）——注册化后这条路径要能选择性装配子集（appliesTo 或单独装配入口），别让它意外跑全链。
- S1/S2/S3 system-prompt override（S1-S3）**非幂等**（prepend/append 每次都加），只能 S3 入口跑一次，**绝不**进 S4 attempt 循环——order 与 appliesTo 要保证这点。
- 不改 `HistoryEntryData`；sanitization 诊断现由 `request.rewrite_applied` 事件喂（但 P1 still 经现 handler，事件化是 P2/P3）。
