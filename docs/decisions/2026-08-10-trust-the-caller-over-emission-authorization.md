# 信任调用方，不为未出现的问题预设防护——generation emission cutover 的范围收窄

**日期**：2026-08-10
**状态**：已裁决（用户）
**影响**：`docs/rfc/2026-08-03-generation-emission-command-algebra/` 的 design §5 处置矩阵与 cutover-plan Commit 2–4

## 背景

RFC 把 generation 的全部 client-visible emission 收口为 `GenerationDeliveryOwner` 的 command port。审视时把它包含的机制拆成三类，性质并不相同：

1. **原子性与并发**：close 判定、wire index、stop 发射、lease 清除、heartbeat/diagnostic 副作用在同一个 serialized command 内完成；terminal 作为 owner command 且 exactly-once；单 serializer、单次采样、单次物理发射。
2. **类型层收窄**：非 Anthropic profile 在类型层拿不到 indexed-block command；raw emitter 与 sink factory 不再是公开 production API。
3. **运行时授权**：classifier 归一 actual effect 后与 caller 的 semantic intent 比对，不符即拒绝；provenance 由 owner 从自己的 lease/mapping 铸造而非信 caller 声明的 `kind`（design §1.2 的 D2）；每次物理发射携带 owner 铸的 command identity 作为授权凭据（D8 的授权面）。

第三类是**防护**：它防的是「调用方拿着新 command，却声明了与实际 effect 不符的 intent」。

## 决定

**做第一类、第二类，以及遥测/调试信息；不做第三类的授权与拒绝。**

具体：

| 项 | 处置 |
|---|---|
| 原子 compound command（close+write+lease 清除同一 command） | 做 |
| terminal 作为 owner command、exactly-once、finalize 不成为第二发射入口 | 做 |
| 单 serializer、单次采样、单次物理发射 | 做 |
| capability-shaped 类型收窄 | 做 |
| 删除旧 generation write 路径，调用 population 归零 | 做 |
| per-command telemetry 与 History generation operation detail | **做**（记录 ≠ 防护，见下） |
| classifier 校验 intent × effect × authority 并**拒绝** mismatch | **本轮不做** |
| D2：provenance 由 owner 从 active lease 铸造，取代 caller 声明的 `kind` | **本轮不做** |
| command identity 作为**授权凭据** | **本轮不做**（作为诊断标识仍随遥测保留） |

## 理由

**用户裁决的原则**：信任调用方；内容真的错时让它自然报错；不为尚未出现的问题预设防护。这与本项目既有的 [internal-tool-security-posture](2026-07-05-internal-tool-security-posture.md) 同源——工具是内部开发用途，威胁模型里没有敌手。

**技术上这条成立，因为 classifier 并不是那几个真缺陷的承重件。** design §1.1 论证「隐藏一个入口不够」时，针对的是**藏**（源码 regex、静态 view narrowing、运行时摘 property）——那些只能减少一种写法。而 cutover-plan 的 Commit 6 是**真删**：旧 generation write API 的 production 调用 population 必须为零。因此 D1/D3/D4 那类 state 与 wire 分裂的修复，靠的是「旧路径不存在了」加「新 command 是原子的」，不靠运行时拦截。

**RFC 自己也没给第三类背书。** §11.1 明写：不证明 classifier 天然正确，也不证明 producer intent 与 classifier 相互独立——上游转发腿常以与 classifier 同族的谓词选 command，共享谓词漏形态时两侧会共因判绿。一个证不了自己正确、且可能与被检查方共因失效的检查层，正是「徒增烦恼」的定义。

**遥测保留的理由与防护无关。** 它记录发生了什么，不裁决什么被允许；符合 ADR [richest-data-flow](2026-07-05-richest-data-flow.md)，并且是排查线上问题时区分「有意的命令」与「意外流出的帧」的唯一手段。删掉它省不下多少实现，却会让 History 退回到今天这种三者不可分的状态。

## 后果

**诚实边界**：intent 与实际 effect 不一致时，**不会在 command port 当场 fail loud**。它会通过既有测试、wire golden 与客户端行为暴露，或者不暴露。接受这个代价是本决定的实质内容，不是它的副作用。

**D2 的具体让步**：synthetic 与 real 的 provenance 仍来自调用方声明的 `kind`。design §1.2 对 D2 的原始判断（「provenance 的 authority 来自调用方声明」）依然成立，只是不在本轮处理。

**需要同步修改的文档**：cutover-plan 的 Commit 2（owner state/serializer/coordination primitives）与 Commit 4（authority publish）的 task 表把 validation 与 coordination 建在一起，须按本决定重写；design §5 处置矩阵中对应行须标注本轮不做与恢复入口。

**恢复入口**：若将来出现真实的 intent/effect mismatch 缺陷（而不是设想的），第三类的三项各自独立可加——classifier 可作为 owner 内的一层校验后置引入，D2 只需把 `WireEnvelopeFactory.anchor` 的 caller 参数换成 owner 查询，两者都不要求重做第一类的 command 形状。本条已登记进 [deferred-backlog](../todo/deferred-backlog.md)。

## 未改变的事

本决定不改变 cutover 的相位结构：Commit 1–3 仍是零行为变化的准备、Commit 4 仍是唯一可观察切换点且不许拆、Commit 6 仍要求旧 API population 归零。也不改变已通过的入场门——entry `15c43e40d3c4c172425ec2356721b73bebd8315b` 与其 receipt 仍然有效，本决定只动 `docs/`。
