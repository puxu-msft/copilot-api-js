# CC ~280s 断连实测 — keepalive 帧类型裁决

**日期：** 2026-07-04
**性质：** 实测（受控 mock 上游 + 真实 `claude` CLI **2.1.201** 作 oracle，无需真实 GHC）。
**裁决：** CC 有一个 **300s「无真实内容 chunk」idle 上限**（独立于 60s byte-idle）。`event: ping` 与 SSE comment **都不算 chunk**、无法重置它；**空 `thinking_delta`（零可见内容）算 content chunk、能重置**。用户观测的 ~280s 断 = 这个 300s 上限（最后真实帧@~1s + 观测余量）。

---

## 0. TL;DR

| 臂 | keepalive 帧（每 20s） | CC duration | 结果 |
|---|---|---|---|
| **A: ping** | `event: ping` / `{type:"ping"}`（**当前代理行为**） | **300.2s** | ❌ `API Error: Stream idle timeout - no chunks received` |
| **B: thinkdelta** | `content_block_delta` + **空** `thinking_delta`(`thinking:""`) | 340.4s（窗口末+tail） | ✅ `is_error:false result:"ok"` |
| **C: comment** | 裸 SSE 注释行 `: keepalive` | 300.2s | ❌ `Stream idle timeout - no chunks received` |

- **精确复现用户文案** `Stream idle timeout - no chunks received`（A/C），非推断。
- 断点 **duration_ms=300169 / 300187 ≈ 300s 整** → CC 2.1.201 的「必须在 N 秒内收到真实内容 chunk」硬上限 = **300s**。
- A/C 的 14 个 keepalive 帧**全部到达** CC（mock 逐帧 enqueue、CC 消费 300s 才 timeout）——即 flush 无问题（呼应此前 `curl -N` 实测），**是 CC 的 watchdog 不把 ping/comment 计为 chunk**。
- **B 用零可见内容的空 thinking_delta 保活成功并完整收尾**（含上游真 tail 的 signature_delta + text + message_stop）→ 无害、不破坏最终 block 完整性。

## 1. 根因模型（两层 watchdog）

CC 2.1.201 的流式 watchdog 分两层，缺一不可解释观测：

1. **byte-idle（~60s）**：任意字节到达即重置。ping@20s 压住了这一层——所以流能撑到 300s 而非 60s 就断。
2. **no-real-content（300s）**：只有**真实 content chunk**（`content_block_delta`）重置；`event: ping` 与 SSE comment **不算**。纯 keepalive 到 300s → `no chunks received`。

报错文案 **`no chunks received`** 是字面精确的——指「没收到真实内容 chunk」，keepalive 不满足。

## 2. 与 2026-06-22 q2-oracle 报告（2.1.185「ping 有效」）的调和

q2 报告 §3.1 的保活测试全是 `ping@30s **+ tail**`，tail（真实内容）在 180~227s（**均 < 300s**）就出现，从未测过 >227s 纯 ping。那报告验证的「ping 重置」是**第一层 60s byte-idle**；**第二层 300s 上限没被覆盖**。本实测把纯 keepalive 拉到 300s+ 才暴露它。两报告不矛盾，是覆盖区间不同。

## 3. 结论对代理的影响

- 代理当前的 `stream_keepalive_ping_sec`（发 `event: ping`）对 **opus 长 thinking 静默 >300s** 的请求**无效**——正是用户的场景（pre-content thinking 沉默几百秒）。
- 修复方向：keepalive 帧从 `ping` 改为**对客户端无害的空 content delta**（当前 open block 是 thinking → 空 `thinking_delta`；是 text → 空 `text_delta`），需 **block-状态感知**（固定帧会在错误的 block 状态下违反协议）。
- 仅作用于 forwarded 轨（`inboundResponse.sseEvents`），绝不进上游 `sseEvents` 轨。

## 4. 复现

```bash
cd exp/cc-idle-280s
INTERVAL=20 WINDOW=340 CC_CEIL=400 bash run-arm.sh armA-ping    ping       8795   # ❌ 300s 断
INTERVAL=20 WINDOW=340 CC_CEIL=400 bash run-arm.sh armB-thinkdelta thinkdelta 8791 # ✅ 存活
INTERVAL=20 WINDOW=340 CC_CEIL=400 bash run-arm.sh armC-comment comment    8792   # ❌ 300s 断
```

产物：`exp/cc-idle-280s/*.mock.log`（mock 逐帧时间戳 + client abort 时刻）、`*.cli.log`（CC json result）。
mock：`mock.ts`（`idle:TYPE:N:M` 模式，first-party watchdog 经 `run-arm.sh` 的 `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`）。

## 5. 未覆盖 / 后续

- 只测了 first-party watchdog 路径（`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`）。用户真实接线是经代理（custom URL + token）；报告 §3.1 表明两路径 byte-idle 一致，但 300s 上限的 prod-faithful 复测未做（预期一致）。
- 空 **text_delta**（text block 场景）未单测，仅测了空 thinking_delta；同为 `content_block_delta`，预期同样有效，实现时应补测。
- CC 2.1.201 特定值 300s 可能随 CC 版本变动——keepalive cadence 应保守（如 ≤200s）留余量。

---

## 6. Phase 0 补实测 —— 覆盖矩阵定稿（2026-07-04，全 GO）

对抗审查暴露的 oracle 缺口（空 text_delta / 空 input_json_delta / prod-faithful 300s）已补齐四臂，**全部 GO**：

| 臂 | open block + keepalive（每 20s） | 接线 | CC 结果 |
|---|---|---|---|
| armT | **text** block + 空 `text_delta{text:""}` | first-party | ✅ 存活 340s + tail，`is_error=false duration_ms=340468 stop_reason=end_turn` |
| armJ | **tool_use** block + 空 `input_json_delta{partial_json:""}` | first-party | ✅ keepalive 窗口 **CC survived 340s**（`WITHOUT abort`）；@343s CC 收 tool_use tail 后发起第二轮 tool-处理请求，@403s 那次 abort 与 keepalive 无关 |
| armP | **thinking** block + `ping` | **prod-faithful**（custom URL + token，用户真实接线） | ❌ **300s 断** `no chunks received`（`duration_ms=300186`）——**300s 上限非 first-party 特有** |
| armPT | **thinking** block + 空 `thinking_delta` | **prod-faithful** | ✅ 存活 340s + tail，`is_error=false duration_ms=340428`——content_delta 在真实接线也有效 |

### 覆盖矩阵（定稿，实现据此）

| 当前 open block type | keepalive 帧 | 实测证据 |
|---|---|---|
| `thinking` | 空 `thinking_delta{thinking:""}` | ✅ armB / armPT |
| `text` | 空 `text_delta{text:""}` | ✅ armT |
| `tool_use` / `server_tool_use` | 空 `input_json_delta{partial_json:""}` | ✅ armJ（server_tool 同为 tool_use 帧形态，推断同效；保守可 fallback） |
| 无 open block / `redacted_thinking` / 未知 | fallback `ping` | 块间短窗口 + pre-content 延迟-commit(<300s) + 罕见，可接受 |

**prod-faithful 确认**：300s no-content 上限在用户真实接线（非 first-party）下**一致**，content_delta 修复在该路径同样有效。60s→300s 跨层外推的疑虑消除。

### web_search 架构结论（读码）

两条子路径，方案分治：
- **no-search direct re-dispatch**（`web-search-direct.ts:handleDirectAnthropicStreamingResponse`，常见）：真实流式、有 open block（thinking 静默）。keepalive 走 legacy `startForwardedSseHeartbeat`（`streaming-pump.ts:360`，硬编码 ping @389-399）。方案：tick 据 block 状态选帧，但 `streamState.currentBlockType` 是**上游侧、无 index**，server-tool-filter 下 forwarded index 会偏——须在 forwarded 写出点（`processOneStreamEvent`/`forwardToClient`）维护 forwarded-side openBlock{index,type}。
- **search 合成**（`web-search-handler.ts:131` `completeWebSearch` 阻塞期）：**无 open block**（仅 upfront ping 发过，真实 events 在阻塞返回后才发）。content_delta 不适用。方案：`completeWebSearch` 前 flush 一个**占位 block**（thinking 或 text，空 delta 保活）+ 完成后 stop 占位、真实 events index 顺延（remap +1）。占位 block keepalive 有效性 = armB/armPT 已证；占位可见性 Phase 3 实测确认。

**结论**：覆盖 thinking/text/tool_use 三种 open block 的空 delta 全部实测有效，无「fallback-会-断」的常见场景残留；web_search 两路径方案明确，Phase 3 实现。
