# Claude 异模型对抗评审：inter-block >300s keepalive carrier 对比设计

- 评审对象：[2026-07-27-inter-block-keepalive-carrier.md](2026-07-27-inter-block-keepalive-carrier.md)（commit `36496c1a`，分支 `fix/client-proxy-keepalive-300s`）
- 评审人：Claude 驱动 reviewer（独立对抗；被审文档由 GPT 驱动 debugger 撰写，异模型交叉）
- 日期：2026-07-27
- 裁判轴（调用方指定，非 ROI/YAGNI）：长远正确 + 完整；架构健康 > 回归风险；绝不因工程量大把正确方案降级为可选
- 追加约束（用户 2026-07-27）：**不接受流式、也不接受整响应缓冲；可接受的设计空间只有「块级 buffered」，且这是既定终态**

## 总体 verdict

**存在 blocker（针对「本文档能否作为用户裁决依据」）：2 个。技术方向（推荐 A）经我独立复核后**支持**；但文档中两条承重论证是错的或制度错配，会让用户按错误量级取舍——必须修订后再交用户。**

- blocker：2（均为「事实/量级错误会改变用户取舍」，不是「A 选错了」）
- major：6
- minor：3
- nit：1

**一句话**：推荐 A 正确，但文档的理由体系有一半站不住——它把 C 的缺口低估了一个数量级（在「块级 buffered 是终态」前提下，C 不是「缺一个窄角落」，而是「首块之后完全没有保活」），并把 B 的致命伤写成了一条**会被复核者当场证伪**的机制（真实机制更硬、方向相同），同时没有穷尽载体方案面（项目铁律 `one-option-or-the-best-option`）。

## 双视角覆盖证据

### 机械核对（扫描 / 对账 / 查证）

1. 逐行读完被审文档全文（263 行）+ 4 份配套：G2 根因 todo、两轮 GPT 代码审、ADR `2026-07-22-continuation-retry-sequential-anchor`、姊妹 plan `plan-1-sequential-anchor.md`。
2. 逐处核对文档引用的代码断言：`src/lib/anthropic/keepalive-anchor.ts`（allocator :49-62、injector 首个 await 前同步翻 state :241-249、`remapAnthropicBlockIndex` :137-153）、`src/lib/pipeline/driver.ts`（`flushBufferedFrames` :1104-1166、remap :1152、boundary commit :1247-1308、retreat :1197-1210、terminal drain :1343-1366、重试门 :1373）、`src/lib/pipeline/delivery/session.ts`（tick :110-164、content 升级 :119-138、`applyPendingFrame` :166-175、`write` :74-85）、`src/lib/anthropic/live-reconcile.ts:107-143`、`src/lib/codec/anthropic/commit-boundaries.ts:16-24`、`src/routes/messages/handler-v4.ts:1000-1103`。
3. 查证「今天的生产递送模式」：`src/lib/state-defaults.ts:79` `protectStreamingGeneration: false`、仓库 `config.yaml:771` 同值、用户实际 `~/.local/share/copilot-api/config.yaml`（54 行，仅 `model_mappings`/`timeouts`/`history`，**未覆盖任何 keepalive / protect / buffered 键**）→ Anthropic 现网走 **live 流式**。
4. 第一手读客户端权威语义（不转述 GPT 审）：`~/.claude/refs/claude-code-2.1.207/app.pretty.js:298198-298203`（`ping` 在 watchdog reset 前 `continue`，其它事件才 `he()`）、`:298301-298310`（每个 `content_block_stop` 就 yield 一条 assistant 消息）、`:293787`（对其 tool_use 立即 `it.addTool`）、`:291016` + `:291022-291028`（`addTool` → `status:"queued"` → `processQueue()` → `executeTool()`）、`:298250-298283`（`content_block_start` 建 `Pn[index]`；`content_block_delta` 查 `Pn[index]`；`content_block_stop` **不删** `Pn[index]`）。
5. 核对记账 SSOT：`docs/plan/2026-07-22-max-tokens-continuation/plan-Q5-three-way-overlap.md`（round-2 修订已确认两层 remap 是**链式**、`wireDeliveredBlocks` **不含 anchor**）——被审文档**未引用**它。
6. 核对「anchor 会不会污染续写 assistant 前缀」：anchor 帧走 `sink.writeAnchor`（`keepalive-anchor.ts:235/261`）绕过 buffer，而 `extractCommittedBlocks` 只吃 buffer 快照（`driver.ts:1286/1306`）→ **不会**。这条风险不成立，明确写出以免后续评审重复怀疑。

### 第一人称执行模拟（走流程 / 分支 / 用户路径）

1. 扮演「块级 buffered 下的客户端」：写探针 `/tmp/probe.test.ts` 直接驱动 `runResponseBufferedSink` + `commitBoundaries=content_block_stop`，交错打印「上游产出 / 客户端收到」，实测输出——

   ```text
   upstream:message_start / upstream:content_block_start / upstream:content_block_delta ×2 / upstream:content_block_stop
   client:message_start / client:content_block_start / client:content_block_delta ×2 / client:content_block_stop
   ```

   即客户端第一帧出现在上游 `content_block_stop` **之后**：**块级 buffered 下，客户端轨在提交边界之间永远没有 open block。**
2. 扮演「保活升级 tick」：沿 `delivery/session.ts:110-138` 走 buffered 场景——首块提交后 `pendingOpenBlocks` 恒为空 → `contentFrame`（原-index 空 delta）分支**永不触发**，每次升级都落到 scaffold 分支（正是第二轮 GPT 审的 blocker 分支）。
3. 扮演「运维 / 用户」：用真实 History **只读** 复算暴露面——8000 条 Anthropic 记录（2026-07-25 → 07-27，2.5 天），按**客户端轨** `clientResponse.sseEvents`（含 ping 与 `offsetMs`）逐条算最大客户端可见事件间隔，并按该时刻是否有 open block 分类。
4. 扮演「A 的实现者」：把 allocator 接进 continuation 腿走一遍 index 记账，构造出具体撞车序列（F5）。
5. 扮演「B 的实现者」：沿 buffered flush + 三条终局路径 + live 腿走一遍 pending-stop fence，核对文档的改动清单完整性（F8）。
6. 扮演「下一轮对话的客户端」：把 A 注入的空 text block 沿「客户端历史 → 下一轮请求 → 上游校验」走一遍（F4）。
7. 扮演「载体设计者」：把「无 open block 的窗口里还能合法塞什么」穷举一遍，得到 4 条文档未列的候选（F10）。

---

## 事实性发现

### [blocker-1] §5.2 / §6 — 在「块级 buffered 是终态」前提下，C 的缺口不是「窄」而是「首块之后全无保活」；文档列的三条「不是 C 的缺口」有两条为假

**问题**：§5.2 断言在全面 buffered 下，「block 已 open 后内部静默 → 原 index 空 delta 覆盖」「大 tool_use input 生成 → 只要 tool_use block 仍 open 就能发空 `input_json_delta`」都不是 C 的缺口。这两条把**上游轨的 block open** 当成了**客户端轨的 block open**。块级 buffered 的定义就是「块闭合前客户端看不到该块任何字节」，所以上游正在生成的块**在客户端轨上根本不存在**，谈不上 open。

**证据**：

- `driver.ts:1219` 非边界帧只 `buffer.push`；唯一的 `sink.write` 在 `flushBufferedFrames`（:1139-1157）；边界谓词是 `content_block_stop`（`commit-boundaries.ts:16-24`）→ 一个块的 start/delta/stop 在**同一次 flush** 原子写出。
- 保活侧读的是**已写到 sink 的帧**：`applyPendingFrame` 只在 `write()` 内被调用（`delivery/session.ts:74-85, 166-175`）→ `pendingOpenBlocks` 是客户端轨状态。
- 第一人称实测（上文探针）直接看到客户端在 stop 前一帧不收。
- 因此沿 `delivery/session.ts:119-138`：buffered 下首块提交后（pre-content anchor 已在首个真实块前被 `closeAnchorBeforeReal` 关掉，`driver.ts:1147`）`pendingOpenBlocks.length === 0` 恒成立，`contentFrame` 分支死掉。

**影响**：C 在终态下的真实缺口 = **首块提交之后的任何 >200s 客户端可见静默**，而其主要成分恰是文档说 C 能覆盖的两类（长 thinking、大 tool_use 生成）。§6 表格「C：一致但不完整」与 §7 第 5 点「C 的生产暴露面目前看较窄」的量级判断因此失真。

**建议**：§5.2 判据改成「**客户端轨**是否有 open block」，并按 live / buffered 两制度分别列缺口（终态只需 buffered 列，live 列作为历史对照）；§6「完整覆盖」行 C 列改为「否（终态下退化为：首块后全无保活）」。另建议全文术语 `inter-block` 改为「无客户端可见 open block 的窗口」——在块级 buffered 下现名会持续误导（上游块内静默也落在这个窗口里）。

### [blocker-2] §2.1 / §5.2 — 暴露面样本取自 **live 流式**制度，却用来给**块级 buffered 终态**的方案定优先级；两制度对同一段物理静默的载体需求相反

**问题**：§1 判据 2 已把「基于块级 buffered」列为冻结前提，§5.2 也写「在全面 buffered 下」，但校准用的 100 条 History 全部产生于**今天的 live 路径**（`state-defaults.ts:79` = `false`，用户 config 未覆盖；ADR D4 的「全端点块级」对 Anthropic 尚未翻默认，姊妹 plan P1 收口明文写「默认不翻，留 P7」）。

**独立复算（比文档样本大 80 倍）**：8000 条 Anthropic 记录（2.5 天，只读 `GET /history/api/entries*`），按客户端轨最大事件间隔分类：

| 分类（最大间隔发生时客户端轨是否有 open block） | 条数 |
|---|---|
| pre-content（首帧前静默） | 17 |
| open-block（客户端已见 open block） | 16 |
| 真 inter-block（前块已闭合、下块未开） | 2 |

- >300s：12 条；>200s：35 条；>150s：68 条（同期总量 8000）。
- 真 inter-block 最长 130.7s（`req_1785014904543_817`）与 65.9s（`req_1785164449446_4456`）→ **该协议状态在生产里已是常态，只是尾部还没越过 300s**。
- 两条 300.0s 的 open-block 静默（`req_1785177872790_5500`、`req_1785176396642_5257`）均以 `aborted` 收场（309s / 307s）——CC 300s watchdog 掐断的现场。
- 我逐帧核了文档点名的 `req_1785177872790_5500`：客户端轨 `content_block_start@1(tool_use)` 在 **6ms** 就已转发，随后 15 个 ping、300.0s 无任何 content delta。文档把它归为「已 open block 内静默」**归类正确**——但这个 open 完全来自 live 逐帧转发。

**结论（回答调用方的核实请求）**：**调用方的推理成立，且有数据支撑**。这 16 条 open-block 样本在块级 buffered 下会**全部**变成无-open-block 样本（客户端在块闭合前收不到 `content_block_start`）。文档用「live 制度下 inter-block 罕见」支撑「buffered 制度下 C 的缺口窄」，两边不是同一个统计对象——**C 的采样确实测的是另一个世界**。需要补充的精确化有两点：① 迁到 buffered 后，其中一部分（首块尚未提交前的长生成）会落回 **pre-content** 窗口，仍被 C 的单 anchor 覆盖；真正丢失覆盖的是**首块提交之后**的长生成；② 因此 C 的评级不是「暴露面小」而是「**覆盖率随请求块数下降**——单块响应仍安全，多块长响应逐块失守」。这一区分不改变结论方向（C 降级），但比「inter-block 变常态」更准确、也更好验收。

**建议**：§2.1 每条样本注明制度；§5.2 只保留 buffered 终态的缺口分析（live 数字作历史对照并标注「已不代表终态」）；把上表与 12/35/68 三个计数直接并入文档。

### [major] §4.3 / §7 第 4 点 — 「Claude Code 的工具执行发生在完整 assistant turn 之后」是**错的**；B 推迟工具执行的结论对，但按文档的机制反而推不出该结论

**问题**：文档写「CC 的工具执行发生在完整 assistant turn / `stop_reason:tool_use` 后，而 `message_delta/message_stop` 又必须在 pending stop 后，所以延迟 stop 会把工具可执行时机推迟到下一帧或终局」。前后半句互相抵消：若工具必须等整轮结束，而 pending stop 会在 `message_delta` 之前**同批**补发，则 B 对工具执行的延迟 ≈ 0，§7 第 4 点「对 tool 执行引入最坏 300s 的真实用户可见延迟」就不成立。任何按文档机制复核的人都会得出「B 的核心代价不存在」。

**证据（第一手读 CC 2.1.207 打包源码）**：CC 是 **eager per-block 工具执行**——

- `app.pretty.js:298301-298310`：每个 `content_block_stop` 就地构造一条只含该块的 assistant 消息并 `yield`；
- `:293787`：`if (!z.abortController.signal.aborted) for (let yl of Ii) it.addTool(yl, _i)`，对刚 yield 的消息里的 tool_use 立即入队；
- `:291016` + `:291022-291028`：`addTool` 以 `status:"queued"` 入列后**立即** `processQueue()`，后者对 queued 项直接 `await this.executeTool(e2)`；
- 佐证：同类里存在 `discardAndAbortInFlight`（区分 `executing` / `queued`）与 `"Streaming fallback - tool execution discarded"` 分支，说明工具确实可能在流结束前就已 `executing`。

即**工具在 `content_block_stop` 到达时就开始执行**。B 扣住 stop = 工具执行被推迟整段 gap——文档**结论正确、机制写反**。

**建议**：§4.3 该段换成上述机制 + 行号；§7 第 4 点的「除非 PoC 证明 CC 在 stop 前就可安全执行 tool（现有 SDK/agent-loop 结构不支持这一预期）」改为「其反面已被第一手证伪：CC 在 stop 即执行，故 B 的工具延迟是**确定的**，无须 PoC 才能判定」。这条修订**加强**否决 B 的力度，同时移除一个会被当场推翻的错误前提。

### [major] §3.5 / §3.7 — A 与 ADR D2 第 1 点（「空 text block 是错误形状」）的冲突未记账；空 anchor 块的**多轮回传**路径完全未测

**问题**：ADR D2 退役 `empty_text` 的两条理由中，「G2 证载体无效」已于 2026-07-27 撤销，但**「平时注入空 text block 是错误形状」被明确保留**（ADR :27/:37）。A 把这个被保留的判据从「pre-content 至多一次」放大到「每个 gap 一次」，而 §3.5 只写「UI 通常不可见，但结构可观测」，未与 D2 对账。

更实际的是**回传**风险：CC 会把 assistant turn（含空 text block）写进对话历史，下一轮原样发回上游；Anthropic 系上游对请求内空 text content block 有已知校验，而本仓库**没有入站空 text block 清洗**（`src/lib/anthropic/request-preparation.ts` 无相关处理，全仓 grep 未见）。现有全部真 CC 证据（315.5s ×3、sequential PoC）都是 **numTurns=1 单轮**，多轮回传路径**从未走过**。

**已核实为不成立的相邻担忧**（写出以免重复怀疑）：anchor 帧不会进续写的合成 assistant 前缀——见「机械核对」第 6 条。

**建议**：§3.7 失效条件增列「客户端把空 anchor 块回传上游导致下一轮 400」；§3.6 oracle 增列 **numTurns≥2 真 CC 多轮**（第一轮触发 gap anchor，第二轮携历史回上游）。若实测确认被拒，A 需同时提供「anchor 载体改为非空但不可见内容」或「入站清洗空 text block」的兜底——两者属于 A 的**必要**范围，不是可选。

### [major] §3.4 — A 的 continuation 记账只写了方向、没写失败模式，且未引用该记账的 SSOT

**问题**：§3.4 写「continuation 当前用 `wireDeliveredBlocks` 接续 index；多 anchor 加入后必须统一成 allocator frontier」，方向对，但没给失败模式——而这正是「一处漏改即协议损坏」的高危点。具体：`realBlockOffset(upstreamIndex)`（`keepalive-anchor.ts:60`）用 `realWireIndices[upstreamIndex]` 查表，而**续写腿的上游 index 从 0 重启**，会命中主腿留下的旧映射。

**失败序列（按当前代码逐层套）**：`anchor@0 → real@1(上游0) → gap-anchor@2 → real@3(上游1)`，随后进入续写腿，其首块上游 index = 0：

1. 第一层 `anchor.remap(frame, realBlockOffset(0))`：`realWireIndices[0] = 1` → offset 1 → wire 1；
2. 第二层 `continuation.remap(_, continuationOffset)`，`continuationOffset = wireDeliveredBlocks = 2`（`driver.ts:1156` 只对真实块递增、不含 anchor）→ wire **3**；
3. wire 3 已被 `real@3` 占用 → 重复 index，与本轮 blocker 同型故障。

**建议**：§3.4 写入该序列，并引用记账 SSOT `docs/plan/2026-07-22-max-tokens-continuation/plan-Q5-three-way-overlap.md`（其 round-2 修订记录明确两层 remap 是**链式**、`wireDeliveredBlocks` **不含 anchor**——第一版曾在此判断错误，是本仓库现成教训）。目标不变量应写成：**wire index 的唯一权威是 allocator frontier；`anchorShift` 与 `continuationOffset` 两个独立偏移必须被 frontier 取代，而不是继续叠加。**

### [major] §3.5 / §7 第 1 点 — 「短请求零 wire 变化」成立，但代价没写：A 把今天的**死路径**变成**每请求热路径**，记账错误的爆炸半径从「升级过的请求」扩到「全部请求」

逐条核实调用方指定的第一项（A 的四点宣称）：

| A 的宣称 | 复核结论 |
|---|---|
| 完整覆盖三类静默 | **成立**，且在块级 buffered 终态下比文档说的更必要（见 blocker-1） |
| 及时 tool 执行 | **成立**，且现在有 eager 执行的机制证据支撑（见 F3），比文档原有理由更硬 |
| 短请求零 wire 变化 | **成立但有条件**，见下 |
| generation 级协议所有权 | **成立且被低估**，见「主观建议」第 1 条 |

**「零 wire 变化」的复核**：`createAnchorIndexAllocator` 的 `wireCounter` 从 0 起；全程无 anchor 时真实块依次拿 0,1,2…，`realBlockOffset` 恒 0，而 `remapAnthropicBlockIndex`（`keepalive-anchor.ts:138`）在 `offset === 0` 时**原样返回** frame → 逐字节不变。GPT 审也实测 escalate 0/200 两流 SHA-256 相同。**结论成立。**

**但文档没写这个「不变」的性质变了**：今天 remap 被 `injected && anchor && anchorBlockOpen` 三重门挡住（`driver.ts:1152`），未注入 anchor 时整条 remap 是**死路径**；A 之后 offset 由 allocator 运行时记账给出，等价于「每个请求都在跑 index 记账」。任一处 `onRealBlockOpen()` 漏调 / 重复调（§3.4 已列 recovery / continuation / retreat 三条可能重复的腿）受害的不再只是升级过的请求，而是**普通短请求**；且症状是静默错位——第二轮 GPT 审的真 SDK probe 已证重复 index 会让 SDK **重排** content（`first, second, empty-anchor`）而非报错。另外 `ping` 模式 + `escalate>0` 下 `anchorHooks` **也会被构建**（`handler-v4.ts:1062-1063`），所以 A 之后 anchor 分支对绝大多数生产请求都是「活的」。

**建议**：把「零 wire 变化」从**记账正确性的推论**升级为**结构性保证**——在 allocator 上暴露 `anchorsOpened === 0 → 完全旁路 remap` 的短路（或让 `realBlockOffset` 在无 anchor 时返回常量 0 并由断言锁死），使「从未开过 anchor 的请求，代码路径与今天同构」成为可被单测钉死的不变量；§3.6 补正/负样本对照（开过 anchor 必须走记账、没开过必须走短路）。

**是否偏袒 A**：**没有明显偏袒**。文档对 A 的自陈风险（§3.4 五条 + §3.7 三条）比对 B/C 都严厉；它的偏差不在偏袒 A，而在**低估 C 的代价**与**给 B 写错否决理由**，两者同源——把上游轨的 block 状态当成了客户端轨的。

### [major] §3.4 — A 的并发缝（心跳 out-of-band 写 vs driver flush）未被点名，而这正是本仓库踩过的同类坑

**问题**：§3.4 只写「allocator 更新必须与实际成功 wire write 同步」，未指出**谁在并发更新它**。gap anchor 由 delivery 心跳 tick 异步注入（`delivery/session.ts:120-138` → injector），真实块由 driver flush 写出，两者共享 allocator。`suspendHeartbeat`（`driver.ts:1260`）只清定时器、**不等待在飞的注入**；现有代码正是靠 injector「首个 `await` 前同步翻 state」躲开该 TOCTOU（`keepalive-anchor.ts:241-249` 的长注释即此教训）。A 引入的是**带返回值的分配动作**（`nextAnchorIndex` → `onAnchorOpen`），比布尔翻转更难原子化。

**建议**：§3.4 增加硬约束——**index 分配必须发生在 delivery serializer 内部（与写出同一临界区），或沿用「首个 await 前同步分配 + 提交」模式**；§3.6 补并发 oracle（fake clock 让 tick 恰落在 flush 的 `await sink.write` 让点上，断言无重复 / 无跳号）。

### [major] §4.2 / §6 — B 的「不是局部修改」结论成立（我独立走过 flush 路径），但改动清单**漏了 live 腿**，两方案的改动面不是同一基准

逐条核实调用方指定的第二项：

- **「不是局部改一行 predicate」成立**。沿 buffered 路径走：commit 边界谓词是 `content_block_stop`（`commit-boundaries.ts:16-24`），driver 在边界处把 buffer **连 stop 一起** flush（`driver.ts:1247-1292`），紧接着 `committedAny = true`（:1295）并喂续写 ledger（:1306-1308）。要扣住 stop，必须同时改帧切分、`committedAny` 语义、ledger 的「已提交」定义，以及 §4.2 列出的三条终局路径。**文档这一段经得起复核，不是草率否决。**
- **清单漏了 live 腿**：today 的生产路径就是 live（blocker-2），live 的 stop 由 `reconcileLiveFrame` 逐帧透传（`live-reconcile.ts:107-143`），B 要在 live 生效必须再写一套 pending-stop fence（含 `isErrorEvent` / `isMessageTerminator` 两个既有 close-off 触发点的顺序重排）。而 A 的清单**包含** `live-reconcile.ts`（§3.2 第 6 项）。
- 方向说明：补上 live 腿只会让 B **更贵**，不改否决结论；但对比表若要当量化依据，基准必须一致。（若用户已决定终态永久块级 buffered，则可反过来声明「live 腿不再是产品状态」——但那要**显式写**，不能默认省略。）

**建议**：§4.2 补 `src/lib/anthropic/live-reconcile.ts` + `src/routes/messages/streaming-pump.ts`，或显式声明「终态无 live 腿，故不计」。

### [minor] §6 — B 的两项真实优点未计入；「协议风险」一行把两种严重性不同的失败模式抹平

逐条核实调用方指定的「有没有被低估 / 漏掉的 B 的优点」。有两项，文档一字未提：

1. **失败模式的严重性与可检测性不对称**。B 漏一个 fence → 客户端出现悬挂 open block：结构性异常、SDK/CLI 侧可见、**不改变任何已交付内容的顺序与归属**。A 漏一个 remap 站点 → index 错位 / 重复：第二轮 GPT 审的真 SDK probe 已证会**静默重排** content（wire 是 `first, empty-anchor, second`，SDK 累积成 `first, second, empty-anchor`），即用户拿到的答案被悄悄改序。表格里两者都写「高」，抹掉了「结构性可见 vs 语义静默损坏」的差别。
2. **B 不引入任何合成 content block**：完全不触碰 ADR D2 保留的「空 text block 是错误形状」判据，也没有 F4 的历史回传风险。这是 B 相对 A 的**唯一结构性长期优势**。

另：「仅对 text/thinking 启用」的分档，文档以「留下 tool_use 缺口」否决——方向对，但在块级 buffered 终态下应给出更强理由：buffered 下 tool_use 的缺口不只是「tool_use 块之后的 gap」，而是「**任何**块的生成期」，所以分档 B 的缺口与 C 同量级。

**建议**：§6「协议风险」拆成「失败模式」与「可检测性」两行；§4 增设「B 的结构性优点」小节；§7 明确记录「B 的这条优点被 A 的哪条收益超过、为什么」——按 `record-not-adopted`，被否决方案的优点也要落账。

### [major] §3–§5 — 方案空间未穷尽（`one-option-or-the-best-option`）：至少 4 条载体未被列出与否决

文档只给 A/B/C 三选一，没有「已考察并否决」清单。我至少能列出 4 条，其中 2 条在块级 buffered 终态下颇有竞争力：

- **D. 早发真实 `content_block_start`（块头提前透传、块体仍缓冲）**。上游一开块就把 `content_block_start@N` 透传，deltas/stop 仍在提交边界写出；客户端于是有一个**真实 index 上的 open block**，直接复用已被真 CC 验证过的原-index 空 delta 载体——零合成块、零 remap、零 D2 形状回归。否决/暂缓理由（我认为足以否决其作为主方案）：① 它**直接违反 ADR D2 第 3 点**赖以成立的「客户端只见顺序且**完整**的块」——块头先行意味着客户端见到未完成的块；② 对 tool_use **危险**：早发块头而最终未完成时，close-off 的 `content_block_stop` 会让 CC 立刻用空 input 执行工具（F3 的 eager 执行证据）；③ thinking 还有签名契约。→ 至多退化为「仅 text」，覆盖不全。
- **J. 长文本块的 idle 分块**。逼近死线且上游正在生成 text 块时，把已缓冲部分作为一个**完整真实块**提交（start+deltas+stop），余下部分开新块。客户端拿到的是**真内容**而非空 anchor，语义等价（文本拼接）。它同样需要 A 的 allocator（多出一个真实块），因此不是 A 的替代而是 A 的**下游收益**——这恰是 A「generation 级协议所有权」最有力的证据，文档却没用上。建议作为 A 之后的 backlog 记录。
- **K. 在已闭合块的 index 上发空 delta**。CC 侧 `content_block_stop` **不删** `Pn[index]`（`app.pretty.js:298301-298303`），随后的 `content_block_delta` 仍能查到该块（`:298274-298276`），空 `text_delta` 是恒等追加且会 `he()` 重置 watchdog；零新 index、零 remap。否决理由：① 协议外（stop 之后不应再有 delta）；② 对 tool_use **不安全**——`input_json_delta` 分支要求 `Zr.input` 仍是 string（`:298280-298283`），块闭合后 input 多半已被解析成对象 → 直接抛错；③ 官方 `@anthropic-ai/sdk` 累积行为未测。
- **L. 合成 `message_delta` 作载体**。会被 CC 当真终局信号处理：`pn = H0e(pn, ar.usage)` 合并 usage、`ve = ar.delta.stop_reason` 覆盖 stop_reason，并回写所有已 yield 的消息（`:298311-298325`）→ 污染计费与终局语义。明确否决。

**建议**：新增 §「已考察但未采纳的其它载体」，把 D/J/K/L 各给一句机制 + 一句否决 / 暂缓理由（K/L 我已给出可直接引用的行号证据）。这既满足项目铁律，也把 A 的选择从「三选一」升级为「穷尽后择优」。

### [minor] §3 / §5 — A 需要**修订 ADR D2 第 3 点的措辞**，文档未提这项必要的文档改动

**问题（回答调用方指定的第五项：与既有不变量的自洽性）**：

- **「任一时刻至多一个 block open」**：A（gap anchor 只在无 open block 时开、下一真实块前关）、B（pending stop 保持同一块 open，新 start 前 fence）、C 三者**都保持**该不变量。K 也保持（无块 open）。无冲突。
- **ADR D2 第 3 点「严格按 index 顺序输出」**：原文措辞约束的是**真实块**的 commit 顺序（「若 index=2 尚未闭合，则 index=3 虽已闭合也压住不发」）。A 把 synthetic anchor 也放进同一条 wire index 序列，等于把该不变量的论域从「真实块」扩到「真实块 + 合成块，由单一 frontier 分配」。这是**兼容的加强**，不是冲突——但 ADR 的措辞必须同步修订，否则未来实现者读 D2 会以为 synthetic 帧不在该序列内（第二轮 GPT 审的 blocker 分析里已经出现过这一误读：「D2 第 3 点兜不住 out-of-band anchor」）。
- **`wireIndex(i) = i + anchorShift + continuationOffset`**：见 F5，A 之下这条公式**必须被废弃**（frontier 取代两个独立偏移），而不是把 `anchorShift` 从 1 改成 N。

**建议**：§8 的「若选 A」增列一项文档改动：修订 ADR D2 第 3 点措辞 + 在 `plan-Q5-three-way-overlap.md` 追加一条 round-3 修订记录（公式作废、frontier 上位）。

### [minor] §2.1 — 「已实测」清单混入他人报告的转述，未标注证据等级

§2.1 把「第二轮 reviewer 的独立 SDK probe」「短请求 SHA-256 对照」与作者自跑的真 CC 结果并列为「已实测」。按 `verifying-authoritative-claims`，异模型 reviewer 的实测属**二手事实**（我这次复核后认为其结论可信，但等级不同）。建议每条注明来源与等级（自测 / 他人实测 / 静态推导）。

### [minor] §5.6 — backlog 条目缺「解除条件」

§5.6 的模板有根因 / 当前行为 / 理想架构 / 为何暂缓 / 若做需改什么，唯独没有**什么时候必须做**。按本次发现，正确的解除条件是可判定的：「Anthropic 块级 buffered 默认翻转之前必须完成」。建议增列该行，并在 `docs/todo/deferred-backlog.md` 与翻默认的执行计划里互相钉住。

### [nit] 全文术语

`inter-block` 在块级 buffered 下名不副实（上游块内静默也落在同一窗口）。见 blocker-1 的建议。

---

## 主观建议

- **[建议] §7 推荐段的论证顺序** —— 目前「唯一同时满足四点」是第 1 条、「wire frontier 是 generation 状态」是第 2 条。预期影响：第 2 条才是不可替代的长期论点（它同时使能 J 分块、续写 frontier、以及未来任何需要插入合法块的特性），而第 1 条的四点里有两点需加限定（见 F6）。推荐做法：把 frontier 所有权提为第 1 理由，并补一句「A 是唯一把 index 分配从**分散的常量与偏移量**收敛为**单一权威**的方案」。
- **[建议] §8 下一步** —— 目前是三条平行分支（若选 A/B/C）。预期影响：用户面对的其实是一条**带门的顺序**（先解阻、再落 A、A 是块级默认翻转的前置门），平行呈现会让「先解阻」被误读成「选了 C」。推荐做法：改写成带硬门的路线图（见下文）。
- **[建议] 暴露面分析固化** —— 本次结论来自一次性脚本。推荐把「按客户端轨算最大事件间隔 + 按 open block 状态分类」固化成 `exp/` 下的只读分析脚本，之后每次讨论保活都能重算，而不必重写。

---

## 该选哪个方案、为什么（独立结论）

**选 A**——但推荐的是「A 作为终局形态 + 一条带硬门的落地顺序」。理由与文档部分重合、部分不同：

**支持 A 的独立理由**

1. **B 的致命伤被我第一手证实，且比文档说的更硬**：CC 2.1.207 在每个 `content_block_stop` 就 `addTool → processQueue → executeTool`（`app.pretty.js:298301-298310, 293787, 291016-291028`）。B 扣住 stop = 工具执行推迟整段 gap。而在块级 buffered 终态下，这个 gap 就是「下一块的生成时间」——不是罕见角落（我的 8000 条样本里 >150s 静默 68 条）。这不是可用 PoC 翻案的取舍，是**确定的**用户可见回归。
2. **B 与本项目「committed」语义正面冲突**：commit 边界的定义就是块闭合（`commit-boundaries.ts`），续写的「已提交前缀」判据与 `committedAny` 的重试窗口关闭都挂在同一事件上。B 让「wire 上未闭合」与「ledger 认为已提交」分裂——文档 §4.7 判断正确，我复核后同意。
3. **A 的收益不止保活**：单调 frontier 是「在客户端块序列里插入合法块」这一能力的**通用底座**——续写 frontier、J 分块、未来任何合成块特性都要用它。这是长期正确性论点，不是保活局部特判。C 是不做；B 则是在**回避**这个能力（用「永不新增 index」换来「永远不能插入合法块」）。
4. **A 的四点宣称经复核成立三点半**（见 F6 的表），且作者**没有明显偏袒 A**——文档对 A 的自陈风险比对 B/C 更严厉；其偏差在于低估 C 的代价与给 B 写错否决理由，两者同源（上游轨 vs 客户端轨混淆）。
5. **在「块级 buffered 是既定终态」这条用户约束下，A 从「三者中最优」升级为「唯一可接受的终态」**：C 在终态下等于首块之后放弃保活；B 以确定的工具延迟为代价；D/J/K/L 均有结构性缺陷或只是 A 的下游收益。

**不选 B / C 的理由**

- **B**：见上 1、2。但 B 的两项真实优点（失败模式可检测、无合成块形状）必须**落账为复活条件**：若未来 CC 改为非 eager 执行，或在 A 已覆盖 buffered 缺口后我们只想给 text/thinking 加一层更干净的载体，B 值得重估。按 `record-not-adopted`，不能只写「不推荐」。
- **C**：在 live 制度下缺口确实窄（我的 8000 条里 0 条 inter-block >300s，最大 130.7s）；但在块级 buffered 终态下它退化为「首块之后覆盖率随块数下降、多块长响应逐块失守」。**C 不能作为终态**，只能作为解阻用的临时门。

**落地顺序（对 §8 的实质性修改建议——这是排序，不是把 A 降级）**

1. **立刻**：按 C 的形状修当前分支的 blocker（scaffold 门加「尚未完成任何真实块」）+ 修 `enveloped_ping` 与 content 升级共用 latch 的 major（第二轮 GPT 审 §2 两条），让分支可合并。这几行在 A 落地时会被删除，**必须在同一提交里写明「临时门 + 解除条件」**，且文档**不得**声称「>300s 门已闭合」。理由不是「A 太贵」，而是把一个已知会破坏 SDK 累积顺序的 anchor@0 继续留在分支上更糟。
2. **随即**：把本设计转成独立 TDD plan（沿姊妹 Task 1.1–1.3），并补：§3.4 的 continuation frontier 失败序列、§3.6 的并发分配 oracle、F4 的多轮真 CC 回传 oracle、F6 的「无 anchor → 结构性短路」不变量、ADR D2 第 3 点措辞修订 + Q5 公式作废。
3. **硬门（因用户约束而升级）**：既然流式与整响应缓冲都**不是可接受的产品状态**，块级 buffered 默认翻转是**独立必需**的，而不是某个特性的附属前置。因此——**A 必须在 Anthropic 块级 buffered 默认翻转之前落地**，这条依赖要同时写进本设计、`docs/todo/deferred-backlog.md` 和翻默认的执行计划。翻默认那天，C 的缺口会从「窄」变成「多块长响应逐块失守」。
4. **验收**（三层 oracle，缺一不可）：producer 全序（index 单调 + `maxOpen===1` + 多轮 anchor/real 交替）→ 真 `@anthropic-ai/sdk` 累积顺序与 wire 一致 → 真 CC **numTurns≥2** 的 >300s 长墙（覆盖历史回传）+ 短请求 SHA-256 对照。

## 文档可否作为决策依据交用户

**修订后可以；当前不可以。**

两个 blocker 都会直接改变用户取舍：blocker-1 让用户以为「选 C 只丢一个罕见角落」，blocker-2 让用户以为暴露面数字适用于目标架构；F3 则会让任何按文档理由复核 B 的人得出「B 的核心代价不存在」的相反结论。

修订量不大且都在文档层，一轮可闭合（建议由原作者或 `gpt-souls:doc-writer` 处理）：

1. §5.2 重写（判据改为「客户端轨是否有 open block」，只保留块级 buffered 终态的缺口分析）；§6 表格 C 列与「协议风险」行相应调整。
2. §2.1 每条注明制度与证据等级；并入本报告的 8000 条分类与 12/35/68 计数。
3. §4.3 / §7 第 4 点换成 eager 工具执行的机制与行号。
4. §3.4 补 continuation 撞车序列 + 引用 Q5 SSOT；补并发分配临界区约束。
5. §3.5 / §3.7 补空 anchor 块的多轮回传风险与对应 oracle。
6. 新增「已考察但未采纳的其它载体」（D/J/K/L）。
7. §8 改为带硬门的落地顺序；§5.6 backlog 模板补「解除条件」。

修订后即可作为用户裁决 A/B/C 的依据。我对「选 A」的推荐**独立于**文档的论证，修订不会改变结论方向，只会让结论站在正确的事实上。

---

## 附：本次评审用到的一次性探针（供复算）

- `/tmp/probe.test.ts`：驱动 `runResponseBufferedSink`（`commitBoundaries = content_block_stop`），交错打印上游 / 客户端帧序，证明块级 buffered 下客户端在 `content_block_stop` 前一帧不收。跑法：worktree 根 `bun test /tmp/probe.test.ts`（文件内对 `~/` 别名用绝对路径导入）。
- History 只读分析：`GET /history/api/entries?limit=2000&endpoint=anthropic-messages`（4 页 = 8000 条，2026-07-25 → 07-27）+ 逐条 `GET /history/api/entries/:id`；按 `clientResponse.sseEvents` 的 `offsetMs` 与 `content_block_start/stop` 计算最大客户端可见事件间隔与该时刻的 open block 集合。
- **全程只读 GET，未对 4141 主服务器做任何写 / 信号 / 进程操作；未启动任何测试服务器。**
