# Mandatory block delivery 与 HTTP/2 终止观测规格评审——事实与判据证伪

> 状态：第二轮 `0 blocker / 5 major` 已全部采纳并整改，待原 reviewer 第三轮复审
>
> reviewer：独立事实／判据证伪 reviewer
>
> 评审基线：`2bd0b83d88d67f67a315bfc1ba331c75c28b9cff`
>
> 原始报告由 reviewer 通过工具返回；本文件逐条转录其 finding，供多轮处置保留。Reviewer 未修改仓库。

## Gate

Reviewer 在隔离 worktree detached 到固定提交，核验 `pwd`、top-level、HEAD 与干净状态。它逐段对账 spec／ADR／backlog／DESIGN，扫描 sink、buffering 配置、retreat、SSE、HTTP/2、trailers 与 History journal，并模拟生产入口、并发策略、终止分支、事务崩溃点和性能 mutation。Reviewer 未运行测试。

## C1～C7

- C1 通过：当前 translate、direct、Responses 与 Gemini 仍有 live sink；配置仍能关闭 buffering，cap 超限仍会 retreat live。
- C2 通过，但引出 F1：WHATWG 要求 EOF 丢弃 pending data；当前代码没有在 EOF dispatch 残余 event。
- C3 通过：DATA handler 保持纯 enqueue；GOAWAY 参数未消费。
- C4 通过：trailers 仍写 request-global 槽。
- C5 通过：journal 先独立写，operation／CAS 后进另一事务；spec 的 recovery set 是目标态。
- C6 通过：spec、backlog 与 DESIGN 均诚实区分目标态和当前态。
- C7 未验证：隔离树无 History 数据库；三个固定样本仅见于 spec，无法独立复核 attempt／client marker、末帧及 terminal 缺失。

## 第一轮 verdict

`0 blocker / 6 major`，修复 major 并复审后可进入下一阶段；当前不可定稿。

## Findings

### F1 · Major：SSE 空行 dispatch 条件比 WHATWG 更宽

Spec 写“由空行终止的 event 必须 dispatch”，但 WHATWG 在 data buffer 为空时会中止 dispatch。当前 parser 可让仅含 `event:`／`id:` 的输入生成 event。若按现文补测试，会把现有标准偏差冻结为目标。

建议限定为“具有非空 data buffer 且由空行终止”，加入 `event:`-only、`id:`-only 正反样本。

### F2 · Major：response-level unit 的帧所有权与提交边界不闭合

真实前缀必须缓冲，但 spec 又要求 terminal commit 时无 open unit。若整响应算 open unit，正确响应无法提交；若不算，`buffer-real-frame` 由谁、按何边界整体提交未定义。`CompleteClientUnit` 是否携带已缓冲帧也未定义，可能重复写或永久扣留。

建议按协议冻结状态转移和 frame ownership／consumption。

### F3 · Major：production entry set 与双向可达性验收缺失

现有验收未冻结 direct／translate／reverse／Gemini／WS／web search 等生产入口，也未要求逐入口证明只能到达 owner。漏迁入口或新 helper／alias 直写时，已有 mutation 仍可能全绿。

建议建立 production entry set，并做“每入口可达 owner、不可达底层 sink”的 AST／调用图双向守卫。

### F4 · Major：evidence bytes owner 状态机与全退出路径释放缺失

Spec 未定义 session GOAWAY recorder 到 History writer 的 API，也未定义 loser dispatch、History 禁用、prepare／journal 失败、永久提交失败、shutdown 的释放责任。现有验收只测持久对象，不测进程内 handle，允许 digest 有而 bytes 丢失或永久泄漏。

建议冻结 owner 状态机，并为所有退出路径加入释放／可重试正反控。

### F5 · Major：fixed-shape snapshot 没有闭合 schema 与字段上界

字段列表使用“包括”，error／reason 无数值界限；GOAWAY-after-end 未规定保持 frozen、标记不可用或允许 late mutation。字段缺席、无界字符串、终止后改写都可能通过。

建议冻结闭合类型、每个 terminal 分支的完整字段形状与长度上限，以及 GOAWAY-before／after 期望。

### F6 · Major：对象分配与字节复制 mutation 被合并

硬约束把额外对象分配和额外字节复制列为独立禁项，但验收把两者合成一个 mutation。执行者可以只注入一种而宣称全部可检测。

建议拆成四个独立 mutation：时钟、对象分配、字节复制、callback，并逐项确认失败来自目标机制。

## 主会话处置表

| Finding | 级别 | 处置 | 证据／整改 |
|---|---|---|---|
| F1 | C | 采纳 | WHATWG dispatch algorithm 在 data buffer 为空时中止；当前 parser 可从 `event:`／`id:`-only 构造 event。Spec §3／§9.1 已要求修正 empty-data 偏差，并分开 EOF-flush 与 empty-data-dispatch 变异。 |
| F2 | C | 采纳 | 旧 outcome 没有定义 `CompleteClientUnit.frames`，response-level buffer 也没有消费出口。Spec §4.2 已冻结 unit／response buffer 的单次所有权转移、`response-terminal.responseFrames` 与 truncation 销毁语义；§9.3 加逐 adapter 状态转移验收。 |
| F3 | C | 采纳 | 与 I4 独立重合。Spec §4.7 以 path-qualified 5 roots／9 pumps 冻结 production set，并同时测正确 root 可达 owner 与错误 root 不可达 writer。 |
| F4 | C | 采纳 | 与 I2 独立重合。进一步反例发现 session 可能先于 History acquire 退役；Spec §5.4～§5.5 改为 first-write 同步 retain operation ref、terminal seal 产生 `OperationPersistenceEnvelope`，关闭该空窗。 |
| F5 | C | 采纳 | Spec §5.3 已替换“包括”式字段表，冻结 schemaVersion 1 的闭合类型、128／1,024 UTF-8 byte 上界、null 形状与 GOAWAY-after-end 永不 late-mutate；§9.2 加正反验收。 |
| F6 | C | 采纳 | Spec §8.2／§8.3／§9.5 已拆成 clock、object allocation、byte copy、callback 四个独立 variant 与报告行，逐项核对退化机制。 |
| C7 | C | 降级并显式标注 | 当前评审 worktree 无运行态 History DB。Spec §1 明确三个样本是原故障排查的一手运行态记录，reviewer 未独立重放，且该事实不作为书面规格定稿门。 |

性质→验收对账抓到并修复一处已知正样本：正文把实际 6 个 strategy variant 写成“5 个”；现已改为 6，并在 §9.5 保持 4 个 mutation 的正确基数。

## 第二轮复审

> 固定复审 HEAD：`d1a0ad2e3261a643f23f681f2263744bceb22a0e`（base `2bd0b83d88d67f67a315bfc1ba331c75c28b9cff`）
>
> Verdict：`0 blocker / 5 major`。F2、F6 已闭合；F1、F3、F4、F5 仍有 major；另发现旧 journal v1 digest compatibility major。当前不可定稿。

### Gate 与双视角覆盖

Reviewer 机械核对整改 diff、WHATWG SSE algorithm、production stream graph、History format／digest 兼容、snapshot／registry 类型与 runtime harness；执行模拟覆盖 empty-data ID 继承、warmup／precommit synthetic 流、GOAWAY 未观察态、事务 A 重试、旧 journal 恢复、response-level 正常／截断和四类性能 mutation。

### 原 finding 逐项 verdict

- **F1：仍有 major。** Empty-data 不 dispatch 已修，但遗漏 WHATWG last-event-ID 更新、空 `id:` 重置、U+0000 忽略和下一 data event 继承。
- **F2：闭合。** Unit／response buffer 所有权、单次消费、terminal commit 与 truncation 销毁已闭合。
- **F3：仍有 major。** 5 roots／9 pumps 漏掉 warmup `drop|fake` 和 precommit AskUserQuestion 两条直接结构化流写出路径。
- **F4：仍有 major。** `OperationEvidenceLease` 未定义，session ref 有双 release 歧义，且 transient rollback 保留重试与“refcount 为零”验收冲突。
- **F5：仍有 major。** GOAWAY 未在 snapshot 前观察到时，强制 `EvidenceCapture` 无诚实 union variant。
- **F6：闭合。** 4 类性能 mutation 与双 runtime harness 已闭合。
- **C7：处置成立但仍 unverified。** 固定 worktree 无运行态 DB 的限制已诚实记录。

### 新增 Major：旧 journal v1 digest compatibility

当前 recovery 同时接受当前 prepared digest 与 `legacyV1Digest(record)`；spec 只冻结 manifest-v2 digest，会拒绝真实旧 v1-digest pending row。须保留 v1／v2 两条冻结 digest oracle和真实 fixture。

### 第二轮 verdict

`0 blocker / 5 major`。修复后须复审。

### 主会话第二轮处置

| Finding | 级别 | 处置 | 整改方向 |
|---|---|---|---|
| F1-r2 | C | 采纳 | §3／§9.1 冻结完整 last-event-ID buffer：`id:`-only 无 MessageEvent 但更新状态，空值重置，含 U+0000 忽略，下一 data event 继承。 |
| F3-r2 | C | 采纳 | §4.7 扩为 6 个真实 graph roots／11 个 pumps，warmup drop／fake 与 precommit AUQ streaming 全部迁入 synthetic owner；route catch 成为 graph root。TypeScript compiler AST 独立枚举同时识别 driver sink 与 `stream.writeSSE`，精确得到 11 个函数，并确认 6 个冻结 roots 存在。 |
| F4-r2 | C | 采纳 | §5.4 定义 `OperationEvidenceLease` 唯一 release，注册后只由 `RegisteredEvidence.releaseSessionRef()` 释放 session ownership；验收区分 transient retry-retained 与 terminal release。 |
| F5-r2 | C | 采纳 | §5.3 把 GOAWAY evidence 改成 `not-observed-before-snapshot`／`unavailable-at-source`／`captured`／`unavailable-at-capture` 闭合 union，以字段级 `SnapshotScalar` 冻结 observation→detail 合法组合。 |
| J1-r2 | C | 采纳 | §6.3 冻结旧 journal v1／v2 digest oracle，各自使用真实 fixture；旧 oracle 验证 pending row 完整性后迁移提交为 manifest v3，不能用 v3 digest 反向替代旧 oracle。 |
