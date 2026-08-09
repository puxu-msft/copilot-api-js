# 实施计划评审处置表

> 评审对象：`docs/plan/2026-08-08-semantic-bridge/`（首版 commit `8fd73238`）
> 第 1 轮：两名跨模型 reviewer 并行，均在隔离 worktree、只读、显式对齐「长远正确 + 完整」裁判轴。
> 结果：**4 blocker + 10 major，全部核实成立，全部采纳**。

## 评审配置

| Reviewer | 底座 | 视角 | 产出 |
|---|---|---|---|
| R1 | GPT | 计划 ↔ RFC 契约对齐（逐节核对任务承接） | 0 blocker / 6 major |
| R2 | Claude | 可执行性与判据判别力（构造「实现坏掉但判据全绿」的场景） | 4 blocker / 4 major |

R1 中途被服务端 API 错误打断，按纪律用 `SendMessage` 续跑同一个 agent（未重派、未换模型），并把任务砍到单一议题、限 30 行后完成。

## Blocker（全部采纳）

| ID | 发现 | 我的核实 | 处置 |
|---|---|---|---|
| **B1** | 「`writeCommittedBatch` 是唯一客户端 writer」是错的。`session.ts:159` 的 `write()` 才是主路径，`clientSink` 全部写法与 driver 五处 `sink.write` 都走它 | **成立**。自己跑 `rg 'writeToSink\('` 得四个调用方：`:165` `write()`、`:387` `writeCommittedBatch`、`:531` `closeOpenAnchor`、`:564` `writeBlockFrame`；`writeToSink:687` 才是单一漏斗 | 重写锚点 C-1/C-2 与 Architecture 段；C2.3 加 Step 0（重新枚举 writer 集合）+ 写出路径集合冻结守卫 + 两条新 mutation（主路径与 recovery batch 各一条） |
| **B2** | G2「不改变 production writer」只在 C1 有机械判据，C2.1–C8.3 全退化为自评；`test:backend` 不回归证不了字节不变 | **成立**。这正是 `verified-by-a-wrong-query` 的同族问题 | G2 补机械判据：C0.2 新增一组**客户端 wire 字节 golden**（两方向 × stream/non-stream × 有无 retry ≥ 6 条），C2.1–C8.3 每片改动前后逐字节对账 |
| **B3** | C7.1 声称「复用 C6.1 的 validator」，但合并序要求 C7 先合 —— 自相矛盾 | **成立**，读自己的文档即证 | 新增 **C3.4 共享 JSON-value validator** 片，前移为 C4–C7 的共同前置；DAG、合并序、C6.1、C7.1 同步改；加唯一性结构守卫防两份实现 |
| **B4** | C9 的 G6 只覆盖 B-2 一点，而计划自己写着「漏 B-3/B-4 会让 retry 腿回退成 CC 形」 | **成立**。且核实 `tests/anthropic/forward-leg-strategies.it.test.ts:115/127/137` 断言的确实只是**首次 dispatch** 的 wire 形状，无 retry baseline 对照 | C9 的 G6 展开为 B-1…B-4 **逐点冻结命中集合**，B-4 另配独立正控（真实触发一次重试后断言 wire 仍为 Responses 形）；C10 同样按其实际接线逐点冻结 |

## Major（全部采纳）

| ID | 来源 | 发现 | 处置 |
|---|---|---|---|
| M1 | R2 | C2.3 自己点名的「陷阱一」（recovery batch 空 commit 回调）没有任何判据；唯一性判据是单方向的 | 加 mutation 6（以 `onBeforeRecoveryBatchCommit` 为探针）；唯一性断言补**存在性正控**（active 数为 0 时「至多一个」同样成立） |
| M2 | R2 | C2.3→C3.1 的接力靠自由格式进度文件，且 c3-1 的锚点与「同一处接线」互相矛盾 | 改为**编译期保证**：C2.3 新增不变量 17（导出具名 authority 读取接口），C3.1 必须 import 它；c3-1 锚点段改为指明 `request.ts` 只是聚合点、不是 authority 真相源 |
| M3 | R2 | C0.2 的 mutation 在机制上不可能让 encrypted-only 变红（该丢失由 `:210` 的 `reasoningText.length > 0` 门决定，与 `reasoningEncrypted` 基数无关） | 换成翻转 `:210` 条件；multi-reasoning 另立一条（改 `:172` 覆盖赋值为累加）；并在正文写明原 mutation 为何不可能咬住 |
| M4 | R2 | C0.2 在「零生产改动」下要求一批需 C1.2 才能表达的正样本变绿 → 结构性 false-red；计数判据 `rg -c` 是文本型 | fixture 清单按「旧码可否表达」二分，三层 terminal 拒绝正控移到 C1.2；计数改为**运行时枚举冻结命中集合**；补「正样本变红＝发现第十类缺陷，不许改断言」的显式分支 |
| M-A | R1 | **无任何一片承接 direction-specific semantic mapper（wire → ledger）**，而 C8.3 假定它已存在 | 新增 **C8.0a／C8.0b** 两片（两方向 ingest mapper），置于 C8.1/C8.2 之前；DAG 与覆盖表同步 |
| M-B | R1 | RFC §3.3 不变量 4「redacted 不伪造明文」在**跨协议**场景无承接（G4/C0.2 只覆盖同模型原样回送） | C7.2 加第 6 步（policy 侧跨协议 redacted 契约）+ 负控 mutation；C8.0a/C8.0b 加 ingest 侧 redacted 不伪造明文 |
| M-C | R1 | RFC §3.4 的 boundary 状态机不变量（单次声明、ID 命名空间分离、多跳有序 segments、禁全局布尔）无承接 | C2.2 加第 5 步（六条不变量逐条落）+ 两条新 mutation |
| M-D | R1 | RFC §4 要求 part text／arguments／result output **三者**的 delta/done 冲突都产生 observation，计划只为 arguments 留位 | C1.3 改为三类各留结构位；C3.1 加第 16 步（三类冲突的实际 producer）+ 两条新 mutation |
| M-E | R1 | RFC §9 的响应侧载体不等价与「触发后必须产生 degradation」无承接（C6.2 只覆盖请求配置） | C6.2 加第 6 步 + 两条新 mutation |
| M-F | R1 | RFC §16 要求全部 C0–C11 都有 kickoff，而 15 片标为「待写」 | **部分采纳**，见下 |

## 部分采纳的一条（M-F），级别 C

**采纳的部分**：把「增量产出」从一句说明升级为**必经流程上的硬触发** —— `prompts/README.md` 的导航表逐片标注 kickoff 状态，**分派任一片之前必须先写好它的 kickoff**。要派活就得看导航表，看到「待写」即先补。

**未采纳的部分**：不一次性补齐全部 15 片 kickoff。

**理由**：kickoff 的价值在于给零上下文实施者**当前真实的锚点**，而 C4 之后的锚点会被 C1–C3 的 commit 改变（新模块路径、新导出名、行号推移）。提前写会产出**看起来正常但已失效**的指令 —— 比留白更坏。本轮 B1 正是这类失效的现成实例：一个措辞肯定、看起来完全合理、但事实已经不成立的指令。

**这一条是我自评的，因此登记为待裁决**：若评审或用户认为它偏离了 RFC §16 的字面要求，本条可改为「plan 定稿时一次性补齐」。裁决记录同时写在 `plan.md` 末节。

## 我自己在修订过程中犯的错（留档）

- 用 `### C8.1 —— Responses wire emitter` 这个标题当 `old_string` 锚点，却没在 `new_string` 里写回去，导致 C8.1 正文一度成为孤儿。当场发现并修复。这是 `replacement-must-cover-what-it-restates` 的「旧串多、新串少 → 静默删除」方向 —— 标题看起来像定位符、不像内容，最容易漏。
- C3.4 首次插入时落在了 C7.2 之后，文档顺序与 DAG 不符，已移到 C3.3 与 C4.1 之间。
- c0-2.md 合并小节时丢了「改动锚点」的文件清单，通读时发现并补回。

## 下一轮

修订后**重写即算新一轮修改**，须重新触发评审。第 2 轮要求两名 reviewer 逐条复核上述处置是否真的落地（而非只看处置表声称），重点复核 B1/B2/B4 与 M-A —— 它们改动面最大、最可能在修订中引入新缺口。
