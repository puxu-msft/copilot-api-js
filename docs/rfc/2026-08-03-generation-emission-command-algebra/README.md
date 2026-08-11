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
| **Commit 2 —— owner state、serializer 与 coordination primitives** | ✅ `ff948954` + `7d288f9a` | `delivery/{authorization,owner-serializer,owner-lifecycle,heartbeat-controller,raw-emitter}.ts`；两份 `tests/pipeline/delivery/owner-*.unit.test.ts` |

**验收状态**（重算命令：`bun run test:backend`、`bash exp/inter-block-anchor-allocator/byte-equivalence.sh`）：两个 commit 都 typecheck 绿、lint 绿、后端档 **0 fail**、O-6 PASS（零 wire 变化，符合「不接入 production roots」）。

**Commit 2 的关键取舍**（照抄这些结论前先读代码注释，那里写了为什么）：

- **授权注册表没有对外 lease token**：caller 只能说「关闭当前 open anchor」，owner 在 serialized command 内读自己的 `currentAnchorLease`。能出去再回来的 token 就能被重放、留存、跨代次串用。
- **generation 身份在运行时校验**，不只靠 branded type——`as AnchorLeaseId` 和结构相同的对象都能骗过编译器，「是不是本注册表的成员」骗不过。
- **`assertCardinality` 走完整 population**：不是只查当前 leg，也不是 anchor 先查、命中就短路——那两种都漏掉跨类碰撞（anchor lease 与 real block 同 index），而那正是真会发生的一种。
- **回滚的 wire index 直接烧掉、不回退 frontier**：回退会让后来的记录拿到一个客户端可能已经在失败前的帧上见过的 index。
- **serializer 保持非可重入**，compound 步骤走 `runInternal` 内联执行；**不许改用可重入锁掩盖自锁**。
- **「我是否在 command 内」既不能用计数器也不能只用 `AsyncLocalStorage`**：计数器分不清嵌套调用与「心跳恰好在 command 挂起时触发」；ALS 单用也错——**实测 Bun 1.3.14，在 command 内 `setTimeout` 排的回调会继承 store，且在该 command 结束后仍看得见**，于是 command 内武装的心跳会在下一 tick 开始抛重入错误。做法是 store 里带一个 command 结束即退休的 token，两者同时成立才算「在内」。
- **心跳归 owner**：`freezeHeartbeat`／`suspendHeartbeat`／`resumeHeartbeat` 有意不出现在 command port 上，caller 只有 `runBatch`。重新武装用**全新 interval** 而非剩余时间（否则一个耗掉大半 interval 的 batch 结束后会立刻插一个 keepalive，在客户端看来像一次并不存在的停顿）；**batch 抛异常仍重新武装**，只有 terminal 与 `stopPermanently` 才真正停。

## 未完成（下一步从这里接）

**Commit 3 —— producer builders、LegHandle 数据流与 publish harness 准备**（cutover-plan §「Commit 3」）。要实现：各 profile 的 pure builders（用真实 vendor bytes 校准）、producer-to-command 转换 helper、candidate binding 里的 opaque LegHandle 承载、10-root cutover harness——**helpers 仍不被 production roots 调用**。

接手时注意三条：

1. **计划正文是 TDD 形状（「先写什么失败测试 → 预期怎么红」），按本项目 2026-08-11 起的规则不照做**：先让产品行为跑起来，之后只补主路径与已报错路径的测试。已写的那条测试仍须有鉴别力（正样本对照不在淘汰之列）。
2. **builders 先用合成 fixture 跑通，再换真实上游字节确认仍绿**——合成 fixture 单独绿不构成 wire 正确性证据。
3. **Commit 2 的模块可直接复用**：`authorization`（授权注册表）、`owner-serializer`（唯一序列化点 + `runInternal`）、`owner-lifecycle`（terminal 状态机与 #6 的映射桥）、`heartbeat-controller`（`runBatch`）、`raw-emitter`（只吃 `ValidatedDeliveryEnvelope`）。取舍理由见上一节，别按直觉改。

**Commit 4 有一项欠账**：Commit 0 的 T0.6 原本是「绿 = 旧缺陷仍在」的 characterization，Commit 4 之后要反转成正确性断言。既然 Commit 0 不做，**Commit 4 里直接写正确性断言**——stop 与 active anchor index 同字节时，wire 关闭与 lease 清除必须在同一 command 内完成。这是本次推迟里唯一需要补测试的项。

**仍未裁的开放问题**：只剩 **#2 Q1（telemetry 联合查询 A/B/C）**，绑着 #3。它**只阻塞 Commit 5**，不阻塞 Commit 2–4。

## 本轮顺手修掉的、与 cutover 无关的真缺陷

排查 O-6 假红时撞到的，都已单独提交并合入 master：目录外模型 → 500（`73a02eea`，四处 `as ResolvedModel` 把 `undefined` 洗进非可选字段）、守卫吞掉它正在报告的错误（`3c6d72bd`）、未知非 HTTP 错误不打栈（`581f904b`）、O-6 的 token 副本从不更新（`8c0b9ca0`）。第一条的裁决记录在 [docs/tmp/2026-08-11-unresolvable-model-guard-disposition.md](../../tmp/2026-08-11-unresolvable-model-guard-disposition.md)。
