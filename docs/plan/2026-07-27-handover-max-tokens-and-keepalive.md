# 交接：max_tokens 续传 + client↔proxy keepalive（2026-07-27）

> 接手方式：**先读本文件**，再按「下一步（严格顺序）」执行。权威文档链接见文末。
> 本文件只记**当前真相 + 顺序**；细节一律指向权威文档，不重复。

---

## 一句话现状

`max_tokens` 续传特性的 **spec/plan/P0 已 landed**；推进 P1 时挖出一条**保活缺陷链**（我方吞空 delta → CC 300s watchdog 掐断），已修根因并落地 pre-content 保活 + **P6 心跳死亡修复**；剩余 **inter-block 保活缺口**需要方案 A（接线 multi-anchor allocator），其 TDD plan 经**六轮异模型审至零 blocker**、已合并 master，**实施进行中**（P1 + P2 全完成、异模型审查中，P3M 未启动）。max_tokens 的 P1 本身未被阻塞，但**块级默认翻转**的硬前置是方案 A。

## 方案 A 实施进度（活状态，接手先看这里）

**分支 `feat/anchor-allocator-p1p2`**（worktree `.worktrees/alloc-p1p2`，base `da59c586`，**未合并 master**）：

| commit | 内容 |
|---|---|
| `e1a2fc39` | **U1** allocator 更名 `createGenerationWireIndexAllocator` + `anchorsOpened()` 诊断计数 + anchor 三帧改 factory 收显式 index + `ANCHOR_INDEX`→`PRE_CONTENT_ANCHOR_INDEX` |
| `a0890d0c` | **U2** `AnchorState.allocator` 必填、handler `makeAnchoredSseSink()` 唯一创建点、pre-content injector 走共享 allocator |
| `73e1d6be` | **U3** C3 映射恒等短路 `resolveRemappedFrame` + **ratchet 守卫**（四处 legacy literal remap 冻结、新增即 fail、只减不增） |
| `f8230e9e` | **P2.1** 低阶原子 allocator：`LegToken` / 不可变 `WireBlockMapping` / `beginLeg` / `allocate*` / `reserve*` + reservation commit/rollback + 无 active leg 拒绝 real 分配 |
| `92c4325b` | **P2.2** serialized owner API（port 五方法全落地）+ `GenerationWireState` 唯一注入 + 三类 leg 都调 `beginLeg` + 首次 write 前同步 commit + provenance 真实身份 |
| `a2da18fa` | **P2.2b** pre-M6 心跳分配状态 characterization（拆分后留在 P2 的那半，见下方裁决 2） |
| `0441e476` | **P2.2c** C9 三档 commit-point（首帧写出前提交 / build 抛错不提交）+ queued 与 pending-abort 边界 |
| `70dbc50b` | **P2.2c-b** recovery 两支 + reservation 对外不可见 |
| `cdb8b368` | **P2.2c-c** 显式 leg 跨腿 mapping 隔离 / 同腿多块并存 / stop 后释放 / missing mapping fail-visible |
| `a64fb749` | **P2.2d** serialized `beginLeg` fence（与 queued write 串行） |
| `0df3675c` | **P2.3** suspend 后零新分配 |
| `4fa3b568` | **C11** owner 三腿真实 provenance + production 三腿 `beginLeg` + 无 active leg 拒绝 + `"legacy"` 唯一边界守卫 |
| `443332b0` `3662195d` | 格式化 + bridge oracle 改走 delivery owner |
| `035d37c8` `79551d06` | 计划 checkbox 与 `DESIGN.md` 活架构表同步 |

**P1 + P2 已全部完成**（HEAD `79551d06`，clean，37 文件 +2048/−282）。标准档 `bun scripts/parallel-test.ts unit it http` **连跑三轮 6550/0**；三组时序测试各 15/15；O-6 字节等价 SHA-256 `1c6163c6…` / 764 bytes / identical。

**当前所处环节**：**分支未合并**，正由**两个 Claude 驱动的审查者**（implementer 是 GPT 驱动 → 异模型对抗）并行审 P1+P2 整支——`reviewer` 做合并态对抗审、`verifier` 做 oracle 证伪。**审查通过并合并 master 后**才进 **P3M（M1–M8，唯一硬序：M6 晚于 M2–M4）** → P7 → P8。

> **本支是设计意图内的过渡态**：生产上真实块的三条写入路径（S1 buffered flush、S2 retreat、S3 live-reconcile）**仍走旧站点**，计划冻结待 M2/M3/M4 迁移。评审时须核实的是「过渡态自身是否自洽」，而不是「为什么没迁完」。

### 主会话已裁决的计划内冲突（勿重开，两条都写进了 plan）

1. **U3 守卫 × 冻结相位边界**（2026-07-28）：「remap literal 零命中」与「P1 不改 remap 站点」不可两立 → **改用 ratchet 冻结 baseline**，照抄本仓库既有 `tests/architecture/circular-deps-ratchet.unit.test.ts` 的模式。**P3M 每迁一站点必须同步缩减 allowlist，M4 后必须为空**（M4 显式验收项）。否决了「守卫推迟到 M4」（P1→P3M 窗口恰好失去保护）与「提前迁移调用点」。
2. **P2.2b × M6 硬序**（2026-07-28）：P2.2b 要求「首块提交后 tick 调用 `allocateAndWriteAnchor`」，但 `semanticBlockCount === 0` 那道门（**正是先前保活分支为堵 inter-block blocker 加的 pre-content-only 收窄**）要到 **M6** 才删，而 M6 硬序晚于 M2–M4 → **按 DAG 可达性拆两层**：留在 P2 的是「P6 boundary 后 heartbeat 确实恢复 + owner serializer 在该状态下仍安全」的 characterization；「恢复后的 tick 真正调用 `allocateAndWriteAnchor`」**移入 M6 的 O-3**。**两处 plan 都要写**，M6 验收须含「被移入部分实现并红→绿 + mutation」。
3. **C11 History 三腿 oracle × 真实块路径未迁**（2026-07-28）：C11 想用 History generation 轨断言三腿 provenance，但生产真实块仍走 S1/S2/S3 旧站点（冻结待 M2/M3/M4）→ 同样**按 DAG 可达性拆分**：**P2 保留并视为完成**的是 owner 侧三腿 provenance oracle、production 三腿 `beginLeg` 接线、无 active leg 拒绝、`"legacy"` 唯一边界守卫；**History 轨的 merged-state oracle 随 M2/M3/M4 分别落地**（每迁一条 real-block 路径就补该腿的 History 断言），**M4 收口统一断言三腿**——未完成即 M4 未完成。

> **三次冲突同一个形状**：计划把「验收」写在了「能力就位」之前。这不是计划粗糙——六轮审查已把结构性风险挖净，剩下这类「相位切分 vs oracle 可达性」错配只有真按 TDD 顺序走一遍才浮现。**处置模板**：按 DAG 可达性把 oracle 拆到能力就位的那一相位，**两处 plan 都写**，并在后续相位的验收里显式登记「被移入的部分必须红→绿 + mutation」。**绝不**放宽守卫或手工凑绿。

### 实施期教训（已发生，勿重踩）

- **类型归属方向**：从 `pipeline/types.ts` 反向 type-import `keepalive-anchor.ts` 会把后者拉进核心 SCC、`circular-deps-ratchet` 报红 → **allocator interface 定义须留在 pipeline owner**，`keepalive-anchor.ts` 只实现契约。
- **B1 窗口**：owner 迁移会暴露它——legacy 状态 intent 须在 owner **排队前同步发布**、pre-commit 拒绝时恢复；frontier 仍只在 serializer 内分配。
- **既有 flake（非本工作引入，别去改）**：`tests/transport/h2-keepalive-ping.unit.test.ts` 墙钟波动（单跑 25/25 绿）；`tests/restart/states-flush-freeze.it.test.ts` 分片污染（单跑 6/6 绿）。

### 本批次已验证的 oracle 形态（可复用）

- owner mutation 删掉首次 write 前的 `reservation.commit()` → 目标断言转红**且**下一 operation 报 `wire-index reservation already open`——证明分配真绑在 owner transaction 上。
- 非法 owner 正控（两个并发 peek）→ 独立 O-1 oracle 报 `content block start index 0 at ordinal 1; expected 1`。
- **C9 双向 mutation 都咬**：延后 commit → 四个场景 frontier 错停在 0；反过来让 build 抛错也 commit → frontier 错为 1。**两个方向各自有门**，说明两段语义分别被钉住，不是单边守卫。
- **跨腿 ambient mutation**：忽略显式 leg、改读 ambient current leg → 序列 `[0,1,0,1,0,1]` 变成 `[0,1,1,1,1,1]`，stale primary delta 落到 1。精确证明「必须显式传 `LegToken`」不是装饰性参数——这正是计划第五轮审查修掉的自我回归，现已被测试永久钉住。
- ratchet 正控 → 精确报出新增站点路径 + 提示「P3M 须同步删 baseline、M4 须清零」。
- 竞态 15/15 确定性；O-6 SHA-256 `1c6163c6…` / 764 bytes / `cmp=identical`。

### 隔离 worktree 的构建陷阱（复用）

`.worktrees/*` 里 `bun run test` / `bun run build:history-search` 会失败：`rustup could not choose a version of cargo ... no default is configured`。**不要**去改全局 rustup 配置。两条出路：① 跑测试用 `bun scripts/parallel-test.ts unit it http` 绕过该前置；② 确认分支相对 base **未改动** `native/history-search` 与构建脚本后，把主工作树已有的同基线 ignored artifact 复制进隔离 worktree（该文件本就不进 Git）。

---

## 下一步（严格顺序，用户 2026-07-27 指定「按顺序完成」）

1. ~~**P6：心跳死亡修复**~~ ✅ **已 landed master `2e1041e8`**（含异模型合并态审查 0 blocker）。顺带修了捕获脚本的进程树泄漏（`54a4281d`）。
2. **方案 A 全相位实施**（进行中）：**P1 + P2 已完成**（分支 `feat/anchor-allocator-p1p2` HEAD `79551d06`，**未合并**，异模型审查中）；审查通过 → 合并 master → **P3M（M1–M8，唯一硬序：M6 晚于 M2–M4）** → P7 → P8。
3. **Anthropic 块级默认翻转**（姊妹 spec §6.3）——硬前置 = 方案 A 落地。
4. **P1：max_tokens 成功终端截获续写**（`docs/plan/2026-07-22-max-tokens-continuation/plan-1-anthropic-continuation.md`）。

> 步骤 4 的 P1 不依赖翻转即可实现与测试（测试里显式开 `protect_streaming_generation`），但翻转后才在默认配置下生效。用户已明确**只接受块级 buffered**（不接受流式、不接受整响应缓冲），故翻转是独立必需项。

## 已 landed（master）

| 内容 | commit | 备注 |
|---|---|---|
| max_tokens spec（三轮异模型审 + 用户 Q1/Q2 裁决） | `9de1e221` → `056b1e5d` → … | 权威见文末 |
| max_tokens 实施 plan（三轮 plan-review） | `3ebf2a18` → `84598f74` → `3df2e90c` | 11 文件 |
| **P0**：分型判定 + 独立 terminal observer + config schema + 观测层 | `3bb1262a` | Anthropic-only（诚实分档，CC/Responses 在 P3） |
| 门 D + 门 A（PoC，双 PASS） | `afc54196` | 门 A 是**真实 GHC 计费实测** |
| synthetic continuation provenance | `3150b219` | 顺带补上姊妹机制也缺的标记 |
| M 矩阵（12-cell + transport 展开）+ Q5 三方叠加 | `69ed3a06` | — |
| **G2 保活**：吞帧根因修复 + pre-content 按需升级 | `0b9d450d` | 见「承重发现 #1」 |

---

## 方案 A 的 plan（已合并 master，六轮对抗审查）

`docs/plan/2026-07-27-inter-block-anchor-allocator/`（README + 8 相位 + kickoff + `plan-review-gpt.md` 六轮报告）。**契约 C1–C11 / oracle O-1–O-9 / 风险 R1–R13 / 承重项 1–17 / port 五方法**（`allocateAndWriteAnchor` / `withAllocatedRealBlock` / `beginLeg` / `closeOpenAnchor` / `writeBlockFrame`）交叉引用一致。

**六轮审查挖出的东西，按性质分类（都不是代码审查能发现的）**：

| 层次 | 发现 |
|---|---|
| 设计缺陷 | `anchorsOpened===0` 短路让**零-anchor 续写腿**复用 wire index 0——而它本是上一轮**为降风险加的缓解措施** |
| 计划结构 | TDD 相位循环依赖：P3 的红绿门**根本不可满足**（gap anchor 与 close 状态机都在 P5）→ 合并为 P3M |
| 分布式语义 | 「失败全回滚」在 wire 上不成立——**已发出的字节撤不回** → C9 两段语义（commit point 前可回滚 / 后永久消费 + 终止 delivery） |
| 迁移工程 | M1 删字段导致未迁移分支**编译不过** → bridge + 迁移期双写 + 逐格状态转移表 |
| 数据完整性 | 不该退化处退化了（`legacy` provenance，而真 candidate/dispatch id **拿得到**）→ C11 |
| 自我漂移 | `writeBlockFrame` 又把**第三轮刚清掉的 ambient 当前腿**带回来 → 显式传 `LegToken` |

**两条元教训（已进 P8.6 记忆提炼清单）**：
1. **为解决问题而新增的机制，本身会引入新缺陷**——六个 blocker 里有三个是这个形状（C3 短路、C9 回滚、`writeBlockFrame`）。**缓解措施不自带豁免权。**
2. **援引方法论前先核实其适用前提**——planner 把「诚实退化优于伪称完整」用对了方向、却用在了错误前提上（以为拿不到真 id）。参见记忆 `degradation-advice-scoped-to-target-has-equivalent`。

---

## 承重发现（接手必读，都是实测得出）

### #1 我方 rewrite 吞掉协议有效的空 delta（已修，`0b9d450d`）

- 症状：>300s 上游静默时，经代理的真 Claude Code 在 302s 报 `Response stalled mid-stream`。
- **掐断者是 CC 自己的 300s event-idle watchdog**（本仓库无该报文；定位到 CC 打包源码 `~/.claude/refs/claude-code-2.1.207/app.pretty.js:298092/298411/298433`），**不是**代理的 stall 检测。
- **根因在我方**：tool-call 恢复的 marker lookahead 把空 `text_delta` 静默吞掉 → 下游只剩 ping，而 **ping 不重置 CC 的 300s 死线**。
- 修法：共享原语 `src/lib/anthropic/empty-stream-delta.ts`（识别空 `text_delta`/`thinking_delta`/`input_json_delta`）+ 两处 rewrite 旁路（`recover-tool-call/stream.ts`、`decode-tool-input.ts`）。
- 附带落地：`stream_keepalive_escalate_sec: 200` **按需升级**——平时 ping（形状不变），静默逼近死线才发 content delta。**仅覆盖 pre-content**。
- ADR D2 已记录**部分反转**：其理由②「空 delta 无效」被证伪（失效根因是我方吞帧）；理由①「日常空 text block 是错误形状」保留 → 故 anchor 只在 pre-content 且逼近死线时出现。

### #2 buffered 路径上首块提交后心跳永久死亡（未修，= plan 的 P6）

- `delivery/session.ts:205` `freezeHeartbeat: closeHeartbeat`；`:101-102` 置 `heartbeatStopped=true`；`:211` resume 守卫含 `|| heartbeatStopped` → **一旦 stopped，resume 永远空操作**。driver 每个 boundary commit 都经 `flushBufferedFrames` 的 `freezeHeartbeat`。
- **默认受影响的是 Responses HTTP**（buffered 默认 `true` + 真 `commitBoundaries` 逐 item 提交）；**CC 虽 buffered 默认 true，但 `ccCommitBoundaries` 退化到只认上游 error 帧故实际幸免**；WS 故意不传 boundaries；Anthropic 默认 `false`（开 `protect_streaming_generation` 即中招）。
- 实测两层：sink 契约层，以及走真 `runResponseBufferedSink` + 真 commitBoundaries + 120s 块间静默 → `RAW SINK keepalives: 5` vs `DELIVERY SINK keepalives: 0`。
- **测试盲区**：现有 anchor 测试**全部构造 raw sink**（raw sink 的 freeze 只 `clearTimeout` 故能复活），生产走 `makeDeliverySseSink` → 该缺陷结构性测不到。回归锁**不能只写 Anthropic**，必须含 Responses HTTP。

### #3 块级 buffered 下客户端在 `content_block_stop` 前收不到任何帧（探针实测）

- 后果：`pendingOpenBlocks` 在首块提交后恒为空 → 「已有块 open 就在原 index 发空 delta」这条优雅分支在**终态是死代码**；每次 inter-block 升级都需要 anchor。
- 这也让「只保 pre-content」的方案 C 从「暴露面小」变成「**首块之后覆盖率随块数下降**」。
- 8000 条真实 History（2.5 天）校准：pre-content 17 / live open-block 16 / 真 inter-block 2；>300s 12 条、>200s 35 条、>150s 68 条。**那 16 条 open-block 在 buffered 下全部变成无-open-block**。

### #4 方案 A 的风险（plan 已登记）

- A 把今天被三重门挡住的**死 remap 路径变成每请求热路径** → 记账错一处，爆炸半径从「升级过的请求」扩到**全部请求**。对策：`anchorsOpened===0` **结构性短路** + 引用相等的正负样本。
- A 会**作废** `docs/plan/2026-07-22-max-tokens-continuation/plan-Q5-three-way-overlap.md` 的 `wireIndex(i) = i + anchorShift + continuationOffset` 公式，并需修订 **ADR D2 第 3 点**措辞（严格 index 顺序需扩展到「真实 + 合成块统一 frontier」）。
- 已知 continuation 撞车序列：`realBlockOffset` 被续写腿重启的上游 index 命中旧映射 → 算出**已占用**的 wire index。

---

## 用户已裁决（不要重开）

| 决策 | 内容 |
|---|---|
| 客户端可见性（max_tokens） | **transparent 缝合默认**：能藏就藏、藏不掉才透传；多策略可配 `transparent`/`passthrough`/`marker`（marker 也抑制终止符、只多注标记）。不在乎双计费/下游预算。 |
| **透明的边界** | **只对客户端**；后端 history/telemetry **忠实完整**（`perRoundStopReason` 含被藏的 max_tokens + `clientVisibleStopReason` 并存）。 |
| C 类策略 | 多策略可配：`passthrough`（默认）/ `retry_with_budget`；**无 `continue`**（thinking 被 ledger 排除，ADR D3）。 |
| 递送形态 | **只接受块级 buffered**；**不接受流式，也不接受 full-response-level buffering**。 |
| inter-block 保活载体 | **方案 A**（接线 `createAnchorIndexAllocator`），走 plan → 审 → 实现。 |

---

## 执行期须停下问用户的分叉（plan 已标，勿自行拍板）

- P3.1 谁调 `allocateRealBlock`（driver flush vs delivery session）
- P4.3 某格式因删 `continuationOffset` 而破时的两条路（其一违反 C4）
- P6.2 终局路径 freeze/close 裁决（若两条 sink 的 `close()` 副作用不一致）
- P8.4 ADR D2 改动**只出草案**——ADR 记录用户决策，须用户拍板

---

## 方法论教训（本轮反复奏效）

- **为降风险而加的机制，本身要过同样的对抗检验**：`anchorsOpened===0` 短路是上一轮 reviewer 建议、主会话采纳的**缓解措施**，却在默认路径引入了新的 index 复用（见「进行中」的 blocker）。**缓解措施不自带豁免权**。
- **绿灯不自证**：多次靠 **mutation / positive control** 戳破假绿——一条「验证了 enveloped_ping 升级」的 handler 测试，关掉特性开关后**照样绿**；provenance 的「无条件打标」也能全绿通过 6368 个测试。**补完测试必须自己做反向 mutation，不变红就是没咬住**。
- **声音权威都要核**：reviewer 的断言错过（F4 称全仓无入站空 text block 清洗，实际 `filterEmptyAnthropicTextBlocks` 无条件跑生产路径）；我自己的转述也错过（说 CC 默认中招，实际 CC 因边界谓词退化而幸免）。**逐条对照代码/实测再背书**。
- **并发仓库里 ground truth 会在脚下变**：起草期 grep 到「续写底座仅在分支」，修订期它已 landed master + worktree 被移除 → **修订期必须 re-verify landed state，别复用早期 grep 快照**。
- **采样要问「测的是哪个世界」**：C 的暴露面用今天（流式默认）的 History 估算，而目标态是永久 buffered → 系统性低估。
- **合并纪律**：peer 未提交 WIP 挡 FF 时，备份 → **选择性 stash（带 pathspec）** → FF → pop 三方合并；`git stash list` 前后对账（栈顶可能是别会话的 WIP，盲 pop 会误伤）。

---

## 权威文档

- **max_tokens**：spec `docs/spec/2026-07-22-max-tokens-continuation.md`（含 §5.3 截获层 + buffered 前提裁决）；plan `docs/plan/2026-07-22-max-tokens-continuation/`（含 M 矩阵、Q5、provenance 前置、6 份审查报告）。
- **保活**：`docs/todo/2026-07-22-client-proxy-keepalive-300s.md`（G2 全过程 + 根因）；`docs/spec/2026-07-27-inter-block-keepalive-carrier.md`（三方案对比 + 审查报告）；`docs/spec/anthropic-keepalive-content-delta.md`（**已标 superseded**，仅历史快照）。
- **方案 A plan**：`docs/plan/2026-07-27-inter-block-anchor-allocator/`（分支 `feat/anchor-allocator-plan`，**审查中、尚未合并 master**）。
- **姊妹特性**：spec `docs/spec/2026-07-22-continuation-retry-and-sequential-anchor.md` + ADR `docs/decisions/2026-07-22-continuation-retry-sequential-anchor.md`（D2 保活 / D3 tool_use 与 thinking 前缀铁律）。
- **未闭合的独立问题**：`typecheck:ui-v4` **在 master 基线上就是红的**（`~/lib/sqlite/compression` 等解析失败，疑似 monorepo 拆包余波）→ 前端类型门当前失效，任何「ui-v4 绿」的声称都不成立。尚未立项。
