# ADR: 客户端保活「无条件 timeout-safe」——keepalive 开着则客户端永不因 CC watchdog 超时

- **状态**：Accepted（2026-07-09，用户定夺）
- **日期**：2026-07-09
- **相关**：
  - 目标陈述（用户）：**「客户端永不因为超时报错」**。
  - 机制细节（WHAT/HOW）：spec [2026-07-08-buffered-keepalive-empty-text-anchor.md](../spec/2026-07-08-buffered-keepalive-empty-text-anchor.md) §10（本 ADR 落地的合成 message_start 锚点 + live 路径对账 + mode taxonomy）。
  - 前身机制：spec [anthropic-keepalive-content-delta.md](../spec/anthropic-keepalive-content-delta.md)（`content_delta` keepalive 本体）。
  - 客户端两层 watchdog 实测：skill `claude-code-connection`。
  - 合成帧须打可辨识标记：ADR [richest-data-flow](2026-07-05-richest-data-flow.md)（对称面）。
  - 活的架构现状：[../DESIGN.md](../DESIGN.md)「活的架构现状」keepalive 行。

## 背景

copilot-api 把 GitHub Copilot 的模型能力代理给 Claude Code（CC）等客户端。CC 对流式 `/v1/messages` 关掉 SDK 的 600s 总超时，改由**两层 idle watchdog** 管（skill `claude-code-connection` 实测）：

1. **60s byte-idle**：每收任意字节/帧重置。裸 `event: ping` 能压住它。
2. **300s no-real-content**：一定时间内必须收到**真实 content chunk**（`content_block_delta`，空 delta 也算），否则断，报 `Stream idle timeout - no chunks received`。**裸 ping 与 SSE comment 都不算 chunk、压不住这一层。**

上游 opus 系模型在 heavy thinking / 巨型上下文下会在**响应前**合法静默数百秒（已知 >600s 先例）——期间代理无真实内容可转发，只能发 keepalive。

### 实测锁定的 incident（2026-07-09）

History 库只读探针取 `req_1783609043247_663`（claude-opus-4.8，↑435.7KB，`aborted`，`durationMs=320224`，`client disconnected`）：

- `upstream_response`：`success:false, body:null`——上游整整 320s **从没返回任何内容**（连响应头都没有，`attempt[0].error="The operation was aborted."` 是客户端 abort 传导过去）。
- `client_response.sseEvents`：commit 200 @6ms，**16 帧全部是裸 `ping`**（offset 6ms/20s/40s…/300s，`synthetic:"keepalive"`），零真实帧。
- 最后一帧是 300.0s 的裸 ping，随后客户端在 320s 断开。

全库统计:`aborted` + `client disconnected` 里 **20 条**紧簇在 320.1s（±0.2s），15 条零输出。如此紧的时间簇 = **确定性的客户端 watchdog**,绝非用户中断（那会散布）。

### 根因

代理配 `stream_keepalive_mode: empty_text`（本意是 300s-safe），但发出去的**全是裸 ping**：`empty_text` 的合成空 text 锚点(spec 2026-07-08)只在 **buffered 路径**（`runResponseBufferedSink`）绑定注入器,且依赖捕获真实 message_start。本次是 **live/delayed-commit 路径**（`protect_streaming_generation: false`），注入器**从未绑定**;即便绑定,纯 pre-response 静默下上游**连 message_start 都没发**,无从锚定。于是 keepalive 退回裸 ping（`makeAnthropicKeepaliveFrame(openBlock=undefined)` → `ANTHROPIC_PING`）→ 压住 60s 层却撞 300s 层 → 客户端 300s 断连。

这正是 `empty_text` 本应防住的 incident,但它的 scope 漏掉了「live 路径 + 上游全程静默」——spec 2026-07-08 §4#1 曾把「纯 pre-message_start 静默」列为 deferred enhancement（「合成 message_start，本 spec 不做」）。生产实证它在 live 路径高发（20 条）。

## 定夺

**只要 keepalive 开着（`stream_keepalive_ping_sec > 0`）且选安全模式，客户端就永不因 CC 的 300s / 60s watchdog 超时——这是一条不变量，无条件生效于所有流式路径（live / delayed-commit / buffered），不再有「仅 buffered」门控。**

### 1. keepalive 无条件重置 300s（安全模式下）

心跳到期时：

- **有真实 open block（thinking / text / tool_use）**：发匹配类型的**空 delta**（`thinking_delta{""}` / `text_delta{""}` / `input_json_delta{""}`）→ 同时重置 60s + 300s。
- **无 open block（pre-response 静默 / message_start 后首块前 / buffered pre-commit）**：注入**合成 message_start + 空 text 锚点块(0) + 空 text_delta** → 重置 300s。合成 message_start 只需 model 名（env 恒有）→ **任何时刻都能锚定**，不再依赖捕获真实 message_start。

裸 ping 从安全模式的保活路径**彻底消失**。唯一残留的理论超时缝隙：`redacted_thinking` open block（无 streaming delta 语义、无法发空 delta；通常 start+stop 即时完成、不悬挂）——文档化于 spec §10，不阻塞。

### 2. wire 分歧（合成 message_start）是可接受降级

合成 message_start 带假 `id`（`msg_synthetic_<reqid>`）与 `usage.input_tokens:0`（真实 input token 数永不送达客户端——Anthropic 只在 message_start 携 input_tokens，终末 message_delta 只带 output_tokens）。真实上游帧到达时丢弃真实 message_start、真实 content block 索引 +1（锚点占 index 0）。

**这是计费/显示层的 wire 分歧,非协议破坏**,用户已明确接受（2026-07-09）。契合 ADR [internal-tool-security-posture](2026-07-05-internal-tool-security-posture.md)（内部工具,运维价值 > 假想代价）与项目哲学「架构健康 > 向后兼容 / 回归风险」。可用性（客户端永不超时）压倒 message_start 元数据的逐字节保真。

### 3. mode taxonomy：保留 legacy `ping`，合并出单一安全默认，新增 `content_ping`

`stream_keepalive_mode` enum 从 `["ping", "content_delta", "empty_text"]` → **`["ping", "content_ping", "empty_text"]`**，默认 `empty_text`：

| 模式 | 静默时合成 message_start | keepalive 帧（无真实 block） | 重置 300s | 合成 content block / index remap |
|---|---|---|---|---|
| **`ping`**（legacy 逃生舱） | 否 | 裸 ping（裸流上） | 否，会超时 | 否 |
| **`content_ping`**（新） | **是**（提交 message 信封） | 裸 ping（message 内） | **待 oracle 实测**（现有证据倾向否） | 否（不造 content block，无需 remap） |
| **`empty_text`**（默认，安全） | 是 | 锚点块上空 `text_delta` | **是** | 是（锚点 @0，真实块 +1） |

- **`content_delta` → 迁移到 `empty_text`**（`config/compat.ts` renameLeaf / valueMap，warn-and-migrate）。在无条件重置下 `content_delta` 与 `empty_text` 等价（前者只是没有 pre-response 锚点，而锚点现已无条件）。
- **保留 `ping`** 作为知情逃生舱：某些客户端可能不吃空 delta / 合成 content block 时可回退（纯裸 ping、classic 行为、可能 >300s 超时）。项目无向后兼容负担,但保留一个真正的「关掉所有合成」开关有诊断价值。
- **`content_ping`（新增,用户 2026-07-09 要求）**：合成 message_start 提交 message 信封,但 keepalive 只发裸 ping、**不造合成 content block、不发空 content delta**（故无需 index remap、不污染消息为空块）。相对 `empty_text` 更「干净」,代价是保活靠裸 ping。

### 4. content_ping 的实证问号（上线门控,可能改默认）

「forwarded message_start + 裸 ping」到底重不重置 CC 300s **从未被干净测过**——原 incident 里 message_start 是**被缓冲、没转发**给客户端的(客户端只见 ping),而 skill 结论「ping 不算 chunk」是在无 message_start 的裸流上测的。故这是开放实证问题：

- 若 oracle 证明 **message_start + 裸 ping 撑不过 300s**（现有证据倾向此）：`content_ping` 记为「知情、可能超时」的中间档,默认保持 `empty_text`。
- 若 oracle 证明 **message_start + 裸 ping 能撑过 300s**：`content_ping` 反而是**更干净的安全模式**（无假 content block、无 remap、不污染消息）,应取代 `empty_text` 当默认。

裁决依据是亲手实测（skill `empirical-verification`：真实 CC 作独立 oracle,复用 `exp/cc-idle-280s/`），不凭推断。

## 后果

- **正面**：live/delayed-commit 路径的 pre-response 静默（生产 20/短期条 incident 的主因）被根治;buffered 路径的 pre-message_start 窄窗一并覆盖;保活行为从「分路径、有门控」收敛为「无条件不变量」,更易推理与测试。
- **负面 / 代价**：合成 message_start 的 wire 分歧（§2,已接受）;live 路径需新增实时逐帧对账（丢真实 message_start + content_block_* 索引 +1 + 首真实块前收口锚点）——比 buffered 的 flush-时 remap 复杂,须覆盖 retreat（OOM cap）路径（见 deferred-backlog「retreated + 锚点 index 碰撞」条,本次一并修）。
- **迁移**：`content_delta` 配置自动迁移到 `empty_text`;显式 `ping` 保留;无双轨包袱。
- **未采纳**：① 完全移除 mode 旋钮（用户选保留 `ping` legacy）;② 把 pre-response 锚点做成仅 live 路径（用户选统一 live+buffered）;③ 上游 stall 快检提前触发 retry（spec 2026-07-08 §2 已否——heavy-thinking 合法慢会误伤）。

## 参考实证

- incident 记录：History `req_1783609043247_663`（+ 同签名 19 条,320.1s±0.2s 紧簇）。
- 根因链与两层 watchdog：skill `claude-code-connection` / `empirical-verification`。
- 机制与测试矩阵：spec [2026-07-08-buffered-keepalive-empty-text-anchor.md](../spec/2026-07-08-buffered-keepalive-empty-text-anchor.md) §10。
