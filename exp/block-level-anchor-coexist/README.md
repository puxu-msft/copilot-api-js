# block-level-anchor-coexist — 两段 PoC 门（spec §4.5）

归属：`docs/spec/2026-07-11-block-level-buffered-retry.md` §4.5（R4「默认 on」翻转前置）。这是块级缓冲重试「默认 on 安全」的**实证脊梁**。

## 为什么需要这个门

块级 flush 的 wire 形状 = **anchor@0 全程 open + 真实块@+1 同时 open + 块间 `text_delta@0` + 仅终止 close@0**。其中「两块并存 open」是一个**未验证的协议假设**——Claude Code 的 `@anthropic-ai/sdk` SSEDecoder 是否接受「index 0 与 index 1/2 同时处于 open 状态」的流，没有先例可依。若客户端拒绝，主形状不可用，须走备选/兜底。

门分**两段**，对应两个正交的失败面：

| 段 | 问题 | 谁跑 | 可自动化 |
|---|---|---|---|
| ① 代理可产出 | 生产 sink（块栈，commit 6a4ae0ea）**确实产出**块间 `text_delta@0`（非裸 ping）？ | **agent**（`oracle-wire.ts`） | 是（可 CI） |
| ② 客户端接受 | 真实 `@anthropic-ai/sdk` / Claude Code **接受**两块并存 open + 长静默不断连？ | **用户**（`probe.ts`，起 server） | 部分（①可，②需真 CC） |

「代理产出」与「客户端接受」是两件不同的事——原 PoC 门只测了后者一半（未验代理是否真产出、未验 300s 死线被 `text_delta@0`（而非 ping）重置）。本门补全。

## 文件

- `fixture.ts` —— 两段共享的合成块序列（anchor@0 + 真实块@1/@2 并存 + 块间 gap + 终止 close@0）。**一份 fixture 驱动两段**，保证「①证代理产出的形状」与「②要客户端接受的形状」逐字节一致。
- `oracle-wire.ts` —— **第一段**（agent 跑）。用生产 `makeSseSink` + `resolveAnthropicKeepalive("empty_text")`，独立数组 sink（假 `SSEStreamingApi`）抓 wire，逐帧断言。
- `probe.ts` —— **第二段**（用户跑）。起最小 SSE server 回放 fixture，用 `@anthropic-ai/sdk` 的 `Stream.fromSSEResponse`（裸 SSEDecoder）+ `messages.stream()`（MessageStream 累积器）消费并断言；`--serve` 模式为真实 Claude Code 300s 死线测试。

## 第一段：代理可产出（`oracle-wire.ts`，agent 已跑）

```bash
bun run exp/block-level-anchor-coexist/oracle-wire.ts
```

**结果：PASS**（连跑 20/20 确定性通过，2026-07-11）。抓到的 wire：

```
[ 0] message_start
[ 1] content_block_start@0            ← anchor 打开（empty text）
[ 2] content_block_delta@0 text_delta ← anchor 自己的首个空 delta
[ 3] content_block_start@1            ← 真实块 #1（tool_use）打开，anchor@0 仍 open（两块并存）
[ 4] content_block_delta@1 input_json_delta
[ 5] content_block_stop@1             ← 真实块 #1 关闭
[ 6] content_block_delta@0 text_delta ← «GAP» 块间 idle：心跳骑 anchor@0
[ 7] content_block_delta@0 text_delta ← «GAP»
[ 8] content_block_delta@0 text_delta ← «GAP»
[ 9] content_block_delta@0 text_delta ← «GAP»
[10] content_block_start@2            ← 真实块 #2（text）打开
[11] content_block_delta@2 text_delta
[12] content_block_stop@2
[13] content_block_stop@0             ← anchor@0 仅在终止处关闭（terminal-only）
[14] message_delta
[15] message_stop
```

三组断言全绿：
- **(A) 两块并存 open**：`content_block_start@0` 在 `content_block_start@1` 之前，且其间**无** `content_block_stop@0`。
- **(B) 块间 gap = `text_delta@0`（非裸 ping）**：这是 C1 回归 oracle——块栈修复前，单槽 `openBlock` 被真实块@1 的 start 覆盖、被其 stop 清空 → 块间 tick 见 `undefined` → 裸 ping → CC 300s 断连。块栈让 anchor@0 常驻栈底 → 块间 tick 骑它。
- **(C) anchor@0 恰好关闭一次，且在真实块@2 关闭之后**（terminal-only close）。

**含义**：生产块栈 sink（Task 2）确实产出目标 wire 形状。**若第一段 FAIL → 块栈改造未生效，回 Task 2**（本轮不适用）。

## 第二段：客户端接受（`probe.ts`，⚠ 须用户执行）

`probe.ts` 起本地 SSE server，故落 **no-auto-server 纪律**——**agent 不跑，须用户跑**。

### 自动化子集（criterion ①：SDK 解析 + 累积）

```bash
bun run exp/block-level-anchor-coexist/probe.ts
```

起 server 回放 fixture，用 `@anthropic-ai/sdk` 两条路径消费：
- **路径 A**：`Stream.fromSSEResponse`（裸 SSEDecoder）—— 断言每帧解码无报错、无丢帧（解码事件数 ≥ fixture 帧数）、观测到 anchor@0 与真实块并存 open。
- **路径 B**：`client.messages.stream()`（MessageStream 累积器，Claude Code 自身的消费路径）—— 断言累积器不抛错、组装出非空 final message。

**判据 ①**：SDK 解码 + 累积**无报错、无丢帧**，且两块并存 open 被接受。默认用短 idle（`--long-idle` 默认 2s）快速走完 gap。

### 真实 Claude Code 死线测试（criterion ②：须真 CC）

SDK **没有 300s 时钟**——300s no-real-content 死线是 Claude Code CLI 的行为，`@anthropic-ai/sdk` 层测不了。故 ② 只能用**真实 Claude Code**：

```bash
# 终端 1：起 server，块间静默 310s（> 300s 死线），期间每 15s 发一个 text_delta@0 keepalive
bun run exp/block-level-anchor-coexist/probe.ts --long-idle=310 --serve

# 终端 2：把真实 Claude Code 指向该 server，发任意消息
ANTHROPIC_BASE_URL=http://127.0.0.1:8791 ANTHROPIC_API_KEY=x claude
```

**判据 ②**：真实 Claude Code 在 310s 块间静默期间**保持连接**（无 no-real-content/idle 断连）且渲染出两个真实块。即 `text_delta@0`（而非裸 ping）确实重置了 CC 的 300s 死线（对照 `exp/cc-idle-280s/REPORT.md`：裸 ping 不重置）。

## 三分支后续（决定 Task 6 的 anchor 形状）

| 结果 | Task 6 走向 |
|---|---|
| **两段全 PASS** | **主形状**：anchor@0 全程 open + 真实块@+1（spec §4.3）。块级默认 on。 |
| **第二段 ② FAIL**（客户端拒绝两块并存 open） | **备选**：每块 flush 前 close anchor@0 → flush 该块 → 重开新 anchor@0（多次 open/close index 0）。probe 须加验「index 0 关闭后重开被 SDK 接受 + 每 gap 复位 `anchorAttempted`」。备选更契合单槽 openBlock。 |
| **备选也 FAIL** | **兜底**：Anthropic 保留整响应缓冲（已证形状）作 anchor 端点兜底，块级仅对无 anchor 的 Responses/CC 生效；默认 on = 整响应（非块级）。 |

「默认 on」裁决不被牺牲——主/备/兜底之一实证通过即保「默认启用确定可交付」（spec §4.5）。

## 现状（2026-07-11）

- 第一段：**PASS**（agent 已跑，20/20 确定性）。
- 第二段：**待用户执行**（命令见上）。①自动化子集可先自证 SDK 解析；②真 CC 死线测试须用户手动接真实 Claude Code。
