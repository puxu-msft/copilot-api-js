# 双向可追溯矩阵 —— generation emission command algebra cutover

> **这份文件回答一个问题**：RFC 冻结的每一条判据、每一条调查缝、每一个停点，**归哪个 commit 管**；反过来，plan 里的每一个 task **指回 RFC 的哪里**。
>
> **它不复制 §10.2。** 「怎么测 / mutation 正控 / false-red 对照」的单一事实源是 RFC §10.2 的对应行，本表只放**归属与可达性**。两处并存的表必然漂移——本目录已经因此栽过（`docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md` 一节里 `七处`／`八处` 并存过一次）。
>
> **机械校验**：`exp/inter-block-anchor-allocator/traceability-check.py`。它解析本文件，**不接受人工声称**。

## 0. 口径

**三态**（与 `HANDOVER.md` T6 的验收态同一套词汇，不另立）：

| 态 | 含义 | 谁可以是这一态 |
|---|---|---|
| `IN-SCOPE` | 在本 RFC 内有归属 commit | 默认 |
| `NOT-YET-IN-SCOPE` | 归属在本 RFC **之后**的相位，**必须具名后继相位** | **冻结白名单，恰 5 项**，见 §2 |
| — | 验收时另有 `PASS / FAIL / NOT-YET-IN-SCOPE` 三态，那是**执行期**的 verdict，不是本表的归属态 | |

**归属可以多段**，而且必须多段——RFC §10.2 里 R-1／R-2／R-5／R-12 本就是「辅助门在早期 commit、production 硬门在 Commit 4」的两段式，R-11 是每 commit 共同门。**写成「恰好一个归属 commit」会判红这些行，而最省事的修法正好是把 RFC 六轮评审建立起来的分级压平。** 因此每段都必须标等级：

- `辅助门` —— 通过不升级 behavior 等级，失败仍阻止交付
- `production 硬门` —— behavior 闭合所依赖的那一档
- `每 commit 共同门` —— 每个 commit 都要跑

## 1. R-1 ～ R-14（验收判据 → commit）

`依赖能力就位于` 是本表**最容易被写错的一列**：把门排在它所依赖的能力之前，换一个新实例只会照着错的验收项打勾。

| ID | 归属 commit · 等级 | 依赖能力就位于 | 生产入口（可达路径） | plan task | 状态 |
|---|---|---|---|---|---|
| R-1 | C0 `辅助门`（recorder 自检）· C4 `production 硬门` | C4 authority publish | 四 vendor HTTP root + Responses WS | T0.3 · T4.2 T4.3 | IN-SCOPE |
| R-2 | C1 `辅助门`（classifier 三态 unit）· C4 `production 硬门` | C4 authority publish | 每 profile 从真实 route 发 generic／keepalive／terminal | T1.4 · T4.4 T4.14 | IN-SCOPE |
| R-3 | C0 `辅助门`（旧缺陷 characterization，红）· C4 `production 硬门` | C4 indexed 接线 | 真实 Anthropic live consumer | T0.6 · T4.5 T4.7 | IN-SCOPE |
| R-4 | C4 `production 硬门` | C4 compound command | FakeClock + 真实 route | T4.7 | IN-SCOPE |
| R-5 | C1 `辅助门`（test-only 预损坏 state）· C4 `production 硬门` | **C4 mapping 接线**——§4.6 `design.md:378` 写明 `withAllocatedRealBlock`／`writeBlockFrame` 当前**零 production 调用者**，双命中 mutation 在 cutover 前**不可达** | production registration mutation | T2.3 · T4.9 | IN-SCOPE |
| R-6 | C1 · C6 · **等级未定，见 §5** | C1 types / C6 import guard | compile fixtures + import guard | T1.1 T1.2 T1.3 · T6.6 | IN-SCOPE |
| R-7 | C4 `production 硬门` | C4 typed terminal result | 各 vendor direct／reverse、H2、H3、truncation | T4.10 | IN-SCOPE |
| R-8 | C4 `production 硬门` | C4 WS owner + FakeClock seam | Responses WS control-with-inflight | T4.11 | IN-SCOPE |
| R-9 | C5 `辅助门`（诊断，不计 behavior 等级） | C5 telemetry schema（**Q1 未裁则本段不可开工**） | 同 command 驱动 success／preflight／wire partial | T5.3 T5.7 | IN-SCOPE |
| R-10 | C6 `production 硬门` | C6 legacy 删除完成 | inventory AST 重跑 + test-only adversarial seam | T6.1 T6.5 | IN-SCOPE |
| R-11 | **每 commit 共同门**（C0～C8 各一次） | 无（沿用现有 fixture） | `exp/inter-block-anchor-allocator/byte-equivalence.sh` | T0.2 | IN-SCOPE |
| R-12 | C4 `production 硬门`（更新 golden）· C7 `辅助门`（审计） | C4 前先过 Q5 逐帧 diff 停门 | O-1／O-2／真 SDK 先跑，再同步 golden | T4.1 T4.16 · T7.1 | IN-SCOPE |
| R-13 | C0 `production 硬门`（Q3 已裁 A） | 无（现有 route 即可） | 真实 warmup route | T0.4 T0.5 | IN-SCOPE |
| R-14 | C4 `production 硬门` | C4 authority publish + `selectWinner` provenance | Chat Completions／Azure／Responses HTTP／Responses WS／Gemini **各一次有 winner 的 generation**，hedge winner 场景重跑 | T4.13 | IN-SCOPE |

**R-14 单独说一句**：`R-1～R-13 无一断言非 Anthropic 的 candidate provenance`，缺它则该回归**全绿交付**。它曾经被加进 §10.2 却**没有进 §10.4 的必过清单**——「新增判据」与「完成判定」是两处，只改一处就是这个后果。本表的反向 trace 就是为了让这类孤儿自动变红。

## 2. O-1 ～ O-9（原验收 oracle → 处置）

**`NOT-YET-IN-SCOPE` 是冻结白名单，不是可自由申领的标签。** 否则它就是万能逃生舱——把 R-14 标成 `NOT-YET-IN-SCOPE / M7` 就能绕过孤儿门，而那正是「缺了它回归会全绿交付」的那一条。

| ID | 处置（§10.3 原文摘） | 归属 | 状态 |
|---|---|---|---|
| O-1 | 需修改并沿用；本 RFC 内成为完整硬门 | C4（5 sites／3 kinds／4 scenarios） | IN-SCOPE |
| O-2 | 沿用，anchor authority 的主 behavior oracle | C4（R-3／R-4／R-7 直接使用） | IN-SCOPE |
| O-3 | 仍待后续补 | **M2～M8 gap lifecycle** | NOT-YET-IN-SCOPE |
| O-4 | **拆两段**：靶向复用 IN-SCOPE，完整真 SDK 验收待 P8 | C4（靶向）／**P8**（完整） | 部分 NOT-YET-IN-SCOPE |
| O-5 | 不属于本 RFC | **P8** | NOT-YET-IN-SCOPE |
| O-6 | 沿用且每 commit 必跑 | C0～C8（= R-11） | IN-SCOPE |
| O-7 | 不属于本 RFC | **P7／P8** | NOT-YET-IN-SCOPE |
| O-8 | 需修改接线并沿用 | C4 authority publish（准备 commit 只跑 owner unit 活性） | IN-SCOPE |
| O-9 | 仍待 M7，**绝不删除** | **M7** | NOT-YET-IN-SCOPE |

**白名单恰 5 项**：`O-3`、`O-4`**仅其完整真 SDK 验收部分**、`O-5`、`O-7`、`O-9`。
**双向核对**：正向——不在这 5 项里的 ID 申领 `NOT-YET-IN-SCOPE` 即 FAIL；反向——具名相位必须在 RFC §8「范围外」表里**解析到一行**。
⚠️ **反向核对必须接受区间行**：§8 对 M 系列只有一行区间「inter-block anchor allocator 原计划 **M2～M8** 的剩余 feature 本体」，P7／P8 各自独立成行。`M7` **全文只出现一次**（§10.3 的 O-9 行），按「逐字命中」判会把 O-9 误判成 roadmap 断链。

## 3. §9.3 调查缝（1～8）→ 证据槽必须齐全于哪个 commit

**单一事实源是 RFC §9.4**，本表只做归属映射，不复制停点措辞。

| # | 缝（摘） | 证据槽齐全于 | 可提前供 | plan task |
|---|---|---|---|---|
| 1 | 最终 composition factory 是否需要 export、谁拿 owner 谁只拿 command port | **C4 publish kickoff** | C1～C3 取最小子集 | T1.5 · T4.2 |
| 2 | HTTP／WS runner 可返回的 typed operation result；WS close intent 产生时是否已具备 | **C4 publish kickoff** | C1～C3 | T1.6 · T4.11 |
| 3 | 每个 indexed command 调用时 producer 实际持有的 format-native data／handle／builder | **C4 publish kickoff** | C1～C3 | T3.3 · T4.6 |
| 4 | Responses output-item boundary 的精确 effect taxonomy | **C4 publish kickoff** | C1～C3 | T3.2 |
| 5 | production authorization 双命中 mutation 的精确注入点 | **C4 publish kickoff** | C1～C3 | T2.2 · T4.9 |
| 6 | per-command rich records 的 request-scoped owner 与 settle 冻结点 | **C5 之前** | — | T5.1 · T5.5 |
| 7 | C4 authority publish 的逐点可表达性（五类 handler、8 个 anchor terminal-close、2 个 driver） | **C4 publish kickoff** | C1～C3 | T3.5 · T4.10 |
| 8 | raw factory test imports 迁到 test-only entrypoint，65 个 raw factory tests 仍覆盖 transport bytes | **C4 publish kickoff** | C1～C3 | T0.8 · T4.15 |
| + | already-rendered builder / LegHandle / heartbeat 逐点映射 | **C4 publish kickoff** | C1～C3 | T3.1 · T3.4 · T4.8 |

**到达 commit kickoff 时先读证据槽；没有 `file:line` 或 PoC 结论，就交付已完成部分与具体问题、结束本轮，不生成猜测签名。**

## 4. 裁决停点 → 触发 commit

| 停点 | 触发于 | 现状 |
|---|---|---|
| **Q1**（telemetry 联合查询能力） | **C5 之前** | **open**——用户 2026-08-03 裁的是「现在不裁」，**不是**裁了 A/B/C。守卫：`exp/inter-block-anchor-allocator/q1-locations.sh`（`PHASE=pre`） |
| **Q2** | **C8 之前**，默认不改 ADR | open |
| **Q3／Q4** | — | 已裁决，不再设停点 |
| **Q5**（anchor 帧序逐帧 diff） | **C4 authority publish 之前**（必经） | 用户已裁「接受帧序变更」；**逐帧 diff 审查仍是必经触发点，缺材料不得进入 C4** |
| **§7.13 不可满足停门** | C4 | 若 PoC 证明无法在同一 semantic commit 切换，**不得发布部分 authority、不得引入 `legacy_adapted`／payload-guessing facade、不得让 new command 回落** |

## 5. 已知缺口：R-6 的等级读不出来（**停下来问，别自己填**）

§10.2 末列 14 条里 13 条可直接读出等级，**唯独 R-6 是 `本RFC辅助门；Commit 1／6` —— 两个 commit、一个等级、没有分段**。

**这是 RFC 的既有缺口，不是接手方该自行填的空**：自行推断没有 RFC 出处，两段同填「辅助门」则是被明确禁止的压平。

**处置**：走 RFC §9.1／§9.4 的 open question 机制，交主会话／用户；按 `scope-ambiguity-then-ask` 摆 3–4 个带量化影响的选项而非 yes/no。**允许并且鼓励先给候选拆法**：

| 候选 | 拆法 | 量化影响 |
|---|---|---|
| 1 | compile fixtures → C1、import guard → C6，两段各自定级 | 与其余 4 条两段式判据形状一致；需要 RFC 补一句分段措辞 |
| 2 | 两段同为 `辅助门`（维持末列字面读法） | 改动最小；**代价是 C6 的 import guard 失去阻断力** |
| 3 | C6 那段升 `production 硬门` | §7.9 的 import guard 守的是「delivery 不 import concrete codec」这条分层边界，破了它 R-6 的价值就没了；**代价是 C6 通过条件变严** |

## 6. 反向：plan task → RFC 出处

**每个 plan task 必须能指回一个 RFC 出处**；指不回的，要么是 RFC 漏了、要么是 task 多余，**两种都得当场裁，不得默默保留**。

上面 §1／§3 已经覆盖了由 **R-\*／O-\* 验收判据**驱动的 task。但 plan 里还有一类 task **不由任何验收 id 驱动**，而由 RFC §7 的 **commit invariant／越界判据／归零审计／文档同步**驱动——它们同样必须指回 RFC，否则就是「task 多余」。下表补齐这一类，**逐条给出处**。

| plan task | RFC 出处 | 它在那里承担什么 |
|---|---|---|
| T0.1 | §7.1「整个序列的入场条件位于 Commit 0 之前」 | entry commit 上连跑 ≥15 次；**本 plan §11 待裁项 #4 另提「entry 落在哪棵树」这一 RFC 未回答的缝** |
| T0.7 | §7.2 全节（双向不动点闭包、A／B／C／D 四集、C-D tie-break） | 冻结旧 generation delivery 的完整能力面；**Commit 0 与 Commit 4 均 fail loud** 的判据来源 |
| T0.9 | §7.10 + §9.2 Q5 | 冻结 goldens 清单，作为 Commit 4 逐帧预测 diff 的比对基座与 Commit 7 审计对象 |
| T1.7 / T2.9 / T3.7 | §7.4「准备commit（Commit 1～3）共同的越界判据」第 2 条 | 属性存在性快照逐 commit 比对（`sink.writeAnchor ?? sink.write` 那类分派，方法存在性变了就改行为而 call-site 一行不动） |
| T2.1 | §4.1 `OpenAnchorLease` + §7.5 目标清单 | 把裸 `openAnchorIndex` 升级为 canonical record；lease 默认不暴露成 caller 传回的 public token |
| T2.4 | §7.5 目标清单「non-enqueue internal command primitives、owner serializer」+ §2.4「排序唯一」 | 所有 commands 共用一个 serializer |
| T2.5 | §3.3 `runEmissionBatch` + §7.5 | owner-scoped coordination；caller 拿不到 timer 控制方法 |
| T2.6 | §10.1「所有 FakeClock 否定断言还必须先有 unpark 活性对照」+ §5.2 heartbeat 行 | 活性对照是 parked 否定断言的前置，缺它则假绿 |
| T2.7 | §3.3 `terminate`／`finalize(result)` + §7.5 | first terminal wins、terminal exactly once、finalize 不是第二 emission 入口 |
| T2.8 | §2.2 唯一 choke point + §7.5「raw emitter 接口」 | raw emitter 只消费 validated envelope |
| T3.6 | §7.6 目标清单「10-root cutover harness 与 test-only handle recorder」 | isolated test composition 中完整演练，production 侧零变化 |
| T4.12 | §7.7 切换清单第 9／10 项（收口 C 集与 D 集） | resolution 归零、construction 收敛 allowlist；D 集判据是**运行期拿不到 emission 能力**而非签名不含某类型名 |
| T5.2 | §4.8 字段基数与存储分界 | bounded 字段的 canonical registry／normalizer；`wireIndex`／`commandId` 只进 detail |
| T5.4 | §4.9 compound command phase 与 partial 表达 | `phase` 四值 + 各 count measures；`closedThenWireTorn` 不得降成普通 `ok:false` |
| T5.6 | §4.9 末段「现有SQLite schema按固定additive columns持久化」 | 增列并验证 raw／hourly／daily／cumulative 四腿；不重建 command event 表 |
| T6.2 / T6.3 / T6.4 | §7.9 目标清单（A／B／C 三集的 definitions／exports 删除） | 分别对应 A 集、B 集、C 集 |
| T6.7 | §7.7 切换清单第 11 项「任何guard删除或放宽有独立裁决记录」+ CLAUDE.md `[hard]` | 删除或放宽既有 guard 必须交独立 reviewer 或用户裁决 |
| T7.2 | §7.10「删除确被取代的旧fixture／helper」 | 删前先确认它守的不变量已由新 oracle 承载 |
| T7.3 | §7.10「不改production、不首次recapture」 | `git diff -- src/` 为空 |
| T8.1 | §6.2 一致性矩阵末列「需要同步的权威位置」+ §7.11 | README C1～C11 回填；C1／C3／C4／C8 语义不变 |
| T8.2 | §6.3「C1～C11之外的已冻结可观察量」 | anchor 精确帧序登记为独立契约，**不得包装成 C2／C7 的实现细节** |
| T8.3 | §7.11 目标清单「DESIGN」 | 活的架构现状表与类型架构节 |
| T8.4 | §8 范围外表的 M2～M8 行 + §10.3 O-9「绝不删除」 | 旧 plan supersede 关系；supersede ≠ 删除 |
| T8.5 | §7.11「旧plan supersede关系」+ §7.9 population 审计 | 权威文档 manifest + 按契约轴检索 + 双向 trace |
| T8.6 | §8 范围外表前两行 | 两项 deferred 记入 `docs/todo/deferred-backlog.md` |
| T8.7 | §7.11「独立merged-state review」 | 跨 phase 集成缝、doc↔code 对账 |

**机械校验**（由 `traceability-check.py` 执行，不接受人工声称）：

- §1／§3 各表的 `plan task` 列不得留 `_TBD_`；
- plan 里的每个 task id 必须在本文件被引用至少一次；
- 两个方向的差集都必须为空。

## 7. 鉴别力正控（**已实跑，不是计划**）

判据：`exp/inter-block-anchor-allocator/traceability-check.py`。变异跑在副本上（`MATRIX=` 覆盖路径），**没有改动过真实文档**。


| 打哪一型 | 变异 | 期望 |
|---|---|---|
| 孤儿（有判据无 task） | 从本文件删掉 R-14 那一行 | 反向 trace 报「R-14 无归属」 |
| 孤儿（有 task 无出处） | 在 plan 里加一个不指回 RFC 的 task | 正向 trace 报该 task 无出处 |
| **门排在其依赖能力之前** | 把 **R-5 的 production 硬门**从 C4 挪到 C2 | 报红——§4.6 `design.md:378` 写明其依赖 C4 的 mapping 接线 |
| 逃生舱 | 把 R-14 标成 `NOT-YET-IN-SCOPE / M7` | 正向核对报 FAIL（不在冻结 5 项内） |
| roadmap 断链 | 把 O-9 的后继相位改成 §8 任何行都覆盖不到的名字（如 `M9`） | 反向核对报 FAIL |
| **假红对照** | O-9 保持 `M7`；R-5 保持 C4 | 必须 PASS（区间覆盖成立、依赖顺序成立） |

**实跑结果（2026-08-03）**：五条变异**全红且红的都是目标机制**——分别报 `R-14 … no row in the matrix (orphan)` / `R-5: production gate at C2 precedes the capability it depends on (C4)` / `R-14 claims NOT-YET-IN-SCOPE, which is a frozen list of […]` / `O-9 defers to M9, which resolves to no row or range in RFC section 8` / `deferred set … dropped: ['O-3']`；未改动的真实文档 `rc=0`。

⚠️ **这份判据能证什么、不能证什么**：它证的是**归属与可达性的结构完整**（无孤儿、无逃生舱、无断链、无倒序），**不证**任何一条判据真的咬得住它声称要抓的缺陷——那由 §10.2 各行自己的 mutation 正控负责，本表**有意不复制**它们。

