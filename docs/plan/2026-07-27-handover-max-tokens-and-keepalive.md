# 交接：max_tokens 续传 + client↔proxy keepalive（2026-07-27）

> 接手方式：**先读本文件**，再按「下一步（严格顺序）」执行。权威文档链接见文末。
> 本文件只记**当前真相 + 顺序**；细节一律指向权威文档，不重复。

---

## 一句话现状

`max_tokens` 续传特性的 **spec/plan/P0 已 landed**；推进 P1 时挖出一条**保活缺陷链**（我方吞空 delta → CC 300s watchdog 掐断），已修根因并落地 pre-content 保活 + **P6 心跳死亡修复**；剩余 **inter-block 保活缺口**需要方案 A（接线 multi-anchor allocator），其 TDD plan 经**六轮异模型审至零 blocker**、已合并 master。**方案 A 的 P1+P2 已于 2026-08-02 合并 master（`88e47cef`），经四轮异模型审查，P3M 未启动。** max_tokens 的 P1 本身未被阻塞，但**块级默认翻转**的硬前置是方案 A。

## 方案 A 实施进度（活状态，接手先看这里）

**P1 + P2 已 landed master `88e47cef`**（2026-08-02）。分支 `feat/anchor-allocator-p1p2` 已合并，worktree `.worktrees/alloc-p1p2` 可清理。

**下一步 = P3M（M1–M8，唯一硬序：M6 晚于 M2–M4）→ P7 → P8。**

### 四轮异模型审查的账（每轮都抓到全套件抓不到的东西）

| 轮次 | 结论 | 抓到的 |
|---|---|---|
| 1 | 0 Blocker / 4 Major | live 腿 `beginLeg` 死接线（默认配置命中）；real 腿 C9 零门；五条 oracle 名实不符；ratchet 判据形状错 |
| 2 | **1 Blocker** / 3 Major | **live 修复自身没有裁决力**（改回完整原 bug 形态仍 6566/0）；`terminateAfterWireFailure` 吞 finalize；mirror-state throw 路径撕裂；hedge 腿从不 `beginLeg` |
| 3 | **1 Blocker** / 1 Major | **winner 帧绕过装饰器**、wire index `[0,0,1,1,1]`→`[0,0,0,0]`；C9-② 禁止后续分配随硬关 session 被删 |
| 4 | **0 / 0，判可合并** | 仅 3 Minor + 2 Nit，全部已修 |

**承重教训（已入库）**：连续三轮「修复引入新回归且全套件照绿」，共同根因是**测试自造 sink，看不到 handler↔装饰器↔driver 这条缝**。判据 = 把修复完整改回原 bug 形态仍全绿即无裁决力；验收必须走真实 HTTP 入口（`createFullTestApp` + `app.request("/v1/messages")`）。→ [[methodology-each-fix-round-introduces-green-passing-regression-at-the-same-seam]]

### 合并时处理的语义冲突（自动合并成功、合并后才红）

master 期间新增守卫「stream-error outcomes are minted in exactly one place」——该 outcome 只允许由 `driver.ts:streamErrorOutcome()` 产出，否则绕过 abort-provenance gap 计数。本分支的 owner 失败契约恰在两处直接 mint，合并后守卫报 `Expected 1 / Received 4`。**修法是接线而非绕过**：两处改走 `streamErrorOutcome(error, env)`，工厂表签名收 `env`；`classifyStreamError` 是纯 `instanceof`、我们自造的 Error 归 `"other"`，故不会误记 gap，穷尽性由 `satisfies` 保持。

顺带修掉 master 上 `deferred-backlog.md` 里一行孤立的 `||||||| a675064e`（peer 解 diff3 时漏删的残留标记）。

**合并态验证**：typecheck 绿、`package-boundaries` 22/22、`FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http` **连跑两轮 6842/6842 · 0 fail**。

### 交给 P3M 的两条硬前置（别漏）

1. **M2 torn-wire 前置条件**（`plan-3-remap-sites.md` 有独立专节）：legacy 瞬时非-client 撕裂会让客户端拿到 index 0 的洞 + 孤儿 `stop@0` 而流仍记成功；今天因 anchor injector 一次性 latch 不可达，**M2 迁真实块后立即成为热路径可达**。四条满足点写在该节，未满足不得宣称 M2 完成、也不得开启 M6。
2. **M4 必须清空 AST allowlist 的所有 `legacy:*` 条目**（守卫已从字面量 blocklist 换成 AST 调用点 allowlist，三种绕过写法均实测转红、注释不误伤）。

### 用户裁决：owner 五入口拒绝语义 = 方案 D（2026-07-28）

五个入口原本对「session 非 open」有四种行为（`undefined` / `"write-error"` / **抛错** / **根本不检查**），而 driver 四个 `beginLeg` 站点全是裸 `await`（`:1054` 在唯一 try 之外，`:1468`/`:1526` 所在 try 只有 finally 没有 catch）→ 客户端断开后 `beginLeg` reject 从 driver 裸抛，本该 `settled-abort` 的路径被记成失败。

**裁决：把「已终止」建模成一等返回值，真正的接线错误继续抛。**

```ts
type OwnerResult<T> = { ok: true; value: T } | { ok: false; reason: "delivery-finished" }
```

`{ok:false}` **只**表示交付已终结这一种预期终态；未配置 wire state、reservation 重复开启、无 active leg 却写 `real` 帧**照旧 throw**。**这条分界是方案的全部价值**——混进去就退化成哑哨兵。

用户先否决了「统一安静哨兵」（真 bug 被伪装成客户端断开）与「统一 fail-loud」（每个新站点都要记得包 try，忘记 = 裸 await reject → 本仓库记录在案的 `unhandledRejection` → `process.exit(1)` 崩溃放大链）。D 同时拿到两者的优点：类型系统强制每个站点 narrow 后才能取 `.value`，而真错误依然响亮。**现在做的理由**：P3M 本就要逐个碰这 13 个站点，增量成本近零，之后做是返工。

### 过渡态自洽性（reviewer 的机制性论证，非「测试绿了」）

三条同时成立才安全，均已逐条核实：① allocator 在生产上只有 anchor 一个消费者（`withAllocatedRealBlock`/`writeBlockFrame` 生产零调用）；② 一次 generation 至多分配一个 anchor（三种配置组合下 latch 都收敛）；③ 本分支新增的 `semanticBlockCount === 0` 门（`session.ts:167`）把 anchor 钉死在 pre-content，故 `wireIndex` 恒为 0 = 旧 `PRE_CONTENT_ANCHOR_INDEX`，与仍硬编码的 `anchor.stopFrame(0)` 与 `+1` remap 对齐。该门是**承重的**（改回 master 形状立刻红 5 条），由 M6 解除。

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

> ⚠️ 以下由 implementer 自报，**其中两条已被 verifier 独立证伪**——保留在此是为了记住「自报 mutation 不可原样采信」：(a) 「抹掉 `heartbeatSuspended` 会让 `suspended-heartbeat-no-allocation` 转红」**是错的**，该测试照绿（suspend 里 `stopHeartbeat()` 已 clearTimeout，之后再无 `armHeartbeat()`，它锁的是 clearTimeout 不是 suspend 语义）；(b) 跨腿 mutation 的实际失败点是第 6 次调用先返回 `no-mapping`，不是预测的帧序。**教训：mutation 报告只写「跑了哪条具名测试、实际输出是什么」，不写预测。**

- owner mutation 删掉首次 write 前的 `reservation.commit()` → 目标断言转红**且**下一 operation 报 `wire-index reservation already open`——证明分配真绑在 owner transaction 上。
- 非法 owner 正控（两个并发 peek）→ 独立 O-1 oracle 报 `content block start index 0 at ordinal 1; expected 1`。
- **C9 双向 mutation 都咬**：延后 commit → 四个场景 frontier 错停在 0；反过来让 build 抛错也 commit → frontier 错为 1。**两个方向各自有门**，说明两段语义分别被钉住。**但仅限 anchor 腿**——real 腿的同族 mutation 全绿（见返工清单）。
- **跨腿 ambient mutation**：忽略显式 leg、改读 ambient current leg → 序列错乱。证明「必须显式传 `LegToken`」不是装饰性参数——这正是计划第五轮审查修掉的自我回归。
- ratchet 正控 → 精确报出新增站点路径。**但判据形状是错的**：只认字面量偏移，变量偏移与直调 primitive 都绕得过去（见返工清单）。
- 竞态 15/15 确定性；O-6 SHA-256 `1c6163c6…` / 764 bytes / `cmp=identical`。

### 返工清单（2026-07-28 发出，进行中）

1. **owner 五入口改 `OwnerResult`**（上述裁决 D），含 `closeOpenAnchor` 补状态检查、driver 四站点映射 `settled-abort`、`writeAllocationFrames` 裸 `catch` 按 `classifyStreamError` 分类不再静默。
2. **Major-1 live 腿 `beginLeg` 死接线**：`deliveryBySink` 以 `delivery.clientSink` 为 key，而 driver 拿到的是 `liveReconcilingSink` 包出的新对象 → `getDownstreamDeliverySession(wrapped)` 恒 `undefined`（探针实测）。**命中 Anthropic 默认配置**。今天无功能故障（`capturedMessageStart` 只在 buffered 分支赋值，live 腿不产生 `real` spec），但**是 M4 的地雷**：M4 让 live 装饰器调 `withAllocatedRealBlock` 时每个 live 请求都会撞「无 active leg」。
3. **Major-3 real 腿零门**：`withAllocatedRealBlock` 的 rollback→commit、删状态守卫、`writeBlockFrame` 删守卫、driver recovery/continuation 跳过 `beginLeg` —— 六个 mutation **全量套件 100% 绿**。对照：同样打在 anchor 腿与 primary 腿都有门。**`plan-2` Task 2.2c-b Step 5 的勾选是错的**（其 mutation 打在测试自己的 `port.beginLeg` 上，锁不住 driver 是否真调）→ 已要求改回未完成并写明原因。
4. **五条 oracle 名实不符/自证**：`anchor-allocation-race` 的 "POSITIVE CONTROL" 实为 matcher 自测；`allocation-race-after-boundary-commit` 根本没传 `wireState`；`anchor-allocation-owner` 测试名超出断言能力 + identity 断言恒真；`suspended-heartbeat-no-allocation` 两条 allocator 断言恒真；`anchor-remap-short-circuit` 场景 B/C 逐字相同。
5. **ratchet 换 allowlist**：`driver.ts:1212` 的 `continuation.remap(outFrame, continuationOffset)` 正是 C4 要消灭的那条，却在字面量正则盲区；baseline 首项匹配的是 `driver.ts:1083` 的**注释文本**（改注释即可「减少站点」）。→ skill `reshaping-a-bypassed-guard`。

### ⚠️ 已排除的伪缺陷：测试套件「不确定」

reviewer 曾报「7 轮里 2 轮出现成员固定的 17 条 anchor 失败簇」并定级 major。**已证伪**：根因是主会话把 `reviewer` 与 `verifier` 同时派进同一个 worktree，verifier 的 67 秒 mutation 窗口污染了 reviewer 的 run2/run3（源文件恢复也救不回已导入 mutation 版模块的进程）。debugger 在独立 worktree 逐字施加同一 mutation → 一轮跑出**成员完全相同的 17 条**；干净源码连跑 **40 轮（含 load 35 过载、禁 Bun transpiler cache）该簇 0 次**。

**结论：套件是确定的，implementer 的三轮全绿站得住。绝不要加排空圈数、标 flaky 或改这些测试的时序结构。** 教训见记忆 [[methodology-concurrent-agents-must-not-share-worktree-for-mutation]]：**并发 subagent 不得共享 worktree 做 mutation probe**，这是主会话的调度责任。

### 隔离 worktree 的构建陷阱（复用）

`.worktrees/*` 里 `bun run test` / `bun run build:history-search` 会失败：`rustup could not choose a version of cargo ... no default is configured`。**不要**去改全局 rustup 配置。两条出路：① 跑测试用 `bun scripts/parallel-test.ts unit it http` 绕过该前置；② 确认分支相对 base **未改动** `native/history-search` 与构建脚本后，把主工作树已有的同基线 ignored artifact 复制进隔离 worktree（该文件本就不进 Git）。

---

## 下一步（严格顺序，用户 2026-07-27 指定「按顺序完成」）

1. ~~**P6：心跳死亡修复**~~ ✅ **已 landed master `2e1041e8`**（含异模型合并态审查 0 blocker）。顺带修了捕获脚本的进程树泄漏（`54a4281d`）。
2. **方案 A 全相位实施**：~~P1 + P2~~ ✅ **已 landed master `88e47cef`**（2026-08-02，四轮异模型审查）。**下一步 = P3M（M1–M8，唯一硬序：M6 晚于 M2–M4）** → P7 → P8。两条硬前置见上方「交给 P3M 的两条硬前置」。
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
