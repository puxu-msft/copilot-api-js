# 交接：max_tokens 续传 + client↔proxy keepalive（2026-07-27）

> 接手方式：**先读本文件**，再按「下一步（严格顺序）」执行。权威文档链接见文末。
> 本文件只记**当前真相 + 顺序**；细节一律指向权威文档，不重复。

---

## 一句话现状

`max_tokens` 续传特性的 **spec/plan/P0 已 landed**；推进 P1 时挖出一条**保活缺陷链**（我方吞空 delta → CC 300s watchdog 掐断），已修根因并落地 pre-content 保活；剩余 **inter-block 保活缺口**需要方案 A（接线 multi-anchor allocator），其 TDD plan 已写好、**审查中**。P1 本身未被阻塞，但**块级默认翻转**的硬前置是方案 A。

---

## 下一步（严格顺序，用户 2026-07-27 指定「按顺序完成」）

1. **消化 anchor allocator plan 的异模型审查**（in-flight，见下「进行中」）→ 据审查修订 → **合并 plan 到 master**（`docs-merge-before-execute`）。
2. **P6：心跳死亡修复**（可独立于 A 交付、但仍是 P5 前置）。详见 plan 的 P6 相位 + 本文件「承重发现 #2」。
3. **方案 A 全相位实施**（P0→P1→P2→P3→P4→P5，P6/P7 可并行起）：隔离 worktree + TDD + 真 SDK/CC 验收。
4. **Anthropic 块级默认翻转**（姊妹 spec §6.3，`plan-4-7-remaining.md:75` 已列待办）——**硬前置 = A 落地**。
5. **P1：max_tokens 成功终端截获续写**（Anthropic transparent A 类）。计划见 `docs/plan/2026-07-22-max-tokens-continuation/plan-1-anthropic-continuation.md`。

> **注意**：4 和 5 的先后可议——P1 不依赖翻转即可实现与测试（测试里显式开 `protect_streaming_generation`），但翻转后 P1 才在默认配置下真正生效。用户已明确**不接受流式、也不接受整响应缓冲**，故翻转是独立必需项、非仅 max_tokens 的前置。

---

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

## 进行中

- **anchor allocator plan**：分支 `feat/anchor-allocator-plan`（worktree `.worktrees/anchor-alloc-plan`），plan commit `4945d988`。
  **异模型审查已完成**（报告 `docs/plan/2026-07-27-inter-block-anchor-allocator/plan-review-gpt.md`）：**1 blocker + 11 major + 5 minor，不可开工**，planner 正在修订。
  - **[blocker] C3 × C4 冲突**：`anchorsOpened===0` 的**无条件**结构性短路会让**续写腿**（upstream index 从 0 重启）跳过 remap → **复用主腿已占用的 wire index 0**。plan 现有撞车 oracle 只覆盖「有 anchor」的序列，**漏掉这个更常见的默认分支**。修法方向：短路只能在 frontier **等同恒等映射**时成立（无 anchor **且** 非续写腿）+ red-first oracle 覆盖「无 anchor 的续写腿」。
    ⚠️ **这条短路正是上一轮设计 reviewer 建议、并被主会话采纳写进要求的风险缓解措施**——结果它自身在默认路径引入了新的 index 复用。**教训：为降风险而加的机制，必须过同样的对抗检验。**
  - 其余 major 要点：P2 serializer 临界区**有设计无可执行接口**；S2 retreat 与 S3 live 腿**缺真实块分配步骤**；**P2 与 P6 并非「无代码重叠」**、需交叉门；**O-2 / O-7 / Task 5.4 的 mutation 存在假绿空间**（5.4 本就是为防单侧假绿而设，它自己有假绿空间即自相矛盾）；ADR D2 与 Q5 公式的具名 task 存在但**停点与 grep 验收需修正**。
  - **已确认无问题、勿改**：P6 影响面矩阵成立（Responses HTTP 默认中招 / CC 因 `ccCommitBoundaries` 退化到只认 error 帧而结构性幸免）；P6 独立先交付方向正确；freeze 可恢复 vs close 永久的契约与 raw sink 注释一致；P8.4/P8.5 文档后果有具名 task。
- **审查期间后端抖动多次**：纪律是**只 SendMessage resume 原 agent**，不派替代、不换模型、**也不设「挂 N 次就放弃」的成本逃生口**。经验：让 reviewer **分段落盘**能在中断时保住已完成部分（本轮救回 82 行）。

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
