# Mandatory Block Delivery 实施计划评审——事实与判据证伪

> 状态：最终轮 `0 blocker / 0 major`，可定稿。
>
> 评审对象：Plan Mode 原文件 `/home/xp/.claude/plans/sparkling-juggling-whistle.md`；归档后对应本目录 README、四份阶段计划与 KICKOFF。
>
> 来源：原 reviewer `a130ac0b192ebbfe7` 通过工具回传；Plan Mode 中 reviewer 无法直接写仓库，本文件由主会话逐轮转录并按当前计划处置表核对。

## 核验方法

Reviewer 将冻结 spec §1～§11 逐节映射到 Task 1～12，模拟错误实现全绿与正确实现被误拒两方向；重点核验 mandatory delivery／retry 正交、DATA 静态与性能双控、6 roots／11 pumps、GOAWAY provenance、History crash matrix／legacy compatibility、A/A-A/B strategy identity、progress 与 KICKOFF。

## 第一轮：`0 blocker / 5 major`

1. **Task 3 在 owner 接管前删除 legacy delivery projections。** 中间 commit 会丢 terminal／误判 truncation或不编译。
2. **Terminal bus 在 evidence CAS 就绪前接收含 lease envelope。** 旧 writer 会忽略／泄漏 evidence或落悬空 ref。
3. **旧 `enabled:true` 兼容漏测 default／explicit retry。** 错误实现可把启用状态迁成 `max_retries:0`。
4. **GOAWAY ambiguous／rejected 形状与 mutations 未逐项冻结。** 只测一个 ambiguous 样本即可宣称完成，或把正确 rejected 统一判 unsupported。
5. **性能 raw JSONL 缺 source commit／strategy digest。** A/B 可加载同一实现并把零差异冒充“无回归”。

**处置：全部 C 级采纳。** Task 3 保留 compatibility projection到Task 4；Task 9 storage substrate先于Task 10 activation；配置补 `enabled:true` default／explicit retries；GOAWAY逐格列形状与独立 mutation；性能记录 commit／digest并加同 strategy 双标签反控。

## 第二轮：`0 blocker / 1 major`

- **Progress 协议三处冲突。** 全局、执行策略、KICKOFF 分别指向单一共享文件和不同 Task 集合，违反一 agent 一文件并漏掉重型任务。
- **处置（C，采纳）：** 统一为 Task 5／9／10／11 各自独立 progress 文件；KICKOFF 指向 README 执行策略作为单一事实源。

## 第三轮：`0 blocker / 1 major`

- **Pump ratchet 未冻结中间批次成员。** 执行者可不迁目标 pump、原样留 pending并宣称完成；迁后漏移集合也直到最终批才暴露。
- **处置（C，采纳）：** 预先冻结 Batch 0～4 exact strict delta与累计数量；pending由 frozen差集派生；pending必须命中冻结 legacy sink，strict必须 owner-only；未迁／漏移／回退当批 mutation。

## 第四轮：`0 blocker / 1 major`

- **Installed GOAWAY source 与 recorder 双 owner，freeze 返回的 operation lease 无法原子进入 RequestContext sidecar。** 错误实现可只保存 snapshot而丢 lease。
- **处置（C，采纳）：** 选择 port-owner 形状：RequestContext install并独占 real source；recorder只交 builder；port先CAS，成功后内部freeze并原子写 snapshot + lease，拒绝不freeze。补CAS拒绝／成功原子写／无双消费三控。

## 中间复审：`0 blocker / 0 major`

Reviewer 确认当时版本的 ratchet、History substrate→activation、config、GOAWAY provenance、performance digest、DATA双控与progress均闭合。随后实施者视角发现Task 7缺port和observer双通道，继续整改，不把这一中间 `0/0` 当最终状态。

## 最终轮：`0 blocker / 0 major`

Reviewer 对最新单文件计划确认：

- Local port无callback／snapshot store／observer，只负责CAS、freeze与builder；recorder唯一调用`onTermination`，拒绝／second terminal零次，异常不阻断consumer terminal。
- RequestContext port独占real source，成功时snapshot与operation lease同临界区落地，拒绝不freeze并由cleanup释放。
- Task 7唯一serializable union／commit port、Task 8 lease implementation、Task 10 activation无反向import或ownership缝。
- Batch 0～4 exact ratchet、History substrate→activation、配置兼容、GOAWAY全形状、A/A-A/B digest、DATA双控、Bun RST deferred均未回归。
- Spec coverage无孤儿；关键gate有正确样本与目标mutation；KICKOFF的状态、禁区、Task与progress路径一致。

**最终 verdict：`0 blocker / 0 major`。**
