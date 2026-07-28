# 交接：keepalive 300s、合成分隔符、顺序不变量审计（2026-07-27）

> **状态**：进行中——**T1 已完成**（2026-07-28，见 §3 T1）；T2–T4 用户已批准、未开工；T5 待用户裁决顺序；T6 待用户一句话。
> **核验基线**：`847f8bc8`（2026-07-28 12:10）——晚于此的 peer 提交可能已作废下面的结论；上一次就栽在这里（见 §5）。
> **工作区**：master 共享主树，**并发会话活跃**——本文核验时工作区有大量他人未提交改动（`src/lib/transport/*`、`packages/foundation/*`、多份 `docs/memory/*` 等），我方改动已全部提交，未留未追踪产物。**后续代码改动一律进隔离 worktree**（用户 2026-07-27 决定）。
> **已跑门禁**：`bun scripts/parallel-test.ts unit it http` 绿（2026-07-27）；`bun run test:backend` 现已等价于该命令（`1b8bdf2f` 起不再前置 `build:history-search`）；`bun run lint:all` 常年红（退役的 `ui/`，用户已推迟）。门禁现状最易腐，**接手第一件事是复验而非采信**。

**给接手会话**：本文是这一轮的**唯一入口**。按「先读什么 → 已定事实 → 待办与判据」的顺序写；每条待办都带**验收判据**与**证伪方式**，不带「大概」「也许」。交接文档本身的写法见 skill `session-closeout` §6 与其 `handover.md` 模板。

会话起因：用户贴来一条 `API Error: 400 ... does not support assistant message prefill`，要求修复。查下去牵出三条独立的线：C3 布局约束（已收官）、**keepalive 300s 死线（线上损伤，部分已修）**、顺序不变量缺守卫（审计完成，未动手）。

---

## 0. 先读这三份（都在本目录）

| 文件 | 是什么 | 什么时候读 |
|---|---|---|
| `research-keepalive-options.md`（446 行） | keepalive 300s 的**源码级机制 + 生产损伤量化 + 14 个方案** | 动 keepalive 任何一行之前 |
| `research-separator-options.md`（317 行） | 合成分隔符的 18 个方案 + 17 种 block type 逐型判定 + 真上游探针设计 | 动分隔符 / 做不可见 Unicode PoC 之前 |
| `research-order-invariant-audit.md` | 6 个「靠注释守着、无机器守卫」的顺序/装配隐患，2 CRITICAL | 决定要不要修那两个 CRITICAL 之前 |

**这三份是 subagent 产出、我逐条抽查过承重结论后保留的**。它们标了证据等级（实测 / 源码读证 / 推断），**按标签对待，别把推断当实测**。

---

## 1. 已经落地的（本会话提交，master）

| commit | 内容 |
|---|---|
| `39a2a0d9` | L1：C3（含 tool_use 必须以 tool_use 收尾）升为**独立触发条件**的主动修复；781 条穷举扫描扩到全部输入 |
| `53758f9a` | L2：`classifyLayoutRejection` 分三种线索；C3 走**有条件治愈**（真实 strip-all 前后对比 + 全 payload + 排除 assistant 收尾） |
| `5b5c8c14` | 事故取证 + 离线探针 `exp/thinking-terminal-block/probe-remote-c3-regression.ts` |
| `8fb19a6e` / `848ba250` | 全量重命名（`repairAssistantBlockLayout` / `blockLayout` / `assistant_block_layout_strategy`，旧配置键留 compat 别名）+ 活文档跟进 |
| `5352b478` | 第二轮跨模型评审的 4 minor 收尾 |
| `2029a1d2` / `67dcb6ee` | `insert_text` 策略退役（契约与 C3 互斥，不可能在契约内修好）+ 理由文档化 |
| `3f6bf483` | **retry 放弃计数器**：`copilot_api_retry_giveups_total{reason,error_type}` + warn，四种 reason 分开 |
| `52a4ff94` | 合成分隔符改为**前缀族 + 版本**，单一谓词 + 身份守卫 |
| （本轮）| **合成分隔符两条轴**：`separator_carrier`（EMIT，封闭 enum）/ `separator_accept_extra`（ACCEPT，开放 list） |
| `984c56ee` | 根目录散落探针归档进 `exp/` |

**并发会话在 18:28 落了 `68a3b3f5`「escalate keepalive before content timeout」**——它实现了本轮 keepalive 分析里的 R1（有开块时打空 delta）+ 无开块时注入脚手架，且只在逼近 300s 时才升级（日常仍纯 ping、零污染）。**接手前先 `git log --oneline -20` 看这块有没有再动。**

---

## 2. 已确证的硬事实（别再重新推导）

### 2.1 CC 的 300s 死线（源码读证，我亲自复核过引文）

- 参照源码：`~/.claude/refs/claude-code-2.1.207/app.pretty.js`（本机装的是 2.1.220，**引文行号仅对 2.1.207 有效**）。
- `:10018` `if (a.event === "ping") continue;` 位于 accept-set 判断**之后** → **ping 帧永远不会被 yield 给 CC**。
- `:298200` 消费循环 `if (ar.type === "ping") { yield…; continue }` 然后才 `he()` → **任何非-ping 事件都重置**，不必是 content delta。`content_block_start`/`content_block_stop`/`message_delta` 都算。
- **既有 skill 里「只有真实 content_block_delta 能重置」的表述不准确**，尚未修正（见 §4 待办）。
- 300s 是**地板**（`Math.max(env, 3e5)`），只能调高。
- 300s 时钟在**响应头到达后**才武装（`he()` 在 `await …withResponse()` 之后），头到达前**一帧都不用发**。
  - **⚠ 2026-07-27 订正**：本行原写「头到达前由 SDK client `timeout = API_TIMEOUT_MS || 600000` 管」——**那不是真正的约束**。SDK 的计时器确实是 600s（2.1.220 实装亦然），但它**从来没机会触发**：更低一层的 undici 默认 `headersTimeout` 在 **~300s** 就掐断了。实测：真 CC 299,667–300,280ms、SDK（显式 1250s 超时）300,001ms、裸 `fetch` 300,887ms 抛 `UND_ERR_HEADERS_TIMEOUT`。所以 pre-header 预算是 **~300s，不是 600s**。见 `exp/silence-recovery-gates/FINDINGS.md` §「Q1 续测」（含作用域限定：这是本机 CC 2.1.220 + Node v26.3.0 的 transport 默认，非协议常量）。
  - 巧合提醒：pre-header 的 300s（undici `headersTimeout`，**任何**响应头即满足）与 commit 后的 300s（CC stream idle watchdog，**ping 不重置**）是**两个不同机制**，数值相同，别合并做预算。

### 2.2 生产损伤（我亲手用 History 只读探针复核）

- 405 条 entry 里 **没有任何 completed 超过 300s**；最长成功 292.7s。
- 阴性样本 `req_1785177872790_5500`：可重置帧之间最大间隔 **300,039ms**，state=aborted；上游恢复晚到 39ms。
- 阳性样本 `req_1785180629203_212`：最大间隔 257,408ms < 300s → completed。
- **我一度声称有「成功的 314s 请求」，那是错的**（`req_1785179198417_5582` 是 `state: failed`）。别再引用。

### 2.3 空 delta 上不上 wire（本会话实测，`exp/keepalive-escalation-wire/`）

**上——但这个"上"是被并发会话修出来的，别读成"一直都上"。**

12s 静默期间 wire 收到 8 ping + **3 个空 `text_delta`**。**关键时序**：并发会话的 `883e0533`（15:20 UTC）已经定位并修好了真正的丢失层——**`recoverToolCallText` 的 marker lookahead 在响应改写链里吞掉了空 delta**，下游只收到 ping；修复后他们用真 CC 2.1.220 连跑两次 315s PASS。我这发探针跑在 21:10，**验的是修复后的行为**。

所以正确的结论是：
- **G2 的丢失确实在我方管线**（不是 CC、不是 harness）。我一度写下的「不在我方管线」是**错的**，因为我没有先查 peer 是否已经动过这块——`883e0533` 比我早 6 小时。
- D2 第 ② 条判据「空 delta 不能重置 CC 死线」是**假阴性**这一点仍然成立，但原因是**我方吞帧**，不是 CC 不认。
- 刚落地的升级修复在 wire 层有效（我的探针 + peer 的真 CLI 双证）；
- 但该配置下 **anchor 块@0 确实被发出**（真实块 remap 到 index=1）——「客户端历史里的空 text 块全来自上游」这句**要收窄**：production 抽样里 index=0 的可能是我方 anchor，index=1 的才是上游的。

> **⚠️ 这发探针证明的范围要看准**：我用的是 buffered 配置，真实块直到收尾才 flush，所以静默期间**客户端视角是 pre-content 窗口**——探针验证的是**pre-content 升级路径**。而 `docs/DESIGN.md:306` 明写当前升级是 **pre-content-only**：「首块提交后的无-open窗口只 ping，完整覆盖等待 generation-scoped allocator（方案 A）」。
>
> **所以 W3（首块已提交、块间无开块）仍然是活的缺口，仍会在 300s 处死**——这正是 T2 要做的实验，别因为这发探针绿了就以为 W3 已解决。

### 2.4 合成分隔符的必要性（有精确判据，不是偏好）

设消息内 `n` 个 thinking、`m` 个可用真实非 thinking 块：**零合成的充要条件是 `m ≥ n`**（`n-1` 个内部间隔 + 1 个合法收尾）。事故形状 `[T,empty,T,tool]` 本来 `m=n=2` 够用，是我方删掉那个空块才让 `m` 掉到 1。

### 2.5 block type 穷举结论

17 种顶层类型逐个判过：**只有 `text` 没有配对关系、外部资源、签名或指令语义**。不换类型；值得实测的是 **text 的最小载荷**（不可见 Unicode）。

---

## 3. 待办（按优先级，每条带验收判据）

### T1【已完成 2026-07-28】commit 时机推迟 —— 测量与落地都做完了

> **状态：DONE，合并在 master `da59c586`。** 剩下的不在本条。
>
> **测量（Q1 闭合）**：CC pre-header 容忍度 ≈ **300s**，归 undici 默认 `headersTimeout`（不是 SDK 的 1200/1250s request timer，也不是 CC 响应头后才武装的 stream-idle watchdog）。附测：`API_FORCE_IDLE_TIMEOUT=0` 能把它整个关掉（静默 600s 仍单次成功）——但那是**客户端侧**开关，我方取值一律按「客户端没设」来定。证据 `exp/silence-recovery-gates/FINDINGS.md` §「Q1 续测」/§「Q1 附测」。
>
> **落地**：`streamCommitAfterSec` 默认 20 → **180**（用户 2026-07-28 拍板）、`COMMIT_WINDOW_MAX_SEC` → **240**（~300s 减余量）、窗口改为**从请求 ingress 起算的 deadline**（合并态审查抓出：handler-局部计时会把 pre-handler 的 token 刷新时间花两次、吃掉 ceiling 承诺的余量）。B1 的 clamp 拆分是 cherry-pick 自 `feat/upstream-silence-recovery`，非重写。
>
> **两条别再重新推导的边界**：① 180 只覆盖事故带 126-206s 的**前半段**，180-206s 段仍先 commit、归 B2；② **不存在「总预算 T+300s / ~600s 天花板」**——commit 后那个 300s 是可重置的 idle watchdog，且我方 `streamKeepaliveEscalateSec`（默认 200s）本就在主动重置它。本文档早先版本写过那条算术，是错的。
>
> **已知暴露面**（已入 `docs/todo/deferred-backlog.md`）：窗口是全局的，但安全上限只在两个 Node 客户端上实测过；pre-header 容忍度落在 `(20s, 180s)` 的其它 Anthropic 客户端会被这个默认打破。长远形状是客户端感知的 commit policy。

<details>
<summary>原始 T1 条目（保留供追溯）</summary>


> **⚠ 2026-07-27 续会话更新：T1 的无上限形式已被实测否定，且它不是空地。**
>
> **① 实测（Q1 门已闭合）**：CC 的 pre-header 容忍度 ≈ **300s**，不是「≥125s、上界未知」。直接触发器**与 undici 默认 `headersTimeout` 一致**——**不是** SDK 的 1200/1250s request timer，**也不是** CC 那个响应头后才武装的 stream-idle watchdog（把 `CLAUDE_STREAM_IDLE_TIMEOUT_MS` 抬到 600s 不移动该点；裸 `fetch` 无 SDK 无 CC 抛 `UND_ERR_HEADERS_TIMEOUT`；裸 TCP socket 打同一 handler 420.1s 未被关，排除我方服务端）。**作用域**：本机 CC 2.1.220 + 其内置 Node v26.3.0 transport 默认，四个完整 attempt 落在 299.667–300.280s。这是**可配置、随版本变化的 transport 默认值，不是协议常量**。证据 + 对照见 [`exp/silence-recovery-gates/FINDINGS.md`](../../../exp/silence-recovery-gates/FINDINGS.md) §「Q1 续测」。
>
> **所以「推迟到首个真实块」不能无上限做**：commit 前我方一个字节都发不出，~300s 一到该 attempt 就被中止。可安全断言的**窄结论仅此一条**——单个 pre-header attempt 必须在 ~300s 前 commit，否则接受它被中止。撞上不致命（CC 原生重试，观测 4 个完整周期、backoff ≈0.55/1.05/2.16/4.06s，最大尝试数未测），代价是上游从头重算。
>
> ⚠ **本文档早先版本写过「总预算 T+300s、天花板 ~600s」——那是错的，已删除。** commit 后的 300s 是**可重置的 idle watchdog**（任何非-ping 事件重置），而且我方 `streamKeepaliveEscalateSec` 默认 **200s** 就在主动重置它（[state.ts:410-415](../../../src/lib/state.ts#L410-L415)，注释自陈「留 ~100s 余量给 CC 的 300s watchdog」）。post-commit 能撑多久由 keepalive/escalation 契约决定，**不存在无条件的 T+300 算术**。两个 300s 相互独立配置、当前默认值相同，不得合并做预算。
>
> **② 别另起炉灶**：这条已有定稿 spec + 经两轮跨模型评审达成 consensus 的 5 份 plan（[`docs/plan/2026-07-23-upstream-silence-recovery/`](../2026-07-23-upstream-silence-recovery/)），**B1 就是 T1**。且 `feat/upstream-silence-recovery` 分支上 B1 已实现但未合 master（`a81f117d` 拆 clamp、`6c53e27b` ceiling 提 125s，外加 B2-P0 地基）。该分支停在 07-23，**无会话在跟进**（查过所有活跃 session 的 `gitBranch`）；与今日 master 做 `git merge-tree` 试合并：**全部源码文件自动合并干净，只有 `docs/DESIGN.md` 和 `docs/todo/deferred-backlog.md` 两处文本冲突**。用户 2026-07-27 裁决：**先只读评估、暂不动它**。
>
> **③ 剩下真正要做的**：不是测量（已完成），而是 **`streamCommitAfterSec` 默认值取多少**——现在是一个上界已知的取舍（窗口越大越多长思考走原生保护 vs A 型挂起干等越久），事故 RST 的 126-206s 整段在窗口内。plan-1 Task 1.2 已按此改写，**取值需用户拍板**。

- **收益**：CC 的 idle watchdog 在响应头之后才起跑，且 pre-commit 期间上游报错还能返回**真 HTTP 状态码**（保住 CC 全套原生自愈：thinking-strip / cache-beta drop / 429 退避重试）。~~推迟到 T 秒 commit，总预算变 T+300s。~~ **该加法已作废**——见上方 ⚠ 订正，commit 后是可重置的 idle watchdog，不存在固定总预算加法。推迟 commit 延长的是**原生 HTTP 状态保护窗口**，其幅度受 pre-header ~300s 硬上界约束。
- **用户明确要求**：**源码 + 实证双证**，证明推迟不会破坏 CC 与 proxy 的连接。→ 双证已完成（见上方更新）：源码侧确认 pre-header 期间 CC 的 idle watchdog 尚未武装（`he()` 在 `await …withResponse()` 之后），实证侧测出真正的约束在更低一层。
- **仍未查的风险面**：代理侧 `stream_commit_after_sec` 与 pre-response 重试/错误整形的交互（上游错误在 commit 前还能以真 HTTP 状态码返回，commit 后就只能走 SSE 内错误——这是**收益的一部分**，也是风险面）。
- **必须与 `docs/spec/2026-07-23-upstream-silence-commit-timing.md` 合并设计**，别另起炉灶。
- **验收**：① 真 CLI e2e：上游静默 T+250s 后才出首块，客户端完整收尾；② 上游在 commit 前报错时客户端拿到**真 HTTP 状态码**；③ 现有 pre-response 相关测试全绿。

</details>

### T2【用户已批】W3（已 commit、无开块）兜底手段 —— **要做实验**

- 并发会话的 `escalationScaffold` 已是一种 W3 实现（升级时注入脚手架）。**尚未有实验证明它在真 CLI 下有效**。
- 候选对照臂（研究报告 §4.8/§4.10/§4.14）：`content_block_stop` 延迟一帧（把 W3 塌缩进 W2）/ 非标准协议缝隙帧 / `message_delta` 心跳（注意：**每发一次都会把整轮 input 成本再加一次**，污染 CC 成本显示）。
- **实验骨架已经有了**：照抄 `exp/keepalive-escalation-wire/`（改 hook 让静默发生在**块间**而不是块内），配 skill `client-proxy-e2e-testing` 起真 CLI。
- **验收**：`[block0] → 静默 340s → [block1]`，两块内容全保、客户端不报 stall。

### T3【用户已批】不可见 Unicode 的 PoC

- **落点已经备好**：EMIT 轴的封闭 enum（`SEPARATOR_CARRIERS`，`src/lib/anthropic/sanitize/block-layout-contract.ts`）。过了门就加一个 `invisible_v1` 值、切默认；旧值继续被 ACCEPT 轴识别，**零迁移成本**。
- **五道门**（研究报告 §探针 A 有可复跑设计）：① GHC 真上游接受（非 strip）；② 跨模型（opus/sonnet/haiku）；③ mutation（改一个字符要能被检出）；④ wire 保真（不被中间层归一化）；⑤ 客户端往返（CC 存进历史再发回来仍可识别）。
- **任一门失败 → 维持可见 marker**，不要"部分通过就上"。

### T4【用户已批】`empty_text` 保活模式的删除 —— **但先确认它现在还有没有被用**

- 用户已批准删除。**但 `68a3b3f5` 之后语义变了**：升级路径注入的就是内容 delta / 脚手架。删之前**先读 `resolveAnthropicKeepalive` 与 escalation 的关系**，确认 `empty_text` 这个 mode 值是否已被升级机制取代。
- 若确认冗余：删 enum 值 + config compat 值迁移（照抄本会话 `insert_text` 退役的做法：`migrateValue` + `renameLeaf` 的 `transform` 两条入口都要覆盖，因为**迁移不链式求值**）。
- **同时要做的文档纠偏**（研究报告 §5.3 P3）：ADR `2026-07-22-continuation-retry-sequential-anchor` D2 补修订记录（结论保留、**理由第 ② 条已被推翻**）；skill `debugging-claude-client-connection` 改成 §2.1 的精确判据 + 给「60s byte-idle」标存疑；`docs/todo/2026-07-22-client-proxy-keepalive-300s.md` 明确排除「掐断源是代理 stall 检测」这个假设（字面量在 CC `:298433`）。

### T5 顺序不变量审计的 6 个发现 —— **一个都还没动，需要你先裁决顺序**

见 `research-order-invariant-audit.md`。我的建议顺序：

1. **CRITICAL｜Responses WS 缺 `acc.streamError` 分支**（`src/routes/responses/ws.ts:467` vs HTTP 镜像 `handler-v4.ts:451`）——**这是已发生的漂移，不是缺守卫**。上游终止 error 帧会被误判成 truncation，发第二个合成 error + 1011 关闭，History 失败原因被改写。**先修这个**。
2. **HIGH｜liveness 的假守卫**（`server.ts:119` 要求 liveness 注册在 config/token 中间件之前，但「缺 token 仍 200」的测试走的是**没有该中间件的 test app**）——最误导人，改动小。
3. **CRITICAL｜WS abort controller 必须在首个 `await` 前注册**（`ws.ts:226`，注释自承 "correct-by-inspection"，对应过一次 4GB OOM）——加守卫，涉及可注入化。
4. 其余 HIGH/MED：delayed-commit abort listener 顺序、`inspectRequest` 漏 `client.inbound`、`createFullTestApp` 与生产 server 装配漂移。

### T6 零散但别丢

- **`.codex`**：仓库根 0 字节空文件，归档没意义。留着还是删，等用户一句话。
- **`docs/DESIGN.md:305-306`** 曾写 `empty_text` 是默认（陈旧、误导过我）。`68a3b3f5` 可能已改，**接手时核一遍**。
- **两条 load-sensitive 测试**：`tests/architecture/telemetry-domain-surface.unit.test.ts`（本会话已给 30s 预算）和 `tests/history/v3/canonical-performance.unit.test.ts`（**未处理**，并行负载下会假红，单跑 3/3 绿）。
- **`bun run test:backend` 可以直接跑**（**订正于 2026-07-28**）：`1b8bdf2f` 已把 `build:history-search` 从它前面拿掉，它现在就是 `bun scripts/parallel-test.ts unit it http`。本文早先写它"跑不起来、请用 parallel-test 替代"——那条在写下时就已过期，两者是同一条命令。真跑 native history-search 才需要 `bun run build:history-search`（本机 rustup 未配默认 toolchain），相关测试已改为有产物才跑、没有则显式 skip。
- **`lint:all` 常年红**（400 errors，主要在退役的 `ui/`）。同样已推迟。

---

## 4. 工作方式：**后续改动一律在隔离 worktree 进行**（用户 2026-07-27 决定）

**how-to 不在这里** —— 见 skill `session-closeout` §6（交接与 worktree 分工的单一源）与 skill `git-preference:isolating-from-a-shared-git-worktree`。这里只记本轮为「在共享主树上作业」实付的代价，作为该决定的证据：

- 三份研究报告在提交前被并发会话的清理**从工作区抹掉**（原件恰好还在 `/tmp` 才救回，已提交）；
- 我对丢失层的结论被 peer 早 6 小时的 `883e0533` 推翻，因为在共享树上**很难察觉别人已经动过同一块**；
- 每次提交都要写显式 pathspec 绕开别人的脏文件，`eslint --fix` 得逐文件点名。

一句话结论：**代码进 worktree，本目录的交接/研究文档留主树即时提交**。

---

## 5. 给接手会话的纪律提醒（这一轮踩过的坑）

1. **`offsetMs` 是 commit 相对的**。我用它当"请求开始后 N ms"做归因，得出了错误结论并写进了给用户的报告，随后被 `synthetic` 标记字段推翻。**做时间归因前先确认时间基。**
2. **空的检索结果不能证明不存在**。判「帧有没有 synthetic 标记」时，先确认该投影**能**带出标记（我一开始看的投影根本不含该字段）。
3. **动手前先 `git log` 看 peer 有没有已经落地**。本轮 P0 的实质在我分析期间被并发会话落了。
4. **SCC 环守卫是真的会咬**：往 `sanitize/*` 里 import `state` 会把文件吸进 19 模块巨型 SCC。配置读留在装配层，解析结果向下传参。
5. **后端今天抖得厉害**，agent 中断了 4 次。**永远 `SendMessage` 恢复同一个 agent**，不换模型、不另派；并要求它**边写边落盘**。
