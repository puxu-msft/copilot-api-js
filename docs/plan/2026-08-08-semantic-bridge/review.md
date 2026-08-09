# 实施计划评审处置表

> 评审对象：`docs/plan/2026-08-08-semantic-bridge/`
> 每轮两名**跨模型** reviewer 并行，均在隔离 worktree、只读、显式对齐「长远正确 + 完整」裁判轴（非 ROI/YAGNI）。
> 本文按轮次追加，**不覆写历史轮次**。

# 第 1 轮（首版 `8fd73238`）

结果：**4 blocker + 10 major，全部核实成立，全部采纳**。

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

---

# 第 2 轮（`b31a23b6`）

两名 reviewer 均**逐条对文件复核、未采信处置表**。

**结果**：上轮 14 条处置**全部真实落地、无一条被弱化或虚报**（两名 reviewer 独立确认）。新增 C3.4／C8.0a／C8.0b 未制造新的 RFC 覆盖缺口或顺序矛盾。

**但抓到 1 个新 blocker + 3 个新 major，全部由我修 B1/B2 时引入或遗留。**

| ID | 发现 | 我的核实 | 处置 |
|---|---|---|---|
| **B5**（新 blocker） | 「`writeToSink` 是**所有**客户端字节的单一漏斗」**仍是过宽的全称** —— 非流式响应由 handler 直接 `c.json` 返回，根本不创建 delivery session | **成立**。自查确认 `createDownstreamDeliverySession` 只在 `client-sink.ts:494` `makeDeliverySseSink` 与 `:697` `makeDeliveryWsSink` 创建；非流式走 `handler-v4.ts:1377` / `:1344` 的 `c.json` | 新增锚点 **C-0**（两条互不相交的路径）；C-1/C-2 限定为「流式」；C2.3 加非流式 authority 落点 + 非流式存在性正控 + 第七条 mutation；**写出路径守卫的标题与断言消息必须写明只覆盖流式** |
| **M5** | G2 wire golden **自己没有灵敏度对照** —— 它是十余片 G2 的唯一机械判据，但没有任何 mutation 证明「production wire 改一个字节 → golden 变红」 | **成立**。捕获点取浅或归一化过度都会让它对真实差异失明，且无信号 | C0.2 加第三条 mutation（改一个 `event:` 名或 usage 字段 → 至少一条 golden 变红），结论记进 C0.3 registry |
| **M6** | G2 对账行在 12 片的 Verify 里缺失，而 kickoff 是自包含分派的 —— 执行者读不到全局规则等于没有 | **成立** | 任务详情前言加 `[hard]` 规范条款（每片 Verify 隐含包含 + 结果写进度文件 + 写 kickoff 的人必须抄进该片验收段）；C3.2／C3.3／C8.3／C11.1 四片逐字写出；README 通用红线强化 |
| **M-F**（上轮遗留） | 契约 reviewer 坚持要求补齐全部 kickoff，并抓到我一处事实错误：README 称「C0–C3.4 已就绪」而 `c3-4.md` 不存在 | 事实错误**成立** | 补写 `c3-4.md`（十片就绪）；导航表与「已就绪」表述对齐。**「是否立即补齐 C4+ 的 15 片」仍存分歧，不自行终裁，交用户** |

## B5 的教训：同一个错误连犯两次

第 1 轮我把「`writeCommittedBatch` 是唯一 writer」改成「`writeToSink` 是所有客户端字节的漏斗」——**后者在流式作用域内完全正确，跨出去就不成立**。这是 `scoped-invariant-written-as-global`：修一个过宽断言时，只把名字换窄，没有**主动去构造跨作用域的反例**。

更糟的是，我为此加的 writer 集合守卫会**为那个假全称背书** —— 它冻结的正是 `writeToSink` 的四个调用方，于是「所有客户端写出都在此」看起来有了机械保障。**一个守护错误命题的守卫，比没有守卫更危险。**

已把这两次失效连同「守卫标题必须写明作用域」写进 c2-3.md 正文，作为实施者的前车之鉴。

## 先例核实中的意外发现

我引用 `anthropic-via-openai-translation` 作为「增量 kickoff」的先例时去核实了它 —— 先例成立（该特性已 landed，`phase-1..5` 确实随推进逐个写出），**但那张导航表至今仍写着「待写」**。

于是给本计划的硬触发补了一条：**写 kickoff 与更新导航表必须是同一次改动**。先例证明了做法可行，也证明了不加这一条会陈旧。

## 仍待用户裁决的一条

**M-F：是否在 plan 定稿前一次性补齐 C4–C11 的 15 片 kickoff。** 双方论据、项目先例与我的倾向记录在 `plan.md` 末节的裁决记录里。提出方与复核方都是当事人，故不自行终裁。在裁决前按「增量产出 + 硬触发」执行；若裁定补齐，只需新增 15 个文件，不影响任何已定稿契约。

---

# 第 3 轮（`a68c3954`）

**只查一件事：修正本身有没有再犯同类错。** 结论：**有，而且是第三次。**

| ID | 发现 | 我的核实 | 处置 |
|---|---|---|---|
| **B6**（新 blocker） | 「客户端字节有两条互不相交的路径」**仍不穷尽** —— 存在**第三类**：handler／lib 自持 `streamSSE`，既不经 delivery session 也不经 `c.json` | **成立**。`messages/error-shaping-glue.ts:129`（`:131` `writeSSE`）与 `lib/anthropic/warmup.ts:211`／`:241`（`:214`／`:230`／`:243`）逐条验证 | C-0 **改为按枚举组织、不按二分**，新增「客户端字节起点全集」小节（三类全表）；C2.3 加步骤 3（③ 的落点）与**第二条守卫** `client-byte-origins`（冻结 `streamSSE(`／`c.json(` 调用点集合） |
| **B7** | 非流式落点只写了 messages，`responses`／cc／gemini 全漏 —— 而 `responses` 就在本 RFC 的 R→A 方向上 | **成立**（这一条我在 reviewer 报告前已自查发现并部分修了，其报告补全了 cc／gemini 与 `messages:788` 的中止路径） | ② 类按路由枚举：messages `:1377`／`:1344` + responses `:269`／`:534` 必落；cc／gemini 在 RFC §2 范围外，**须显式写明不落的理由与 History 后果**；mutation 7 改为「必须打**非 messages** 路由」 |
| **B8** | `c2-3.md` 不变量 2 仍写「不得写任何客户端 sink……证据见第 2 步的守卫」—— 把**无限定全称**指向**只覆盖流式**的守卫 | **成立**。这正是本轮 blocker 的措辞原型 | 改为「证据由三部分合起来给」+ `client-byte-origins` 兜第四类 |

reviewer 同时确认：「守卫只覆盖流式」的限定在 plan.md G2／C-0／C-1／C2.3 步骤与 `c2-3.md` 多处**均已写到**，只有不变量 2 那一处残留（即 B8）。

## 关键教训：连续三次，形态完全同构

1. 「`writeCommittedBatch` 是唯一客户端 writer」—— 漏 `write()` 主路径。
2. 「`writeToSink` 是所有客户端字节的漏斗」—— 流式内**完全正确**，漏非流式 `c.json`。
3. 「客户端字节有两条互不相交的路径」—— 漏自持 `streamSSE` 的第三类。

**共同根因**：修一个过宽断言时**只把名字换窄**，没有主动构造跨作用域反例。每次都以为「这次总该穷尽了」。

**更要命的是判据的形状**：我每次加的守卫，冻结的都是**上一次那条路径的内部**（`writeToSink` 的调用方），于是它对新缺口结构性失明，反而**为当前的假全称背书**。一个守护错误命题的守卫，比没有守卫更危险。

**本轮的结构性修法**（reviewer 提出，我采纳）：
- C-0 **按枚举组织，不按二分** —— 先问「谁能向客户端写字节」，再谈分类；
- 新增 `client-byte-origins` 守卫**冻结 `streamSSE(`／`c.json(` 的调用点集合**，出现第四类即 fail。**这才是能抓住下一次同类错的机械判据**；
- mutation 9 专门验证「这条守卫真的会咬」——即验证「防第四次」这件事本身。

## 本轮发现的一个既有矛盾

第 ③ 类里的 `error-shaping-glue` **直接证伪了 C2.3 的不变量 5**：该不变量要求「错误 wire 仍由 active authority 发送、不允许无 authority 的 writer 代发」，而这条既有生产路径正是一个无 authority 的 writer 在发错误帧。

已写进 C2.3 步骤 3 与 kickoff：**实施时必须先处理这个矛盾**（落 authority，或显式裁决豁免并写明理由与 History 后果），**不得假装不变量已经成立**。

## 我在本轮又犯的一次编辑事故

用 `### D. 配置（C2/C6 的对象）` 当编辑锚点插入新小节，却没在新串里写回该标题，导致 D 段标题一度被静默删除。当场发现并修复。**这是同一会话内第二次**（上次是 C8.1 的标题）—— 用小节标题当锚点时，它看起来像定位符、不像内容，最容易漏写回。


