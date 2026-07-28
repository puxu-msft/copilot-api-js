# 交接：未完成工作与待裁决决策（2026-07-28）

**给接手会话**：本文是**当前未完工作的唯一入口**。上一份入口 [`2026-07-27-keepalive-and-separator/HANDOVER.md`](2026-07-27-keepalive-and-separator/HANDOVER.md) 仍是那条线的**背景与证据**来源（T1 已完成、其余条目正文仍有效），本文只接管「还剩什么、哪些需要你拍板」。

**基线（会很快过期，别当事实用）**：本文写于 2026-07-28。在 clean detached `1b8bdf2f` 上可复现的是 **6485 pass / 0 fail**，`typecheck` + `typecheck:ui-v4` 绿。（我最初在这里写的 6506 是**主树工作区**的计数——那里有并发会话未提交的新测试，把它当成该 commit 的基线是错的。同样的错误我也写进了 `2026-07-23-upstream-silence-recovery/plan-1-b1-widen-window.md`，已一并订正。）

> ⚠ **这个仓库的 master 移动得极快**——本文写完后不久，`1b8bdf2f..master` 已经是 **45 个提交**，当时主树 `test:backend` 已变成 6574 pass。（我一度在这里写「8 个提交」，那是我用 `git log | head -8` 看了个截断输出就当成了总数——**别重复这个错误：数数用 `git rev-list --count`，别用 `head`**。）所以：**别把上面的 hash 和测试数当现状**，动手前自己跑一遍：
>
> ```bash
> git log --oneline 1b8bdf2f..master   # 本文写完之后别人落了什么
> git worktree list                     # 谁在动哪条线
> bun run test:backend                  # 当前真实基线（history-search 需先 bun run build:history-search，否则相关 suite 会 skip）
> ```
>
> 本文里所有「当前是 X」的陈述都有同样的时效问题。凡是你要据以做决定的，**先自己核一遍**——本会话吃过两次亏：结论被并发会话已落地的提交推翻，以及「那条分支没人管」的判断在几小时内失效。

---

## 0. 先读什么

| 想动哪条 | 先读 |
|---|---|
| 任何 keepalive / 300s 死线的事 | `exp/silence-recovery-gates/FINDINGS.md` §「Q1 续测」+ §「Q1 附测」（三层超时的实测与归因）；skill `debugging-claude-client-connection` |
| T2（块间保活） | `2026-07-27-keepalive-and-separator/research-keepalive-options.md` §4.8/§4.10/§4.14；实验骨架 `exp/keepalive-escalation-wire/` |
| T3（合成分隔符） | 同目录 `research-separator-options.md`（18 方案 + 17 种 block type 逐型判定 + 探针设计） |
| T5（顺序不变量） | 同目录 `research-order-invariant-audit.md`（6 个发现全文，含每条的「谁能破坏它 / 可观测后果 / 建议守卫形态」） |
| 本轮改了什么、为什么 | 同目录 `review-merged-state.md`（合并态审查报告）+ `review-q1-preheader.md` |

**证据等级按标签对待**：这些报告标了「实测 / 源码读证 / 推断」，别把推断当实测。

---

## 1. 需要你拍板的六件事

每条给：**背景 → 选项 pros/cons → 我的建议**。建议是我的主观取舍，不是既定事实。

---

### D1【最该先定】T5 六个顺序不变量发现：做哪些、什么顺序

**背景**：审计出 6 处顺序/装配隐患。**严重级别分布 = 2 CRITICAL / 2 HIGH / 2 MED**；**性质上另分三类**——`#1`、`#2` 是**已经发生的漂移**（生产代码此刻就是错的），`#3`/`#4`/`#5` 是「今天对、但没东西拦住明天改错」，`#6` 是**假守卫**（有测试但测不到那条顺序）。两个维度别混读：CRITICAL 的是 #1/#4，已漂移的是 #1/#2。（2026-07-28 独立复核：#1、#2 在当前 master 上**仍然成立**，没有被并发提交修掉。）

| # | 严重 | 一句话 | 性质 |
|---|---|---|---|
| 1 | CRITICAL | Responses WS 缺 `if (acc.streamError)` 分支，上游 terminal error 被误判成 truncation → 发第二个合成 error + 1011 关闭，History 失败原因被改写、真实 error code/message 丢失 | **已发生的漂移** |
| 4 | CRITICAL | WS abort controller 必须在首个 `await` 前注册（注释自承 "correct-by-inspection"，对应过一次 4GB OOM） | 缺守卫 |
| 3 | HIGH | delayed-commit 的 `stream.onAbort` 必须先于首个 ping | 缺守卫 |
| 6 | HIGH | liveness 必须挂在 config/token middleware 之前；现有「缺 token 仍 200」测试走的是**没有该 middleware 的 test app**，等于没测 | 假守卫 |
| 2 | MED | `inspectRequest` 声称逐字镜像 `runRequest` S1–S3，漏了 `client.inbound` → 诊断端点会**静默撒谎** | 已发生的漂移 |
| 5 | MED | `createFullTestApp` 宣称镜像生产 server，但无 parity 守卫 | 缺守卫 |

**选项**

- **A（推荐）分两批：先修两条「已经错了」的（#1、#2），再补两条 CRITICAL/HIGH 的守卫（#4、#6）**
  - pros：#1 是线上此刻就在错判失败原因的缺陷，修它直接改善可诊断性；#2 让 `/api/debug/pipeline` 停止撒谎——**诊断工具撒谎的代价是误诊生产**，而本轮已经吃过「凭错误前提下结论」的亏。#6 的守卫形态**本轮已有现成 pattern**（见下方「白拿」），成本很低。
  - cons：#3、#5 留着，仍是注释守着。
- **B 全做**
  - pros：一次清干净。
  - cons：#5 要抽 `configureBaseApp(app, deps)` 共享装配，那是跨生产/测试的结构改动，值得单独一个工作单元，混在一批里会拖长且难审。
- **C 只修 #1**
  - pros：最小、最快。
  - cons：#2 的「诊断撒谎」和 #6 的「假守卫」都会继续误导后来者，而它们恰恰是最省事的两条。

**我的建议：A。** 顺序 **#1 → #6 → #2 → #4**，#3/#5 转 backlog。

> **白拿的部分**：#6 建议的守卫形态是「用真实 `createServer()` + 安装一个会抛/永不 resolve 的 token runtime，断言 `/health/liveness` 立即 200 且 mock 调用 0 次」。本轮为验证 ingress 接线**已经把真实装配骨架搭出来了**——见 `tests/anthropic/commit-window-ingress-deadline.http.test.ts` 里 `installTokenRuntime` + `createServer()` + finally-reset 那条测试。**可复用的是骨架，不是断言**：那条测试让 runtime 最终 resolve、打的是 `/v1/messages`；#6 需要的是**永不 resolve 或直接 throw** 的 runtime、打 `/health/liveness`、并显式断言 `ensureValidCopilotToken` **调用 0 次**且立即 200。#4 的守卫可复用同一 fixture 思路（受控 handler 让第一步就触发 `onClose`）。

---

### D2 `empty_text` 保活模式：删还是留

**背景**：上一轮把「删掉它」列为已批准任务，但**前提已经变了**。现状核实（2026-07-28）：默认是 `ping`，`empty_text` 仍是 schema 里的**合法可选值**，作为「常驻 content-delta 模式」保留；按需升级（`streamKeepaliveEscalateSec` 默认 200s）覆盖的是**默认路径**。所以它不是死代码，删它是**删掉一个用户可选的常驻模式**。

**爆炸半径（2026-07-28 `git grep` 实测，我最初把 `src/` 的数误标成「全仓」）**：生产源码 `src/` = **12 文件 / 45 行**；含 tests + `config.yaml` + `config.schema.json` = **37 文件 / 97 行**；整个 tracked tree（含历史 ADR/plan/记忆）= **98 文件 / 377 行**。真删时只有前两档需要改，历史文档保留不动——但估工作量别用 12/45 那个数。

**选项**

- **A（推荐）不删；是否把支持级别收窄为「research-only」另议**
  - **先分清事实与建议**：*事实*是它目前在 schema / `config.yaml` 里被公开描述为**用户可选的常驻模式**，有实装与测试（`tests/anthropic/keepalive-active-path.unit.test.ts` 正向证明它在 thinking/tool/text 开块下各产生对应空 delta）；*建议*才是「把它降级成研究/回退用」——**那需要同步 schema、`config.yaml`、README、ADR 之后再定，不能只改个注释**，否则用户配置面与支持承诺会不一致。
  - pros：ADR 2026-07-22 D2 的反转历史证明这个模式**被推翻过又被部分证明有效**（G2 实测空 delta 确实能保活，当时失效是我方吞帧）；留一个可切换的常驻模式，是排查「按需升级是否够用」时的对照臂。删了以后再想验证就得重写。
  - cons：45+ 处引用继续存在，anchor remap 那套机件（只有 `empty_text` 才需要）也留着，是真实的复杂度。
- **B 按原计划删**
  - pros：消掉 anchor remap 这条只服务单一模式的分支，代码面收窄；符合项目「无向后兼容负担」。
  - cons：**删的是能力不是债**——它现在有明确用途（常驻模式 + 对照臂）。且 B2 的 plan 里写着「三 keepalive 模式 wire contract 必须分支处理」，删掉会牵动那条**别人正在推进**的线。
- **C 先降级为不可配置的内部常量，观察一段时间再删**
  - pros：折中。
  - cons：既没收窄代码，又失去可切换性，两头不讨好。

**我的建议：A（不删）。** 这条我和上一轮的判断相反，但**不是擅自否决你的决定**：上一轮的交接原文写的是「用户已批准删除，**但先确认它现在还有没有被用**……若确认冗余：删」——**核验门是那次授权自带的**。核实结果是前提不成立（它没被 escalation 取代，只是不再是默认，两者语义不同：常驻模式从首个 heartbeat 起就发块感知空 delta，按需升级只在 content deadline 到点才注入）。所以这里是**核验门没过**，需要你重新拍板。**如果你要的是收窄代码面，真正的目标应该是 anchor remap 机件本身**，那要等 allocator 方案 A（别人在做）落地后一并处理。

---

### D3 T2：W3（首块已提交、块间无开块）的兜底手段

**背景**：`docs/DESIGN.md` 明写当前升级是 **pre-content-only**——首块提交后的无-open 窗口只发 ping，而 ping **不重置** CC 的 300s event-idle。所以 W3 仍是活的缺口、仍会在 300s 处死。并发会话的 `escalationScaffold` 是一种实现，但**没有实验证明它在真 CLI 下有效**。

**选项**

- **A（推荐）先做实验，不先做实现**
  - pros：骨架现成（`exp/keepalive-escalation-wire/`，改 hook 让静默发生在**块间**而非块内），配 skill `client-proxy-e2e-testing` 起真 CLI，离线零额度。验收判据明确：`[block0] → 静默 340s → [block1]`，两块内容全保、客户端不报 stall。**在知道现有实现是否已经够用之前做任何新实现，都可能是白做。**
  - cons：花时间但可能得到「现状已经够用」的结论（——那也是好结论）。
- **B 直接上 `content_block_stop` 延迟一帧**（把 W3 塌缩进 W2）
  - pros：机制最简单，不引入新帧型。
  - cons：改变块边界时序，可能影响 buffered/continuation 的接缝；**未经实验**。
- **C `message_delta` 心跳**
  - pros：合法协议帧、必定重置。
  - cons：**每发一次都会把整轮 input 成本再加一次**，污染 CC 的成本显示——这是用户可见的副作用。
- **D-i 复用**已经落地**的 allocator primitive，做最小 W3 接线**
  - **前提事实（2026-07-28 复核）**：`createAnchorIndexAllocator` **已经在 master 上**（`src/lib/anthropic/keepalive-anchor.ts:49`），但**没有接进 W3 那个站点**——`src/lib/pipeline/delivery/session.ts:127` 的注释仍写「no-open window needs the future monotone index allocator」。所以这不是「等别人」，是「接一条已有的线」。
  - pros：比 B/C 都直接，且不改协议语义、不引入成本副作用；一次到位地解决「首块后无 open block 时该用哪个 wire index」。
  - cons：**必须正面处理那条 plan 评审发现的 blocker**——`anchorsOpened===0` 的结构性短路会让 continuation 腿跳过 remap、复用主腿的 wire index 0，即索引冲突。最小接线同样可能踩它。
- **D-ii 等完整的 allocator 方案 A**（别人在推进）
  - pros：DESIGN 写的就是「完整覆盖等待方案 A」，一次做对。
  - cons：那条 plan 的跨模型评审曾判「1 blocker + 11 major」——**但那只描述最初那版 plan，不代表当前实施态**：2026-07-28 复核，`alloc-p1p2` 分支上 **P1/P2 已实现**（allocator 参数化、generation state、atomic allocation、leg tokens、delivery serialized ownership + 测试），只是尚未合并、还有未追踪的新测试、且落后 master 63 提交。**引用旧评审前先看分支现状**；期间 W3 继续在 300s 处死。

**我的建议：A，然后按结果走 D-i。** 先用实验确定 `escalationScaffold` 在真 CLI 下到底行不行——它可能已经把 W3 关了，那后面全不必做。若没关上，**优先 D-i 而不是 B/C**：B 改块边界时序、C 会重复计费污染成本显示，都是带语义副作用的载体，而 D-i 用的是本来就为此设计的 primitive。实验结果同时也是 allocator 那条线需要的实测输入。

---

### D4 T3 不可见 Unicode PoC：**做不做已经定了（你批过）**，待定的是分期与停止条件

> **订正**：我最初把这条写成「做不做」并给了一个「完全不做」的选项——**那是把你已经拍过的板又摆回去**。上一份交接 `2026-07-27-keepalive-and-separator/HANDOVER.md:131` 明标 `T3【用户已批】`，KICKOFF 也记着「用户已批准 T1–T4」，而且**没有新证据支持反转**。所以下面只问执行形状，不问要不要做。「维持可见 marker」是**任一门失败后的既定 fallback**，不是待选项。

**背景**：落点在 EMIT 轴的封闭 enum `SEPARATOR_CARRIERS`（`src/lib/anthropic/sanitize/block-layout-contract.ts`）。**迁移成本要说准**：历史数据零迁移（ACCEPT 轴继续识别旧值），但**加一个 `invisible_v1` 不是零改动**——`src/lib/config/schema.ts:443` 目前把 enum 硬编码成 `["marker_v1"]`、`config.yaml:791` 也显式配着它，还要同步 state default、生成的 schema、identity 测试与 DESIGN/ADR。

**待定的是：按什么顺序烧额度。** 权威门清单在 `research-separator-options.md:153-224`（本地 `.trim()` 筛选、visible 正控 + empty/space 阴控、独立 History 逐码点 wire oracle、目标模型 × stream true/false × ≥3 次、**删掉 separator 应恢复 C1 400** 的 mutation、SDK/CC round-trip、replacement glyph 与 usage/token 异常）。**我先前压缩成的「五道门」失真了**——把「HTTP 接受」和「wire 非 strip」并成一条、又把 mutation 写成「改一个字符能被检出」，那不是源报告的 mutation oracle（源报告要的是「删掉分隔符后 C1 400 应当回来」）。**以源报告为准，别用我那版。**

**选项**

- **A（推荐）漏斗式：本地 → mock → 单个便宜模型 → 再扩**
  1. 本地：`.trim()` 筛选（**报告里已经测过一轮**，U+00A0/U+FEFF 会被 trim 掉、U+200B 等不会）+ 我方 sanitizer/JSON/History 的逐码点保真；
  2. mock upstream + 真 SDK/CLI 的 round-trip（离线、零额度）；
  3. **单个便宜模型、non-stream**，跑正控/阴控/候选/mutation；
  4. 过了再扩：模型 × stream/non-stream × ≥3 次；
  5. 最后查 replacement glyph 与 usage/token 异常。
  - pros：**只有第 3 步之后才烧额度**，而前两步能否决掉大部分候选。
  - cons：步骤多，要按顺序推。
- **B 我先前推荐的「只先做门①（GHC 是否 strip）」**
  - pros：看起来最省。
  - cons：**成本判断是倒的**——真 GHC 请求已经是最贵的一步，而本地 trim 与 wire oracle 完全免费且能先筛掉一批候选。**不要采用这条**，列在这里只为说明它错在哪。

**我的建议：A。** 另外补一条源报告要求、我先前漏掉的**生产切换 gate**：History 的 clientRequest 原始轨 / upstreamRequest effective 轨，以及 `replacedStructuralEmpty`/`insertedSeparators` 必须可辨识——**不可见载体尤其不能靠肉眼确认**。

---

### D5 commit 窗口 clamp 240 是否放开

**背景**：本轮定的是「默认 180 / clamp 240」，依据是**客户端没设 `API_FORCE_IDLE_TIMEOUT`** 时 pre-header 上限 ~300s。但实测确认：客户端设 `API_FORCE_IDLE_TIMEOUT=0` 后，那个 300s 整个消失（静默 600s 仍单次干净成功）。**如果你给自己的 CC 设了这个变量，240 这个 clamp 就变成我方的限制、而不是客户端的。**

**选项**

- **A（推荐）维持 240 不动**
  - pros：默认路径的保护优先；clamp 的意义就是拦住「配了会打破客户端」的值。你目前没有配到 240 以上的需求。
  - cons：真要配大时会被自己的 clamp 挡住，届时要改代码。
- **B 放开 clamp（比如提到 1100，留在 SDK 的 1200s request timer 之下）**
  - pros：给设了 env 的用户完整空间。
  - cons：**没设 env 的客户端会被静默打破**——clamp 从「保护」退化成「摆设」，而这正是它存在的理由。
- **C clamp 变成条件式：检测到请求带 CC 特征就用高上限，否则用 240**
  - pros：两头兼顾。
  - cons：**这条做不到**。实测对照证实：设了 `API_FORCE_IDLE_TIMEOUT=0` 与没设的两次请求，wire 上**逐项相同**（同 `user-agent` / `x-app` / runtime / `x-stainless-timeout:1200`，只差 `host` 与随机 session id）——见 `exp/silence-recovery-gates/results/q1-firstfail/env-force-idle-0.observations.json` 与 `env-control-unset.observations.json`。精确表述是：**请求 wire 不携带该设置；在 240s 这个 clamp 决策点之前没有可靠信号**（>300s 仍存活只是事后现象，且不能唯一归因于该 env）。
- **D 保持默认 clamp 240，另加一个显式的高上限 opt-in 配置键**
  - pros：**不需要探测客户端**，也不把默认保护退化成摆设——默认路径仍被 240 挡住，只有明确写下「我知道我在做什么」的人才拿到更高上限；这是长期形状上最正确的一个。
  - cons：新增配置键要同步 schema / hot-reload / 诊断可见性 / 验收，是一个独立工作单元；在你还没有 >240 的需求之前是纯预支。

**我的建议：A（现在不实现）。** 但要说清：**A 并不是「唯一能保护默认路径」的选项，D 同样能**——我只是认为在你没有 >240 的实际需求前，D 属于预支。等你真需要时，**正确的做法是 D（显式逃生键），不是 B（抬高 clamp）**。

---

### D6 非 Claude Code 客户端的暴露面

**背景**（本轮新增，已入 `docs/todo/deferred-backlog.md`）：`stream_commit_after_sec` 对**所有** Anthropic 流式请求一视同仁，但窗口的安全上限只在**两个 Node 客户端**上实测过（真 CC 2.1.220、`@anthropic-ai/sdk` on Node，都是 ~300s 因为都落在 undici 默认 `headersTimeout`）。窗口内我方一个字节都不发，所以 **pre-header 容忍度落在 `(20s, 180s)` 的任何 Anthropic 客户端，都被这次默认值改动打破了**（旧默认 20s commit + keepalive 能活）。Python / Go / Java / Ruby 官方 SDK、第三方工具、中间反向代理、用户自设短 timeout，**均未测**。

**选项**

- **B1（推荐）立刻把未知客户端退回保守值，可识别且已实测的走 180s**
  - pros：**不需要先知道任何其它 SDK 的秒数就能做**——这是它相对下面几条的决定性优势。backlog 里已经提出 `unknown_client_commit_after_sec`（`docs/todo/deferred-backlog.md:23-27`）。可识别集就是已实测的两个（CC 的 `x-app: cli` + `user-agent: claude-cli/*`；Node SDK 的 `x-stainless-runtime`），其余一律 20s，回到改动前的行为。
  - cons：引入客户端识别这一层（虽然只是两条 header 判据）；识别不到的 CC 变体会退回 20s，失去本次收益。
- **B2 保留全局默认，但允许显式的 per-client / per-route commit-window profile**
  - pros：能覆盖 B1 覆盖不到的两类——**用户自设短 timeout**、**中间反向代理**，这两类靠 header 识别不出来。
  - cons：新配置面，且要用户知道自己该配什么。
- **B3 先补测量，再据测量扩大 allowlist**
  - pros：证据驱动。
  - cons：**这条不能单独成立**——`run-q1-firstfail.sh` 只是个单臂选择器（现有 `cli|sdk|bare-fetch` 三个 runner **都是 Node**），本机**没有 python 的 `anthropic` 模块，也没有 go/java/ruby**。**加第一个 Python 臂本身就是一个完整的 PoC 工作单元**（隔离依赖 + 版本锁 + runner + stream 消费 + timeout 配置 + 结果规范化），多语言矩阵更不是一行改动。而且**一个 Python 样本只能关掉「Python 默认」这一格**，关不掉这条 backlog。（server/launcher/观测那套确实可复用，且全离线零额度——这点成立。）
- **C 什么都不做**
  - pros：你实际只用 CC。
  - cons：哪天接了别的客户端会撞上，症状是「请求在收到任何字节前超时」，很难联想到是代理的窗口默认值。

**我的建议：B1 先落地，B3 作为后续扩 allowlist 的输入，B2 视是否真的出现代理/自设 timeout 场景再说。**

> **两处我先前写错、已删**：① 我说「加一个官方 SDK 臂成本很低」——不成立，见 B3 的 cons；② 我说「多数语言默认 HTTP 栈很可能也是 ~300s，这条可能自动消解」——**那是没有证据的猜测**，不同 SDK 可能有各自独立的 connect/read/request timeout 或根本没有总 timeout。别拿它当决策依据。

---

## 2. 不需要裁决、可以直接做的

- **T6 残留**：`.codex` 空文件**已经不在了**（本轮核实），此项作废。`docs/DESIGN.md` 的 pre-content-only 表述**是准确的**（与 D3 一致），无需改。
- **两条 load-sensitive 测试**：`tests/architecture/telemetry-domain-surface.unit.test.ts`（已给 30s 预算）与 `tests/history/v3/canonical-performance.unit.test.ts`（**未处理**，并行负载下会假红、单跑 3/3 绿）。后者值得给个预算或改判据。
- **History 详情页 upstream 轨的时间基**（本轮新增 backlog）：forwarded 轨已修（改用持久化的 `streamOpenMs`），**upstream 轨的 offset 原点没追出来**。若持久化记录里没有可证明的原点，该轨应只显示 elapsed 或显式「绝对时间不可用」，**不要继续伪造绝对钟点**（已有 `offsetSource === "unavailable"` 的先例可复用）。

---

## 3. 别人的地盘（别抢）—— 以及「活跃」这个词的陷阱

本仓库常有并发会话。**先量再判**，别看 worktree 名字就下结论：

```bash
git worktree list
for w in .worktrees/*; do                       # 逐个量落后/领先与脏状态
  echo "$w $(git -C $w branch --show-current) $(git -C $w rev-list --left-right --count master...HEAD)"
done
git log --oneline master..HEAD                  # 注意是 master..HEAD，不是 `master ..`
git merge-base --is-ancestor <tip> master && echo "已被 master 吸收"
```

**2026-07-28 实测快照（会漂，按上面的命令自己重量）**，格式 `落后/领先`：

| worktree / 分支 | 落后/领先 | 判断 |
|---|---|---|
| `upstream-silence-recovery` | 63 / 23 | **真活跃**：B2。**下一步不是 Task 0.6**——plan 自述 Task 0.1–0.7 已完成、crash guard 已做，真实下一阶段是 **plan-3 的 P4/P5 生产接线**（外加 fresh recovery 的 operation-scope join）。**零生产接线**，且落后 master 63，接手前先重读底座 |
| `alloc-p1p2`（`feat/anchor-allocator-p1p2`）、`anchor-flaky` | 各 63 / 16 | **真活跃**：allocator。**P1/P2 已实现**（参数化、generation state、atomic allocation、leg tokens、delivery serialized ownership + 测试），alloc-p1p2 还有未追踪新测试；**「1 blocker + 11 major」只描述最初那版 plan review，不代表当前实施态**——引用前先复核 |
| `refusal-diagnostics` | 5 / **0** | **非活跃**：tip 已被 master 吸收，可清理 |
| `repetition-truncation` | 306 / 1 | 陈旧 |
| `history-cas-stage` | 999 / 20 | 陈旧（自述已 landed） |
| `shadcn-redesign` | 1615 / 10 | 陈旧，另有 13 个未追踪报告 |
| `feat-activity-detail-outline` | 2927 / 52 | 极陈旧，有未追踪 prompt |

> ⚠ **别照抄我最初写的「各自独立、无重叠」——那句是错的。** 落后上千提交的分支不能凭名字断言不重叠，尤其 UI 与 history 那三条会和当前 History/UI 改动相交。**判重叠要 `git merge-base` + 改动路径求交，不是看 worktree 列表。**

`docs/memory/` 下常有别的会话的未提交改动。**改 `MEMORY.md` 用 `git hash-object` + `git update-index` 只暂存自己那一行**（本轮用过三次），别整文件 `git add`。

## 4. 本轮踩过、值得你避开的坑

1. **绿了不算数，mutation 不咬更要警觉。** 本轮两次写出假绿测试：① 断言被 `remaining > 0` 短路条件满足，改回错误实现照样绿；② 测试自己复制了生产的中间件，删掉生产接线仍全绿。**两次都是把修复改回去才发现的**——写完守卫务必反向验证一次。
2. **worktree 里的红可能是环境噪声。** `native/history-search/*.node` 是 gitignored 产物，新建 worktree 里没有 → 在其中跑测试会红一片。我据此把 14 条失败归因成 rustup toolchain，**结论对但推理错**。判据一条命令：`git check-ignore <产物路径>`。**交付前的全量回归在主树跑。**（2026-07-28 起该产物已默认不构建、相关测试改为可用性门控，这类红不会再出现。）
3. **现在有两个时钟并存，别混用（本轮新增的坑）。** `sseEvents[].offsetMs` 仍是 **commit 相对**（`client-sink.ts:216` 的 `Date.now() - streamStartMs`，本轮没动它），而 **delayed-commit 窗口本轮改成了 ingress 相对**。也就是说 `commit 时刻 ≈ startedAt + streamCommitAfterSec` **这个等式现在不成立了**——commit 时刻要读持久化的 `entry.timing.client.streamOpenMs`，因为窗口会扣掉 pre-handler 已耗时。上一轮据旧等式做归因得出过错误结论；本轮又发现 UI 踩同一个坑（被默认值 20s→180s 放大到约 3 分钟，已修 forwarded 轨）。**做任何时间归因前先确认是哪个时钟。**
4. **别信配置层自称的超时数字。** CC 头里写 `x-stainless-timeout: 1200`、SDK 设 1250s、源码里是 600s——**三个都没触发**，真正掐断的是下一层 undici 的 300s 默认。逐层剥离 + 看错误 cause 才是归因法。
5. **后端抖动时永远 `SendMessage` 恢复同一个 agent**，不换模型、不另派；并要求它**边查边落盘**（本轮两个评审 agent 各中断一次，第一次丢了完整报告）。
6. **动手前先查 peer。** 本轮有两处结论被并发会话已落地的提交推翻；也有一条「那条分支没人管」的判断在几小时内失效。

---

## 5. 建议的起手顺序

若你不另行指定，我会按：**D1 的 #1 → D3 的实验 → D4 的本地/mock 前两级 → D1 剩余（#6/#2/#4）→ D6 的 B1 → D2 决定**。

理由：
1. **#1 是此刻就在错判失败原因的生产缺陷**，最该先修。
2. **D3 的实验离线零额度**，且可能直接证明 W3 已被 `escalationScaffold` 关上——先做能避免白做后面的实现。
3. **D4 的前两级（本地 trim + 逐码点 oracle、mock upstream 的 SDK/CLI round-trip）同样零额度**，能在烧任何额度前筛掉候选；T3 本身你已批过，不需要再等裁决。
4. D1 剩余三条里 **#6 成本最低**（本轮已有真实装配骨架可复用）。
5. **D6 的 B1 不依赖任何补测**就能落地，把未知客户端退回保守值。
6. D2 牵动别人正在推进的 B2 线，放最后。

> ⚠ 这个顺序里**没有**「D6 的补测」——我先前把它排在前面，理由是「可能自动消解」，那个理由已被删除（见 D6 的订正）。
