# Q1 / Q2 实测门 PoC 结论（2026-07-23）

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
