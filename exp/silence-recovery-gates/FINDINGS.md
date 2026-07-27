# Q1 / Q2 实测门 PoC 结论（2026-07-23，Q1 首次失败点于 2026-07-27 闭合）

关联 spec：[`docs/spec/2026-07-23-upstream-silence-commit-timing.md`](../../docs/spec/2026-07-23-upstream-silence-commit-timing.md) §8 Q1/Q2。执行：`gpt-souls:poc-runner`（主会话补记本文档——运行环境交付纪律禁止子 agent 写 report/findings 文档）。实验代码与实测 JSON 见同目录 `q1-*.ts` / `q2-live-probe.ts` / `results/`。

## Q1：CC pre-header 容忍度 —— 实测 ≥125s（旧「50-55s」估计证伪）

问题：CC（Claude Code / `@anthropic-ai/sdk`）对「请求已发、迟迟无 HTTP 200 响应头」的容忍度。这决定 B1 `streamCommitAfterSec` 窗口上限。

做法：离线本地 fake Anthropic server（端口 41921）在写出任何 HTTP 响应头前**完全静默 N 秒**，随后发完整合法 SSE。全离线、零 GHC 额度。

| 客户端 | pre-header 静默 | 结果 |
|---|---:|---|
| `@anthropic-ai/sdk`（maxRetries:0、显式 1250s timeout） | 60s | 成功 60.03s |
| 同上 | 100s | 成功 100.03s |
| 同上 | 125s | 成功 125.03s |
| 真 Claude Code 2.1.218 | 60s | 成功 TTFT 60.2s，`num_turns=1` |
| 真 Claude Code 2.1.218 | 125s | 成功 TTFT 125.2s，`num_turns=1`、`stop_reason:end_turn` |

（真 CC 125s 样本核验：`results/q1/cli-125000ms.json` — exitCode 0、`result:"Q1_PRE_HEADER_OK after 125000ms"`、`ttft_ms:125247`。）

**timeout 层裁决**：这**不是** commit 后的 60s SSE byte-idle watchdog——测试期间代理还没发 200/SSE，客户端不可能收到 ping 或任何字节。125s 内没触发 CC 的 pre-header connect/read timeout。

**边界（诚实标注）**：**未测到首次失败点**，可证区间仅 `[125s, 未知)`。事故里的 `x-stainless-timeout: 1200` **不能**当本次实测的 timeout oracle，不能据此宣称 CC 一定能等到 1200s。

**对 B1 的意义**：
- 旧假设「50-55s 是 CC 上限」**证伪**——安全下界至少 125s，B1 窗口可远大于旧估计。
- **但事故 RST 最早 ~126s**，故仅把窗口调到 125s **不能确认覆盖事故**（B1 单独救不了干挂到 126-206s 的 A，与 spec §5.B1「部分」一致）。
- **待续**：定默认值/schema clamp 前，继续跑真 CC 的 130s/150s/180s 阶梯找首个失败区间 + 留安全余量。

## Q1 续测（2026-07-27）：首次失败点 = **300.0s**，且不归 Anthropic 层 —— 区间闭合

上轮留的 `[125s, 未知)` 现已闭合。**没有走阶梯**：阶梯每档一次完整运行、且只能夹逼。改为让 fake server 静默到远超任何可能容忍度，直接从 `request.signal` 服务端读出客户端放弃的时刻——一次运行同时给出精确点位与其后的重试行为。代码 `q1-abort-observer-server.ts` / `q1-firstfail-cli-runner.ts` / `q1-bare-fetch-runner.ts` / `run-q1-firstfail.sh`，实测 JSON 见 `results/q1-firstfail/`。

**对照先行**（否则「没观测到 abort」什么也证明不了）：`curl --max-time 5` 必须被记成 `abortedAfterMs: 5002`（abort 检测真的工作）；10s 窗口必须驱动真 CC 走完整成功、且 `result` 里带着服务器自己写的标签文本（成功路径端到端通）。两条都过。

| 臂 | 客户端 | 自称 timeout | 放弃时刻 |
|---|---|---:|---:|
| firstfail attempt 1 | 真 CC 2.1.220 | `x-stainless-timeout: 1200`（秒） | **299,667ms** |
| firstfail attempt 2（CC 自发重试） | 同上 | 同上 | **300,268ms** |
| firstfail attempt 3 | 同上 | 同上 | **300,280ms** |
| firstfail attempt 4 | 同上 | 同上 | **300,256ms** |
| sdkcontrol | `@anthropic-ai/sdk` 0.106.0，`maxRetries:0`、显式 `timeout: 1_250_000` | 1250 | **300,001ms**，`Request timed out.` |
| idle-env-600s | 真 CC + `CLAUDE_STREAM_IDLE_TIMEOUT_MS=600000` | — | **299,813ms**（**没动**） |
| barefetch | Node 裸 `fetch`，无 SDK 无 CC | 无 | **300,887ms**，`UND_ERR_HEADERS_TIMEOUT` |
| repro-125s | 真 CC 2.1.220 | — | 成功 125,002ms，exit 0、`num_turns:1` |

**归因（三步排除，每步都有独立对照）**：

1. **不是 harness**：服务器一直挂着（窗口 900–1500s），是客户端先走。SDK 臂显式给了 1250s 超时仍在 300.0s 死——它自己的 `setTimeout(abort, 1_250_000)` 根本没到点。
2. **不是 CC 的 stream idle watchdog**：把 `CLAUDE_STREAM_IDLE_TIMEOUT_MS` 抬到 600000，放弃点纹丝不动（299,813ms）。且源码侧 `x0i()` 的武装点 `he()` 在 `await …withResponse()` **之后**，pre-header 期间本就没武装。
3. **是 undici 的默认 `headersTimeout`**：剥掉全部 Anthropic 层的裸 `fetch` 在 300,887ms 抛 `HeadersTimeoutError` / `UND_ERR_HEADERS_TIMEOUT`。这一层在 SDK 与 CC 的配置**下面**，所以两者自称的 1200s/1250s 都够不着它。

**因此 `x-stainless-timeout: 1200` 确实不是 oracle**——上轮的谨慎标注是对的，但真实上限比它小 4 倍，不是大。

**CC 撞上后不会死给用户看**：观测到 CC 连做 5 次尝试，每次静默 ~300s 后放弃、~2s 后重发（attempt 到达时刻 1,401 / 301,615 / 602,930 / 905,365ms）。即 pre-header 超时落在 CC 的**原生重试保护区**内——代价是每次重试都让上游从头重算。

**版本注记**：本轮是 CC **2.1.220**（上轮 2.1.218）。125s 正样本在新版本上复现通过，故两轮可比。参照源码 `~/.claude/refs/claude-code-2.1.207` 与实装版本有漂移（例：2.1.220 里 300s 的 `t1_()` 只在非流式路径调用），**行号与结论都只对 2.1.207 有效**，凡涉及实装行为一律以本表实测为准。

**对 B1 / commit 时机的意义**：
- **`stream_commit_after_sec` 的物理上限 = 300s**（减安全余量），不是「未知」。plan-1 Task 1.2 把 ceiling 提到 125s 是**安全的，但保守了 175s**。
- **「把 commit 推迟到首个真实块」在无上限形式下不成立**：commit 前一个字节都没发，300s 一到客户端就整条放弃。commit 在 T 秒 ⇒ 总预算 = T + 300s，T 只能逼近 300s ⇒ **天花板 ~600s**；当前 T=20 ⇒ ~320s。
- 事故的 RST 落在 126–206s，**整段在 300s 窗口内**——把默认窗口抬到该区间之上，这些请求就能留在 pre-header 区、拿到真 HTTP 状态、走 CC 原生重试，这正是 B1 的收益论证。
- **两个 300s 是不同机制、数值巧合**：pre-header 的 300s 是 undici `headersTimeout`（任何响应头即满足）；post-commit 的 300s 是 CC 自己的 stream idle watchdog（**ping 不重置**）。别把两者当同一个东西做预算。


## Q2：事故类大 context 的 fresh-retry 可恢复性 —— 未能定论（inconclusive）

问题：事故类请求（大 context、GHC 0 帧干挂）在 fresh retry 下能否成功？决定 B2 根治 vs 退化 B3。

做法：隔离非 4141 server（端口 41922，当前 worktree 代码、独立 `XDG_DATA_HOME`、真 GHC token、独立 History V3 库；先确认 copied config 未开 upstream hook 以免真请求变 mock）。`claude-haiku-4.5` alias 实际路由到 `claude-sonnet-4-6`，270KB context + `thinking budget 32` + `max_tokens 64`，真 GHC 4 次靶向请求。

| 尝试 | 输入 tokens | 客户端首字节 | `upstreamHeadersAt−startedAt` | 结果 |
|---:|---:|---:|---:|---|
| 1 | 135,020 | 5.95s | 5.86s | 200 |
| 2 | 135,020 | 6.76s | 6.08s | 200 |
| 3 | 135,020 | 12.57s | 12.49s | 200 |
| 4 | 135,020 | 5.53s | 5.40s | 200 |

四条隔离 History attempt 均 `candidateVerdict:"winner"` / `dispatchVerdict:"committed"` / `state:"completed"`，无 hook synthetic 标记（真请求）。

**为何不能判「瞬态可恢复」**：Q2 的必要正样本是「先复现 0 帧、126-206s 后 status=0/RST，再立即 fresh retry 同 body 成功」。本轮**没复现 0 帧干挂**，故无合法 retry 样本。四次成功只支持一个**较弱推断**：270KB 量级 context 并非每次必挂，事故更像**间歇/瞬态**而非大 context 系统性必挂。这不是 B2 fresh-retry 可恢复性的实测通过结论。

**对 B2 的意义**：
- 继续按 spec 主线实现 driver-owned 的 post-commit / pre-semantic-content recovery supervisor，但**「根治事故」必须继续标作待验证**（不因本轮成功而降格为已证）。
- **上线/观测期补埋点**：为每次 `0 real semantic frames + pre-ready failure` 保存可关联 attempt 信息；在 server-tool 风险 gate 通过时对同 body 精确执行一次 fresh dispatch，记录 retry 成功率/时延/计费/History settlement——才能把本门升级为「瞬态可恢复」或「系统性不可恢复」。

## 安全与清理（已核）

Q1 全离线（本地 41921，零额度）；Q2 共 4 次真 GHC 大请求（每次约 135k input / 7 output tokens）。未停/重启/改 4141 主服务器（末次确认 PID 144078 仍监听、`/health` healthy）；测试端口 41921/41922 均无残留监听。

2026-07-27 续测同样全离线、零额度（本地 41931-41939，fake server + 真 CC/SDK/裸 fetch）。真 CC 以 `mkdtemp` 隔离 `HOME` 与 `XDG_*` 运行，不读写用户真实 `~/.claude`。收尾时按 PID 精确 kill 全部探针监听（未用 `pkill`/`killall`），复核 41900 段无残留、4141 主服务器 `/health` 仍 healthy。
