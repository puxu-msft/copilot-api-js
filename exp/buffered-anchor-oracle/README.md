# buffered `empty_text` 合成锚点 —— 真实 CC oracle（上线门控，用户运行）

对应 spec [`docs/spec/2026-07-08-buffered-keepalive-empty-text-anchor.md`](../../docs/spec/2026-07-08-buffered-keepalive-empty-text-anchor.md) §3.6 + plan Task 6.1。

这套 harness 用**真实 `claude` CLI**（本机实测 2.1.204）作 oracle，验证 buffered 模式的 `empty_text` 合成锚点 keepalive 在三条链上都成立。**agent 只编写脚本，不启动服务器**（项目 `no-auto-server` 纪律）；下面的步骤由**你（用户）**执行，跑完把结果贴回 [`REPORT.md`](REPORT.md)，agent 据结果判定门控通过与否。

## 拓扑（与 `exp/cc-idle-280s/` 的关键区别）

`cc-idle-280s` 的 mock 是 CC 的**直接**上游；这里的 mock 是**代理的**上游，夹在代理背后：

```
claude CLI ──Anthropic SSE──▶ copilot-api 代理 (:4141) ──Anthropic SSE──▶ 本 mock (:8890)
                              （锚点注入 / buffered-retry 都在代理这一层）
```

之所以 wire 仍是原生 Anthropic Messages SSE：Claude 模型在 GHC 上 `supported_endpoints:["/v1/messages"]`，代理对其**逐字透传**到 `${ghc_api_base_url}/v1/messages`（`src/lib/anthropic/client.ts:126`）。mock 只负责复现**上游形状**；被测的锚点 / 保活 / 重试行为全在代理侧。

## 前置条件

- 本机装好 `claude` CLI（`claude --version`）。
- 代理有可用的 GitHub 认证（mock 忽略上游 token，但代理启动仍要拿 copilot token；这是你日常的认证）。
- mock 必须**先于代理**启动——代理启动时会从 mock 拉 `/models`。

## 步骤

### 1. 启动 mock GHC 上游（先启动）

```bash
cd exp/buffered-anchor-oracle
bash start-mock.sh            # 默认 :8890，日志 → exp/buffered-anchor-oracle/mock.log
# 可调静默窗口：MOCK_SILENCE_SEC=320（keepalive 链，须 > CC 的 300s 死线）
#              MOCK_ANCHOR_SILENCE_SEC=25（thinking 链，须 > 代理 keepalive cadence）
```

### 2. 启动代理，把上游指向 mock + 打开 buffered

编辑代理的 `config.yaml`（或用等价 CLI/env），关键项：

```yaml
ghc_api_base_url: "http://localhost:8890"     # 指向 mock（不可热更，需重启）
anthropic:
  protect_streaming_generation: tool_use_only  # 进 buffered 路径（CC 必带 tools）
  stream_keepalive_mode: empty_text            # 被测的锚点模式（新默认）
  stream_commit_after_sec: 20                  # delayed-commit 窗口
  stream_keepalive_ping_sec: 20                # 心跳 cadence → 锚点约 20s 注入
  # stream_idle_timeout(timeouts.stream_idle) 默认 900 > 320，别调小否则会先杀上游
```

然后正常启动代理（`bun run start` 等，**由你执行**），监听 `:4141`。

> **锚点占位帧确认**：`config.yaml:518` 已把 `stream_keepalive_mode` 默认设为 `empty_text`，但 `protect_streaming_generation` 默认 `false`——务必显式改成 `tool_use_only`（或 `on`），否则不进 buffered 路径、锚点不触发。

### 3. 逐条跑三条链

每条链一个命令；脚本会先经 `POST /__mode` 切 mock 链并重置计数，再跑一次 headless `claude -p`，最后打印 CC 的 `is_error/duration_ms/num_turns` + mock 计数器。

```bash
cd exp/buffered-anchor-oracle
bash run-chain.sh keepalive              # 链 1：保活有效（empty_text 臂，应 GO）
bash run-chain.sh thinking               # 链 2：thinking-首块良性（最高危）
bash run-chain.sh retry                  # 链 3：retry 透明
```

**链 1 的对照臂（GO/NG 对照）**：把代理 `stream_keepalive_mode` 改成 `content_delta`（此项可热更，无需重启），再跑一次：

```bash
bash run-chain.sh keepalive keepalive-content_delta   # 对照臂：应 NG（~300s 断）
```

跑完把 `stream_keepalive_mode` 改回 `empty_text`。

### 4. 观测 wire（可选但推荐）

除了 CC 的 `--output-format json`，还可以用代理的 **History API / History Web UI** 检查 forwarded 轨：
- 链 1：forwarded 轨应有 `content_block_start{text}`（`synthetic:"anchor"`）+ 空 `text_delta`（`synthetic:"keepalive"`）+ commit 时 `content_block_stop@0` + 真实块 index +1。
- 链 3：forwarded 轨 `message_start` **恰 1 次**、真实块 index 连续、单条完整生成。

## GO/NG 判据

| 链 | GO（通过） | NG（失败 → 回 spec §3.6 调收口形状） |
|---|---|---|
| **1 保活（empty_text）** | CC `is_error=false` 且 `duration_ms > 300000`（撑过 300s 死线，收到 mock tail） | `is_error=true` 且 `duration_ms ≈ 300000`，报 `Stream idle timeout - no chunks received` |
| **1 对照（content_delta）** | 预期 **NG**：`is_error=true`、`duration_ms ≈ 300000`（buffered 无 open block 退 ping、压不住 300s）——证明锚点是 empty_text 独有的效力 | 若这臂反而 GO，说明对照失真，需排查 |
| **2 thinking-首块良性** | CC `is_error=false`、`num_turns ≥ 2`（走了 tool 回合）；且 **mock `validationRejections == 0`**（`/__mode` 计数器）——代理成功剥掉空 text 锚点、thinking 复位首块、上游不 400 | mock 打出 `400 thinking-first VIOLATION`（`validationRejections ≥ 1`）→ 代理**未**剥空 text 锚点 → 上游会 400 |
| **3 retry 透明** | CC `is_error=false`、单条完整生成（result 含 `complete-generation`）；mock `messagesSeen == 2`（首 attempt truncation + 重试）；forwarded 轨 `message_start` 恰 1 次、真实块 index 连续 | 半截流 + 错误、双 `message_start`、或 index 断裂 |

三臂（含对照）全符合预期才算门控通过；任一 NG（尤其链 2 的 400）阻断上线，回 spec 调锚点收口形状。

## 结果贴哪

把每条链的 CC json（`<label>.cli.log`）关键字段 + mock 计数器 + 关键 mock 日志片段，填进 [`REPORT.md`](REPORT.md) 的三臂表格，交回 agent 判定。

## 产物

- `mock.ts` —— mock GHC 上游（`/models` + `/v1/messages` + `/__mode` 控制端点）。
- `start-mock.sh` —— 启动 mock（先启动）。
- `run-chain.sh <chain>` —— 切链 + 跑一次 `claude -p` + 采集结果。
- `mock.log` / `<label>.cli.log` / `settings.<label>.json` —— 运行产物（跑后生成）。
- `REPORT.md` —— 三臂结果表 + 门控判定（待填）。

## 边界 / 注意

- 链 2 依赖 CC **自动执行** mock 返回的 `Bash`(`echo oracle-tool-ran`) 工具以触发第二回合，故用 `--dangerously-skip-permissions`（mock 只返回无害 `echo`，在你的沙箱内运行）。若 CC 版本行为变化不自动续轮，可退而用「直接向代理 replay 一个含 `[空text, thinking, tool_use]` 的 turn-2 请求体」的手工探针复核同一不变量（代理剥空 text → mock 不 400）。
- mock 每条链一进程内长驻、经 `/__mode` 切换（避免代理启动期已缓存 `/models`、后续换 mock 端口失配）。
- prod-faithful 接线（custom base URL + token，非 first-party assume）—— 与两条 320s incident 完全同路径；`exp/cc-idle-280s/` armP 已证 300s 死线在此路径成立。
