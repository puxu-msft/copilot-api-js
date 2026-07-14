# Responses `response.ping` keepalive M-2 实证 oracle — 结果骨架（待用户填）

**性质：** harness 已写、结果待用户运行填入（no-auto-server：agent 写 harness、不起代理）。
**红线 R4：** Task 6（翻 `openai_responses.buffered_retry` 默认为 `true`）**必须**在本 oracle **armPing 通过之后**才能进行。绝不先翻默认再验证。

对应 spec `docs/plan/2026-07-11-block-level-buffered-retry/plan-2-responses-http.md` §Task 5、spec §7.2/§11 M-2。

---

## 0. 为什么仍需要这个门（即便 keepalive 帧类型没变）

Responses 的 forced heartbeat（`responsesKeepaliveFrame()` = `event: response.ping`）+ 强制心跳间隔已随 tier-1 落地（`src/routes/responses/buffered-config.ts:19-24`）。`src/lib/codec/openai-responses/keepalive.ts` 的 docstring 已据 codex-rs `responses.rs` 源码（`timeout(idle_timeout, stream.next())` 逐事件重置）+ openai-node/python SDK 对未知 `type` 的三重容忍，**推断**这个帧能重置 Codex 的 300s idle 死线。

但项目纪律 `empirical-verification`（`docs/CLAUDE.md`）要求：**实测 > 文档推断**。spec §7.2/§11 M-2 明确要求一个独立 oracle 实证，而非停留在文档推断。

块级缓冲重试（本特性）只改变**何时**把真实帧 flush 给客户端（在每个 `output_item.done` 边界提交，而不是只在终态提交）——但**首个 output_item 出现之前**的窗口，无论块级与否，仍然是**全缓冲**的。所以门控精确指向这个 **pre-first-item 全缓冲窗口**：上游长静默期间，`response.ping` 能否让真实 Codex/OpenAI Responses 消费者存活超过 300s。

## 1. 拓扑

```
real codex exec (0.144.1+)  ──OpenAI Responses (/v1/responses)──▶  copilot-api PROXY (buffered_retry: true)  ──ghc_api_base_url (https/h2)──▶  mock-upstream.ts（silent-then-tail, :8799）
```

被测的 `response.ping` 心跳注入 + buffered 提交逻辑全在**代理**这一层；mock 只复现上游形状（`response.created` 立即返回，然后纯静默 `SILENCE_SEC` 秒，最后吐一个干净的双 `output_item` 尾）。

### 1.1 传输：mock = HTTPS/HTTP2（Node），proxy = Bun（生产同款）

本 harness 的 mock **必须是 HTTPS/h2**（不是明文 `http://`），原因是本任务构建过程中**实测确认**的一个 Bun 专属传输缺陷（与 `exp/buffered-anchor-oracle/README.md` 「传输」节记录的 Anthropic 路径同一根因）：

- 代理的 `upstreamFetch`（`src/lib/transport/upstream-fetch.ts:66-69`）对 `https://` 上游走**生产 node:http2 客户端**（在 Bun 下正常），对 `http://` 上游走 **undici**——而 undici 在 Bun 下对增量/静默-then-尾这种 SSE 流有已知缺陷。
- **本任务的实测**：先写了一版明文 `http://` 的 mock，让真实代理（Bun）指向它、静默 8 秒。结果代理的上游 fetch 在收到响应头后 **~5ms 就 ABORT**（而不是撑过 8 秒静默窗口）——这不是超时配置问题（`timeouts.response_header`/`stream_idle` 当时已设 900），是 undici-on-Bun 的解析层缺陷。
- **修复**：把 mock 改造成 `node:http2.createSecureServer`（自签 localhost 证书，ALPN `h2`），代理的 `ghc_api_base_url` 指向 `https://localhost:8799`，走生产 node:http2 客户端——**修复后同样的静默窗口测试（15s、45s）全部端到端跑通**，代理正确转发了 `response.ping` 心跳帧（45s 静默窗口下实测收到 4 个 `response.ping` 帧，间隔约 20s，符合 `stream_keepalive_ping_sec: 20` 配置）。
- mock 本身跑在 **Node**（不是 Bun）——这里不是因为需要真实 RST（本 oracle 不测 retry，只测 keepalive），而是延续与 sibling harness 一致的约定（Node 24+ 靠 type-stripping 直接跑 `.ts`，无需构建）。

**结论**：mock 的传输选型（h2/Node）不是可有可无的实现细节，是这个 harness 能否产出有效证据的**前提条件**——明文 http mock 会让代理在 Bun 下于静默窗口内假性 abort，产生「keepalive 无效」的假阴性，而根因其实是传输层 bug 与被测的心跳逻辑无关。

## 2. 臂设计（两臂，`response.ping` 为门控、对照 = 无 heartbeat）

| 臂 | 代理 heartbeat | 预期消费者结果 | 证明 |
|---|---|---|---|
| **armPing**（门控） | `responsesKeepaliveFrame()` @20s（buffered 强制，`stream_keepalive_ping_sec: 20`） | `is_error=false`、`duration_ms > 300000`、干净收到双 `output_item` 尾 | `response.ping` 无条件重置 Codex 300s idle；上游 330s 后吐尾，消费者干净收全 |
| **armSilent**（对照） | heartbeat 强制关闭（`stream_keepalive_ping_sec: 0` **且** `openai_responses.buffered_retry.heartbeat_sec: 0`，见 oracle-config.yaml 注释块） | `is_error=true`（若消费者有 300s idle 墙）；`turn.failed` | 无保活 → 复现 idle-out，反证 armPing 的保活是承重的 |

> **oracle 选择**：本 harness 用**真实 Codex CLI**（`codex exec`，本机实测 **0.144.1**）——其 `responses.rs` 的 300s idle 正是被测对象，可信度高于回退用 openai-node/python SDK（SDK 已知容忍未知帧类型，但未必有真实的、独立测量的 300s idle 墙）。

## 3. 上线门控判据

- **armPing** `is_error=false` **且** `duration_ms > 300000`（撑过 300s 死线，收到 mock 的完整双 `output_item` 尾）→ **M-2 通过** → 允许 Task 6 把 `openai_responses.buffered_retry` 默认翻为 `true`。
- **armSilent** 复现 idle-out（`is_error=true`）→ 反证：没有 heartbeat 时消费者确实会在 ~300s 处断连，证明 armPing 的存活不是巧合（例如 Codex 本身没有 300s 墙、或这次请求太快完成之类的混淆因素）。
- 若 armPing **失败**或 armSilent **也存活**（两臂结果无法区分）→ oracle 不确定，M-2 未通过 → **不翻默认**，Task 6 降级为「保持 opt-in，文档记 M-2 未通过」（spec §4.5/§11 三级 fallback 的精神：不牺牲安全换默认开）。

## 4. 结果（**待用户填**）

| 臂 | `stream_keepalive_ping_sec` | `buffered_retry.heartbeat_sec` | 预期 | 实测 `is_error` | 实测 `duration_ms` | codex `turn.*` 摘要 | 裁决 |
|---|---|---|---|---|---|---|---|
| armPing | 20 | (fallback, N/A) | `is_error=false`、`duration_ms>300000` | _待填_ | _待填_ | _待填_ | _待填_ |
| armSilent | 0 | 0 | `is_error=true`、`duration_ms≈300000` | _待填_ | _待填_ | _待填_ | _待填_ |

**门控判定：** _待填_（PASS / FAIL / 不确定）

## 5. 运行指令（用户执行 — `no-auto-server`：agent 写 harness、不起代理）

**前提**：
- 本机已装 `codex` CLI（`codex --version`；本 harness 用 **0.144.1** 验证过）。
- 本机已装 **Node 22.6+/24**（跑 mock，靠 type-stripping 直接执行 `.ts`）+ **Bun**（跑代理，生产运行时）。
- 代理有可用的 GitHub 认证（mock 忽略上游 token，但代理启动仍要拿 copilot token；可复用你 live 实例的 `github_token`，见下方 `XDG_DATA_HOME` 隔离）。

### 5.1 armPing（门控臂）

> **⚠️ 顺序（2026-07-14 修正）**：代理 boot 会去 `ghc_api_base_url`（=本 mock 端口）拉 `/models`，**拉不到就 `process.exit(1)` 硬退出**（`start.ts:468-474`）。所以 mock 必须**先于**代理起。原步骤（先代理后 mock）有鸡生蛋死锁 → 现改为：**先常驻起 mock（步骤 0）→ 起代理（步骤 2）→ 跑臂（步骤 3，用 `MOCK_UPSTREAM_EXTERNAL=1` 复用常驻 mock，不自起、不 kill）**。证书须先于常驻 mock 生成（步骤 -1）。

```bash
cd exp/responses-keepalive-idle-oracle

# 0) 生成自签证书（一次性；常驻 mock 起来就要用它）：
openssl req -x509 -newkey rsa:2048 -nodes -keyout mock-key.pem -out mock-cert.pem \
  -days 3650 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost"

# 1) 隔离 XDG_DATA_HOME（不污染 live :4141 的 history/config）：
export ORACLE_XDG=/tmp/oracle-responses-xdg
mkdir -p "$ORACLE_XDG/copilot-api"
cp ~/.local/share/copilot-api/github_token "$ORACLE_XDG/copilot-api/github_token"
chmod 600 "$ORACLE_XDG/copilot-api/github_token"
cp oracle-config.yaml "$ORACLE_XDG/copilot-api/config.yaml"   # armPing 用默认值（不改任何注释块）

# 2a) 常驻起 mock（终端 A — 先于代理！/models 立即响应、只有 /responses 静默；两臂通用）：
MOCK_UPSTREAM_MODE="silent:330" MOCK_UPSTREAM_PORT=8799 MOCK_MODEL_ID=gpt-5.5 node mock-upstream.ts

# 2b) 起代理（终端 B，非 :4141，指向常驻 mock，信任其自签证书）：
cd <repo-root>
XDG_DATA_HOME="$ORACLE_XDG" NODE_EXTRA_CA_CERTS=exp/responses-keepalive-idle-oracle/mock-cert.pem \
  bun run src/main.ts start --port 4142 --ghc-api-base-url https://localhost:8799 --no-rate-limit

# 3) 跑臂（终端 C — 复用终端 A 的常驻 mock，只驱动一次 headless codex exec）：
cd exp/responses-keepalive-idle-oracle
PROXY_URL=http://localhost:4142 MOCK_UPSTREAM_EXTERNAL=1 bash run-proxy-arm.sh armPing 330
```

`run-proxy-arm.sh`（`MOCK_UPSTREAM_EXTERNAL=1`）会：复用常驻 mock（不自起/不 kill）→ 驱动一次 `codex exec --json` 经代理 → 解析 codex 的 `--json` 事件流拿 `turn.completed`（成功）/`turn.failed`（失败）→ 落 `armPing.codex.jsonl`（原始事件）+ `armPing.oracle.log`（裁决摘要）。mock 逐帧时间戳看终端 A 的 stdout。

### 5.2 armSilent（对照臂）

改 `$ORACLE_XDG/copilot-api/config.yaml`：取消注释「armSilent（control）」那两个覆盖块（`anthropic.stream_keepalive_ping_sec: 0` + `openai_responses.buffered_retry: {enabled: true, heartbeat_sec: 0}`），保存（热重载生效，无需重启代理/mock）：

```bash
cd exp/responses-keepalive-idle-oracle
PROXY_URL=http://localhost:4142 MOCK_UPSTREAM_EXTERNAL=1 bash run-proxy-arm.sh armSilent 330
```

跑完把 `config.yaml` 的两个覆盖块重新注释掉（恢复 armPing 默认状态），供后续复跑或交叉核对。

### 5.3 回填 §4 表

把两臂各自的 `is_error`/`duration_ms`/`turn.*` 摘要（`armPing.oracle.log` / `armSilent.oracle.log` 已打印好，可直接摘录）填进上面的表格，交回 agent 判定。

可调环境变量：`PROXY_URL`（默认 `http://localhost:4141` — **务必显式改成你的隔离端口**，如 4142，避免误打真实 :4141 主服务器）、`MOCK_UPSTREAM_PORT`（默认 8799）、`CODEX_CEIL`（wall-clock 上限，默认 420s，须 > silence_sec + 余量）、`MOCK_MODEL_ID`（默认 `gpt-5.5`，需在 `refs/AVAILABLE_MODELS.json` 里带 `/responses` 的 `supported_endpoints`）。

## 6. 排障提示

- **两臂都在 300s 附近断（含 armPing）** → 检查代理是否真的进了 buffered 路径：`openai_responses.buffered_retry` 是否为 `true`（`buffered-config.ts` 的 `resolveResponsesBufferedAndHeartbeat` 门控）；查代理日志确认没有走 `viaFallback`（chat-completions 转译回退路径不走块级缓冲，见 `handler-v4.ts:307`）。
- **mock 日志记 `proxy/upstream-fetch ABORTED`（早于 silence_sec）** → `timeouts.response_header` / `timeouts.stream_idle` 仍是默认 900 以下的某个值，或被其他覆盖层调小了；确认 `oracle-config.yaml` 的 `timeouts` 块确实被代理读到（`GET /` 或代理启动日志里的 Data directory 路径应指向你的隔离 `$ORACLE_XDG`）。
- **代理启动报 `Failed to fetch models from Copilot API: connect ECONNREFUSED`** → mock 还没起来就启动了代理；**必须先起 mock 再起代理**（代理开机会立刻拉一次 `/models`）。`run-proxy-arm.sh` 自己会起一个新 mock 实例（同端口），所以如果你手动预热过一个 mock 用于验证代理连通性，记得在跑 `run-proxy-arm.sh` 之前把它杀掉（否则端口冲突，`run-proxy-arm.sh` 会打印 `EADDRINUSE`，此时看 `<label>.mock-upstream.log`）。
- **codex 立即报模型未找到 / 400** → 确认 mock 的 `/models` 返回含 `gpt-5.5`（或你用 `MOCK_MODEL_ID` 覆盖的模型）、`supported_endpoints` 含 `/responses`（`refs/AVAILABLE_MODELS.json` 已满足，除非该文件被换过）。
- **codex TLS 报自签证书不受信** → 代理需要 `NODE_EXTRA_CA_CERTS=<repo>/exp/responses-keepalive-idle-oracle/mock-cert.pem` 才能信任 mock；codex 本身走 `PROXY_URL`（明文 http，不涉及 mock 的证书），所以这一步只影响代理→mock 这一腿，不影响 codex→代理。
- **codex 输出里 `turn.completed`/`turn.failed` 都没出现，`is_error=<unknown>`** → 多半是 `CODEX_CEIL` 太小、被 `timeout` 杀死（codex_rc 会是 124 或类似），或 codex 报了别的致命错误（看 `<label>.codex.jsonl` 全文，特别是非 JSON 行 —— codex `--json` 会混一条 `Reading additional input from stdin...` banner 和偶发的 `rmcp::transport::worker` ERROR 行，均可忽略，是本地 MCP 服务器探测失败的噪音，与被测逻辑无关）。
- **`ss -ltnp` 显示端口被占用（8799/代理端口）** → 之前的调试进程残留；用 `ss -ltnp | grep <port>` 找到具体 PID **精确 kill**（绝不 `pkill`/`killall`，避免误杀无关进程或真实 :4141 主服务器）。

## 7. 环境（用户跑完后请补全）

| 项 | 值 |
|---|---|
| `codex --version` | _待填（本 harness 构建期验证过 0.144.1）_ |
| 代理 commit / 分支 | `feat/block-level-buffered-retry` — _待填 commit sha_ |
| 代理运行时 | Bun（生产运行时） — _待填版本_ |
| mock 运行时 | Node（type-stripping） — _待填版本，构建期用 v24.16.0 验证过_ |
| 隔离方式 | `XDG_DATA_HOME=/tmp/oracle-responses-xdg` → 独立 `APP_DIR`（独立 config.yaml/history.db），复用 live 的 `github_token` |
| 独立端口 | 代理 _待填（建议 4142，非 live :4141）_ · mock https :8799 |

## 8. 已知非阻塞限制

- 本 harness 只测 **HTTP** 传输路径下的 buffered keepalive（`openai_responses.upstream_ws: false`）。gpt-5.5 同时支持 `ws:/responses`——若操作者开启 `upstream_ws: true`，请求会走上游 WebSocket 而非 HTTP，buffered-config.ts 的 heartbeat 逻辑不适用于该分支（WS 有自己的保活机制，未在本 oracle 覆盖范围内，也不属于本次 R4 门控范围——block-level buffered retry 的默认翻转目标是 `openai_responses.buffered_retry`，其 HTTP 分支）。
- 本 harness 不测 Chat-Completions-fallback 转译路径（`viaFallback`）——该路径的块级缓冲已知不适用（见 `handler-v4.ts:307` 注释），M-2 门控范围内不涉及。
- Gemini / web_search 路径本轮明确排除（见项目记忆 `project-block-level-buffered-retry-execution`）。
