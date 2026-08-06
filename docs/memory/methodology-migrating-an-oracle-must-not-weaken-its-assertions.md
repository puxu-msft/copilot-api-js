---
name: methodology-migrating-an-oracle-must-not-weaken-its-assertions
description: 把测试从旧 harness 迁到生产构造时删掉一条既有断言，理由「新构造下这个行为不再产生」几乎总是假的——真相通常是新构造把节奏挪了一拍、你的驱动少了一步；删除既有断言的最低举证标准是「扫参数证明该性质在新构造下不存在」，而不是「当前驱动跑不出来」
metadata:
  type: feedback
---

迁移测试 oracle（把 harness 换成生产构造）时，若发现某条既有断言不再成立，**默认假设是「驱动不足」而不是「性质消失」**。这两者在现场长得一模一样：测试变红 → 你看代码觉得新构造的时间模型/包装层确实不同 → 顺手把期待改小 → 绿了。合理、说得通、且**一跑就假**。

2026-07-29 实例（B2 Task 4.1′）：把 `live-reconcile-collision.it.test.ts` 的 `buildLiveStack` 从 `makeSseSink` 迁到生产 `makeDeliverySseSink` 后，一条既有期待从「anchor 块上出现**两次** keepalive」被改成一次，理由写的是「第二 idle tick 的行为由 delivery heartbeat 的时间模型决定，原测试多期待的一条重复 keepalive 不再产生」。评审把 `buildLiveStack` 参数化成 legacy/delivery 两条链、**扫 tick 数 2/3/4**：

| ticks | legacy `makeSseSink` | 生产 `makeDeliverySseSink` |
|---|---|---|
| 2 | 2 条 keepalive | 1 条 |
| 3 | 3 条 | **2 条** |
| 4 | 4 条 | 3 条 |

生产链照样重复发 keepalive（`keepalives == ticks − 1`）——delivery 只是把第一拍花在 scaffold 注入与 re-arm 上，**整条节奏后移一拍**。删断言而不是补一拍，于是「静默期内打开的 anchor 块持续收到 block-aware keepalive」这条性质从该文件消失，而它正是 300s 看门狗设计的核心。

**How to apply:**
- **删除既有断言的最低举证标准**：附上**证明该性质在新构造下不存在**的实验——扫自变量（tick 数、帧数、重试次数）看它是否只是平移或延迟。「当前驱动跑不出来」证明的是**驱动不足**，不是性质消失。这两者的区别就是本条的全部内容。
- **最廉价的探测器是注释**：本例的决定性线索不是行为分析，而是同一文件相隔 10 行的自相矛盾——注释仍写着「Second idle tick → one more keepalive」，紧接着的期待说没有。改 `toEqual` 期待数组时，把测试体内**提及被删元素的注释**一并纳入 diff 审查；删断言的人几乎不会回头看那条注释。
- **判重级别时别按「测试仍是绿的」打折**：一个**会撒谎**的 oracle 比缺失的 oracle 更贵——未来读者（尤其下一个 Task 的实施者）会把「打开的块上只有一条 keepalive」当作生产事实，而那是设计意图的反面。
- 同源反例：迁 oracle 的**动机**往往正是「旧 harness 不是生产构造、对某类缺陷结构性失明」（本例就是——旧链没有 delivery session，看不见 hedge 胜者绕过 reconcile）。**别让「修地基」这件对的事顺手带走地基上原有的守卫**：迁移与削弱是两件事，必须分开评审。

**Related:** verification 簇根 [[feedback-pass-null-clean-not-self-validating]]；「新写的 oracle 一定咬得住只是推理」[[methodology-new-oracle-discriminating-power-is-experimental]]；「mutation control 自身要自证改到了代码」[[methodology-verify-the-mutation-actually-applied]]；本例的上游教训（唯一端到端 oracle 建在非生产 sink 上 → 2319 测试全绿而回归就在里面）见 [[methodology-probe-conclusion-scope-and-peer-invalidation]]。
