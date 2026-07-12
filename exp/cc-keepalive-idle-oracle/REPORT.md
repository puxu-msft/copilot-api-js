# Chat Completions keepalive M-2 实证 oracle — 结果骨架（待用户填 armPing/armSilent 经真代理的实测行）

**性质：** harness 已写、经代理的两臂结果待用户运行填入（no-auto-server：agent 写 harness、不起代理）。**§0 的机制验证已由本任务亲手实测确认**（无代理，直连 mock，用同一 SDK/Node 默认值），是本 harness 存在的实证地基；§4 表格仍需用户跑经真实代理的两臂拿最终裁决。

**红线 R4：** Task 4（翻 `chat_completions.buffered_retry` 默认为 `true`）**必须**在本 oracle **armPing 通过之后**才能进行。绝不先翻默认再验证。

对应 spec `docs/plan/2026-07-11-block-level-buffered-retry/plan-3-chat-completions.md` §Task 3、spec §7.1/§11 M-2。

---

## 0. 为什么这个门比 Responses 的更承重（且机制已亲手实测，非仅文档推断）

Chat Completions **没有中途块边界**——`ccCommitBoundaries`（`src/lib/openai/cc-commit-boundaries.ts`）是**终止-only**谓词：只有一个上游 `error` 帧算边界，普通内容 delta 一律不算。真正的终止提交靠 handler 的 `sawMessageStop = () => acc.finishReason !== ""`。这意味着 buffered 模式下**整个生成过程**（不只是首块前）都被完整缓冲，直到 `finish_reason` 落地——比 Responses 的「首个 `output_item.done` 前」缓冲窗口更宽。因此 CC 的 keepalive 门比 Responses 更承重：只要生成期间有任何超过消费者 idle 死线的静默，都完全依赖这个心跳 chunk。

**Chat Completions 没有像 Codex 之于 Responses 那样的单一主导 CLI 客户端**——spec §7.1 M-2 明确要求「须独立 oracle 实证」而非盲目复用 sibling 的 Codex CLI。本 harness 选择项目自身依赖的 `openai`（Node SDK，`package.json:110` 锁定 `^6.45.0`）**不加任何自定义 timeout/dispatcher**——即真实 CC 消费者会遇到的**开箱默认行为**，比虚构一个假想客户端更有代表性（也是本仓库反向代理调用 GHC 时用的同一个包，见 `src/lib/openai/chat-completions-client.ts`）。

**本任务已亲手实测确认的机制**（构建本 harness 期间的探针，不经过代理，直连一个本地 Node HTTP 服务器）：
- Node 的全局 `fetch`（底层 undici）对每个请求应用**默认** body-idle 超时：`node_modules/undici/lib/dispatcher/client.js:261` `this[kBodyTimeout] = bodyTimeout != null ? bodyTimeout : 300e3`（**300 秒**），由 `client-h1.js:614-620`（收到响应头后设置该 timeout）+ `client-h1.js:687-700`（`onBody` 每收到一个 body chunk 就 `timeout.refresh()`）落实——**任何**到达的 body 字节（包括一个空 delta 的 SSE chunk）都会重置这个 300 秒计时器，一个纯 SSE 注释帧则不会触发 `onBody`（无法验证但符合 `eventsource-parser`/SDK 装饰器不解析裸注释的一致行为，参见 sibling harness 对 Responses 侧的同类论证）。
- **实测两臂**（两个并发请求打向一个本地 Node `http` 服务器，`armSilent` 全程零 body 字节、`armPing` 每 15 秒发一个 `{"choices":[{"delta":{},"index":0,"finish_reason":null}]}` 空 delta chunk，两臂都在 320 秒后吐尾）：
  - `armSilent`：`ERROR at +300.8s: TypeError: terminated` —— **精确命中** undici 默认 300 秒 body-idle 墙，无任何 keepalive 时消费者必断连。
  - `armPing`：跨越 300 秒边界（`chunk#... at +300.1s`、`+315.1s`）**未断连**，收到 `+320.1s` 处的完整尾帧，`STREAM COMPLETE`。
  - 这就是本 harness §4 表格「预期」列的依据——不是文档推断，是本任务亲手测量的、无代理参与的最小复现。

**下一步（§4，待用户跑）**：把同样的两臂**经真实代理**（`chat_completions.buffered_retry: true`，代理注入 `ccKeepaliveFrame()`）跑一遍，验证代理层确实产出同等效果的 keepalive chunk、且不破坏正常生成的完整性。

## 1. 拓扑

```
openai-node client (oracle-client.mjs，无自定义 timeout/dispatcher)
  ──/v1/chat/completions（流式）──▶  copilot-api PROXY（chat_completions.buffered_retry: true）
  ──ghc_api_base_url（https/h2）──▶  mock-upstream.ts（silent-then-tail，:8798）
```

被测的 `ccKeepaliveFrame()` 心跳注入 + buffered 提交逻辑全在**代理**这一层；mock 只复现上游形状（立即吐一个内容 delta chunk，然后纯静默 `SILENCE_SEC` 秒，最后吐一个干净的 `finish_reason:"stop"` 终止 chunk + `[DONE]`）。

### 1.1 传输：mock = HTTPS/HTTP2（Node），proxy = Bun（生产同款）

本 harness 的 mock **必须是 HTTPS/h2**（不是明文 `http://`），沿用 sibling harness `exp/responses-keepalive-idle-oracle/` **已实测确认**的同一传输缺陷（不是重新发现，是复用其结论）：

- 代理的 `upstreamFetch`（`src/lib/transport/upstream-fetch.ts:66-69`）对 `https://` 上游走**生产 node:http2 客户端**（在 Bun 下正常），对 `http://` 上游走 **undici**——而 undici 在 Bun 下对增量/静默-then-尾这种 SSE 流有已知缺陷（sibling harness 实测：明文 mock 让代理的上游 fetch 在收到响应头后 ~5ms 就 ABORT，而非撑过静默窗口）。
- **修复**：mock 用 `node:http2.createSecureServer`（自签 localhost 证书，ALPN `h2`），代理的 `ghc_api_base_url` 指向 `https://localhost:8798`，走生产 node:http2 客户端。
- mock 本身跑在 **Node**（不是 Bun）——同 sibling 约定：Node 24+ 靠 type-stripping 直接跑 `.ts`，无需构建。本 harness 不需要真实 h2 RST（只测 keepalive，不测 retry），mock 的运行时不是承重项。

## 2. 臂设计（两臂，`ccKeepaliveFrame` 为门控、对照 = 无 heartbeat）

| 臂 | 代理 heartbeat | 预期 openai-node 客户端结果 | 证明 |
|---|---|---|---|
| **armPing**（门控） | `ccKeepaliveFrame()` @15s（buffered 强制，`chat_completions.buffered_retry.heartbeat_sec` 落到共享默认 15，或 `anthropic.stream_keepalive_ping_sec` 设 15 时优先取其值——见 `resolveCcBufferedAndHeartbeat`） | `is_error=false`、`duration_ms > 300000`、干净收到 `finish_reason:"stop"` 终止 chunk | 空 delta chunk 无条件重置 undici 300s body-idle 墙（§0 已本地实测）；上游 330s 后吐尾，消费者干净收全 |
| **armSilent**（对照） | heartbeat 强制关闭（`anthropic.stream_keepalive_ping_sec: 0` **且** `chat_completions.buffered_retry.heartbeat_sec: 0`，见 oracle-config.yaml 注释块） | `is_error=true`（在约 300s 处 `TypeError: terminated`） | 无保活 → 复现 idle-out，反证 armPing 的保活是承重的 |

> **oracle 选择**：本 harness 用项目自身依赖的**真实 `openai` Node SDK**（`oracle-client.mjs`，无自定义 `timeout`/`fetchOptions.dispatcher`——即 SDK + Node 的开箱默认行为）。CC 没有像 Codex 之于 Responses 那样的单一主导 CLI，SDK 本身（真实 CC 客户端构建于其上的解码器）是比虚构假想客户端更直接的 oracle；且其 300s 默认 body-idle 墙已在 §0 本地实测验证，是明确、可复现的判据。

## 3. 上线门控判据

- **armPing** `is_error=false` **且** `duration_ms > 300000`（撑过约 300s 的 undici 默认墙，收到 mock 的完整终止 chunk + `[DONE]`）→ **M-2 通过** → 允许 Task 4 把 `chat_completions.buffered_retry` 默认翻为 `true`。
- **armSilent** 复现 idle-out（`is_error=true`，`duration_ms` 落在约 300000ms 附近）→ 反证：没有 heartbeat 时消费者确实会在 ~300s 处断连，证明 armPing 的存活不是巧合。
- 若 armPing **失败**或 armSilent **也存活**（两臂结果无法区分）→ oracle 不确定，M-2 未通过 → **不翻默认**，Task 4 降级为「保持 opt-in，文档记 M-2 未通过」（spec §4.5/§11 三级 fallback 的精神：不牺牲安全换默认开）。

## 4. 结果（**待用户填** —— 经真实代理的两臂）

| 臂 | `anthropic.stream_keepalive_ping_sec` | `chat_completions.buffered_retry.heartbeat_sec` | 预期 | 实测 `is_error` | 实测 `duration_ms` | oracle-client 摘要 | 裁决 |
|---|---|---|---|---|---|---|---|
| armPing | 15 | (fallback, N/A) | `is_error=false`、`duration_ms>300000` | _待填_ | _待填_ | _待填_ | _待填_ |
| armSilent | 0 | 0 | `is_error=true`、`duration_ms≈300000` | _待填_ | _待填_ | _待填_ | _待填_ |

**门控判定：** _待填_（PASS / FAIL / 不确定）

**§0 本地实测（无代理、已由本任务完成，作为上表的机制地基对照）：**

| 臂 | 心跳 | `is_error` | `duration_ms` | 备注 |
|---|---|---|---|---|
| armSilent（本地，无代理） | 无 | `true` | `300843`（`TypeError: terminated`） | 精确命中 undici 默认 300s body-idle 墙 |
| armPing（本地，无代理） | 每 15s 空 delta chunk | `false` | `320143` | 跨越 300s 边界未断连，收到 320.1s 处的完整尾帧 |

## 5. 运行指令（用户执行 — `no-auto-server`：agent 写 harness、不起代理）

**前提**：
- 本机已装 **Node 22.6+/24**（跑 mock，靠 type-stripping 直接执行 `.ts`；也跑 `oracle-client.mjs`，用本仓库 `node_modules/openai`） + **Bun**（跑代理，生产运行时）。
- 代理有可用的 GitHub 认证（mock 忽略上游 token，但代理启动仍要拿 copilot token；可复用你 live 实例的 `github_token`，见下方 `XDG_DATA_HOME` 隔离）。

### 5.1 armPing（门控臂）

```bash
cd exp/cc-keepalive-idle-oracle

# 1) 准备一个隔离的 XDG_DATA_HOME（不要用真实 ~/.local/share/copilot-api，避免污染 live :4141 的 history/config）：
export ORACLE_XDG=/tmp/oracle-cc-xdg
mkdir -p "$ORACLE_XDG/copilot-api"
cp ~/.local/share/copilot-api/github_token "$ORACLE_XDG/copilot-api/github_token"
chmod 600 "$ORACLE_XDG/copilot-api/github_token"
cp oracle-config.yaml "$ORACLE_XDG/copilot-api/config.yaml"   # armPing 用默认值（不改任何注释块）

# 2) 起代理（终端 A，非 :4141，指向 mock，信任其自签证书）：
cd <repo-root>
XDG_DATA_HOME="$ORACLE_XDG" NODE_EXTRA_CA_CERTS=exp/cc-keepalive-idle-oracle/mock-cert.pem \
  bun run src/main.ts start --port 4143 --ghc-api-base-url https://localhost:8798 --no-rate-limit

# 3) 跑臂（终端 B — 脚本起 mock + 驱动一次 openai-node 流式请求经代理）：
cd exp/cc-keepalive-idle-oracle
PROXY_URL=http://localhost:4143 bash run-proxy-arm.sh armPing 330
```

`run-proxy-arm.sh` 会：生成/复用自签证书 → 起 mock（`silent:330`，静默 330s > 300s 墙 + 余量）→ 驱动一次 `oracle-client.mjs` 经代理 → 打印 JSON 裁决行（`is_error`/`duration_ms`/`chunks`）→ 落 `armPing.oracle-client.log`（逐 chunk 时间戳 + 最终 JSON 裁决）+ `armPing.mock-upstream.log`（mock 逐帧时间戳/静默/尾/abort）+ `armPing.oracle.log`（裁决摘要）。

### 5.2 armSilent（对照臂）

改 `$ORACLE_XDG/copilot-api/config.yaml`：取消注释「armSilent（control）」那两个覆盖块（`anthropic.stream_keepalive_ping_sec: 0` + `chat_completions.buffered_retry: {enabled: true, heartbeat_sec: 0}`），保存（热重载生效，无需重启代理）：

```bash
cd exp/cc-keepalive-idle-oracle
PROXY_URL=http://localhost:4143 bash run-proxy-arm.sh armSilent 330
```

跑完把 `config.yaml` 的两个覆盖块重新注释掉（恢复 armPing 默认状态），供后续复跑或交叉核对。

### 5.3 回填 §4 表

把两臂各自的 `is_error`/`duration_ms`（`armPing.oracle.log` / `armSilent.oracle.log` 的 `verdict=...` 行已打印好，可直接摘录）填进上面的表格，交回 agent 判定。

可调环境变量：`PROXY_URL`（默认 `http://localhost:4141` — **务必显式改成你的隔离端口**，如 4143，避免误打真实 :4141 主服务器）、`MOCK_UPSTREAM_PORT`（默认 8798）、`MOCK_MODEL_ID`（默认 `gpt-5.4`，需在 `refs/AVAILABLE_MODELS.json` 里带 `/chat/completions` 的 `supported_endpoints` —— `gpt-5.5` 只支持 `/responses`+WS，不可用于本 harness）。

## 6. 排障提示

- **两臂都在 300s 附近断（含 armPing）** → 检查代理是否真的进了 buffered 路径：`chat_completions.buffered_retry` 是否为 `true`（`buffered-config.ts` 的 `resolveCcBufferedAndHeartbeat` 门控）；查代理日志确认心跳间隔（`anthropic.stream_keepalive_ping_sec` 或 `chat_completions.buffered_retry.heartbeat_sec`）确实 > 0 且 < 300s。
- **mock 日志记 `proxy/upstream-fetch ABORTED`（早于 silence_sec）** → `timeouts.response_header` / `timeouts.stream_idle` 仍是默认 900 以下的某个值，或被其他覆盖层调小了；确认 `oracle-config.yaml` 的 `timeouts` 块确实被代理读到（`GET /` 或代理启动日志里的 Data directory 路径应指向你的隔离 `$ORACLE_XDG`）。
- **代理启动报 `Failed to fetch models from Copilot API: connect ECONNREFUSED`** → mock 还没起来就启动了代理；**必须先起 mock 再起代理**（代理开机会立刻拉一次 `/models`）。`run-proxy-arm.sh` 自己会起一个新 mock 实例（同端口），所以如果你手动预热过一个 mock 用于验证代理连通性，记得在跑 `run-proxy-arm.sh` 之前把它杀掉（否则端口冲突，会看 `EADDRINUSE`，此时看 `<label>.mock-upstream.log`）。
- **oracle-client.mjs 报模型未找到 / 400** → 确认 mock 的 `/models` 返回含 `gpt-5.4`（或你用 `MOCK_MODEL_ID` 覆盖的模型）、`supported_endpoints` 含 `/chat/completions`（`refs/AVAILABLE_MODELS.json` 已满足，除非该文件被换过）。
- **oracle-client.mjs TLS 报自签证书不受信** → 这是代理→mock 这一腿的问题（代理需要 `NODE_EXTRA_CA_CERTS=<repo>/exp/cc-keepalive-idle-oracle/mock-cert.pem` 才能信任 mock），不影响 oracle-client→代理（明文 http，不涉及 mock 的证书）。
- **oracle-client.mjs 输出没有 JSON 裁决行，`is_error=<unknown>`** → 多半是 `CEIL`（脚本内 `ceil_sec` 参数）太小、被 `timeout` 杀死，或客户端报了别的致命错误（看 `<label>.oracle-client.log` 全文）。
- **`ss -ltnp` 显示端口被占用（8798/代理端口）** → 之前的调试进程残留；用 `ss -ltnp | grep <port>` 找到具体 PID **精确 kill**（绝不 `pkill`/`killall`，避免误杀无关进程或真实 :4141 主服务器）。

## 7. 环境（用户跑完后请补全）

| 项 | 值 |
|---|---|
| `openai` SDK 版本 | `6.45.0`（`package.json:110` 锁定，本 harness 用仓库自带 `node_modules/openai`，非独立安装） |
| 代理 commit / 分支 | `feat/block-level-buffered-retry` — _待填 commit sha_ |
| 代理运行时 | Bun（生产运行时） — _待填版本_ |
| mock/client 运行时 | Node（type-stripping） — _待填版本，构建期用 v24.16.0 验证过（§0 本地实测同版本）_ |
| 隔离方式 | `XDG_DATA_HOME=/tmp/oracle-cc-xdg` → 独立 `APP_DIR`（独立 config.yaml/history.db），复用 live 的 `github_token` |
| 独立端口 | 代理 _待填（建议 4143，非 live :4141）_ · mock https :8798 |

## 8. 已知非阻塞限制

- 本 harness 只测 CC **直接 passthrough**（`/chat/completions` → GHC 原生 CC 上游）路径下的 buffered keepalive。via-responses 桥接路径（客户端发 CC、代理内部转译到 `/responses`）不在本 harness 覆盖范围——该路径的终止帧由 `codec.flushResponse` 在循环外合成（P2.2-D2），与 Gemini 的同类结构性缺口同根因（见 spec §7.4），不在本轮 M-2 门控的直接范围内。
- 本 harness 用 `openai` Node SDK 作 oracle（无自定义 timeout），未覆盖其它语言/运行时 SDK（Python `openai` 包、`curl`/裸 fetch 等）——若未来某消费者的 idle 死线与 undici 的 300s 默认不同，需另开验证。这是 spec §7.1「CC 无单一主导 CLI」现实下的合理折衷：Node SDK 本身的开箱默认值是目前唯一有代表性、可复现的判据。
- Gemini 路径本轮明确排除（见项目记忆 `project-block-level-buffered-retry-execution`），与本 harness 无关。
