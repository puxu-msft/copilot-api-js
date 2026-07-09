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

---

## 7. LIVE 路径 pre-response 保活臂（task 7.1，2026-07-09）—— 端到端经代理，**待用户实测**

> **状态：harness 已写、结果待填。** §1-§6 各臂是 **CC ← mock 直连**（测 CC watchdog 认不认某帧型）。本节的臂是 **CC → copilot-api 代理 → mock 上游**（测**代理**在上游全静默时**合成** `empty_text` 前奏能否让 CC 存活 >300s）。对应 spec [2026-07-08-buffered-keepalive-empty-text-anchor](../../docs/spec/2026-07-08-buffered-keepalive-empty-text-anchor.md) §10.8 + ADR [2026-07-09-unconditional-keepalive-timeout-safety](../../docs/decisions/2026-07-09-unconditional-keepalive-timeout-safety.md)。

### 7.1 为什么需要新拓扑（不能复用 §1-§6 的直连 mock）

§1-§6 的 `mock.ts` 由 mock **自己**发 keepalive 帧、CC 直连 mock——证明的是「CC 的 watchdog 认不认这个帧型」，**完全绕过了代理的合成逻辑**。而 incident `req_1783609043247_663`（ADR）的根因是**代理**在 live/delayed-commit 路径、上游**纯 pre-response 静默**（连响应头都没返回）时，本应合成 `empty_text` 前奏却退回裸 ping。要验证修复，必须让**代理**处在被测回路里：

```
real claude (CC)  ──ANTHROPIC_BASE_URL=:4141──▶  copilot-api 代理  ──ghc_api_base_url──▶  mock-upstream.ts（静默）
```

`mock-upstream.ts` 模拟 GHC 上游：`/v1/messages` **持住响应（不发任何头）** `SILENCE_SEC` 秒（默认 330 > CC 的 300s 墙），再返回干净 200 尾（`message_start` + 小 text 块 + `message_stop`）——代理把尾 pump 给 CC 即证 CC 仍在线。另供 `/models`（读 `refs/AVAILABLE_MODELS.json`，代理据此建模型索引）+ `/count_tokens`。

### 7.2 臂设计（三臂，`empty_text` 为门控、其余对照）

| 臂 | 代理 `stream_keepalive_mode` | 预期 CC 结果 | 证明 |
|---|---|---|---|
| **armLive-empty_text**（门控） | `empty_text` | ✅ `is_error=false`、`duration_ms > 300000` | 合成 message_start 前奏 + 空 text_delta **无条件**重置 CC 300s watchdog；上游 330s 后吐尾、CC 收到真实 "ok" 干净收尾 |
| **armLive-ping**（对照） | `ping` | ❌ `is_error=true`、`duration_ms ≈ 300000-320000`、`Stream idle timeout - no chunks received` | 纯裸 ping 压不住 300s no-real-content 墙（复现 incident） |
| **armLive-enveloped_ping**（确认，**非门控**） | `enveloped_ping` | ❌（预期）`is_error=true`、`≈300s` 断 | 合成 message_start 信封 + 裸 ping、无 content block/空 delta → 理论同 `ping` 层撑不住（现有 armP 证据）；仅闭合「message_start 单独是否影响 watchdog」缝隙，不阻塞主线 |

### 7.3 运行指令（用户执行——`no-auto-server`：agent 写 harness、不起代理）

**前提**：用户已 GitHub 认证（代理正常跑生产的凭据即可——Copilot token 交换仍走真实 `api.github.com`，只有 `/v1/messages` + `/models` 数据面被 `ghc_api_base_url` 改道到 mock）。

**每臂三步**（每臂重复；`stream_keepalive_mode` 可热重载、无需重启代理，其余 config 恒定）：

1. **起代理**（终端 A，用户手动——脚本不代劳）。config.yaml 关键项：
   ```yaml
   anthropic:
     protect_streaming_generation: false   # 走 LIVE / delayed-commit（非 buffered）
     stream_commit_after_sec: 20
     stream_keepalive_ping_sec: 20
     stream_keepalive_mode: empty_text      # ← 每臂改此值（empty_text / ping / enveloped_ping）
   timeouts:
     response_header: 900                   # 必须 > SILENCE_SEC（默认 330），否则代理先 abort 上游
     stream_idle: 900
   ```
   启动加 `--ghc-api-base-url http://localhost:8799`（把 GHC 数据面指向 mock）。确认代理监听 :4141。

2. **跑臂**（终端 B——脚本起 mock 上游 + 驱动 headless CC）：
   ```bash
   cd exp/cc-idle-280s
   bash run-proxy-arm.sh armLive-empty_text     empty_text        # 门控，预期 ✅ >300s
   # 改 config.yaml stream_keepalive_mode: ping，等热重载，再：
   bash run-proxy-arm.sh armLive-ping           ping              # 对照，预期 ❌ ~300s
   # 改 config.yaml stream_keepalive_mode: enveloped_ping，再：
   bash run-proxy-arm.sh armLive-enveloped_ping enveloped_ping    # 确认，预期 ❌ ~300s（非门控）
   ```
   脚本读 CC 的 `--output-format json` 出 `is_error` / `duration_ms` / `subtype`，日志落 `armLive-*.cli.log`（CC 裁决）+ `armLive-*.mock-upstream.log`（mock 静默/尾/abort 时刻）。

3. **回填 §7.4 表**（下方 `duration_ms` 待用户填实测值）。

可调环境变量：`SILENCE`（默认 330）、`CC_CEIL`（默认 420，CC 墙钟上限）、`MOCK_UPSTREAM_PORT`（默认 8799）、`PROXY_URL`（默认 http://localhost:4141）、`PROXY_TOKEN`（默认 `copilot-api`）。

### 7.4 结果（**待用户填实测 `duration_ms`**）

| 臂 | `stream_keepalive_mode` | 预期 | 实测 `is_error` | 实测 `duration_ms` | 裁决 |
|---|---|---|---|---|---|
| armLive-empty_text | `empty_text` | ✅ 存活 >300s | _待填_ | _待填_ | _待填_ |
| armLive-ping | `ping` | ❌ ~300-320s 断 | _待填_ | _待填_ | _待填_ |
| armLive-enveloped_ping | `enveloped_ping` | ❌ ~300s 断（非门控） | _待填_ | _待填_ | _待填_ |

**上线门控**：`armLive-empty_text` 的 `is_error=false` 且 `duration_ms > 300000` = 直接证明 ADR §1 的「无条件 timeout-safe」在 live pre-response 路径成立（C1 修复生效）。`armLive-ping` 对照复现 incident。`armLive-enveloped_ping` 仅确认现有 armP 外推（预期断、不阻塞）。

### 7.5 排障提示

- **CC 在 ~300s 就断且是 empty_text 臂** → 检查代理是否真在 live 路径（`protect_streaming_generation: false`）、`stream_keepalive_mode` 是否热重载生效（看代理日志 keepalive 帧型）；查 `armLive-*.mock-upstream.log` 是否记了「proxy ABORTED」（= 代理 timeouts 未抬到 >SILENCE）。
- **mock 日志记「proxy ABORTED at ~300s」** → `timeouts.response_header` / `timeouts.stream_idle` 仍是默认 300，抬到 900。
- **CC 立刻 400/404** → 模型没解析：确认 mock `/models` 返回含 `claude-opus-4.8`（vendor Anthropic + `/v1/messages`）的 `refs/AVAILABLE_MODELS.json`、代理模型索引已建。
- **代理立刻报无 token** → 用户未认证；本实验不改认证路径（Copilot token 仍走真实 GitHub），需先 `copilot-api auth`。
