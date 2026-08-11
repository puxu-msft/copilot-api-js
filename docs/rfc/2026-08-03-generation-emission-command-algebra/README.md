# generation emission command algebra —— 当前进度

**最后更新**：2026-08-11。**权威**：本文件只记「做到哪了」；设计看 [design.md](design.md)，执行步骤看 [cutover-plan.md](cutover-plan.md)，活的架构现状以 [docs/DESIGN.md](../../DESIGN.md) 为准。

## 范围（已被两次裁决收窄，读计划前先读这里）

- **ADR [trust-the-caller-over-emission-authorization](../../decisions/2026-08-10-trust-the-caller-over-emission-authorization.md)**（2026-08-10）：做**原子性/串行化**与**类型层收窄**两类，保留遥测；**不做运行时授权**（classifier 拒绝 mismatch、D2 owner 铸 provenance、command identity 当授权凭据）。
- **Commit 0 全面推迟**（用户 2026-08-11）：T0.3–T0.9 全是证据基础设施、零生产行为，与「快做快合」冲突。业务代码完成后挑一部分回主线，其余彻底推迟。分流口径写在 cutover-plan 的「推迟项分流」节。

## 已完成

| 阶段 | 状态 | 证据 |
|---|---|---|
| 入场门（T0.0f → P → T0.0d → T0.1） | ✅ | entry `15c43e40`，receipt verdict green |
| T0.2 —— O-6 双向自检 | ✅ | 未改动树 `O-6 PASS` rc=0；`sse-encoder.ts` 注入一字节后 rc=9 |
| Commit 0 | 🛑 **不做**（已裁决推迟） | — |
| **Commit 1 —— capability types 与 profile registry** | ✅ `2df9c570` | `src/lib/pipeline/delivery/capability.ts`；`tests/pipeline/delivery/capability-narrowing.unit.test.ts` |

**Commit 1 的验收状态**（测于 `2df9c570` 合并态）：typecheck 绿、lint 绿、`bun run test:backend` **0 fail**、O-6 PASS（零 wire 变化，符合「不改 production 行为」的 invariant）。数字会过期，重算用 `bun run test:backend`。

## 未完成（下一步从这里接）

**Commit 2 —— owner state、serializer 与 coordination primitives**（cutover-plan §「Commit 2」）。要实现：private authorization registry 与 `OpenAnchorLease`、cardinality assertion、non-enqueue internal command primitives、owner serializer、`runEmissionBatch`、`terminate`／`finalize(result)` 状态机、raw emitter 接口——**都不接入 production roots**。

接手时注意三条，都是这一轮已经踩实的：

1. **计划正文是 TDD 形状（「先写什么失败测试 → 预期怎么红」），按本项目 2026-08-11 起的规则不照做**：先让产品行为跑起来，之后只补主路径与已报错路径的测试。已写的那条测试仍须有鉴别力（正样本对照不在淘汰之列）。
2. **serializer 自锁测不出来**：非可重入 serializer 在持锁时再入队的典型表现是 **promise 永不 settle，不是同步 throw**。用可控 barrier 停在 callback 内部再触发 internal primitive，别 await 到全局超时——那既慢又分不清目标自锁与环境慢。**不许改用可重入锁掩盖**。
3. **#6 已裁（候选 ④）**：`OwnerCommandFailureDisposition`（任意 command failure → caller action，已改名）与 `TerminalEmissionResult`（terminate 的 effect）是**正交两轴**，只在「terminate 自身失败」一格架具名映射桥。Commit 2 的 `terminate`／`finalize` 状态机建在这个结论上。

**Commit 4 有一项欠账**：Commit 0 的 T0.6 原本是「绿 = 旧缺陷仍在」的 characterization，Commit 4 之后要反转成正确性断言。既然 Commit 0 不做，**Commit 4 里直接写正确性断言**——stop 与 active anchor index 同字节时，wire 关闭与 lease 清除必须在同一 command 内完成。这是本次推迟里唯一需要补测试的项。

**仍未裁的开放问题**：只剩 **#2 Q1（telemetry 联合查询 A/B/C）**，绑着 #3。它**只阻塞 Commit 5**，不阻塞 Commit 2–4。

## 本轮顺手修掉的、与 cutover 无关的真缺陷

排查 O-6 假红时撞到的，都已单独提交并合入 master：目录外模型 → 500（`73a02eea`，四处 `as ResolvedModel` 把 `undefined` 洗进非可选字段）、守卫吞掉它正在报告的错误（`3c6d72bd`）、未知非 HTTP 错误不打栈（`581f904b`）、O-6 的 token 副本从不更新（`8c0b9ca0`）。第一条的裁决记录在 [docs/tmp/2026-08-11-unresolvable-model-guard-disposition.md](../../tmp/2026-08-11-unresolvable-model-guard-disposition.md)。
