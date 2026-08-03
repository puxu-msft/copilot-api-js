# HANDOVER —— inter-block anchor allocator，M1 已实施待复评收口

**状态**：进行中 · **M1 实现已落、三条走查 Major 已修，但验收判据这一层有系统性问题，等第三方裁决** —— **不得据本文件宣称 M1 已定稿或可合并**
**核验基线**：分支 `feat/inter-block-anchor-allocator` @ `6fb9ed67`（2026-08-03）；主线 master @ `1b8712b4`
**worktree**：`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc`
**未提交 / 未追踪**：无（worktree clean）
**已跑门禁**：`bun run typecheck` 绿；`FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http` = **6848 pass / 0 fail**（基线 6824 → M1 首版 6828 → 评审修复后 6848）

> ⚠️ **门禁全绿不代表 M1 可定稿**——下面「M1 未闭合的判据问题」那节列的三处，全部是「实现落了但锁不住它」的形态，`test:fast` 与 `typecheck` 对它们结构性失明。

> 隔离 worktree 里 `bun run test` 会因 rustup 前置失败，**用上面那条 `parallel-test.ts` 命令**。核验于 2026-08-03 @ `6fb9ed67`；接手第一件事是复验而非采信。

## M1 未闭合的判据问题（**接手最该先读这一节**）

两轮代码评审 + 各自的复核轮之后，实现面已被逐项核过是对的（状态转移表逐格、bridge 等价、心跳时钟两入口各自可红、wire-torn close 例外、13 站点 port 取法、六个终局站点分流、live client-gone 走 settled-abort）。**问题全部集中在「拿什么锁住它」这一层**，且三处是同一个病——**判据在检查源码长什么样，而不是检查行为**：

| # | 问题 | 证据 | 定级 |
|---|---|---|---|
| G1 | anchor-stop 能力边界可被 `as OwnerRawSink` 绕过 | 复核轮实测；**这已是同一条守卫第二次被交出 witness**（第一次是同行 regex 被变量提取写法绕过） | 阻断定稿 |
| G2 | 七个 `settleMessagesOwnerFailure` 分流点**逐个中和后全套件照绿** | 走查复核轮实测 | 复核者判 minor，**主会话判 major**（计划的门明写「每个可达组合一条从真实入口驱动的 oracle」）——**争议已交第三方裁定** |
| G3 | 13 站点 close registry oracle 是**源码文本 oracle** | 走查复核轮自陈 | 同 G1 的拼写轴问题 |

**另有一条方法论事实值得单独记**：走查复核轮自建的 HTTP 探针**跑在修复前源码上输出相同**，即无判别力；它主动交代了这一点，Major 1 的真实证据是单元测试而非它原本声称的真实入口 oracle。→ 「探针跑通」不等于「探针能分辨」。

**主会话在这条上的失误**（接手请引以为戒）：守卫两次被绕过，两次都是**主会话一个人换的轴**（regex → 能力边界 → 准备换运行期摘除），并且**自己发明了一条退路**（「窄判据 + 显式登记表」）没经任何人看过。同一个问题、同一个裁判、连续两轮，正是第一次被绕过的成因。

### 第三方裁决已回（`docs/tmp/2026-08-03-m1-guard-axis-adjudication.md`，已提交 `08131f59`）

**四项结论，其中三项推翻主会话**：

1. **归属层：主会话与评审者皆误。** 同行 regex、类型能力边界、以及主会话准备换的「帧构造权 / 运行期摘除」**全部落在表示层**。正确不变量：**anchor close 的判定、所关闭的 `openAnchorIndex`、`content_block_stop` 的发射、关闭状态清除与 heartbeat/diagnostic 副作用，必须在 delivery owner 的同一个 serialized command 内原子完成；所有可到达客户端 wire 的路径都不得绕过它。**
   - `stopFrame` 只是可重造的协议值——禁止构造**既不闭合又会误伤**（真实块合法拥有 `content_block_stop`）。
   - `writeAnchor` 是 transport/sampling 能力，不是关闭权威（owner 缺它时退化到普通 `write`）。
2. **运行期摘除：必要但不闭合。** 普通 `ClientSink.write` 与公开 raw factory 仍能发射同字节的 stop。
3. **主会话发明的退路「窄判据 + 显式登记表」= 自我授权的留口子**；仅在「外部裁决 + 诚实限缩 claim + 具体阻塞物 + 独立正控 + 确定恢复门」五者齐备时正当。
4. **定级**：G2（七个 settlement 分流点）**支持主会话，是 major**；G3 两者皆误——presence 门有价值但替代不了行为门，**行为缺口仍是 major**。

对「连续换轴是否说明不变量不在这一层」的正面回答：**成立，但理由不是次数**。两次 witness 利用的是同一事实——判据在观察表示层，而真正的违规是「绕过 owner canonical state 后仍能产生 client-visible wire effect」。

**下一步（已在进行）**：`gpt-souls:architect-advisor` 已冻结 owner/wire 边界形状，产出 `docs/tmp/2026-08-03-m1-owner-wire-boundary-design.md`。

### ⚠️ 边界设计触发了范围变更，**用户已裁决**（2026-08-03）

设计结论：正确形状**要求回开 P2 已冻结的 owner API**，并把整个客户端 emission 面重塑成 command algebra。三个缺口是实施细节补不平的——① `WireEnvelopeFactory.anchor(frame)` 让调用方**自己声称** anchor provenance；② `closeOpenAnchor` 与随后的 real start 分属两个 operation，表达不了「close→real-start 同一 callback」（**plan 的 S3 节早就要求过这个 transaction，当时没发现 API 表达不了**）；③ 公共 `ClientSink.write` 是无条件 wire capability，不动它就没法让所有 emission 先过 effect 校验——**这是同字节 stop 旁路的根**。

**用户裁决**：
1. **采纳「全量：现在就重写 emission 面」**——不拆、不排后面。M1 的范围因此从「关闭权威」扩展为 owner command algebra + 13 个出口逐个收口（driver live/buffered/retreat、live 装饰器退回纯 transform、handler 终局、heartbeat 归属、terminate/finalize、Responses WS 终局路径、测试 sink 改注入式）。
2. **该设计必须先过评审再定排期**——理由：它要改经六轮评审冻结的 API，而它自己一轮评审都没过。

**评审在跑**（两路正交）：`docs/tmp/2026-08-03-m1-boundary-design-review-claude.md`（对抗闭合主张：13 格闭合等级判定、独立枚举出口对账、有无更小闭合方案、自证型断言）与 `-review-gpt.md`（可行性与爆炸半径：删无条件 `write` 的调用点计数、测试改造是否让某些测试**失去判别力**、三个异域 writer 的域隔离是否为真、**与 P6 心跳修复是否冲突**、每 commit 可编译的迁移切分是否存在）。

**接手须知**：在这两路评审收口前，**不要开始实施边界重写**，也不要按旧形状继续推进 M2——M2 的三腿接线会大量建立在即将被改掉的 API 上。




## 接手先读什么

1. **本文件**读完。
2. `docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md` 的「**M1 调查结论**」①–⑧ —— 这是 M1 的实施依据，冻结了签名、模块位置、类型形状、诊断载体。M2 起的依据在同文件 M2–M8 各行。
3. 同目录 `README.md` 的**冻结契约 C1–C11**（C9 于 2026-08-03 按用户裁决改过措辞，见下）。
4. 只在需要追溯「为什么是这个形状」时读：`docs/tmp/2026-08-03-m1-investigation-dispositions.md`（30 条评审发现的处置与理由）。

## 已确证的硬事实（别再重新推导）

| 事实 | 证据等级 | 出处 |
|---|---|---|
| P0 / P1 / P2 / P6 **均已 landed master**，本轮起点是 P3M | 实测（`git merge-base --is-ancestor` 逐个 commit 核过） | kickoff 里「先从 P0 开始」是 2026-07-27 的陈旧文本 |
| 生产 anchor-stop 关闭者共 **13 个**，不是计划原写的 10/11/12 | 实测（全仓 `stopFrame(` 扫描，含 `driver.ts:1317-1321` 那个原表漏列的 retreat live 写穿分支） | 逐条见 plan-3「M1 调查结论」① |
| M1 后全仓只剩 **3 个** `stopFrame(` 调用点，且三个都走 `port.closeOpenAnchor` | 实测 grep @ `6fb9ed67` | driver / handler / live 装饰器各一 |
| `anchorClosed` 赋值点只剩 owner 两处；`anchorBlockOpen` 只剩 injector 开侧两处 | 实测 grep @ `6fb9ed67` | 与冻结的两阶段 allowlist 逐点吻合 |
| `writeAnchor` 已从公共 `ClientSink` 移到 `OwnerRawSink`；生产调用点只剩 `session.ts:584` | 实测 grep @ `6fb9ed67` | 这是「守卫换轴」的落点，见下 |
| `recordFeature` **不进** History（只 publish 实时事件，消费者只有 WS sink 与 TUI 内存 store） | 实测（读 `context/request.ts:2109-2116` + 全部消费者） | 故 partial-delivery 载体改用 `PipelineInfo` |
| owner 五个入口里 `closeOpenAnchor` 与 `writeBlockFrame` **原本不更新 heartbeat 时钟** | 实测（读 `session.ts:401-409` / `:430-436` vs `:317-321`） | P2 就带进来的既有缺陷，M1 已补齐两处 |

**计数事实的集合边界**（按 `session-closeout` 的要求写明，否则读者会照错的量估工）：
- 「13 个关闭者」= **生产源码中会写出 anchor `content_block_stop` 的判定/写出点**，集合边界 `src/`，排除测试与已归档文档。
- 「6848 tests」= `unit + it + http` 三档，**不含** pty / e2e / 前端（`ui/`、`ui-v4/`）。
- 「3 个 `stopFrame(` 调用点」= `src/` 下的调用表达式，不含注释与类型声明。

## 用户已裁决（不要重开）

| 裁决 | 内容 | 日期 |
|---|---|---|
| **wire-torn 时 close 放行** | `wireTorn` 语义 = 「禁止推进 frontier」，只封锁四个入口（`allocateAndWriteAnchor` / `withAllocatedRealBlock` / `beginLeg` / `writeBlockFrame`）；**`closeOpenAnchor` 例外，撕裂后仍写出 stop**。理由：关闭不推进任何 index，拒绝它会让客户端拿到未闭合 `block@0` + error，既违反 §10.5 也是相对 legacy 的行为回归。已同步进 README C9 与 plan-2/plan-3 | 2026-08-03 |
| **M1 直接开工、做完再报** | 不逐 commit 回报 | 2026-08-03 |

## 与冻结上游文档的对账

- **C9 已按上述裁决修订措辞**（README 冻结契约表）。上游 spec `docs/spec/2026-07-27-inter-block-keepalive-carrier.md` **未**改动——它写的是载体选型（方案 A/B/C），不涉及 owner 入口封锁语义，**无冲突**（检索词：`wireTorn` / `wire-torn` / `closeOpenAnchor` / `五个入口`，范围 `docs/spec/` + `docs/decisions/`，零命中）。
- **ADR D2 第 3 点仍待改**（P8.4）：措辞需从「真实块的严格 index 顺序」扩展到「真实 + 合成块统一 frontier」。**停点在写文件之前**——只产出逐段 replacement 草案，获用户明确同意后才改 ADR。
- **Q5 的 `wireIndex(i) = i + anchorShift + continuationOffset` 公式**要在 P8.5 作废，验收判据是**分类审计**（每个命中判为「已作废历史记录」或「仍具规范性」），**不是字面零命中**。

## 待办（每条带验收判据与证伪方式）

### T1 —— M1 收口（**当前就在这一步**，用户已批准开工）
- **当前卡点**：不是「等复评」，而是**判据轴问题待第三方裁决**（见上方「M1 未闭合的判据问题」G1–G3）。两路复评均已回话并完成复核轮：走查侧 3 条 Major 全部解决、判据侧 `message_stop` oracle 已关闭，**剩余阻断项只有 G1–G3**。
- **动作**：等 `docs/tmp/2026-08-03-m1-guard-axis-adjudication.md` 的四项裁决 → 按裁决修 G1（并按其定级处置 G2、G3）→ 恢复原评审者复核 → 合 master。
- **验收**：G1 的绕过 witness 在修复后**不可编译或不可运行**（而不只是被扫描器报出）；G2 的七个分流点**逐个中和必须有具名测试转红**；G3 换成行为 oracle。
- **证伪**：中和任一分流点而全套件仍绿；或对 G1 又能交出新的合法 witness。
- ⚠️ **不要自己再换一次轴**——主会话已经这么做了两次，两次都被绕过。裁决回来之前不要动手。


### T2 —— M2/M3/M4：三腿分配 + remap（未开工，plan 已冻结）
- **动作**：按 plan-3 的 M2→M3→M4 顺序，各腿 start 帧经 `withAllocatedRealBlock`、非 start 帧经 `writeBlockFrame(leg, upstreamIndex, frame)`。
- **验收**：6 格 mutation 矩阵填满（三腿 × remap/allocate 两维）；每腿至少一条**从真实 HTTP 入口**驱动的 oracle（`createFullTestApp` + `app.request("/v1/messages")` + `setDeliverySessionObserverForTests`）；O-1/O-2/O-6 绿。
- **证伪**：把某腿的 remap 改回硬编码 `1`、或删掉该腿的 `withAllocatedRealBlock` 调用，若无测试转红则该格无覆盖。
- **硬前置**：M2 必须先满足 plan-3「M2 前置条件：legacy 瞬时撕裂必须随 S1 owner 化一并消失」那一节的四条满足点。

### T3 —— M5/M6/M7/M8（未开工）
- **唯一硬序**：**M6（删 `semanticBlockCount === 0` 门、特性开门）必须晚于 M2–M4 全部完成**。开门前两种算法数值等价，开门后才会产出多 anchor。
- **验收**：M5 后 `continuationOffset` / `wireDeliveredBlocks` / `anchorBlockOpen` / `anchorClosed` / bridge 判据在 `src/` 全部零命中；M6 的 O-3 精确形状；M7 交叉 mutation 矩阵；M8 多 gap + 字节等价。

### T4 —— P7 的 translate 腿缺口（**本轮新发现，未定性**）
- **事实**：空 text block 清洗 `filterEmptyAnthropicTextBlocks` 经 `sanitize-messages` 跑在 Anthropic 入站路径上，**但外层有门**——`codec/anthropic/request-rewrite-adapter.ts:65` 的 `appliesTo: (env) => env.targetEndpoint === ENDPOINT.MESSAGES`，故 `@cc` / `@responses` 的 forward translate 腿**不跑这条清洗**；而 translate 腿同样共用 anchored keepalive sink（`handler-v4.ts:1248-1254`），一样会产出 gap anchor 空块。
- **尚未证明它是缺口**：还差两跳实测——① Anthropic→CC/Responses 的**翻译**会不会丢掉空 text block；② CC / Responses 上游对空 content part 的**实际**校验行为（不能拿 Anthropic 上游的 400 外推）。
- **验收**：Task 7.1 的核实矩阵 = **2 腿 × 2 跳**，direct 与 translate **各**一条 oracle。
- **证伪**：只测 direct 腿就宣称「清洗已覆盖」——那是本条明令禁止的假完成。
- **若坐实**：兜底走 α（把清洗接到 `targetEndpoint` 门**之前**），**仍是 α 不是 β**，不触发 P7.2 那个需要用户拍板的停点。

### T5 —— P8 验收与文档后果（未开工）
- O-4 真 SDK 累积顺序 / O-5 真 CC inter-block >300s（连跑 ≥3 次 + escalate=0 对照组）/ O-6 与 P0 捕获字节 `cmp`。
- ADR D2 停点见上；Q5 作废用分类审计。
- **收口清单是 O-1 ~ O-9 九条**，三处对账（README 总表、P8 验收记录表、P8 kickoff 清单），别漏 O-9 交叉缝。

## 我这轮犯过的错，与它们的复发点

| 错 | 成因 | 复发点 |
|---|---|---|
| 声称「共 12 个关闭者、没有第 13 个」 | 枚举用的 grep 结尾带 `head -60`，`driver.ts` 命中被截断在 `:1183`，我把**被截断的输出**当完整清单，在其上下了否定性断言 | **T2 每腿枚举站点时**：任何「共 N 个 / 没有别的」都必须来自不截断的输出，并用一个已知应命中的正样本证明扫描触达 |
| 新加的 oracle 自己是个 blocker | 它照着**采纳修法之前**的问题陈述写，在新形状下正确实现也必红，且让它变绿的唯一路径恰好是被否决的方案 | **T2/T3 每写一条新 oracle 时**：先问「在我这次采纳的形状下，正确实现会不会也红」 |
| 诊断载体选了 `FeatureKind` | 只看到它进 observability 事件，没核它进不进 History 条目 | **T4/T5 任何「落到持久载体」的主张**：核到 `HistoryEntryData` 字段与 `toHistoryEntry` 投影为止 |
| 要求的守卫判据形状是错的（同行 regex） | 我按「能抓住我想到的破法」验收，而绕过来自我没想到的合法写法 | **T2/T3 每加一条架构守卫时**：先试着自己写一个合法的绕过 witness；写得出就换轴，别补拼写 |
| 一条 Bash 查了主树而不是 worktree | shell cwd 被重置，我依赖了上一条命令留下的 cwd | **每条 Bash 调用**都自己绑定目录根（`cd <abs> && ...` 或 `git -C <abs>`） |

## 本轮的环境异常（影响调度，不影响结论）

- **五个 agent 撞 `Server error mid-response`**。缓解：派活时要求「先建文件、每条证据闭合就追加落盘、回复压到 3 行」，改后未再丢报告。
- **两位原评审者事后 `No transcript found` 无法 resume**（本仓记录在案的 transcript 闸门 + 中途 shell 重启换了任务目录）。处置：换新实例并**明说它不是 resume**；新实例对上一轮发现反而是未卷入方，正好满足 B 级裁定要第三方那条。
- **并发跑测试会污染结果**：一次全套件跑出 4 条失败，全部在隔离复跑时通过（含架构守卫与三条真实进程 SIGINT 测试）。**下断言前确认没有 peer agent 在同树跑测试或做 mutation。**
