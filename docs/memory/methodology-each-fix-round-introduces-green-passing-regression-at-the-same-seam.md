---
name: methodology-each-fix-round-introduces-green-passing-regression-at-the-same-seam
description: 连续多轮「修复引入新回归且全套件照绿」时，别逐个修——去找那条所有测试结构上都看不到的缝
metadata:
  type: feedback
---

**当连续两轮以上出现「本轮修复引入了一个全套件抓不到的新回归」，停止把它们当独立缺陷逐个修**。这是信号：存在一条**所有现有测试在结构上都无法观测的缝**，每次改动路过它都会掉进去，而绿灯每次都照给你。

**Why:** 2026-08-02 方案 A 的 P1+P2 连续三轮命中同一形状：
- 第一轮修 owner 契约 → 引入 `terminateAfterWireFailure` 硬关 session、吞掉 finalize（History/telemetry 永不封口），全套件绿。
- 第二轮修 live 腿死接线 → **该修复自己没有裁决力**，把 handler 改回完整原 bug 形态后 6566/0 照绿。
- 第三轮修 wrapper blind spot → winner 帧改走 owner，**绕过 `makeReconcilingSink` 装饰器**、+1 remap 不再发生，wire index `[0,0,1,1,1]` 变 `[0,0,0,0]`，6567/6567 照绿。

三次的共同根因是**同一条缝**：`handler → 装饰器 → driver` 这条链上，**测试全都自己构造 sink**（自造 delivery session、`{...clientSink}` 浅拷贝当装饰器、传未装饰 sink 给 driver），于是「handler 究竟供给了什么」「字节是否真的过了装饰器」在结构上不可观测。缝的两侧各自都有测试且都绿。

**How to apply:**
- **判据**：把修复**完整改回原 bug 形态**，全套件仍绿 → 该修复没有裁决力，缝就在这里。这比「再加一条断言」有用得多。
- **验收必须来自真实入口**：用 `createFullTestApp` + `app.request("/v1/messages")` 这种真 HTTP 入口驱动，配合 `setDeliverySessionObserverForTests` 之类的观察点捕获**生产代码实际创建的对象**。任何自造 sink / 自造 session 的单元门都不能作为该缝的唯一证据。
- **一个测试是否覆盖某条缝，判据是它 import 了什么、从哪个入口进**，不是它读起来像什么。核对方式：`rg -l 'createFullTestApp|createTestApp' tests/` 数一数真正走生产入口的文件。
- 别急着补第四种形态；先问「这条缝为什么所有测试都看不见」，再决定是补 oracle 还是换轴。

**主会话自己的一份责任（同一事故）**：转述 reviewer 的 minor 时**剥掉了它的限定语**。原话是「字节仍经装饰器抵达 delivery，账本不丢，但 candidate provenance 记账整条丢失」——明确说了**字节是好的、只丢 provenance**、建议登记 backlog 即可。转述成「一并纳入」后，执行者选择把帧改走 owner，于是把良性退化变成真实 wire 损坏。**转述评审意见时，限定语和严重度是内容的一部分，不是修辞**。

**Related:** [[feedback-pass-null-clean-not-self-validating]]（通过/干净不自证）[[methodology-new-oracle-discriminating-power-is-experimental]]（新 oracle 咬不咬得住是实验不是推理）[[methodology-appliesto-matches-but-chain-never-driven]]（命中 ≠ 链被驱动）[[methodology-cross-phase-integration-seam-only-caught-at-merged-state]]
