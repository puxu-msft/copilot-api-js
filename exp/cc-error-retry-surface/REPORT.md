# CC 错误行为 PoC 实测报告（supersedes FINDINGS 的源码推断）

- **日期**：2026-07-13
- **性质**：**运行时实测**（真实 Claude Code `2.1.207` 客户端 × fake Anthropic server）。可信度：实测 > 源码推断 —— 本报告与 [FINDINGS.md](FINDINGS.md) 冲突处**以本报告为准**。
- **harness**：[fake-anthropic-server.ts](fake-anthropic-server.ts)（喂 CC 精确 SSE 帧序列 + 数 upstream 命中次数）、[run-probe.sh](run-probe.sh)（`claude -p --output-format stream-json`，`CLAUDE_CONFIG_DIR` 隔离 + `ANTHROPIC_API_KEY` 强制 API-key 模式 → `Bo()`=false 匹配代理场景）。
- **oracle**：fake server 收到的 `/v1/messages` 请求次数（>1 = CC 重发整轮）+ stream-json 最终 `result`/`error`。
- **正样本对照**：`happy` variant → 命中恰好 1 次 + 干净 `stop_reason:end_turn` 响应（证 harness 连通、计数可信）。
- **确定性**：关键变体 3/3 复跑同结果。

## 实测结果总表

| variant（喂给 CC 的帧序列） | upstream 命中 | CC 重发? | CC 最终呈现 |
|---|---|---|---|
| `happy`（正常完整响应） | 1 | — | 正常回答，exit 0 |
| `nothing-overloaded`（直接 error 帧，无 message_start） | **3** | ✅ 重发 2 次 | 耗尽后 `API Error: <msg>`，`error:unknown`，exit 1 |
| `bare-overloaded`（message_start + error） | **3** | ✅ | 同上 |
| `pre-content-overloaded`（message_start + ping + error） | **3** | ✅ | 同上 |
| `incomplete-thinking-overloaded`（thinking start+delta **无 stop** + error） | **3** | ✅ | 同上 |
| `pre-content-thinking-overloaded`（**完成的** thinking 块 + error） | **1** | ❌ | 显示 thinking + `API Error: <msg>`，`error:unknown`，exit 1 |
| `post-content-overloaded`（完整 text 块 + error） | **1** | ❌ | `API Error: Server error mid-response. The response above may be incomplete.`，`error:server_error` |
| `pre-content-api-error`（message_start + ping + api_error） | **1** | ❌ | `API Error: <msg>`，`error:unknown`，exit 1 |
| `post-content-api-error`（完整 text + api_error） | **1** | ❌ | partial-text 注记，`error:server_error` |

## 定论（实测确证 / 修正）

1. **post-commit 让 CC 重发整轮的唯一 wire 手段 = `error.type:"overloaded_error"`，且窗口 = 「任何 `content_block_stop` 之前」**。
   - **修正 FINDINGS §2**：窗口**不是**「pre-content（仅 thinking 不算内容）」，而是「**任何块完成之前**」——一个**已完成的 thinking 块**（收到 `content_block_stop`）就足以关闭重试窗口（`pre-content-thinking-overloaded`→hits=1）。未完成的块（无 stop）仍在窗口内（`incomplete-thinking`→hits=3）。判别是 CC 的 `ol`（"已完成任意块，含 thinking"）而非 `_i`（"真实非-thinking 内容"）。
   - 实务含义：这个窗口**极窄**——只在流最开头、第一个块 `content_block_stop` 之前。真实流一旦完成任何块（含 thinking），窗口即关。
2. **`api_error` 不触发任何客户端重试**（pre 或 post content 皆 hits=1）。**修正 FINDINGS §2/§4**：「`api_error` pre-content → 降级非流式重发」这条腿**实测不成立**（至少在 headless `-p` + 默认 config 下）。它直接终端错误。
3. **重试是有界的、且耗尽后仍是终端错误**：即便在重试窗口内，`overloaded_error` 也只重发 2 次（共 3 次 upstream 命中，`svo` 相关），耗尽后 CC 仍 exit 1 显示 `API Error`。所以「relabel overloaded」在 upstream 持续失败时**并不能救活一轮**，只是多给 3 次机会。
4. **post-content 的 partial-text 注记确证**：已吐真实内容 + overloaded/api_error → CC 注入 `API Error: Server error mid-response. The response above may be incomplete.`（`error:server_error`），不重试——正是要避免的「拼普通 text」行为。
5. **`Bo()`=false 场景确证**：`ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` 驱动下，overloaded 重试腿正常触发（未被首方 OAuth 门控收窄），与 FINDINGS §4 对 `Bo()` 的判定一致。

## 对设计的净蕴含（喂给择优）

- **post-commit 的客户端重试基本不可依赖**：唯一手段 overloaded_error 的可用窗口窄到「第一个块完成前」，且耗尽仍终端错误。**任何已经开始吐内容的流，post-commit 都无法靠客户端重试挽救** → **proxy 自己的 buffered-retry（缓冲重放）是 post-commit 唯一可靠出路**。这比 FINDINGS 的结论更强。
- **可重试错误应尽量停在 pre-commit 解决**（真实 status / `x-should-retry` 头，客户端原生重试可靠）——这进一步支撑「延迟提交联动」纳入主线：commit 越晚，越多可重试错误落在可靠的 pre-commit 段。
- **post-content 的错误**：既然客户端侧只会 partial-text 或 hard-stop，代理能做的是（a）buffered-retry 重放（若还没 commit 到已吐内容）、（b）接受 CC 的 partial-text 行为、或（c）若不可重试且用户可动作，在 stop 前追加 AskUserQuestion（交互式）。

## 未测 / 留待项

- **连接层失败 vs body 层 error 帧的非对称**（对抗评审补，本 PoC 未测）：thinking-only 状态下，body 层 `overloaded_error` 帧→硬停，但**连接层 TCP reset / idle→仍重发**（源码 `298416` 的 `wn||jt` 腿）。即代理若用「真断 TCP」而非「发 error 帧」收尾，thinking-only 下仍能触发重试。值得单独 PoC（fake server 中途 `socket.destroy()`）。
- **上游是否总在首个 text 前发完 thinking 块的 `content_block_stop`**（对抗评审补）：直接决定 overloaded-relabel 窗口在 thinking-enabled 真实流里是否可用——若上游总先完成 thinking 块，窗口在 text 前已关，relabel 基本无用武之地。
- 交互式（非 `-p` headless）模式下 querySource 是否使窗口/重试行为不同——本 PoC 是 headless；`api_retry` 系统事件在 headless 未出现（重试经 inner streaming `zr` 腿而非 outer `onRetryStatus`）。交互式重试的 UI 呈现（"retrying in Ns"）未验。
- 非流式 fallback 是否在**非** headless 或特定 config 下才启用（本 PoC 下 `api_error` 未触发它）。
- pre-commit 真实 status 的客户端重试（本 PoC 只测 post-commit 流内帧；pre-commit 的 status/header 腿由 FINDINGS §1 源码 + SDK 层 agent 覆盖，可靠性高，未单独 PoC——如需可加变体让 fake server 直接回非-200）。

## 自愈委派实测（透传上游 400 → CC 自剥+重发；对应 FINDINGS §1c）

动机：本项目已有一整套反应式 retry 策略（`src/lib/request/strategies/`：adaptive-thinking-rejection / cache-control-subfield / tool-field / server-tool / unsupported-beta / structured-outputs / system-reject …）自己修+重试。CC 有语义**重叠**的自愈腿（§1c）。本组测「代理若**透传**匹配 CC 自愈腿的 400（而非自己修）→ CC 是否真自剥+重发」。

| 变体（fake 返回真 HTTP 400 + 特定 message） | upstream 命中 | 判定 |
|---|---|---|
| `err-plain-400`（不匹配任何腿，**负样本对照**） | 1 | ✅ 硬停不重试（证 harness 不误报） |
| `err-thinking-type`（`thinking.type … not supported`，请求级参数） | **2** | ✅ **自愈重发确证**（切 type 后重发一次，去重耗尽后硬停） |
| `err-thinking-signature` / `cannot-modify` / `mid-conv-system` / `media-image`（fresh `say hi` 请求） | 1 | ⚠️ 未触发——**非委派不成立，而是 fresh 请求里没有可剥内容**（源码 `298139` `if(wr!==F)` 才重试） |
| **`sig-conv`（2 轮：turn1 fake 回带签名 thinking 块 → turn2 请求含该块 → fake 回 thinking-signature 400）** | **3** | ✅ **旗舰委派端到端确证** |

**`sig-conv` 决定性证据**（3 次复跑一致）：命中序列 turn1(hit1) → turn2 得 400(hit2) → **hit3 在 hit2 之后仅 6-7ms、body 小 68 字节**。一个纯 400 在 `x6_` 不可重试（非 408/409/429/5xx、无 `x-should-retry`）、`lvo` 退避重试也有 500ms+ 退避——**唯一能产生「立即（无退避）+ body 变小」重发的只有 onError 的 `retry:thinking-signature-strip` 腿**（剥 thinking 块后 `y--;continue`）。即 CC 收到透传的 signature 400 → 剥块 → 立即重发。fake 恒 400 故最终仍放弃；真实场景（剥块后请求合法）该次重发即成功。

**净蕴含**：「透传语义匹配的上游 400 让 CC 自愈」**可行且已验证**（thinking-type 请求级 + thinking-signature 内容级双证）。约束：自愈腿只在**请求含可剥内容**时触发——而真实委派流里内容必在（代理选择不剥→坏内容留在请求→上游 400→透传→CC 有东西可剥）。故该行为适合做成**可配置轴**：每类错误「proxy 自己修（现状反应式策略）vs 透传委派 CC 自愈」二选一。thinking-signature 尤其与本项目 quarantine 机制正面重叠。

## TCP reset / 断连收尾实测（B-1 修法可行性；raw-TCP `socket.terminate()` 发真 RST）

背景：spec 评审 B-1 指出默认 `empty_text` keepalive 会注入一个空 text anchor 块，`closeAnchorIfOpen` 在写 error 帧前先发 `content_block_stop@0`，制造「已完成块」→ overloaded 帧落进不重试腿。候选修法 option 3：post-commit 可重试错误用「断 TCP」而非 error 帧收尾。本组用 raw-TCP server（[rst-fake-server.ts](rst-fake-server.ts)，`socket.terminate()`=真 RST）实测（2/2 确定性）：

| 断流时的块状态 | upstream 连接数 | CC 重发? | CC 呈现 |
|---|---|---|---|
| 无块（`reset-nothing`） | **7** | ✅ 猛重试（网络重试 ≤maxRetries） | terminal error |
| 完成的 **thinking** 块 | **3** | ✅ 重试 | `Connection closed while thinking… Try again` |
| **anchor 开着**（空 text 块**无** stop） | **7** | ✅ 猛重试 | terminal error |
| **anchor 关闭**（空 text 块**有** stop） | **1** | ❌ | `Connection closed mid-response…` partial-finalize |
| 完成的真实 text 块 | **1** | ❌ | 同上 partial-finalize |
| （对照）thinking 块 + FIN（`socket.end()`） | **3** | ✅ | 同 RST |

**定论（对 B-1 决定性）**：
1. **TCP reset/断连比 error 帧的重试窗口宽**——能越过**完成的 thinking 块**（conns=3，印证评审源码断言 `298416` gate 在 `_i` 而非 `ol`），也能在 **anchor 块开着**时重试（conns=7）。RST 与 FIN 行为相同（CC 都当连接错误）。
2. **但 `content_block_stop` 一发即置 `_i`（连空 text 块也算「真实内容」）→ 关闭重试窗口**：`reset-after-anchor-closed`（空 text 块已 stop）→ conns=1 不重试，与 overloaded 帧同。
3. **对默认 `empty_text` keepalive 的直接蕴含**：`closeAnchorIfOpen` 若在断连前关掉 anchor（发 stop@0），TCP reset 收尾**同样失效**（conns=1）。**option 3 的唯一可行形态 = 断连前【不关 anchor、保持块开着】**（conns=7 重试）——而 anchor 在错误到达时本就开着，故技术上可行，代价是「CC 重试耗尽/不重试时下游留一个未闭合块」。
4. `controller.error()`（Bun ReadableStream abort，≈ 干净 EOF/FIN 而非 RST）在无块时被 CC 当 `Stream ended without receiving any events`、不重试——故忠实测 RST 必须用 raw-TCP `socket.terminate()`。

**净蕴含**：option 3（TCP reset）**可行但非免费**——须保证断连时 anchor 块开着（不调 `closeAnchorIfOpen`），且接受下游可能留未闭合块。与 option 1（放弃 post-commit 客户端重试、纯 buffered-retry）相比：option 3 多一条「buffered-retry 不可用/未开时」的客户端重试兜底，但引入未闭合块 + 依赖「保持块开」的时序特判。二者可并存（buffered 优先、其不可用时 TCP-reset 兜底）。

## 独立方法收敛（高置信度依据）

本实测（真 CC × fake server）与一轮**独立的对抗性源码评审**（纯读 `app.pretty.js`、不看本报告）**逐字收敛**于核心结论：inner-retry 窗口的判据是「是否已完成任何 `content_block_stop`（`_r` 空 / `ol` 标志）」而非「pre-content」，一个已完成的 thinking 块即关窗。两个正交方法（黑盒实测 + 白盒读码）得同一非平凡结论，故该结论可信度高。评审另独立指出 SDK 层 `maxRetries:0`（重试全在 `lvo`，默认 10）——已回填 FINDINGS 横幅。
