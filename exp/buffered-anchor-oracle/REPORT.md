# buffered `empty_text` 合成锚点 —— 真实 CC oracle 结果（门控）

**日期：** 2026-07-08（运行日）
**性质：** 实测（受控 mock GHC 上游 + 真实 `claude` CLI 2.1.204 作 oracle，夹在 copilot-api 代理背后）。
**运行者：** oracle-runner subagent（用户已明确授权启动 mock + 一个独立配置的 copilot-api 实例，隔离于 live :4141）。
**门控判定：** **PASS** —— 三臂（含对照）+ 链 2 正样本对照 + 链 3 wire 检查全部符合预期。附一条**运行期传输保真度** caveat（须让独立实例跑在 Node，不能跑 Bun；见「关键运行事项」），与被测特性逻辑正交、不阻断上线。

复现与判据见 [`README.md`](README.md)。以下表格由运行结果填充。

---

## 关键运行事项（transport-fidelity caveat，必读）

**独立代理实例必须在 Node 下运行，不能在 Bun 下运行**，否则**三条链全部失败**（与被测特性无关）。根因：

- 代理 `upstreamFetch`（`src/lib/transport/upstream-fetch.ts:62-68`）对 `https://` 上游走 HTTP/2，对 **plaintext `http://` 上游走 real-undici**。注释明确记载「undici's HTTP/1.1 parser hangs forever under Bun on chunked responses」——这正是所有真实 https GHC 上游迁到 HTTP/2 的原因。本 mock 是 plaintext `http://localhost:8890`（Bun.serve 只能 HTTP/1.1），故命中那条 Bun 专属坏路径。
- **实测（Bun 下运行代理）**：唯一读通的是「同步一次性 flush 的完整流」（retry attempt2，75ms 抽干）；任何**帧间有延迟/静默**的流（keepalive 320s、thinking 25s、retry attempt1 截断）都在 **+1s 处被代理 abort 上游**或**挂死 320s**，随后退化成 **CC 自身在 ~300s 死线后重发**（History 出现两条独立 client entry、`messagesSeen` 虚增）。
- **探针逐层定位**：Node 的 undici（全局 fetch）读 **Bun.serve 增量流**干净抽干（3064ms）→ 挂死纯属 **Bun-as-undici-client** 的 HTTP/1.1 增量 chunked 缺陷。
- **结论**：被测的锚点 / 保活 / buffered-retry / thinking-strip **逻辑与运行时正交**；生产（live :4141，Bun → 真实 GHC https/HTTP/2）不受影响。把独立实例切到 **Node**（`node dist/main.mjs`，rebuild 自 HEAD）后，三条链全部跑通。
- **给 harness 作者的建议（记录，未采纳为默认）**：若要在 Bun 下直跑，需把 mock 改为 **HTTP/2 上游**（`node:http2` secure server + 自签证书 + 代理侧 `NODE_TLS_REJECT_UNAUTHORIZED=0`），因 Bun.serve 仅 HTTP/1.1、无法提供 h2。本次采用「代理跑 Node」作等效、更省的解绑。

---

## 环境

| 项 | 值 |
|---|---|
| `claude --version` | 2.1.204 (Claude Code) |
| 代理 commit / 分支 | HEAD `c4fb8f85`；运行进程 `sha=67afa1af-dirty`（rebuild 自当时工作树，特性已在 master） |
| **代理运行时** | **Node v24.16.0**（`node dist/main.mjs`，非 Bun——见「关键运行事项」） |
| 代理配置 | `ghc_api_base_url=http://localhost:8890`（CLI `--ghc-api-base-url` + 独立 config.yaml）· `protect_streaming_generation=tool_use_only` · `stream_keepalive_mode=empty_text` · `stream_commit_after_sec=20` · `stream_keepalive_ping_sec=20`（`/api/config` 已核对） |
| 隔离方式 | `XDG_DATA_HOME=/tmp/oracle-xdg` → 独立 `APP_DIR`（独立 config.yaml/history.db），复用 live 的 `github_token`（真 GitHub 认证换 copilot token；mock 只替 GHC 数据面） |
| 独立端口 | 代理 :4142（非 live :4141）· mock :8890 |
| mock | `MOCK_SILENCE_SEC=320` · `MOCK_ANCHOR_SILENCE_SEC=25` · `MOCK_MODEL=claude-opus-4-8` · `MOCK_AUX_MODEL=claude-mock-haiku`（aux 隔离） |
| mock 修正 | `modelEntry.vendor` 由 `"anthropic"` 改为 **`"Anthropic"`**（代理 `supportsDirectAnthropicApi` 精确匹配 `vendor==="Anthropic"`，`features.ts:40`；否则首个请求即 400。harness 保真度修复） |

## 结果

| 链 | mode | CC `is_error` | CC `duration_ms` | CC `num_turns` | mock 计数器 | 判据 | GO/NG |
|---|---|---|---|---|---|---|---|
| **1 保活** | `stream_keepalive_mode=empty_text` | **false** | **320834**（>300000 ✓） | 1 | `messagesSeen=1` · `validationRejections=0` | `is_error=false` 且 `duration_ms>300000`（单条上游请求撑过 300s 死线、收到 mock tail） | **GO ✓** |
| **1 对照** | `stream_keepalive_mode=content_delta` | (killed rc=124) | 未完成（CC ~300s 死线内部重发） | — | `messagesSeen=2`（mock req#2 恰在 req#1 **+300.00s**） | 预期 **NG**：content_delta 裸 ping 不重置 300s 死线 → CC 在 300s 处重发、单条请求撑不到 320s tail | **NG（符合预期）✓** |
| **2 thinking-首块（端到端）** | `empty_text` | **false** | 28524 | **2**（走了 tool 回合） | `validationRejections=0` · `auxRequestsSeen=0` | `is_error=false` 且 mock `validationRejections==0`（**端到端不 400 = 生产安全**） | **GO ✓** |
| **2 正样本对照（`replay-turn2.sh`）** | `empty_text` | — | — | — | `messagesSeen=1` 且 `validationRejections=0` | 脚本 **PASS**（严格归因：代理 `filterEmptyAnthropicTextBlocks` 在剥，非 CC） | **GO ✓** |
| **3 retry 透明** | `empty_text` | **false** | 643 | 1 | `messagesSeen=2` | `complete-generation` + History `message_start` **恰 1 次** + 恰 **2 个 attempt**（同一 entry：attempt1 截断 + attempt2 成功）+ 无中途 error 帧 | **GO ✓** |

## 关键 wire 观测（History API / forwarded 轨）

- **链 1**（empty_text，entry `req_1783541345727_5`，state=completed）：forwarded 共 28 帧 —— `message_start`×1 → `content_block_start`(**synthetic=`anchor`**)×1 → 空 `content_block_delta`(**synthetic=`keepalive`**)×**16**（~20s cadence × 320s）→ `content_block_stop`(**synthetic=`anchor`**)×1（commit 收口）→ 真实块（thinking + text answer，在锚点 index+1）→ `message_delta` + `message_stop`。**`message_start` 恰 1 次**。完全符合 spec §3.6 预期收口形状。
- **链 2 正样本对照**（`replay-turn2.sh`）：VERDICT=**PASS** —— 直接把 `[空text, thinking, tool_use, tool_result]` turn-2 体绕过 CC POST 到代理，代理 200，mock `messagesSeen=1` 且 `validationRejections=0` → 代理剥掉前导空 text 锚点、thinking 复位首块、mock 未 400。严格隔离出是**代理**（`filterEmptyAnthropicTextBlocks`）在剥，非 CC。
- **链 3**（entry `req_1783541257531_1`，state=completed，**门控必需**）：`clientResponse.sseEvents` = 6 帧，`message_start` **恰 1 次**，无双 `message_start`，无中途 `error` 帧，单一 content block（start/delta/stop）+ `message_delta` + `message_stop`。`attempts[]` = **2**（attempt[0] 截断失败 + attempt[1] `success=True`），**同一 entry**（req id base 一致）→ 代理侧 buffered-retry 透明重跑（非 CC 级重发；对照 Bun 下坏行为=两条独立 entry、间隔 320s）。

## CC json 摘录

```
# 链 1（keepalive.cli.log，empty_text）
is_error=false  duration_ms=320834  num_turns=1  subtype=success  result=ok

# 链 1 对照（keepalive-content_delta.cli.log）
rc=124（被 380s ceiling kill）——CC 未产出终态 json：content_delta 下 CC 在 ~300s 死线重发
（mock req#2 恰在 req#1 +300.00s），单条请求撑不到 320s tail。messagesSeen=2。

# 链 2（thinking.cli.log）
is_error=false  duration_ms=28524  num_turns=2  subtype=success  result=done   （validationRejections=0）

# 链 2 正样本对照（replay-turn2.response.log + 脚本 VERDICT）
proxy HTTP 200；mock messagesSeen=1 validationRejections=0；VERDICT=PASS（proxy stripped the leading empty-text anchor）

# 链 3（retry.cli.log）
is_error=false  duration_ms=643  num_turns=1  subtype=success  result=complete-generation   （messagesSeen=2）
```

## mock 日志摘录（关键相位 + 400/RST）

```
# 链 1 empty_text（GO）——单条请求撑过 320s：
POST /v1/messages chain=keepalive req#1 ... assistantThinking=false
   keepalive: sent message_start + thinking content_block_start; now SILENT for 320s
-> keepalive: 320s silence elapsed WITHOUT abort — proxy kept CC alive; sending thinking tail
-> keepalive: tail sent, stream closed          （messagesSeen=1）

# 链 1 content_delta（NG，符合预期）——CC 恰在 300s 死线重发：
POST /v1/messages chain=keepalive req#1 ...   （20:15:15）
POST /v1/messages chain=keepalive req#2 ...   （20:20:15 = req#1 +300.00s；content_delta 裸 ping 未重置死线）
<- keepalive: client(proxy) ABORTED during silence   （req#1 被 CC 断开）

# 链 2 thinking（GO）——turn1 anchor 静默 25s + tool_use tail + turn2 200，全程 validationRejections=0：
POST req#1 ... turn1: message_start; SILENT 25s so proxy injects an anchor
-> thinking turn1: sending REAL thinking@0 + tool_use@1, stop_reason:tool_use
POST req#2 ... turn2: clean text answer sent (inbound passed thinking-first validation)   （validationRejections=0）

# 链 3 retry（GO）——attempt1 截断 + attempt2 clean，代理 buffered-retry 透明重跑：
POST req#1 ... retry attempt1: sent message_start + partial text, now ABORTING mid-stream (truncation)
POST req#2 ... retry attempt2: full clean generation sent, stream closed   （messagesSeen=2，同一 client entry 内 2 attempts）
```

## 门控结论

**三臂（保活 GO / 对照 NG / thinking GO）+ 链 2 正样本对照 PASS + 链 3 wire 单 `message_start` + 2 attempts 同 entry —— 全部符合预期 → 门控通过（PASS）。**

- **链 1 保活 GO**：empty_text 合成锚点（`content_block_start{text}` synthetic:anchor + 空 `text_delta` synthetic:keepalive ×16 + commit 时 `content_block_stop@0`）使 CC 单条请求撑过 300s 死线（duration 320834ms）、收到 tail、`is_error=false`。
- **链 1 对照 NG（符合预期）**：content_delta 在 buffered 无 open block 时退回裸 ping，**不重置** CC 的 300s 死线——CC 恰在 +300.00s 重发（`messagesSeen=2`），证明**锚点的空 text_delta 是重置死线的唯一有效手段**（empty_text 独有效力）。
- **链 2 thinking GO + 正样本对照 PASS**：端到端不 400（`validationRejections=0`，生产安全）；`replay-turn2.sh` 绕过 CC 严格归因——代理 `filterEmptyAnthropicTextBlocks` 确实剥离前导空 text 锚点、thinking 复位首块。
- **链 3 retry GO**：buffered-retry 对上游 mid-stream 截断透明重跑，CC 只见一次完整生成（`complete-generation`），wire 上 `message_start` 恰 1 次、同一 entry 恰 2 个 attempt、无双 message_start、无中途 error 帧。

**唯一 caveat（不阻断上线）**：本 oracle 的**测试管线**在 Bun 下因 plaintext-http 上游的 undici HTTP/1.1 缺陷不可用，须让独立实例跑在 Node（详见「关键运行事项」）。此为 harness 传输保真度问题，与被测特性逻辑正交；生产 Bun + https/HTTP/2 路径不受影响。建议 harness 作者后续把 mock 升级为 h2 上游以便 Bun 下直跑。
