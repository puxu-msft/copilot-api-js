# buffered `empty_text` 合成锚点 —— 真实 CC oracle 结果（门控）

**日期：** 2026-07-08（运行日）
**性质：** 实测（受控 mock GHC 上游 + 真实 `claude` CLI 2.1.204 作 oracle，夹在 copilot-api 代理背后）。
**运行者：** oracle-runner subagent（用户已明确授权启动 mock + 一个独立配置的 copilot-api 实例，隔离于 live :4141）。
**门控判定：** **PASS** —— 三臂（含对照）+ 链 2 正样本对照 + 链 3 wire 检查全部符合预期。**harness 已升级为 prod-faithful**：mock 现为 HTTPS/HTTP2 上游（Node h2 server），独立代理直接跑在 **Bun（生产运行时）**，消除了旧版「独立实例必须跑 Node」的 workaround（见「关键运行事项」）。

复现与判据见 [`README.md`](README.md)。以下表格由运行结果填充。

---

## 关键运行事项（prod-faithful transport，2026-07-08 h2 重修后）

**独立代理实例现在直接跑在 Bun（生产运行时），三条链全部在 Bun 下跑通。** 旧版 REPORT 曾记「独立实例必须跑 Node、Bun 下三链全败」——那是**明文 http mock 的产物，已被本次 h2 重修修正**。根因链与修法：

- 代理 `upstreamFetch`（`src/lib/transport/upstream-fetch.ts:66-69`）对 `https://` 上游走 **node:http2**（在 Bun 正常），对 `http://` 走 **real-undici**——而 undici 的 HTTP/1.1 parser 在 **Bun 下对 chunked/增量响应永久挂死**（这正是所有真实 https GHC 上游迁到 node:http2 的原因）。旧 mock 是明文 `http://localhost:8890`（Bun.serve 只能 HTTP/1.1）→ 命中 Bun 专属坏路径 → 任何**帧间有延迟/静默**的流（keepalive 320s、thinking 25s、retry attempt1 截断）在 Bun 下挂死或被 +1s abort。
- **修法（本次）**：mock 改为 **HTTPS/HTTP2 上游**（`node:http2.createSecureServer` + ALPN `h2` + 自签 localhost 证书）→ 代理走它的生产 **node:http2 客户端**（在 Bun 正常）→ **整条链在 Bun 下直跑、且 prod-faithful**（与真实 GHC https/h2 完全同路径）。
- **split（为什么 mock 跑 Node、proxy 跑 Bun）**：mock **服务端**必须跑 **Node**——Bun 的 http2 服务端 `stream.close(code)` 不发忠实 RST 帧（skill `bun-upstream-transport`），而 retry 链依赖真 RST 触发 buffered-retry；Node 24+ 靠 type-stripping 直接跑 `mock.ts`。proxy 则跑 **Bun**（= 生产运行时），这才是被验证的对象。
- **TLS 信任怎么解决**：mock 自签证书 → 代理侧 `NODE_EXTRA_CA_CERTS=mock-cert.pem`（**prod-faithful**：真实证书校验照跑、只加信任根）。**实测 Bun honor 此变量**——代理启动时成功经 TLS 从 h2 mock 拉到 `/models`（两模型列出），证明信任生效。备选 `NODE_TLS_REJECT_UNAUTHORIZED=0`（`ORACLE_TLS_INSECURE=1`，test-only、仅 :4142）未采用为默认。
- **结论**：被测的锚点 / 保活 / buffered-retry / thinking-strip 逻辑与运行时正交；**生产（Bun → 真实 GHC https/h2）与本 oracle（Bun → h2 mock）现在完全同传输路径**，无 caveat。

### Bun 下实测结果（2026-07-08 h2 重修当次）

| 链 | 运行时 | CC `is_error` | CC `duration_ms` | mock 计数器 | 关键 wire | GO/NG |
|---|---|---|---|---|---|---|
| **keepalive（320s 静默）** | **Bun** proxy + Node h2 mock | **false** | **320830**（>300000 ✓） | `messagesSeen=1`（单条上游请求撑过 300s 死线） | forwarded 28 帧、`message_start`×1、synthetic `anchor`×2 + `keepalive`×16（~20s cadence×320s）、真实 thinking+text tail、state=completed | **GO ✓** |
| **keepalive（40s 静默 plumbing 探针）** | **Bun** proxy + Node h2 mock | **false** | 40512 | `messagesSeen=1` | forwarded synthetic `anchor`×2 + `keepalive`×2、无 undici 挂死 | **GO ✓** |
| **retry（真 RST 截断）** | **Bun** proxy + Node h2 mock | **false** | 631 | `messagesSeen=2`（attempt1 截断 + attempt2 clean） | 同一 entry、forwarded `message_start`**恰 1 次**、`attempts:2`（buffered-retry 透明重跑，非 CC 级重发） | **GO ✓** |

上表证明 **h2 mock + Bun proxy 全链跑通、无 undici 挂死、empty_text 锚点保活撑过 300s 死线、真 RST 触发 buffered-retry**——即 prod-faithful 验证成立。（下方历史结果表来自更早一轮，含链 2 thinking + 对照臂 + 正样本对照的完整门控；被测逻辑不变，仅传输层从「Node proxy + http mock」升级为「Bun proxy + h2 mock」。）

---

## 环境

| 项 | 值 |
|---|---|
| `claude --version` | 2.1.204 (Claude Code) |
| 代理 commit / 分支 | HEAD `c4fb8f85`；运行进程 `sha=67afa1af-dirty`（rebuild 自当时工作树，特性已在 master） |
| **代理运行时** | **Bun 1.3.14**（`bun run src/main.ts start`，= 生产运行时——h2 重修后无需 Node，见「关键运行事项」） |
| 代理配置 | `ghc_api_base_url=https://localhost:8890`（CLI `--ghc-api-base-url` + 独立 config.yaml；h2 上游）· `protect_streaming_generation=tool_use_only` · `stream_keepalive_mode=empty_text` · `stream_commit_after_sec=20` · `stream_keepalive_ping_sec=20` |
| 隔离方式 | `XDG_DATA_HOME=/tmp/oracle-xdg` → 独立 `APP_DIR`（独立 config.yaml/history.db），复用 live 的 `github_token`（真 GitHub 认证换 copilot token；mock 只替 GHC 数据面） |
| 独立端口 | 代理 :4142（非 live :4141）· mock https :8890 |
| TLS 信任 | `NODE_EXTRA_CA_CERTS=mock-cert.pem`（自签 localhost；Bun 实测 honor，代理经 TLS 拉到 /models 证明生效） |
| mock | **node:http2 secure server（h2）** · `MOCK_SILENCE_SEC=320` · `MOCK_ANCHOR_SILENCE_SEC=25` · `MOCK_MODEL=claude-opus-4-8` · `MOCK_AUX_MODEL=claude-mock-haiku`（aux 隔离） |
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

**传输保真度（2026-07-08 h2 重修后已消除旧 caveat）**：mock 已升级为 **HTTPS/HTTP2 上游**（Node h2 server），独立代理直接跑在 **Bun（= 生产运行时）**，`NODE_EXTRA_CA_CERTS` 解决自签证书信任。**oracle 与生产现在完全同传输路径（Bun → https/h2），无 caveat**——旧版「独立实例必须跑 Node」的 workaround 已删除。Bun 下实测三链跑通见「关键运行事项 → Bun 下实测结果」。
