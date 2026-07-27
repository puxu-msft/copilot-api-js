# ADR: 续写重试 + 退役整响应缓冲 + 退役空-text 保活 —— 以完整响应换保真度

- 状态：Accepted（用户裁决 2026-07-22；D2 相对初稿反转，见下）
- 日期：2026-07-22
- 关联 spec：[docs/spec/2026-07-22-continuation-retry-and-sequential-anchor.md](../spec/2026-07-22-continuation-retry-and-sequential-anchor.md)
- 修订：[2026-07-11-block-level-buffered-retry](2026-07-11-block-level-buffered-retry.md)（前 spec）在 Anthropic 上未完成的部分
- 相关待办：[docs/todo/2026-07-22-client-proxy-keepalive-300s.md](../todo/2026-07-22-client-proxy-keepalive-300s.md)（>300s 保活调研）

## 背景

incident `req_162`（opus-4.8 / Claude Code CLI）：tool_use 中途 `NGHTTP2_CANCEL`，首块 commit 后按当今 `partial-degrade` 终局不重试，用户 0 可用产出。mid-stream CANCEL 协议上不可安全重试。前 spec 的 Anthropic 块级因 anchor-coexist 对 CLI 不安全而默认关、未完成。

## 决策

### D1 —— 退役整响应缓冲，兜底为 live（非 whole）

删除 `protect_streaming_generation` 的 whole-response 语义。所有缓冲一律块级。Anthropic 块级不可用时回退 **live**（`runResponseSink`），**永不回退 whole**。

**理由**：whole 是历史遗留的平行实现，与块级骨架重复；用户明确要求彻底退役、无双轨包袱（项目「无向后兼容负担」）。

**「回退 live」的精确语义 + block hook 跳过（已核实）**：block-level 与 live 是**两个不同的 driver 入口、不同的 opts 类型**——`runResponseBufferedSink(RunBufferedOpts)` 携全部 block hook（`commitBoundaries` / `committedBlocksLedger` / `extractCommittedBlocks` / `transformBufferedFlush` / 续写旁路），`runResponseSink(RunResponseOpts)` 类型上**无法接收**任何 block hook（[driver.ts:903](../../src/lib/pipeline/driver.ts)）。回退 live = 走 `runResponseSink`，所有针对 block 的 hook **结构性地不存在于这条路径**（TypeScript 编译期强制），ledger 喂养也只在 buffered 的 boundary-commit 里 → live 上续写永不触发。故 block hook 的跳过是**类型层面保证的，不靠约定**。

**已知缺口（须记录，非隐藏）**：当前**没有**「块级保活失败 → 运行时自动回退 live」的探测机制——`buffered` 纯由 `protect_streaming_generation` 配置决定（[handler-v4.ts:1064](../../src/routes/messages/handler-v4.ts) `resolveBufferedAndHeartbeat`）。spec 初稿写的「300s 门 FAIL → 回退 live」目前只能靠运维改配置实现。若需运行时自动降级，另立任务（backlog）。

### D2（相对初稿反转）—— 退役「空-text block 保活」，CLI-safety 改由块级顺序输出保证

> **2026-07-27 事实更正（不自动改写本 ADR 的用户决策）**：G2 当时并未证明空 `text_delta` 无法重置 CC 300s 死线；`recoverToolCallText` marker lookahead 在代理 response rewrite 链中吞掉了空 delta，下游只收到 ping。修复后真 CC 2.1.220 连续两次 315s PASS。故下文“G2 证无效”这一决策前提已被证伪；“空 text block 是否仍因形状原因退役、是否重新启用 `empty_text`”是新的产品语义分叉，须另行用户裁决，不能由这次 bugfix 擅自反转。权威取证见 [client-proxy keepalive 300s](../todo/2026-07-22-client-proxy-keepalive-300s.md)。

**初稿 D2 是「顺序 anchor 取代 coexist」（P1 已 landed close-before-real 空-text anchor）。现反转为：**

1. **退役向 client 注入空 text block 的保活**（`empty_text` 模式：`content_block_start@0(text "")` + 空 `text_delta`）。判据：空 text block 是**错误形状**，且实测（G2）空 `text_delta` 在代理路径**不能重置** CC 的 300s no-real-content 死线，**保不住保活**。
   - **全路径禁用、但不删代码**（`empty_text` / 顺序 anchor / `enveloped_ping` 实现保留，供后续保活调研复用）。实现手段 = `stream_keepalive_mode` 默认从 `empty_text` 翻为 `ping`（`ping` 模式下 `anchorHooks` 为 undefined，driver 所有 anchor 分支——含 P1 的 close-before-real——**自动 inert**，byte-equivalent 无 anchor 路径）。P1 landed 的顺序 anchor 代码因此**转为默认休眠**（非撤销）。
2. **过渡期长静默 = 裸 ping，接受 >300s 限制**。60s byte-idle 层仍在；CC 的 300s no-real-content 死线在 >300s 纯静默时会断连。**接受此限制**，等 [keepalive 调研](../todo/2026-07-22-client-proxy-keepalive-300s.md) 出真方案。
3. **块级递送的 CLI-safety 改由「严格按 index 顺序输出」保证，而非空 anchor**：因为是 block buffering，driver 在块闭合（`content_block_stop`）时**总是按 index 顺序** output——若 index=2 尚未闭合，则 index=3 虽已闭合也**压住不发**给客户端，直到 index=2 闭合。**允许上游 coexist index**（上游可并存 open 多个 index），客户端侧永远只见顺序、完整的块。这取代了「用空 anchor 逼出单块 open」的 P1 手法。
   - Anthropic direct 上游本就严格顺序，此不变量自动成立；CC/Responses 的并行 index（parallel tool_calls）由 D4 各格式块级升级时落地此顺序门。

**理由**：空-text 保活既错误又无效（G2 实证）；用户裁决停止发它、退回裸 ping 并接受 >300s 限制，把真保活留给后续调研；CLI-safety 由块级缓冲的确定性顺序输出承担，比空 anchor 更本质、更简单。

### D3（细化）—— 首块后续写重试，以合成 continuation 轮实现；完整可交互 tool_use 不续写

首块 commit 后被掐 → 重投上游，请求 = `[原始体] + [已commit块作assistant] + [合成user续写轮]`（默认 `"network issue. please continue"`，可配置）。上游不支持 assistant-prefill（haiku+opus-4.8 双拒实测），合成 continuation 轮是唯一可行形状。

**触发/终止规则（细化）**：
- **已提交前缀含任一「完整的、需客户端交互的 tool_use 块」→ 不续写，正常终止**。理由：完整的可交互 tool_use 是合法轮边界——客户端要拿去执行工具、自己接续对话，续写会破坏这个语义。（`server_tool_use` 等上游自执行、不需客户端交互的不算此列。）
- 续写**只在**被掐发生于 text/thinking、且已提交前缀**无**完整可交互 tool_use 时触发。
- **已完整的 text/thinking 块照发客户端，但不发 `message_stop`（不结束连接）**，直接在同一条连接上合成 user 续写轮、把剩余块接进来。
- **thinking 块发给客户端，但不进续写的合成 assistant 前缀**（上游拒 thinking 作前缀 + 签名毒化风险）。合成 assistant 前缀只带可安全重放的块（text / 完整 tool_use）——与 ledger extractor 已排除 thinking 一致。

**取舍**：重发整上下文 + 重新计费 + 续写保真度不完美（合成轮是「重构意图」非模型真实内部状态）。用户裁决：client 优先「拿到完整响应」，不在乎双重计费/不完美。

### D4（确认）—— 全端点块级 + 续写默认 on

Responses WS 升块级、CC 升块级；续写覆盖 Anthropic + Responses(HTTP/WS) + CC；`continuation.enabled` 默认 true；续写与首块前透明重试共享 `max_retries`（默认 3）。Gemini 排除。块级缓冲默认 on 与 D2 的「anchor 禁用」正交（块级缓冲 = commit 边界机制；keepalive = 裸 ping）。

**理由**：长远、泛用优先（项目哲学）；CC 有内部结构（indexed tool_calls）可重建块边界，不应留退化档。默认 on 契合用户「完整响应优先」立场。

## 后果

- 正面：incident 类 mid-stream cancel（首块后、限内被掐）可被续写救回；块级递送 CLI-safe 靠确定性顺序输出（无需空 anchor）；全端点统一块级骨架，无 whole 双轨、无空-text 保活的错误形状。
- 负面/代价：
  - 续写重发上下文 + 重新计费（prompt cache 摊薄）；续写块保真度降级（诚实标注 `synthetic:"continuation"`）。
  - **>300s 纯静默（尤其首块前长静默，如 incident 的 142.9s 那类若超 300s）会断连**——空-text 保活退役后无替代，接受此限制待调研。incident 本身 142.9s < 300s 不踩，但同类更长静默会踩。
  - P1 landed 的顺序 anchor 代码转为默认休眠（保留不删）。
  - CC/Responses/WS 续写形状依赖计划期 PoC 门（G3/G4/G5 已 PASS），FAIL 则该格式/角落回退 partial-degrade。
  - 「运行时自动降级 live」缺口（D1）未做，记 backlog。

## 备选（未采纳）

- native prefill 续写：上游双拒，无绕过。
- 保留 whole 作 Anthropic 兜底：用户裁决彻底退役，回退 live。
- **保留空-text anchor 保活**（初稿 D2）：用户裁决退役（错误形状 + G2 证无效），改裸 ping + 顺序输出，真保活留待调研。
- 续写独立预算旋钮：弃，用共享预算。
- 无限续写：弃，受 max_retries 共享预算约束（防病态大请求续写风暴）。
